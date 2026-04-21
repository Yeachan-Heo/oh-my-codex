import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FixtureModelProvider, recordEntry } from '../model/fixture-provider.js';
import type { ModelResponse } from '../model/provider.js';
import {
  PlannerResponseError,
  buildPlannerRequest,
  parsePlannerResponse,
  planUpgrades,
} from '../skills/upgrade-planner.js';
import {
  FixerResponseError,
  buildMechanicalFixerRequest,
  parseFixerResponse,
  proposeMechanicalFix,
} from '../skills/mechanical-fixer.js';
import {
  buildReasoningFixerRequest,
  proposeReasoningFix,
} from '../skills/reasoning-fixer.js';
import {
  ReviewerResponseError,
  buildReviewerRequest,
  evaluateReviewer,
  parseReviewerResponse,
  reviewFix,
} from '../skills/llm-reviewer.js';

function resp(content: string): ModelResponse {
  return { content, stopReason: 'end_turn', inputTokens: 0, outputTokens: 0 };
}

describe('bumpkin/upgrade-planner', () => {
  it('builds a request with the dependencies formatted', () => {
    const req = buildPlannerRequest({
      dependencies: [
        { name: 'lodash', current: '4.17.0', latest: '4.17.21' },
        { name: 'react', current: '17.0.0', latest: '19.0.0', changelog: 'http://x' },
      ],
    });
    const userMsg = req.messages[0]?.content;
    assert.ok(userMsg);
    assert.match(userMsg, /lodash: 4\.17\.0 -> 4\.17\.21/);
    assert.match(userMsg, /react: 17\.0\.0 -> 19\.0\.0 \(http/);
  });

  it('parses a valid planner response', () => {
    const plan = parsePlannerResponse(
      JSON.stringify({
        order: [
          { name: 'lodash', from: '4.17.0', to: '4.17.21', rationale: 'patch', riskLevel: 'low' },
          { name: 'react', from: '17.0.0', to: '19.0.0', rationale: 'major', riskLevel: 'high' },
        ],
      }),
    );
    assert.equal(plan.order.length, 2);
    assert.equal(plan.order[0]?.riskLevel, 'low');
    assert.equal(plan.order[1]?.riskLevel, 'high');
  });

  it('normalizes unknown risk levels to medium', () => {
    const plan = parsePlannerResponse(
      JSON.stringify({ order: [{ name: 'x', from: '1', to: '2', rationale: 'r', riskLevel: 'EXTREME' }] }),
    );
    assert.equal(plan.order[0]?.riskLevel, 'medium');
  });

  it('rejects malformed planner output', () => {
    assert.throws(() => parsePlannerResponse('not json'), PlannerResponseError);
    assert.throws(() => parsePlannerResponse('{}'), PlannerResponseError);
    assert.throws(
      () => parsePlannerResponse(JSON.stringify({ order: [{ name: 'x' }] })),
      PlannerResponseError,
    );
  });

  it('planUpgrades integrates with FixtureModelProvider end-to-end', async () => {
    const input = { dependencies: [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }] };
    const request = buildPlannerRequest(input);
    const provider = new FixtureModelProvider({
      recordings: [
        recordEntry(
          request,
          resp(
            JSON.stringify({
              order: [{ name: 'lodash', from: '4.17.0', to: '4.17.21', rationale: 'patch only', riskLevel: 'low' }],
            }),
          ),
        ),
      ],
    });
    const plan = await planUpgrades(provider, input);
    assert.equal(plan.order[0]?.name, 'lodash');
  });
});

describe('bumpkin/mechanical-fixer', () => {
  it('builds a request referencing the failing test and library delta', () => {
    const req = buildMechanicalFixerRequest({
      failingTest: { file: 't.test.ts', name: 'renders', output: 'TypeError: x is not a function' },
      libraryApiDelta: {
        libraryName: 'react',
        fromVersion: '17',
        toVersion: '19',
        summary: 'ReactDOM.render → createRoot',
      },
      sourceSnippet: 'ReactDOM.render(<App/>, root);',
    });
    const userMsg = req.messages[0]?.content;
    assert.ok(userMsg);
    assert.match(userMsg, /react 17 -> 19/);
    assert.match(userMsg, /ReactDOM\.render/);
  });

  it('parses a valid fixer response', () => {
    const p = parseFixerResponse(
      JSON.stringify({ diff: '--- a\n+++ b\n-x\n+y\n', explanation: 'rename' }),
    );
    assert.match(p.diff, /^--- a/);
    assert.equal(p.explanation, 'rename');
  });

  it('rejects fixer output without a diff', () => {
    assert.throws(() => parseFixerResponse(JSON.stringify({ explanation: 'none' })), FixerResponseError);
  });

  it('proposeMechanicalFix wires provider → parser', async () => {
    const input = {
      failingTest: { file: 't.test.ts', name: 'renders', output: 'error' },
      libraryApiDelta: { libraryName: 'react', fromVersion: '17', toVersion: '19', summary: 's' },
      sourceSnippet: 'src',
    };
    const req = buildMechanicalFixerRequest(input);
    const provider = new FixtureModelProvider({
      recordings: [recordEntry(req, resp(JSON.stringify({ diff: 'D', explanation: 'E' })))],
    });
    const result = await proposeMechanicalFix(provider, input);
    assert.equal(result.diff, 'D');
  });
});

