/**
 * Update orchestration for oh-my-codex.
 *
 * The launch-time checker is intentionally passive, non-fatal, and throttled.
 * The explicit `omx update` command uses the same executor but bypasses the
 * launch-time cadence so a user request always checks npm immediately.
 */

import { readFile, writeFile, mkdir, realpath } from 'fs/promises';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, relative, isAbsolute } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import { getPackageRoot } from '../utils/package.js';
import {
  readPersistedSetupPreferencesSync,
  resolvePersistedSetupMergeAgents,
} from './setup-preferences.js';
import {
  isCompletePackageManagerOwnership,
  packageManagerOwnershipError,
  resolvePackageManagerOwnership,
  runNpmCommand,
  validatePackageManagerOwnership,
  type PackageManagerOwnership,
} from './package-manager-ownership.js';
import {
  readUserInstallStamp,
  writeUserInstallStamp,
  type UserInstallStamp,
} from '../scripts/postinstall-advisory.js';
export {
  isInstallVersionBump,
  readUserInstallStamp,
  writeUserInstallStamp,
} from '../scripts/postinstall-advisory.js';
export type { UserInstallStamp } from '../scripts/postinstall-advisory.js';

export interface UpdateState {
  last_checked_at: string;
  last_seen_latest?: string;
}


interface LatestPackageInfo {
  version?: string;
}

interface PackageManifest {
  bin?: string | Record<string, string>;
  version?: string;
}

export interface UpdateExecutionResult {
  status: 'updated' | 'scheduled' | 'up-to-date' | 'declined' | 'failed' | 'unavailable';
  currentVersion: string | null;
  latestVersion: string | null;
}

export type UpdateChannel = 'stable' | 'dev';

export interface UpdateChannelConfig {
  channel: UpdateChannel;
  installSource: string;
}

type RunGlobalUpdateResult = { ok: boolean; stderr: string; revision?: string | null };
type RunSetupRefreshResult = { ok: boolean; stderr: string };
type RunDeferredUpdateResult = { ok: boolean; stderr: string; logPath?: string };
type SpawnSyncLike = typeof spawnSync;
type SpawnSyncOptions = NonNullable<Parameters<SpawnSyncLike>[2]>;
type SpawnLike = typeof spawn;
export type AutoUpdateMode = 'disabled' | 'prompt' | 'defer';

const PACKAGE_NAME = 'oh-my-codex';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const STABLE_INSTALL_SOURCE = `${PACKAGE_NAME}@latest`;
const DEV_INSTALL_SOURCE = 'github:Yeachan-Heo/oh-my-codex#dev';
const DEV_REPOSITORY_URL = 'https://github.com/Yeachan-Heo/oh-my-codex.git';
const DEV_REPOSITORY_BRANCH = 'dev';
const DEV_UPDATE_TIMEOUT_MS = 300000;
const SKIP_NATIVE_AGENT_REFRESH_ENV = 'OMX_SKIP_NATIVE_AGENT_REFRESH';

export function resolveUpdateChannelConfig(channel: UpdateChannel = 'stable'): UpdateChannelConfig {
  if (channel === 'dev') {
    return { channel: 'dev', installSource: DEV_INSTALL_SOURCE };
  }
  return { channel: 'stable', installSource: STABLE_INSTALL_SOURCE };
}

export function resolveAutoUpdateMode(value = process.env.OMX_AUTO_UPDATE): AutoUpdateMode {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return 'prompt';
  if (normalized === '0') return 'disabled';
  if (normalized === 'defer') return 'defer';
  return 'prompt';
}

function parseSemver(version: string): [number, number, number] | null {
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

export function shouldCheckForUpdates(
  nowMs: number,
  state: UpdateState | null,
  intervalMs = CHECK_INTERVAL_MS
): boolean {
  if (!state?.last_checked_at) return true;
  const last = Date.parse(state.last_checked_at);
  if (!Number.isFinite(last)) return true;
  return (nowMs - last) >= intervalMs;
}

function updateStatePath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'update-check.json');
}

async function readUpdateState(cwd: string): Promise<UpdateState | null> {
  const path = updateStatePath(cwd);
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as UpdateState;
  } catch {
    return null;
  }
}

async function writeUpdateState(cwd: string, state: UpdateState): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(updateStatePath(cwd), JSON.stringify(state, null, 2));
}

