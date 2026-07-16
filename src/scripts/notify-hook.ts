#!/usr/bin/env node

/**
 * oh-my-codex Notification Hook
 * Codex CLI fires this after each agent turn via the `notify` config.
 * Receives JSON payload as the last argv argument.
 *
 * Responsibilities are split into sub-modules under scripts/notify-hook/:
 *   utils.js           – pure helpers (asNumber, safeString, …)
 *   payload-parser.js  – payload field extraction
 *   state-io.js        – state file I/O and normalization
 *   process-runner.js  – child-process helper
 *   log.js             – structured event logging
 *   auto-nudge.js      – stall-pattern detection and auto-nudge
 *   tmux-injection.js  – tmux prompt injection
 *   team-dispatch.js   – durable team dispatch queue consumer
 *   team-leader-nudge.js – leader mailbox nudge
 *   team-worker.js     – worker heartbeat and idle notification
 */

import { writeFile, appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  appendPromptSessionProvenanceRejection,
  isSessionStateUsable,
  readSessionPointer,
  normalizeSessionId,
  resolveSessionPointerContext,
  type SessionPointerContext,
} from '../hooks/session.js';
import {
  evaluateResolvedPromptTurn,
  extractSelectedTargetOwnerEvidence,
  preflightSelectedTargetOwner,
  type ResolvedPromptTurnContext,
} from '../hooks/prompt-session-provenance.js';
import { readTeamModeConfig } from '../config/team-mode.js';

import { safeString, asNumber } from './notify-hook/utils.js';
import {
  getSessionTokenUsage,
  getQuotaUsage,
  normalizeInputMessages,
} from './notify-hook/payload-parser.js';
import { getBaseStateDir } from '../mcp/state-paths.js';
import {
  getScopedStatePath,
  getScopedStatePathAtScope,
  readScopedJsonAtScope,
  hasExistingScopedSessionDir,
  readCurrentSessionId,
  readScopedJsonIfExists,
  getScopedStateDirsForCurrentSession,
  normalizeNotifyState,
  pruneRecentTurns,
  readdir,
  type NotifyStateScope,
} from './notify-hook/state-io.js';
import { isLeaderStale, resolveLeaderStalenessThresholdMs, maybeNudgeTeamLeader } from './notify-hook/team-leader-nudge.js';
import { drainPendingTeamDispatch } from './notify-hook/team-dispatch.js';
import { handleTmuxInjection } from './notify-hook/tmux-injection.js';
import {
  maybeAutoNudge,
  resolveNudgePaneTarget,
  isDeepInterviewStateActive,
  isDeepInterviewInputLockActive,
  syncSkillStateFromTurn,
} from './notify-hook/auto-nudge.js';
import { isManagedOmxSessionAtPromptContext } from './notify-hook/managed-tmux.js';
import { logNotifyHookEvent } from './notify-hook/log.js';
import { reconcileRalphSessionResume } from './notify-hook/ralph-session-resume.js';
import { sendPaneInput } from './notify-hook/team-tmux-guard.js';
import {
  buildOperationalContext,
  deriveAssistantSignalEvents,
  readRepositoryMetadata,
  resolveOperationalSessionName,
} from './notify-hook/operational-events.js';
import {
  parseTeamWorkerEnv,
  resolveTeamStateDirForWorker,
  updateWorkerHeartbeat,
  maybeNotifyLeaderAllWorkersIdle,
  maybeNotifyLeaderWorkerIdle,
} from './notify-hook/team-worker.js';
import { DEFAULT_MARKER } from './tmux-hook-engine.js';
import { sameFilePath } from '../utils/paths.js';
import {
  MAX_NOTIFY_ARGV_JSON_BYTES,
  extractRawJsonStringField,
  utf8ByteLength,
} from './hook-payload-guard.js';
import {
  classifyKeywordInput,
  recordSkillActivation,
  type KeywordInputClassification,
  type RecordSkillActivationInput,
  type SkillActiveState,
} from '../hooks/keyword-detector.js';

const RALPH_ACTIVE_PROGRESS_PHASES = new Set([
  'start',
  'started',
  'starting',
  'execute',
  'execution',
  'executing',
  'verify',
  'verification',
  'verifying',
  'fix',
  'fixing',
]);

const IDLE_NOTIFICATION_SUMMARY_MAX_LENGTH = 240;
const NOTIFY_SKILL_ACTIVATION_ERROR_MAX_LENGTH = 512;
const NOTIFY_SKILL_ACTIVATION_CONTEXT_MAX_LENGTH = 200;

async function readJsonFileIfObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasOmxRuntimeStateMarker(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  return typeof value.active === 'boolean'
    || typeof value.team_name === 'string'
    || typeof value.current_phase === 'string'
    || typeof value.lifecycle_outcome === 'string'
    || typeof value.run_outcome === 'string';
}

async function hasManagedTeamStateTree(cwd: string): Promise<boolean> {
  const teamStateRoot = join(cwd, '.omx', 'state', 'team');
  if (!existsSync(teamStateRoot)) return false;
  let entries: string[] = [];
  try {
    entries = await readdir(teamStateRoot);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const teamDir = join(teamStateRoot, entry);
    if (existsSync(join(teamDir, 'manifest.v2.json')) || existsSync(join(teamDir, 'config.json'))) {
      return true;
    }
  }
  return false;
}

