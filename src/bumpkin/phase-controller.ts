export type UpgradePhase =
  | 'plan'
  | 'prd'
  | 'exec'
  | 'verify-tests'
  | 'verify-types'
  | 'verify-build'
  | 'verify-lint'
  | 'verify-preview'
  | 'verify-apisurface'
  | 'verify-bundle-size'
  | 'llm-review'
  | 'blast-radius-check'
  | 'category-check'
  | 'fix'
  | 'ship'
  | 'escalated'
  | 'failed';

export type TerminalUpgradePhase = 'ship' | 'escalated' | 'failed';

export type EscalationReason =
  | 'max-fix-attempts-exceeded'
  | 'blast-radius-exceeded'
  | 'safety-critical-category';

export type PhaseEvent =
  | { kind: 'phase-done' }
  | { kind: 'gate-pass' }
  | { kind: 'gate-fail'; reason: string }
  | { kind: 'fix-success' }
  | { kind: 'fix-fail' }
  | { kind: 'review-reject'; reason: string };

export interface PhaseTransition {
  from: UpgradePhase;
  to: UpgradePhase;
  at: string;
  reason: string | undefined;
}

export interface UpgradeState {
  phase: UpgradePhase;
  fixAttempts: number;
  maxFixAttempts: number;
  failedGate: UpgradePhase | null;
  escalationReason: EscalationReason | null;
  transitions: PhaseTransition[];
}

export interface CreateOptions {
  maxFixAttempts?: number;
  now?: () => string;
}

export interface AdvanceOptions {
  now?: () => string;
}

const DEFAULT_MAX_FIX_ATTEMPTS = 3;

export const LINEAR_GATE_ORDER: readonly UpgradePhase[] = [
  'verify-tests',
  'verify-types',
  'verify-build',
  'verify-lint',
  'verify-preview',
  'verify-apisurface',
  'verify-bundle-size',
  'llm-review',
  'blast-radius-check',
  'category-check',
  'ship',
] as const;

const TERMINAL: ReadonlySet<UpgradePhase> = new Set(['ship', 'escalated', 'failed']);

const PRE_GATE_ORDER: readonly UpgradePhase[] = ['plan', 'prd', 'exec', 'verify-tests'] as const;

export function isTerminal(phase: UpgradePhase): phase is TerminalUpgradePhase {
  return TERMINAL.has(phase);
}

export function createInitialState(options: CreateOptions = {}): UpgradeState {
  return {
    phase: 'plan',
    fixAttempts: 0,
    maxFixAttempts: options.maxFixAttempts ?? DEFAULT_MAX_FIX_ATTEMPTS,
    failedGate: null,
    escalationReason: null,
    transitions: [],
  };
}

function nextPreGate(phase: UpgradePhase): UpgradePhase | null {
  const idx = PRE_GATE_ORDER.indexOf(phase);
  if (idx < 0 || idx === PRE_GATE_ORDER.length - 1) return null;
  return PRE_GATE_ORDER[idx + 1] ?? null;
}

function nextGate(phase: UpgradePhase): UpgradePhase | null {
  const idx = LINEAR_GATE_ORDER.indexOf(phase);
  if (idx < 0 || idx === LINEAR_GATE_ORDER.length - 1) return null;
  return LINEAR_GATE_ORDER[idx + 1] ?? null;
}

function recordTransition(
  state: UpgradeState,
  to: UpgradePhase,
  reason: string | undefined,
  now: () => string,
): UpgradeState {
  if (state.phase === to) return state;
  return {
    ...state,
    phase: to,
    transitions: [
      ...state.transitions,
      { from: state.phase, to, at: now(), reason },
    ],
  };
}

function escalate(
  state: UpgradeState,
  reason: EscalationReason,
  transitionReason: string | undefined,
  now: () => string,
): UpgradeState {
  return recordTransition(
    { ...state, escalationReason: reason },
    'escalated',
    transitionReason,
    now,
  );
}

export function advance(
  state: UpgradeState,
  event: PhaseEvent,
  options: AdvanceOptions = {},
): UpgradeState {
  if (isTerminal(state.phase)) return state;

  const now = options.now ?? (() => new Date().toISOString());
  const phase = state.phase;

  if (phase === 'plan' || phase === 'prd' || phase === 'exec') {
    if (event.kind === 'phase-done') {
      const target = nextPreGate(phase);
      if (target) return recordTransition(state, target, undefined, now);
    }
    return state;
  }

  if (phase === 'fix') {
    if (event.kind === 'fix-success' && state.failedGate) {
      return recordTransition(
        { ...state, fixAttempts: 0 },
        state.failedGate,
        'fix-success',
        now,
      );
    }
    if (event.kind === 'fix-fail') {
      const attempts = state.fixAttempts + 1;
      if (attempts >= state.maxFixAttempts) {
        return escalate(
          { ...state, fixAttempts: attempts },
          'max-fix-attempts-exceeded',
          'max-fix-attempts-exceeded',
          now,
        );
      }
      return { ...state, fixAttempts: attempts };
    }
    return state;
  }

  // Gate phases
  if (event.kind === 'gate-pass') {
    const target = nextGate(phase);
    if (target) return recordTransition(state, target, undefined, now);
    return state;
  }

  if (event.kind === 'gate-fail') {
    if (phase === 'blast-radius-check') {
      return escalate(state, 'blast-radius-exceeded', event.reason, now);
    }
    if (phase === 'category-check') {
      return escalate(state, 'safety-critical-category', event.reason, now);
    }
    return recordTransition(
      { ...state, failedGate: phase, fixAttempts: 0 },
      'fix',
      event.reason,
      now,
    );
  }

  if (event.kind === 'review-reject' && phase === 'llm-review') {
    return recordTransition(
      { ...state, failedGate: 'llm-review', fixAttempts: 0 },
      'fix',
      event.reason,
      now,
    );
  }

  return state;
}
