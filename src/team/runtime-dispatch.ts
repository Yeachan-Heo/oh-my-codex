/**
 * Message dispatch, mailbox, and inbox routing.
 *
 * Handles worker→leader messages, broadcast messaging, mailbox delivery,
 * inbox instruction dispatching, and the hook-based dispatch pipeline.
 */
import { sanitizeTeamName, isTmuxAvailable, sendToWorker, sendToWorkerStdin, notifyLeaderMailboxAsync } from './tmux-session.js';
import {
  queueInboxInstruction,
  queueDirectMailboxMessage,
  queueBroadcastMailboxMessage,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateMailboxTriggerMessage,
  generateLeaderMailboxTriggerMessage,
} from './worker-bootstrap.js';
import {
  type TeamConfig,
  teamReadConfig as readTeamConfig,
  teamReadManifest as readTeamManifestV2,
  teamMarkMessageNotified as markMessageNotified,
  teamListMailbox as listMailboxMessages,
  teamEnqueueDispatchRequest as enqueueDispatchRequest,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  teamReadDispatchRequest as readDispatchRequest,
  type TeamPolicy,
  teamNormalizePolicy as normalizeTeamPolicy,
} from './team-ops.js';
import type { TeamSnapshot, WorkerInfo, WorkerHeartbeat, WorkerStatus } from './team-ops.js';
import type { TeamTask } from './team-ops.js';
import type { TeamWorkerCli } from './tmux-session.js';
import type { TeamMonitorSnapshotState } from './team-ops.js';
import { appendTeamEvent, teamAppendEvent as _appendTeamEvent } from './team-ops.js';
import { readModeState, updateModeState } from '../modes/base.js';
import { getPromptWorkerHandle } from './runtime-prompt-worker.js';

// ── Worker startup evidence type (shared with runtime-prompt-worker) ──

type WorkerStartupEvidence = 'task_claim' | 'worker_progress' | 'leader_ack' | 'none';

// ── Forward refs (injected by runtime.ts to avoid circular deps) ──

let _resolveInstructionStateRoot: ((path?: string | null) => string | undefined) | undefined;
let _waitForWorkerStartupEvidence: ((params: { teamName: string; workerName: string; workerCli: TeamWorkerCli; cwd: string }) => Promise<WorkerStartupEvidence>) | undefined;

export function injectResolveInstructionStateRoot(fn: typeof _resolveInstructionStateRoot): void {
  _resolveInstructionStateRoot = fn;
}

export function injectWaitForWorkerStartupEvidence(fn: typeof _waitForWorkerStartupEvidence): void {
  _waitForWorkerStartupEvidence = fn;
}

// ── Dispatch policy ──

export function resolveDispatchPolicy(
  manifestPolicy: TeamPolicy | null | undefined,
  workerLaunchMode: TeamConfig['worker_launch_mode'],
): TeamPolicy {
  return normalizeTeamPolicy(manifestPolicy, {
    display_mode: manifestPolicy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
    worker_launch_mode: workerLaunchMode,
  });
}

// ── Worker outcome notification ──

