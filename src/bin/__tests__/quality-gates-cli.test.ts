import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qualityGatesCommand } from '../quality-gates-cli.js';

const gates = [
  { skill: 'risk-check', mode: 'blocking', model: 'review-model' },
  { skill: 'style-check', mode: 'advisory' },
];

describe('quality-gates CLI', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'omx-quality-gates-cli-'));
    writeFileSync(join(home, '.omx-config.json'), JSON.stringify({ qualityGates: {
      plan: gates, interview: [gates[1]], codeReview: [gates[0]],
    } }));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists each stage partitioned by mode and preserves model overrides', () => {
    for (const [stage, selected] of Object.entries({ plan: gates, interview: [gates[1]], codeReview: [gates[0]] })) {
      assert.deepEqual(JSON.parse(qualityGatesCommand(['list', '--stage', stage, '--json'], home)), {
        gates: selected, stage,
        advisory: selected.filter(gate => gate.mode === 'advisory'),
        blocking: selected.filter(gate => gate.mode === 'blocking'),
      });
    }
  });

  it('returns an empty list for an unconfigured stage', () => {
    writeFileSync(join(home, '.omx-config.json'), JSON.stringify({ qualityGates: { interview: gates } }));
    assert.deepEqual(JSON.parse(qualityGatesCommand(['list', '--stage', 'plan', '--json'], home)), {
      gates: [], stage: 'plan', advisory: [], blocking: [],
    });
  });

  it('rejects invalid stages, missing stages, unsupported commands and unknown flags', () => {
    for (const args of [
      ['list', '--stage', 'invalid', '--json'],
      ['list', '--stage', 'code-review', '--json'],
      ['list', '--json'], ['list', '--stage'],
      ['run', '--stage', 'plan'], ['list', '--stage', 'plan', '--unknown'],
    ]) {
      const output = JSON.parse(qualityGatesCommand(args, home));
      assert.equal(typeof output.error, 'string');
      assert.ok(output.error.length > 0);
      assert.equal(output.gates, undefined);
    }
  });

  it('routes the public CLI and returns a failing exit code for invalid stages', () => {
    const cli = fileURLToPath(new URL('../../cli/omx.js', import.meta.url));
    const options = { cwd: home, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' as const };
    const listed = spawnSync(process.execPath, [cli, 'quality-gates', 'list', '--stage', 'plan', '--json'], options);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), { gates, stage: 'plan', advisory: [gates[1]], blocking: [gates[0]] });
    const invalid = spawnSync(process.execPath, [cli, 'quality-gates', 'list', '--stage', 'invalid', '--json'], options);
    assert.notEqual(invalid.status, 0);
    assert.match(JSON.parse(invalid.stdout).error, /stage/i);
  });
});
