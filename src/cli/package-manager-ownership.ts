import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { UserInstallStamp } from '../scripts/postinstall-advisory.js';

export type PackageManager = 'npm' | 'bun';
type SpawnSyncLike = typeof spawnSync;
type SpawnSyncOptions = NonNullable<Parameters<SpawnSyncLike>[2]>;

/** A resolved invocation form, including the Windows shim fallback selected during validation. */
export type NpmCommand = { kind: 'direct'; command: 'npm' | 'npm.cmd' };

export type PackageManagerOwnership =
  | {
    manager: 'npm';
    npmCommand?: NpmCommand;
    npmPrefix?: string;
    globalInstallRoot: string;
    packageRoot?: string;
    environment?: NodeJS.ProcessEnv;
  }
  | {
    manager: 'bun';
    bunCommand: string;
    bunGlobalBin: string;
    npmPrefix?: string;
    globalInstallRoot: string;
    packageRoot?: string;
    environment?: NodeJS.ProcessEnv;
  };

export interface PackageManagerOwnershipDependencies {
  currentExecutable: string;
  currentPackageRoot: string;
  readInstallStamp: () => Promise<UserInstallStamp | null>;
  realpath: (path: string) => string;
  resolveBunGlobalBin: () => string | null;
  resolveBunCommand: () => string | null;
  resolveNpmCommand: () => NpmCommand | null;
  resolveNpmGlobalInstallRoot: (command?: NpmCommand) => string | null;
  resolveNpmPrefix: (command?: NpmCommand) => string | null;
  platform: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

const rootOptions: SpawnSyncOptions = {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true,
};

export function runNpmCommand(
  npmCommand: NpmCommand,
  args: string[],
  options: SpawnSyncOptions,
  spawnProcess: SpawnSyncLike = spawnSync,
): ReturnType<SpawnSyncLike> {
  return spawnProcess(npmCommand.command, args, options);
}

function commandResult(command: NpmCommand, args: string[], spawnProcess: SpawnSyncLike): string | null {
  const result = runNpmCommand(command, args, rootOptions, spawnProcess);
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

export function resolveNpmCommand(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
): NpmCommand | null {
  const commands: NpmCommand[] = [{ kind: 'direct', command: 'npm' }];
  if (platform === 'win32') commands.push({ kind: 'direct', command: 'npm.cmd' });
  return commands.find((command) => commandResult(command, ['--version'], spawnProcess) !== null) ?? null;
}

export function resolveNpmGlobalInstallRoot(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
  command = resolveNpmCommand(spawnProcess, platform),
): string | null {
  return command ? commandResult(command, ['root', '-g'], spawnProcess) : null;
}

export function resolveNpmPrefix(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
  command = resolveNpmCommand(spawnProcess, platform),
): string | null {
  return command ? commandResult(command, ['prefix', '-g'], spawnProcess) : null;
}

/** Bun reports its configured global bin directory; its executable is resolved separately. */
export function resolveBunGlobalBin(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const command = platform === 'win32' ? 'bun.exe' : 'bun';
  const result = spawnProcess(command, ['pm', 'bin', '-g'], rootOptions);
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

/** Only accept Bun provenance from the current runtime or lifecycle launcher, never the global bin path. */
export function resolveBunCommand(): string | null {
  const candidates = [process.execPath, process.env.npm_execpath].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (/^bun(?:\.exe)?$/i.test(basename(resolved))) return resolved;
    } catch {
      // A lifecycle hint must be a real Bun executable to be trusted.
    }
  }
  return null;
}

function isPathWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function matchesCurrentNpmInstall(root: string, dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'realpath'>): string | null {
  try {
    const packageRoot = dependencies.realpath(join(root, 'oh-my-codex'));
    const currentPackageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    return packageRoot === currentPackageRoot && isPathWithin(executable, packageRoot) ? packageRoot : null;
  } catch {
    return null;
  }
}

function resolveBunOwnership(dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'environment' | 'platform' | 'realpath' | 'resolveBunGlobalBin' | 'resolveBunCommand'>): Extract<PackageManagerOwnership, { manager: 'bun' }> | null {
  try {
    const configuredBin = dependencies.resolveBunGlobalBin();
    const command = dependencies.resolveBunCommand();
    if (!configuredBin || !command) return null;
    const bunGlobalBin = dependencies.realpath(configuredBin);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const shimName = dependencies.platform === 'win32' ? 'omx.cmd' : 'omx';
    if (dependencies.realpath(join(bunGlobalBin, shimName)) !== executable) return null;
    if (basename(packageRoot) !== 'oh-my-codex' || !isPathWithin(executable, packageRoot)) return null;
    return { manager: 'bun', bunCommand: dependencies.realpath(command), bunGlobalBin, npmPrefix: dirname(packageRoot), globalInstallRoot: dirname(packageRoot), packageRoot, environment: { ...(dependencies.environment ?? process.env) } };
  } catch {
    return null;
  }
}

export async function resolvePackageManagerOwnership(dependencies: Partial<PackageManagerOwnershipDependencies> = {}): Promise<PackageManagerOwnership | null> {
  const resolved: PackageManagerOwnershipDependencies = {
    currentExecutable: process.argv[1] ?? '',
    currentPackageRoot: process.cwd(),
    readInstallStamp: async () => null,
    realpath: (path) => realpathSync(path),
    resolveBunGlobalBin,
    resolveBunCommand,
    resolveNpmCommand,
    resolveNpmGlobalInstallRoot: (command) => resolveNpmGlobalInstallRoot(spawnSync, process.platform, command),
    resolveNpmPrefix: (command) => resolveNpmPrefix(spawnSync, process.platform, command),
    platform: process.platform,
    environment: process.env,
    ...dependencies,
  };
  if (!resolved.currentExecutable) return null;
  const stamp = await resolved.readInstallStamp();
  const managers: PackageManager[] = stamp?.package_manager ? [stamp.package_manager] : ['npm', 'bun'];
  const candidates: PackageManagerOwnership[] = [];
  for (const manager of managers) {
    if (manager === 'bun') {
      const ownership = resolveBunOwnership(resolved);
      if (ownership) candidates.push(ownership);
      continue;
    }
    const npmCommand = resolved.resolveNpmCommand();
    if (!npmCommand) continue;
    const globalInstallRoot = resolved.resolveNpmGlobalInstallRoot(npmCommand);
    const npmPrefix = resolved.resolveNpmPrefix(npmCommand);
    const packageRoot = globalInstallRoot && matchesCurrentNpmInstall(globalInstallRoot, resolved);
    if (globalInstallRoot && npmPrefix && packageRoot) candidates.push({ manager: 'npm', npmCommand, npmPrefix, globalInstallRoot, packageRoot, environment: { ...(resolved.environment ?? process.env) } });
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function packageManagerOwnershipError(): string {
  return '[omx] Unable to determine whether this global install is owned by npm or Bun. Reinstall OMX globally with one package manager, then retry.';
}