async function fetchLatestVersion(timeoutMs = 3500): Promise<string | null> {
  const registryUrl = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(registryUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json() as LatestPackageInfo;
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getCurrentVersion(): Promise<string | null> {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const content = await readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}


function stableInstallArgs(ownership: PackageManagerOwnership, installSource: string): string[] {
  return ownership.manager === 'bun'
    ? ['add', '--global', '--ignore-scripts', installSource]
    : ['install', '--global', '--ignore-scripts', '--no-audit', '--no-progress', '--prefix', ownership.npmPrefix, installSource];
}

function runFrozenNpmInstall(
  ownership: Extract<PackageManagerOwnership, { manager: 'npm' }>,
  installSource: string,
  options: SpawnSyncOptions,
  spawnProcess: SpawnSyncLike,
): ReturnType<SpawnSyncLike> {
  return runNpmCommand(ownership.npmCommand, stableInstallArgs(ownership, installSource), options, spawnProcess);
}

function commandFailure(stderr: unknown, status: number | null, label: string): RunGlobalUpdateResult {
  const details = String(stderr || '').trim();
  return {
    ok: false,
    stderr: details || `${label} exited ${typeof status === 'number' ? status : 'without a status'}`,
  };
}

function runDevGlobalUpdate(
  ownership: Extract<PackageManagerOwnership, { manager: 'npm' }>,
  spawnProcess: SpawnSyncLike = spawnSync,
): RunGlobalUpdateResult {
  const tempRoot = mkdtempSync(join(tmpdir(), 'omx-dev-update-'));
  const checkoutDir = join(tempRoot, 'checkout');

  try {
    const cloneResult = spawnProcess(
      'git',
      ['clone', '--depth', '1', '--branch', DEV_REPOSITORY_BRANCH, DEV_REPOSITORY_URL, checkoutDir],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEV_UPDATE_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    if (cloneResult.error) return { ok: false, stderr: cloneResult.error.message };
    if (cloneResult.status !== 0) {
      return commandFailure(cloneResult.stderr, cloneResult.status, 'git clone');
    }

    const revisionResult = spawnProcess(
      'git',
      ['rev-parse', 'HEAD'],
      {
        cwd: checkoutDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15000,
        windowsHide: true,
      },
    );
    const clonedRevision = revisionResult.status === 0
      ? String(revisionResult.stdout || '').trim()
      : null;
    const installRevision = /^[0-9a-f]{7,40}$/i.test(clonedRevision ?? '')
      ? String(clonedRevision).slice(0, 12)
      : null;

    const installResult = runNpmCommand(
      ownership.npmCommand,
      [
        'install',
        '--global=false',
        '--location=project',
        '--include=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-progress',
      ],
      {
        cwd: checkoutDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEV_UPDATE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...ownership.environment, npm_config_global: 'false', npm_config_location: 'project' },
      },
      spawnProcess,
    );
    if (installResult.error) return { ok: false, stderr: installResult.error.message };
    if (installResult.status !== 0) {
      return commandFailure(installResult.stderr, installResult.status, 'npm install --include=dev');
    }

    const prepackResult = runNpmCommand(
      ownership.npmCommand,
      ['run', 'prepack'],
      {
        cwd: checkoutDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEV_UPDATE_TIMEOUT_MS,
        windowsHide: true,
        env: ownership.environment,
      },
      spawnProcess,
    );
    if (prepackResult.error) return { ok: false, stderr: prepackResult.error.message };
    if (prepackResult.status !== 0) {
      return commandFailure(prepackResult.stderr, prepackResult.status, 'npm run prepack');
    }

    const packResult = runNpmCommand(
      ownership.npmCommand,
      ['pack', '--ignore-scripts', '--json'],
      {
        cwd: checkoutDir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEV_UPDATE_TIMEOUT_MS,
        windowsHide: true,
        env: ownership.environment,
      },
      spawnProcess,
    );
    if (packResult.error) return { ok: false, stderr: packResult.error.message };
    if (packResult.status !== 0) {
      return commandFailure(packResult.stderr, packResult.status, 'npm pack');
    }

    let tarballPath: string | null = null;
    try {
      const packed = JSON.parse(String(packResult.stdout || '[]')) as Array<{ filename?: string }>;
      const filename = packed[0]?.filename;
      if (typeof filename === 'string' && filename.trim() !== '') {
        tarballPath = join(checkoutDir, filename);
      }
    } catch {
      tarballPath = null;
    }
    if (!tarballPath || !existsSync(tarballPath)) {
      return { ok: false, stderr: 'npm pack did not produce an installable tarball.' };
    }

    const globalInstallResult = runNpmCommand(
      ownership.npmCommand,
      ['install', '--global', '--ignore-scripts', '--no-audit', '--no-progress', '--prefix', ownership.npmPrefix, tarballPath],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: DEV_UPDATE_TIMEOUT_MS,
        windowsHide: true,
        env: ownership.environment,
      },
      spawnProcess,
    );
    if (globalInstallResult.error) {
      return { ok: false, stderr: globalInstallResult.error.message };
    }
    if (globalInstallResult.status !== 0) {
      return commandFailure(globalInstallResult.stderr, globalInstallResult.status, 'npm install -g dev tarball');
    }

    return { ok: true, stderr: '', revision: installRevision };
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort. Do not mask a successful update or the primary
      // failure from git/npm with a transient temp-directory removal error.
    }
  }
}

