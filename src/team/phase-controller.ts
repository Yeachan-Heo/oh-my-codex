import {
  createTeamState,
  isTerminalPhase,
  transitionPhase,
  type TeamPhase,
  type TeamState,
  type TerminalPhase,
} from './orchestrator.js';
import { type TeamPhaseState } from './state.js';

export function inferPhaseTargetFromTaskCounts(
  taskCounts: { pending: number; blocked: number; in_progress: number; failed: number },
  options: { verificationPending?: boolean } = {},
): TeamPhase | TerminalPhase {
  const allTasksTerminal = taskCounts.pending === 0 && taskCounts.blocked === 0 && taskCounts.in_progress === 0;
  if (allTasksTerminal && taskCounts.failed === 0) {
    if (options.verificationPending) return 'team-verify';
    return 'complete';
  }
  if (allTasksTerminal && taskCounts.failed > 0) return 'team-fix';
  return 'team-exec';
}

function defaultPersistedPhaseState(): TeamPhaseState {
  return {
    current_phase: 'team-exec',
    max_fix_attempts: 3,
    current_fix_attempt: 0,
    transitions: [],
    updated_at: new Date().toISOString(),
  };
}

function toTeamState(phaseState: TeamPhaseState): TeamState {
  const state = createTeamState('team-runtime-monitor', phaseState.max_fix_attempts);
  return {
    ...state,
    active: !isTerminalPhase(phaseState.current_phase),
    phase: phaseState.current_phase,
    current_fix_attempt: phaseState.current_fix_attempt,
    phase_transitions: [...phaseState.transitions],
  };
}

function toPhaseState(state: TeamState): TeamPhaseState {
  return {
    current_phase: state.phase,
    max_fix_attempts: state.max_fix_attempts,
    current_fix_attempt: state.current_fix_attempt,
    transitions: [...state.phase_transitions],
    updated_at: new Date().toISOString(),
  };
}

function buildTransitionPath(from: TeamPhase | TerminalPhase, to: TeamPhase | TerminalPhase): Array<TeamPhase | TerminalPhase> {
  if (from === to) return [];

  if (to === 'team-verify') {
    if (from === 'team-plan') return ['team-prd', 'team-exec', 'team-verify'];
    if (from === 'team-prd') return ['team-exec', 'team-verify'];
    if (from === 'team-exec') return ['team-verify'];
    if (from === 'team-fix') return ['team-exec', 'team-verify'];
    return [];
  }

  if (to === 'team-exec') {
    if (from === 'team-plan') return ['team-prd', 'team-exec'];
    if (from === 'team-prd') return ['team-exec'];
    if (from === 'team-fix') return ['team-exec'];
    return [];
  }

  if (to === 'team-fix') {
    if (from === 'team-plan') return ['team-prd', 'team-exec', 'team-verify', 'team-fix'];
    if (from === 'team-prd') return ['team-exec', 'team-verify', 'team-fix'];
    if (from === 'team-exec') return ['team-verify', 'team-fix'];
    if (from === 'team-verify') return ['team-fix'];
    return [];
  }

  if (to === 'complete') {
    if (from === 'team-plan') return ['team-prd', 'team-exec', 'team-verify', 'complete'];
    if (from === 'team-prd') return ['team-exec', 'team-verify', 'complete'];
    if (from === 'team-exec') return ['team-verify', 'complete'];
    if (from === 'team-verify') return ['complete'];
    if (from === 'team-fix') return ['complete'];
    return [];
  }

  if (to === 'failed') {
    if (from === 'team-plan') return ['team-prd', 'team-exec', 'team-verify', 'failed'];
    if (from === 'team-prd') return ['team-exec', 'team-verify', 'failed'];
    if (from === 'team-exec') return ['team-verify', 'failed'];
    if (from === 'team-verify') return ['failed'];
    if (from === 'team-fix') return ['failed'];
    return [];
  }

  return [];
}

export function reconcilePhaseStateForMonitor(
  persisted: TeamPhaseState | null,
  target: TeamPhase | TerminalPhase,
): TeamPhaseState {
  const now = new Date().toISOString();
  const base = persisted ?? defaultPersistedPhaseState();
  if (base.current_phase === target) {
    return {
      ...base,
      updated_at: now,
    };
  }

  if (isTerminalPhase(base.current_phase)) {
    if (isTerminalPhase(target)) return base;
    return {
      current_phase: target,
      max_fix_attempts: base.max_fix_attempts,
      current_fix_attempt: 0,
      transitions: [
        ...base.transitions,
        {
          from: base.current_phase,
          to: target,
          at: now,
          reason: 'tasks_reopened',
        },
      ],
      updated_at: now,
    };
  }

  let state = toTeamState(base);
  const transitionPath = buildTransitionPath(state.phase, target);
  for (const next of transitionPath) {
    if (state.phase === next) continue;
    if (isTerminalPhase(state.phase)) break;
    state = transitionPhase(state, next);
  }

  return toPhaseState(state);
}
