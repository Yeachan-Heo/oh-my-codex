import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type CodexGoalSnapshotStatus = 'active' | 'complete' | 'cancelled' | 'failed' | 'unknown';

export interface CodexGoalSnapshot {
  available: boolean;
  objective?: string;
  status?: CodexGoalSnapshotStatus;
  tokenBudget?: number;
  remainingTokens?: number | null;
  unavailableReason?: 'db_schema_context_error' | 'tool_error';
  errorMessage?: string;
  raw: unknown;
}

export interface CodexGoalReconciliation {
  ok: boolean;
  snapshot: CodexGoalSnapshot;
  warnings: string[];
  errors: string[];
}

export interface ReconcileCodexGoalOptions {
  expectedObjective: string;
  acceptedObjectives?: readonly string[];
  allowedStatuses?: readonly CodexGoalSnapshotStatus[];
  requireSnapshot?: boolean;
  requireComplete?: boolean;
}

export class CodexGoalSnapshotError extends Error {}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeStatus(value: unknown): CodexGoalSnapshotStatus {
  const status = safeString(value).toLowerCase();
  if (status === 'complete' || status === 'completed' || status === 'done') return 'complete';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'failed' || status === 'failure') return 'failed';
  if (status === 'active' || status === 'in_progress' || status === 'pending' || status === 'running') return 'active';
  return 'unknown';
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function extractErrorMessage(value: unknown): string {
  const root = safeObject(value);
  const candidates = [
    root.error,
    root.message,
    root.errorMessage,
    root.stderr,
    safeObject(root.error).message,
    safeObject(root.error).error,
  ];
  return candidates.map(safeString).find(Boolean) ?? '';
}

export function isCodexGoalDbSchemaContextError(message: string | undefined): boolean {
  const normalized = safeString(message).toLowerCase();
  return Boolean(normalized)
    && (
      normalized.includes('no such table: thread_goals')
      || (normalized.includes('thread_goals') && /\b(?:sqlite|sql|schema|table|database|db)\b/.test(normalized))
      || /\b(?:codex goal|goal)\b.*\b(?:db|database|schema|context)\b.*\b(?:unavailable|missing|failed|error)\b/.test(normalized)
    );
}

export function parseCodexGoalSnapshot(value: unknown): CodexGoalSnapshot {
  const root = safeObject(value);
  const hasGoalProperty = Object.hasOwn(root, 'goal');
  const goalValue = hasGoalProperty ? root.goal : value;
  const errorMessage = hasGoalProperty && goalValue !== null && goalValue !== undefined && goalValue !== false
    ? ''
    : extractErrorMessage(value);
  if (!hasGoalProperty && errorMessage) {
    return {
      available: false,
      unavailableReason: isCodexGoalDbSchemaContextError(errorMessage) ? 'db_schema_context_error' : 'tool_error',
      errorMessage,
      raw: value,
    };
  }
  if (goalValue === null || goalValue === undefined || goalValue === false) {
    if (errorMessage) {
      return {
        available: false,
        unavailableReason: isCodexGoalDbSchemaContextError(errorMessage) ? 'db_schema_context_error' : 'tool_error',
        errorMessage,
        raw: value,
      };
    }
    return { available: false, raw: value };
  }

  const goal = safeObject(goalValue);
  const objective = safeString(
    goal.objective
    ?? goal.goal
    ?? goal.description
    ?? root.objective,
  );
  const status = normalizeStatus(goal.status ?? root.status);
  const tokenBudget = safeNumber(
    goal.token_budget
    ?? goal.tokenBudget
    ?? root.token_budget
    ?? root.tokenBudget,
  );
  const remainingTokens = safeNumber(root.remainingTokens ?? root.remaining_tokens);

  return {
    available: Boolean(objective || status !== 'unknown'),
    ...(objective ? { objective } : {}),
    status,
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    remainingTokens: remainingTokens ?? null,
    raw: value,
  };
}

