import { existsSync } from 'fs';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'child_process';
import { delimiter, extname, join, resolve } from 'path';

type ExistsSyncLike = (path: string) => boolean;
type SpawnSyncLike = typeof spawnSync;

export type SpawnErrorKind = 'missing' | 'blocked' | 'error';

export interface PlatformCommandSpec {
  command: string;
  args: string[];
  resolvedPath?: string;
}

export interface ProbedPlatformCommand {
  spec: PlatformCommandSpec;
  result: SpawnSyncReturns<string>;
}

const WINDOWS_DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd', '.ps1'];
const WINDOWS_DIRECT_EXTENSIONS = new Set(['.com', '.exe']);
const WINDOWS_CMD_EXTENSIONS = new Set(['.bat', '.cmd']);
const WINDOWS_EXTENSION_PRIORITY = ['.exe', '.com', '.ps1', '.cmd', '.bat'];
const NODE_HOSTED_SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function isWindowsPathLike(command: string): boolean {
  return /^[A-Za-z]:/.test(command) || /[\\/]/.test(command);
}

function normalizeWindowsPathext(env: NodeJS.ProcessEnv): string[] {
  const raw = String(env.PATHEXT ?? '').trim();
  if (raw === '') return WINDOWS_DEFAULT_PATHEXT;
  const entries = raw
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const ordered = [...WINDOWS_EXTENSION_PRIORITY, ...entries];
  return [...new Set(ordered)];
}

function classifyWindowsCommandPath(path: string): 'direct' | 'cmd' | 'powershell' {
  const extension = extname(path).toLowerCase();
  if (WINDOWS_CMD_EXTENSIONS.has(extension)) return 'cmd';
  if (extension === '.ps1') return 'powershell';
  if (WINDOWS_DIRECT_EXTENSIONS.has(extension)) return 'direct';
  return 'direct';
}

function resolveWindowsCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  existsImpl: ExistsSyncLike,
): string | null {
  const candidates: string[] = [];
  const extension = extname(command).toLowerCase();
  const pathext = normalizeWindowsPathext(env);

  const addCandidatesForBase = (base: string): void => {
    if (extension) {
      candidates.push(base);
      return;
    }
    for (const ext of pathext) {
      candidates.push(`${base}${ext}`);
    }
    candidates.push(base);
  };

  if (isWindowsPathLike(command)) {
    addCandidatesForBase(command);
  } else {
    const pathEntries = String(env.Path ?? env.PATH ?? '')
      .split(delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
    for (const entry of pathEntries) {
      addCandidatesForBase(join(entry, command));
    }
  }

  for (const candidate of candidates) {
    if (existsImpl(candidate)) return candidate;
  }

  return null;
}

function resolvePosixCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  existsImpl: ExistsSyncLike,
): string | null {
  const trimmed = command.trim();
  if (trimmed === '') return null;

  if (trimmed.includes('/')) {
    const candidate = resolve(trimmed);
    return existsImpl(candidate) ? candidate : null;
  }

  const pathEntries = String(env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = resolve(entry, trimmed);
    if (existsImpl(candidate)) return candidate;
  }

  return null;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCmdLaunch(commandPath: string, args: string[], env: NodeJS.ProcessEnv): PlatformCommandSpec {
  const commandLine = [commandPath, ...args].map(quoteForCmd).join(' ');
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    resolvedPath: commandPath,
  };
}

function resolvePowerShellExecutable(env: NodeJS.ProcessEnv, existsImpl: ExistsSyncLike): string {
  return resolveWindowsCommandPath('powershell', env, existsImpl) || 'powershell.exe';
}

export function classifySpawnError(error: NodeJS.ErrnoException | undefined | null): SpawnErrorKind | null {
  if (!error) return null;
  if (error.code === 'ENOENT') return 'missing';
  if (error.code === 'EPERM' || error.code === 'EACCES') return 'blocked';
  return 'error';
}

export function resolveCommandPathForPlatform(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  existsImpl: ExistsSyncLike = existsSync,
): string | null {
  if (platform === 'win32') {
    return resolveWindowsCommandPath(command, env, existsImpl);
  }
  return resolvePosixCommandPath(command, env, existsImpl);
}

export function buildPlatformCommandSpec(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  existsImpl: ExistsSyncLike = existsSync,
): PlatformCommandSpec {
  if (platform !== 'win32') {
    return { command, args: [...args] };
  }

  const resolvedPath = resolveWindowsCommandPath(command, env, existsImpl);
  if (!resolvedPath) {
    return { command, args: [...args] };
  }

  const kind = classifyWindowsCommandPath(resolvedPath);
  if (kind === 'cmd') {
    return buildCmdLaunch(resolvedPath, args, env);
  }
  if (kind === 'powershell') {
    return {
      command: resolvePowerShellExecutable(env, existsImpl),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...args],
      resolvedPath,
    };
  }
  return {
    command: resolvedPath,
    args: [...args],
    resolvedPath,
  };
}

function shouldRetryWithNodeHost(spec: PlatformCommandSpec, error: NodeJS.ErrnoException | undefined | null, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return false;
  if (classifySpawnError(error) !== 'blocked') return false;
  return NODE_HOSTED_SCRIPT_EXTENSIONS.has(extname(spec.command).toLowerCase());
}

export function spawnPlatformCommandSync(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: 'utf-8' },
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  existsImpl: ExistsSyncLike = existsSync,
  spawnImpl: SpawnSyncLike = spawnSync,
): ProbedPlatformCommand {
  const spec = buildPlatformCommandSpec(command, args, platform, env, existsImpl);
  const result = spawnImpl(spec.command, spec.args, options);
  if (!shouldRetryWithNodeHost(spec, result.error as NodeJS.ErrnoException | undefined, platform)) {
    return { spec, result };
  }

  const retrySpec: PlatformCommandSpec = {
    command: process.execPath,
    args: [spec.command, ...spec.args],
    resolvedPath: spec.command,
  };
  const retryResult = spawnImpl(retrySpec.command, retrySpec.args, options);
  return { spec: retrySpec, result: retryResult };
}
