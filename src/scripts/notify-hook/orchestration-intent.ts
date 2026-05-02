// @ts-nocheck

import { safeString } from './utils.js';

export const TEAM_ORCHESTRATION_INTENTS = [
  'followup-reuse',
  'followup-relaunch',
  'stalled-unblock',
  'done-review-or-shutdown',
  'pending-mailbox-review',
] as const;

export const ORCHESTRATION_INTENT_TAG_PREFIX = '[OMX_INTENT:';

const ORCHESTRATION_INTENT_TAG_RE = /\s*\[OMX_INTENT:[a-z0-9-]+\]/gi;

export function buildOrchestrationIntentTag(intent) {
  const normalizedIntent = safeString(intent).trim();
  return normalizedIntent ? `${ORCHESTRATION_INTENT_TAG_PREFIX}${normalizedIntent}]` : '';
}

export function appendOrchestrationIntentTag(text, intent) {
  const normalizedText = safeString(text).trim();
  const tag = buildOrchestrationIntentTag(intent);
  if (!tag) return normalizedText;
  return normalizedText ? `${normalizedText} ${tag}` : tag;
}

export function stripOrchestrationIntentTags(text) {
  return safeString(text).replace(ORCHESTRATION_INTENT_TAG_RE, '');
}

export function classifyLeaderActionState({
  allWorkersIdle = false,
  workerPanesAlive = false,
  taskCounts = {},
} = {}) {
  const pending = Number.isFinite(taskCounts.pending) ? taskCounts.pending : 0;
  const blocked = Number.isFinite(taskCounts.blocked) ? taskCounts.blocked : 0;
  const inProgress = Number.isFinite(taskCounts.in_progress) ? taskCounts.in_progress : 0;
  const tasksComplete = pending === 0 && blocked === 0 && inProgress === 0;
  const pendingFollowUpTasks = allWorkersIdle && pending > 0 && blocked === 0 && inProgress === 0;
  const blockedWaitingOnLeader = allWorkersIdle && blocked > 0 && pending === 0 && inProgress === 0;
  const terminalWaitingOnLeader = allWorkersIdle && tasksComplete && workerPanesAlive;

  if (terminalWaitingOnLeader) return 'done_waiting_on_leader';
  if (blockedWaitingOnLeader) return 'stuck_waiting_on_leader';
  if (pendingFollowUpTasks) return 'still_actionable';
  return 'still_actionable';
}

export function resolveAllWorkersIdleIntent(leaderActionState = 'still_actionable') {
  if (leaderActionState === 'done_waiting_on_leader') return 'done-review-or-shutdown';
  if (leaderActionState === 'stuck_waiting_on_leader') return 'stalled-unblock';
  return 'followup-reuse';
}

export function resolveLeaderNudgeIntent({ nudgeReason = '', leaderActionState = 'still_actionable' } = {}) {
  switch (safeString(nudgeReason).trim()) {
    case 'new_mailbox_message':
    case 'stale_leader_with_messages':
      return 'pending-mailbox-review';
    case 'ack_without_start_evidence':
      return 'followup-relaunch';
    case 'stuck_waiting_on_leader':
    case 'stale_leader_panes_alive':
      return 'stalled-unblock';
    case 'done_waiting_on_leader':
      return 'done-review-or-shutdown';
    case 'all_workers_idle':
    default:
      return resolveAllWorkersIdleIntent(leaderActionState);
  }
}

export function resolveWorkerIdleIntent(currentState = 'idle') {
  return safeString(currentState).trim() === 'done'
    ? 'done-review-or-shutdown'
    : 'followup-reuse';
}
