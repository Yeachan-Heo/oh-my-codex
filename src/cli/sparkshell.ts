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

const OMX_SPARKSHELL_BIN_ENV = 'OMX_SPARKSHELL_BIN';

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
): string {
  return join(packageRoot, 'bin', 'native', `${platform}-${arch}`, sparkshellBinaryName(platform));
}

export function repoLocalSparkShellBinaryPath(
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
    exists = existsSync,
  } = options;

  const override = env[OMX_SPARKSHELL_BIN_ENV]?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd, override);
  }

  const packaged = packagedSparkShellBinaryPath(packageRoot, platform, arch);
  if (exists(packaged)) return packaged;

  const repoLocal = repoLocalSparkShellBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  throw new Error(
    `[sparkshell] native binary not found. Checked ${packaged} and ${repoLocal}. `
      + `Set ${OMX_SPARKSHELL_BIN_ENV} to override the path.`
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

  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    env,
    stdio: 'inherit',
    encoding: 'utf-8',
  };

  return spawnImpl(binaryPath, [...args], spawnOptions);
}

export async function sparkshellCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(SPARKSHELL_USAGE);
    return;
  }

  if (args.length === 0) {
    throw new Error(`Missing command to run.\n${SPARKSHELL_USAGE}`);
  }

  const binaryPath = resolveSparkShellBinaryPath();
  const result = runSparkShellBinary(binaryPath, args);

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (kind === 'missing') {
      throw new Error(`[sparkshell] failed to launch native binary: executable not found (${binaryPath})`);
    }
    if (kind === 'blocked') {
      throw new Error(`[sparkshell] failed to launch native binary: executable is blocked (${errno.code || 'blocked'})`);
    }
    throw new Error(`[sparkshell] failed to launch native binary: ${errno.message}`);
  }

  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number'
      ? result.status
      : resolveSignalExitCode(result.signal);
  }
}
