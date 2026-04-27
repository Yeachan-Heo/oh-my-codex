import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'child_process';
import { existsSync } from 'fs';
import { arch as osArch, constants as osConstants } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { getPackageRoot } from '../utils/package.js';
import { classifySpawnError } from '../utils/platform-command.js';
import { readConfiguredEnvOverrides } from '../config/models.js';
import { buildCapturePaneArgv } from '../scripts/tmux-hook-engine.js';
import {
  SPARKSHELL_BIN_ENV as SPARKSHELL_BIN_ENV_SHARED,
  getPackageVersion,
  hydrateNativeBinary,
  resolveLinuxNativeLibcPreference,
  resolveCachedNativeBinaryCandidatePaths,
} from './native-assets.js';

const OMX_SPARKSHELL_BIN_ENV = SPARKSHELL_BIN_ENV_SHARED;
const OMX_SPARKSHELL_INSTRUCTIONS_FILE_ENV = 'OMX_SPARKSHELL_MODEL_INSTRUCTIONS_FILE';

export const SPARKSHELL_USAGE = [
  'Usage: omx sparkshell <command> [args...]',
  '   or: omx sparkshell --tmux-pane <pane-id> [--tail-lines <100-1000>]',
  'Runs the native omx-sparkshell sidecar with direct argv execution or explicit tmux pane summarization.',
  'Shell metacharacters such as pipes and redirects are not interpreted in v1.',
  'Tmux pane mode is explicit opt-in and captures a larger pane tail before applying raw-vs-summary behavior.',
].join('\n');

export interface ResolveSparkShellBinaryPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  linuxLibcPreference?: readonly ('musl' | 'glibc')[];
  exists?: (path: string) => boolean;
}

export interface RunSparkShellBinaryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawnSync;
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === 'number' && Number.isFinite(signalNumber)) {
    return 128 + signalNumber;
  }
  return 1;
}

export function sparkshellBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'omx-sparkshell.exe' : 'omx-sparkshell';
}

export function packagedSparkShellBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = osArch(),
  libc?: 'musl' | 'glibc',
): string {
  const platformKey = libc ? `${platform}-${arch}-${libc}` : `${platform}-${arch}`;
  return join(packageRoot, 'bin', 'native', platformKey, sparkshellBinaryName(platform));
}

export function packagedSparkShellBinaryCandidatePaths(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = osArch(),
  env: NodeJS.ProcessEnv = process.env,
  linuxLibcPreference?: readonly ('musl' | 'glibc')[],
): string[] {
  const candidates: string[] = [];
  if (platform === 'linux') {
    for (const libc of linuxLibcPreference ?? resolveLinuxNativeLibcPreference({ env })) {
      candidates.push(packagedSparkShellBinaryPath(packageRoot, platform, arch, libc));
    }
  }
  candidates.push(packagedSparkShellBinaryPath(packageRoot, platform, arch));
  return [...new Set(candidates)];
}

export function repoLocalSparkShellBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'target', 'release', sparkshellBinaryName(platform));
}

export function nestedRepoLocalSparkShellBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'native', 'omx-sparkshell', 'target', 'release', sparkshellBinaryName(platform));
}

export function resolveSparkShellBinaryPath(options: ResolveSparkShellBinaryPathOptions = {}): string {
  const {
    cwd = process.cwd(),
    env = process.env,
    packageRoot = getPackageRoot(),
    platform = process.platform,
    arch = osArch(),
    linuxLibcPreference,
    exists = existsSync,
  } = options;

  const override = env[OMX_SPARKSHELL_BIN_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }

  for (const packaged of packagedSparkShellBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference)) {
    if (exists(packaged)) return packaged;
  }

  const repoLocal = repoLocalSparkShellBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalSparkShellBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  const packagedCandidates = packagedSparkShellBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference);
  throw new Error(
    `[sparkshell] native binary not found. Checked ${packagedCandidates.join(', ')}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Set ${OMX_SPARKSHELL_BIN_ENV} to override the path.`
  );
}

