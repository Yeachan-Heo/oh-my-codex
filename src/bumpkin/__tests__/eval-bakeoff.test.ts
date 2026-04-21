import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FixtureModelProvider, recordEntry } from '../model/fixture-provider.js';
import { buildReviewerRequest } from '../skills/llm-reviewer.js';
import type { ModelResponse } from '../model/provider.js';
import {
  formatEvalReport,
  parseCorpusFromJsonl,
  runEval,
  type ReviewerEvalCorpus,
} from '../eval/run-eval.js';
import {
  formatBakeoffReport,
  runBakeoff,
  type BakeoffCase,
} from '../bakeoff/run-bakeoff.js';
import type { Gate, GateContext, CommandRunner } from '../gates/types.js';
import { buildPlannerRequest } from '../skills/upgrade-planner.js';

function resp(content: string): ModelResponse {
  return { content, stopReason: 'end_turn', inputTokens: 5, outputTokens: 5 };
}

const REVIEW_INPUT_OK = {
  diff: 'D-ok',
  failingTestOutput: 'T',
  releaseNotes: 'RN',
  libraryName: 'l',
  fromVersion: '1',
  toVersion: '2',
};
const REVIEW_INPUT_BAD = { ...REVIEW_INPUT_OK, diff: 'D-bad' };

describe('bumpkin/eval', () => {
  const corpus: ReviewerEvalCorpus = {
    kind: 'reviewer',
    cases: [
      { label: 'good', input: REVIEW_INPUT_OK, expectedVerdict: 'APPROVE' },
      { label: 'bad', input: REVIEW_INPUT_BAD, expectedVerdict: 'REJECT' },
    ],
  };

  it('runs a corpus through the provider and reports precision/recall', async () => {
    const provider = new FixtureModelProvider({
      recordings: [
        recordEntry(buildReviewerRequest(REVIEW_INPUT_OK), resp(JSON.stringify({ verdict: 'APPROVE', rationale: '' }))),
        recordEntry(buildReviewerRequest(REVIEW_INPUT_BAD), resp(JSON.stringify({ verdict: 'REJECT', rationale: '' }))),
      ],
    });
    const result = await runEval({ provider, corpus });
    assert.equal(result.report.total, 2);
    assert.equal(result.report.correct, 2);
    assert.equal(result.meetsThresholds, true);
    assert.deepEqual(result.failures, []);
  });

  it('fails thresholds when precision is below minimum', async () => {
    const provider = new FixtureModelProvider({
      recordings: [
        recordEntry(buildReviewerRequest(REVIEW_INPUT_OK), resp(JSON.stringify({ verdict: 'APPROVE', rationale: '' }))),
        recordEntry(buildReviewerRequest(REVIEW_INPUT_BAD), resp(JSON.stringify({ verdict: 'APPROVE', rationale: 'wrong' }))),
      ],
    });
    const result = await runEval({ provider, corpus });
    assert.equal(result.meetsThresholds, false);
    assert.ok(result.failures.some((f) => f.startsWith('precision')));
  });

  it('parseCorpusFromJsonl accepts and rejects lines correctly', () => {
    const jsonl = [
      JSON.stringify({ label: 'a', input: REVIEW_INPUT_OK, expectedVerdict: 'APPROVE' }),
      '',
      JSON.stringify({ label: 'b', input: REVIEW_INPUT_BAD, expectedVerdict: 'REJECT' }),
    ].join('\n');
    const parsed = parseCorpusFromJsonl(jsonl);
    assert.equal(parsed.cases.length, 2);
    assert.throws(() => parseCorpusFromJsonl('{"label": "a"}'), /invalid corpus line/);
  });

  it('formatEvalReport renders threshold status', () => {
    const out = formatEvalReport('reviewer', {
      report: { total: 4, correct: 3, precision: 0.9, recall: 1, truePositives: 2, falsePositives: 0, falseNegatives: 1, trueNegatives: 1 },
      meetsThresholds: false,
      failures: ['precision 0.900 < required 0.95'],
    });
    assert.match(out, /Eval report: reviewer/);
    assert.match(out, /❌ Fails thresholds/);
  });
});

