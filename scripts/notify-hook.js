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
 *   linked-sync.js     – linked ralph/team terminal sync
 *   tmux-injection.js  – tmux prompt injection
 *   team-leader-nudge.js – leader mailbox nudge
 *   team-worker.js     – worker heartbeat and idle notification
 */

import { writeFile, appendFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

import { safeString, asNumber } from './notify-hook/utils.js';
import {
  getSessionTokenUsage,
  getQuotaUsage,
  normalizeInputMessages,
} from './notify-hook/payload-parser.js';
import {
  readJsonIfExists,
  getScopedStateDirsForCurrentSession,
  normalizeNotifyState,
  pruneRecentTurns,
  readdir,
} from './notify-hook/state-io.js';
import { isLeaderStale, resolveLeaderStalenessThresholdMs, maybeNudgeTeamLeader } from './notify-hook/team-leader-nudge.js';
import { syncLinkedRalphOnTeamTerminal } from './notify-hook/linked-sync.js';
import { handleTmuxInjection } from './notify-hook/tmux-injection.js';
import { maybeAutoNudge, resolveNudgePaneTarget } from './notify-hook/auto-nudge.js';
import {
  parseTeamWorkerEnv,
  resolveTeamStateDirForWorker,
  updateWorkerHeartbeat,
  maybeNotifyLeaderAllWorkersIdle,
  maybeNotifyLeaderWorkerIdle,
} from './notify-hook/team-worker.js';
import { DEFAULT_MARKER } from './tmux-hook-engine.js';

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

  // Team worker detection via environment variable
  const teamWorkerEnv = process.env.OMX_TEAM_WORKER; // e.g., "fix-ts/worker-1"
  const parsedTeamWorker = parseTeamWorkerEnv(teamWorkerEnv);
  const isTeamWorker = !!parsedTeamWorker;

  const stateDir = (isTeamWorker && parsedTeamWorker)
    ? await resolveTeamStateDirForWorker(cwd, parsedTeamWorker)
    : join(cwd, '.omx', 'state');
  const logsDir = join(cwd, '.omx', 'logs');
  const omxDir = join(cwd, '.omx');

  // Ensure directories exist
  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await mkdir(stateDir, { recursive: true }).catch(() => {});

  // Turn-level dedupe prevents double-processing when native notify and fallback
  // watcher both emit the same completed turn.
  try {
    const turnId = safeString(payload['turn-id'] || payload.turn_id || '');
    if (turnId) {
      const now = Date.now();
      const threadId = safeString(payload['thread-id'] || payload.thread_id || '');
      const eventType = safeString(payload.type || 'agent-turn-complete');
      const key = `${threadId || 'no-thread'}|${turnId}|${eventType}`;
      const dedupeStatePath = join(stateDir, 'notify-hook-state.json');
      const dedupeState = normalizeNotifyState(await readJsonIfExists(dedupeStatePath, null));
      dedupeState.recent_turns = pruneRecentTurns(dedupeState.recent_turns, now);
      if (dedupeState.recent_turns[key]) {
        process.exit(0);
      }
      dedupeState.recent_turns[key] = now;
      dedupeState.last_event_at = new Date().toISOString();
      await writeFile(dedupeStatePath, JSON.stringify(dedupeState, null, 2)).catch(() => {});
    }
  } catch {
    // Non-critical
  }

  // 1. Log the turn
  const logEntry = {
    timestamp: new Date().toISOString(),
    type: payload.type || 'agent-turn-complete',
    thread_id: payload['thread-id'] || payload.thread_id,
    turn_id: payload['turn-id'] || payload.turn_id,
    input_preview: (payload['input-messages'] || payload.input_messages || [])
      .map(m => m.slice(0, 100))
      .join('; '),
    output_preview: (payload['last-assistant-message'] || payload.last_assistant_message || '')
      .slice(0, 200),
  };

  const logFile = join(logsDir, `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
  await appendFile(logFile, JSON.stringify(logEntry) + '\n').catch(() => {});

  // 2. Update active mode state (increment iteration)
  // GUARD: Skip when running inside a team worker to prevent state corruption
  if (!isTeamWorker) {
    try {
      const scopedDirs = await getScopedStateDirsForCurrentSession(stateDir, payloadSessionId);
      for (const scopedDir of scopedDirs) {
        const stateFiles = await readdir(scopedDir).catch(() => []);
        for (const f of stateFiles) {
          if (!f.endsWith('-state.json')) continue;
          const statePath = join(scopedDir, f);
          const state = JSON.parse(await readFile(statePath, 'utf-8'));
          if (state.active) {
            state.iteration = (state.iteration || 0) + 1;
            state.last_turn_at = new Date().toISOString();
            await writeFile(statePath, JSON.stringify(state, null, 2));
          }
        }
      }
    } catch {
      // Non-critical
    }
  }

  // If linked team reaches terminal state, mark linked ralph terminal/inactive too.
  if (!isTeamWorker) {
    await syncLinkedRalphOnTeamTerminal(stateDir, new Date().toISOString(), payloadSessionId);
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
        if (quotaUsage.fiveHourLimitPct !== null) metrics.five_hour_limit_pct = quotaUsage.fiveHourLimitPct;
        if (quotaUsage.weeklyLimitPct !== null) metrics.weekly_limit_pct = quotaUsage.weeklyLimitPct;
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
    const hudStatePath = join(stateDir, 'hud-state.json');
    try {
      let hudState = { last_turn_at: '', turn_count: 0 };
      if (existsSync(hudStatePath)) {
        hudState = JSON.parse(await readFile(hudStatePath, 'utf-8'));
      }
      hudState.last_turn_at = new Date().toISOString();
      hudState.turn_count = (hudState.turn_count || 0) + 1;
      hudState.last_agent_output = (payload['last-assistant-message'] || payload.last_assistant_message || '')
        .slice(0, 100);
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

  // 4.55. Notify leader when individual worker transitions to idle (worker session only)
  if (isTeamWorker && parsedTeamWorker) {
    try {
      await maybeNotifyLeaderWorkerIdle({ cwd, stateDir, logsDir, parsedTeamWorker });
    } catch {
      // Non-critical
    }
  }

  // 4.6. Notify leader when all workers are idle (worker session only)
  if (isTeamWorker && parsedTeamWorker) {
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

  // 6. Team leader nudge (lead session only): remind the leader to check teammate/mailbox state.
  if (!isTeamWorker) {
    try {
      await maybeNudgeTeamLeader({ cwd, stateDir, logsDir, preComputedLeaderStale });
    } catch {
      // Non-critical
    }
  }

  // 7. Dispatch native turn-complete hook event (best effort, post-dedupe)
  try {
    const { buildNativeHookEvent } = await import('../dist/hooks/extensibility/events.js');
    const { dispatchHookEvent } = await import('../dist/hooks/extensibility/dispatcher.js');
    const event = buildNativeHookEvent('turn-complete', {
      source: safeString(payload.source || 'native'),
      type: safeString(payload.type || 'agent-turn-complete'),
      input_messages: normalizeInputMessages(payload),
      output_preview: safeString(payload['last-assistant-message'] || payload.last_assistant_message || '').slice(0, 400),
    }, {
      session_id: safeString(payload.session_id || payload['session-id'] || ''),
      thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
      turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
      mode: safeString(payload.mode || ''),
    });
    await dispatchHookEvent(event, { cwd });
  } catch {
    // Non-fatal: extensibility modules may not be built yet
  }

  // 8. Dispatch session-idle lifecycle notification (lead session only, best effort)
  if (!isTeamWorker) {
    try {
      const { notifyLifecycle } = await import('../dist/notifications/index.js');
      const sessionJsonPath = join(stateDir, 'session.json');
      let notifySessionId = '';
      try {
        const sessionData = JSON.parse(await readFile(sessionJsonPath, 'utf-8'));
        notifySessionId = safeString(sessionData && sessionData.session_id ? sessionData.session_id : '');
      } catch { /* no session file */ }

      if (notifySessionId) {
        await notifyLifecycle('session-idle', {
          sessionId: notifySessionId,
          projectPath: cwd,
        });
        try {
          const { buildNativeHookEvent } = await import('../dist/hooks/extensibility/events.js');
          const { dispatchHookEvent } = await import('../dist/hooks/extensibility/dispatcher.js');
          const event = buildNativeHookEvent('session-idle', {
            project_path: cwd,
            reason: 'post_turn_idle_notification',
          }, {
            session_id: notifySessionId,
            thread_id: safeString(payload['thread-id'] || payload.thread_id || ''),
            turn_id: safeString(payload['turn-id'] || payload.turn_id || ''),
            mode: safeString(payload.mode || ''),
          });
          await dispatchHookEvent(event, { cwd });
        } catch {
          // Non-fatal
        }
      }
    } catch {
      // Non-fatal: notification module may not be built or config may not exist
    }
  }

  // 8.5. Skill activation tracking: update skill-active-state.json when a keyword is detected.
  try {
    const { recordSkillActivation } = await import('../dist/hooks/keyword-detector.js');
    const inputMessages = normalizeInputMessages(payload);
    const latestUserInput = safeString(inputMessages.length > 0 ? inputMessages[inputMessages.length - 1] : '');
    if (latestUserInput) {
      await recordSkillActivation({
        stateDir,
        text: latestUserInput,
        sessionId: payloadSessionId,
        threadId: safeString(payload['thread-id'] || payload.thread_id || ''),
        turnId: safeString(payload['turn-id'] || payload.turn_id || ''),
      });
    }
  } catch {
    // Non-fatal: keyword detector module may not be built yet
  }

  // 9. Auto-nudge: detect Codex stall patterns and automatically send a continuation prompt.
  //    Works for both leader and worker contexts.
  try {
    await maybeAutoNudge({ cwd, stateDir, logsDir, payload });
  } catch {
    // Non-critical
  }

  // 10. Code simplifier: delegate recently modified files for simplification.
  //     Opt-in via ~/.omx/config.json: { "codeSimplifier": { "enabled": true } }
  if (!isTeamWorker) {
    try {
      const { processCodeSimplifier } = await import('../dist/hooks/code-simplifier/index.js');
      const csResult = processCodeSimplifier(cwd, stateDir);
      if (csResult.triggered) {
        const csPaneId = await resolveNudgePaneTarget(stateDir);
        if (csPaneId) {
          const csText = `${csResult.message} ${DEFAULT_MARKER}`;
          const { runProcess } = await import('./notify-hook/process-runner.js');
          await runProcess('tmux', ['send-keys', '-t', csPaneId, '-l', csText], 3000);
          await new Promise(r => setTimeout(r, 100));
          await runProcess('tmux', ['send-keys', '-t', csPaneId, 'C-m'], 3000);
          await new Promise(r => setTimeout(r, 100));
          await runProcess('tmux', ['send-keys', '-t', csPaneId, 'C-m'], 3000);

          const { logTmuxHookEvent } = await import('./notify-hook/log.js');
          await logTmuxHookEvent(logsDir, {
            timestamp: new Date().toISOString(),
            type: 'code_simplifier_triggered',
            pane_id: csPaneId,
            file_count: csResult.message.split('\n').filter(l => l.trimStart().startsWith('- ')).length,
          });
        }
      }
    } catch {
      // Non-critical: code-simplifier module may not be built yet
    }
  }
}

main().catch(() => process.exit(0));