export async function resolveSparkShellBinaryPathWithHydration(
  options: ResolveSparkShellBinaryPathOptions = {},
): Promise<string> {
  const {
    cwd = process.cwd(),
    env = process.env,
    packageRoot = getPackageRoot(),
    platform = process.platform,
    arch = osArch(),
    linuxLibcPreference,
    exists = existsSync,
  } = options;

  const override = env[OMX_SPARKSHELL_BIN_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }

  const version = await getPackageVersion(packageRoot);
  for (const cached of resolveCachedNativeBinaryCandidatePaths('omx-sparkshell', version, platform, arch, env, {
    linuxLibcPreference: platform === 'linux'
      ? (linuxLibcPreference ?? resolveLinuxNativeLibcPreference({ env }))
      : undefined,
  })) {
    if (exists(cached)) return cached;
  }

  for (const packaged of packagedSparkShellBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference)) {
    if (exists(packaged)) return packaged;
  }

  const repoLocal = repoLocalSparkShellBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalSparkShellBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  const hydrated = await hydrateNativeBinary('omx-sparkshell', { packageRoot, env, platform, arch });
  if (hydrated) return hydrated;

  throw new Error(
    `[sparkshell] native binary not found. Checked cached/native candidates under ${packageRoot}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Reconnect to the network so OMX can fetch the release asset, or set ${OMX_SPARKSHELL_BIN_ENV} to override the path.`
  );
}

export function runSparkShellBinary(
  binaryPath: string,
  args: readonly string[],
  options: RunSparkShellBinaryOptions = {},
): SpawnSyncReturns<string> {
  const {
    cwd = process.cwd(),
    env = process.env,
    spawnImpl = spawnSync,
  } = options;

  const configEnvOverrides = readConfiguredEnvOverrides(env.CODEX_HOME);
  const mergedEnv = {
    ...configEnvOverrides,
    ...env,
  };
  const instructionsFile = mergedEnv[OMX_SPARKSHELL_INSTRUCTIONS_FILE_ENV]?.trim()
    || join(getPackageRoot(), 'templates', 'model-instructions', 'sparkshell-lightweight-AGENTS.md');
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    env: {
      ...mergedEnv,
      [OMX_SPARKSHELL_INSTRUCTIONS_FILE_ENV]: instructionsFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  };

  return spawnImpl(binaryPath, [...args], spawnOptions);
}

function writeSparkShellResultOutput(result: SpawnSyncReturns<string>): void {
  if (typeof result.stdout === 'string' && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (typeof result.stderr === 'string' && result.stderr.length > 0) process.stderr.write(result.stderr);
}

const SPARKSHELL_GLIBC_INCOMPATIBLE_PATTERN = /GLIBC(?:XX)?_[0-9.]+['` ]+not found/i;

export function isSparkShellNativeCompatibilityFailure(result: SpawnSyncReturns<string>): boolean {
  if ((result.status ?? 0) === 0) return false;
  return SPARKSHELL_GLIBC_INCOMPATIBLE_PATTERN.test(result.stderr || '');
}

interface SparkShellFallbackInvocation {
  argv: string[];
  kind: 'command' | 'tmux-pane';
}

interface RunSparkShellFallbackOptions {
  announce?: boolean;
}

export function parseSparkShellFallbackInvocation(args: readonly string[]): SparkShellFallbackInvocation {
  if (args.length === 0) {
    throw new Error(`Missing command to run.\n${SPARKSHELL_USAGE}`);
  }

  if (args[0] !== '--tmux-pane' && !args[0]?.startsWith('--tmux-pane=')) {
    return { kind: 'command', argv: [...args] };
  }

  let paneId: string | undefined;
  let tailLines = 200;
  let sawTailLines = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--tmux-pane') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) throw new Error(`--tmux-pane requires a pane id.\n${SPARKSHELL_USAGE}`);
      paneId = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--tmux-pane=')) {
      const value = token.slice('--tmux-pane='.length).trim();
      if (!value) throw new Error(`--tmux-pane requires a pane id.\n${SPARKSHELL_USAGE}`);
      paneId = value;
      continue;
    }
    if (token === '--tail-lines') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) throw new Error(`--tail-lines requires a numeric value.\n${SPARKSHELL_USAGE}`);
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 100 || parsed > 1000) {
        throw new Error(`--tail-lines must be an integer between 100 and 1000.\n${SPARKSHELL_USAGE}`);
      }
      tailLines = parsed;
      sawTailLines = true;
      index += 1;
      continue;
    }
    if (token.startsWith('--tail-lines=')) {
      const parsed = Number.parseInt(token.slice('--tail-lines='.length), 10);
      if (!Number.isFinite(parsed) || parsed < 100 || parsed > 1000) {
        throw new Error(`--tail-lines must be an integer between 100 and 1000.\n${SPARKSHELL_USAGE}`);
      }
      tailLines = parsed;
      sawTailLines = true;
      continue;
    }
    throw new Error(`tmux pane mode does not accept an additional command.\n${SPARKSHELL_USAGE}`);
  }

  if (!paneId) throw new Error(`--tmux-pane requires a pane id.\n${SPARKSHELL_USAGE}`);
  if (!paneId.trim()) throw new Error(`--tmux-pane requires a pane id.\n${SPARKSHELL_USAGE}`);

  return {
    kind: 'tmux-pane',
    argv: ['tmux', ...buildCapturePaneArgv(paneId, sawTailLines ? tailLines : 200)],
  };
}

