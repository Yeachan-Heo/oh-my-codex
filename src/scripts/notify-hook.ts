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

import { safeString, asNumber } from './notify-hook/utils.js';
import {
  getSessionTokenUsage,
  getQuotaUsage,
  normalizeInputMessages,
} from './notify-hook/payload-parser.js';
import {
  getScopedStatePath,
  readCurrentSessionId,
  readScopedJsonIfExists,
  getScopedStateDirsForCurrentSession,
  normalizeNotifyState,
  pruneRecentTurns,
  readdir,
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
import { isManagedOmxSession } from './notify-hook/managed-tmux.js';
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

async function main() {
  const rawPayload = process.argv[process.argv.length - 1];
  if (!rawPayload || rawPayload.startsWith('-')) {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    process.exit(0);
  }

  const cwd = payload.cwd || payload['cwd'] || process.cwd();
  const payloadSessionId = safeString(payload.session_id || payload['session-id'] || '');
  const payloadThreadId = safeString(payload['thread-id'] || payload.thread_id || '');
  const inputMessages = normalizeInputMessages(payload);
  const latestUserInput = safeString(inputMessages.length > 0 ? inputMessages[inputMessages.length - 1] : '');
  const isTurnComplete = isTurnCompletePayload(payload);

  // Team worker detection via environment variable
  const teamWorkerEnv = process.env.OMX_TEAM_WORKER; // e.g., "fix-ts/worker-1"
  const parsedTeamWorker = parseTeamWorkerEnv(teamWorkerEnv);
  const isTeamWorker = !!parsedTeamWorker;

  const resolvedWorkerStateDir = (isTeamWorker && parsedTeamWorker)
    ? await resolveTeamStateDirForWorker(cwd, parsedTeamWorker)
    : null;
  const workerStateRootResolved = !isTeamWorker || !!resolvedWorkerStateDir;
  const stateDir = resolvedWorkerStateDir || join(cwd, '.omx', 'state');
  const logsDir = join(cwd, '.omx', 'logs');
  const omxDir = join(cwd, '.omx');
  let currentOmxSessionId = '';
  const getEffectiveSessionId = () => currentOmxSessionId || payloadSessionId;

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  if (workerStateRootResolved) {
    await mkdir(stateDir, { recursive: true }).catch(() => {});
    currentOmxSessionId = await readCurrentSessionId(stateDir).catch(() => '') || '';
  }

  // Turn-level dedupe prevents double-processing when native notify and fallback
  // watcher both emit the same completed turn.
  try {
    if (!workerStateRootResolved) throw new Error('worker_state_root_unresolved');
    const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
    if (turnId) {
      const now = Date.now();
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const eventType = safeString(payload.type || 'agent-turn-complete');
      const key = `${threadId || 'no-thread'}|${turnId}|${eventType}`;
      const dedupeSessionId = getEffectiveSessionId();
      const dedupeStatePath = await getScopedStatePath(stateDir, 'notify-hook-state.json', dedupeSessionId);
      const dedupeState = normalizeNotifyState(
        await readScopedJsonIfExists(stateDir, 'notify-hook-state.json', dedupeSessionId, null),
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

  // 0.5. Track leader + native subagent thread activity (lead session only)
  if (!isTeamWorker) {
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
  if (!isTeamWorker) {
    try {
      const resumeResult = await reconcileRalphSessionResume({
        stateDir,
        payloadSessionId,
        payloadThreadId,
      });
      currentOmxSessionId = resumeResult.currentOmxSessionId;
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
  if (!isTeamWorker) {
    try {
      const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir);
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
  if (!isTeamWorker) {
    try {
      const scopedSessionId = getEffectiveSessionId();
      const hudStatePath = await getScopedStatePath(stateDir, 'hud-state.json', scopedSessionId);
      let hudState = await readScopedJsonIfExists(stateDir, 'hud-state.json', scopedSessionId, {
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

  // 4.45. Skill activation tracking: update skill-active-state.json before any nudge logic.
  try {
    const { recordSkillActivation } = await import('../hooks/keyword-detector.js');
    if (latestUserInput) {
        await recordSkillActivation({
          stateDir,
          text: latestUserInput,
          sessionId: getEffectiveSessionId(),
          threadId: payloadThreadId,
          turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
        });
    }
  } catch {
    // Non-fatal: keyword detector module may not be built yet
  }

  try {
    await syncSkillStateFromTurn(stateDir, payload);
  } catch {
    // Non-fatal: lifecycle sync should not block the hook
  }

  const deepInterviewStateActive = await isDeepInterviewStateActive(stateDir, getEffectiveSessionId());
  const deepInterviewInputLockActive = await isDeepInterviewInputLockActive(stateDir, getEffectiveSessionId());

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
  if (!isTeamWorker) {
    try {
      await handleTmuxInjection({ payload, cwd, stateDir, logsDir });
    } catch {
      // Non-critical
    }
  }

  // 5.5. Opportunistic team dispatch drain (leader session only).
  if (!isTeamWorker) {
    try {
      await drainPendingTeamDispatch({ cwd, stateDir, logsDir, maxPerTick: 5 } as any);
    } catch {
      // Non-critical
    }
  }

  // 6. Team leader nudge (lead session only): remind the leader to check teammate/mailbox state.
  if (!isTeamWorker && !deepInterviewStateActive) {
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

      const shouldNotifyLifecycle = notifySessionId
        && shouldSendIdleNotification(stateDir, notifySessionId, idleFingerprint);
      const shouldDispatchSessionIdleHookEvent = notifySessionId
        && shouldSendSessionIdleHookEvent(stateDir, notifySessionId, idleFingerprint);

      if (shouldNotifyLifecycle || shouldDispatchSessionIdleHookEvent) {
        if (shouldNotifyLifecycle) {
          const idleResult = await notifyLifecycle('session-idle', {
            sessionId: notifySessionId,
            projectPath: cwd,
          });
          if (idleResult && idleResult.anySuccess) {
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
  if (!deepInterviewStateActive || deepInterviewInputLockActive) {
    try {
      await maybeAutoNudge({ cwd, stateDir, logsDir, payload });
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
  if (!isTeamWorker) {
    try {
      const { processCodeSimplifier } = await import('../hooks/code-simplifier/index.js');
      const csResult = processCodeSimplifier(cwd, stateDir);
      if (csResult.triggered) {
        const managedSession = await isManagedOmxSession(cwd, payload, { allowTeamWorker: false });
        if (!managedSession) {
          const { logTmuxHookEvent } = await import('./notify-hook/log.js');
          await logTmuxHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'code_simplifier_skipped',
            reason: 'unmanaged_session',
          });
        } else {
          const csPaneId = await resolveNudgePaneTarget(stateDir, cwd, payload);
          if (csPaneId) {
            const csText = `${csResult.message} ${DEFAULT_MARKER}`;
            const sendResult = await sendPaneInput({
              paneTarget: csPaneId,
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

main().catch((err) => {
  process.exitCode = 1;
  // eslint-disable-next-line no-console
  console.error('[notify-hook] fatal error:', err);
});
