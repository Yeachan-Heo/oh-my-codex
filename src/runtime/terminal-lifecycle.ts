import {
  TERMINAL_LIFECYCLE_OUTCOMES,
  compatibilityRunOutcomeFromTerminalLifecycleOutcome,
  normalizeRunOutcome,
  normalizeTerminalLifecycleOutcome as normalizeTerminalLifecycleOutcomeContract,
  terminalLifecycleOutcomeFromRunOutcome,
  type RunOutcome,
  type TerminalLifecycleOutcome,
  type TerminalLifecycleOutcomeNormalizationResult,
} from './run-outcome.js';

export {
  TERMINAL_LIFECYCLE_OUTCOMES,
  compatibilityRunOutcomeFromTerminalLifecycleOutcome,
};
export type { TerminalLifecycleOutcome };
export type TerminalLifecycleNormalizationResult = TerminalLifecycleOutcomeNormalizationResult;

function rewriteWarning(warning: string | undefined): string | undefined {
  return warning?.replace('legacy terminal lifecycle outcome', 'legacy lifecycle outcome');
}

function isCanonicalTerminalLifecycleOutcome(value: unknown): value is TerminalLifecycleOutcome {
  return typeof value === 'string' && (TERMINAL_LIFECYCLE_OUTCOMES as readonly string[]).includes(value.trim());
}

export function normalizeTerminalLifecycleOutcome(value: unknown): TerminalLifecycleNormalizationResult {
  if (isCanonicalTerminalLifecycleOutcome(value)) {
    return { outcome: value.trim() as TerminalLifecycleOutcome };
  }

  const result = normalizeTerminalLifecycleOutcomeContract(value, {
    blockedOnUserStrategy: 'blocked',
  });
  return {
    ...(result.outcome ? { outcome: result.outcome } : {}),
    ...(result.warning ? { warning: rewriteWarning(result.warning) } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export function inferTerminalLifecycleOutcome(candidate: {
  lifecycle_outcome?: unknown;
  run_outcome?: unknown;
}): TerminalLifecycleNormalizationResult {
  const explicit = normalizeTerminalLifecycleOutcome(candidate.lifecycle_outcome);
  if (explicit.outcome || explicit.error) return explicit;

  const runOutcome = normalizeRunOutcome(candidate.run_outcome);
  if (runOutcome.error) return { error: runOutcome.error };
  switch (runOutcome.outcome) {
    case 'finish':
    case 'blocked_on_user':
    case 'failed':
      return {
        outcome: terminalLifecycleOutcomeFromRunOutcome(runOutcome.outcome, {
          blockedOnUserStrategy: 'blocked',
        }),
      };
    case 'cancelled':
      return {
        outcome: terminalLifecycleOutcomeFromRunOutcome('cancelled', {
          blockedOnUserStrategy: 'blocked',
        }),
        warning: 'normalized legacy run outcome "cancelled" -> "userinterlude"',
      };
    default:
      return {};
  }
}

export function preferredRunOutcomeForLifecycleOutcome(
  outcome: TerminalLifecycleOutcome,
): RunOutcome {
  return compatibilityRunOutcomeFromTerminalLifecycleOutcome(outcome);
}
