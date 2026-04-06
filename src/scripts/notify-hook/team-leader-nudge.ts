// @ts-nocheck
/**
 * Team leader nudge: remind the leader to check teammate/mailbox state.
 */

import { readFile, writeFile, mkdir, appendFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { asNumber, safeString, isTerminalPhase } from './utils.js';
import { readJsonIfExists, getScopedStateDirsForCurrentSession } from './state-io.js';
import { runProcess } from './process-runner.js';
import { logTmuxHookEvent } from './log.js';
import { evaluatePaneInjectionReadiness, sendPaneInput } from './team-tmux-guard.js';
import { resolvePaneTarget } from './tmux-injection.js';
import {
  classifyLeaderActionState,
  resolveLeaderNudgeIntent,
} from './orchestration-intent.js';
import { DEFAULT_MARKER } from '../tmux-hook-engine.js';
import { isLeaderRuntimeStale } from '../../team/leader-activity.js';
import { appendTeamDeliveryLog } from '../../team/delivery-log.js';
import { writeTeamLeaderAttention } from '../../team/state.js';
const LEADER_PANE_MISSING_NO_INJECTION_REASON = 'leader_pane_missing_no_injection';
const LEADER_PANE_SHELL_NO_INJECTION_REASON = 'leader_pane_shell_no_injection';
const LEADER_NOTIFICATION_DEFERRED_TYPE = 'leader_notification_deferred';
const ACK_WITHOUT_START_EVIDENCE_REASON = 'ack_without_start_evidence';
const ACK_LIKE_PATTERNS = [
  /^ack(?::\s*[a-z0-9-]+(?:\s+initialized)?)?[.!]*$/i,
  /^(?:ok|okay|k|roger|copy|received|got it|understood|sounds good)[.!]*$/i,
  /^(?:on it|will do|i(?:'|')ll do it|working on it)[.!]*$/i,
];

export function resolveLeaderNudgeIntervalMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_NUDGE_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds for stale-leader follow-up. Guard against spam.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 30_000;
}

export function resolveLeaderAllIdleNudgeCooldownMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_ALL_IDLE_COOLDOWN_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds.
  if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

export function resolveLeaderStalenessThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_LEADER_STALE_MS || '');
  const parsed = asNumber(raw);
  // Default: 3 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 30 * 60_000) return parsed;
  return 180_000;
}

export function resolveFallbackProgressStallThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_PROGRESS_STALL_MS || '');
  const parsed = asNumber(raw);
  // Fallback-only threshold used when worker turn-count signals are unavailable.
  // Default: 2 minutes. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 60 * 60_000) return parsed;
  return 120_000;
}

export function resolveWorkerTurnStallThresholdMs() {
  const raw = safeString(process.env.OMX_TEAM_WORKER_TURN_STALL_MS || '');
  const parsed = asNumber(raw);
  // Default: 30 seconds. Guard against unreasonable values.
  if (parsed !== null && parsed >= 10_000 && parsed <= 10 * 60_000) return parsed;
  return 30_000;
}

function buildStatusCheckReminder(teamName) {
  return `Next: check messages; keep orchestrating; if done, gracefully shut down: omx team shutdown ${teamName}.`;
}

function buildMailboxCheckReminder(teamName) {
  return `Next: read messages; keep orchestrating; if done, gracefully shut down: omx team shutdown ${teamName}.`;
}

function buildWorkerStartEvidenceReminder(teamName, workerName) {
  return `Next: check ${workerName} msg/output, confirm task in omx team status ${teamName}, then reassign/nudge.`;
}

function classifyLeaderActionState({
  allWorkersIdle = false,
  workerPanesAlive = false,
  taskCounts = {},
  teamProgressStalled = false,
} = {}) {
  const pending = Number.isFinite(taskCounts.pending) ? taskCounts.pending : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? taskCounts.blocked : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? taskCounts.in_progress : 0;
  const tasksComplete = pending === 0 && blocked === 0 && inProgress === 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;
  const blockedWaitingOnLeader = allWorkersIdle && blocked > 0 && pending === 0 && inProgress === 0;
  const terminalWaitingOnLeader = allWorkersIdle && tasksComplete && workerPanesAlive;
  const stalledWaitingOnLeader = blockedWaitingOnLeader || teamProgressStalled;

  if (terminalWaitingOnLeader) return 'done_waiting_on_leader';
  if (stalledWaitingOnLeader) return 'stuck_waiting_on_leader';
  if (pendingFollowUpTasks) return 'still_actionable';
  return 'still_actionable';
}

