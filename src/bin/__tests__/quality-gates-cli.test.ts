import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qualityGatesCommand } from '../quality-gates-cli.js';

describe('quality-gates CLI', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omx-quality-gates-cli-'));
    writeFileSync(
      join(home, '.omx-config.json'),
      JSON.stringify({
        qualityGates: {
          'deep-interview': ['interview-check'],
          'ralplan': ['plan-check', 'design-review'],
          'code-review': ['code-check'],
        },
      }),
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists normalized gates for a specified stage', () => {
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    assert.deepEqual(result, {
      gates: [
        { skill: 'plan-check', mode: 'blocking' },
        { skill: 'design-review', mode: 'blocking' },
      ],
      stage: 'ralplan',
    });
  });

  it('returns an empty list for an unconfigured stage', () => {
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'code-review'], home));
    assert.deepEqual(result, {
      gates: [{ skill: 'code-check', mode: 'blocking' }],
      stage: 'code-review',
    });

    writeFileSync(
      join(home, '.omx-config.json'),
      JSON.stringify({ qualityGates: { 'deep-interview': ['interview-check'] } }),
    );
    const emptyResult = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    assert.deepEqual(emptyResult, {
      gates: [],
      stage: 'ralplan',
    });
  });

  it('normalizes object entries with mode and model', () => {
    writeFileSync(
      join(home, '.omx-config.json'),
      JSON.stringify({
        qualityGates: {
          'ralplan': [
            { skill: 'blocking-gate', mode: 'blocking' },
            { skill: 'advisory-gate', mode: 'advisory' },
            { skill: 'model-gate', model: 'claude-opus' },
            { skill: 'full-config', mode: 'advisory', model: 'claude-sonnet' },
          ],
        },
      }),
    );
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    assert.deepEqual(result, {
      gates: [
        { skill: 'blocking-gate', mode: 'blocking' },
        { skill: 'advisory-gate', mode: 'advisory' },
        { skill: 'model-gate', mode: 'blocking', model: 'claude-opus' },
        { skill: 'full-config', mode: 'advisory', model: 'claude-sonnet' },
      ],
      stage: 'ralplan',
    });
  });

  it('rejects invalid stages, missing stages, unsupported commands and unknown flags', () => {
    for (const args of [
      ['list', '--stage', 'invalid'],
      ['list', '--stage', 'plan'], // old camelCase stage name
      ['list'],
      ['list', '--stage'],
      ['run', '--stage', 'ralplan'],
      ['list', '--stage', 'ralplan', '--unknown'],
    ]) {
      const output = JSON.parse(qualityGatesCommand(args, home));
      assert.equal(typeof output.error, 'string');
      assert.ok(output.error.length > 0);
      assert.equal(output.gates, undefined);
    }
  });

  it('filters out invalid skill names from config', () => {
    writeFileSync(
      join(home, '.omx-config.json'),
      JSON.stringify({
        qualityGates: {
          'ralplan': ['valid-gate', 'MyInvalidGate', 'deep-interview'],
        },
      }),
    );
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    // Only valid-gate should be returned, normalized with mode
    assert.deepEqual(result.gates, [{ skill: 'valid-gate', mode: 'blocking' }]);
  });

  it('filters out invalid object entries', () => {
    writeFileSync(
      join(home, '.omx-config.json'),
      JSON.stringify({
        qualityGates: {
          'ralplan': [
            'valid-gate',
            { skill: 'MyInvalidGate' },
            { skill: 'valid-obj', mode: 'advisory' },
            { mode: 'blocking' }, // Missing skill
            { skill: 'valid-final' },
          ],
        },
      }),
    );
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    assert.deepEqual(result.gates, [
      { skill: 'valid-gate', mode: 'blocking' },
      { skill: 'valid-obj', mode: 'advisory' },
      { skill: 'valid-final', mode: 'blocking' },
    ]);
  });
});
