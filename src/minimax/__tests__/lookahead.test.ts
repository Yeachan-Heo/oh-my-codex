import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDefaultMinimaxLookaheadPolicy,
  minimaxBranchFactorForRisk,
  normalizeMinimaxLookaheadPolicy,
  rankMinimaxLookaheadBranches,
  scoreMinimaxLookaheadBranch,
  selectMinimaxLookaheadBranch,
  selectMinimaxLookaheadBranchesForRisk,
  type MinimaxLookaheadBranch,
} from '../lookahead.js';

function branch(overrides: Partial<MinimaxLookaheadBranch>): MinimaxLookaheadBranch {
  return {
    id: 'A',
    max_action: 'Run targeted test',
    next_state: 'Evidence is fresh',
    value: 5,
    risk: 2,
    evidence_strength: 5,
    reversible: true,
    scope_expansion: 0,
    expected_evidence: ['test output'],
    ...overrides,
  };
}

describe('minimax lookahead policy', () => {
  it('uses bounded depth and risk-based branch factors', () => {
    const policy = buildDefaultMinimaxLookaheadPolicy();

    assert.equal(policy.schema_version, 'minimax-lookahead-policy-v1');
    assert.equal(policy.depth, 2);
    assert.equal(policy.max_branches, 3);
    assert.equal(minimaxBranchFactorForRisk('low', policy), 1);
    assert.equal(minimaxBranchFactorForRisk('medium', policy), 2);
    assert.equal(minimaxBranchFactorForRisk('high', policy), 3);
  });

  it('scores value and evidence against risk and scope growth', () => {
    const score = scoreMinimaxLookaheadBranch(branch({
      value: 8,
      evidence_strength: 6,
      reversible: true,
      risk: 3,
      scope_expansion: 2,
    }));

    assert.equal(score, 11);
  });

  it('normalizes partial or oversized persisted policies', () => {
    const policy = normalizeMinimaxLookaheadPolicy({
      depth: 9,
      branch_factor_by_risk: { low: 0, medium: 4 },
      max_branches: 99,
    });

    assert.equal(policy.depth, 2);
    assert.equal(policy.max_branches, 3);
    assert.deepEqual(policy.branch_factor_by_risk, { low: 1, medium: 3, high: 3 });
    assert.equal(policy.scoring.reversibility_bonus, 2);
    assert.equal(policy.progressive_widening.add_branch_when_public_contract_changes, true);
  });

  it('clamps branch metrics to the documented 0-10 range before scoring', () => {
    assert.equal(scoreMinimaxLookaheadBranch(branch({
      value: 1000,
      evidence_strength: 1000,
      reversible: false,
      risk: -10,
      scope_expansion: -10,
    })), 20);
  });

  it('ranks by score, lower risk, then stable id', () => {
    const ranked = rankMinimaxLookaheadBranches([
      branch({ id: 'C', value: 6, risk: 2, evidence_strength: 4, reversible: false }),
      branch({ id: 'B', value: 6, risk: 1, evidence_strength: 3, reversible: false }),
      branch({ id: 'A', value: 10, risk: 7, evidence_strength: 2, reversible: false }),
    ]);

    assert.deepEqual(ranked.map((item) => item.id), ['B', 'C', 'A']);
    assert.deepEqual(ranked.map((item) => item.score), [8, 8, 5]);
  });

  it('selects the top branch or null for empty input', () => {
    assert.equal(selectMinimaxLookaheadBranch([]), null);
    assert.equal(selectMinimaxLookaheadBranch([
      branch({ id: 'risky', value: 9, risk: 8, evidence_strength: 1, reversible: false }),
      branch({ id: 'safe', value: 5, risk: 1, evidence_strength: 4, reversible: true }),
    ])?.id, 'safe');
  });

  it('limits reviewed branches by workflow risk', () => {
    const branches = [
      branch({ id: 'A', value: 10, risk: 1 }),
      branch({ id: 'B', value: 9, risk: 1 }),
      branch({ id: 'C', value: 8, risk: 1 }),
      branch({ id: 'D', value: 7, risk: 1 }),
    ];

    assert.deepEqual(selectMinimaxLookaheadBranchesForRisk(branches, 'low').map((item) => item.id), ['A']);
    assert.deepEqual(selectMinimaxLookaheadBranchesForRisk(branches, 'medium').map((item) => item.id), ['A', 'B']);
    assert.deepEqual(selectMinimaxLookaheadBranchesForRisk(branches, 'high').map((item) => item.id), ['A', 'B', 'C']);
  });
});
