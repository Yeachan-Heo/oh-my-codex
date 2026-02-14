/**
 * Launch-time update checks for oh-my-codex.
 * Non-fatal and throttled; can be disabled via OMX_AUTO_UPDATE=0.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { getPackageRoot } from '../utils/package.js';
import { notify } from '../notifications/notifier.js';

interface UpdateState {
  last_checked_at: string;
  last_seen_latest?: string;
}

interface LatestPackageInfo {
  version?: string;
}

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

function runGlobalUpdate(): { ok: boolean; stderr: string } {
  const result = spawnSync('npm', ['install', '-g', `${PACKAGE_NAME}@latest`], {
    encoding: 'utf-8',
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 120000,
  });

  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `npm exited ${result.status}` };
  }
  return { ok: true, stderr: '' };
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

export function shouldPromptForUpdate(): boolean {
  return process.env.OMX_AUTO_UPDATE_PROMPT === '1';
}

export async function maybeCheckAndPromptUpdate(cwd: string): Promise<void> {
  if (process.env.OMX_AUTO_UPDATE === '0') return;

  const now = Date.now();
  const state = await readUpdateState(cwd);
  if (!shouldCheckForUpdates(now, state)) return;

  const [current, latest] = await Promise.all([
    getCurrentVersion(),
    fetchLatestVersion(),
  ]);

  await writeUpdateState(cwd, {
    last_checked_at: new Date(now).toISOString(),
    last_seen_latest: latest || state?.last_seen_latest,
  });

  if (!current || !latest || !isNewerVersion(current, latest)) return;

  console.log(`[omx] Update available: v${current} -> v${latest}.`);

  if (!shouldPromptForUpdate()) {
    await notify({
      title: 'OMX Update Available',
      message: `New version available: v${current} -> v${latest}. Set OMX_AUTO_UPDATE_PROMPT=1 to prompt for update.`,
      type: 'info',
      projectPath: cwd,
    });
    return;
  }

  const approved = await askYesNo('[omx] Update now? [Y/n] ');
  if (!approved) {
    await notify({
      title: 'OMX Update Available',
      message: `New version available: v${current} -> v${latest}.`,
      type: 'info',
      projectPath: cwd,
    });
    return;
  }

  console.log(`[omx] Running: npm install -g ${PACKAGE_NAME}@latest`);
  const result = runGlobalUpdate();

  if (result.ok) {
    console.log(`[omx] Auto-update complete: v${latest}`);
    await notify({
      title: 'OMX Updated',
      message: `Updated ${PACKAGE_NAME} from v${current} to v${latest}. Restart sessions to use new code.`,
      type: 'success',
      projectPath: cwd,
    });
  } else {
    console.log('[omx] Auto-update failed. Run manually: npm install -g oh-my-codex@latest');
    await notify({
      title: 'OMX Update Available',
      message: `v${current} -> v${latest}. Auto-update failed: ${result.stderr || 'unknown error'}`,
      type: 'warning',
      projectPath: cwd,
    });
  }
}