async function isOmxManagedCwd(cwd: string): Promise<boolean> {
  const trustedInternalCwd = safeString(process.env.OMX_NOTIFY_HOOK_TRUSTED_MANAGED_CWD || '').trim();
  if (trustedInternalCwd && sameFilePath(trustedInternalCwd, cwd)) return true;
  if (existsSync(join(cwd, '.omx', 'setup-scope.json'))) return true;
  if (existsSync(join(cwd, '.omx', 'managed'))) return true;
  const sessionStatePath = join(cwd, '.omx', 'state', 'session.json');
  if (existsSync(sessionStatePath)) {
    try {
      const sessionState = JSON.parse(await readFile(sessionStatePath, 'utf-8'));
      if (isSessionStateUsable(sessionState, cwd)) return true;
    } catch {
      // Continue checking other managed markers.
    }
  }
  const teamState = await readJsonFileIfObject(join(cwd, '.omx', 'state', 'team-state.json'));
  if (hasOmxRuntimeStateMarker(teamState)) return true;
  const hudState = await readJsonFileIfObject(join(cwd, '.omx', 'state', 'hud-state.json'));
  if (hudState && (typeof hudState.last_turn_at === 'string' || typeof hudState.turn_count === 'number')) return true;
  if (await hasManagedTeamStateTree(cwd)) return true;
  const teamWorkerEnv = safeString(process.env.OMX_TEAM_INTERNAL_WORKER || process.env.OMX_TEAM_WORKER || '').trim();
  if (teamWorkerEnv) {
    const [teamName = '', workerName = ''] = teamWorkerEnv.split('/');
    if (teamName && workerName) {
      const candidateStateRoots = [
        safeString(process.env.OMX_TEAM_STATE_ROOT || '').trim(),
        safeString(process.env.OMX_TEAM_LEADER_CWD || '').trim()
          ? join(resolve(cwd, safeString(process.env.OMX_TEAM_LEADER_CWD || '').trim()), '.omx', 'state')
          : '',
        join(cwd, '.omx', 'state'),
      ].filter((value, index, values) => value && values.indexOf(value) === index);
      for (const candidateStateRoot of candidateStateRoots) {
        const identityPath = join(candidateStateRoot, 'team', teamName, 'workers', workerName, 'identity.json');
        if (!existsSync(identityPath)) continue;
        try {
          const raw = await readFile(identityPath, 'utf-8');
          const identity = JSON.parse(raw);
          const worktreePath = safeString(identity?.worktree_path || '').trim();
          const stateRoot = safeString(identity?.team_state_root || '').trim();
          if (
            (!worktreePath || sameFilePath(worktreePath, cwd))
            && (!stateRoot || sameFilePath(stateRoot, candidateStateRoot))
          ) {
            return true;
          }
        } catch {
          return false;
        }
      }
      // A worker notify hook with an explicit runtime root hint is OMX-scoped
      // even when the hint fails validation. Let the main worker path log the
      // unresolved-root warning and fail closed without inventing local state.
      if (
        safeString(process.env.OMX_TEAM_STATE_ROOT || '').trim()
        || safeString(process.env.OMX_TEAM_LEADER_CWD || '').trim()
      ) {
        return true;
      }
    }
  }
  const hooksPath = join(cwd, '.codex', 'hooks.json');
  if (existsSync(hooksPath)) {
    try {
      const raw = await readFile(hooksPath, 'utf-8');
      return /(?:^|[\\/])codex-native-hook\.js(?:["'\s]|$)/.test(raw);
    } catch {
      return false;
    }
  }
  return false;
}

function summarizeIdleNotificationMessage(message: unknown): string {
  const source = safeString(message)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const preferred = source.at(-1) || '';
  const normalized = preferred.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > IDLE_NOTIFICATION_SUMMARY_MAX_LENGTH
    ? `${normalized.slice(0, IDLE_NOTIFICATION_SUMMARY_MAX_LENGTH - 1)}…`
    : normalized;
}

function classifyIdleNotificationPhase(message: unknown): 'idle' | 'progress' | 'finished' | 'failed' {
  const lower = safeString(message).toLowerCase();
  if (!lower) return 'idle';

  if (/(error|failed|exception|invalid|timed out|timeout)/i.test(lower)) {
    return 'failed';
  }

  if ([
    'all tests pass',
    'build succeeded',
    'completed',
    'complete',
    'done',
    'final summary',
    'summary',
  ].some((pattern) => lower.includes(pattern))) {
    return 'finished';
  }

  if ([
    'verify',
    'verified',
    'verification',
    'review',
    'reviewed',
    'diagnostic',
    'typecheck',
    'test',
    'implement',
    'implemented',
    'apply patch',
    'change',
    'fix',
    'update',
    'refactor',
    'resume',
    'resumed',
    'progress',
    'continue',
    'continued',
  ].some((pattern) => lower.includes(pattern))) {
    return 'progress';
  }

  return 'idle';
}



function looksLikeAutopilotTerminalHandoff(text: string): boolean {
  return /\bAutopilot complete\b/i.test(text)
    || /\btask_complete\b/i.test(text)
    || /\bautopilot\b[\s\S]{0,120}\b(?:complete|completed|finished)\b/i.test(text);
}

function isTerminalModeStateObject(value: unknown, mode: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (safeString(state.mode).trim() !== mode) return false;
  if (state.active === true) return false;
  const phase = safeString(state.current_phase || state.currentPhase).trim().toLowerCase().replace(/_/g, '-');
  if (['complete', 'completed', 'failed', 'cancelled', 'canceled', 'stopped', 'user-stopped'].includes(phase)) return true;
  const outcome = safeString(state.run_outcome || state.outcome || state.lifecycle_outcome || state.terminal_outcome).trim().toLowerCase();
  return ['finish', 'finished', 'complete', 'completed', 'failed', 'cancelled', 'canceled'].includes(outcome)
    || safeString(state.completed_at || state.completedAt).trim() !== '';
}

function terminalStateMatchesNotifyTurn(state: Record<string, unknown>, payload: Record<string, unknown>): boolean {
  const payloadTurnId = safeString(payload['turn-id'] || payload.turn_id || '').trim();
  const stateTurnId = safeString(state.turn_id || state.turnId || '').trim();
  const payloadThreadId = safeString(payload['thread-id'] || payload.thread_id || '').trim();
  const stateThreadId = safeString(state.thread_id || state.threadId || '').trim();

  if (payloadTurnId || stateTurnId) {
    if (!payloadTurnId || !stateTurnId || payloadTurnId !== stateTurnId) return false;
    return !payloadThreadId || !stateThreadId || payloadThreadId === stateThreadId;
  }

  return Boolean(payloadThreadId && stateThreadId && payloadThreadId === stateThreadId);
}

async function hasTerminalAutopilotStateForNotifyTurn(
  stateDir: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const state = await readScopedJsonIfExists(
    stateDir,
    'autopilot-state.json',
    sessionId || undefined,
    null,
    { includeRootFallback: true },
  );
  return isTerminalModeStateObject(state, 'autopilot')
    && terminalStateMatchesNotifyTurn(state as Record<string, unknown>, payload);
}

async function shouldSuppressAutopilotTerminalReplayActivation(
  stateDir: string,
  payload: Record<string, unknown>,
  isAutopilotActivation: boolean,
  sessionId: string,
): Promise<boolean> {
  if (!isTurnCompletePayload(payload) && !isNotifyFallbackTaskCompletePayload(payload)) return false;
  if (!isAutopilotActivation) return false;

  const lastAssistantMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  if (!looksLikeAutopilotTerminalHandoff(lastAssistantMessage) && !isNotifyFallbackTaskCompletePayload(payload)) return false;

  return hasTerminalAutopilotStateForNotifyTurn(stateDir, sessionId, payload);
}

export interface NotifySkillActivationInput {
  readonly stateDir: string;
  readonly sourceCwd: string;
  readonly text: string;
  readonly sessionId?: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly payload: Record<string, unknown>;
  readonly nowIso?: string;
}

export interface NotifySkillActivationDependencies {
  readonly classifyKeywordInput?: (text: string) => KeywordInputClassification;
  readonly recordSkillActivation?: (input: RecordSkillActivationInput) => Promise<SkillActiveState | null>;
}

function boundedNotifySkillActivationContext(value: unknown): string | null {
  try {
    const context = safeString(value).trim().slice(0, NOTIFY_SKILL_ACTIVATION_CONTEXT_MAX_LENGTH);
    return context || null;
  } catch {
    return null;
  }
}

function boundedNotifySkillActivationError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    return message.slice(0, NOTIFY_SKILL_ACTIVATION_ERROR_MAX_LENGTH);
  } catch {
    return 'unknown_error';
  }
}