export function runGlobalUpdate(
  installSourceOrSpawnProcess: string | SpawnSyncLike = STABLE_INSTALL_SOURCE,
  spawnProcessOrPlatform: SpawnSyncLike | NodeJS.Platform = spawnSync,
  _platform: NodeJS.Platform = process.platform,
  ownership?: PackageManagerOwnership,
): RunGlobalUpdateResult {
  if (typeof installSourceOrSpawnProcess === 'function') {
    return { ok: false, stderr: 'A validated package-manager ownership transaction is required before installing.' };
  }
  const installSource = installSourceOrSpawnProcess;
  const spawnProcess = typeof spawnProcessOrPlatform === 'function' ? spawnProcessOrPlatform : spawnSync;
  if (!ownership || !isCompletePackageManagerOwnership(ownership)) {
    return { ok: false, stderr: ownership ? 'The package-manager ownership transaction is incomplete.' : 'A validated package-manager ownership transaction is required before installing.' };
  }
  if (installSource === DEV_INSTALL_SOURCE) {
    return ownership.manager === 'bun'
      ? { ok: false, stderr: 'Bun dev updates are not yet supported' }
      : runDevGlobalUpdate(ownership, spawnProcess);
  }
  const result = ownership.manager === 'bun'
    ? spawnProcess(ownership.bunCommand, stableInstallArgs(ownership, installSource), {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true, env: ownership.environment!,
    })
    : runFrozenNpmInstall(ownership, installSource, {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, windowsHide: true, env: ownership.environment!,
    }, spawnProcess);
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stderr: String(result.stderr || '').trim() || `${ownership.manager} exited ${result.status}` };
  }
  return { ok: true, stderr: '' };
}


export function resolveSetupRefreshArgs(cwd: string): string[] {
  const preferences = readPersistedSetupPreferencesSync(cwd);
  const args = ['setup'];
  if (preferences?.scope) {
    args.push('--scope', preferences.scope);
  }
  if (preferences?.installMode === 'plugin') {
    args.push('--plugin');
  } else if (preferences?.installMode === 'legacy') {
    args.push('--legacy');
  }
  if (preferences?.mcpMode) {
    args.push('--mcp', preferences.mcpMode);
  }
  if (preferences?.teamMode === 'disabled') {
    args.push('--disable-team');
  } else if (preferences?.teamMode === 'enabled') {
    args.push('--enable-team');
  }
  const mergeAgents = resolvePersistedSetupMergeAgents(preferences, preferences?.scope ?? 'user');
  if (mergeAgents === true) {
    args.push('--merge-agents');
  } else if (mergeAgents === false) {
    args.push('--no-merge-agents');
  }
  return args;
}

