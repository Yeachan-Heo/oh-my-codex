import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join, posix, win32 } from 'node:path';
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
    /** Canonical configured BUN_INSTALL root when it defines this install. */
    bunInstallRoot?: string;
    npmPrefix: string;
    globalInstallRoot: string;
    packageRoot: string;
    environment: NodeJS.ProcessEnv;
  };

/** Reject incomplete or malformed serialized ownership before any package-manager spawn. */
export function isCompletePackageManagerOwnership(ownership: unknown): ownership is PackageManagerOwnership {
  if (!ownership || typeof ownership !== 'object' || Array.isArray(ownership)) return false;
  const candidate = ownership as Record<string, unknown>;
  if (
    typeof candidate.npmPrefix !== 'string' || !candidate.npmPrefix
    || typeof candidate.globalInstallRoot !== 'string' || !candidate.globalInstallRoot
    || typeof candidate.packageRoot !== 'string' || !candidate.packageRoot
    || !candidate.environment || typeof candidate.environment !== 'object' || Array.isArray(candidate.environment)
  ) return false;
  if (candidate.manager === 'npm') {
    const command = candidate.npmCommand;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
    const npmCommand = command as Record<string, unknown>;
    const commandArgs = npmCommand.commandArgs;
    return npmCommand.kind === 'node-script'
      && typeof npmCommand.command === 'string'
      && Boolean(npmCommand.command)
      && Array.isArray(commandArgs)
      && commandArgs.length > 0
      && commandArgs.every((arg: unknown) => typeof arg === 'string' && Boolean(arg));
  }
  if (candidate.manager === 'bun') {
    const environment = candidate.environment as Record<string, unknown>;
    return typeof candidate.bunCommand === 'string'
      && Boolean(candidate.bunCommand)
      && typeof candidate.bunGlobalBin === 'string'
      && Boolean(candidate.bunGlobalBin)
      && typeof candidate.bunInstallRoot === 'string'
      && Boolean(candidate.bunInstallRoot)
      && environment.BUN_INSTALL === candidate.bunInstallRoot;
  }
  return false;
}

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
  currentNodeExecutable: string;
  bunInstallRoot?: string;
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

/** Only accept Bun provenance from the current runtime, lifecycle launcher, or configured install root, never PATH. */
export function resolveBunCommand(): string | null {
  const candidates = [process.execPath, process.env.npm_execpath, process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun')]
    .filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate);
      if (/^bun(?:\.exe)?$/i.test(basename(resolved))) return resolved;
    } catch {
      // A provenance hint must be a real Bun executable to be trusted.
    }
  }
  return null;
}