function runSparkShellFallback(args: readonly string[], options: RunSparkShellFallbackOptions = {}): void {
  const { announce = true } = options;
  const invocation = parseSparkShellFallbackInvocation(args);
  if (announce) {
    process.stderr.write('[sparkshell] native sidecar unavailable; falling back to raw command execution without summary support.\n');
  }
  const result = spawnSync(invocation.argv[0], invocation.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    encoding: 'utf-8',
  });
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (kind === 'missing') {
      throw new Error(`[sparkshell] raw fallback failed: executable not found (${invocation.argv[0]})`);
    }
    if (kind === 'blocked') {
      throw new Error(`[sparkshell] raw fallback failed: executable is blocked (${errno.code || 'blocked'})`);
    }
    throw new Error(`[sparkshell] raw fallback failed: ${errno.message}`);
  }
  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number'
      ? result.status
      : resolveSignalExitCode(result.signal);
  }
}

export async function sparkshellCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(SPARKSHELL_USAGE);
    return;
  }

  if (args.length === 0) {
    throw new Error(`Missing command to run.\n${SPARKSHELL_USAGE}`);
  }

  const hasExplicitOverride = typeof process.env[OMX_SPARKSHELL_BIN_ENV] === 'string'
    && process.env[OMX_SPARKSHELL_BIN_ENV]!.trim().length > 0;
  let binaryPath: string;
  try {
    binaryPath = await resolveSparkShellBinaryPathWithHydration();
  } catch (error) {
    if (!hasExplicitOverride) {
      runSparkShellFallback(args);
      return;
    }
    throw error;
  }
  const result = runSparkShellBinary(binaryPath, args);

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (!hasExplicitOverride && (kind === 'missing' || kind === 'blocked')) {
      runSparkShellFallback(args);
      return;
    }
    if (kind === 'missing') {
      throw new Error(`[sparkshell] failed to launch native binary: executable not found (${binaryPath})`);
    }
    if (kind === 'blocked') {
      throw new Error(`[sparkshell] failed to launch native binary: executable is blocked (${errno.code || 'blocked'})`);
    }
    throw new Error(`[sparkshell] failed to launch native binary: ${errno.message}`);
  }

  if (!hasExplicitOverride && isSparkShellNativeCompatibilityFailure(result)) {
    process.stderr.write('[sparkshell] GLIBC-incompatible native sidecar detected; falling back to raw command execution without summary support.\n');
    runSparkShellFallback(args, { announce: false });
    return;
  }

  writeSparkShellResultOutput(result);

  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number'
      ? result.status
      : resolveSignalExitCode(result.signal);
  }
}