export async function readCodexGoalSnapshotInput(raw: string | undefined, cwd = process.cwd()): Promise<CodexGoalSnapshot | null> {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  try {
    return parseCodexGoalSnapshot(JSON.parse(trimmed));
  } catch {
    const path = resolve(cwd, trimmed);
    if (!existsSync(path)) {
      throw new CodexGoalSnapshotError(`Codex goal snapshot is neither valid JSON nor a readable path: ${trimmed}`);
    }
    try {
      return parseCodexGoalSnapshot(JSON.parse(await readFile(path, 'utf-8')));
    } catch (error) {
      throw new CodexGoalSnapshotError(`Codex goal snapshot path does not contain valid JSON: ${trimmed}${error instanceof Error ? ` (${error.message})` : ''}`);
    }
  }
}

export function reconcileCodexGoalSnapshot(
  snapshot: CodexGoalSnapshot | null | undefined,
  options: ReconcileCodexGoalOptions,
): CodexGoalReconciliation {
  const effectiveSnapshot = snapshot ?? { available: false, raw: null };
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!effectiveSnapshot.available) {
    const detail = effectiveSnapshot.errorMessage ? ` Last get_goal error: ${effectiveSnapshot.errorMessage}.` : '';
    const diagnostic = effectiveSnapshot.unavailableReason === 'db_schema_context_error'
      ? ' Codex goal state is unavailable due to a DB/schema/context error; this is distinct from a normal missing or incomplete goal.'
      : '';
    const message = `Codex goal snapshot is absent or reports no active goal; call get_goal and pass its JSON with --codex-goal-json.${diagnostic}${detail}`;
    if (options.requireSnapshot) errors.push(message);
    else warnings.push(message);
    return { ok: errors.length === 0, snapshot: effectiveSnapshot, warnings, errors };
  }

  const expected = normalizeObjective(options.expectedObjective);
  const accepted = new Set([
    expected,
    ...(options.acceptedObjectives ?? []).map((objective) => normalizeObjective(objective)),
  ].filter(Boolean));
  const actual = normalizeObjective(effectiveSnapshot.objective ?? '');
  if (!actual) {
    errors.push('Codex goal snapshot is missing objective text.');
  } else if (!accepted.has(actual)) {
    errors.push(`Codex goal objective mismatch: expected "${expected}", got "${actual}".`);
  }

  const allowed = options.allowedStatuses ?? (options.requireComplete ? ['complete'] : ['active', 'complete']);
  const actualStatus = effectiveSnapshot.status ?? 'unknown';
  if (!allowed.includes(actualStatus)) {
    errors.push(`Codex goal status mismatch: expected ${allowed.join(' or ')}, got ${actualStatus}.`);
  }
  if (options.requireComplete && actualStatus !== 'complete') {
    errors.push(`Codex goal is not complete; call update_goal({status: "complete"}) only after the objective is actually complete, then pass the fresh get_goal JSON.`);
  }

  return { ok: errors.length === 0, snapshot: effectiveSnapshot, warnings, errors };
}

export function formatCodexGoalReconciliation(reconciliation: CodexGoalReconciliation): string {
  const parts = [...reconciliation.errors, ...reconciliation.warnings];
  return parts.join(' ');
}

export function buildCodexGoalTerminalCleanupNotice(workflowLabel: string): string {
  return [
    `${workflowLabel}: Codex goal is complete and OMX durable workflow artifacts are complete.`,
    'Terminal next step for another goal in this same Codex thread/session: run /goal clear in the Codex UI before calling create_goal for the next OMX goal.',
    'OMX shell commands and hooks do not call /goal clear or hidden thread/goal/clear routes; if a future Codex tool surface exposes explicit clear/reset, use that tool instead.',
  ].join('\n');
}

export function buildCompletedCodexGoalRemediation(workflowLabel: string): string {
  return `${workflowLabel}: get_goal reports a completed Codex goal still attached to this thread. Run /goal clear in the Codex UI before starting another goal in this same thread/session; OMX did not and cannot clear hidden Codex goal state from shell/hooks.`;
}
