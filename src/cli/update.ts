/**
 * Update orchestration for oh-my-codex.
 *
 * The launch-time checker is intentionally passive, non-fatal, and throttled.
 * The explicit `omx update` command uses the same executor but bypasses the
 * launch-time cadence so a user request always checks npm immediately.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { getPackageRoot } from '../utils/package.js';
import { omxUserInstallStampPath } from '../utils/paths.js';

export interface UpdateState {
  last_checked_at: string;
  last_seen_latest?: string;
}

export interface UserInstallStamp {
  installed_version: string;
  setup_completed_version?: string;
  updated_at: string;
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

type RunGlobalUpdateResult = { ok: boolean; stderr: string };
type RunSetupRefreshResult = { ok: boolean; stderr: string };
type RunDeferredUpdateResult = { ok: boolean; stderr: string; logPath?: string };
type SpawnSyncLike = typeof spawnSync;
type SpawnLike = typeof spawn;

const PACKAGE_NAME = 'oh-my-codex';
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h

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

function runGlobalUpdate(): RunGlobalUpdateResult {
  const result = spawnSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    windowsHide: true,
  });

  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `npm exited ${result.status}` };
  }
  return { ok: true, stderr: '' };
}

function formatUpdateLogPath(date = new Date()): string {
  return `update-${date.toISOString().replace(/[:.]/g, '-')}.log`;
}

export function runDeferredGlobalUpdate(
  cwd: string,
  spawnProcess: SpawnLike = spawn,
  platform: NodeJS.Platform = process.platform,
  parentPid = process.pid,
): RunDeferredUpdateResult {
  const logPath = join(cwd, '.omx', 'logs', formatUpdateLogPath());

  try {
    mkdirSync(dirname(logPath), { recursive: true });

    const env = {
      ...process.env,
      OMX_DEFERRED_UPDATE_LOG: logPath,
      OMX_DEFERRED_UPDATE_PARENT_PID: String(parentPid),
    };

    const command = platform === 'win32' ? 'powershell.exe' : 'sh';
    const args = platform === 'win32'
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          [
            '$ErrorActionPreference = "Continue"',
            '$log = $env:OMX_DEFERRED_UPDATE_LOG',
            '$parentPid = [int]$env:OMX_DEFERRED_UPDATE_PARENT_PID',
            'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }',
            'npm install -g oh-my-codex@latest *>> $log',
            'if ($LASTEXITCODE -eq 0) { omx setup *>> $log }',
          ].join('; '),
        ]
      : [
          '-c',
          [
            'while kill -0 "$OMX_DEFERRED_UPDATE_PARENT_PID" 2>/dev/null; do sleep 1; done',
            'npm install -g oh-my-codex@latest >> "$OMX_DEFERRED_UPDATE_LOG" 2>&1',
            'if [ "$?" -eq 0 ]; then omx setup >> "$OMX_DEFERRED_UPDATE_LOG" 2>&1; fi',
          ].join('; '),
        ];

    const child = spawnProcess(command, args, {
      cwd,
      detached: true,
      env,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', (error) => {
      try {
        appendFileSync(
          logPath,
          `[omx] Deferred update launcher failed: ${error.message}\n`,
          'utf-8',
        );
      } catch {
        // The startup path must remain non-fatal even when diagnostics cannot be persisted.
      }
    });
    child.unref();
    return { ok: true, stderr: '', logPath };
  } catch (error) {
    return {
      ok: false,
      stderr: error instanceof Error ? error.message : String(error),
      logPath,
    };
  }
}

function formatDeferredUpdateFailure(stderr: string, logPath?: string): string {
  return [
    '[omx] Failed to schedule the deferred update.',
    stderr.trim() ? `[omx] scheduler error: ${stderr.trim()}` : undefined,
    logPath ? `[omx] Intended log: ${logPath}` : undefined,
    '[omx] You can retry manually with: npm install -g oh-my-codex@latest && omx setup',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function summarizeUpdateFailure(stderr: string, logPath?: string): string {
  const details = stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ');
  return [
    '[omx] Update failed while running npm install -g oh-my-codex@latest.',
    details ? `[omx] npm stderr: ${details}` : undefined,
    logPath ? `[omx] Full log: ${logPath}` : undefined,
    '[omx] You can retry manually with: npm install -g oh-my-codex@latest && omx setup',
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
  readUserInstallStamp: typeof readUserInstallStamp;
  runGlobalUpdate: typeof runGlobalUpdate;
  runDeferredGlobalUpdate: typeof runDeferredGlobalUpdate;
  runSetupRefresh: (cwd: string) => Promise<RunSetupRefreshResult>;
  writeUpdateState: typeof writeUpdateState;
}

const defaultUpdateDependencies: UpdateDependencies = {
  askYesNo,
  fetchLatestVersion,
  getCurrentVersion,
  readUserInstallStamp,
  runGlobalUpdate,
  runDeferredGlobalUpdate,
  runSetupRefresh,
  writeUpdateState,
};

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, '');
}

async function writeSuccessfulInstallStamp(
  installedVersion: string,
): Promise<void> {
  await writeUserInstallStamp({
    installed_version: stripLeadingV(installedVersion),
    setup_completed_version: stripLeadingV(installedVersion),
    updated_at: new Date().toISOString(),
  });
}

export async function readUserInstallStamp(
  path = omxUserInstallStampPath(),
): Promise<UserInstallStamp | null> {
  if (!existsSync(path)) return null;
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content) as Partial<UserInstallStamp>;
    if (typeof parsed.installed_version !== 'string' || typeof parsed.updated_at !== 'string') {
      return null;
    }
    return {
      installed_version: parsed.installed_version,
      ...(typeof parsed.setup_completed_version === 'string'
        ? { setup_completed_version: parsed.setup_completed_version }
        : {}),
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
}

export async function writeUserInstallStamp(
  stamp: UserInstallStamp,
  path = omxUserInstallStampPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(stamp, null, 2));
}

export function isInstallVersionBump(
  currentVersion: string | null | undefined,
  stamp: UserInstallStamp | null,
): boolean {
  if (!currentVersion) return false;
  if (!stamp?.installed_version) return true;
  return stripLeadingV(currentVersion) !== stripLeadingV(stamp.installed_version);
}

function doesSetupStampMatchVersion(
  currentVersion: string,
  stamp: UserInstallStamp | null,
): boolean {
  return stripLeadingV(stamp?.setup_completed_version ?? '') === stripLeadingV(currentVersion);
}

function resolveGlobalInstallRoot(): string | null {
  const result = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const root = (result.stdout || '').trim();
  return root === '' ? null : root;
}

export async function resolveInstalledCliEntry(globalInstallRoot: string): Promise<string | null> {
  const packageRoot = join(globalInstallRoot, PACKAGE_NAME);
  const packageJsonPath = join(packageRoot, 'package.json');
  let cliRelativePath = join('dist', 'cli', 'omx.js');

  try {
    const content = await readFile(packageJsonPath, 'utf-8');
    const pkg = JSON.parse(content) as PackageManifest;
    if (typeof pkg.bin === 'string' && pkg.bin.trim() !== '') {
      cliRelativePath = pkg.bin;
    } else if (
      pkg.bin &&
      typeof pkg.bin === 'object' &&
      typeof pkg.bin.omx === 'string' &&
      pkg.bin.omx.trim() !== ''
    ) {
      cliRelativePath = pkg.bin.omx;
    }
  } catch {
    // Fall back to the published contract used in package.json today.
  }

  const cliEntry = join(packageRoot, cliRelativePath);
  return existsSync(cliEntry) ? cliEntry : null;
}

export function spawnInstalledSetupRefresh(
  cliEntry: string,
  cwd: string,
  spawnProcess: SpawnSyncLike = spawnSync,
): RunSetupRefreshResult {
  const result = spawnProcess(process.execPath, [cliEntry, 'setup'], {
    cwd,
    env: process.env,
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

async function runSetupRefresh(cwd: string): Promise<RunSetupRefreshResult> {
  const globalInstallRoot = resolveGlobalInstallRoot();
  if (!globalInstallRoot) {
    return {
      ok: false,
      stderr: 'Unable to resolve the npm global install root after updating.',
    };
  }

  const cliEntry = await resolveInstalledCliEntry(globalInstallRoot);
  if (!cliEntry) {
    return {
      ok: false,
      stderr: `Unable to find the updated OMX CLI entry under ${join(globalInstallRoot, PACKAGE_NAME)}.`,
    };
  }

  return spawnInstalledSetupRefresh(cliEntry, cwd);
}

async function executeUpdate(
  options: {
    cwd: string;
    dependencies: UpdateDependencies;
    prompt: boolean;
    immediate: boolean;
    nowMs?: number;
  },
): Promise<UpdateExecutionResult> {
  const { cwd, dependencies, prompt, immediate, nowMs = Date.now() } = options;
  const [current, latest] = await Promise.all([
    dependencies.getCurrentVersion(),
    dependencies.fetchLatestVersion(),
  ]);

  try {
    await dependencies.writeUpdateState(cwd, {
      last_checked_at: new Date(nowMs).toISOString(),
      last_seen_latest: latest ?? undefined,
    });
  } catch {
    // Update-check state is advisory only. Do not fail installs or explicit updates
    // just because the current working directory is read-only or unavailable.
  }

  if (!current || !latest) {
    if (immediate) {
      console.log('[omx] Unable to determine the latest oh-my-codex version. Try again later.');
    }
    return { status: 'unavailable', currentVersion: current, latestVersion: latest };
  }

  if (!isNewerVersion(current, latest)) {
    if (immediate) {
      const installStamp = await dependencies.readUserInstallStamp();
      if (!doesSetupStampMatchVersion(current, installStamp)) {
        console.log(
          `[omx] oh-my-codex is already up to date (v${current}). Running setup refresh...`,
        );
        const setupRefreshResult = await dependencies.runSetupRefresh(cwd);
        if (!setupRefreshResult.ok) {
          console.log(
            `[omx] Update installed, but the setup refresh failed. Run \`omx setup\` with the new install. (${setupRefreshResult.stderr})`,
          );
          return { status: 'failed', currentVersion: current, latestVersion: latest };
        }
        await writeSuccessfulInstallStamp(current);
        console.log(`[omx] Setup refresh completed for v${current}. Restart to use current code.`);
        return { status: 'up-to-date', currentVersion: current, latestVersion: latest };
      }
    }

    if (immediate) {
      console.log(`[omx] oh-my-codex is already up to date (v${current}).`);
    }
    return { status: 'up-to-date', currentVersion: current, latestVersion: latest };
  }

  if (prompt) {
    const approved = await dependencies.askYesNo(
      immediate
        ? `[omx] Update available: v${current} → v${latest}. Update now? [Y/n] `
        : `[omx] Update available: v${current} → v${latest}. Update after this session exits? [Y/n] `,
    );
    if (!approved) {
      return { status: 'declined', currentVersion: current, latestVersion: latest };
    }
  }

  if (!immediate) {
    const deferredResult = dependencies.runDeferredGlobalUpdate(cwd);
    if (!deferredResult.ok) {
      console.log(formatDeferredUpdateFailure(deferredResult.stderr, deferredResult.logPath));
      return { status: 'failed', currentVersion: current, latestVersion: latest };
    }
    console.log('[omx] Update scheduled after this session exits.');
    if (deferredResult.logPath) {
      console.log(`[omx] Log: ${deferredResult.logPath}`);
    }
    return { status: 'scheduled', currentVersion: current, latestVersion: latest };
  }

  console.log(`[omx] Running: npm install -g ${PACKAGE_NAME}@latest`);
  const result = dependencies.runGlobalUpdate();

  if (!result.ok) {
    console.log(summarizeUpdateFailure(result.stderr));
    return { status: 'failed', currentVersion: current, latestVersion: latest };
  }

  const setupRefreshResult = await dependencies.runSetupRefresh(cwd);
  if (!setupRefreshResult.ok) {
    console.log(
      `[omx] Update installed, but the setup refresh failed. Run \`omx setup\` with the new install. (${setupRefreshResult.stderr})`,
    );
    return { status: 'failed', currentVersion: current, latestVersion: latest };
  }

  await writeSuccessfulInstallStamp(latest);
  console.log(`[omx] Updated to v${latest}. Restart to use new code.`);
  return { status: 'updated', currentVersion: current, latestVersion: latest };
}

export async function runImmediateUpdate(
  cwd = process.cwd(),
  dependencies: Partial<UpdateDependencies> = {},
): Promise<UpdateExecutionResult> {
  const updateDependencies = { ...defaultUpdateDependencies, ...dependencies };
  return executeUpdate({
    cwd,
    dependencies: updateDependencies,
    prompt: false,
    immediate: true,
  });
}

export async function maybeCheckAndPromptUpdate(
  cwd: string,
  dependencies: Partial<UpdateDependencies> = {},
): Promise<void> {
  const updateDependencies = { ...defaultUpdateDependencies, ...dependencies };
  if (process.env.OMX_AUTO_UPDATE === '0') return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const now = Date.now();
  const state = await readUpdateState(cwd);
  if (!shouldCheckForUpdates(now, state)) return;

  await executeUpdate({
    cwd,
    dependencies: updateDependencies,
    prompt: true,
    immediate: false,
    nowMs: now,
  });
}
