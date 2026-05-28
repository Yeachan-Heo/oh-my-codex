const AUTOPILOT_CHILD_PHASES = [
  'deep-interview',
  'ralplan',
  'ultragoal',
  'team',
  'ralph',
  'code-review',
  'ultraqa',
] as const;

const AUTOPILOT_RUNTIME_PHASES = [
  ...AUTOPILOT_CHILD_PHASES,
  'waiting-for-user',
  'complete',
  'failed',
] as const;

export type AutopilotChildPhase = (typeof AUTOPILOT_CHILD_PHASES)[number];
export type AutopilotRuntimePhase = (typeof AUTOPILOT_RUNTIME_PHASES)[number];
export type AutopilotStageLabel = `autopilot:${AutopilotChildPhase}`;

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizePhaseText(value: unknown): string {
  const normalized = safeString(value).toLowerCase().replace(/_/g, '-');
  if (normalized === 'completed') return 'complete';
  if (normalized === 'planning') return 'ralplan';
  return normalized;
}

export function isAutopilotChildPhase(value: unknown): value is AutopilotChildPhase {
  return (AUTOPILOT_CHILD_PHASES as readonly string[]).includes(normalizePhaseText(value));
}

export function normalizeAutopilotPhase(value: unknown): AutopilotRuntimePhase | null {
  const normalized = normalizePhaseText(value);
  return (AUTOPILOT_RUNTIME_PHASES as readonly string[]).includes(normalized)
    ? normalized as AutopilotRuntimePhase
    : null;
}

function readWaitingPreviousPhase(state: Record<string, unknown>): AutopilotChildPhase | null {
  const nestedState = safeObject(state.state);
  const wait = safeObject(nestedState.deep_interview_question);
  const previousPhase = normalizeAutopilotPhase(wait.previous_phase);
  return previousPhase && isAutopilotChildPhase(previousPhase) ? previousPhase : null;
}

function isActiveAutopilotState(state: Record<string, unknown>): boolean {
  return safeString(state.mode) === 'autopilot' && state.active === true;
}

export function deriveAutopilotChildPhase(state: unknown): AutopilotChildPhase | null {
  const candidate = safeObject(state);
  if (!isActiveAutopilotState(candidate)) return null;
  const phase = normalizeAutopilotPhase(candidate.current_phase);
  if (phase && isAutopilotChildPhase(phase)) return phase;
  if (phase === 'waiting-for-user') return readWaitingPreviousPhase(candidate);
  return null;
}

export function isAutopilotSupervising(state: unknown): boolean {
  const candidate = safeObject(state);
  return isActiveAutopilotState(candidate) && deriveAutopilotChildPhase(candidate) !== null;
}

export function isAutopilotSupervisingChild(
  state: unknown,
  child: AutopilotChildPhase,
): boolean {
  return isAutopilotSupervising(state) && deriveAutopilotChildPhase(state) === child;
}

export function deriveAutopilotStageLabel(state: unknown): AutopilotStageLabel | null {
  const child = deriveAutopilotChildPhase(state);
  return child ? `autopilot:${child}` : null;
}
