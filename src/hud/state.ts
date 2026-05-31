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
import { findGitLayout, readGitLayoutFile } from '../utils/git-layout.js';
import { getDefaultBridge, isBridgeEnabled } from '../runtime/bridge.js';
import type { RuntimeSnapshot } from '../runtime/bridge.js';
import { getBaseStateDir, getStateFilePath, readCurrentSessionId, resolveRuntimeStateScope } from '../mcp/state-paths.js';
import { teamReadPhase as readTeamPhase } from '../team/team-ops.js';

import { listActiveSkills, readVisibleSkillActiveStateForStateDir } from '../state/skill-active.js';
import type {
  RalphStateForHud,
  UltragoalStateForHud,
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

async function readAuthoritativeModeState<T>(cwd: string, mode: string): Promise<T | null> {
  const sessionId = await readCurrentSessionId(cwd);
  return readJsonFile<T>(getStateFilePath(`${mode}-state.json`, cwd, sessionId));
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
    statusLine: {
      preset: DEFAULT_HUD_CONFIG.statusLine.preset,
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

  if (raw.statusLine && typeof raw.statusLine === 'object') {
    if (isValidPreset(raw.statusLine.preset)) {
      normalized.statusLine.preset = raw.statusLine.preset;
    }
  }

  return normalized;
}

interface RawUltragoalGoal {
  id?: unknown;
  title?: unknown;
  objective?: unknown;
  status?: unknown;
}

interface RawUltragoalPlan {
  activeGoalId?: unknown;
  aggregateCompletion?: unknown;
  goals?: unknown;
}

const ULTRAGOAL_ACTIVE_STATUSES = new Set(['in_progress', 'review_blocked', 'needs_user_decision']);
const ULTRAGOAL_UNRESOLVED_STATUSES = new Set(['pending', 'in_progress', 'failed', 'review_blocked', 'needs_user_decision']);

type NormalizedUltragoalGoal = {
  id: string;
  title: string;
  objective: string;
  status: string;
};

function normalizeUltragoalGoal(raw: unknown): NormalizedUltragoalGoal | null {
  if (!raw || typeof raw !== 'object') return null;
  const goal = raw as RawUltragoalGoal;
  const id = sanitizeOptionalString(goal.id);
  const title = sanitizeOptionalString(goal.title);
  const objective = sanitizeOptionalString(goal.objective);
  const status = sanitizeOptionalString(goal.status);
  if (!id || !title || !objective || !status) return null;
  return { id, title, objective, status };
}

function isAggregateComplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { status?: unknown }).status === 'complete';
}

export async function readUltragoalState(cwd: string): Promise<UltragoalStateForHud | null> {
  const plan = await readJsonFile<RawUltragoalPlan>(join(cwd, '.omx', 'ultragoal', 'goals.json'));
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.goals)) return null;

  const goals = plan.goals.map(normalizeUltragoalGoal).filter((goal): goal is NormalizedUltragoalGoal => goal !== null);
  if (goals.length === 0) return null;

  const completed_goals = goals.filter((goal) => goal.status === 'complete').length;
  const pending_goals = goals.filter((goal) => goal.status === 'pending').length;
  const in_progress_goals = goals.filter((goal) => goal.status === 'in_progress').length;
  const failed_goals = goals.filter((goal) => goal.status === 'failed').length;
  const review_blocked_goals = goals.filter((goal) => goal.status === 'review_blocked').length;
  const needs_user_decision_goals = goals.filter((goal) => goal.status === 'needs_user_decision').length;
  const unresolved_goals = goals.length - completed_goals;
  const activeGoalId = sanitizeOptionalString(plan.activeGoalId);
  const activeGoal = (
    (activeGoalId ? goals.find((goal) => goal.id === activeGoalId && goal.status !== 'complete') : undefined)
    ?? goals.find((goal) => ULTRAGOAL_ACTIVE_STATUSES.has(goal.status))
    ?? goals.find((goal) => ULTRAGOAL_UNRESOLVED_STATUSES.has(goal.status))
  );
  const activeIndex = activeGoal ? goals.findIndex((goal) => goal.id === activeGoal.id) : -1;
  const complete = isAggregateComplete(plan.aggregateCompletion) || unresolved_goals === 0;
  const toHudGoal = ({ goal, index }: { goal: NormalizedUltragoalGoal; index: number }) => ({
    id: goal.id,
    title: goal.title,
    objective: goal.objective,
    status: goal.status,
    index: index + 1,
  });
  const nextPendingGoals = goals
    .map((goal, index) => ({ goal, index }))
    .filter(({ goal, index }) => index > activeIndex && goal.status === 'pending' && goal.id !== activeGoal?.id)
    .slice(0, 3)
    .map(toHudGoal);
  const orderedOngoingGoals = [
    ...(activeGoal && activeIndex >= 0 ? [toHudGoal({ goal: activeGoal, index: activeIndex })] : []),
    ...nextPendingGoals,
  ];

  return {
    active: !complete,
    status: complete ? 'complete' : activeGoal?.status ?? 'active',
    total: goals.length,
    complete: completed_goals,
    pending: pending_goals,
    inProgress: in_progress_goals,
    failed: failed_goals,
    reviewBlocked: review_blocked_goals,
    needsUserDecision: needs_user_decision_goals,
    progressTotal: goals.length,
    activeGoal: activeGoal && activeIndex >= 0 ? {
      id: activeGoal.id,
      title: activeGoal.title,
      objective: activeGoal.objective,
      status: activeGoal.status,
      index: activeIndex + 1,
    } : undefined,
    ongoingGoals: orderedOngoingGoals,
    nextGoals: nextPendingGoals,
  };
}

