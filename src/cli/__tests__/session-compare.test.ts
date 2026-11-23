import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionCompareArgs } from '../session-compare.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('parseSessionCompareArgs', () => {
  it('accepts flags before or after ids and both value syntaxes', () => {
    assert.deepEqual(parseSessionCompareArgs(['before', 'after']), {
      options: { baseline: 'before', candidate: 'after' }, json: false, failOnRegression: false,
    });
    assert.deepEqual(parseSessionCompareArgs([
      '--json', 'before', '--sort=duration', 'after', '--tool', 'read', '--namespace=filesystem',
      '--codex-home', '/shared home', '--baseline-home=/before', '--candidate-home', '/after',
      '--limit=10', '--max-duration-increase', '12.5', '--fail-on-regression', '--output=report.json',
    ]), {
      options: {
        baseline: 'before', candidate: 'after', sort: 'duration', tool: 'read', namespace: 'filesystem',
        codexHomeDir: '/shared home', baselineHome: '/before', candidateHome: '/after', limit: 10, maxDurationIncrease: 12.5,
      }, json: true, failOnRegression: true, output: 'report.json',
    });
    assert.equal(parseSessionCompareArgs(['before', 'after', '--max-duration-increase=0']).options.maxDurationIncrease, 0);
  });

  for (const args of [[], ['before'], [' ', 'after'], ['before', 'after', 'extra'],
    ...['--unknown', '--json=true', '--fail-on-regression=false', '--sort=recent', '--limit=0',
      '--limit=1001', '--limit=1.5', '--limit=2oops', '--limit=1e2', '--tool=', '--namespace=',
      '--output', '--baseline-home=', '--candidate-home=', '--codex-home=', '--limit=9007199254740992',
      '--max-duration-increase=-1', '--max-duration-increase=NaN', '--max-duration-increase=Infinity',
      '--max-duration-increase=1e2', '--max-duration-increase=1000001', '--max-duration-increase=',
    ].map((flag) => ['before', 'after', flag]),
    ['before', 'after', '--tool', '--json'],
  ]) {
    it(`rejects ${JSON.stringify(args)}`, () => assert.throws(() => parseSessionCompareArgs(args)));
  }
});

