export const TERMINAL_RUN_OUTCOMES = [
  'finish',
  'blocked_on_user',
  'failed',
  'cancelled',
] as const;

export const NON_TERMINAL_RUN_OUTCOMES = [
  'progress',
  'continue',
] as const;

export const RUN_OUTCOMES = [
  ...NON_TERMINAL_RUN_OUTCOMES,
  ...TERMINAL_RUN_OUTCOMES,
] as const;

export const TERMINAL_LIFECYCLE_OUTCOMES = [
  'finished',
  'blocked',
  'failed',
  'userinterlude',
  'askuserQuestion',
] as const;

export type TerminalRunOutcome = (typeof TERMINAL_RUN_OUTCOMES)[number];
export type NonTerminalRunOutcome = (typeof NON_TERMINAL_RUN_OUTCOMES)[number];
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type TerminalLifecycleOutcome = (typeof TERMINAL_LIFECYCLE_OUTCOMES)[number];

const TERMINAL_RUN_OUTCOME_SET = new Set<string>(TERMINAL_RUN_OUTCOMES);
const NON_TERMINAL_RUN_OUTCOME_SET = new Set<string>(NON_TERMINAL_RUN_OUTCOMES);
const RUN_OUTCOME_SET = new Set<string>(RUN_OUTCOMES);
const TERMINAL_LIFECYCLE_OUTCOME_SET = new Set<string>(TERMINAL_LIFECYCLE_OUTCOMES);

const RUN_OUTCOME_ALIASES: Readonly<Record<string, RunOutcome>> = {
  finish: 'finish',
  finished: 'finish',
  complete: 'finish',
  completed: 'finish',
  done: 'finish',
  blocked: 'blocked_on_user',
  'blocked-on-user': 'blocked_on_user',
  blocked_on_user: 'blocked_on_user',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  cancel: 'cancelled',
  aborted: 'cancelled',
  abort: 'cancelled',
  progress: 'progress',
  continue: 'continue',
  continued: 'continue',
} as const;

const TERMINAL_LIFECYCLE_OUTCOME_ALIASES: Readonly<Record<string, TerminalLifecycleOutcome>> = {
  finished: 'finished',
  finish: 'finished',
  complete: 'finished',
  completed: 'finished',
  done: 'finished',
  blocked: 'blocked',
  failed: 'failed',
  fail: 'failed',
  error: 'failed',
  userinterlude: 'userinterlude',
  'user-interlude': 'userinterlude',
  interrupted: 'userinterlude',
  interrupt: 'userinterlude',
  cancelled: 'userinterlude',
  canceled: 'userinterlude',
  cancel: 'userinterlude',
  aborted: 'userinterlude',
  abort: 'userinterlude',
  askuserquestion: 'askuserQuestion',
  'ask-user-question': 'askuserQuestion',
  askuser: 'askuserQuestion',
  question: 'askuserQuestion',
} as const;

const TERMINAL_PHASE_TO_RUN_OUTCOME: Readonly<Record<string, TerminalRunOutcome>> = {
  complete: 'finish',
  completed: 'finish',
  blocked: 'blocked_on_user',
  blocked_on_user: 'blocked_on_user',
  'blocked-on-user': 'blocked_on_user',
  failed: 'failed',
  cancelled: 'cancelled',
  cancel: 'cancelled',
};

const RUN_OUTCOME_FROM_LIFECYCLE: Readonly<Record<TerminalLifecycleOutcome, TerminalRunOutcome>> = {
  finished: 'finish',
  blocked: 'blocked_on_user',
  failed: 'failed',
  userinterlude: 'cancelled',
  askuserQuestion: 'blocked_on_user',
};

export interface RunOutcomeNormalizationResult {
  outcome?: RunOutcome;
  warning?: string;
  error?: string;
}

export interface TerminalLifecycleOutcomeNormalizationOptions {
  blockedOnUserStrategy?: 'blocked' | 'askuserQuestion' | 'userinterlude';
}

export interface TerminalLifecycleOutcomeNormalizationResult {
  outcome?: TerminalLifecycleOutcome;
  warning?: string;
  error?: string;
}

export interface RunOutcomeValidationResult {
  ok: boolean;
  state?: Record<string, unknown>;
  warning?: string;
  error?: string;
}

function normalizeRunOutcomeValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBlockedOnUserLifecycleOutcome(
  options: TerminalLifecycleOutcomeNormalizationOptions = {},
): TerminalLifecycleOutcome {
  return options.blockedOnUserStrategy ?? 'blocked';
}

