/**
 * Interview Stage Quality Gates Wiring
 * 
 * Spawns quality gates as native subagents during the $deep-interview final-spec stage.
 * Gates are invoked after specification is complete and before handoff.
 */

import { getGatesForStage, getBlockingGatesForStage, getAdvisoryGatesForStage, type QualityGate } from '../config/quality-gates.js';

export interface InterviewStageGateResult {
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
}

export interface InterviewStageGateReceipt {
  /** Gates that executed in advisory mode */
  advisory_gates: InterviewStageGateResult[];
  /** Gates that executed in blocking mode */
  blocking_gates: InterviewStageGateResult[];
  /** Blocking verdicts that must be addressed before handoff */
  blocking_issues: Array<{ skill: string; reason: string }>;
  /** Whether all blocking gates passed */
  blocking_cleared: boolean;
}

/**
 * Get quality gates for the interview stage
 */
export function getInterviewStageGates(): QualityGate[] {
  return getGatesForStage('interview');
}

/**
 * Get advisory gates for the interview stage
 */
export function getInterviewAdvisoryGates(): QualityGate[] {
  return getAdvisoryGatesForStage('interview');
}

/**
 * Get blocking gates for the interview stage
 */
export function getInterviewBlockingGates(): QualityGate[] {
  return getBlockingGatesForStage('interview');
}

/**
 * Initialize an empty interview stage gate receipt
 */
export function createEmptyInterviewGateReceipt(): InterviewStageGateReceipt {
  return {
    advisory_gates: [],
    blocking_gates: [],
    blocking_issues: [],
    blocking_cleared: true,
  };
}

/**
 * Record a gate execution result in the interview receipt
 */
export function recordInterviewGateResult(
  receipt: InterviewStageGateReceipt,
  gate: QualityGate,
  result: InterviewStageGateResult,
): InterviewStageGateReceipt {
  if (gate.mode === 'advisory') {
    receipt.advisory_gates.push(result);
  } else {
    receipt.blocking_gates.push(result);
    if (result.verdict === 'fail' || result.verdict === 'unavailable') {
      receipt.blocking_issues.push({
        skill: gate.skill,
        reason: result.finding || `${result.verdict} (${gate.skill})`,
      });
      receipt.blocking_cleared = false;
    }
  }
  return receipt;
}

/**
 * Check if interview stage gates allow proceeding to handoff
 */
export function canProceedWithInterviewHandoff(receipt: InterviewStageGateReceipt): boolean {
  return receipt.blocking_cleared;
}
