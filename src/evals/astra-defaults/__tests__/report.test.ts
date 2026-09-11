import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderReport, summarize, weightedPassRates } from '../report.js';
import type { EvalSuite, RunRecord } from '../types.js';

const suite: EvalSuite = {
  fixtures: [
    {
      id: 'a',
      surface: 'explore',
      title: 'a',
      prompt: 'a',
      inputs: {},
      checks: [{ kind: 'must-include', name: 'c', values: ['x'] }],
    },
    {
      id: 'b',
      surface: 'sparkshell',
      title: 'b',
      prompt: 'b',
      inputs: {},
      checks: [{ kind: 'must-include', name: 'c', values: ['x'] }],
    },
  ],
  configs: [
    {
      id: 'astra-defaults',
      label: 'baseline',
      isBaseline: true,
      omxRevision: 'abc123',
      roles: {
        explore: { model: 'gpt-6-astra', reasoningEffort: 'medium' },
        sparkshell: { model: 'gpt-6-astra', reasoningEffort: 'medium' },
      },
      serviceTier: 'unknown',
      cacheConditions: 'unknown',
    },
  ],
};

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    fixtureId: 'a',
    configId: 'astra-defaults',
    outcome: 'pass',
    checks: [{ name: 'c', kind: 'must-include', passed: true }],
    requiredChecksPassed: true,
    retries: 0,
    latencyMs: 1000,
    usage: { inputTokens: 100, outputTokens: 20 },
    operatorMinutes: 2,
    difficult: false,
    ...overrides,
  };
}

describe('summarize', () => {
  it('marks aggregate usage unknown when any record lacks attribution', () => {
    const summary = summarize(
      [record(), record({ fixtureId: 'b', usage: null })],
      'astra-defaults',
    );
    assert.equal(summary.totalUsage, null);
    assert.equal(summary.usageAttributionComplete, false);
    assert.equal(summary.totalLatencyMs, 2000);
  });

  it('keeps operator effort separate and marks it unknown when missing', () => {
    const summary = summarize(
      [record(), record({ fixtureId: 'b', operatorMinutes: null })],
      'astra-defaults',
    );
    assert.equal(summary.totalOperatorMinutes, null);
    assert.equal(summary.operatorAttributionComplete, false);
    assert.notEqual(summary.totalUsage, null);
  });

  it('counts failures, errors, difficult cases and retries', () => {
    const summary = summarize(
      [
        record({ outcome: 'fail', retries: 2 }),
        record({
          fixtureId: 'b',
          outcome: 'error',
          difficult: true,
          retries: 1,
        }),
      ],
      'astra-defaults',
    );
    assert.deepEqual(
      [summary.passed, summary.failed, summary.errored, summary.difficult, summary.retries],
      [0, 1, 1, 1, 3],
    );
  });
});

describe('weightedPassRates', () => {
  it('refuses to weight without documented frequencies for every evaluated fixture', () => {
    const records = [record(), record({ fixtureId: 'b' })];
    assert.equal(weightedPassRates(suite, records, null), null);
    assert.equal(weightedPassRates(suite, records, { a: 3 }), null);
  });

  it('weights pass rate by documented frequency', () => {
    const records = [record(), record({ fixtureId: 'b', outcome: 'fail' })];
    const weighted = weightedPassRates(suite, records, { a: 3, b: 1 });
    assert.deepEqual(weighted, [{ configId: 'astra-defaults', weightedPassRate: 0.75 }]);
  });
});

describe('renderReport', () => {
  it('reports unknown usage instead of a cost claim and omits weighted savings', () => {
    const report = renderReport(suite, [record(), record({ fixtureId: 'b', usage: null })]);
    assert.match(report, /No complete cost claim is made/);
    assert.match(report, /\| unknown \|/);
    assert.match(report, /Not reported: documented, representative task frequencies are missing/);
    assert.match(report, /A lower token count alone is not a successful result\./);
  });

  it('lists failed and difficult cases separately with check detail', () => {
    const report = renderReport(suite, [
      record({
        outcome: 'fail',
        checks: [
          {
            name: 'c',
            kind: 'must-include',
            passed: false,
            detail: 'missing: x',
          },
        ],
      }),
      record({ fixtureId: 'b', difficult: true }),
    ]);
    assert.match(report, /## Failed and difficult cases/);
    assert.match(report, /`a` @ `astra-defaults`: fail — c: missing: x/);
    assert.match(report, /`b` @ `astra-defaults`: pass \(difficult\)/);
  });

  it('pins the inspectable configuration table', () => {
    const report = renderReport(suite, [record()]);
    assert.match(
      report,
      /\| astra-defaults \| yes \| abc123 \| unknown \| unknown \| gpt-6-astra \/ medium/,
    );
  });
});
