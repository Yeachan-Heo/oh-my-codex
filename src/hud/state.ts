/**
 * OMX HUD - State file readers
 *
 * Reads .omx/state/ files to build HUD render context.
 */

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { omxStateDir } from '../utils/paths.js';
import { getReadScopedStatePaths } from '../mcp/state-paths.js';
import type {
  RalphStateForHud,
  UltraworkStateForHud,
  AutopilotStateForHud,
  TeamStateForHud,
  EnterpriseStateForHud,
  HudMetrics,
  HudNotifyState,
  HudConfig,
  HudRenderContext,
  SessionStateForHud,
} from './types.js';
import { DEFAULT_HUD_CONFIG } from './types.js';

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const content = await readFile(path, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function readScopedModeState<T>(cwd: string, mode: string): Promise<T | null> {
  const candidates = await getReadScopedStatePaths(mode, cwd);
  for (const candidate of candidates) {
    const state = await readJsonFile<T>(candidate);
    if (state) return state;
  }
  return null;
}

export async function readRalphState(cwd: string): Promise<RalphStateForHud | null> {
  const state = await readScopedModeState<RalphStateForHud>(cwd, 'ralph');
  return state?.active ? state : null;
}

export async function readUltraworkState(cwd: string): Promise<UltraworkStateForHud | null> {
  const state = await readScopedModeState<UltraworkStateForHud>(cwd, 'ultrawork');
  return state?.active ? state : null;
}

export async function readAutopilotState(cwd: string): Promise<AutopilotStateForHud | null> {
  const state = await readScopedModeState<AutopilotStateForHud>(cwd, 'autopilot');
  return state?.active ? state : null;
}

export async function readTeamState(cwd: string): Promise<TeamStateForHud | null> {
  const state = await readScopedModeState<TeamStateForHud>(cwd, 'team');
  return state?.active ? state : null;
}


async function readEnterpriseHealthCounts(cwd: string): Promise<{ healthy_worker_count: number; stale_worker_count: number; offline_worker_count: number }> {
  const enterpriseRoot = join(cwd, '.omx', 'state', 'enterprise', 'worker-heartbeat');
  const result = { healthy_worker_count: 0, stale_worker_count: 0, offline_worker_count: 0 };
  try {
    const { readdir } = await import('fs/promises');
    const files = await readdir(enterpriseRoot);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const heartbeat = await readJsonFile<{ alive?: boolean; lastHeartbeatAt?: string }>(join(enterpriseRoot, file));
      if (!heartbeat || heartbeat.alive !== true) {
        result.offline_worker_count += 1;
        continue;
      }
      const last = new Date(String(heartbeat.lastHeartbeatAt ?? '')).getTime();
      if (!Number.isFinite(last)) {
        result.offline_worker_count += 1;
        continue;
      }
      if (Date.now() - last > 60_000) result.stale_worker_count += 1;
      else result.healthy_worker_count += 1;
    }
  } catch {
    // ignore missing heartbeat state
  }
  return result;
}

export async function readEnterpriseState(cwd: string): Promise<EnterpriseStateForHud | null> {
  const state = await readScopedModeState<EnterpriseStateForHud>(cwd, 'enterprise');
  if (!state?.active) return null;
  return {
    ...state,
    ...(await readEnterpriseHealthCounts(cwd)),
  };
}

export async function readMetrics(cwd: string): Promise<HudMetrics | null> {
  return readJsonFile<HudMetrics>(join(cwd, '.omx', 'metrics.json'));
}

export async function readHudNotifyState(cwd: string): Promise<HudNotifyState | null> {
  return readJsonFile<HudNotifyState>(join(omxStateDir(cwd), 'hud-state.json'));
}

export async function readSessionState(cwd: string): Promise<SessionStateForHud | null> {
  const state = await readJsonFile<SessionStateForHud>(join(omxStateDir(cwd), 'session.json'));
  return state?.session_id ? state : null;
}

export async function readHudConfig(cwd: string): Promise<HudConfig> {
  const config = await readJsonFile<HudConfig>(join(cwd, '.omx', 'hud-config.json'));
  return config ?? DEFAULT_HUD_CONFIG;
}

export function readVersion(): string | null {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(__filename), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return `v${pkg.version}`;
  } catch {
    return null;
  }
}

export function readGitBranch(cwd: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const remote = execSync('git remote get-url origin', { cwd, encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    // Extract repo name from URL: https://github.com/user/repo.git -> repo
    const repoMatch = remote.match(/\/([^/]+?)(?:\.git)?$/);
    const repo = repoMatch ? repoMatch[1] : null;
    return repo ? `${repo}/${branch}` : branch;
  } catch {
    return null;
  }
}

/** Read all state files and build the full render context */
export async function readAllState(cwd: string): Promise<HudRenderContext> {
  const version = readVersion();
  const gitBranch = readGitBranch(cwd);

  const [ralph, ultrawork, autopilot, team, enterprise, metrics, hudNotify, session] =
    await Promise.all([
      readRalphState(cwd),
      readUltraworkState(cwd),
      readAutopilotState(cwd),
      readTeamState(cwd),
      readEnterpriseState(cwd),
      readMetrics(cwd),
      readHudNotifyState(cwd),
      readSessionState(cwd),
    ]);

  return { version, gitBranch, ralph, ultrawork, autopilot, team, enterprise, metrics, hudNotify, session };
}
