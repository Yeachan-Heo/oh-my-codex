import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { arch as osArch, constants as osConstants } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getPackageRoot } from '../utils/package.js';
import { classifySpawnError } from '../utils/platform-command.js';
import {
  API_BIN_ENV as API_BIN_ENV_SHARED,
  getPackageVersion,
  hydrateNativeBinary,
  resolveCachedNativeBinaryCandidatePaths,
  resolveLinuxNativeLibcPreference,
} from './native-assets.js';

const OMX_API_BIN_ENV = API_BIN_ENV_SHARED;

export const API_USAGE = [
  'Usage: omx api <command> [args...]',
  '',
  'Commands:',
  '  serve [--host 127.0.0.1] [--port N] [--daemon] [--system] [--dry-run]',
  '  status',
  '  stop',
  '  generate text <prompt...> [--state-file path]',
  '  generate image <prompt...> [--state-file path]',
  '',
  'Runs the native omx-api localhost gateway sidecar and forwards arguments unchanged.',
  `Set ${OMX_API_BIN_ENV} to override the native binary path.`,
].join('\n');

export interface ResolveApiBinaryPathOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  linuxLibcPreference?: readonly ('musl' | 'glibc')[];
  exists?: (path: string) => boolean;
}

export interface RunApiBinaryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawnSync;
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1;
  const signalNumber = osConstants.signals[signal];
  if (typeof signalNumber === 'number' && Number.isFinite(signalNumber)) return 128 + signalNumber;
  return 1;
}

export function apiBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'omx-api.exe' : 'omx-api';
}

export function packagedApiBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = osArch(),
  libc?: 'musl' | 'glibc',
): string {
  const platformKey = libc ? `${platform}-${arch}-${libc}` : `${platform}-${arch}`;
  return join(packageRoot, 'bin', 'native', platformKey, apiBinaryName(platform));
}

export function packagedApiBinaryCandidatePaths(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = osArch(),
  env: NodeJS.ProcessEnv = process.env,
  linuxLibcPreference?: readonly ('musl' | 'glibc')[],
): string[] {
  const candidates: string[] = [];
  if (platform === 'linux') {
    for (const libc of linuxLibcPreference ?? resolveLinuxNativeLibcPreference({ env })) {
      candidates.push(packagedApiBinaryPath(packageRoot, platform, arch, libc));
    }
  }
  candidates.push(packagedApiBinaryPath(packageRoot, platform, arch));
  return [...new Set(candidates)];
}

export function repoLocalApiBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'target', 'release', apiBinaryName(platform));
}

export function nestedRepoLocalApiBinaryPath(
  packageRoot = getPackageRoot(),
  platform: NodeJS.Platform = process.platform,
): string {
  return join(packageRoot, 'native', 'omx-api', 'target', 'release', apiBinaryName(platform));
}

export function resolveApiBinaryPath(options: ResolveApiBinaryPathOptions = {}): string {
  const {
    cwd = process.cwd(),
    env = process.env,
    packageRoot = getPackageRoot(),
    platform = process.platform,
    arch = osArch(),
    linuxLibcPreference,
    exists = existsSync,
  } = options;

  const override = env[OMX_API_BIN_ENV]?.trim();
  if (override) return isAbsolute(override) ? override : resolve(cwd, override);

  for (const packaged of packagedApiBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference)) {
    if (exists(packaged)) return packaged;
  }

  const repoLocal = repoLocalApiBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalApiBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  const packagedCandidates = packagedApiBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference);
  throw new Error(
    `[api] native binary not found. Checked ${packagedCandidates.join(', ')}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Set ${OMX_API_BIN_ENV} to override the path.`,
  );
}

export async function resolveApiBinaryPathWithHydration(
  options: ResolveApiBinaryPathOptions = {},
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

  const override = env[OMX_API_BIN_ENV]?.trim();
  if (override) return isAbsolute(override) ? override : resolve(cwd, override);

  const version = await getPackageVersion(packageRoot);
  for (const cached of resolveCachedNativeBinaryCandidatePaths('omx-api', version, platform, arch, env, {
    linuxLibcPreference: platform === 'linux'
      ? (linuxLibcPreference ?? resolveLinuxNativeLibcPreference({ env }))
      : undefined,
  })) {
    if (exists(cached)) return cached;
  }

  for (const packaged of packagedApiBinaryCandidatePaths(packageRoot, platform, arch, env, linuxLibcPreference)) {
    if (exists(packaged)) return packaged;
  }

  const repoLocal = repoLocalApiBinaryPath(packageRoot, platform);
  if (exists(repoLocal)) return repoLocal;

  const nestedRepoLocal = nestedRepoLocalApiBinaryPath(packageRoot, platform);
  if (exists(nestedRepoLocal)) return nestedRepoLocal;

  const hydrated = await hydrateNativeBinary('omx-api', { packageRoot, env, platform, arch });
  if (hydrated) return hydrated;

  throw new Error(
    `[api] native binary not found. Checked cached/native candidates under ${packageRoot}, ${repoLocal}, and ${nestedRepoLocal}. `
      + `Reconnect to the network so OMX can fetch the release asset, or set ${OMX_API_BIN_ENV} to override the path.`,
  );
}

export function runApiBinary(
  binaryPath: string,
  args: readonly string[],
  options: RunApiBinaryOptions = {},
): SpawnSyncReturns<string> {
  const { cwd = process.cwd(), env = process.env, spawnImpl = spawnSync } = options;
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  };
  return spawnImpl(binaryPath, [...args], spawnOptions);
}

function writeApiResultOutput(result: SpawnSyncReturns<string>): void {
  if (typeof result.stdout === 'string' && result.stdout.length > 0) process.stdout.write(result.stdout);
  if (typeof result.stderr === 'string' && result.stderr.length > 0) process.stderr.write(result.stderr);
}

function isHelpRequest(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  return args.includes('--help') || args.includes('-h');
}

export async function apiCommand(args: string[]): Promise<void> {
  if (isHelpRequest(args)) {
    console.log(API_USAGE);
    return;
  }

  let binaryPath: string;
  try {
    binaryPath = await resolveApiBinaryPathWithHydration();
  } catch (error) {
    throw error;
  }

  const result = runApiBinary(binaryPath, args);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(errno);
    if (kind === 'missing') throw new Error(`[api] failed to launch native binary: executable not found (${binaryPath})`);
    if (kind === 'blocked') throw new Error(`[api] failed to launch native binary: executable is blocked (${errno.code || 'blocked'})`);
    throw new Error(`[api] failed to launch native binary: ${errno.message}`);
  }

  writeApiResultOutput(result);
  if (result.status !== 0) {
    process.exitCode = typeof result.status === 'number'
      ? result.status
      : resolveSignalExitCode(result.signal);
  }
}