describe('bumpkin/reasoning-fixer', () => {
  it('includes release notes and previous attempts in the prompt', () => {
    const req = buildReasoningFixerRequest({
      failingTest: { file: 't.ts', name: 't', output: 'err' },
      libraryApiDelta: { libraryName: 'lib', fromVersion: '1', toVersion: '2', summary: 's' },
      sourceSnippet: 'src',
      releaseNotes: 'BREAKING: new async semantics',
      previousAttempts: [{ diff: 'D1', testOutput: 'still failing' }],
    });
    const userMsg = req.messages[0]?.content;
    assert.ok(userMsg);
    assert.match(userMsg, /BREAKING: new async semantics/);
    assert.match(userMsg, /Previous failed attempts \(1\)/);
    assert.match(userMsg, /D1/);
  });

  it('proposeReasoningFix works with FixtureModelProvider', async () => {
    const input = {
      failingTest: { file: 't', name: 't', output: 'e' },
      libraryApiDelta: { libraryName: 'l', fromVersion: '1', toVersion: '2', summary: 's' },
      sourceSnippet: 'src',
      releaseNotes: 'notes',
    };
    const req = buildReasoningFixerRequest(input);
    const provider = new FixtureModelProvider({
      recordings: [recordEntry(req, resp(JSON.stringify({ diff: 'REASONED', explanation: 'ok' })))],
    });
    const result = await proposeReasoningFix(provider, input);
    assert.equal(result.diff, 'REASONED');
  });
});

describe('bumpkin/llm-reviewer', () => {
  it('parses APPROVE and REJECT verdicts', () => {
    const a = parseReviewerResponse(JSON.stringify({ verdict: 'APPROVE', rationale: 'ok' }));
    assert.equal(a.verdict, 'APPROVE');
    const r = parseReviewerResponse(JSON.stringify({ verdict: 'REJECT', rationale: 'nope' }));
    assert.equal(r.verdict, 'REJECT');
  });

  it('rejects malformed reviewer output', () => {
    assert.throws(
      () => parseReviewerResponse(JSON.stringify({ verdict: 'MAYBE' })),
      ReviewerResponseError,
    );
  });

  it('reviewFix builds the request with release notes + diff', () => {
    const req = buildReviewerRequest({
      diff: 'D',
      failingTestOutput: 'T',
      releaseNotes: 'RN',
      libraryName: 'l',
      fromVersion: '1',
      toVersion: '2',
    });
    const userMsg = req.messages[0]?.content;
    assert.ok(userMsg);
    assert.match(userMsg, /l 1 -> 2/);
    assert.match(userMsg, /Release notes:\nRN/);
    assert.match(userMsg, /Proposed diff:\nD/);
  });

  it('evaluateReviewer computes precision and recall against labeled cases', async () => {
    const input1 = {
      diff: 'D1',
      failingTestOutput: 'T',
      releaseNotes: 'RN',
      libraryName: 'l',
      fromVersion: '1',
      toVersion: '2',
    };
    const input2 = { ...input1, diff: 'D2' };
    const input3 = { ...input1, diff: 'D3' };

    const provider = new FixtureModelProvider({
      recordings: [
        recordEntry(buildReviewerRequest(input1), resp(JSON.stringify({ verdict: 'APPROVE', rationale: '' }))),
        recordEntry(buildReviewerRequest(input2), resp(JSON.stringify({ verdict: 'REJECT', rationale: '' }))),
        recordEntry(buildReviewerRequest(input3), resp(JSON.stringify({ verdict: 'APPROVE', rationale: '' }))),
      ],
    });

    const report = await evaluateReviewer(provider, [
      { label: 'good-fix', input: input1, expectedVerdict: 'APPROVE' },
      { label: 'bad-fix', input: input2, expectedVerdict: 'REJECT' },
      { label: 'false-positive', input: input3, expectedVerdict: 'REJECT' },
    ]);

    assert.equal(report.total, 3);
    assert.equal(report.truePositives, 1);
    assert.equal(report.falsePositives, 1);
    assert.equal(report.trueNegatives, 1);
    assert.equal(report.falseNegatives, 0);
    assert.equal(report.precision, 0.5);
    assert.equal(report.recall, 1);
  });

  it('reviewFix wires provider → parser with fixture replay', async () => {
    const input = {
      diff: 'D',
      failingTestOutput: 'T',
      releaseNotes: 'RN',
      libraryName: 'l',
      fromVersion: '1',
      toVersion: '2',
    };
    const req = buildReviewerRequest(input);
    const provider = new FixtureModelProvider({
      recordings: [
        recordEntry(req, resp(JSON.stringify({ verdict: 'APPROVE', rationale: 'looks good' }))),
      ],
    });
    const result = await reviewFix(provider, input);
    assert.equal(result.verdict, 'APPROVE');
    assert.equal(result.rationale, 'looks good');
  });
});