function quotePosixShellArg(value: string): string {
  return value === '' ? "''" : `'${value.replace(/'/g, "'\\''")}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Compatibility formatter retained for existing callers; deferred updates use update-worker instead. */
export function formatDeferredSetupCommand(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
): string {
  const argv = [command, ...args];
  return platform === 'win32'
    ? `& ${argv.map(quotePowerShellArg).join(' ')}`
    : argv.map(quotePosixShellArg).join(' ');
}

function formatUpdateLogPath(date = new Date()): string {
  return `update-${date.toISOString().replace(/[:.]/g, '-')}.log`;
}

interface DeferredUpdatePayload {
  cwd: string;
  logPath: string;
  parentPid: number;
  ownership: PackageManagerOwnership;
  setupArgs: string[];
}

export function runDeferredGlobalUpdate(
  cwd: string,
  spawnProcess: SpawnLike = spawn,
  platform: NodeJS.Platform = process.platform,
  parentPid = process.pid,
  ownership?: PackageManagerOwnership,
): RunDeferredUpdateResult {
  const logPath = join(cwd, '.omx', 'logs', formatUpdateLogPath());
  if (!isCompletePackageManagerOwnership(ownership)) {
    return { ok: false, stderr: 'The package-manager ownership transaction is incomplete.', logPath };
  }
  let stage: string | undefined;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    stage = mkdtempSync(join(tmpdir(), 'omx-update-'));
    if (platform !== 'win32') chmodSync(stage, 0o700);
    const payloadPath = join(stage, 'transaction.json');
    const payload: DeferredUpdatePayload = { cwd, logPath, parentPid, ownership, setupArgs: resolveSetupRefreshArgs(cwd) };
    const serialized = JSON.stringify(payload);
    writeFileSync(payloadPath, serialized, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    const canonicalStage = realpathSync(stage);
    const canonicalPayload = realpathSync(payloadPath);
    const stageStat = lstatSync(stage);
    const payloadStat = lstatSync(payloadPath);
    if (
      !stageStat.isDirectory()
      || stageStat.isSymbolicLink()
      || (platform !== 'win32' && ((stageStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stageStat.uid !== process.getuid())))
      || canonicalPayload !== join(canonicalStage, 'transaction.json')
      || payloadStat.isSymbolicLink()
      || !payloadStat.isFile()
      || (platform !== 'win32' && (payloadStat.mode & 0o077) !== 0)
    ) throw new Error('Deferred update payload is not a canonical owner-only staged file.');
    const bundledWorker = join(dirname(fileURLToPath(import.meta.url)), 'update-worker.js');
    const workerCandidate = existsSync(bundledWorker) ? bundledWorker : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'cli', 'update-worker.js');
    const workerPath = realpathSync(workerCandidate);
    if (lstatSync(workerCandidate).isSymbolicLink() || !lstatSync(workerPath).isFile()) throw new Error('Deferred update worker is not a regular canonical file.');
    const payloadFingerprint = createHash('sha256').update(readFileSync(canonicalPayload)).digest('hex');
    const workerFingerprint = createHash('sha256').update(readFileSync(workerPath)).digest('hex');
    const stagedDirectory = stage;
    const child = spawnProcess(process.execPath, [workerPath, payloadPath, payloadFingerprint, workerFingerprint], {
      cwd, detached: true, env: { ...ownership.environment, [SKIP_NATIVE_AGENT_REFRESH_ENV]: '1' }, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', (error) => {
      try {
        appendFileSync(logPath, `[omx] Deferred update launcher failed: ${error.message}\n`, 'utf-8');
      } catch {
        // The scheduler must not become fatal when diagnostics cannot be persisted.
      }
      try {
        rmSync(stagedDirectory, { recursive: true, force: true });
      } catch {
        // The asynchronous launcher failure must not throw into the caller.
      }
    });
    child.unref();
    stage = undefined;
    return { ok: true, stderr: '', logPath };
  } catch (error) {
    if (stage) {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch {
        // Preserve the original scheduling failure when cleanup cannot complete.
      }
    }
    return { ok: false, stderr: error instanceof Error ? error.message : String(error), logPath };
  }
}

function formatDeferredUpdateFailure(
  stderr: string,
  logPath?: string,
  manager: PackageManagerOwnership['manager'] = 'npm',
): string {
  return [
    '[omx] Failed to schedule the deferred update.',
    stderr.trim() ? `[omx] scheduler error: ${stderr.trim()}` : undefined,
    logPath ? `[omx] Intended log: ${logPath}` : undefined,
    `[omx] Retry with the selected ${manager} owner through: omx update`,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function summarizeUpdateFailure(
  stderr: string,
  installSource = STABLE_INSTALL_SOURCE,
  logPath?: string,
  manager: PackageManagerOwnership['manager'] = 'npm',
): string {
  const details = stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ');
  if (installSource === DEV_INSTALL_SOURCE) {
    return [
      `[omx] Update failed while building and installing the dev channel from ${DEV_REPOSITORY_URL}#${DEV_REPOSITORY_BRANCH}.`,
      details ? `[omx] update stderr: ${details}` : undefined,
      logPath ? `[omx] Full log: ${logPath}` : undefined,
      '[omx] You can retry manually with: omx update --dev',
    ].filter((line): line is string => typeof line === 'string').join('\n');
  }
  const installCommand = `${manager === 'bun' ? 'bun add -g' : 'npm install -g'} ${installSource}`;
  return [
    `[omx] Update failed while running the selected ${manager} transaction (${installCommand}).`,
    details ? `[omx] ${manager} stderr: ${details}` : undefined,
    logPath ? `[omx] Full log: ${logPath}` : undefined,
    '[omx] Retry through the ownership-safe recovery command: omx update',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

interface UpdateDependencies {
  askYesNo: typeof askYesNo;
  fetchLatestVersion: typeof fetchLatestVersion;
  getCurrentVersion: typeof getCurrentVersion;
  getInstalledVersionAfterUpdate: typeof getInstalledVersionAfterUpdate;
  getInstalledRevisionAfterUpdate: typeof getInstalledRevisionAfterUpdate;
  readUserInstallStamp: typeof readUserInstallStamp;
  resolvePackageManagerOwnership: () => Promise<PackageManagerOwnership | null>;
  runGlobalUpdate: (installSource: string, ownership?: PackageManagerOwnership) => RunGlobalUpdateResult;
  runDeferredGlobalUpdate: (cwd: string, ownership?: PackageManagerOwnership) => RunDeferredUpdateResult;
  runSetupRefresh: (cwd: string, ownership?: PackageManagerOwnership) => Promise<RunSetupRefreshResult>;
  writeUpdateState: typeof writeUpdateState;
}

async function resolveCurrentPackageManagerOwnership(): Promise<PackageManagerOwnership | null> {
  return resolvePackageManagerOwnership({
    currentPackageRoot: getPackageRoot(),
    readInstallStamp: readUserInstallStamp,
  });
}

const defaultUpdateDependencies: UpdateDependencies = {
  askYesNo,
  fetchLatestVersion,
  getCurrentVersion,
  getInstalledVersionAfterUpdate,
  getInstalledRevisionAfterUpdate,
  readUserInstallStamp,
  resolvePackageManagerOwnership: resolveCurrentPackageManagerOwnership,
  runGlobalUpdate: (installSource, ownership) => runGlobalUpdate(installSource, spawnSync, process.platform, ownership),
  runDeferredGlobalUpdate: (cwd, ownership) => runDeferredGlobalUpdate(cwd, spawn, process.platform, process.pid, ownership),
  runSetupRefresh,
  writeUpdateState,
}

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, '');
}