export async function readRalphState(cwd: string): Promise<RalphStateForHud | null> {
  const state = await readAuthoritativeModeState<RalphStateForHud>(cwd, 'ralph');
  return state?.active ? state : null;
}

export async function readUltraworkState(cwd: string): Promise<UltraworkStateForHud | null> {
  const state = await readAuthoritativeModeState<UltraworkStateForHud>(cwd, 'ultrawork');
  return state?.active ? state : null;
}

export async function readAutopilotState(cwd: string): Promise<AutopilotStateForHud | null> {
  const state = await readAuthoritativeModeState<AutopilotStateForHud>(cwd, 'autopilot');
  return state?.active ? state : null;
}

export async function readRalplanState(cwd: string): Promise<RalplanStateForHud | null> {
  const state = await readAuthoritativeModeState<RalplanStateForHud>(cwd, 'ralplan');
  return state?.active ? state : null;
}

interface DeepInterviewRawState extends DeepInterviewStateForHud {
  input_lock?: {
    active?: boolean;
  };
}

export async function readDeepInterviewState(cwd: string): Promise<DeepInterviewStateForHud | null> {
  const state = await readAuthoritativeModeState<DeepInterviewRawState>(cwd, 'deep-interview');
  if (!state?.active) return null;

  return {
    ...state,
    input_lock_active: state.input_lock_active ?? state.input_lock?.active === true,
  };
}

export async function readAutoresearchState(cwd: string): Promise<AutoresearchStateForHud | null> {
  const state = await readAuthoritativeModeState<AutoresearchStateForHud>(cwd, 'autoresearch');
  return state?.active ? state : null;
}

export async function readUltraqaState(cwd: string): Promise<UltraqaStateForHud | null> {
  const state = await readAuthoritativeModeState<UltraqaStateForHud>(cwd, 'ultraqa');
  return state?.active ? state : null;
}

export async function readTeamState(cwd: string): Promise<TeamStateForHud | null> {
  const state = await readAuthoritativeModeState<TeamStateForHud>(cwd, 'team');
  return state?.active ? state : null;
}

export async function readMetrics(cwd: string): Promise<HudMetrics | null> {
  return readJsonFile<HudMetrics>(join(cwd, '.omx', 'metrics.json'));
}

export async function readHudNotifyState(cwd: string): Promise<HudNotifyState | null> {
  const sessionId = await readCurrentSessionId(cwd);
  const hudStatePath = getStateFilePath('hud-state.json', cwd, sessionId);
  return readJsonFile<HudNotifyState>(hudStatePath);
}

