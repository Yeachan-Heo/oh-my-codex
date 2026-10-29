/**
 * Code Review Stage Quality Gates Wiring
 * 
 * Spawns quality gates as native subagents during the $code-review stage.
 * Gates execute alongside standard reviewers and record findings in the code review receipt.
 */

import { getGatesForStage, getBlockingGatesForStage, getAdvisoryGatesForStage, type QualityGate } from '../config/quality-gates.js';

export interface CodeReviewGateResult {
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
  /** Code issues identified by the gate */
  issues?: Array<{ file: string; line: number; message: string }>;
  /** Recommendations from the gate */
  recommendations?: string[];
}

export interface CodeReviewStageGateReceipt {
  /** Gates that executed in advisory mode */
  advisory_gates: CodeReviewGateResult[];
  /** Gates that executed in blocking mode */
  blocking_gates: CodeReviewGateResult[];
  /** Blocking verdicts that prevent approval */
  blocking_issues: Array<{ skill: string; reason: string; issues?: Array<{ file: string; line: number; message: string }> }>;
  /** Whether all blocking gates passed */
  blocking_cleared: boolean;
  /** Total issues found across all gates */
  total_issues: number;
}

/**
 * Get quality gates for the code-review stage
 */
export function getCodeReviewGates(): QualityGate[] {
  return getGatesForStage('codeReview');
}

/**
 * Get advisory gates for the code-review stage
 */
export function getCodeReviewAdvisoryGates(): QualityGate[] {
  return getAdvisoryGatesForStage('codeReview');
}

/**
 * Get blocking gates for the code-review stage
 */
export function getCodeReviewBlockingGates(): QualityGate[] {
  return getBlockingGatesForStage('codeReview');
}

/**
 * Initialize an empty code review stage gate receipt
 */
export function createEmptyCodeReviewGateReceipt(): CodeReviewStageGateReceipt {
  return {
    advisory_gates: [],
    blocking_gates: [],
    blocking_issues: [],
    blocking_cleared: true,
    total_issues: 0,
  };
}

/**
 * Record a gate execution result in the code review receipt
 */
export function recordCodeReviewGateResult(
  receipt: CodeReviewStageGateReceipt,
  gate: QualityGate,
  result: CodeReviewGateResult,
): CodeReviewStageGateReceipt {
  if (gate.mode === 'advisory') {
    receipt.advisory_gates.push(result);
  } else {
    receipt.blocking_gates.push(result);
    if (result.verdict === 'fail' || result.verdict === 'unavailable') {
      receipt.blocking_issues.push({
        skill: gate.skill,
        reason: result.finding || `${result.verdict} (${gate.skill})`,
        issues: result.issues,
      });
      receipt.blocking_cleared = false;
    }
  }

  // Count total issues
  if (result.issues) {
    receipt.total_issues += result.issues.length;
  }

  return receipt;
}

/**
 * Check if code review gates allow approval
 */
export function canApproveCode(receipt: CodeReviewStageGateReceipt): boolean {
  return receipt.blocking_cleared;
}

/**
 * Get a summary of gate results
 */
export function getCodeReviewGateSummary(receipt: CodeReviewStageGateReceipt): string {
  const lines: string[] = [];

  if (receipt.advisory_gates.length > 0) {
    lines.push(`Advisory gates: ${receipt.advisory_gates.length}`);
  }

  if (receipt.blocking_gates.length > 0) {
    const passed = receipt.blocking_gates.filter((g) => g.verdict === 'pass').length;
    const failed = receipt.blocking_gates.filter((g) => g.verdict === 'fail').length;
    const unavailable = receipt.blocking_gates.filter((g) => g.verdict === 'unavailable').length;
    lines.push(`Blocking gates: ${passed} passed, ${failed} failed, ${unavailable} unavailable`);
  }

  if (receipt.total_issues > 0) {
    lines.push(`Total issues: ${receipt.total_issues}`);
  }

  return lines.length > 0 ? lines.join('; ') : 'No gates executed';
}
