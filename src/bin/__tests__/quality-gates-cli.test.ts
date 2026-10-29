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

  it('lists gates for a specified stage', () => {
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'ralplan'], home));
    assert.deepEqual(result, {
      gates: ['plan-check', 'design-review'],
      stage: 'ralplan',
    });
  });

  it('returns an empty list for an unconfigured stage', () => {
    const result = JSON.parse(qualityGatesCommand(['list', '--stage', 'code-review'], home));
    assert.deepEqual(result, {
      gates: ['code-check'],
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
    // Only valid-gate should be returned
    assert.deepEqual(result.gates, ['valid-gate']);
  });
});