function hasPendingQuestionEnforcement(candidate: Record<string, unknown>): boolean {
  const enforcement = candidate.question_enforcement;
  if (!enforcement || typeof enforcement !== 'object') return false;
  const record = enforcement as Record<string, unknown>;
  const obligationId = safeString(record.obligation_id);
  const status = safeString(record.status).toLowerCase();
  return obligationId !== '' && status === 'pending';
}

export function compatibilityRunOutcomeFromTerminalLifecycleOutcome(
  outcome: TerminalLifecycleOutcome,
): TerminalRunOutcome {
  return RUN_OUTCOME_FROM_LIFECYCLE[outcome];
}

export function terminalLifecycleOutcomeFromRunOutcome(
  outcome: TerminalRunOutcome,
  options: TerminalLifecycleOutcomeNormalizationOptions = {},
): TerminalLifecycleOutcome {
  switch (outcome) {
    case 'finish':
      return 'finished';
    case 'blocked_on_user':
      return resolveBlockedOnUserLifecycleOutcome(options);
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'userinterlude';
  }
}

export function normalizeRunOutcome(value: unknown): RunOutcomeNormalizationResult {
  const normalized = normalizeRunOutcomeValue(value);
  if (!normalized) return {};
  if (RUN_OUTCOME_SET.has(normalized)) {
    return { outcome: normalized as RunOutcome };
  }
  const alias = RUN_OUTCOME_ALIASES[normalized];
  if (alias) {
    return {
      outcome: alias,
      warning: `normalized legacy run outcome "${value}" -> "${alias}"`,
    };
  }
  return { error: `run_outcome must be one of: ${RUN_OUTCOMES.join(', ')}` };
}

export function normalizeTerminalLifecycleOutcome(
  value: unknown,
  options: TerminalLifecycleOutcomeNormalizationOptions = {},
): TerminalLifecycleOutcomeNormalizationResult {
  const normalized = normalizeRunOutcomeValue(value);
  if (!normalized) return {};
  if (TERMINAL_LIFECYCLE_OUTCOME_SET.has(normalized)) {
    return { outcome: normalized as TerminalLifecycleOutcome };
  }
  if (normalized === 'blocked_on_user' || normalized === 'blocked-on-user') {
    const outcome = resolveBlockedOnUserLifecycleOutcome(options);
    return {
      outcome,
      warning: `normalized legacy terminal lifecycle outcome "${value}" -> "${outcome}"`,
    };
  }
  const alias = TERMINAL_LIFECYCLE_OUTCOME_ALIASES[normalized];
  if (alias) {
    return {
      outcome: alias,
      warning: `normalized legacy terminal lifecycle outcome "${value}" -> "${alias}"`,
    };
  }
  return {
    error: `lifecycle_outcome must be one of: ${TERMINAL_LIFECYCLE_OUTCOMES.join(', ')}`,
  };
}

export function classifyRunOutcome(value: unknown): RunOutcome {
  return normalizeRunOutcome(value).outcome ?? 'progress';
}

export function isTerminalRunOutcome(value: unknown): value is TerminalRunOutcome {
  const normalized = normalizeRunOutcome(value).outcome;
  return normalized !== undefined && TERMINAL_RUN_OUTCOME_SET.has(normalized);
}

export function isTerminalLifecycleOutcome(
  value: unknown,
  options: TerminalLifecycleOutcomeNormalizationOptions = {},
): value is TerminalLifecycleOutcome {
  const normalized = normalizeTerminalLifecycleOutcome(value, options).outcome;
  return normalized !== undefined && TERMINAL_LIFECYCLE_OUTCOME_SET.has(normalized);
}

export function isNonTerminalRunOutcome(value: unknown): value is NonTerminalRunOutcome {
  const normalized = normalizeRunOutcome(value).outcome;
  return normalized !== undefined && NON_TERMINAL_RUN_OUTCOME_SET.has(normalized);
}

export function isNonTerminalRunState(value: unknown): boolean {
  return isNonTerminalRunOutcome(classifyRunOutcome(value));
}

export function isTerminalRunState(value: unknown): boolean {
  return isTerminalRunOutcome(classifyRunOutcome(value));
}