async function logNotifySkillActivationFailure(
  logsDir: string,
  input: NotifySkillActivationInput,
  error: unknown,
): Promise<void> {
  await logNotifyHookEvent(logsDir, {
    timestamp: new Date().toISOString(),
    level: 'warn',
    type: 'notify_skill_activation_failure',
    error: boundedNotifySkillActivationError(error),
    session_id: boundedNotifySkillActivationContext(input.sessionId),
    thread_id: boundedNotifySkillActivationContext(input.threadId),
    turn_id: boundedNotifySkillActivationContext(input.turnId),
  }).catch(() => {});
}

/**
 * Records prompt skill activation using one shared input classification for the
 * terminal-replay check and the state writer.
 */
export async function recordNotifySkillActivation(
  input: NotifySkillActivationInput,
  dependencies: NotifySkillActivationDependencies = {},
): Promise<SkillActiveState | null> {
  const classification = (dependencies.classifyKeywordInput ?? classifyKeywordInput)(input.text);
  const teamEnabled = readTeamModeConfig(input.sourceCwd).enabled;
  const runtimeMatches = teamEnabled
    ? classification.matches
    : classification.matches.filter((match) => match.skill !== 'team');
  const terminalAutopilotReplay = await shouldSuppressAutopilotTerminalReplayActivation(
    input.stateDir,
    input.payload,
    runtimeMatches.some((match) => match.skill === 'autopilot'),
    input.sessionId || '',
  );
  if (terminalAutopilotReplay && runtimeMatches[0]?.skill === 'autopilot') return null;

  return (dependencies.recordSkillActivation ?? recordSkillActivation)({
    stateDir: input.stateDir,
    sourceCwd: input.sourceCwd,
    text: input.text,
    sessionId: input.sessionId,
    threadId: input.threadId,
    turnId: input.turnId,
    nowIso: input.nowIso,
    classification,
    allowSecondaryAutopilot: !terminalAutopilotReplay,
  });
}

/**
 * Non-fatal notify-hook boundary for shared classification and state writes.
 */
export async function recordNotifySkillActivationNonFatal(
  input: NotifySkillActivationInput,
  logsDir: string,
  dependencies: NotifySkillActivationDependencies = {},
): Promise<SkillActiveState | null> {
  try {
    return await recordNotifySkillActivation(input, dependencies);
  } catch (error) {
    await logNotifySkillActivationFailure(logsDir, input, error);
    return null;
  }
}

function buildIdleNotificationFingerprint(payload: Record<string, unknown>): string {
  const lastAssistantMessage = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '');
  const summary = summarizeIdleNotificationMessage(lastAssistantMessage);
  const phase = classifyIdleNotificationPhase(lastAssistantMessage);
  return JSON.stringify({
    phase,
    ...(summary ? { summary } : {}),
  });
}

function isTurnCompletePayload(payload: Record<string, unknown>): boolean {
  const type = safeString(payload.type || '').trim().toLowerCase();
  return type === '' || type === 'agent-turn-complete' || type === 'turn-complete';
}

function isNotifyFallbackTaskCompletePayload(payload: Record<string, unknown>): boolean {
  const source = safeString(payload.source || '').trim();
  if (source !== 'notify-fallback-watcher') return false;
  return normalizeInputMessages(payload).some((message) => (
    message.includes('[notify-fallback] synthesized from rollout task_complete')
  ));
}

interface LeaderNotifyWriteDecision {
  readonly context: ResolvedPromptTurnContext;
  readonly pointerContext: SessionPointerContext;
  readonly scope?: NotifyStateScope;
}