export async function readSessionState(cwd: string): Promise<SessionStateForHud | null> {
  const scope = await resolveRuntimeStateScope(cwd);
  const metadata = scope.metadata;
  return metadata?.sessionId ? {
    session_id: metadata.sessionId,
    started_at: typeof metadata.raw?.started_at === 'string' ? metadata.raw.started_at : '',
  } : null;
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

const TERMINAL_OR_INACTIVE_PHASES = new Set(['complete', 'completed', 'cancelled', 'canceled', 'failed', 'inactive', 'cleared']);

function isMissingTerminalOrInactiveDetail(detail: { active?: boolean; current_phase?: string } | null): boolean {
  if (!detail) return true;
  if (detail.active !== true) return true;
  const phase = sanitizeOptionalString(detail.current_phase)?.toLowerCase();
  return phase ? TERMINAL_OR_INACTIVE_PHASES.has(phase) : false;
}

function shouldSurfaceCanonicalSkill(
  canonicalSkills: Map<string, { phase?: string }>,
  skill: string,
  detail: { active?: boolean; current_phase?: string } | null,
): boolean {
  const canonicalPhase = canonicalPhaseForSkill(canonicalSkills, skill);
  if (canonicalSkills.has(skill) && !detail && canonicalPhase) return true;
  if (!canonicalSkills.has(skill)) return false;
  return !isMissingTerminalOrInactiveDetail(detail);
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
  const stateDir = getBaseStateDir(cwd);
  const canonicalSkillState = await readVisibleSkillActiveStateForStateDir(stateDir, currentSessionId);
  const canonicalSkills = new Map(
    listActiveSkills(canonicalSkillState).map((entry) => [entry.skill, entry] as const),
  );


  const [
    ralphDetail,
    ultragoal,
    ultraworkDetail,
    autopilotDetail,
    ralplanDetail,
    deepInterviewDetail,
    autoresearchDetail,
    ultraqaDetail,
    teamDetail,
  ] = await Promise.all([
    readAuthoritativeModeState<RalphStateForHud>(cwd, 'ralph'),
    readUltragoalState(cwd),
    readAuthoritativeModeState<UltraworkStateForHud>(cwd, 'ultrawork'),
    readAuthoritativeModeState<AutopilotStateForHud>(cwd, 'autopilot'),
    readAuthoritativeModeState<RalplanStateForHud>(cwd, 'ralplan'),
    readAuthoritativeModeState<DeepInterviewRawState>(cwd, 'deep-interview'),
    readAuthoritativeModeState<AutoresearchStateForHud>(cwd, 'autoresearch'),
    readAuthoritativeModeState<UltraqaStateForHud>(cwd, 'ultraqa'),
    readAuthoritativeModeState<TeamStateForHud>(cwd, 'team'),
  ]);

  const ralph = shouldSurfaceCanonicalSkill(canonicalSkills, 'ralph', ralphDetail)
    ? mergePhase(ralphDetail?.active === true ? ralphDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ralph'))
    : null;
  const ultrawork = shouldSurfaceCanonicalSkill(canonicalSkills, 'ultrawork', ultraworkDetail)
    ? mergePhase(ultraworkDetail?.active === true ? ultraworkDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultrawork'))
    : null;
  const autopilot = shouldSurfaceCanonicalSkill(canonicalSkills, 'autopilot', autopilotDetail)
    ? mergePhase(autopilotDetail?.active === true ? autopilotDetail : null, canonicalPhaseForSkill(canonicalSkills, 'autopilot'))
    : null;
  const ralplan = shouldSurfaceCanonicalSkill(canonicalSkills, 'ralplan', ralplanDetail)
    ? mergePhase(ralplanDetail?.active === true ? ralplanDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ralplan'))
    : null;
  const deepInterview = shouldSurfaceCanonicalSkill(canonicalSkills, 'deep-interview', deepInterviewDetail)
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
  const ultraqa = shouldSurfaceCanonicalSkill(canonicalSkills, 'ultraqa', ultraqaDetail)
    ? mergePhase(ultraqaDetail?.active === true ? ultraqaDetail : null, canonicalPhaseForSkill(canonicalSkills, 'ultraqa'))
    : null;
  const canonicalTeamPhase = await readCanonicalTeamPhase(cwd, teamDetail?.active === true ? teamDetail : null);
  const team = shouldSurfaceCanonicalSkill(canonicalSkills, 'team', teamDetail)
    ? mergeTeamPhase(
      teamDetail?.active === true ? teamDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'team'),
      canonicalTeamPhase,
    )
    : null;
  const autoresearch = shouldSurfaceCanonicalSkill(canonicalSkills, 'autoresearch', autoresearchDetail)
    ? mergePhase(
      autoresearchDetail?.active === true ? autoresearchDetail : null,
      canonicalPhaseForSkill(canonicalSkills, 'autoresearch'),
    )
    : null;

  // When the Rust runtime bridge is enabled, prefer Rust-authored snapshot
  // for authority/backlog/readiness display over JS-inferred state.
  let runtimeSnapshot: RuntimeSnapshot | null = null;
  if (isBridgeEnabled()) {
    const bridge = getDefaultBridge(stateDir);
    runtimeSnapshot = bridge.readCompatFile<RuntimeSnapshot>('snapshot.json');
  }

  return {
    version,
    gitBranch,
    ralph,
    ultragoal,
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
