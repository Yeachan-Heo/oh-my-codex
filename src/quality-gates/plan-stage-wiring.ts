/**
 * Plan Stage Quality Gates Wiring
 * 
 * Spawns quality gates as native subagents during the $plan/$ralplan Architect→Critic review stage.
 * Gates are invoked after initial planning and feed into the revise loop within the iteration cap.
 */

import { getGatesForStage, getBlockingGatesForStage, getAdvisoryGatesForStage, type QualityGate } from '../config/quality-gates.js';

export interface PlanStageGateResult {
  /** Name of the quality gate skill */
  skill: string;
  /** Gate enforcement mode */
  mode: 'advisory' | 'blocking';
  /** Model override if specified */
  model?: string;
  /** Verdict from the gate execution (if available) */
  verdict?: 'pass' | 'fail' | 'unavailable' | 'skipped';
  /** Findings or reason for verdict */
  finding?: string;
  /** Revision suggestions from the gate */
  suggestions?: string[];
}

export interface PlanStageGateReceipt {
  /** Gates that executed in advisory mode */
  advisory_gates: PlanStageGateResult[];
  /** Gates that executed in blocking mode */
  blocking_gates: PlanStageGateResult[];
  /** Blocking verdicts that trigger the revise loop */
  blocking_issues: Array<{ skill: string; reason: string; suggestions?: string[] }>;
  /** Whether all blocking gates passed */
  blocking_cleared: boolean;
  /** Whether iteration cap was reached with unresolved blocking gates */
  iteration_cap_exceeded?: boolean;
}

/**
 * Get quality gates for the plan stage
 */
export function getPlanStageGates(): QualityGate[] {
  return getGatesForStage('plan');
}

/**
 * Get advisory gates for the plan stage
 */
export function getPlanAdvisoryGates(): QualityGate[] {
  return getAdvisoryGatesForStage('plan');
}

/**
 * Get blocking gates for the plan stage
 */
export function getPlanBlockingGates(): QualityGate[] {
  return getBlockingGatesForStage('plan');
}

/**
 * Initialize an empty plan stage gate receipt
 */
export function createEmptyPlanGateReceipt(): PlanStageGateReceipt {
  return {
    advisory_gates: [],
    blocking_gates: [],
    blocking_issues: [],
    blocking_cleared: true,
  };
}

/**
 * Record a gate execution result in the plan receipt
 */
export function recordPlanGateResult(
  receipt: PlanStageGateReceipt,
  gate: QualityGate,
  result: PlanStageGateResult,
): PlanStageGateReceipt {
  if (gate.mode === 'advisory') {
    receipt.advisory_gates.push(result);
  } else {
    receipt.blocking_gates.push(result);
    if (result.verdict === 'fail' || result.verdict === 'unavailable') {
      receipt.blocking_issues.push({
        skill: gate.skill,
        reason: result.finding || `${result.verdict} (${gate.skill})`,
        suggestions: result.suggestions,
      });
      receipt.blocking_cleared = false;
    }
  }
  return receipt;
}

/**
 * Check if plan stage gates allow proceeding without revision
 */
export function canProceedWithoutRevision(receipt: PlanStageGateReceipt): boolean {
  return receipt.blocking_cleared;
}

/**
 * Mark that the iteration cap was exceeded
 */
export function markIterationCapExceeded(receipt: PlanStageGateReceipt): PlanStageGateReceipt {
  receipt.iteration_cap_exceeded = true;
  return receipt;
}