async function preflightLeaderNotifyTarget(
  stateDir: string,
  context: ResolvedPromptTurnContext,
): Promise<ResolvedPromptTurnContext> {
  if (context.status !== 'authorized') return context;
  const scope: NotifyStateScope = {
    targetSessionId: context.authorization.targetSessionId,
    ownerCodexSessionId: context.authorization.ownerCodexSessionId,
    allowedStorageSessionIds: context.authorization.allowedStorageSessionIds,
  };
  const probePath = await getScopedStatePathAtScope(stateDir, 'prompt-provenance-probe.json', scope);
  const targetDir = dirname(probePath);
  const evidence: Array<{ ownerCodexSessionId?: unknown; targetSessionId?: unknown }> = [];
  let filenames: string[];
  try {
    filenames = await readdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context;
    return preflightSelectedTargetOwner(context, [{ ownerCodexSessionId: {} }], 'notify', new Date().toISOString());
  }
  for (const filename of filenames) {
    if (!filename.endsWith('-state.json') && filename !== 'skill-active-state.json') continue;
    try {
      const value = JSON.parse(await readFile(join(targetDir, filename), 'utf8')) as unknown;
      evidence.push(...extractSelectedTargetOwnerEvidence(value));
    } catch {
      evidence.push({ ownerCodexSessionId: {} });
    }
  }
  return preflightSelectedTargetOwner(context, evidence, 'notify', new Date().toISOString());
}

async function resolveLeaderNotifyWriteDecision(
  cwd: string,
  stateDir: string,
  payloadSessionId: unknown,
): Promise<LeaderNotifyWriteDecision> {
  const pointerContext = resolveSessionPointerContext(cwd);
  const selectedPointer = await readSessionPointer(pointerContext);
  const ownerEnvSessionId = process.env.OMX_SESSION_ID;
  const normalizedOwnerEnvSessionId = normalizeSessionId(ownerEnvSessionId);
  const forkScopeExists = normalizedOwnerEnvSessionId
    ? await hasExistingScopedSessionDir(stateDir, normalizedOwnerEnvSessionId)
    : false;
  const context = evaluateResolvedPromptTurn({
    producer: 'notify',
    payloadSessionId,
    ownerEnvSessionId,
    selectedPointer,
    forkScopeExists,
    nowIso: new Date().toISOString(),
  });
  const preflightedContext = await preflightLeaderNotifyTarget(stateDir, context);
  if (preflightedContext.status !== 'authorized') return { context: preflightedContext, pointerContext };
  if (context.status !== 'authorized') return { context, pointerContext };
  return {
    context: preflightedContext,
    pointerContext,
    scope: {
      targetSessionId: preflightedContext.authorization.targetSessionId,
      ownerCodexSessionId: preflightedContext.authorization.ownerCodexSessionId,
      allowedStorageSessionIds: preflightedContext.authorization.allowedStorageSessionIds,
    },
  };
}