async function writeSuccessfulInstallStamp(
  installedVersion: string,
  metadata: {
    channel?: UpdateChannel;
    source?: string;
    revision?: string | null;
    devBaseVersion?: string | null;
    packageManager?: PackageManagerOwnership['manager'];
  } = {},
): Promise<void> {
  await writeUserInstallStamp({
    installed_version: stripLeadingV(installedVersion),
    setup_completed_version: stripLeadingV(installedVersion),
    ...(metadata.channel ? { install_channel: metadata.channel } : {}),
    ...(metadata.source ? { install_source: metadata.source } : {}),
    ...(metadata.revision ? { install_revision: metadata.revision } : {}),
    ...(metadata.devBaseVersion ? { dev_base_version: stripLeadingV(metadata.devBaseVersion) } : {}),
    ...(metadata.packageManager ? { package_manager: metadata.packageManager } : {}),
    updated_at: new Date().toISOString(),
  });
}


function doesSetupStampMatchVersion(
  currentVersion: string,
  stamp: UserInstallStamp | null,
): boolean {
  return stripLeadingV(stamp?.setup_completed_version ?? '') === stripLeadingV(currentVersion);
}

function resolveUpdateCheckBaseline(
  currentVersion: string | null,
  stamp: UserInstallStamp | null,
): string | null {
  if (!currentVersion) return null;
  const current = stripLeadingV(currentVersion);
  const stampVersion = stripLeadingV(stamp?.setup_completed_version ?? stamp?.installed_version ?? '');
  const devBaseVersion = stripLeadingV(stamp?.dev_base_version ?? '');

  // Launch-time update checks must not synthesize dev_base_version from npm
  // latest alone. A dev baseline is install metadata, so only a matching dev
  // stamp written by a successful dev update can raise the comparison baseline.
  if (
    stamp?.install_channel === 'dev' &&
    stampVersion === current &&
    devBaseVersion &&
    isNewerVersion(current, devBaseVersion)
  ) {
    return devBaseVersion;
  }

  return currentVersion;
}


