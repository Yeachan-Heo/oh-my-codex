import { lstatSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, win32 } from 'node:path';
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
    bunShim: string;
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
      && typeof candidate.bunShim === 'string'
      && Boolean(candidate.bunShim)
      && typeof candidate.bunInstallRoot === 'string'
      && Boolean(candidate.bunInstallRoot)
      && environment.BUN_INSTALL === candidate.bunInstallRoot;
  }
  return false;
}

/** Revalidate the frozen manager, root, package, and bin before transaction advancement. */
export async function validatePackageManagerOwnership(
  ownership: PackageManagerOwnership,
): Promise<string | null> {
  if (!isCompletePackageManagerOwnership(ownership)) return null;
  try {
    const globalInstallRoot = realpathSync(ownership.globalInstallRoot);
    const packageRoot = realpathSync(ownership.packageRoot);
    if (
      pathsEqual(globalInstallRoot, packageRoot)
      || !pathsEqual(realpathSync(join(globalInstallRoot, 'oh-my-codex')), packageRoot)
      || !isPathWithin(packageRoot, globalInstallRoot)
    ) return null;
    if (ownership.manager === 'npm') {
      const root = commandResult(ownership.npmCommand, ['root', '-g'], spawnSync, { ...rootOptions, env: ownership.environment });
      const prefix = commandResult(ownership.npmCommand, ['prefix', '-g'], spawnSync, { ...rootOptions, env: ownership.environment });
      if (
        !root || !prefix
        || !pathsEqual(realpathSync(root), globalInstallRoot)
        || !pathsEqual(realpathSync(prefix), ownership.npmPrefix)
        || !isPathWithin(globalInstallRoot, realpathSync(prefix))
      ) return null;
    } else {
      if (!ownership.bunInstallRoot || ownership.environment.BUN_INSTALL !== ownership.bunInstallRoot) return null;
      const result = spawnSync(ownership.bunCommand, ['pm', 'bin', '-g'], { ...rootOptions, env: ownership.environment });
      const bin = result.error || result.status !== 0 ? null : String(result.stdout || '').trim() || null;
      if (
        !bin
        || !pathsEqual(realpathSync(bin), ownership.bunGlobalBin)
        || !pathsEqual(realpathSync(ownership.bunInstallRoot), ownership.bunInstallRoot)
      ) return null;
    }
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8')) as {
      name?: string;
      bin?: string | Record<string, string>;
    };
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.omx;
    if (manifest.name !== 'oh-my-codex' || typeof bin !== 'string' || !bin.trim() || isAbsolute(bin)) return null;
    const entry = realpathSync(join(packageRoot, bin));
    if (ownership.manager === 'bun' && (
      !pathsEqual(realpathSync(dirname(ownership.bunShim)), ownership.bunGlobalBin)
      || (basename(ownership.bunShim).toLowerCase().endsWith('.cmd')
        ? (!lstatSync(ownership.bunShim).isFile() || !isPathWithin(realpathSync(ownership.bunShim), ownership.bunGlobalBin))
        : !pathsEqual(realpathSync(ownership.bunShim), entry))
    )) return null;
    return lstatSync(entry).isFile() && isPathWithin(entry, packageRoot) ? entry : null;
  } catch {
    return null;
  }
}