async function main() {
  const rawPayload = process.argv[process.argv.length - 1];
  if (!rawPayload || rawPayload.startsWith('-')) {
    process.exit(0);
  }
  if (utf8ByteLength(rawPayload) > MAX_NOTIFY_ARGV_JSON_BYTES) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || payload['cwd'] || process.cwd();
  if (!(await isOmxManagedCwd(cwd))) {
    process.exit(0);
  }
  const rawPayloadSessionId = payload.session_id ?? payload['session-id'];
  const payloadSessionId = safeString(rawPayloadSessionId);
  const payloadThreadId = safeString(payload['thread-id'] || payload.thread_id || '');
  const inputMessages = normalizeInputMessages(payload);
  const latestUserInput = safeString(inputMessages.length > 0 ? inputMessages[inputMessages.length - 1] : '');
  const isTurnComplete = isTurnCompletePayload(payload);
  const isNotifyFallbackTaskComplete = isNotifyFallbackTaskCompletePayload(payload);

  // Team worker detection via environment variable
  const teamWorkerEnv = process.env.OMX_TEAM_INTERNAL_WORKER || process.env.OMX_TEAM_WORKER; // e.g., "fix-ts/worker-1"
  const parsedTeamWorker = parseTeamWorkerEnv(teamWorkerEnv);
  const isTeamWorker = !!parsedTeamWorker;

  const resolvedWorkerStateDir = (isTeamWorker && parsedTeamWorker)
    ? await resolveTeamStateDirForWorker(cwd, parsedTeamWorker)
    : null;
  const workerStateRootResolved = !isTeamWorker || !!resolvedWorkerStateDir;
  const stateDir = resolvedWorkerStateDir || getBaseStateDir(cwd);
  const logsDir = join(cwd, '.omx', 'logs');
  const omxDir = join(cwd, '.omx');
  const leaderWriteDecision = isTeamWorker
    ? null
    : await resolveLeaderNotifyWriteDecision(cwd, stateDir, rawPayloadSessionId);
  if (!isTeamWorker && leaderWriteDecision?.context.status === 'rejected') {
    await appendPromptSessionProvenanceRejection(
      leaderWriteDecision.pointerContext,
      leaderWriteDecision.context.diagnostic,
    ).catch(() => {});
    return;
  }
  if (!isTeamWorker && leaderWriteDecision?.context.status === 'suppressed-target-child') return;
  const leaderAuthorization = leaderWriteDecision?.context.status === 'authorized'
    ? leaderWriteDecision.context.authorization
    : null;
  const canWriteLeaderScopedState = Boolean(leaderWriteDecision?.scope && leaderAuthorization);
  let currentOmxSessionId = isTeamWorker
    ? ''
    : leaderWriteDecision?.scope?.targetSessionId || '';
  const getEffectiveSessionId = () => currentOmxSessionId || payloadSessionId;

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  if (isTeamWorker && workerStateRootResolved) {
    await mkdir(stateDir, { recursive: true }).catch(() => {});
    currentOmxSessionId = await readCurrentSessionId(stateDir).catch(() => '') || '';
  }

  // Turn-level dedupe prevents double-processing when native notify and fallback
  // watcher both emit the same completed turn.
  if (isTeamWorker || canWriteLeaderScopedState) {
    try {
      if (!workerStateRootResolved) throw new Error('worker_state_root_unresolved');
      const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
      if (turnId) {
        const now = Date.now();
        const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
        const eventType = safeString(payload.type || 'agent-turn-complete');
        const key = `${threadId || 'no-thread'}|${turnId}|${eventType}`;
        const dedupeSessionId = getEffectiveSessionId();
        const scope = leaderWriteDecision?.scope;
        const dedupeStatePath = scope
          ? await getScopedStatePathAtScope(stateDir, 'notify-hook-state.json', scope)
          : await getScopedStatePath(stateDir, 'notify-hook-state.json', dedupeSessionId);
        const dedupeState = normalizeNotifyState(
          scope
            ? await readScopedJsonAtScope(stateDir, 'notify-hook-state.json', scope, null)
            : await readScopedJsonIfExists(stateDir, 'notify-hook-state.json', dedupeSessionId, null),
        );
        dedupeState.recent_turns = pruneRecentTurns(dedupeState.recent_turns, now);
        if (dedupeState.recent_turns[key]) {
          process.exit(0);
        }
        dedupeState.recent_turns[key] = now;
        dedupeState.last_event_at = new Date().toISOString();
        await mkdir(dirname(dedupeStatePath), { recursive: true }).catch(() => {});
        await writeFile(dedupeStatePath, JSON.stringify(dedupeState, null, 2)).catch(() => {});
      }
    } catch {
      // Non-critical
    }
  }

  // 0.5. Track leader + native subagent thread activity (lead session only)
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
      if (getEffectiveSessionId() && threadId) {
        const { recordSubagentTurnForSession } = await import('../subagents/tracker.js');
        await recordSubagentTurnForSession(cwd, {
          sessionId: getEffectiveSessionId(),
          threadId,
          ...(turnId ? { turnId } : {}),
          timestamp: new Date().toISOString(),
          mode: safeString(payload.mode || ''),
          ...(isNotifyFallbackTaskComplete
            ? {
                completed: true,
                completionSource: 'notify-fallback-watcher',
              }
            : {}),
        });
      }
    } catch {
      // Non-critical: tracking must never block the hook
    }
  }

  // 1. Log the turn
  const normalizedInputMessages = normalizeInputMessages(payload);
  const latestInputPreview = safeString(
    normalizedInputMessages.length > 0
      ? normalizedInputMessages[normalizedInputMessages.length - 1]
      : '',
  ).slice(0, 200);
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: payload.type || 'agent-turn-complete',
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    input_preview: latestInputPreview,
    input_message_count: normalizedInputMessages.length,
    output_preview: (payload['last-assistant-message'] || payload.last_assistant_message || '')
      .slice(0, 200),
  };

  const logFile = join(logsDir, `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logFile, JSON.stringify(logEntry) + '\n').catch(() => {});

  if (!isTurnComplete) {
    return;
  }

  if (isTeamWorker && !workerStateRootResolved) {
    await logNotifyHookEvent(logsDir, {
      timestamp: new Date().toISOString(),
      level: 'warn',
      type: 'team_worker_state_root_unresolved',
      team_worker: teamWorkerEnv || null,
      reason: 'skip_team_worker_state_mutations',
    }).catch(() => {});

    // Keep the fail-closed worker state-root behavior for normal team-worker
    // mutations, but allow the narrow auto-nudge path to use an explicitly
    // supplied, already-existing worker state root. Auto-nudge only needs the
    // worker-scoped state files/pane anchor and should not fall back to creating
    // local `.omx/state` when identity resolution failed.
    const explicitWorkerStateRoot = safeString(process.env.OMX_TEAM_STATE_ROOT || '').trim();
    const autoNudgeStateDir = explicitWorkerStateRoot ? resolve(cwd, explicitWorkerStateRoot) : '';
    if (autoNudgeStateDir && existsSync(autoNudgeStateDir)) {
      try {
        await maybeAutoNudge({ cwd, stateDir: autoNudgeStateDir, logsDir, payload });
      } catch {
        // Non-critical
      }
    }
    return;
  }

  // Reconcile Ralph ownership for same-Codex-session continuation before
  // lifecycle counters or injection read the active scope.
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      const resumeResult = await reconcileRalphSessionResume({
        stateDir,
        authorization: leaderAuthorization!,
        env: {
          ...process.env,
          OMX_SESSION_ID: leaderAuthorization!.targetSessionId,
          CODEX_SESSION_ID: '',
          SESSION_ID: '',
        },
        payloadThreadId,
      });
      if (resumeResult.currentOmxSessionId && resumeResult.currentOmxSessionId === leaderAuthorization!.targetSessionId) {
        currentOmxSessionId = resumeResult.currentOmxSessionId;
      }
      if (resumeResult.resumed || resumeResult.updatedCurrentOwner) {
        await logNotifyHookEvent(logsDir, {
          timestamp: new Date().toISOString(),
          type: 'ralph_session_resume',
          reason: resumeResult.reason,
          current_omx_session_id: resumeResult.currentOmxSessionId || null,
          payload_codex_session_id: payloadSessionId || null,
          source_path: resumeResult.sourcePath || null,
          target_path: resumeResult.targetPath || null,
          owner_updated: resumeResult.updatedCurrentOwner,
          resumed: resumeResult.resumed,
        });
      }
    } catch (error) {
      await logNotifyHookEvent(logsDir, {
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'ralph_session_resume_failure',
        payload_codex_session_id: payloadSessionId || null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 2. Update active mode state (increment iteration)
  // GUARD: Skip when running inside a team worker to prevent state corruption
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir, getEffectiveSessionId());
      for (const scopedDir of scopedDirs) {
        const stateFiles = await readdir(scopedDir).catch(() => []);
        for (const f of stateFiles) {
          if (!f.endsWith('-state.json')) continue;
          const statePath = join(scopedDir, f);
          const state = JSON.parse(await readFile(statePath, 'utf-8'));
          if (state.active) {
            const nowIso = new Date().toISOString();
            const nextIteration = (state.iteration || 0) + 1;
            state.iteration = nextIteration;
            state.last_turn_at = nowIso;

            const maxIterations = asNumber(state.max_iterations);
            if (maxIterations !== null && maxIterations > 0 && nextIteration >= maxIterations) {
              const currentPhase = typeof state.current_phase === 'string'
                ? state.current_phase.trim().toLowerCase()
                : '';
              const isActiveRalphProgress = (
                (f === 'ralph-state.json' || state.mode === 'ralph')
                && RALPH_ACTIVE_PROGRESS_PHASES.has(currentPhase)
              );

              if (isActiveRalphProgress) {
                state.max_iterations = maxIterations + 10;
                state.max_iterations_auto_expand_count = (asNumber(state.max_iterations_auto_expand_count) || 0) + 1;
                state.max_iterations_auto_expanded_at = nowIso;
                delete state.completed_at;
                delete state.stop_reason;
              } else {
                state.active = false;
                if (typeof state.current_phase !== 'string' || !state.current_phase.trim()) {
                  state.current_phase = 'complete';
                } else if (!['cancelled', 'failed', 'complete'].includes(state.current_phase)) {
                  state.current_phase = 'complete';
                }
                if (typeof state.completed_at !== 'string' || !state.completed_at) {
                  state.completed_at = nowIso;
                }
                if (typeof state.stop_reason !== 'string' || !state.stop_reason) {
                  state.stop_reason = 'max_iterations_reached';
                }
              }
            }

            await writeFile(statePath, JSON.stringify(state, null, 2));
          }
        }
      }
    } catch {
      // Non-critical
    }
  }


  // 3. Track subagent metrics (lead session only)
  if (!isTeamWorker) {
    const metricsPath = join(omxDir, 'metrics.json');
    try {
      let metrics = {
        total_turns: 0,
        session_turns: 0,
        last_activity: '',
        session_input_tokens: 0,
        session_output_tokens: 0,
        session_total_tokens: 0,
      };
      if (existsSync(metricsPath)) {
        metrics = { ...metrics, ...JSON.parse(await readFile(metricsPath, 'utf-8')) };
      }

      const tokenUsage = getSessionTokenUsage(payload);
      const quotaUsage = getQuotaUsage(payload);

      metrics.total_turns++;
      metrics.session_turns++;
      metrics.last_activity = new Date().toISOString();

      if (tokenUsage) {
        if (tokenUsage.input !== null) {
          if (tokenUsage.inputCumulative) {
            metrics.session_input_tokens = tokenUsage.input;
          } else {
            metrics.session_input_tokens = (metrics.session_input_tokens || 0) + tokenUsage.input;
          }
        }
        if (tokenUsage.output !== null) {
          if (tokenUsage.outputCumulative) {
            metrics.session_output_tokens = tokenUsage.output;
          } else {
            metrics.session_output_tokens = (metrics.session_output_tokens || 0) + tokenUsage.output;
          }
        }
        if (tokenUsage.total !== null) {
          if (tokenUsage.totalCumulative) {
            metrics.session_total_tokens = tokenUsage.total;
          } else {
            metrics.session_total_tokens = (metrics.session_total_tokens || 0) + tokenUsage.total;
          }
        } else {
          metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
        }
      } else {
        metrics.session_total_tokens = (metrics.session_input_tokens || 0) + (metrics.session_output_tokens || 0);
      }

      if (quotaUsage) {
        if (quotaUsage.fiveHourLimitPct !== null) (metrics as any).five_hour_limit_pct = quotaUsage.fiveHourLimitPct;
        if (quotaUsage.weeklyLimitPct !== null) (metrics as any).weekly_limit_pct = quotaUsage.weeklyLimitPct;
      }

      await writeFile(metricsPath, JSON.stringify(metrics, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 3.5. Pre-compute leader staleness BEFORE updating HUD state (used by nudge in step 6)
  let preComputedLeaderStale = false;
  if (!isTeamWorker) {
    try {
      const stalenessMs = resolveLeaderStalenessThresholdMs();
      preComputedLeaderStale = await isLeaderStale(stateDir, stalenessMs, Date.now());
    } catch {
      // Non-critical
    }
  }

  // 4. Write HUD state summary for `omx hud` (lead session only)
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      const scope = leaderWriteDecision?.scope;
      if (!scope) return;
      const hudStatePath = await getScopedStatePathAtScope(stateDir, 'hud-state.json', scope);
      let hudState = await readScopedJsonAtScope(stateDir, 'hud-state.json', scope, {
        last_turn_at: '',
        turn_count: 0,
      });
      const nowIso = new Date().toISOString();
      hudState.last_turn_at = nowIso;
      (hudState as any).last_progress_at = nowIso;
      hudState.turn_count = (hudState.turn_count || 0) + 1;
      (hudState as any).last_agent_output = (payload['last-assistant-message'] || payload.last_assistant_message || '')
        .slice(0, 100);
      await mkdir(dirname(hudStatePath), { recursive: true }).catch(() => {});
      await writeFile(hudStatePath, JSON.stringify(hudState, null, 2));
    } catch {
      // Non-critical
    }
  }

  // 4.5. Update team worker heartbeat (if applicable)
  if (isTeamWorker) {
    try {
      if (parsedTeamWorker) {
        const { teamName: twTeamName, workerName: twWorkerName } = parsedTeamWorker;
        await updateWorkerHeartbeat(stateDir, twTeamName, twWorkerName);
      }
    } catch {
      // Non-critical: heartbeat write failure should never block the hook
    }
  }

  let skillSyncResult: Awaited<ReturnType<typeof syncSkillStateFromTurn>> | null = null;

  // 4.45. Skill activation tracking: update skill-active-state.json before any nudge logic.
  if (isTeamWorker || canWriteLeaderScopedState) {
    if (latestUserInput) {
      await recordNotifySkillActivationNonFatal({
        stateDir,
        sourceCwd: cwd,
        text: latestUserInput,
        sessionId: getEffectiveSessionId(),
        threadId: payloadThreadId,
        turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
        payload,
      }, logsDir, {
        recordSkillActivation: async (input) => recordSkillActivation({
          ...input,
          ...(!isTeamWorker && leaderWriteDecision ? {
            resolvedPromptTurnContext: leaderWriteDecision.context,
            onProvenanceRejected: async (diagnostic: import('../hooks/prompt-session-provenance.js').PromptDiagnosticDescriptor) => {
              await appendPromptSessionProvenanceRejection(leaderWriteDecision.pointerContext, diagnostic).catch(() => {});
            },
          } : {}),
        }),
      });
    }

    try {
      skillSyncResult = await syncSkillStateFromTurn(
        stateDir,
        payload,
        !isTeamWorker && leaderAuthorization ? leaderAuthorization.targetSessionId : '',
        !isTeamWorker ? leaderAuthorization : null,
      );
    } catch {
      // Non-fatal: lifecycle sync should not block the hook
    }
  }

  const effectiveSessionId = getEffectiveSessionId();
  const deepInterviewStateActive = effectiveSessionId
    ? await isDeepInterviewStateActive(stateDir, effectiveSessionId)
    : await isDeepInterviewStateActive(stateDir, undefined);
  const deepInterviewInputLockActive = await isDeepInterviewInputLockActive(stateDir, effectiveSessionId);

  // 4.55. Notify leader when individual worker transitions to idle (worker session only)
  if (isTeamWorker && parsedTeamWorker && !deepInterviewStateActive) {
    try {
      await maybeNotifyLeaderWorkerIdle({ cwd, stateDir, logsDir, parsedTeamWorker });
    } catch {
      // Non-critical
    }
  }

  // 4.6. Notify leader when all workers are idle (worker session only)
  if (isTeamWorker && parsedTeamWorker && !deepInterviewStateActive) {
    try {
      await maybeNotifyLeaderAllWorkersIdle({ cwd, stateDir, logsDir, parsedTeamWorker });
    } catch {
      // Non-critical
    }
  }

  // 5. Optional tmux prompt injection workaround (non-fatal, opt-in)
  // Skip for team workers - only the lead should inject prompts
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      await handleTmuxInjection({ payload, cwd, stateDir, logsDir, context: leaderWriteDecision!.context });
    } catch {
      // Non-critical
    }
  }

  // 5.5. Opportunistic team dispatch drain (leader session only).
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      await drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: 5 } as any);
    } catch {
      // Non-critical
    }
  }

  // 6. Team leader nudge (lead session only): remind the leader to check teammate/mailbox state.
  if (!isTeamWorker && canWriteLeaderScopedState && !deepInterviewStateActive) {
    try {
      await maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale });
    } catch {
      // Non-critical
    }
  }

  // 7. Dispatch native turn-complete hook event (best effort, post-dedupe)
  try {
    const { buildNativeHookEvent, buildDerivedHookEvent } = await import('../hooks/extensibility/events.js');
    const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
    const sessionIdForHooks = getEffectiveSessionId();
    const threadIdForHooks = safeString(payload['thread-id'] || payload.thread_id || '');
    const turnIdForHooks = safeString(payload['turn-id'] || payload.turn_id || '');
    const modeForHooks = safeString(payload.mode || '');
    const outputPreview = safeString(payload['last-assistant-message'] || payload.last_assistant_message || '').slice(0, 400);
    const event = buildNativeHookEvent('turn-complete', {
      source: safeString(payload.source || 'native'),
      type: safeString(payload.type || 'agent-turn-complete'),
      input_messages: normalizeInputMessages(payload),
      output_preview: outputPreview,
      native_session_id: payloadSessionId || null,
      omx_session_id: sessionIdForHooks || null,
      ...readRepositoryMetadata(cwd),
      session_name: resolveOperationalSessionName(cwd, sessionIdForHooks),
      project_path: cwd,
      project_name: safeString(payload.project_name || ''),
    }, {
      session_id: sessionIdForHooks,
      thread_id: threadIdForHooks,
      turn_id: turnIdForHooks,
      mode: modeForHooks,
    });
    await dispatchHookEvent(event, { cwd });

    for (const signal of deriveAssistantSignalEvents(outputPreview)) {
      const derivedEvent = buildDerivedHookEvent(signal.event, buildOperationalContext({
        cwd,
        normalizedEvent: signal.normalized_event,
        sessionId: sessionIdForHooks,
        text: outputPreview,
        status: signal.normalized_event,
        errorSummary: signal.error_summary,
        extra: {
          native_session_id: payloadSessionId || null,
          omx_session_id: sessionIdForHooks || null,
          source_event: safeString(payload.type || 'agent-turn-complete'),
        },
      }), {
        session_id: sessionIdForHooks,
        thread_id: threadIdForHooks,
        turn_id: turnIdForHooks,
        mode: modeForHooks,
        confidence: signal.confidence,
        parser_reason: signal.parser_reason,
      });
      await dispatchHookEvent(derivedEvent, { cwd });
    }
  } catch {
    // Non-fatal: extensibility modules may not be built yet
  }

  // 8. Dispatch session-idle lifecycle notification (lead session only, best effort)
  if (!isTeamWorker) {
    try {
      const { notifyLifecycle } = await import('../notifications/index.js');
      const {
        shouldSendIdleNotification,
        recordIdleNotificationSent,
        shouldSendSessionIdleHookEvent,
        recordSessionIdleHookEventSent,
      } = await import('../notifications/idle-cooldown.js');
      const idleFingerprint = buildIdleNotificationFingerprint(payload);
      const notifySessionId = getEffectiveSessionId();

      const shouldNotifyLifecycle = notifySessionId && (
        !canWriteLeaderScopedState
        || shouldSendIdleNotification(stateDir, notifySessionId, idleFingerprint)
      );
      const shouldDispatchSessionIdleHookEvent = canWriteLeaderScopedState
        && notifySessionId
        && shouldSendSessionIdleHookEvent(stateDir, notifySessionId, idleFingerprint);

      if (shouldNotifyLifecycle || shouldDispatchSessionIdleHookEvent) {
        if (shouldNotifyLifecycle) {
          const idleResult = await notifyLifecycle('session-idle', {
            sessionId: notifySessionId,
            projectPath: cwd,
          }, undefined, {
            persistScopedReceipts: canWriteLeaderScopedState,
          });
          if (canWriteLeaderScopedState && idleResult && idleResult.anySuccess) {
            recordIdleNotificationSent(stateDir, notifySessionId, idleFingerprint);
          }
        }

        if (shouldDispatchSessionIdleHookEvent) {
          try {
            const { buildNativeHookEvent } = await import('../hooks/extensibility/events.js');
            const { dispatchHookEvent } = await import('../hooks/extensibility/dispatcher.js');
            const event = buildNativeHookEvent('session-idle', {
              ...buildOperationalContext({
                cwd,
                normalizedEvent: 'blocked',
                sessionId: notifySessionId,
                status: 'blocked',
                extra: {
                  project_path: cwd,
                  reason: 'post_turn_idle_notification',
                },
              }),
            }, {
              session_id: notifySessionId,
              thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
              turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
              mode: safeString(payload.mode || ''),
            });
            const hookDispatchResult = await dispatchHookEvent(event, { cwd });
            if (hookDispatchResult.results.some((result) => result.ok)) {
              recordSessionIdleHookEventSent(stateDir, notifySessionId, idleFingerprint);
            }
          } catch {
            // Non-fatal
          }
        }
      }
    } catch {
      // Non-fatal: notification module may not be built or config may not exist
    }
  }

  // 9. Auto-nudge: detect Codex stall patterns and automatically send a continuation prompt.
  //    Works for both leader and worker contexts.
  if ((isTeamWorker || canWriteLeaderScopedState) && (!deepInterviewStateActive || deepInterviewInputLockActive)) {
    try {
      await maybeAutoNudge({
        cwd,
        stateDir,
        logsDir,
        payload,
        context: isTeamWorker ? null : leaderWriteDecision!.context,
        syncResult: skillSyncResult,
      });
    } catch {
      // Non-critical
    }
  }

  // 10.5. Visual verdict persistence (non-fatal, observable – issue #421)
  if (!isTeamWorker) {
    try {
      const { maybePersistVisualVerdict } = await import('./notify-hook/visual-verdict.js');
      await maybePersistVisualVerdict({
        cwd,
        payload,
        stateDir,
        logsDir,
        sessionId: getEffectiveSessionId(),
        turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
        persistRuntimeFeedback: canWriteLeaderScopedState,
      });
    } catch (err) {
      // Structured warning for module import failure (issue #421)
      const warnEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        type: 'visual_verdict_import_failure',
        error: (err as any)?.message || String(err),
        session_id: getEffectiveSessionId(),
        turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
      });
      const warnFile = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      await appendFile(warnFile, warnEntry + '\n').catch(() => {});
    }
  }

  // 10. Code simplifier: delegate recently modified files for simplification.
  //     Opt-in via ~/.omx/config.json: { "codeSimplifier": { "enabled": true } }
  if (!isTeamWorker && canWriteLeaderScopedState) {
    try {
      const { processCodeSimplifier } = await import('../hooks/code-simplifier/index.js');
      const csResult = processCodeSimplifier(cwd, stateDir);
      if (csResult.triggered) {
        const managedSession = await isManagedOmxSessionAtPromptContext(cwd, leaderWriteDecision!.context, { allowTeamWorker: false });
        if (!managedSession) {
          const { logTmuxHookEvent } = await import('./notify-hook/log.js');
          await logTmuxHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'code_simplifier_skipped',
            reason: 'unmanaged_session',
          });
        } else {
          const csPaneId = await resolveNudgePaneTarget(stateDir, cwd, payload, leaderWriteDecision!.context);
          if (csPaneId) {
            const csText = `${csResult.message} ${DEFAULT_MARKER}`;
            const sendResult = await sendPaneInput({
              paneTarget: csPaneId,
              exactPaneId: csPaneId,
              prompt: csText,
              submitKeyPresses: 2,
              submitDelayMs: 100,
            });
            if (!sendResult.ok) {
              throw new Error(sendResult.error || sendResult.reason || 'send_failed');
            }

            const { logTmuxHookEvent } = await import('./notify-hook/log.js');
            await logTmuxHookEvent(logsDir, {
              timestamp: new Date().toISOString(),
              type: 'code_simplifier_triggered',
              pane_id: csPaneId,
              file_count: csResult.message.split('\n').filter(l => l.trimStart().startsWith('- ')).length,
            });
          }
        }
      }
    } catch {
      // Non-critical: code-simplifier module may not be built yet
    }
  }
}

async function logFatalNotifyHookError(err: unknown): Promise<void> {
  let cwd = process.cwd();
  try {
    const rawPayload = process.argv[process.argv.length - 1];
    if (rawPayload && !rawPayload.startsWith('-')) {
      if (utf8ByteLength(rawPayload) <= MAX_NOTIFY_ARGV_JSON_BYTES) {
        const payload = JSON.parse(rawPayload) as Record<string, unknown>;
        cwd = safeString(payload.cwd || payload['cwd'] || cwd) || cwd;
      } else {
        cwd = extractRawJsonStringField(rawPayload, ['cwd']) || cwd;
      }
    }
  } catch {
    // Keep notification hook failures silent in Codex TUI surfaces.
  }

  const logsDir = join(cwd, '.omx', 'logs');
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  const logPath = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'notify_hook_fatal_error',
    error: err instanceof Error ? err.message : String(err),
  }) + '\n').catch(() => {});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // Notify hooks are auxiliary background work. Avoid printing stack traces into
    // Codex TUI/PowerShell foreground panes; record diagnostics in .omx/logs.
    process.exitCode = 0;
    void logFatalNotifyHookError(err);
  });
}