export async function notifyWorkerOutcome(config: TeamConfig, workerIndex: number, message: string, workerPaneId?: string): Promise<DispatchOutcome> {
  const worker = config.workers.find((candidate) => candidate.index === workerIndex);
  if (!worker) return { ok: false, transport: 'none', reason: 'worker_not_found' };

  if (config.worker_launch_mode === 'prompt') {
    const handle = getPromptWorkerHandle(config.name, worker.name);
    if (!handle) return { ok: false, transport: 'prompt_stdin', reason: 'prompt_worker_handle_missing' };
    try {
      sendToWorkerStdin(handle.child.stdin, message);
      return { ok: true, transport: 'prompt_stdin', reason: 'prompt_stdin_sent' };
    } catch (error) {
      return {
        ok: false,
        transport: 'prompt_stdin',
        reason: `prompt_stdin_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!config.tmux_session || !isTmuxAvailable()) {
    return { ok: false, transport: 'tmux_send_keys', reason: 'tmux_unavailable' };
  }
  try {
    await sendToWorker(config.tmux_session, workerIndex, message, workerPaneId, worker.worker_cli);
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Leader pane missing mailbox outcome check ──

export function isLeaderPaneMissingMailboxPersistedOutcome(params: {
  workerName: string;
  paneId?: string;
  outcome: DispatchOutcome;
}): boolean {
  const { workerName, paneId, outcome } = params;
  return workerName === 'leader-fixed'
    && !paneId
    && outcome.ok
    && outcome.reason === 'leader_pane_missing_mailbox_persisted';
}

export async function markDispatchRequestLeaderPaneMissingDeferred(params: {
  teamName: string;
  requestId: string;
  messageId?: string;
  cwd: string;
}): Promise<void> {
  const { teamName, requestId, messageId, cwd } = params;
  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (!current) return;
  if (current.status !== 'pending') return;

  await transitionDispatchRequest(
    teamName,
    requestId,
    current.status,
    current.status,
    {
      message_id: messageId ?? current.message_id,
      last_reason: 'leader_pane_missing_deferred',
    },
    cwd,
  ).catch(() => {});
}

// ── Critical inbox dispatch ──

export async function dispatchCriticalInboxInstruction(params: {
  teamName: string;
  config: TeamConfig;
  workerName: string;
  workerIndex: number;
  paneId?: string;
  workerCli?: TeamWorkerCli;
  inbox: string;
  triggerMessage: string;
  cwd: string;
  dispatchPolicy: TeamPolicy;
  inboxCorrelationKey: string;
  requireWorkerStartupEvidence?: boolean;
}): Promise<DispatchOutcome> {
  const {
    teamName,
    config,
    workerName,
    workerIndex,
    paneId,
    workerCli,
    inbox,
    triggerMessage,
    cwd,
    dispatchPolicy,
    inboxCorrelationKey,
    requireWorkerStartupEvidence,
  } = params;

  if (config.worker_launch_mode === 'prompt') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'prompt_stdin',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  if (dispatchPolicy.dispatch_mode === 'transport_direct') {
    return await queueInboxInstruction({
      teamName,
      workerName,
      workerIndex,
      paneId,
      inbox,
      triggerMessage,
      cwd,
      transportPreference: 'transport_direct',
      fallbackAllowed: false,
      inboxCorrelationKey,
      notify: (_target, message) => notifyWorkerOutcome(config, workerIndex, message, paneId),
    });
  }

  const queued = await queueInboxInstruction({
    teamName,
    workerName,
    workerIndex,
    paneId,
    inbox,
    triggerMessage,
    cwd,
    transportPreference: 'hook_preferred_with_fallback',
    fallbackAllowed: true,
    inboxCorrelationKey,
    notify: () => ({ ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }),
  });

  if (!queued.request_id) return { ...queued, ok: false, reason: 'dispatch_request_missing_id' };

  const receipt = await waitForDispatchReceipt(teamName, queued.request_id, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt?.status === 'delivered') {
    return { ok: true, transport: 'hook', reason: 'hook_receipt_delivered', request_id: queued.request_id };
  }
  const requiresObservedStartupEvidence = requireWorkerStartupEvidence === true
    && (workerCli === 'claude' || workerCli === 'codex');
  let startupEvidence: WorkerStartupEvidence = 'none';
  if (receipt?.status === 'notified') {
    if (!requiresObservedStartupEvidence) {
      return { ok: true, transport: 'hook', reason: 'hook_receipt_notified', request_id: queued.request_id };
    }
    if (_waitForWorkerStartupEvidence) {
      startupEvidence = await _waitForWorkerStartupEvidence({
        teamName,
        workerName,
        workerCli: workerCli ?? 'codex',
        cwd,
      });
    }
    if (startupEvidence !== 'none') {
      return {
        ok: true,
        transport: 'hook',
        reason: `hook_receipt_notified_with_${startupEvidence}`,
        request_id: queued.request_id,
      };
    }
  }
  if (receipt?.status === 'failed') {
    const fallback = await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
    if (fallback.ok) {
      await markDispatchRequestNotified(
        teamName,
        queued.request_id,
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`, failed_at: undefined },
        cwd,
      ).catch(() => null);
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: queued.request_id,
      };
    }
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      receipt.status,
      'failed',
      { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const fallback = await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId);
  const startupFallbackLabel = receipt?.status === 'notified' && requiresObservedStartupEvidence
    ? `${workerCli}_startup_no_evidence`
    : null;
  const fallbackFailureReason = startupFallbackLabel
    ? `${startupFallbackLabel}_fallback_failed:${fallback.reason}`
    : `fallback_attempted_but_unconfirmed:${fallback.reason}`;
  if (fallback.ok) {
    const marked = await markDispatchRequestNotified(
      teamName,
      queued.request_id,
      { last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        queued.request_id,
        'failed',
        'failed',
        { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: startupFallbackLabel
        ? `${startupFallbackLabel}_fallback_confirmed:${fallback.reason}`
        : `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: queued.request_id,
    };
  }

  const current = await readDispatchRequest(teamName, queued.request_id, cwd);
  if (current && current.status !== 'failed') {
    await transitionDispatchRequest(
      teamName,
      queued.request_id,
      current.status,
      'failed',
      { last_reason: fallbackFailureReason },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: fallbackFailureReason,
    request_id: queued.request_id,
  };
}

// ── Hook-preferred mailbox dispatch finalization ──

export async function finalizeHookPreferredMailboxDispatch(params: {
  teamName: string;
  requestId: string;
  workerName: string;
  workerIndex?: number;
  paneId?: string;
  messageId: string;
  triggerMessage: string;
  config: TeamConfig;
  dispatchPolicy: TeamPolicy;
  cwd: string;
  fallbackNotify?: () => DispatchOutcome | Promise<DispatchOutcome>;
}): Promise<DispatchOutcome> {
  const {
    teamName,
    requestId,
    workerName,
    workerIndex,
    paneId,
    messageId,
    triggerMessage,
    config,
    dispatchPolicy,
    cwd,
    fallbackNotify,
  } = params;
  const receipt = await waitForDispatchReceipt(teamName, requestId, cwd, {
    timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
    pollMs: 50,
  });
  if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    return { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: requestId, message_id: messageId };
  }

  const fallback: DispatchOutcome = fallbackNotify
    ? await fallbackNotify()
    : (typeof workerIndex === 'number'
      ? await notifyWorkerOutcome(config, workerIndex, triggerMessage, paneId)
      : { ok: false, transport: 'none', reason: 'missing_worker_index' });
  if (receipt?.status === 'failed') {
    if (fallback.ok) {
      await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
      await markDispatchRequestNotified(
        teamName,
        requestId,
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`, failed_at: undefined },
        cwd,
      ).catch(() => null);
      return {
        ok: true,
        transport: fallback.transport,
        reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
        request_id: requestId,
        message_id: messageId,
      };
    }
    await transitionDispatchRequest(
      teamName,
      requestId,
      'failed',
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
    return {
      ok: false,
      transport: fallback.transport,
      reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  if (fallback.ok) {
    if (isLeaderPaneMissingMailboxPersistedOutcome({ workerName, paneId, outcome: fallback })) {
      await markDispatchRequestLeaderPaneMissingDeferred({
        teamName,
        requestId,
        messageId,
        cwd,
      });
      return {
        ok: true,
        transport: fallback.transport,
        reason: 'leader_pane_missing_mailbox_persisted',
        request_id: requestId,
        message_id: messageId,
      };
    }

    await markMessageNotified(teamName, workerName, messageId, cwd).catch(() => false);
    const marked = await markDispatchRequestNotified(
      teamName,
      requestId,
      { message_id: messageId, last_reason: `fallback_confirmed:${fallback.reason}` },
      cwd,
    );
    if (!marked) {
      await transitionDispatchRequest(
        teamName,
        requestId,
        'failed',
        'failed',
        { message_id: messageId, last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
        cwd,
      ).catch(() => {});
    }
    return {
      ok: true,
      transport: fallback.transport,
      reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
      request_id: requestId,
      message_id: messageId,
    };
  }

  const current = await readDispatchRequest(teamName, requestId, cwd);
  if (current) {
    await transitionDispatchRequest(
      teamName,
      requestId,
      current.status,
      'failed',
      { message_id: messageId, last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
      cwd,
    ).catch(() => {});
  }
  return {
    ok: false,
    transport: fallback.transport,
    reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
    request_id: requestId,
    message_id: messageId,
  };
}

// ── Leader notification ──

export async function notifyLeaderAsync(config: TeamConfig, message: string, cwd: string): Promise<DispatchOutcome> {
  const { notifyLeaderMailboxAsync } = await import('./tmux-session.js');
  const persisted = await notifyLeaderMailboxAsync(config.name, 'system', message, cwd);
  if (!persisted) {
    return { ok: false, transport: 'mailbox', reason: 'leader_mailbox_notify_failed' };
  }
  if (!config.leader_pane_id) {
    return { ok: true, transport: 'mailbox', reason: 'leader_pane_missing_mailbox_persisted' };
  }
  return { ok: true, transport: 'mailbox', reason: 'leader_mailbox_notified' };
}

// ── Mailbox delivery ──

export async function deliverPendingMailboxMessages(
  teamName: string,
  config: TeamConfig,
  workers: TeamSnapshot['workers'],
  previousNotifications: Record<string, string>,
  dispatchPolicy: TeamPolicy,
  cwd: string,
): Promise<Record<string, string>> {
  const nextNotifications: Record<string, string> = {};
  const pendingIdsAcrossTeam = new Set<string>();

  for (const worker of workers) {
    const workerInfo = config.workers.find((w) => w.name === worker.name);
    if (!workerInfo) continue;
    const mailbox = await listMailboxMessages(teamName, worker.name, cwd);
    const pending = mailbox.filter((m) => !m.delivered_at);
    if (pending.length === 0) continue;

    const pendingIds = pending.map((m) => m.message_id);
    for (const id of pendingIds) pendingIdsAcrossTeam.add(id);

    // Preserve already-tracked notification timestamps in the next snapshot.
    for (const msg of pending) {
      nextNotifications[msg.message_id] = msg.notified_at || previousNotifications[msg.message_id] || '';
    }

    const unnotified = pending.filter(
      (m) => !m.notified_at && !previousNotifications[m.message_id],
    );
    if (unnotified.length === 0) continue;
    if (!worker.alive) continue;

    for (const msg of unnotified) {
      const triggerMessage = generateMailboxTriggerMessage(
        worker.name,
        teamName,
        1,
        _resolveInstructionStateRoot?.(workerInfo.worktree_path),
      );
      const transportPreference = config.worker_launch_mode === 'prompt'
        ? 'prompt_stdin'
        : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
      const fallbackAllowed = transportPreference === 'hook_preferred_with_fallback';
      const queued = await enqueueDispatchRequest(
        teamName,
        {
          kind: 'mailbox',
          to_worker: worker.name,
          worker_index: workerInfo.index,
          pane_id: workerInfo.pane_id,
          trigger_message: triggerMessage,
          message_id: msg.message_id,
          transport_preference: transportPreference,
          fallback_allowed: fallbackAllowed,
        },
        cwd,
      );

      let outcome: DispatchOutcome;
      if (transportPreference === 'hook_preferred_with_fallback') {
        outcome = await finalizeHookPreferredMailboxDispatch({
          teamName,
          requestId: queued.request.request_id,
          workerName: worker.name,
          workerIndex: workerInfo.index,
          paneId: workerInfo.pane_id,
          messageId: msg.message_id,
          triggerMessage,
          config,
          dispatchPolicy,
          cwd,
        });
      } else {
        const direct = await notifyWorkerOutcome(config, workerInfo.index, triggerMessage, workerInfo.pane_id);
        outcome = { ...direct, request_id: queued.request.request_id, message_id: msg.message_id };
        if (outcome.ok) {
          await markMessageNotified(teamName, worker.name, msg.message_id, cwd).catch(() => false);
          await markDispatchRequestNotified(
            teamName,
            queued.request.request_id,
            { message_id: msg.message_id, last_reason: outcome.reason },
            cwd,
          ).catch(() => null);
        }
      }

      if (outcome.ok) {
        nextNotifications[msg.message_id] = new Date().toISOString();
      }
    }
  }

  const pruned: Record<string, string> = {};
  for (const [messageId, ts] of Object.entries(nextNotifications)) {
    if (pendingIdsAcrossTeam.has(messageId) && ts) pruned[messageId] = ts;
  }
  return pruned;
}

// ── Worker-to-worker messaging ──

export async function sendWorkerMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string,
): Promise<DispatchOutcome> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);

  if (toWorker === 'leader-fixed') {
    const leaderTriggerMessage = generateLeaderMailboxTriggerMessage(sanitized, fromWorker);
    const leaderTransportPreference = dispatchPolicy.dispatch_mode === 'transport_direct'
      ? 'transport_direct'
      : 'hook_preferred_with_fallback';
    const outcome = await queueDirectMailboxMessage({
      teamName: sanitized,
      fromWorker,
      toWorker,
      toPaneId: config.leader_pane_id ?? undefined,
      body,
      triggerMessage: leaderTriggerMessage,
      cwd,
      transportPreference: leaderTransportPreference,
      fallbackAllowed: leaderTransportPreference === 'hook_preferred_with_fallback',
      notify: async (_target, message) => (
        leaderTransportPreference === 'hook_preferred_with_fallback'
          ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
          : await notifyLeaderAsync(config, message, cwd)
      ),
    });
    let finalOutcome = outcome;
    const mailboxAlreadyNotified = outcome.ok && outcome.reason === 'existing_message_already_notified';
    if (!mailboxAlreadyNotified && leaderTransportPreference === 'hook_preferred_with_fallback' && !config.leader_pane_id) {
      if (outcome.request_id) {
        await markDispatchRequestLeaderPaneMissingDeferred({
          teamName: sanitized,
          requestId: outcome.request_id,
          messageId: outcome.message_id,
          cwd,
        });
      }
      finalOutcome = {
        ...outcome,
        ok: true,
        transport: 'mailbox',
        reason: 'leader_pane_missing_mailbox_persisted',
      };
    }
    const canLeaderFallbackDirectly = Boolean(config.leader_pane_id) && isTmuxAvailable();
    if (!mailboxAlreadyNotified && leaderTransportPreference === 'hook_preferred_with_fallback' && canLeaderFallbackDirectly) {
      if (!outcome.request_id || !outcome.message_id) {
        throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
      }
      finalOutcome = await finalizeHookPreferredMailboxDispatch({
        teamName: sanitized,
        requestId: outcome.request_id,
        workerName: 'leader-fixed',
        paneId: config.leader_pane_id ?? undefined,
        messageId: outcome.message_id,
        triggerMessage: leaderTriggerMessage,
        config,
        dispatchPolicy,
        cwd,
        fallbackNotify: async () => await notifyLeaderAsync(config, leaderTriggerMessage, cwd),
      });
    }
    if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
    return finalOutcome;
  }

  const recipient = config.workers.find((w) => w.name === toWorker);
  if (!recipient) throw new Error(`Worker ${toWorker} not found in team`);

  const triggerMessage = generateMailboxTriggerMessage(
    toWorker,
    sanitized,
    1,
    _resolveInstructionStateRoot?.(recipient.worktree_path),
  );
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');
  const outcome = await queueDirectMailboxMessage({
    teamName: sanitized,
    fromWorker,
    toWorker,
    toWorkerIndex: recipient.index,
    toPaneId: recipient.pane_id,
    body,
    triggerMessage,
    cwd,
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: async (_target, message) => (
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : await notifyWorkerOutcome(config, recipient.index, message, recipient.pane_id)
    ),
  });
  let finalOutcome = outcome;
  const mailboxAlreadyNotified = outcome.ok && outcome.reason === 'existing_message_already_notified';
  if (!mailboxAlreadyNotified && transportPreference === 'hook_preferred_with_fallback') {
    if (!outcome.request_id || !outcome.message_id) {
      throw new Error('mailbox_notify_failed:dispatch_request_missing_id');
    }
    finalOutcome = await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: recipient.name,
      workerIndex: recipient.index,
      paneId: recipient.pane_id,
      messageId: outcome.message_id,
      triggerMessage,
      config,
      dispatchPolicy,
      cwd,
    });
  }
  if (!finalOutcome.ok) throw new Error(`mailbox_notify_failed:${finalOutcome.reason}`);
  return finalOutcome;
}