function buildLeaderActionGuidance(teamName, {
  allWorkersIdle = false,
  workerPanesAlive = false,
  taskCounts = {},
  leaderActionState = 'still_actionable',
} = {}) {
  const pending = Number.isFinite(taskCounts.pending) ? taskCounts.pending : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? taskCounts.blocked : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? taskCounts.in_progress : 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;

  if (pendingFollowUpTasks) {
    return workerPanesAlive
      ? 'Next: assign the next follow-up task to this idle team.'
      : 'Next: launch a new team for the next task set.';
  }
  if (leaderActionState === 'done_waiting_on_leader') {
    return `Next: decide whether to reconcile/merge results or gracefully shut down: omx team shutdown ${teamName}.`;
  }
  if (leaderActionState === 'stuck_waiting_on_leader') {
    return `Next: omx team status ${teamName}; read worker messages; unblock/reassign or shutdown.`;
  }
  return buildStatusCheckReminder(teamName);
}

function buildIdleContextText(teamName, {
  allWorkersIdle = false,
  workerPanesAlive = false,
  taskCounts = {},
  leaderActionState = 'still_actionable',
} = {}) {
  const pending = Number.isFinite(taskCounts.pending) ? taskCounts.pending : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? taskCounts.blocked : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? taskCounts.in_progress : 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;

  if (pendingFollowUpTasks) {
    return workerPanesAlive
      ? ` Team ${teamName} has idle workers ready.`
      : ` Team ${teamName} has follow-up work ready.`;
  }
  if (leaderActionState === 'done_waiting_on_leader') {
    return ` Team ${teamName} looks complete.`;
  }
  if (leaderActionState === 'stuck_waiting_on_leader') {
    return ` Team ${teamName} needs leader review.`;
  }
  return '';
}

export async function checkWorkerPanesAlive(tmuxTarget, workerPaneIds = []) {
  const sessionName = tmuxTarget.split(':')[0];
  try {
    const result = await runProcess('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id} #{pane_pid}'], 2000);
    const lines = (result.stdout || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    const workerPaneIdSet = new Set(
      Array.isArray(workerPaneIds)
        ? workerPaneIds.map((paneId) => safeString(paneId).trim()).filter(Boolean)
        : [],
    );
    const relevantLines = workerPaneIdSet.size > 0
      ? lines.filter((line) => workerPaneIdSet.has(line.split(/\s+/, 1)[0] || ''))
      : lines;
    return { alive: relevantLines.length > 0, paneCount: relevantLines.length };
  } catch {
    return { alive: false, paneCount: 0 };
  }
}

export async function isLeaderStale(stateDir, thresholdMs, nowMs) {
  return isLeaderRuntimeStale(stateDir, thresholdMs, nowMs);
}

function resolveTerminalAtFromPhaseDoc(parsed, fallbackIso) {
  const transitions = Array.isArray(parsed && parsed.transitions) ? parsed.transitions : [];
  for (let idx = transitions.length - 1; idx >= 0; idx -= 1) {
    const at = safeString(transitions[idx] && transitions[idx].at).trim();
    if (at) return at;
  }
  const updatedAt = safeString(parsed && parsed.updated_at).trim();
  return updatedAt || fallbackIso;
}

async function readTeamPhaseSnapshot(stateDir, teamName, nowIso) {
  const phasePath = join(stateDir, 'team', teamName, 'phase.json');
  try {
    if (!existsSync(phasePath)) return { currentPhase: '', terminal: false, completedAt: '' };
    const parsed = JSON.parse(await readFile(phasePath, 'utf-8'));
    const currentPhase = safeString(parsed && parsed.current_phase).trim();
    return {
      currentPhase,
      terminal: isTerminalPhase(currentPhase),
      completedAt: resolveTerminalAtFromPhaseDoc(parsed, nowIso),
    };
  } catch {
    return { currentPhase: '', terminal: false, completedAt: '' };
  }
}

async function syncScopedTeamStateFromPhase(teamStatePath, teamName, phaseSnapshot, nowIso) {
  if (!phaseSnapshot || !phaseSnapshot.terminal) return false;
  try {
    if (!existsSync(teamStatePath)) return false;
    const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
    if (!parsed || safeString(parsed.team_name).trim() !== teamName) return false;

    let changed = false;
    if (parsed.active !== false) {
      parsed.active = false;
      changed = true;
    }
    if (safeString(parsed.current_phase).trim() !== phaseSnapshot.currentPhase) {
      parsed.current_phase = phaseSnapshot.currentPhase;
      changed = true;
    }
    if (safeString(parsed.completed_at).trim() !== phaseSnapshot.completedAt && phaseSnapshot.completedAt) {
      parsed.completed_at = phaseSnapshot.completedAt;
      changed = true;
    }
    if (safeString(parsed.last_turn_at).trim() !== nowIso) {
      parsed.last_turn_at = nowIso;
      changed = true;
    }

    if (changed) {
      await writeFile(teamStatePath, JSON.stringify(parsed, null, 2));
    }
    return changed;
  } catch {
    return false;
  }
}

