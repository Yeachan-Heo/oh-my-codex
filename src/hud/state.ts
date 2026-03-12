/**
 * OMX HUD - State file readers
 *
 * Reads .omx/state/ files to build HUD render context.
 */

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { omxStateDir } from '../utils/paths.js';
import { getReadScopedStatePaths } from '../mcp/state-paths.js';
import type {
  RalphStateForHud,
  UltraworkStateForHud,
  AutopilotStateForHud,
  TeamStateForHud,
  HudMetrics,
  HudNotifyState,
  HudConfig,
  HudRenderContext,
  SessionStateForHud,
  ResolvedHudConfig,
  HudGitDisplay,
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

function isValidPreset(value: unknown): value is ResolvedHudConfig['preset'] {
  return value === 'minimal' || value === 'focused' || value === 'full';
}

function isValidGitDisplay(value: unknown): value is HudGitDisplay {
  return value === 'branch' || value === 'repo-branch';
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeHudConfig(raw: HudConfig | null | undefined): ResolvedHudConfig {
  const normalized: ResolvedHudConfig = {
    preset: DEFAULT_HUD_CONFIG.preset,
    git: {
      ...DEFAULT_HUD_CONFIG.git,
    },
  };

  if (!raw || typeof raw !== 'object') return normalized;

  if (isValidPreset(raw.preset)) {
    normalized.preset = raw.preset;
  }

  if (raw.git && typeof raw.git === 'object') {
    if (isValidGitDisplay(raw.git.display)) {
      normalized.git.display = raw.git.display;
    }

    const remoteName = sanitizeOptionalString(raw.git.remoteName);
    if (remoteName) normalized.git.remoteName = remoteName;

    const repoLabel = sanitizeOptionalString(raw.git.repoLabel);
    if (repoLabel) normalized.git.repoLabel = repoLabel;
  }

  return normalized;
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

export async function readHudConfig(cwd: string): Promise<ResolvedHudConfig> {
  const config = await readJsonFile<HudConfig>(join(cwd, '.omx', 'hud-config.json'));
  return normalizeHudConfig(config);
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

export type GitRunner = (cwd: string, args: string[]) => string | null;

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function extractRepoName(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;
  const repoMatch = remoteUrl.match(/[:/]([^/]+?)(?:\.git)?$/);
  return repoMatch?.[1] ?? null;
}

function readGitBranchName(cwd: string, gitRunner: GitRunner): string | null {
  return gitRunner(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function readGitRemoteUrl(cwd: string, remoteName: string, gitRunner: GitRunner): string | null {
  return gitRunner(cwd, ['remote', 'get-url', remoteName]);
}

function readFirstRemoteName(cwd: string, gitRunner: GitRunner): string | null {
  const remotes = gitRunner(cwd, ['remote']);
  if (!remotes) return null;

  for (const remote of remotes.split(/\r?\n/)) {
    const trimmed = remote.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function readRepoBasename(cwd: string, gitRunner: GitRunner): string | null {
  const topLevel = gitRunner(cwd, ['rev-parse', '--show-toplevel']);
  return topLevel ? basename(topLevel) : null;
}

function resolveRepoLabel(cwd: string, config: ResolvedHudConfig, gitRunner: GitRunner): string | null {
  if (config.git.repoLabel) return config.git.repoLabel;

  if (config.git.remoteName) {
    const repoFromConfiguredRemote = extractRepoName(readGitRemoteUrl(cwd, config.git.remoteName, gitRunner));
    if (repoFromConfiguredRemote) return repoFromConfiguredRemote;
  }

  const repoFromOrigin = extractRepoName(readGitRemoteUrl(cwd, 'origin', gitRunner));
  if (repoFromOrigin) return repoFromOrigin;

  const firstRemoteName = readFirstRemoteName(cwd, gitRunner);
  if (firstRemoteName) {
    const repoFromFirstRemote = extractRepoName(readGitRemoteUrl(cwd, firstRemoteName, gitRunner));
    if (repoFromFirstRemote) return repoFromFirstRemote;
  }

  return readRepoBasename(cwd, gitRunner);
}

export function readGitBranch(cwd: string): string | null {
  return readGitBranchName(cwd, runGit);
}

export function buildGitBranchLabel(
  cwd: string,
  config: ResolvedHudConfig = DEFAULT_HUD_CONFIG,
  gitRunner: GitRunner = runGit,
): string | null {
  const branch = readGitBranchName(cwd, gitRunner);
  if (!branch) return null;

  if (config.git.display === 'branch') {
    return branch;
  }

  const repoLabel = resolveRepoLabel(cwd, config, gitRunner);
  return repoLabel ? `${repoLabel}/${branch}` : branch;
}

/** Read all state files and build the full render context */
export async function readAllState(cwd: string, config: ResolvedHudConfig = DEFAULT_HUD_CONFIG): Promise<HudRenderContext> {
  const version = readVersion();
  const gitBranch = buildGitBranchLabel(cwd, config);

  const [ralph, ultrawork, autopilot, team, metrics, hudNotify, session] =
    await Promise.all([
      readRalphState(cwd),
      readUltraworkState(cwd),
      readAutopilotState(cwd),
      readTeamState(cwd),
      readMetrics(cwd),
      readHudNotifyState(cwd),
      readSessionState(cwd),
    ]);

  return { version, gitBranch, ralph, ultrawork, autopilot, team, metrics, hudNotify, session };
}