export async function broadcastWorkerMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string,
): Promise<void> {
  const sanitized = sanitizeTeamName(teamName);
  const config = await readTeamConfig(sanitized, cwd);
  if (!config) throw new Error(`Team ${sanitized} not found`);
  const manifest = await readTeamManifestV2(sanitized, cwd);
  const dispatchPolicy = resolveDispatchPolicy(manifest?.policy, config.worker_launch_mode);
  const transportPreference = config.worker_launch_mode === 'prompt'
    ? 'prompt_stdin'
    : (dispatchPolicy.dispatch_mode === 'transport_direct' ? 'transport_direct' : 'hook_preferred_with_fallback');

  const outcomes = await queueBroadcastMailboxMessage({
    teamName: sanitized,
    fromWorker,
    recipients: config.workers.map((w) => ({ workerName: w.name, workerIndex: w.index, paneId: w.pane_id })),
    body,
    cwd,
    triggerFor: (workerName) => generateMailboxTriggerMessage(
      workerName,
      sanitized,
      1,
      _resolveInstructionStateRoot?.(config.workers.find((worker) => worker.name === workerName)?.worktree_path),
    ),
    transportPreference,
    fallbackAllowed: transportPreference === 'hook_preferred_with_fallback',
    notify: async (target, message) =>
      transportPreference === 'hook_preferred_with_fallback'
        ? { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' }
        : (typeof target.workerIndex === 'number'
        ? await notifyWorkerOutcome(config, target.workerIndex, message, target.paneId)
        : { ok: false, transport: 'none', reason: 'missing_worker_index' }),
  });
  const finalizedOutcomes: DispatchOutcome[] = [];
  for (const outcome of outcomes) {
    if (transportPreference !== 'hook_preferred_with_fallback') {
      finalizedOutcomes.push(outcome);
      continue;
    }
    if (!outcome.request_id || !outcome.message_id) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'dispatch_request_missing_id' });
      continue;
    }
    const target = outcome.to_worker
      ? (config.workers.find((w) => w.name === outcome.to_worker) ?? null)
      : null;
    if (!target) {
      finalizedOutcomes.push({ ...outcome, ok: false, reason: 'missing_worker_index' });
      continue;
    }
    finalizedOutcomes.push(await finalizeHookPreferredMailboxDispatch({
      teamName: sanitized,
      requestId: outcome.request_id,
      workerName: target.name,
      workerIndex: target.index,
      paneId: target.pane_id,
      messageId: outcome.message_id,
      triggerMessage: generateMailboxTriggerMessage(
        target.name,
        sanitized,
        1,
        _resolveInstructionStateRoot?.(target.worktree_path),
      ),
      config,
      dispatchPolicy,
      cwd,
    }));
  }
  const results = transportPreference === 'hook_preferred_with_fallback' ? finalizedOutcomes : outcomes;
  if (results.some((result) => !result.ok)) {
    const firstFailure = results.find((result) => !result.ok);
    throw new Error(`mailbox_notify_failed:${firstFailure?.reason ?? 'unknown'}`);
  }
}