async function resolveCurrentSessionId(stateDir) {
  const fromEnv = safeString(
    process.env.OMX_SESSION_ID
    || process.env.CODEX_SESSION_ID
    || process.env.SESSION_ID
    || '',
  ).trim();
  if (fromEnv) return fromEnv;

  const sessionPath = join(stateDir, 'session.json');
  try {
    if (!existsSync(sessionPath)) return '';
    const parsed = JSON.parse(await readFile(sessionPath, 'utf-8'));
    const sessionId = safeString(parsed && parsed.session_id ? parsed.session_id : '').trim();
    return sessionId;
  } catch {
    return '';
  }
}

async function readWorkerStatusSnapshot(stateDir, teamName, workerName) {
  if (!workerName) return { state: 'unknown', current_task_id: '' };
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'status.json');
  try {
    if (!existsSync(path)) return { state: 'unknown', current_task_id: '', missing: true };
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return {
      state: safeString(parsed && parsed.state ? parsed.state : 'unknown') || 'unknown',
      current_task_id: safeString(parsed && parsed.current_task_id ? parsed.current_task_id : '').trim(),
      missing: false,
    };
  } catch {
    return { state: 'unknown', current_task_id: '', missing: false };
  }
}

async function readWorkerStatusState(stateDir, teamName, workerName) {
  const snapshot = await readWorkerStatusSnapshot(stateDir, teamName, workerName);
  return snapshot.state;
}

async function readWorkerHeartbeatSnapshot(stateDir, teamName, workerName) {
  if (!workerName) return { turn_count: null, missing: true };
  const path = join(stateDir, 'team', teamName, 'workers', workerName, 'heartbeat.json');
  try {
    if (!existsSync(path)) return { turn_count: null, missing: true };
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return {
      turn_count: Number.isFinite(parsed?.turn_count) ? parsed.turn_count : null,
      missing: false,
    };
  } catch {
    return { turn_count: null, missing: false };
  }
}

async function readTeamTaskProgressSnapshot(stateDir, teamName) {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) {
    return {
      taskCounts: { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
      taskSignature: [],
      workRemaining: false,
    };
  }

  const taskCounts = { pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  const taskSignature = [];
  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        const id = safeString(parsed?.id || entry.replace(/^task-/, '').replace(/\.json$/, '')).trim();
        const status = safeString(parsed?.status || 'pending').trim() || 'pending';
        const owner = safeString(parsed?.owner || '').trim();
        if (Object.hasOwn(taskCounts, status)) taskCounts[status] += 1;
        taskSignature.push({ id, owner, status });
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    // ignore task-read failures
  }

  return {
    taskCounts,
    taskSignature,
    workRemaining: taskCounts.pending > 0 || taskCounts.blocked > 0 || taskCounts.in_progress > 0,
  };
}

async function readTeamProgressSnapshot(stateDir, teamName, workerNames) {
  const [taskSnapshot, workerSnapshot] = await Promise.all([
    readTeamTaskProgressSnapshot(stateDir, teamName),
    Promise.all(
      workerNames.map(async (workerName) => {
        const [status, heartbeat] = await Promise.all([
          readWorkerStatusSnapshot(stateDir, teamName, workerName),
          readWorkerHeartbeatSnapshot(stateDir, teamName, workerName),
        ]);
        return {
          worker: workerName,
          state: status.state,
          current_task_id: status.current_task_id,
          status_missing: status.missing === true,
          turn_count: heartbeat.turn_count,
          heartbeat_missing: heartbeat.missing === true,
        };
      }),
    ),
  ]);

  const missingSignalWorkers = workerSnapshot.filter(
    ({ status_missing, heartbeat_missing }) => status_missing || heartbeat_missing,
  ).length;

  return {
    ...taskSnapshot,
    workerSnapshot,
    missingSignalWorkers,
    signature: JSON.stringify({
      tasks: taskSnapshot.taskSignature,
      workers: workerSnapshot,
    }),
  };
}

function readPreviousWorkerTurnCounts(previousSignature) {
  try {
    const parsed = JSON.parse(previousSignature || '{}');
    const workers = Array.isArray(parsed?.workers) ? parsed.workers : [];
    return new Map(workers
      .map((worker) => [safeString(worker?.worker).trim(), Number.isFinite(worker?.turn_count) ? Number(worker.turn_count) : null])
      .filter(([workerName]) => workerName.length > 0));
  } catch {
    return new Map();
  }
}

function hasWorkerTurnProgress(workerSnapshot, previousTurnCounts) {
  return workerSnapshot.some((worker) => {
    if (worker.state !== 'working' && worker.state !== 'blocked') return false;
    if (!Number.isFinite(worker.turn_count) || worker.turn_count === null) return false;
    const previousTurnCount = previousTurnCounts.get(worker.worker);
    return Number.isFinite(previousTurnCount) && previousTurnCount !== null && worker.turn_count > previousTurnCount;
  });
}

