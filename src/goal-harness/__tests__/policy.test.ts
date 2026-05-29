import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoalHarnessAnnealingChallenge,
  buildRefinedGoalPrompt,
  buildWorkerBoundaryInstruction,
  classifyGoalHarnessRoute,
  evaluateGoalHarnessCompletionGate,
} from '../policy.js';

describe('goal-harness policy', () => {
  it('refines a raw request into a single-goal Codex objective with OMX policy', () => {
    const refined = buildRefinedGoalPrompt('Build a new architecture for long-running autonomous research with team agents and verification.');

    assert.match(refined.objective, /Use one Codex goal as the single top-level source of truth/);
    assert.match(refined.objective, /deep-interview intake/);
    assert.match(refined.objective, /basin-escape challenge/);
    assert.match(refined.objective, /Only the leader calls update_goal/);
    assert.equal(refined.route.route, 'team_assisted');
    assert.ok(refined.route.recommendedSkills.includes('team'));
  });

  it('routes small bounded tasks away from heavy orchestration', () => {
    const decision = classifyGoalHarnessRoute('Fix a typo in README and verify the spelling.');

    assert.equal(decision.route, 'direct');
    assert.deepEqual(decision.recommendedSkills, []);
  });

  it('honors explicit team and persistence requests before direct routing', () => {
    const teamDecision = classifyGoalHarnessRoute('Use a team to pressure-test this tiny change.');
    const persistentDecision = classifyGoalHarnessRoute('Keep going persistently until this tiny change is verified.');

    assert.equal(teamDecision.route, 'team_assisted');
    assert.ok(teamDecision.recommendedSkills.includes('team'));
    assert.equal(persistentDecision.route, 'ralph_loop');
    assert.ok(persistentDecision.recommendedSkills.includes('ralph'));
  });

  it('uses late annealing as a basin-escape completion challenge', () => {
    const challenge = buildGoalHarnessAnnealingChallenge('late', 'team_assisted');

    assert.equal(challenge.strategy, 'converge');
    assert.ok(challenge.workerLanes.includes('critic'));
    assert.ok(challenge.workerLanes.includes('tester'));
    assert.match(challenge.stopRule, /basin-escape challenge/);
    assert.ok(challenge.requiredProbes.some((probe) => /independent alternative/.test(probe)));
  });

  it('renders worker instructions that forbid Codex goal mutation', () => {
    const instruction = buildWorkerBoundaryInstruction({
      role: 'critic',
      task: 'Attack the completion claim and return missed requirements.',
    });

    assert.match(instruction, /You do not own the Codex goal/);
    assert.match(instruction, /Do not call create_goal/);
    assert.match(instruction, /Do not call update_goal/);
    assert.match(instruction, /Return evidence/);
  });

  it('blocks completion until leader evidence passes all gates', () => {
    const workerDecision = evaluateGoalHarnessCompletionGate({
      actor: 'worker',
      objectiveAudit: 'audit',
      implementationEvidence: ['diff'],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic clear' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'basin escape passed' },
    });
    assert.equal(workerDecision.allowed, false);
    assert.match(workerDecision.blockers.join(' '), /only the leader/);

    const leaderDecision = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'all requirements mapped to evidence',
      implementationEvidence: ['src/goal-harness/policy.ts implemented'],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'all relevant tests passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic found no blockers' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'alternate route rejected by evidence' },
    });
    assert.equal(leaderDecision.allowed, true);
    assert.match(leaderDecision.nextAction, /update_goal/);
  });

  it('rejects weak completion evidence that only satisfies the JSON shape', () => {
    const emptyImplementation = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'requirements mapped',
      implementationEvidence: ['   '],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'focused tests passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic clear' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'two alternatives rejected by evidence' },
    });
    assert.equal(emptyImplementation.allowed, false);
    assert.match(emptyImplementation.missing.join(' '), /implementation evidence/);

    const missingAlternativeCount = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'requirements mapped',
      implementationEvidence: ['src/goal-harness/policy.ts tightened completion evidence checks'],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'focused tests passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic clear' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: Number.NaN, evidence: 'alternative rejected by evidence' },
    });
    assert.equal(missingAlternativeCount.allowed, false);
    assert.match(missingAlternativeCount.missing.join(' '), /basin-escape convergence challenge/);

    const adversarialIssues = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'requirements mapped',
      implementationEvidence: ['src/goal-harness/policy.ts tightened completion evidence checks'],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'focused tests passed' }],
      adversarialReview: { status: 'issues', evidence: 'critic found a missed completion edge case' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'alternative rejected by evidence' },
    });
    assert.equal(adversarialIssues.allowed, false);
    assert.match(adversarialIssues.blockers.join(' '), /adversarial review is issues/);
  });

  it('requires concrete verification targets and plural basin-escape alternatives', () => {
    const selfAssertedVerification = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'requirements mapped',
      implementationEvidence: ['src/goal-harness/policy.ts tightened completion evidence checks'],
      externalVerification: [{ status: 'pass', evidence: 'I inspected it and it passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic clear' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'two alternatives rejected by evidence' },
    });
    assert.equal(selfAssertedVerification.allowed, false);
    assert.match(selfAssertedVerification.missing.join(' '), /concrete external verification command or artifact path/);

    const singleAlternative = evaluateGoalHarnessCompletionGate({
      actor: 'leader',
      objectiveAudit: 'requirements mapped',
      implementationEvidence: ['src/goal-harness/policy.ts tightened completion evidence checks'],
      externalVerification: [{ command: 'npm test', status: 'pass', evidence: 'focused tests passed' }],
      adversarialReview: { status: 'clear', evidence: 'critic clear' },
      convergenceChallenge: { status: 'passed', alternativesConsidered: 1, evidence: 'only one alternative was considered' },
    });
    assert.equal(singleAlternative.allowed, false);
    assert.match(singleAlternative.missing.join(' '), /at least two alternatives/);
  });
});
