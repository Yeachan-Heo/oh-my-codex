import { clearDeepInterviewQuestionObligation } from '../question/deep-interview.js';
import { inferRunOutcome, inferTerminalLifecycleOutcome, isTerminalRunOutcome } from '../runtime/run-outcome.js';

const TERMINAL_PHASES = new Set([
  'complete',
  'completed',
  'cancelled',
  'canceled',
  'failed',
  'blocked',
  'cleared',
]);

const LOCK_KEYS = new Set([
  'input_lock',
  'inputLock',
  'approval_lock',
  'approvalLock',
  'approval_locks',
  'approvalLocks',
]);

const POSSIBLE_APPROVAL_MARKER_KEYS = new Set([
  'approval',
  'approval_request',
  'approvalRequest',
]);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalState(state: Record<string, unknown>): boolean {
  const phase = stringValue(state.current_phase ?? state.currentPhase).toLowerCase();
  if (state.active === false && TERMINAL_PHASES.has(phase)) return true;
  if (state.active === false && stringValue(state.completed_at)) return true;
  if (inferTerminalLifecycleOutcome(state, { includeQuestionEnforcement: false }) !== undefined) return true;
  return isTerminalRunOutcome(inferRunOutcome(state));
}

function isActiveOrPendingLock(record: Record<string, unknown>): boolean {
  const status = stringValue(record.status).toLowerCase();
  const phase = stringValue(record.phase).toLowerCase();
  return record.active === true
    || record.locked === true
    || record.pending === true
    || ['active', 'pending', 'waiting', 'waiting_for_user', 'requested', 'required'].includes(status)
    || ['active', 'pending', 'waiting', 'waiting_for_user', 'requested', 'required'].includes(phase);
}

function releaseLockValue(value: unknown, releasedAt: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const released = value.map((item) => {
      const result = releaseLockValue(item, releasedAt);
      changed ||= result.changed;
      return result.value;
    });
    return { value: released, changed };
  }

  if (!isRecord(value)) return { value, changed: false };

  if (!isActiveOrPendingLock(value)) return { value, changed: false };

  return {
    value: {
      ...value,
      active: false,
      locked: false,
      pending: false,
      status: 'released',
      released_at: stringValue(value.released_at) || releasedAt,
      release_reason: stringValue(value.release_reason) || 'terminal_state_normalization',
    },
    changed: true,
  };
}

function releaseTerminalLocksOnRecord(record: Record<string, unknown>, releasedAt: string): boolean {
  let changed = false;
  for (const key of Object.keys(record)) {
    if (!LOCK_KEYS.has(key) && !POSSIBLE_APPROVAL_MARKER_KEYS.has(key)) continue;
    const result = releaseLockValue(record[key], releasedAt);
    if (!result.changed) continue;
    record[key] = result.value;
    changed = true;
  }
  return changed;
}

export function normalizeTerminalWorkflowState(
  state: Record<string, unknown>,
  options: { mode?: string; nowIso?: string } = {},
): { state: Record<string, unknown>; changed: boolean } {
  if (!isTerminalState(state)) return { state, changed: false };

  const next: Record<string, unknown> = { ...state };
  const completedAt = stringValue(next.completed_at) || options.nowIso || new Date().toISOString();
  let changed = false;

  if (next.active !== false) {
    next.active = false;
    changed = true;
  }
  if (!stringValue(next.completed_at)) {
    next.completed_at = completedAt;
    changed = true;
  }

  if (releaseTerminalLocksOnRecord(next, completedAt)) changed = true;

  if (isRecord(next.state)) {
    const nested = { ...next.state };
    if (releaseTerminalLocksOnRecord(nested, completedAt)) {
      next.state = nested;
      changed = true;
    }
  }

  if (options.mode === 'deep-interview' && isRecord(next.question_enforcement)) {
    const status = stringValue(next.question_enforcement.status).toLowerCase();
    if (status === 'pending') {
      const phase = stringValue(next.current_phase).toLowerCase();
      const clearReason = phase === 'completed' || phase === 'complete' ? 'handoff' : 'abort';
      const cleared = clearDeepInterviewQuestionObligation(
        next.question_enforcement as unknown as Parameters<typeof clearDeepInterviewQuestionObligation>[0],
        clearReason,
        new Date(completedAt),
      );
      if (cleared) {
        next.question_enforcement = cleared;
        changed = true;
      }
    }
  }

  return { state: next, changed };
}