describe('omx session compare', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'omx-compare-cli-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function run(args: string[]) {
    return spawnSync(process.execPath, [join(repoRoot, 'dist/cli/omx.js'), 'session', ...args], {
      cwd, encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: join(cwd, 'home'), OMX_ROOT: '', OMX_STATE_ROOT: '' },
    });
  }

  async function fixture(id: string, duration = 1000, count = 1, name = 'exec', home = join(cwd, 'home')): Promise<string> {
    const root = join(home, 'sessions');
    await mkdir(root, { recursive: true });
    const path = join(root, `rollout-${id.replace(/[^a-z0-9-]/gi, '_')}.jsonl`);
    const rows: unknown[] = [{ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-26T10:00:00Z' } }];
    for (let i = 0; i < count; i++) rows.push(
      { type: 'response_item', timestamp: '2026-10-26T10:00:00Z', payload: { type: 'function_call', name: count === 1 ? name : `${name}-${i}`, call_id: `id-${i}`, arguments: 'PRIVATE_ARGUMENTS' } },
      { type: 'response_item', timestamp: new Date(Date.parse('2026-10-26T10:00:00Z') + duration).toISOString(), payload: { type: 'function_call_output', call_id: `id-${i}`, output: { exit_code: 0, output: 'PRIVATE_OUTPUT' } } },
    );
    await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return path;
  }

  it('dispatches a read-only human comparison even when a session lock exists', async () => {
    const source = await fixture('baseline');
    await fixture('candidate', 2000);
    const original = await readFile(source, 'utf-8');
    const state = join(cwd, '.omx', 'state');
    await mkdir(join(state, 'session.json.lock'), { recursive: true });
    await writeFile(join(state, 'session.json'), 'leave the pointer alone');
    const result = run(['compare', 'base', 'candidate']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Session comparison: baseline -> candidate/);
    assert.match(result.stdout, /Assessment: regression/);
    assert.match(result.stdout, /mean_duration_ms: 1000 -> 2000 \(delta=\+1000, \+100%\)/);
    assert.doesNotMatch(result.stdout, /PRIVATE_/);
    assert.equal(result.stderr, '');
    assert.equal(await readFile(source, 'utf-8'), original);
    assert.equal(await readFile(join(state, 'session.json'), 'utf-8'), 'leave the pointer alone');
    assert.equal((await stat(join(state, 'session.json.lock'))).isDirectory(), true);
  });

  it('flushes large JSON reports through a pipe before the regression exit', async () => {
    await fixture('baseline', 1000, 200);
    await fixture('candidate', 2000, 200);
    const result = run(['compare', 'baseline', 'candidate', '--json', '--limit=200', '--fail-on-regression']);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stdout.length > 65536);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, 1);
    assert.equal(report.tools.length, 200);
    assert.equal(report.assessment.regressions.length, 200);
    assert.equal(report.selection.truncated, false);
    assert.doesNotMatch(result.stdout, /PRIVATE_/);
    assert.equal(result.stderr, '');
  });

  it('uses exit 0 for a passing gate and honors the configured threshold', async () => {
    await fixture('baseline');
    await fixture('candidate', 1200);
    assert.equal(run(['compare', 'baseline', 'candidate', '--fail-on-regression']).status, 0);
    assert.equal(run(['compare', 'baseline', 'candidate', '--max-duration-increase=10', '--fail-on-regression']).status, 2);
  });

  it('uses exit 3 for inconclusive evidence only when gating is requested', async () => {
    await fixture('baseline', 1000, 0);
    await fixture('candidate', 1000, 0);
    const args = ['compare', 'baseline', 'candidate', '--json'];
    const normal = run(args);
    assert.equal(normal.status, 0, normal.stderr);
    assert.equal(JSON.parse(normal.stdout).assessment.status, 'inconclusive');
    const gated = run([...args, '--fail-on-regression']);
    assert.equal(gated.status, 3, gated.stderr);
    assert.match(gated.stdout, /no_tool_calls/);
  });

  it('does not hide regressions with display filters or limits', async () => {
    await fixture('baseline', 1000, 3);
    await fixture('candidate', 3000, 3);
    const limited = run(['compare', 'baseline', 'candidate', '--limit=1']);
    assert.equal(limited.status, 0, limited.stderr);
    assert.match(limited.stdout, /Showing 1 of 3 tools/);
    const empty = run(['compare', 'baseline', 'candidate', '--tool=missing', '--fail-on-regression']);
    assert.equal(empty.status, 2, empty.stderr);
    assert.match(empty.stdout, /No tools matched/);
    assert.match(empty.stdout, /3 regression\(s\)/);
  });

  it('supports side-specific home overrides', async () => {
    const beforeHome = join(cwd, 'before home');
    const afterHome = join(cwd, 'after home');
    await fixture('same', 1000, 1, 'exec', beforeHome);
    await fixture('same', 2000, 1, 'exec', afterHome);
    const result = run(['compare', 'same', 'same', '--baseline-home', beforeHome, '--candidate-home', afterHome, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).tools[0].metrics.mean_duration_ms.delta, 1000);
  });

  it('writes owner-only reports before returning the regression exit code', async () => {
    const source = await fixture('baseline');
    await fixture('candidate', 2000);
    const output = join(cwd, 'comparison with spaces.json');
    const result = run(['compare', 'baseline', 'candidate', '--json', '--output', output, '--fail-on-regression']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Saved session comparison/);
    assert.equal(JSON.parse(await readFile(output, 'utf-8')).assessment.status, 'regression');
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    for (const destination of [source, output]) {
      const original = await readFile(destination, 'utf-8');
      const conflict = run(['compare', 'baseline', 'candidate', '--output', destination, '--fail-on-regression']);
      assert.equal(conflict.status, 1);
      assert.match(conflict.stderr, /EEXIST/);
      assert.equal(await readFile(destination, 'utf-8'), original);
    }
  });

  it('refuses a symlink output destination', { skip: process.platform === 'win32' }, async () => {
    const source = await fixture('baseline');
    await fixture('candidate');
    const output = join(cwd, 'link');
    const original = await readFile(source, 'utf-8');
    await symlink(source, output);
    assert.equal(run(['compare', 'baseline', 'candidate', '--output', output]).status, 1);
    assert.equal(await readFile(source, 'utf-8'), original);
  });

  it('strips terminal control characters from session and tool labels', async () => {
    await fixture('baseline\u001b[31m\nforged-session', 1000, 1, 'exec\u001b[31m\nforged-tool');
    await fixture('candidate', 2000, 1, 'exec\u001b[31m\nforged-tool');
    const result = run(['compare', 'baseline', 'candidate']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\u001b|\nforged-/);
  });

  it('returns exit 1 for bad input or missing sessions without creating output', async () => {
    await fixture('baseline');
    const output = join(cwd, 'absent.json');
    for (const args of [['baseline'], ['baseline', 'missing'], ['baseline', 'missing', '--limit=2oops']]) {
      const result = run(['compare', ...args, '--output', output, '--fail-on-regression']);
      assert.equal(result.status, 1);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    }
  });

  it('shows parent and nested help without inspecting session history', () => {
    assert.match(run(['--help']).stdout, /omx session compare <baseline-id> <candidate-id>/);
    for (const args of [['compare', '--help'], ['compare', 'help'], ['compare', 'missing', '--help', '--codex-home=/absent']]) {
      const result = run(args);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^Usage: omx session compare/);
      assert.match(result.stdout, /--max-duration-increase/);
      assert.match(result.stdout, /Exit 2 for regressions, 3 for inconclusive/);
    }
  });
});
