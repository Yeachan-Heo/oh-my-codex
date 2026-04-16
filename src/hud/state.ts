/**
 * OMX HUD - State file readers
 *
 * Reads .omx/state/ files to build HUD render context.
 */

import { readFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { omxStateDir } from '../utils/paths.js';
import { findGitLayout, readGitLayoutFile } from '../utils/git-layout.js';
import { getDefaultBridge, isBridgeEnabled } from '../runtime/bridge.js';
import type { RuntimeSnapshot } from '../runtime/bridge.js';
import { getReadScopedStateFilePaths, getReadScopedStatePaths, readCurrentSessionId } from '../mcp/state-paths.js';
import { teamReadPhase as readTeamPhase } from '../team/team-ops.js';
import { readUsableSessionState } from '../hooks/session.js';
import { listActiveSkills, readVisibleSkillActiveState } from '../state/skill-active.js';
import type {
  RalphStateForHud,
  UltraworkStateForHud,
  AutopilotStateForHud,
  RalplanStateForHud,
  DeepInterviewStateForHud,
  AutoresearchStateForHud,
  UltraqaStateForHud,
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

async function readSessionAwareModeState<T>(cwd: string, mode: string): Promise<T | null> {
  const candidates = await getReadScopedStatePaths(mode, cwd);
  const sessionId = await readCurrentSessionId(cwd);

  if (sessionId) {
    if (candidates.length === 0) return null;
    return readJsonFile<T>(candidates[0]);
  }

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
  const state = await readSessionAwareModeState<RalphStateForHud>(cwd, 'ralph');
  return state?.active ? state : null;
}

export async function readUltraworkState(cwd: string): Promise<UltraworkStateForHud | null> {
  const state = await readSessionAwareModeState<UltraworkStateForHud>(cwd, 'ultrawork');
  return state?.active ? state : null;
}

export async function readAutopilotState(cwd: string): Promise<AutopilotStateForHud | null> {
  const state = await readSessionAwareModeState<AutopilotStateForHud>(cwd, 'autopilot');
  return state?.active ? state : null;
}

export async function readRalplanState(cwd: string): Promise<RalplanStateForHud | null> {
  const state = await readSessionAwareModeState<RalplanStateForHud>(cwd, 'ralplan');
  return state?.active ? state : null;
}

interface DeepInterviewRawState extends DeepInterviewStateForHud {
  input_lock?: {
    active?: boolean;
  };
}

export async function readDeepInterviewState(cwd: string): Promise<DeepInterviewStateForHud | null> {
  const state = await readSessionAwareModeState<DeepInterviewRawState>(cwd, 'deep-interview');
  if (!state?.active) return null;

  return {
    ...state,
    input_lock_active: state.input_lock_active ?? state.input_lock?.active === true,
  };
}

export async function readAutoresearchState(cwd: string): Promise<AutoresearchStateForHud | null> {
  const state = await readSessionAwareModeState<AutoresearchStateForHud>(cwd, 'autoresearch');
  return state?.active ? state : null;
}

export async function readUltraqaState(cwd: string): Promise<UltraqaStateForHud | null> {
  const state = await readSessionAwareModeState<UltraqaStateForHud>(cwd, 'ultraqa');
  return state?.active ? state : null;
}

export async function readTeamState(cwd: string): Promise<TeamStateForHud | null> {
  const state = await readSessionAwareModeState<TeamStateForHud>(cwd, 'team');
  return state?.active ? state : null;
}

export async function readMetrics(cwd: string): Promise<HudMetrics | null> {
  return readJsonFile<HudMetrics>(join(cwd, '.omx', 'metrics.json'));
}

export async function readHudNotifyState(cwd: string): Promise<HudNotifyState | null> {
  const [hudStatePath] = await getReadScopedStateFilePaths('hud-state.json', cwd, undefined, {
    rootFallback: false,
  });
  return readJsonFile<HudNotifyState>(hudStatePath);
}

export async function readSessionState(cwd: string): Promise<SessionStateForHud | null> {
  const state = await readUsableSessionState(cwd);
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

/**
 * On Windows, read common git queries directly from .git/ files to avoid
 * spawning console windows (conhost.exe flicker).  Falls back to execSync
 * for non-Windows platforms or unrecognised arguments.
 *
 * See: https://github.com/Yeachan-Heo/oh-my-codex/issues/1100
 */
function runGit(cwd: string, args: string[]): string | null {
  if (process.platform === 'win32') {
    try {
      const gitLayout = findGitLayout(cwd);
      if (gitLayout) {
        const cmd = args.join(' ');

        if (cmd === 'rev-parse --abbrev-ref HEAD') {
          const head = readGitLayoutFile(gitLayout.gitDir, 'HEAD');
          if (head?.startsWith('ref: refs/heads/'))
            return head.slice('ref: refs/heads/'.length);
          return head; // detached HEAD — raw SHA
        }

        if (cmd.startsWith('remote get-url ')) {
          const remoteName = args[2];
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const escaped = remoteName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const re = new RegExp(
              `\\[remote "${escaped}"\\][\\s\\S]*?url\\s*=\\s*(.+)`,
              'm',
            );
            const m = config.match(re);
            if (m) return m[1].trim();
          }
          return null;
        }

        if (cmd === 'remote') {
          const config = readGitLayoutFile(gitLayout.gitDir, 'config')
            ?? readGitLayoutFile(gitLayout.commonDir, 'config');
          if (config) {
            const matches = [...config.matchAll(/\[remote "([^"]+)"\]/g)];
            if (matches.length > 0) return matches.map((m) => m[1]).join('\n');
          }
          return null;
        }

        if (cmd === 'rev-parse --show-toplevel') {
          return gitLayout.worktreeRoot;
        }
      }
    } catch { /* fall through to execSync */ }
  }

  return runGitExec(cwd, args);
}

function runGitExec(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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

function canonicalPhaseForSkill(
  canonicalSkills: Map<string, { phase?: string }>,
  skill: string,
): string | undefined {
  return canonicalSkills.get(skill)?.phase;
}

function mergePhase<T extends { active?: boolean; current_phase?: string }>(
  detail: T | null,
  canonicalPhase?: string,
): T | null {
  if (detail?.active === true) {
    if (!canonicalPhase || detail.current_phase) return detail;
    return { ...detail, current_phase: canonicalPhase };
  }
  if (!canonicalPhase) return null;
  return { active: true, current_phase: canonicalPhase } as T;
}

async function readCanonicalTeamPhase(cwd: string, teamDetail: TeamStateForHud | null): Promise<string | undefined> {
  const teamName = sanitizeOptionalString(teamDetail?.team_name);
  if (!teamName) return undefined;
  const phaseState = await readTeamPhase(teamName, cwd).catch(() => null);
  return sanitizeOptionalString(phaseState?.current_phase);
}

function mergeTeamPhase(
  detail: TeamStateForHud | null,
  canonicalSkillPhase?: string,
  canonicalTeamPhase?: string,
): TeamStateForHud | null {
  const canonicalPhase = canonicalTeamPhase || canonicalSkillPhase;
  if (detail?.active === true) {
    return canonicalPhase ? { ...detail, current_phase: canonicalPhase } : detail;
  }
  if (!canonicalPhase) return null;
  return { active: true, current_phase: canonicalPhase };
}

/** Read all state files and build the full render context */
export async function readAllState(cwd: string, config: ResolvedHudConfig = DEFAULT_HUD_CONFIG): Promise<HudRenderContext> {
  const version = readVersion();
  const gitBranch = buildGitBranchLabel(cwd, config);
  const [metrics, hudNotify, session, currentSessionId] = await Promise.all([
    readMetrics(cwd),
    readHudNotifyState(cwd),
    readSessionState(cwd),
    readCurrentSessionId(cwd),
  ]);
  const canonicalSkillState = await readVisibleSkillActiveState(cwd, currentSessionId);
  const canonicalSkills = new Map(
    listActiveSkills(canonicalSkillState).map((entry) => [entry.skill, entry] as const),
  );
  const useCompatibilityFallback = canonicalSkillState == null;

  const [
    ralphDetail,
    ultraworkDetail,
    autopilotDetail,
    ralplanDetail,
    deepInterviewDetail,
    autoresearchDetail,
    ultraqaDetail,
    teamDetail,
  ] = await Promise.all([
    readSessionAwareModeState<RalphStateForHud>(cwd, 'ralph'),
    readSessionAwareModeState<UltraworkStateForHud>(cwd, 'ultrawork'),
    readSessionAwareModeState<AutopilotStateForHud>(cwd, 'autopilot'),
    readSessionAwareModeState<RalplanStateForHud>(cwd, 'ralplan'),
    readSessionAwareModeState<DeepInterviewRawState>(cwd, 'deep-interview'),
    readSessionAwareModeState<AutoresearchStateForHud>(cwd, 'autoresearch'),
    readSessionAwareModeState<UltraqaStateForHud>(cwd, 'ultraqa'),
    readSessionAwareModeState<TeamStateForHud>(cwd, 'team'),
  ]);

  const ralph = canonicalSkills.has('ralph') || useCompatibilityFallback
    ? (ralphDetail?.active === true ? mergePhase(ralphDetail, canonicalPhaseForSkill(canonicalSkills, 'ralph')) : null)
    : null;
  const ultrawork = canonicalSkills.has('ultrawork') || useCompatibilityFallback
    ? mergePhase(ultraworkDetail?.active === true ? ultraworkDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultrawork'))
    : null;
  const autopilot = canonicalSkills.has('autopilot') || useCompatibilityFallback
    ? mergePhase(autopilotDetail?.active === true ? autopilotDetail : null, canonicalPhaseForSkill(canonicalSkills, 'autopilot'))
    : null;
  const ralplan = canonicalSkills.has('ralplan') || useCompatibilityFallback
    ? mergePhase(ralplanDetail?.active === true ? ralplanDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ralplan'))
    : null;
  const deepInterview = canonicalSkills.has('deep-interview') || useCompatibilityFallback
    ? (() => {
      const merged = mergePhase(
        deepInterviewDetail?.active === true ? {
          ...deepInterviewDetail,
          input_lock_active: deepInterviewDetail.input_lock_active ?? deepInterviewDetail.input_lock?.active === true,
        } : null,
        canonicalPhaseForSkill(canonicalSkills, 'deep-interview'),
      );
      return merged;
    })()
    : null;
  const ultraqa = canonicalSkills.has('ultraqa') || useCompatibilityFallback
    ? mergePhase(ultraqaDetail?.active === true ? ultraqaDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultraqa'))
    : null;
  const canonicalTeamPhase = await readCanonicalTeamPhase(cwd, teamDetail?.active === true ? teamDetail : null);
  const team = canonicalSkills.has('team') || useCompatibilityFallback
    ? mergeTeamPhase(
      teamDetail?.active === true ? teamDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'team'),
      canonicalTeamPhase,
    )
    : null;
  const autoresearch = canonicalSkills.has('autoresearch') || useCompatibilityFallback
    ? mergePhase(
      autoresearchDetail?.active === true ? autoresearchDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'autoresearch'),
    )
    : null;

  // When the Rust runtime bridge is enabled, prefer Rust-authored snapshot
  // for authority/backlog/readiness display over JS-inferred state.
  let runtimeSnapshot: RuntimeSnapshot | null = null;
  if (isBridgeEnabled()) {
    const stateDir = omxStateDir(cwd);
    const bridge = getDefaultBridge(stateDir);
    runtimeSnapshot = bridge.readCompatFile<RuntimeSnapshot>('snapshot.json');
  }

  return {
    version,
    gitBranch,
    ralph,
    ultrawork,
    autopilot,
    ralplan,
    deepInterview,
    autoresearch,
    ultraqa,
    team,
    metrics,
    hudNotify,
    session,
    runtimeSnapshot,
  };
}