export function inferTerminalLifecycleOutcome(
  candidate: Record<string, unknown>,
  options: {
    includeQuestionEnforcement?: boolean;
    blockedOnUserStrategy?: 'blocked' | 'askuserQuestion' | 'userinterlude';
  } = {},
): TerminalLifecycleOutcome | undefined {
  const blockedOnUserStrategy = options.blockedOnUserStrategy
    ?? (
      options.includeQuestionEnforcement && hasPendingQuestionEnforcement(candidate)
        ? 'askuserQuestion'
        : 'blocked'
    );

  const explicit = normalizeTerminalLifecycleOutcome(
    candidate.lifecycle_outcome ?? candidate.terminal_outcome,
    { blockedOnUserStrategy },
  );
  if (explicit.outcome) return explicit.outcome;

  const runOutcome = normalizeRunOutcome(candidate.run_outcome).outcome;
  if (runOutcome && isTerminalRunOutcome(runOutcome)) {
    return terminalLifecycleOutcomeFromRunOutcome(runOutcome, { blockedOnUserStrategy });
  }

  const phase = safeString(candidate.current_phase).toLowerCase();
  if (phase) {
    const normalizedPhase = normalizeTerminalLifecycleOutcome(phase, { blockedOnUserStrategy });
    if (normalizedPhase.outcome) return normalizedPhase.outcome;
  }

  if (options.includeQuestionEnforcement && hasPendingQuestionEnforcement(candidate)) {
    return 'askuserQuestion';
  }

  if (candidate.active === true) return undefined;
  if (safeString(candidate.completed_at)) return 'finished';
  if (candidate.active === false) return 'finished';
  return undefined;
}

export function inferRunOutcome(candidate: Record<string, unknown>): RunOutcome {
  const explicit = normalizeRunOutcome(candidate.run_outcome);
  if (explicit.outcome) return explicit.outcome;

  const lifecycleOutcome = inferTerminalLifecycleOutcome(candidate, {
    includeQuestionEnforcement: false,
  });
  if (lifecycleOutcome) {
    return compatibilityRunOutcomeFromTerminalLifecycleOutcome(lifecycleOutcome);
  }

  const phase = safeString(candidate.current_phase).toLowerCase();
  if (phase && TERMINAL_PHASE_TO_RUN_OUTCOME[phase]) {
    return TERMINAL_PHASE_TO_RUN_OUTCOME[phase];
  }

  if (candidate.active === true) return 'continue';
  if (safeString(candidate.completed_at)) return 'finish';
  if (candidate.active === false) return 'finish';
  return 'continue';
}

export function applyRunOutcomeContract(
  candidate: Record<string, unknown>,
  options?: { nowIso?: string },
): RunOutcomeValidationResult {
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const next: Record<string, unknown> = { ...candidate };
  const normalizedLifecycle = normalizeTerminalLifecycleOutcome(next.lifecycle_outcome ?? next.terminal_outcome);
  if (normalizedLifecycle.error) return { ok: false, error: normalizedLifecycle.error };

  const normalizedRunOutcome = normalizeRunOutcome(next.run_outcome);
  if (normalizedRunOutcome.error) return { ok: false, error: normalizedRunOutcome.error };

  const lifecycleOutcome = normalizedLifecycle.outcome ?? inferTerminalLifecycleOutcome(next, {
    includeQuestionEnforcement: false,
  });
  const outcome = normalizedLifecycle.outcome
    ? compatibilityRunOutcomeFromTerminalLifecycleOutcome(normalizedLifecycle.outcome)
    : normalizedRunOutcome.outcome ?? inferRunOutcome(next);

  delete next.terminal_outcome;
  next.run_outcome = outcome;
  if (lifecycleOutcome) {
    next.lifecycle_outcome = lifecycleOutcome;
  } else {
    delete next.lifecycle_outcome;
  }

  const terminal = lifecycleOutcome !== undefined || isTerminalRunOutcome(outcome);
  if (terminal) {
    if (next.active === true) {
      return {
        ok: false,
        error: `terminal run outcome "${lifecycleOutcome ?? outcome}" requires active=false`,
      };
    }
    next.active = false;
    if (!safeString(next.completed_at)) {
      next.completed_at = nowIso;
    }
  } else {
    if (next.active === false) {
      return { ok: false, error: `non-terminal run outcome "${outcome}" requires active=true` };
    }
    next.active = true;
    if (safeString(next.completed_at)) {
      delete next.completed_at;
    }
  }

  return {
    ok: true,
    state: next,
    warning: normalizedLifecycle.warning ?? normalizedRunOutcome.warning,
  };
}