async function getInstalledVersionAfterUpdate(ownership?: PackageManagerOwnership): Promise<string | null> {
  const globalInstallRoot = ownership?.globalInstallRoot;
  if (!globalInstallRoot) return null;
  try {
    const content = await readFile(join(globalInstallRoot, PACKAGE_NAME, 'package.json'), 'utf-8');
    const pkg = JSON.parse(content) as PackageManifest;
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version : null;
  } catch {
    return null;
  }
}

async function getInstalledRevisionAfterUpdate(ownership?: PackageManagerOwnership): Promise<string | null> {
  const globalInstallRoot = ownership?.globalInstallRoot;
  if (!globalInstallRoot) return null;
  try {
    const content = await readFile(join(globalInstallRoot, PACKAGE_NAME, 'package.json'), 'utf-8');
    const pkg = JSON.parse(content) as { gitHead?: string };
    const revision = typeof pkg.gitHead === 'string' ? pkg.gitHead.trim() : '';
    return /^[0-9a-f]{7,40}$/i.test(revision) ? revision.slice(0, 12) : null;
  } catch {
    return null;
  }
}

async function resolveCliEntryWithinPackage(packageRoot: string, relativePath: string): Promise<string | null> {
  if (relativePath.trim() === '' || isAbsolute(relativePath)) return null;
  try {
    const cliEntry = await realpath(join(packageRoot, relativePath));
    const relation = relative(packageRoot, cliEntry);
    return relation !== '' && !relation.startsWith('..') && !isAbsolute(relation) ? cliEntry : null;
  } catch {
    return null;
  }
}

