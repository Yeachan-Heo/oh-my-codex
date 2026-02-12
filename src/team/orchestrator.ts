/**
 * Team Orchestration for oh-my-codex
 *
 * Leverages Codex CLI's native collab feature for multi-agent coordination.
 * Provides the staged pipeline: plan -> prd -> exec -> verify -> fix (loop)
 */

export type TeamPhase = 'team-plan' | 'team-prd' | 'team-exec' | 'team-verify' | 'team-fix';
export type TerminalPhase = 'complete' | 'failed' | 'cancelled';

export interface TeamState {
  active: boolean;
  phase: TeamPhase | TerminalPhase;
  task_description: string;
  created_at: string;
  phase_transitions: Array<{ from: string; to: string; at: string; reason?: string }>;
  tasks: TeamTask[];
  max_fix_attempts: number;
  current_fix_attempt: number;
}

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  owner?: string;
  blockedBy?: string[];
  createdAt: string;
  completedAt?: string;
}

/**
 * Phase transition rules
 */
const TRANSITIONS: Record<TeamPhase, Array<TeamPhase | TerminalPhase>> = {
  'team-plan': ['team-prd'],
  'team-prd': ['team-exec'],
  'team-exec': ['team-verify'],
  'team-verify': ['team-fix', 'complete', 'failed'],
  'team-fix': ['team-exec', 'team-verify', 'complete', 'failed'],
};

/**
 * Validate a phase transition
 */
export function isValidTransition(from: TeamPhase, to: TeamPhase | TerminalPhase): boolean {
  const allowed = TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Create initial team state
 */
export function createTeamState(taskDescription: string, maxFixAttempts: number = 3): TeamState {
  return {
    active: true,
    phase: 'team-plan',
    task_description: taskDescription,
    created_at: new Date().toISOString(),
    phase_transitions: [],
    tasks: [],
    max_fix_attempts: maxFixAttempts,
    current_fix_attempt: 0,
  };
}

/**
 * Transition to next phase
 */
export function transitionPhase(
  state: TeamState,
  to: TeamPhase | TerminalPhase,
  reason?: string
): TeamState {
  const from = state.phase as TeamPhase;

  if (!isValidTransition(from, to)) {
    throw new Error(`Invalid transition: ${from} -> ${to}`);
  }

  if (to === 'team-fix') {
    if (state.current_fix_attempt >= state.max_fix_attempts) {
      return {
        ...state,
        phase: 'failed',
        active: false,
        phase_transitions: [
          ...state.phase_transitions,
          { from, to: 'failed', at: new Date().toISOString(), reason: 'Max fix attempts exceeded' },
        ],
      };
    }
    state.current_fix_attempt++;
  }

  const isTerminal = ['complete', 'failed', 'cancelled'].includes(to);

  return {
    ...state,
    phase: to,
    active: !isTerminal,
    phase_transitions: [
      ...state.phase_transitions,
      { from, to, at: new Date().toISOString(), reason },
    ],
  };
}

/**
 * Get agent roles recommended for each phase
 */
export function getPhaseAgents(phase: TeamPhase): string[] {
  switch (phase) {
    case 'team-plan':
      return ['analyst', 'planner'];
    case 'team-prd':
      return ['product-manager', 'analyst'];
    case 'team-exec':
      return ['executor', 'deep-executor', 'designer', 'test-engineer'];
    case 'team-verify':
      return ['verifier', 'quality-reviewer', 'security-reviewer'];
    case 'team-fix':
      return ['executor', 'build-fixer', 'debugger'];
  }
}

/**
 * Generate phase instructions for AGENTS.md context
 */
export function getPhaseInstructions(phase: TeamPhase): string {
  switch (phase) {
    case 'team-plan':
      return 'PHASE: Planning. Use /analyst for requirements, /planner for task breakdown. Output: task list with dependencies.';
    case 'team-prd':
      return 'PHASE: Requirements. Use /product-manager for PRD, /analyst for acceptance criteria. Output: explicit scope and success metrics.';
    case 'team-exec':
      return 'PHASE: Execution. Use /executor for implementation, /test-engineer for tests. Output: working code with tests.';
    case 'team-verify':
      return 'PHASE: Verification. Use /verifier for evidence collection, /quality-reviewer for review. Output: pass/fail with evidence.';
    case 'team-fix':
      return 'PHASE: Fixing. Use /debugger for root cause, /executor for fixes. Output: fixed code, re-verify needed.';
  }
}