describe('bumpkin/bakeoff', () => {
  function buildDeps(status: 'ship' | 'escalated'): ReturnType<BakeoffCase['depsFactory']> {
    const dependencies = [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }];
    const plannerResp = resp(
      JSON.stringify({
        order: [{ name: 'lodash', from: '4.17.0', to: '4.17.21', rationale: 'p', riskLevel: 'low' }],
      }),
    );
    const planner = new FixtureModelProvider({
      recordings: [recordEntry(buildPlannerRequest({ dependencies }), plannerResp)],
    });
    const reviewer = new FixtureModelProvider({
      recordings: [
        recordEntry(
          buildReviewerRequest({
            diff: 'see-workspace',
            failingTestOutput: 'no',
            releaseNotes: 'n',
            libraryName: 'lodash',
            fromVersion: '4.17.0',
            toVersion: '4.17.21',
          }),
          resp(JSON.stringify({ verdict: 'APPROVE', rationale: 'ok' })),
        ),
      ],
    });
    const fixer = new FixtureModelProvider({ recordings: [] });

    const passingGate = (name: string): Gate => ({
      name,
      run: async () => ({ pass: true, reason: `${name} passed` }),
    });

    const runner: CommandRunner = async () => ({ code: 0, stdout: '', stderr: '' });
    const gateCtx: GateContext = { workspacePath: '/ws', run: runner };

    const diffPaths = status === 'ship' ? ['src/utils/helper.ts'] : ['src/auth/token.ts'];

    return {
      planner,
      fixer,
      reviewer,
      router: {
        oss: { providerId: 'g' },
        frontier: { providerId: 'a' },
      },
      gates: [
        passingGate('verify-tests'),
        passingGate('verify-types'),
        passingGate('verify-build'),
        passingGate('verify-lint'),
        passingGate('verify-preview'),
        passingGate('verify-apisurface'),
        passingGate('verify-bundle-size'),
      ],
      applyUpgrade: async () => {},
      applyFixDiff: async () => {},
      gateContext: gateCtx,
      libraryApiDelta: async () => ({
        libraryName: 'lodash',
        fromVersion: '4.17.0',
        toVersion: '4.17.21',
        summary: 's',
      }),
      failingTestForGate: () => ({ file: 'x', name: 'x', output: 'no' }),
      sourceSnippet: async () => '',
      releaseNotes: async () => 'n',
      expectedSurface: ['src/**'],
      diffPaths: () => diffPaths,
      diffLineCount: () => 10,
      now: () => '2026-01-01T00:00:00.000Z',
    };
  }

  it('runs the pipeline against multiple cases and reports pass rate', async () => {
    const cases: BakeoffCase[] = [
      {
        label: 'happy-path',
        input: { dependencies: [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }] },
        depsFactory: () => buildDeps('ship'),
        expectedStatus: 'ready-to-ship',
      },
      {
        label: 'safety-critical',
        input: { dependencies: [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }] },
        depsFactory: () => buildDeps('escalated'),
        expectedStatus: 'escalated',
      },
    ];
    const report = await runBakeoff(cases);
    assert.equal(report.total, 2);
    assert.equal(report.passed, 2);
    assert.equal(report.failed, 0);
  });

  it('formatBakeoffReport renders a markdown table with pass/fail', async () => {
    const cases: BakeoffCase[] = [
      {
        label: 'x',
        input: { dependencies: [{ name: 'lodash', current: '4.17.0', latest: '4.17.21' }] },
        depsFactory: () => buildDeps('ship'),
        expectedStatus: 'ready-to-ship',
      },
    ];
    const report = await runBakeoff(cases);
    const out = formatBakeoffReport(report);
    assert.match(out, /Bakeoff report/);
    assert.match(out, /Pass rate: 100\.0%/);
    assert.match(out, /✅/);
  });
});
