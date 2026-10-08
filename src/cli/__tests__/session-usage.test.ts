import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSessionUsageArgs } from '../session-usage.js';
import type { SessionUsageReport } from '../../session-history/usage.js';

const omx = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'omx.js');

async function fixture(t: TestContext): Promise<{ root: string; home: string; transcript: string }> {
  const root = await mkdtemp(join(tmpdir(), 'omx-usage-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'codex');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const transcript = join(home, 'sessions', 'rollout-test.jsonl');
  await writeFile(transcript, [
    { type: 'session_meta', payload: { id: 'session-cli', cwd: root, timestamp: '2026-10-01T00:00:00Z' } },
    { type: 'event_msg', timestamp: '2026-10-08T00:00:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125, cached_input_tokens: 50, reasoning_output_tokens: 10 } } } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  return { root, home, transcript };
}

function run(root: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [omx, 'session', 'usage', ...args], {
    cwd: root, encoding: 'utf-8',
    env: { ...process.env, CODEX_HOME: home, OMX_AUTO_UPDATE: '0', OMX_ROOT: '', OMX_STATE_ROOT: '' },
  });
}

describe('session usage CLI', () => {
  it('parses both value forms and all report options', () => {
    assert.deepEqual(parseSessionUsageArgs(['--since=7d', '--project', 'current', '--session=abc', '--limit', '4', '--sort=tokens', '--codex-home', '/tmp/codex', '--json']), {
      options: { since: '7d', project: 'current', session: 'abc', limit: 4, sort: 'tokens', codexHomeDir: '/tmp/codex' }, json: true,
    });
    assert.deepEqual(parseSessionUsageArgs([]), { options: {}, json: false });
  });

  for (const args of [['--limit', '3oops'], ['--limit=1.2'], ['--limit=0'], ['--limit=501'], ['--sort=money'], ['--since'], ['--session='], ['--project', '--json'], ['--nope'], ['unexpected']]) {
    it(`rejects ${args.join(' ')}`, () => assert.throws(() => parseSessionUsageArgs(args)));
  }

  it('emits JSON through the top-level CLI without modifying source files or setting up OMX', async (t) => {
    const { root, home, transcript } = await fixture(t);
    const original = await readFile(transcript, 'utf-8');
    const result = run(root, home, ['--codex-home', home, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as SessionUsageReport;
    assert.equal(report.schema_version, 1);
    assert.equal(report.sessions[0].session_id, 'session-cli');
    assert.equal(report.totals.total_tokens.known, 125);
    assert.equal(report.totals.cached_input_tokens.known, 50);
    assert.equal(await readFile(transcript, 'utf-8'), original);
    assert.deepEqual(await readdir(root), ['codex']);
  });

  it('renders cumulative counters, coverage, subset semantics and project labels', async (t) => {
    const { root, home } = await fixture(t);
    const result = run(root, home, []);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cumulative counters/);
    assert.match(result.stdout, /subsets of input and output/);
    assert.match(result.stdout, /total_tokens: 125 \(1 known, 0 unknown sessions\)/);
    assert.match(result.stdout, /session: session-cli/);
    assert.equal(result.stdout.includes(root), false);
  });

  it('discovers a generated runtime home and honors the explicit home override', async (t) => {
    const { root, home, transcript } = await fixture(t);
    const runtime = join(root, '.omx', 'runtime', 'codex-home', 'omx-test', 'sessions');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'rollout-runtime.jsonl'), (await readFile(transcript, 'utf-8')).replace('session-cli', 'session-runtime'));
    const discovered = run(root, home, ['--json']);
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal((JSON.parse(discovered.stdout) as SessionUsageReport).matched_sessions, 2);
    const explicit = run(root, home, ['--codex-home', home, '--json']);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal((JSON.parse(explicit.stdout) as SessionUsageReport).matched_sessions, 1);
  });

  it('shows help without opening the requested home', async (t) => {
    const { root, home } = await fixture(t);
    const result = run(root, home, ['--codex-home', '/does/not/exist', '--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: omx session usage/);
    assert.match(result.stdout, /not token consumption within a billing period/);
  });

  it('returns a CLI error for an invalid date without emitting a report', async (t) => {
    const { root, home } = await fixture(t);
    const result = run(root, home, ['--since=invalid', '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid --since/);
    assert.equal(result.stdout, '');
  });
});