export interface PackageManagerOwnershipDependencies {
  currentExecutable: string;
  currentPackageRoot: string;
  readInstallStamp: () => Promise<UserInstallStamp | null>;
  realpath: (path: string) => string;
  resolveBunGlobalBin: (command: string, environment: NodeJS.ProcessEnv) => string | null;
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

function commandResult(
  command: NpmCommand,
  args: string[],
  spawnProcess: SpawnSyncLike,
  options: SpawnSyncOptions = rootOptions,
): string | null {
  const result = runNpmCommand(command, args, options, spawnProcess);
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

/** Bun's configured global bin must be queried through its validated executable and frozen environment. */
export function resolveBunGlobalBin(command: string, environment: NodeJS.ProcessEnv = process.env, spawnProcess: SpawnSyncLike = spawnSync): string | null {
  const result = spawnProcess(command, ['pm', 'bin', '-g'], { ...rootOptions, env: environment });
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

function resolveInstalledNpmCommand(dependencies: Pick<PackageManagerOwnershipDependencies, 'currentNodeExecutable' | 'platform' | 'realpath'>, globalInstallRoot: string): NpmCommand | null {
  try {
    const path = platformPath(dependencies.platform);
    const node = dependencies.realpath(dependencies.currentNodeExecutable);
    const candidates = [
      path.join(globalInstallRoot, 'npm', 'bin', 'npm-cli.js'),
      ...(dependencies.platform === 'win32'
        ? [path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
        : []),
    ];
    for (const candidate of candidates) {
      try {
        return { kind: 'node-script', command: node, commandArgs: [dependencies.realpath(candidate)] };
      } catch {
        // Try the runtime's supported npm layout only after the selected global root.
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



function resolveBunOwnership(dependencies: Pick<PackageManagerOwnershipDependencies, 'bunInstallRoot' | 'currentExecutable' | 'currentPackageRoot' | 'environment' | 'platform' | 'realpath' | 'resolveBunGlobalBin' | 'resolveBunCommand'>): Extract<PackageManagerOwnership, { manager: 'bun' }> | null {
  try {
    if (!dependencies.bunInstallRoot) return null;
    const path = platformPath(dependencies.platform);
    const bunInstallRoot = dependencies.realpath(dependencies.bunInstallRoot);
    const globalInstallRoot = dependencies.realpath(path.join(bunInstallRoot, 'install', 'global', 'node_modules'));
    const packageRoot = matchesCurrentInstall(globalInstallRoot, dependencies);
    if (!packageRoot) return null;
    const expectedCommand = dependencies.realpath(path.join(bunInstallRoot, 'bin', dependencies.platform === 'win32' ? 'bun.exe' : 'bun'));
    if (!/^bun(?:\.exe)?$/i.test(path.basename(expectedCommand))) return null;
    const resolvedCommand = dependencies.resolveBunCommand();
    const bunCommand = resolvedCommand ? dependencies.realpath(resolvedCommand) : resolveInstalledBunCommand(dependencies);
    if (!bunCommand || !pathsEqual(bunCommand, expectedCommand, dependencies.platform)) return null;
    const environment = { ...transactionEnvironment(dependencies.environment), BUN_INSTALL: bunInstallRoot };
    const configuredBin = dependencies.resolveBunGlobalBin(bunCommand, environment);
    if (!configuredBin) return null;
    const bunGlobalBin = dependencies.realpath(configuredBin);
    const bunShim = path.join(bunGlobalBin, dependencies.platform === 'win32' ? 'omx.cmd' : 'omx');
    const shim = dependencies.realpath(bunShim);
    const executable = dependencies.realpath(dependencies.currentExecutable);
    if (!isPathWithin(executable, packageRoot, dependencies.platform)) return null;
    if (dependencies.platform === 'win32') {
      if (!isPathWithin(shim, bunGlobalBin, dependencies.platform)) return null;
    } else if (!pathsEqual(shim, executable, dependencies.platform)) {
      return null;
    }
    return {
      manager: 'bun', bunCommand, bunGlobalBin, bunShim, bunInstallRoot,
      npmPrefix: globalInstallRoot, globalInstallRoot, packageRoot, environment,
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
  // The stamp only prioritizes a probe; each candidate requires live ownership proof.
  const managers: PackageManager[] = stamp?.package_manager === 'bun' ? ['bun', 'npm'] : ['npm', 'bun'];
  const candidates: PackageManagerOwnership[] = [];
  for (const manager of managers) {
    if (manager === 'bun') {
      const ownership = resolveBunOwnership(resolved);
      if (ownership) candidates.push(ownership);
      continue;
    }
    const lifecycleNpmCommand = resolved.resolveNpmCommand();
    const selectedGlobalInstallRoot = resolved.realpath(platformPath(resolved.platform).dirname(resolved.currentPackageRoot));
    const selectedPackageRoot = matchesCurrentInstall(selectedGlobalInstallRoot, resolved);
    const npmCommand = lifecycleNpmCommand ?? (selectedPackageRoot
      ? resolveInstalledNpmCommand(resolved, selectedGlobalInstallRoot)
      : null);
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
