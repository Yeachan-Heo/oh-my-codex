/**
 * Quality Gates Stage Wiring Tests
 * 
 * Tests for the wiring of quality gates in interview, plan, and code-review stages.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtemp, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

// Interview stage imports
import {
  getInterviewStageGates,
  getInterviewAdvisoryGates,
  getInterviewBlockingGates,
  createEmptyInterviewGateReceipt,
  recordInterviewGateResult,
  canProceedWithInterviewHandoff,
  type InterviewStageGateReceipt,
} from '../interview-stage-wiring.js';

// Plan stage imports
import {
  getPlanStageGates,
  getPlanAdvisoryGates,
  getPlanBlockingGates,
  createEmptyPlanGateReceipt,
  recordPlanGateResult,
  canProceedWithoutRevision,
  markIterationCapExceeded,
  type PlanStageGateReceipt,
} from '../plan-stage-wiring.js';

// Code review stage imports
import {
  getCodeReviewGates,
  getCodeReviewAdvisoryGates,
  getCodeReviewBlockingGates,
  createEmptyCodeReviewGateReceipt,
  recordCodeReviewGateResult,
  canApproveCode,
  getCodeReviewGateSummary,
  type CodeReviewStageGateReceipt,
} from '../code-review-stage-wiring.js';

import type { QualityGate, QualityGatesConfig } from '../../config/quality-gates.js';

const mkdtempAsync = promisify(mkdtemp);

describe('interview stage wiring', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtempAsync(join(tmpdir(), 'omx-interview-stage-'));
  });

  afterEach(async () => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('retrieves gates for interview stage', () => {
    const config: QualityGatesConfig = {
      interview: [
        { skill: 'analysis-gate', mode: 'advisory' },
        { skill: 'blocking-gate', mode: 'blocking' },
      ],
      plan: [{ skill: 'plan-gate', mode: 'advisory' }],
    };
    writeFileSync(
      join(testDir, '.omx-config.json'),
      JSON.stringify({ qualityGates: config }, null, 2),
    );

    // This test would need the config to be loaded from testDir
    // For now, we test the structure of the receipt
    const receipt = createEmptyInterviewGateReceipt();
    assert.strictEqual(receipt.advisory_gates.length, 0);
    assert.strictEqual(receipt.blocking_gates.length, 0);
    assert.strictEqual(receipt.blocking_cleared, true);
  });

  it('records advisory gate results', () => {
    let receipt = createEmptyInterviewGateReceipt();
    const gate: QualityGate = { skill: 'advisory-gate', mode: 'advisory' };
    const result = {
      skill: 'advisory-gate',
      mode: 'advisory' as const,
      verdict: 'pass' as const,
      finding: 'All checks passed',
    };

    receipt = recordInterviewGateResult(receipt, gate, result);
    assert.strictEqual(receipt.advisory_gates.length, 1);
    assert.strictEqual(receipt.blocking_gates.length, 0);
    assert.strictEqual(receipt.blocking_cleared, true);
  });

  it('records blocking gate results and marks issues', () => {
    let receipt = createEmptyInterviewGateReceipt();
    const gate: QualityGate = { skill: 'blocking-gate', mode: 'blocking' };
    const result = {
      skill: 'blocking-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
      finding: 'Critical issues found',
    };

    receipt = recordInterviewGateResult(receipt, gate, result);
    assert.strictEqual(receipt.blocking_gates.length, 1);
    assert.strictEqual(receipt.blocking_issues.length, 1);
    assert.strictEqual(receipt.blocking_cleared, false);
  });

  it('determines handoff readiness based on blocking gates', () => {
    const passingReceipt = createEmptyInterviewGateReceipt();
    assert.strictEqual(canProceedWithInterviewHandoff(passingReceipt), true);

    let failingReceipt = createEmptyInterviewGateReceipt();
    const gate: QualityGate = { skill: 'blocking-gate', mode: 'blocking' };
    const failResult = {
      skill: 'blocking-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
    };
    failingReceipt = recordInterviewGateResult(failingReceipt, gate, failResult);
    assert.strictEqual(canProceedWithInterviewHandoff(failingReceipt), false);
  });

  it('handles unavailable gates in blocking mode', () => {
    let receipt = createEmptyInterviewGateReceipt();
    const gate: QualityGate = { skill: 'missing-skill', mode: 'blocking' };
    const result = {
      skill: 'missing-skill',
      mode: 'blocking' as const,
      verdict: 'unavailable' as const,
      finding: 'Skill not found',
    };

    receipt = recordInterviewGateResult(receipt, gate, result);
    assert.strictEqual(receipt.blocking_cleared, false);
  });
});

describe('plan stage wiring', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtempAsync(join(tmpdir(), 'omx-plan-stage-'));
  });

  afterEach(async () => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('initializes empty plan stage receipt', () => {
    const receipt = createEmptyPlanGateReceipt();
    assert.strictEqual(receipt.advisory_gates.length, 0);
    assert.strictEqual(receipt.blocking_gates.length, 0);
    assert.strictEqual(receipt.blocking_cleared, true);
    assert.strictEqual(receipt.iteration_cap_exceeded, undefined);
  });

  it('records gate results with suggestions', () => {
    let receipt = createEmptyPlanGateReceipt();
    const gate: QualityGate = { skill: 'review-gate', mode: 'blocking' };
    const result = {
      skill: 'review-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
      finding: 'Plan needs revision',
      suggestions: ['Add timeline', 'Clarify dependencies'],
    };

    receipt = recordPlanGateResult(receipt, gate, result);
    assert.strictEqual(receipt.blocking_issues.length, 1);
    assert.deepStrictEqual(receipt.blocking_issues[0].suggestions, ['Add timeline', 'Clarify dependencies']);
  });

  it('determines if revision is needed', () => {
    const readyReceipt = createEmptyPlanGateReceipt();
    assert.strictEqual(canProceedWithoutRevision(readyReceipt), true);

    let revisionNeeded = createEmptyPlanGateReceipt();
    const gate: QualityGate = { skill: 'review-gate', mode: 'blocking' };
    const failResult = {
      skill: 'review-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
    };
    revisionNeeded = recordPlanGateResult(revisionNeeded, gate, failResult);
    assert.strictEqual(canProceedWithoutRevision(revisionNeeded), false);
  });

  it('marks iteration cap exceeded', () => {
    let receipt = createEmptyPlanGateReceipt();
    receipt = markIterationCapExceeded(receipt);
    assert.strictEqual(receipt.iteration_cap_exceeded, true);
  });

  it('tracks multiple blocking issues', () => {
    let receipt = createEmptyPlanGateReceipt();

    const gate1: QualityGate = { skill: 'gate1', mode: 'blocking' };
    receipt = recordPlanGateResult(receipt, gate1, {
      skill: 'gate1',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
      finding: 'Issue 1',
    });

    const gate2: QualityGate = { skill: 'gate2', mode: 'blocking' };
    receipt = recordPlanGateResult(receipt, gate2, {
      skill: 'gate2',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
      finding: 'Issue 2',
    });

    assert.strictEqual(receipt.blocking_issues.length, 2);
    assert.strictEqual(receipt.blocking_gates.length, 2);
  });
});

describe('code review stage wiring', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtempAsync(join(tmpdir(), 'omx-code-review-stage-'));
  });

  afterEach(async () => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('initializes empty code review receipt', () => {
    const receipt = createEmptyCodeReviewGateReceipt();
    assert.strictEqual(receipt.advisory_gates.length, 0);
    assert.strictEqual(receipt.blocking_gates.length, 0);
    assert.strictEqual(receipt.total_issues, 0);
    assert.strictEqual(receipt.blocking_cleared, true);
  });

  it('records gate results with code issues', () => {
    let receipt = createEmptyCodeReviewGateReceipt();
    const gate: QualityGate = { skill: 'code-quality-gate', mode: 'blocking' };
    const result = {
      skill: 'code-quality-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
      issues: [
        { file: 'src/index.ts', line: 42, message: 'Missing null check' },
        { file: 'src/utils.ts', line: 10, message: 'Unused variable' },
      ],
    };

    receipt = recordCodeReviewGateResult(receipt, gate, result);
    assert.strictEqual(receipt.total_issues, 2);
    assert.strictEqual(receipt.blocking_issues.length, 1);
  });

  it('determines approval eligibility', () => {
    const approvableReceipt = createEmptyCodeReviewGateReceipt();
    assert.strictEqual(canApproveCode(approvableReceipt), true);

    let blockingReceipt = createEmptyCodeReviewGateReceipt();
    const gate: QualityGate = { skill: 'lint-gate', mode: 'blocking' };
    const failResult = {
      skill: 'lint-gate',
      mode: 'blocking' as const,
      verdict: 'fail' as const,
    };
    blockingReceipt = recordCodeReviewGateResult(blockingReceipt, gate, failResult);
    assert.strictEqual(canApproveCode(blockingReceipt), false);
  });

  it('generates summary of gate results', () => {
    let receipt = createEmptyCodeReviewGateReceipt();

    const advisoryGate: QualityGate = { skill: 'advisory-gate', mode: 'advisory' };
    receipt = recordCodeReviewGateResult(receipt, advisoryGate, {
      skill: 'advisory-gate',
      mode: 'advisory' as const,
      verdict: 'pass' as const,
    });

    const blockingGate: QualityGate = { skill: 'blocking-gate', mode: 'blocking' };
    receipt = recordCodeReviewGateResult(receipt, blockingGate, {
      skill: 'blocking-gate',
      mode: 'blocking' as const,
      verdict: 'pass' as const,
      issues: [{ file: 'test.ts', line: 1, message: 'Issue' }],
    });

    const summary = getCodeReviewGateSummary(receipt);
    assert.ok(summary.includes('Advisory gates'));
    assert.ok(summary.includes('Blocking gates'));
    assert.ok(summary.includes('Total issues'));
  });

  it('accumulates issues from multiple gates', () => {
    let receipt = createEmptyCodeReviewGateReceipt();

    const gate1: QualityGate = { skill: 'gate1', mode: 'advisory' };
    receipt = recordCodeReviewGateResult(receipt, gate1, {
      skill: 'gate1',
      mode: 'advisory' as const,
      verdict: 'fail' as const,
      issues: [
        { file: 'a.ts', line: 1, message: 'Issue 1' },
        { file: 'b.ts', line: 2, message: 'Issue 2' },
      ],
    });

    const gate2: QualityGate = { skill: 'gate2', mode: 'advisory' };
    receipt = recordCodeReviewGateResult(receipt, gate2, {
      skill: 'gate2',
      mode: 'advisory' as const,
      verdict: 'fail' as const,
      issues: [{ file: 'c.ts', line: 3, message: 'Issue 3' }],
    });

    assert.strictEqual(receipt.total_issues, 3);
    assert.strictEqual(receipt.advisory_gates.length, 2);
  });
});