function hasTrackableActiveWorkerTurns(workerSnapshot, previousTurnCounts) {
  return workerSnapshot.some((worker) => {
    if (worker.state !== 'working' && worker.state !== 'blocked') return false;
    if (!Number.isFinite(worker.turn_count) || worker.turn_count === null) return false;
    const previousTurnCount = previousTurnCounts.get(worker.worker);
    return Number.isFinite(previousTurnCount) && previousTurnCount !== null;
  });
}

function formatDurationMs(durationMs) {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${remainingSeconds}s`;
}

function normalizeMailboxMessages(rawMailbox) {
  if (Array.isArray(rawMailbox)) return rawMailbox;
  if (rawMailbox && typeof rawMailbox === 'object' && Array.isArray(rawMailbox.messages)) {
    return rawMailbox.messages;
  }
  return [];
}

function normalizeMessageIdentity(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const explicitId = safeString(msg.message_id || '').trim();
  if (explicitId) return explicitId;
  const createdAt = safeString(msg.created_at || msg.timestamp || '').trim();
  const from = safeString(msg.from_worker || msg.from || '').trim();
  const body = safeString(msg.body || '').trim();
  return [createdAt, from, body].filter(Boolean).join('|');
}

function normalizeMailboxBody(body) {
  return safeString(body).replace(/\s+/g, ' ').trim();
}

function isAckLikeMailboxBody(body) {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return false;
  return ACK_LIKE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function formatMailboxBodyForLeader(body, maxLength = 40) {
  const normalized = normalizeMailboxBody(body);
  if (!normalized) return 'ack-like update';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

async function workerHasOwnedStartedTask(stateDir, teamName, workerName) {
  const tasksDir = join(stateDir, 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) return false;

  try {
    const taskFiles = (await readdir(tasksDir))
      .filter((entry) => /^task-\d+\.json$/.test(entry))
      .sort();
    for (const entry of taskFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(tasksDir, entry), 'utf-8'));
        if (safeString(parsed?.owner).trim() !== workerName) continue;
        const status = safeString(parsed?.status).trim();
        if (status === 'in_progress' || status === 'completed' || status === 'failed') return true;
      } catch {
        // ignore malformed task files
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function getAckWithoutStartEvidence(stateDir, teamName, msg) {
  if (!msg || typeof msg !== 'object') return null;
  const fromWorker = safeString(msg.from_worker || '').trim();
  if (!fromWorker || fromWorker === 'leader-fixed') return null;
  if (!isAckLikeMailboxBody(msg.body)) return null;

  const status = await readWorkerStatusSnapshot(stateDir, teamName, fromWorker);
  if (
    status.current_task_id
    || status.state === 'working'
    || status.state === 'blocked'
    || status.state === 'done'
    || status.state === 'failed'
  ) {
    return null;
  }

  if (await workerHasOwnedStartedTask(stateDir, teamName, fromWorker)) {
    return null;
  }

  return {
    worker: fromWorker,
    body: formatMailboxBodyForLeader(msg.body),
    statusState: status.state,
  };
}

export async function emitTeamNudgeEvent(cwd, teamName, reason, orchestrationIntent, nowIso) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `nudge-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason,
      orchestration_intent: orchestrationIntent,
      created_at: nowIso,
    };
    await appendFile(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort
  }
}

async function emitLeaderNudgeDeferredEvent(cwd, teamName, reason, orchestrationIntent, nowIso, { tmuxSession = '', leaderPaneId = '', paneCurrentCommand = '', sourceType = 'leader_nudge' } = {}) {
  const eventsDir = join(cwd, '.omx', 'state', 'team', teamName, 'events');
  const eventsPath = join(eventsDir, 'events.ndjson');
  try {
    await mkdir(eventsDir, { recursive: true });
    const event = {
      event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      team: teamName,
      type: LEADER_NOTIFICATION_DEFERRED_TYPE,
      worker: 'leader-fixed',
      to_worker: 'leader-fixed',
      reason,
      created_at: nowIso,
      tmux_session: tmuxSession || null,
      leader_pane_id: leaderPaneId || null,
      orchestration_intent: orchestrationIntent,
      tmux_injection_attempted: false,
      pane_current_command: paneCurrentCommand || null,
      source_type: sourceType,
    };
    await appendFile(eventsPath, JSON.stringify(event) + '\n');
  } catch {
    // Best effort
  }
}

