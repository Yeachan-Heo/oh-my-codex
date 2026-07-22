import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { UserInstallStamp } from '../scripts/postinstall-advisory.js';

export type PackageManager = 'npm' | 'bun';

type SpawnSyncLike = typeof spawnSync;
type SpawnSyncOptions = NonNullable<Parameters<SpawnSyncLike>[2]>;

export type PackageManagerOwnership =
  | {
    manager: 'npm';
    globalInstallRoot: string;
  }
  | {
    manager: 'bun';
    bunCommand: string;
    bunGlobalBin: string;
    globalInstallRoot: string;
    packageRoot: string;
  };

export interface PackageManagerOwnershipDependencies {
  currentExecutable: string;
  currentPackageRoot: string;
  readInstallStamp: () => Promise<UserInstallStamp | null>;
  realpath: (path: string) => string;
  resolveBunGlobalBin: () => string | null;
  resolveNpmGlobalInstallRoot: () => string | null;
  platform: NodeJS.Platform;
}

function spawnRoot(
  command: string,
  args: string[],
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const options: SpawnSyncOptions = {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  };
  const result = spawnProcess(command, args, options);
  if (platform === 'win32' && (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    const shim = spawnProcess(`${command}.cmd`, args, options);
    if (!shim.error && shim.status === 0) return String(shim.stdout || '').trim() || null;
  }
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

export function resolveNpmGlobalInstallRoot(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return spawnRoot('npm', ['root', '-g'], spawnProcess, platform);
}

/** Bun reports its configured global bin directory. */
export function resolveBunGlobalBin(
  spawnProcess: SpawnSyncLike = spawnSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return spawnRoot('bun', ['pm', 'bin', '-g'], spawnProcess, platform);
}

function isPathWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function matchesCurrentNpmInstall(
  root: string,
  dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'realpath'>,
): boolean {
  try {
    const packageRoot = dependencies.realpath(join(root, 'oh-my-codex'));
    const currentPackageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    return packageRoot === currentPackageRoot && isPathWithin(executable, packageRoot);
  } catch {
    return false;
  }
}

function resolveBunOwnership(
  dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'platform' | 'realpath' | 'resolveBunGlobalBin'>,
): Extract<PackageManagerOwnership, { manager: 'bun' }> | null {
  try {
    const configuredBin = dependencies.resolveBunGlobalBin();
    if (!configuredBin) return null;
    const bunGlobalBin = dependencies.realpath(configuredBin);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const shimName = dependencies.platform === 'win32' ? 'omx.cmd' : 'omx';
    const bunName = dependencies.platform === 'win32' ? 'bun.exe' : 'bun';
    if (dependencies.realpath(join(bunGlobalBin, shimName)) !== executable) return null;
    if (basename(packageRoot) !== 'oh-my-codex' || !isPathWithin(executable, packageRoot)) return null;
    return {
      manager: 'bun',
      bunCommand: dependencies.realpath(join(bunGlobalBin, bunName)),
      bunGlobalBin,
      globalInstallRoot: dirname(packageRoot),
      packageRoot,
    };
  } catch {
    return null;
  }
}

export async function resolvePackageManagerOwnership(
  dependencies: Partial<PackageManagerOwnershipDependencies> = {},
): Promise<PackageManagerOwnership | null> {
  const resolved: PackageManagerOwnershipDependencies = {
    currentExecutable: process.argv[1] ?? '',
    currentPackageRoot: process.cwd(),
    readInstallStamp: async () => null,
    realpath: (path) => realpathSync(path),
    resolveBunGlobalBin,
    resolveNpmGlobalInstallRoot,
    platform: process.platform,
    ...dependencies,
  };
  if (!resolved.currentExecutable) return null;

  const stamp = await resolved.readInstallStamp();
  const managers: PackageManager[] = stamp?.package_manager
    ? [stamp.package_manager]
    : ['npm', 'bun'];
  const candidates: PackageManagerOwnership[] = [];
  for (const manager of managers) {
    if (manager === 'bun') {
      const ownership = resolveBunOwnership(resolved);
      if (ownership) candidates.push(ownership);
      continue;
    }
    const globalInstallRoot = resolved.resolveNpmGlobalInstallRoot();
    if (globalInstallRoot && matchesCurrentNpmInstall(globalInstallRoot, resolved)) {
      candidates.push({ manager, globalInstallRoot });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function packageManagerOwnershipError(): string {
  return '[omx] Unable to determine whether this global install is owned by npm or Bun. Reinstall OMX globally with one package manager, then retry.';
}