function resolveInstalledNpmCommand(dependencies: Pick<PackageManagerOwnershipDependencies, 'currentNodeExecutable' | 'currentPackageRoot' | 'platform' | 'realpath'>): NpmCommand | null {
  try {
    const path = platformPath(dependencies.platform);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    if (path.basename(packageRoot) !== 'oh-my-codex') return null;
    const node = dependencies.realpath(dependencies.currentNodeExecutable);
    const candidates = dependencies.platform === 'win32'
      ? [
        path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(path.dirname(packageRoot), 'npm', 'bin', 'npm-cli.js'),
      ]
      : [path.join(path.dirname(packageRoot), 'npm', 'bin', 'npm-cli.js')];
    for (const candidate of candidates) {
      try {
        return { kind: 'node-script', command: node, commandArgs: [dependencies.realpath(candidate)] };
      } catch {
        // Try the next supported installed-npm layout; never use PATH.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function platformPath(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function resolveInstalledBunCommand(dependencies: Pick<PackageManagerOwnershipDependencies, 'bunInstallRoot' | 'currentPackageRoot' | 'platform' | 'realpath'>): string | null {
  if (!dependencies.bunInstallRoot) return null;
  try {
    const path = platformPath(dependencies.platform);
    const installRoot = dependencies.realpath(dependencies.bunInstallRoot);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    if (!pathsEqual(packageRoot, path.join(installRoot, 'install', 'global', 'node_modules', 'oh-my-codex'), dependencies.platform)) return null;
    const command = dependencies.realpath(path.join(installRoot, 'bin', dependencies.platform === 'win32' ? 'bun.exe' : 'bun'));
    return /^bun(?:\.exe)?$/i.test(path.basename(command)) ? command : null;
  } catch {
    return null;
  }
}

function transactionEnvironment(source: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['CODEX_HOME', 'HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE', 'BUN_INSTALL']) {
    if (source?.[key]) environment[key] = source[key];
  }
  return environment;
}

function pathsEqual(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return left === right;
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function isPathWithin(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  const platformPaths = platformPath(platform);
  const relation = platformPaths.relative(platformPaths.normalize(root), platformPaths.normalize(path));
  return relation === '' || (!relation.startsWith('..') && !platformPaths.isAbsolute(relation));
}

function matchesCurrentInstall(root: string, dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'currentPackageRoot' | 'platform' | 'realpath'>): string | null {
  try {
    const path = platformPath(dependencies.platform);
    const packageRoot = dependencies.realpath(path.join(root, 'oh-my-codex'));
    const currentPackageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    return pathsEqual(packageRoot, currentPackageRoot, dependencies.platform) && isPathWithin(executable, packageRoot, dependencies.platform) ? packageRoot : null;
  } catch {
    return null;
  }
}

function hasAmbiguousBunShimEvidence(dependencies: Pick<PackageManagerOwnershipDependencies, 'currentExecutable' | 'platform' | 'realpath' | 'resolveBunGlobalBin' | 'resolveBunCommand'>): boolean {
  try {
    const commandHint = dependencies.resolveBunCommand();
    if (!commandHint) return false;
    const path = platformPath(dependencies.platform);
    const command = dependencies.realpath(commandHint);
    if (!/^bun(?:\.exe)?$/i.test(path.basename(command))) return false;
    const globalBinHint = dependencies.resolveBunGlobalBin(command);
    if (!globalBinHint) return false;
    const globalBin = dependencies.realpath(globalBinHint);
    const shimName = dependencies.platform === 'win32' ? 'omx.cmd' : 'omx';
    const shim = dependencies.realpath(path.join(globalBin, shimName));
    const executable = dependencies.realpath(dependencies.currentExecutable);
    return pathsEqual(shim, executable, dependencies.platform);
  } catch {
    return false;
  }
}

function resolveBunOwnership(dependencies: Pick<PackageManagerOwnershipDependencies, 'bunInstallRoot' | 'currentExecutable' | 'currentPackageRoot' | 'environment' | 'platform' | 'realpath' | 'resolveBunGlobalBin' | 'resolveBunCommand'>): Extract<PackageManagerOwnership, { manager: 'bun' }> | null {
  try {
    if (!dependencies.bunInstallRoot) return null;
    const path = platformPath(dependencies.platform);
    const bunInstallRoot = dependencies.realpath(dependencies.bunInstallRoot);
    const packageRoot = dependencies.realpath(dependencies.currentPackageRoot);
    if (!pathsEqual(packageRoot, path.join(bunInstallRoot, 'install', 'global', 'node_modules', 'oh-my-codex'), dependencies.platform)) return null;
    const expectedCommand = dependencies.realpath(path.join(bunInstallRoot, 'bin', dependencies.platform === 'win32' ? 'bun.exe' : 'bun'));
    if (!/^bun(?:\.exe)?$/i.test(path.basename(expectedCommand))) return null;
    const resolvedCommand = dependencies.resolveBunCommand();
    const bunCommand = resolvedCommand ? dependencies.realpath(resolvedCommand) : resolveInstalledBunCommand(dependencies);
    if (!bunCommand || !pathsEqual(bunCommand, expectedCommand, dependencies.platform)) return null;
    const configuredBin = dependencies.resolveBunGlobalBin(bunCommand);
    if (!configuredBin) return null;
    const bunGlobalBin = dependencies.realpath(configuredBin);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    const shimName = dependencies.platform === 'win32' ? 'omx.cmd' : 'omx';
    const shim = dependencies.realpath(path.join(bunGlobalBin, shimName));
    if (!isPathWithin(executable, packageRoot, dependencies.platform)) return null;
    if (dependencies.platform === 'win32') {
      if (!isPathWithin(shim, bunGlobalBin, dependencies.platform)) return null;
    } else if (!pathsEqual(shim, executable, dependencies.platform)) {
      return null;
    }
    return {
      manager: 'bun', bunCommand, bunGlobalBin, bunInstallRoot,
      npmPrefix: path.dirname(packageRoot), globalInstallRoot: path.dirname(packageRoot), packageRoot,
      environment: { ...transactionEnvironment(dependencies.environment), BUN_INSTALL: bunInstallRoot },
    };
  } catch {
    return null;
  }
}

function inferBunInstallRoot(command: string | null, platform: NodeJS.Platform): string | undefined {
  if (!command) return undefined;
  const path = platformPath(platform);
  try {
    const binDirectory = path.dirname(command);
    return path.basename(binDirectory).toLowerCase() === 'bin'
      && /^bun(?:\.exe)?$/i.test(path.basename(command))
      ? path.dirname(binDirectory)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function resolvePackageManagerOwnership(dependencies: Partial<PackageManagerOwnershipDependencies> = {}): Promise<PackageManagerOwnership | null> {
  const resolved: PackageManagerOwnershipDependencies = {
    currentExecutable: process.argv[1] ?? '', currentPackageRoot: process.cwd(), currentNodeExecutable: process.execPath,
    bunInstallRoot: process.env.BUN_INSTALL,
    readInstallStamp: async () => null, realpath: (path) => realpathSync(path), resolveBunGlobalBin, resolveBunCommand,
    resolveNpmGlobalInstallRoot: (command) => resolveNpmGlobalInstallRoot(spawnSync, process.platform, command),
    resolveNpmPrefix: (command) => resolveNpmPrefix(spawnSync, process.platform, command),
    platform: process.platform, environment: process.env, ...dependencies,
    resolveNpmCommand: dependencies.resolveNpmCommand ?? resolveNpmCommand,
  };
  if (!resolved.bunInstallRoot) {
    resolved.bunInstallRoot = inferBunInstallRoot(resolved.resolveBunCommand(), resolved.platform);
  }
  if (!resolved.currentExecutable) return null;
  const stamp = await resolved.readInstallStamp();
  const managers: PackageManager[] = stamp?.package_manager ? [stamp.package_manager] : ['npm', 'bun'];
  if (!stamp?.package_manager && hasAmbiguousBunShimEvidence(resolved)) return null;
  const candidates: PackageManagerOwnership[] = [];
  for (const manager of managers) {
    if (manager === 'bun') {
      const ownership = resolveBunOwnership(resolved);
      if (ownership) candidates.push(ownership);
      continue;
    }
    const npmCommand = resolved.resolveNpmCommand() ?? resolveInstalledNpmCommand(resolved);
    if (!npmCommand) continue;
    try {
      const globalInstallRoot = resolved.realpath(resolved.resolveNpmGlobalInstallRoot(npmCommand) ?? '');
      const npmPrefix = resolved.realpath(resolved.resolveNpmPrefix(npmCommand) ?? '');
      const packageRoot = matchesCurrentInstall(globalInstallRoot, resolved);
      if (packageRoot && isPathWithin(globalInstallRoot, npmPrefix, resolved.platform)) candidates.push({ manager: 'npm', npmCommand, npmPrefix, globalInstallRoot, packageRoot, environment: transactionEnvironment(resolved.environment) });
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