export async function maybeNudgeTeamLeader({
  cwd,
  stateDir,
  logsDir,
  preComputedLeaderStale,
  allowFreshMailboxNudges = true,
  source = 'notify_hook',
}) {
  const intervalMs = resolveLeaderNudgeIntervalMs();
  const idleCooldownMs = resolveLeaderAllIdleNudgeCooldownMs();
  const fallbackProgressStallThresholdMs = resolveFallbackProgressStallThresholdMs();
  const workerTurnStallThresholdMs = resolveWorkerTurnStallThresholdMs();
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const omxDir = join(cwd, '.omx');
  const nudgeStatePath = join(stateDir, 'team-leader-nudge.json');

  let nudgeState = await readJsonIfExists(nudgeStatePath, null);
  if (!nudgeState || typeof nudgeState !== 'object') {
    nudgeState = { last_nudged_by_team: {} };
  }
  if (!nudgeState.last_nudged_by_team || typeof nudgeState.last_nudged_by_team !== 'object') {
    nudgeState.last_nudged_by_team = {};
  }
  if (!nudgeState.last_idle_nudged_by_team || typeof nudgeState.last_idle_nudged_by_team !== 'object') {
    nudgeState.last_idle_nudged_by_team = {};
  }
  if (!nudgeState.progress_by_team || typeof nudgeState.progress_by_team !== 'object') {
    nudgeState.progress_by_team = {};
  }

  const candidateTeamNames = new Set();
  const currentSessionId = await resolveCurrentSessionId(stateDir);
  try {
    const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
    const candidateStateDirs = [...new Set([...scopedDirs, stateDir])];
    for (const scopedDir of candidateStateDirs) {
      const teamStatePath = join(scopedDir, 'team-state.json');
      if (!existsSync(teamStatePath)) continue;
      const parsed = JSON.parse(await readFile(teamStatePath, 'utf-8'));
      if (!parsed) continue;
      const teamName = safeString(parsed.team_name || '').trim();
      if (!teamName) continue;

      const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, nowIso);
      if (phaseSnapshot.terminal) {
        await syncScopedTeamStateFromPhase(teamStatePath, teamName, phaseSnapshot, nowIso);
        continue;
      }
      if (parsed.active === true) {
        candidateTeamNames.add(teamName);
      }
    }
  } catch {
    // Non-critical
  }

  // Use pre-computed staleness (captured before HUD state was updated this turn)
  const leaderStale = typeof preComputedLeaderStale === 'boolean' ? preComputedLeaderStale : false;

  for (const teamName of candidateTeamNames) {
    let tmuxSession = '';
    let leaderPaneId = '';
    let ownerSessionId = '';
    let workers = [];
    try {
      const manifestPath = join(omxDir, 'state', 'team', teamName, 'manifest.v2.json');
      const configPath = join(omxDir, 'state', 'team', teamName, 'config.json');
      const srcPath = existsSync(manifestPath) ? manifestPath : configPath;
      if (existsSync(srcPath)) {
        const raw = JSON.parse(await readFile(srcPath, 'utf-8'));
        tmuxSession = safeString(raw && raw.tmux_session ? raw.tmux_session : '').trim();
        leaderPaneId = safeString(raw && raw.leader_pane_id ? raw.leader_pane_id : '').trim();
        ownerSessionId = safeString(raw && raw.leader && raw.leader.session_id ? raw.leader.session_id : '').trim();
        if (Array.isArray(raw && raw.workers)) workers = raw.workers;
      }
    } catch {
      // ignore
    }
    if (currentSessionId && ownerSessionId && ownerSessionId !== currentSessionId) continue;
    let mailbox = null;
    try {
      const mailboxPath = join(omxDir, 'state', 'team', teamName, 'mailbox', 'leader-fixed.json');
      mailbox = await readJsonIfExists(mailboxPath, null);
    } catch {
      mailbox = null;
    }
    const messages = normalizeMailboxMessages(mailbox);
    const newest = messages.length > 0 ? messages[messages.length - 1] : null;
    const newestId = normalizeMessageIdentity(newest);

    const workerNames = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.name ? w.name : '')).filter(Boolean)
      : [];
    const workerPaneIds = Array.isArray(workers)
      ? workers.map((w) => safeString(w && w.pane_id ? w.pane_id : '')).filter(Boolean)
      : [];
    const canonicalLeaderPaneId = safeString(leaderPaneId).trim();
    if (!tmuxSession && !canonicalLeaderPaneId) continue;
    let tmuxTarget = canonicalLeaderPaneId;
    if (canonicalLeaderPaneId) {
      const resolvedLeaderTarget = await resolvePaneTarget(
        { type: 'pane', value: canonicalLeaderPaneId },
        '',
        canonicalLeaderPaneId,
        '',
        {},
      ).catch(() => null);
      if (resolvedLeaderTarget?.paneTarget) {
        tmuxTarget = safeString(resolvedLeaderTarget.paneTarget).trim();
      } else if (resolvedLeaderTarget && ['target_is_hud_pane', 'pane_cwd_mismatch'].includes(safeString(resolvedLeaderTarget.reason).trim())) {
        tmuxTarget = '';
      }
    }
    const paneStatus = tmuxSession
      ? await checkWorkerPanesAlive(tmuxSession, workerPaneIds)
      : { alive: false, paneCount: 0 };
    const workerStates = workerNames.length > 0
      ? await Promise.all(workerNames.map((workerName) => readWorkerStatusState(stateDir, teamName, workerName)))
      : [];
    const allWorkersIdle = workerStates.length > 0 && workerStates.every((state) => state === 'idle' || state === 'done');
    const progressSnapshot = await readTeamProgressSnapshot(stateDir, teamName, workerNames);
    const prevProgress = nudgeState.progress_by_team[teamName] && typeof nudgeState.progress_by_team[teamName] === 'object'
      ? nudgeState.progress_by_team[teamName]
      : {};
    const previousSignature = safeString(prevProgress.signature || '');
    const previousProgressAtIso = safeString(prevProgress.last_progress_at || '');
    const previousProgressAtMs = previousProgressAtIso ? Date.parse(previousProgressAtIso) : NaN;
    const previousTurnCounts = readPreviousWorkerTurnCounts(previousSignature);
    const workerTurnProgress = hasWorkerTurnProgress(progressSnapshot.workerSnapshot, previousTurnCounts);
    const hasTrackableTurnSignals = hasTrackableActiveWorkerTurns(progressSnapshot.workerSnapshot, previousTurnCounts);
    const progressChanged = !previousSignature || previousSignature !== progressSnapshot.signature || workerTurnProgress;
    const effectiveProgressAtMs = progressChanged || !Number.isFinite(previousProgressAtMs)
      ? nowMs
      : previousProgressAtMs;
    const effectiveProgressAtIso = new Date(effectiveProgressAtMs).toISOString();
    const stalledForMs = Math.max(0, nowMs - effectiveProgressAtMs);
    const stallThresholdMs = hasTrackableTurnSignals ? workerTurnStallThresholdMs : fallbackProgressStallThresholdMs;
    const teamProgressStalled =
      progressSnapshot.workRemaining
      && paneStatus.alive
      && !allWorkersIdle
      && !progressChanged
      && stalledForMs >= stallThresholdMs;
    const leaderActionState = classifyLeaderActionState({
      allWorkersIdle,
      workerPanesAlive: paneStatus.alive,
      taskCounts: progressSnapshot.taskCounts,
      teamProgressStalled,
    });
    const leaderActionGuidance = buildLeaderActionGuidance(teamName, {
      allWorkersIdle,
      workerPanesAlive: paneStatus.alive,
      taskCounts: progressSnapshot.taskCounts,
      leaderActionState,
    });
    const prev = nudgeState.last_nudged_by_team[teamName] && typeof nudgeState.last_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_nudged_by_team[teamName]
      : {};
    const prevAtIso = safeString(prev.at || '');
    const prevAtMs = prevAtIso ? Date.parse(prevAtIso) : NaN;
    const prevMsgId = safeString(prev.last_message_id || '');
    const prevReason = safeString(prev.reason || '');

    const hasNewMessage = newestId && newestId !== prevMsgId;
    const dueByTime = !Number.isFinite(prevAtMs) || (nowMs - prevAtMs >= intervalMs);
    const ackWithoutStartEvidence = hasNewMessage
      ? await getAckWithoutStartEvidence(stateDir, teamName, newest)
      : null;

    const prevIdle = nudgeState.last_idle_nudged_by_team[teamName] && typeof nudgeState.last_idle_nudged_by_team[teamName] === 'object'
      ? nudgeState.last_idle_nudged_by_team[teamName]
      : {};
    const prevIdleAtIso = safeString(prevIdle.at || '');
    const prevIdleAtMs = prevIdleAtIso ? Date.parse(prevIdleAtIso) : NaN;
    const dueByIdleCooldown = !Number.isFinite(prevIdleAtMs) || (nowMs - prevIdleAtMs >= idleCooldownMs);
    const shouldSendAllIdleNudge = allWorkersIdle && dueByIdleCooldown;

    // Stale-leader follow-up is the only periodic visible nudge path.
    // This keeps the leader pane quieter when the leader is not actually stale.
    const stalePanesNudge = paneStatus.alive && leaderStale;
    const previousStalledTeamNudge = prevReason === 'stuck_waiting_on_leader';
    const stalledTeamNudge = teamProgressStalled && (dueByTime || !previousStalledTeamNudge);
    const staleFollowupDue = stalePanesNudge && dueByTime;
    const hasActionableNewMessage = hasNewMessage && (allowFreshMailboxNudges || leaderStale);

    let nudgeReason = '';
    let text = '';
    if (shouldSendAllIdleNudge) {
      nudgeReason = leaderActionState === 'done_waiting_on_leader'
        ? 'done_waiting_on_leader'
        : leaderActionState === 'stuck_waiting_on_leader'
          ? 'stuck_waiting_on_leader'
          : 'all_workers_idle';
      const N = workerNames.length;
      const waitingText = buildIdleContextText(teamName, {
        allWorkersIdle,
        workerPanesAlive: paneStatus.alive,
        taskCounts: progressSnapshot.taskCounts,
        leaderActionState,
      });
      text = `[OMX] All ${N} worker${N === 1 ? '' : 's'} idle.${waitingText} ${leaderActionGuidance}`;
    } else if (ackWithoutStartEvidence) {
      nudgeReason = ACK_WITHOUT_START_EVIDENCE_REASON;
      text =
        `Team ${teamName}: ${ackWithoutStartEvidence.worker} said "${ackWithoutStartEvidence.body}" `
        + `but has no start evidence (status: ${ackWithoutStartEvidence.statusState}). `
        + buildWorkerStartEvidenceReminder(teamName, ackWithoutStartEvidence.worker);
    } else if (stalledTeamNudge) {
      nudgeReason = 'stuck_waiting_on_leader';
      const stallPrefix = leaderStale ? 'leader stale, ' : 'worker panes stalled, ';
      text =
        `Team ${teamName}: ${stallPrefix}no progress ${formatDurationMs(stalledForMs)}. `
        + leaderActionGuidance;
    } else if (stalePanesNudge && hasActionableNewMessage) {
      nudgeReason = 'stale_leader_with_messages';
      text =
        `Team ${teamName}: leader stale, ${paneStatus.paneCount} pane(s) active, ${messages.length} msg(s) pending. `
        + buildMailboxCheckReminder(teamName);
    } else if (staleFollowupDue) {
      nudgeReason = 'stale_leader_panes_alive';
      text =
        `Team ${teamName}: leader stale, ${paneStatus.paneCount} worker pane(s) still active. `
        + leaderActionGuidance;
    } else if (hasActionableNewMessage) {
      nudgeReason = 'new_mailbox_message';
      text = `Team ${teamName}: ${messages.length} msg(s) for leader. ${buildMailboxCheckReminder(teamName)}`;
    }

    const unreadLeaderMessageCount = messages.filter((message) => !safeString(message?.delivered_at).trim()).length;
    nudgeState.progress_by_team[teamName] = {
      signature: progressSnapshot.signature,
      last_progress_at: effectiveProgressAtIso,
      observed_at: nowIso,
      missing_signal_workers: progressSnapshot.missingSignalWorkers,
      work_remaining: progressSnapshot.workRemaining,
      leader_action_state: leaderActionState,
      leader_attention_pending: !!nudgeReason,
      leader_attention_reason: nudgeReason || null,
      leader_stale: leaderStale,
      all_workers_idle: allWorkersIdle,
      pending_task_count:
        (progressSnapshot.taskCounts.pending || 0)
        + (progressSnapshot.taskCounts.blocked || 0)
        + (progressSnapshot.taskCounts.in_progress || 0),
      unread_leader_message_count: unreadLeaderMessageCount,
      stalled_for_ms: teamProgressStalled ? stalledForMs : null,
      source: source === 'notify_fallback_watcher' ? 'notify_hook' : source,
    };
    await writeTeamLeaderAttention(teamName, {
      team_name: teamName,
      updated_at: nowIso,
      source: 'notify_hook',
      leader_decision_state: leaderActionState,
      leader_attention_pending: !!nudgeReason,
      leader_attention_reason: nudgeReason || null,
      attention_reasons: nudgeReason ? [nudgeReason] : [],
      leader_stale: leaderStale,
      leader_session_active: true,
      leader_session_id: currentSessionId || ownerSessionId || null,
      leader_session_stopped_at: null,
      unread_leader_message_count: unreadLeaderMessageCount,
      work_remaining: progressSnapshot.workRemaining,
      stalled_for_ms: teamProgressStalled ? stalledForMs : null,
    }, cwd).catch(() => {});

    if (!nudgeReason) continue;
    const orchestrationIntent = resolveLeaderNudgeIntent({ nudgeReason, leaderActionState });
    const capped = text.length > 180 ? `${text.slice(0, 177)}...` : text;
    const markedText = `${capped} ${DEFAULT_MARKER}`;

    if (!tmuxTarget) {
      nudgeState.last_nudged_by_team[teamName] = {
        at: nowIso,
        last_message_id: newestId || prevMsgId || '',
        reason: nudgeReason,
        orchestration_intent: orchestrationIntent,
      };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = {
          at: nowIso,
          worker_count: workerNames.length,
          orchestration_intent: orchestrationIntent,
        };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, LEADER_PANE_MISSING_NO_INJECTION_REASON, orchestrationIntent, nowIso, {
        tmuxSession,
        leaderPaneId,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          orchestration_intent: orchestrationIntent,
          tmux_injection_attempted: false,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      await appendTeamDeliveryLog(logsDir, {
        event: 'nudge_triggered',
        source,
        team: teamName,
        to_worker: 'leader-fixed',
        transport: 'none',
        result: 'deferred',
        reason: LEADER_PANE_MISSING_NO_INJECTION_REASON,
        orchestration_intent: orchestrationIntent,
      }).catch(() => {});
      continue;
    }

    const paneGuard = await evaluatePaneInjectionReadiness(tmuxTarget, {
      skipIfScrolling: true,
      // Leader nudges should still queue into a live Codex pane even while the
      // agent is busy; shell/copy-mode guards stay enforced.
      requireRunningAgent: true,
      requireReady: false,
      requireIdle: false,
    });
    if (!paneGuard.ok) {
      const deferredReason = paneGuard.reason === 'pane_running_shell'
        ? LEADER_PANE_SHELL_NO_INJECTION_REASON
        : paneGuard.reason;
      nudgeState.last_nudged_by_team[teamName] = {
        at: nowIso,
        last_message_id: newestId || prevMsgId || '',
        reason: nudgeReason,
        orchestration_intent: orchestrationIntent,
      };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = {
          at: nowIso,
          worker_count: workerNames.length,
          orchestration_intent: orchestrationIntent,
        };
      }
      await emitLeaderNudgeDeferredEvent(cwd, teamName, deferredReason, orchestrationIntent, nowIso, {
        tmuxSession,
        leaderPaneId,
        paneCurrentCommand: paneGuard.paneCurrentCommand,
        sourceType: 'leader_nudge',
      });
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: LEADER_NOTIFICATION_DEFERRED_TYPE,
          team: teamName,
          worker: 'leader-fixed',
          to_worker: 'leader-fixed',
          reason: deferredReason,
          leader_pane_id: leaderPaneId || null,
          tmux_session: tmuxSession || null,
          tmux_injection_attempted: false,
          pane_target: tmuxTarget,
          orchestration_intent: orchestrationIntent,
          readiness_evidence: paneGuard.readinessEvidence || null,
          pane_current_command: paneGuard.paneCurrentCommand || null,
          injection_skip_reason: paneGuard.reason,
          source_type: 'leader_nudge',
        });
      } catch { /* ignore */ }
      await appendTeamDeliveryLog(logsDir, {
        event: 'nudge_triggered',
        source,
        team: teamName,
        to_worker: 'leader-fixed',
        transport: 'none',
        result: 'deferred',
        reason: deferredReason,
        orchestration_intent: orchestrationIntent,
      }).catch(() => {});
      continue;
    }

    try {
      const sendResult = await sendPaneInput({
        paneTarget: tmuxTarget,
        prompt: markedText,
        submitKeyPresses: 2,
        submitDelayMs: 100,
      });
      if (!sendResult.ok) {
        throw new Error(sendResult.error || sendResult.reason);
      }
      nudgeState.last_nudged_by_team[teamName] = {
        at: nowIso,
        last_message_id: newestId || prevMsgId || '',
        reason: nudgeReason,
        orchestration_intent: orchestrationIntent,
      };
      if (shouldSendAllIdleNudge) {
        nudgeState.last_idle_nudged_by_team[teamName] = {
          at: nowIso,
          worker_count: workerNames.length,
          orchestration_intent: orchestrationIntent,
        };
      }

      await emitTeamNudgeEvent(cwd, teamName, nudgeReason, orchestrationIntent, nowIso);

      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          orchestration_intent: orchestrationIntent,
          pane_count: paneStatus.paneCount,
          leader_stale: leaderStale,
          message_count: messages.length,
          stalled_for_ms: teamProgressStalled ? stalledForMs : undefined,
          missing_signal_workers: progressSnapshot.missingSignalWorkers,
        });
      } catch { /* ignore */ }
      await appendTeamDeliveryLog(logsDir, {
        event: 'nudge_triggered',
        source,
        team: teamName,
        to_worker: 'leader-fixed',
        transport: 'send-keys',
        result: 'sent',
        reason: nudgeReason,
        orchestration_intent: orchestrationIntent,
      }).catch(() => {});
    } catch (err) {
      try {
        await logTmuxHookEvent(logsDir, {
          timestamp: nowIso,
          type: 'team_leader_nudge',
          team: teamName,
          tmux_target: tmuxTarget,
          reason: nudgeReason,
          orchestration_intent: orchestrationIntent,
          error: safeString(err && err.message ? err.message : err),
        });
      } catch { /* ignore */ }
      await appendTeamDeliveryLog(logsDir, {
        event: 'nudge_triggered',
        source,
        team: teamName,
        to_worker: 'leader-fixed',
        transport: 'send-keys',
        result: 'failed',
        reason: nudgeReason,
        orchestration_intent: orchestrationIntent,
        error: safeString(err && err.message ? err.message : err),
      }).catch(() => {});
    }
  }

  await writeFile(nudgeStatePath, JSON.stringify(nudgeState, null, 2)).catch(() => {});
}