export async function resolveInstalledCliEntry(globalInstallRoot: string): Promise<string | null> {
  const packageRoot = join(globalInstallRoot, PACKAGE_NAME);
  let packageRootRealpath: string;
  try {
    packageRootRealpath = await realpath(packageRoot);
  } catch {
    return null;
  }
  try {
    const content = await readFile(join(packageRootRealpath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(content) as PackageManifest;
    const cliRelativePath = typeof pkg.bin === 'string'
      ? pkg.bin
      : pkg.bin && typeof pkg.bin === 'object' ? pkg.bin.omx : undefined;
    return typeof cliRelativePath === 'string'
      ? resolveCliEntryWithinPackage(packageRootRealpath, cliRelativePath)
      : null;
  } catch {
    return resolveCliEntryWithinPackage(packageRootRealpath, join('dist', 'cli', 'omx.js'));
  }
}

export function spawnInstalledSetupRefresh(
  cliEntry: string,
  cwd: string,
  spawnProcess: SpawnSyncLike = spawnSync,
  command = process.execPath,
  environment: NodeJS.ProcessEnv = process.env,
): RunSetupRefreshResult {
  const result = spawnProcess(command, [cliEntry, ...resolveSetupRefreshArgs(cwd)], {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      stderr: `The updated setup refresh exited with status ${result.status}.`,
    };
  }

  return { ok: true, stderr: '' };
}

async function runSetupRefresh(cwd: string, ownership?: PackageManagerOwnership): Promise<RunSetupRefreshResult> {
  if (!ownership || !ownership.packageRoot) return { ok: false, stderr: 'A frozen package-manager ownership transaction is required for setup refresh.' };
  const cliEntry = await validatePackageManagerOwnership(ownership);
  if (!cliEntry) {
    return { ok: false, stderr: `Frozen manager, package root, or bin ownership validation failed before setup refresh under ${join(ownership.globalInstallRoot, PACKAGE_NAME)}.` };
  }
  return spawnInstalledSetupRefresh(
    cliEntry,
    cwd,
    spawnSync,
    process.execPath,
    { ...ownership.environment, [SKIP_NATIVE_AGENT_REFRESH_ENV]: '1' },
  );
}

async function executeUpdate(
  options: {
    cwd: string;
    dependencies: UpdateDependencies;
    prompt: boolean;
    immediate: boolean;
    channel?: UpdateChannel;
    forceInstall?: boolean;
    nowMs?: number;
  },
): Promise<UpdateExecutionResult> {
  const {
    cwd,
    dependencies,
    prompt,
    immediate,
    channel = 'stable',
    forceInstall = false,
    nowMs = Date.now(),
  } = options;
  const channelConfig = resolveUpdateChannelConfig(channel);
  const usesNativeTransaction = immediate
    ? dependencies.runGlobalUpdate === defaultUpdateDependencies.runGlobalUpdate
      || dependencies.runSetupRefresh === defaultUpdateDependencies.runSetupRefresh
    : dependencies.runDeferredGlobalUpdate === defaultUpdateDependencies.runDeferredGlobalUpdate;
  const ownership = usesNativeTransaction
    ? await dependencies.resolvePackageManagerOwnership()
    : null;
  if (usesNativeTransaction && !ownership) {
    console.log(packageManagerOwnershipError());
    return { status: 'failed', currentVersion: null, latestVersion: null };
  }
  if (ownership?.manager === 'bun' && channel === 'dev') {
    console.log('[omx] Bun dev updates are not yet supported');
    return { status: 'failed', currentVersion: null, latestVersion: null };
  }
  const [current, latest] = await Promise.all([
    dependencies.getCurrentVersion(),
    channel === 'stable' || !forceInstall || channel === 'dev' ? dependencies.fetchLatestVersion() : Promise.resolve(null),
  ]);
  const installStamp = await dependencies.readUserInstallStamp();
  const updateCheckBaseline = !forceInstall
    ? resolveUpdateCheckBaseline(current, installStamp)
    : current;

  try {
    await dependencies.writeUpdateState(cwd, {
      last_checked_at: new Date(nowMs).toISOString(),
      last_seen_latest: latest ?? undefined,
    });
  } catch {
    // Update-check state is advisory only. Do not fail installs or explicit updates
    // just because the current working directory is read-only or unavailable.
  }

  if (!forceInstall && (!updateCheckBaseline || !latest)) {
    if (immediate) {
      console.log('[omx] Unable to determine the latest oh-my-codex version. Try again later.');
    }
    return { status: 'unavailable', currentVersion: current, latestVersion: latest };
  }

  if (!forceInstall && updateCheckBaseline && latest && !isNewerVersion(updateCheckBaseline, latest)) {
    if (immediate) {
      if (current && !doesSetupStampMatchVersion(current, installStamp)) {
        console.log(
          `[omx] oh-my-codex is already up to date (v${updateCheckBaseline}). Running setup refresh...`,
        );
        const setupRefreshResult = await dependencies.runSetupRefresh(cwd, ownership ?? undefined);
        if (!setupRefreshResult.ok) {
          console.log(
            `[omx] Update installed, but the setup refresh failed. Run \`omx setup\` with the new install. (${setupRefreshResult.stderr})`,
          );
          return { status: 'failed', currentVersion: current, latestVersion: latest };
        }
        await writeSuccessfulInstallStamp(current, { packageManager: ownership?.manager });
        console.log(`[omx] Setup refresh completed for v${updateCheckBaseline}. Restart to use current code.`);
        return { status: 'up-to-date', currentVersion: current, latestVersion: latest };
      }
    }

    if (immediate) {
      console.log(`[omx] oh-my-codex is already up to date (v${updateCheckBaseline}).`);
    }
    return { status: 'up-to-date', currentVersion: current, latestVersion: latest };
  }

  if (prompt) {
    const approved = await dependencies.askYesNo(
      immediate
        ? `[omx] Update available: v${updateCheckBaseline} → v${latest}. Update now? [Y/n] `
        : `[omx] Update available: v${updateCheckBaseline} → v${latest}. Update after this session exits? [Y/n] `,
    );
    if (!approved) {
      return { status: 'declined', currentVersion: current, latestVersion: latest };
    }
  }

  if (!immediate) {
    const deferredResult = dependencies.runDeferredGlobalUpdate(cwd, ownership ?? undefined);
    if (!deferredResult.ok) {
      console.log(formatDeferredUpdateFailure(deferredResult.stderr, deferredResult.logPath, ownership?.manager));
      return { status: 'failed', currentVersion: current, latestVersion: latest };
    }
    console.log('[omx] Update scheduled after this session exits.');
    if (deferredResult.logPath) {
      console.log(`[omx] Log: ${deferredResult.logPath}`);
    }
    return { status: 'scheduled', currentVersion: current, latestVersion: latest };
  }

  console.log(`[omx] Selected update channel: ${channelConfig.channel}`);
  console.log(`[omx] Install source: ${channelConfig.installSource}`);
  if (channelConfig.channel === 'dev') {
    console.log('[omx] Running: clone dev branch, run prepack, then npm install -g the packed tarball');
  } else {
    console.log(`[omx] Running: ${ownership?.manager === 'bun' ? 'bun add -g' : 'npm install -g'} ${channelConfig.installSource}`);
  }
  const result = dependencies.runGlobalUpdate(channelConfig.installSource, ownership ?? undefined);

  if (!result.ok) {
    console.log(summarizeUpdateFailure(result.stderr, channelConfig.installSource, undefined, ownership?.manager));
    return { status: 'failed', currentVersion: current, latestVersion: latest };
  }

  const setupRefreshResult = await dependencies.runSetupRefresh(cwd, ownership ?? undefined);
  if (!setupRefreshResult.ok) {
    console.log(
      `[omx] Update installed, but the setup refresh failed. Run \`omx setup\` with the new install. (${setupRefreshResult.stderr})`,
    );
    return { status: 'failed', currentVersion: current, latestVersion: latest };
  }

  const installedVersion = await dependencies.getInstalledVersionAfterUpdate(ownership ?? undefined);
  const installedRevision = channelConfig.channel === 'dev'
    ? ((await dependencies.getInstalledRevisionAfterUpdate(ownership ?? undefined)) ?? result.revision ?? null)
    : null;
  const devBaseVersion = channelConfig.channel === 'dev'
    ? (latest && installedVersion
        ? (isNewerVersion(latest, installedVersion) ? installedVersion : latest)
        : latest)
    : null;
  const stampVersion = channelConfig.channel === 'stable'
    ? (latest ?? installedVersion ?? current)
    : installedVersion;
  if (stampVersion) {
    await writeSuccessfulInstallStamp(stampVersion, {
      channel: channelConfig.channel,
      source: channelConfig.installSource,
      revision: channelConfig.channel === 'dev' ? installedRevision : null,
      devBaseVersion,
      packageManager: ownership?.manager,
    });
  } else if (channelConfig.channel === 'dev') {
    console.log(
      '[omx] Dev update completed, but the installed package version could not be determined for the setup stamp.',
    );
  }
  const versionSummary = channelConfig.channel === 'stable' && latest
    ? ` to v${latest}`
    : '';
  console.log(
    `[omx] Updated ${channelConfig.channel} channel${versionSummary}. Restart to use new code.`,
  );
  if (channelConfig.channel === 'dev') {
    console.log('[omx] Dev display version may differ from the package/plugin manifest version; start a new Codex session if /skills still shows stale OMX plugin skill metadata.');
  }
  return { status: 'updated', currentVersion: current, latestVersion: latest };
}

export async function runImmediateUpdate(
  cwd = process.cwd(),
  dependencies: Partial<UpdateDependencies> = {},
  options: { channel?: UpdateChannel } = {},
): Promise<UpdateExecutionResult> {
  const updateDependencies = { ...defaultUpdateDependencies, ...dependencies };
  return executeUpdate({
    cwd,
    dependencies: updateDependencies,
    prompt: false,
    immediate: true,
    channel: options.channel ?? 'stable',
    forceInstall: true,
  });
}

export async function maybeCheckAndPromptUpdate(
  cwd: string,
  dependencies: Partial<UpdateDependencies> = {},
): Promise<void> {
  const updateDependencies = { ...defaultUpdateDependencies, ...dependencies };
  const autoUpdateMode = resolveAutoUpdateMode();
  if (autoUpdateMode === 'disabled') return;
  if (autoUpdateMode === 'prompt' && (!process.stdin.isTTY || !process.stdout.isTTY)) return;

  const now = Date.now();
  const state = await readUpdateState(cwd);
  if (!shouldCheckForUpdates(now, state)) return;

  await executeUpdate({
    cwd,
    dependencies: updateDependencies,
    prompt: autoUpdateMode === 'prompt',
    immediate: false,
    nowMs: now,
  });
}
