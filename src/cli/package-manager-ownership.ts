import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { UserInstallStamp } from '../scripts/postinstall-advisory.js';

export type PackageManager = 'npm' | 'bun';
type SpawnSyncLike = typeof spawnSync;
type SpawnSyncOptions = NonNullable<Parameters<SpawnSyncLike>[2]>;

/** The validated executable and fixed launcher arguments for an npm transaction. */
export type NpmCommand = { kind: 'node-script'; command: string; commandArgs: string[] };

export type PackageManagerOwnership =
  | {
    manager: 'npm';
    npmCommand: NpmCommand;
    npmPrefix: string;
    globalInstallRoot: string;
    packageRoot: string;
    environment: NodeJS.ProcessEnv;
  }
  | {
    manager: 'bun';
    bunCommand: string;
    bunGlobalBin: string;
    npmPrefix: string;
    globalInstallRoot: string;
    packageRoot: string;
    environment: NodeJS.ProcessEnv;
  };

export interface PackageManagerOwnershipDependencies {
  currentExecutable: string;
  currentPackageRoot: string;
  readInstallStamp: () => Promise<UserInstallStamp | null>;
  realpath: (path: string) => string;
  resolveBunGlobalBin: (command: string) => string | null;
  resolveBunCommand: () => string | null;
  resolveNpmCommand: () => NpmCommand | null;
  resolveNpmGlobalInstallRoot: (command: NpmCommand) => string | null;
  resolveNpmPrefix: (command: NpmCommand) => string | null;
  platform: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

const rootOptions: SpawnSyncOptions = {
  encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true,
};

/** Never resolve a manager through PATH after ownership has been established. */
export function runNpmCommand(
  npmCommand: NpmCommand,
  args: string[],
  options: SpawnSyncOptions,
  spawnProcess: SpawnSyncLike = spawnSync,
): ReturnType<SpawnSyncLike> {
  return spawnProcess(npmCommand.command, [...npmCommand.commandArgs, ...args], options);
}

function commandResult(command: NpmCommand, args: string[], spawnProcess: SpawnSyncLike): string | null {
  const result = runNpmCommand(command, args, rootOptions, spawnProcess);
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

/** npm's lifecycle script is executed by this Node binary, not an ambient npm on PATH. */
export function resolveNpmCommand(): NpmCommand | null {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !isAbsolute(npmExecPath)) return null;
  try {
    const script = realpathSync(npmExecPath);
    return { kind: 'node-script', command: realpathSync(process.execPath), commandArgs: [script] };
  } catch {
    return null;
  }
}

export function resolveNpmGlobalInstallRoot(
  spawnProcess: SpawnSyncLike = spawnSync,
  _platform: NodeJS.Platform = process.platform,
  command = resolveNpmCommand(),
): string | null {
  return command ? commandResult(command, ['root', '-g'], spawnProcess) : null;
}

export function resolveNpmPrefix(
  spawnProcess: SpawnSyncLike = spawnSync,
  _platform: NodeJS.Platform = process.platform,
  command = resolveNpmCommand(),
): string | null {
  return command ? commandResult(command, ['prefix', '-g'], spawnProcess) : null;
}

/** Bun's configured global bin must be queried through its validated executable. */
export function resolveBunGlobalBin(command: string, spawnProcess: SpawnSyncLike = spawnSync): string | null {
  const result = spawnProcess(command, ['pm', 'bin', '-g'], rootOptions);
  return result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
}

/** Only accept Bun provenance from the current runtime or lifecycle launcher, never PATH. */
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

function transactionEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) {
    if (source?.[key]) environment[key] = source[key];
  }
  return environment;
}

function isPathWithin(path: string, root: string): boolean {
  const relation = relative(root, path);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function matchesCurrentInstall(root: string, dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'realpath'>): string | null {
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
    const command = dependencies.resolveBunCommand();
    if (!command) return null;
    const bunCommand = dependencies.realpath(command);
    const configuredBin = dependencies.resolveBunGlobalBin(bunCommand);
    if (!configuredBin) return null;
    const bunGlobalBin = dependencies.realpath(configuredBin);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const shimName = dependencies.platform === 'win32' ? 'omx.cmd' : 'omx';
    if (dependencies.realpath(join(bunGlobalBin, shimName)) !== executable) return null;
    if (basename(packageRoot) !== 'oh-my-codex' || !isPathWithin(executable, packageRoot)) return null;
    return { manager: 'bun', bunCommand, bunGlobalBin, npmPrefix: dirname(packageRoot), globalInstallRoot: dirname(packageRoot), packageRoot, environment: transactionEnvironment(dependencies.environment) };
  } catch {
    return null;
  }
}

export async function resolvePackageManagerOwnership(dependencies: Partial<PackageManagerOwnershipDependencies> = {}): Promise<PackageManagerOwnership | null> {
  const resolved: PackageManagerOwnershipDependencies = {
    currentExecutable: process.argv[1] ?? '', currentPackageRoot: process.cwd(), readInstallStamp: async () => null,
    realpath: (path) => realpathSync(path), resolveBunGlobalBin, resolveBunCommand, resolveNpmCommand,
    resolveNpmGlobalInstallRoot: (command) => resolveNpmGlobalInstallRoot(spawnSync, process.platform, command),
    resolveNpmPrefix: (command) => resolveNpmPrefix(spawnSync, process.platform, command),
    platform: process.platform, environment: process.env, ...dependencies,
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
    try {
      const globalInstallRoot = resolved.realpath(resolved.resolveNpmGlobalInstallRoot(npmCommand) ?? '');
      const npmPrefix = resolved.realpath(resolved.resolveNpmPrefix(npmCommand) ?? '');
      const packageRoot = matchesCurrentInstall(globalInstallRoot, resolved);
      if (packageRoot && isPathWithin(globalInstallRoot, npmPrefix)) candidates.push({ manager: 'npm', npmCommand, npmPrefix, globalInstallRoot, packageRoot, environment: transactionEnvironment(resolved.environment) });
    } catch {
      // Manager output must canonicalize before it can authorize a transaction.
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

export function packageManagerOwnershipError(): string {
  const launcher = basename(process.env.npm_execpath ?? '').toLowerCase();
  if (launcher.includes('pnpm') || launcher.includes('yarn')) return '[omx] pnpm and Yarn global ownership layouts are not supported for self-update. Reinstall OMX with npm or Bun, then retry.';
  return '[omx] Unable to determine whether this global install is owned by npm or Bun. Reinstall OMX globally with one supported package manager, then retry.';
}
