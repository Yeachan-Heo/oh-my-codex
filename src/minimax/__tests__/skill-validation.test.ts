import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessMinimaxCompletionState } from '../skill-validation.js';

async function writeVerificationArtifact(cwd: string, step: number): Promise<string> {
  const dir = join(cwd, '.omx', 'minimax');
  await mkdir(dir, { recursive: true });
  const relativePath = `.omx/minimax/verification-step-${step}.json`;
  await writeFile(join(cwd, relativePath), JSON.stringify({
    schema_version: 'minimax-verification-v1',
    step,
    status: 'passed',
    passed: true,
  }));
  return relativePath;
}

describe('minimax skill validation', () => {
  it('requires an arbiter complete decision before completion', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      arbiter_decision: 'continue',
      verification_evidence: ['tests passed'],
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'arbiter_not_complete');
    assert.equal(status.arbiterDecision, 'continue');
  });

  it('requires verification evidence for arbiter complete', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      arbiter_decision: 'complete',
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'missing_verification_evidence');
  });

  it('accepts arbiter complete with a passing verification artifact', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-minimax-verification-'));
    try {
      const verificationPath = await writeVerificationArtifact(cwd, 1);
      const status = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['npm run build', 'targeted tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationPath,
      }, cwd);

      assert.equal(status.complete, true);
      assert.equal(status.reason, 'arbiter_complete_with_evidence');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not accept self-attested inline evidence without a passing artifact', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      step: 1,
      arbiter_decision: 'complete',
      verification_evidence: ['npm run build'],
      verification_evidence_step: 1,
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'missing_or_invalid_verification_artifact');
  });

  it('rejects stale verification evidence when step-scoped evidence is required', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      step: 4,
      arbiter_decision: 'complete',
      verification_evidence: ['old test run'],
      verification_evidence_step: 3,
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'stale_verification_evidence');
  });

  it('requires step-scoped verification evidence even when step is omitted', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      arbiter_decision: 'complete',
      verification_evidence: ['unscoped test run'],
      verification_evidence_step: 1,
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'stale_verification_evidence');
  });

  it('requires passing council evidence when council is required', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-minimax-validation-'));
    try {
      const councilDir = join(cwd, '.omx', 'file-council', 'minimax');
      await mkdir(councilDir, { recursive: true });
      const verificationStep1 = await writeVerificationArtifact(cwd, 1);
      const verificationStep2 = await writeVerificationArtifact(cwd, 2);
      await writeFile(join(councilDir, 'summary.json'), JSON.stringify({
        schema_version: 'file-council-summary-v1',
        verdict: { status: 'no_blockers' },
        blockers: [],
        scorecard: { blocker_count: 0 },
        council_degraded: false,
      }));
      await writeFile(join(councilDir, 'member-review.json'), JSON.stringify({
        schema_version: 'file-council-review-v1',
        verdict: { status: 'pass' },
        blockers: [],
      }));
      await writeFile(join(councilDir, 'fake-pass.json'), JSON.stringify({
        verdict: { status: 'pass' },
        blockers: [],
      }));
      await writeFile(join(councilDir, 'incomplete-summary.json'), JSON.stringify({
        schema_version: 'file-council-summary-v1',
        verdict: { status: 'no_blockers' },
        blockers: [],
      }));
      await writeFile(join(councilDir, 'invalid.md'), 'No structured verdict here.');
      await writeFile(join(councilDir, 'scalar.json'), JSON.stringify({
        verdict: 'pass',
      }));
      await writeFile(join(councilDir, 'blocked.json'), JSON.stringify({
        schema_version: 'file-council-summary-v1',
        verdict: { status: 'pass' },
        blockers: [{ title: 'real blocker' }],
        scorecard: { blocker_count: 1 },
      }));

      const missingCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
      }, cwd);
      assert.equal(missingCouncil.complete, false);
      assert.equal(missingCouncil.reason, 'missing_required_council_artifact');

      const invalidCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_artifact_path: '.omx/file-council/minimax/invalid.md',
      }, cwd);
      assert.equal(invalidCouncil.complete, false);
      assert.equal(invalidCouncil.reason, 'missing_required_council_artifact');

      const scalarCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/scalar.json',
      }, cwd);
      assert.equal(scalarCouncil.complete, false);
      assert.equal(scalarCouncil.reason, 'missing_required_council_artifact');

      const fakeCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/fake-pass.json',
      }, cwd);
      assert.equal(fakeCouncil.complete, false);
      assert.equal(fakeCouncil.reason, 'missing_required_council_artifact');

      const incompleteSummary = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/incomplete-summary.json',
      }, cwd);
      assert.equal(incompleteSummary.complete, false);
      assert.equal(incompleteSummary.reason, 'missing_required_council_artifact');

      const blockedCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/blocked.json',
      }, cwd);
      assert.equal(blockedCouncil.complete, false);
      assert.equal(blockedCouncil.reason, 'missing_required_council_artifact');

      const withCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/summary.json',
      }, cwd);
      assert.equal(withCouncil.complete, true);
      assert.equal(withCouncil.reason, 'arbiter_complete_with_evidence');

      const withMemberReview = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 1,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 1,
        verification_evidence_path: verificationStep1,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/member-review.json',
      }, cwd);
      assert.equal(withMemberReview.complete, false);
      assert.equal(withMemberReview.reason, 'missing_required_council_artifact');

      const staleCouncil = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 2,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 2,
        verification_evidence_path: verificationStep2,
        council_required: true,
        council_evidence_step: 1,
        council_artifact_path: '.omx/file-council/minimax/summary.json',
      }, cwd);
      assert.equal(staleCouncil.complete, false);
      assert.equal(staleCouncil.reason, 'stale_council_evidence');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires council evidence after a recorded escalation even with seeded council defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-minimax-escalation-'));
    try {
      const verificationPath = await writeVerificationArtifact(cwd, 2);
      const status = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 2,
        arbiter_decision: 'complete',
        verification_evidence: ['tests passed'],
        verification_evidence_step: 2,
        verification_evidence_path: verificationPath,
        min_verdict: 'escalate',
        completion_gate: {
          council_artifact_required_when_escalated: true,
        },
        state: {
          council: {
            required: false,
            artifact_path: null,
            verdict: null,
          },
        },
      }, cwd);

      assert.equal(status.complete, false);
      assert.equal(status.reason, 'missing_required_council_artifact');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps the council gate sticky after a prior escalation is recorded', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-minimax-sticky-escalation-'));
    try {
      const verificationPath = await writeVerificationArtifact(cwd, 4);
      const status = await assessMinimaxCompletionState({
        mode: 'minimax',
        step: 4,
        arbiter_decision: 'complete',
        min_verdict: 'continue',
        escalated: true,
        verification_evidence: ['tests passed'],
        verification_evidence_step: 4,
        verification_evidence_path: verificationPath,
      }, cwd);

      assert.equal(status.complete, false);
      assert.equal(status.reason, 'missing_required_council_artifact');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats minimax completion gate requirements as non-weakenable invariants', async () => {
    const status = await assessMinimaxCompletionState({
      mode: 'minimax',
      step: 3,
      arbiter_decision: 'complete',
      verification_evidence: ['stale test run'],
      verification_evidence_step: 2,
      min_verdict: 'escalate',
      completion_gate: {
        fresh_verification_evidence_required: false,
        council_artifact_required_when_escalated: false,
      },
    }, process.cwd());

    assert.equal(status.complete, false);
    assert.equal(status.reason, 'stale_verification_evidence');
  });
});
