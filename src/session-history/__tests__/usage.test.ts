import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSessionUsageReport } from '../usage.js';

const START = '2026-10-01T12:00:00.000Z';
const RECENT = '2026-10-08T12:00:00.000Z';
const NOW = Date.parse('2026-10-09T00:00:00.000Z');

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'omx-session-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function tokens(input: number, output: number, cached = 0, reasoning = 0) {
  return { input_tokens: input, output_tokens: output, cached_input_tokens: cached, reasoning_output_tokens: reasoning, total_tokens: input + output };
}

function count(usage: unknown, at = RECENT): Record<string, unknown> {
  return { type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { total_token_usage: usage, last_token_usage: tokens(999, 999) } } };
}

async function rollout(
  home: string, id: string, rows: Array<Record<string, unknown> | string>,
  options: { archived?: boolean; project?: string; name?: string; start?: string } = {},
): Promise<void> {
  const dir = join(home, options.archived ? 'archived_sessions' : 'sessions', '2026', '10', '08');
  await mkdir(dir, { recursive: true });
  const meta = { type: 'session_meta', payload: { id, timestamp: options.start ?? START, cwd: options.project ?? '/projects/example' } };
  await writeFile(join(dir, `rollout-${options.name ?? id}.jsonl`), [meta, ...rows].map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'));
}

describe('session usage snapshots', () => {
  it('uses one final cumulative snapshot, including repeated events and zero counters', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'a', [count(tokens(100, 10), START), count(tokens(250, 30, 80, 12)), count(tokens(250, 30, 80, 12)), count(null)]);
    await rollout(home, 'zero', [count(tokens(0, 0))]);
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.scope, 'session-cumulative');
    assert.equal(report.sessions_with_usage, 2);
    assert.deepEqual(report.totals.total_tokens, { known: 280, known_sessions: 2, unknown_sessions: 0 });
    assert.equal(report.totals.cached_input_tokens.known, 80);
    assert.equal(report.totals.reasoning_output_tokens.known, 12);
    assert.deepEqual(report.sessions.find((row) => row.session_id === 'a')?.usage, tokens(250, 30, 80, 12));
  });

  it('retains a newer reset snapshot instead of summing or taking historical maxima', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'reset', [count(tokens(500, 100), START), count(tokens(10, 2))]);
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.totals.total_tokens.known, 12);
  });

  it('reports missing measurements separately from measured zero and partial coverage', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'missing', [{ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: tokens(10, 1) } } }]);
    await rollout(home, 'partial', [count({ input_tokens: 0, output_tokens: 2, total_tokens: 2 })]);
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.sessions_with_usage, 1);
    assert.deepEqual(report.totals.input_tokens, { known: 0, known_sessions: 1, unknown_sessions: 1 });
    assert.deepEqual(report.totals.cached_input_tokens, { known: null, known_sessions: 0, unknown_sessions: 2 });
    assert.equal(report.sessions.find((row) => row.session_id === 'missing')?.usage.total_tokens, null);
  });

  it('rejects invalid numeric fields without coercing them into usage', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'invalid', [count({ input_tokens: '12', output_tokens: -1, total_tokens: 0.5, cached_input_tokens: Number.MAX_SAFE_INTEGER + 1, reasoning_output_tokens: true })]);
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.sessions_with_usage, 0);
    assert.equal(report.diagnostics.invalid_usage_fields, 5);
    assert.equal(report.totals.total_tokens.known, null);
  });

  it('counts parse gaps, ignores partial tails and excludes transcript contents and full paths', async (t) => {
    const home = await fixture(t);
    const secret = 'DO-NOT-EXPORT-THIS-PROMPT';
    await rollout(home, 'private', [
      { type: 'response_item', timestamp: RECENT, payload: { role: 'user', content: [{ text: secret }] } },
      { type: 'response_item', payload: { type: 'function_call', arguments: secret } },
      count(tokens(20, 3)), 'not json', '{"type":',
    ], { project: '/private/workspace/project-example' });
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.diagnostics.malformed_records, 2);
    assert.equal(report.totals.total_tokens.known, 23);
    assert.equal(report.sessions[0].cwd_basename, 'project-example');
    assert.match(report.sessions[0].cwd_hash!, /^[a-f0-9]{12}$/);
    const serialized = JSON.stringify(report);
    for (const value of [secret, home, '/private/workspace']) assert.equal(serialized.includes(value), false);
  });

  it('keeps Windows project paths out of reports on every host platform', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'windows', [count(tokens(1, 2))], { project: 'C:\\Users\\private\\Project' });
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.sessions[0].cwd_basename, 'Project');
    assert.equal(JSON.stringify(report).includes('private'), false);
  });
});

describe('session usage discovery and selection', () => {
  it('deduplicates mirrored and archived transcripts by session id and snapshot timestamp', async (t) => {
    const root = await fixture(t);
    const first = join(root, 'first');
    const second = join(root, 'second');
    await rollout(first, 'same', [count(tokens(300, 30), START)]);
    await rollout(second, 'same', [count(tokens(10, 2))], { archived: true });
    await rollout(second, 'same', [{ type: 'event_msg', timestamp: '2026-10-08T13:00:00Z', payload: { type: 'token_count', info: null } }], { name: 'rate-limit' });
    const report = await buildSessionUsageReport({ codexHomeDirs: [first, second, first] });
    assert.equal(report.matched_sessions, 1);
    assert.equal(report.diagnostics.scanned_files, 3);
    assert.equal(report.diagnostics.duplicate_transcripts, 2);
    assert.equal(report.totals.total_tokens.known, 12);
    assert.equal(report.sessions[0].transcript_copies, 3);
    assert.equal(report.sessions[0].archived, false);
    assert.equal(report.sessions[0].last_activity_at, '2026-10-08T13:00:00.000Z');
  });

  it('resolves timestamp ties by total tokens and then field coverage', async (t) => {
    const root = await fixture(t);
    await rollout(root, 'same', [count({ input_tokens: 100, output_tokens: 10, total_tokens: 110 })], { name: 'a' });
    await rollout(root, 'same', [count(tokens(100, 10, 50, 5))], { name: 'b' });
    await rollout(root, 'same', [count(tokens(10, 1))], { name: 'c' });
    const report = await buildSessionUsageReport({ codexHomeDir: root });
    assert.equal(report.totals.total_tokens.known, 110);
    assert.equal(report.totals.cached_input_tokens.known, 50);
  });

  it('does not fill missing fields in the newest snapshot with older measurements', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'same', [count(tokens(100, 10, 80), START)], { name: 'old' });
    await rollout(home, 'same', [count({ input_tokens: 200, output_tokens: 20, total_tokens: 220 })], { name: 'new' });
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.totals.total_tokens.known, 220);
    assert.equal(report.totals.cached_input_tokens.known, null);
    assert.equal(report.totals.cached_input_tokens.unknown_sessions, 1);
  });

  it('includes archived sessions and applies limit only to displayed rows', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'a', [count(tokens(100, 20))], { archived: true });
    await rollout(home, 'b', [count(tokens(20, 5))]);
    await rollout(home, 'c', []);
    const report = await buildSessionUsageReport({ codexHomeDir: home, sort: 'tokens', limit: 1 });
    assert.equal(report.sessions[0].session_id, 'a');
    assert.equal(report.sessions[0].archived, true);
    assert.equal(report.matched_sessions, 3);
    assert.equal(report.truncated, true);
    assert.deepEqual(report.totals.total_tokens, { known: 145, known_sessions: 2, unknown_sessions: 1 });
  });

  it('selects by recorded last activity while retaining complete cumulative counters', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'old-start-recent-activity', [count(tokens(5000, 100), START), { type: 'event_msg', timestamp: RECENT, payload: { type: 'task_complete' } }]);
    await rollout(home, 'old', [count(tokens(500, 100), START)]);
    const report = await buildSessionUsageReport({ codexHomeDir: home, since: '2d', now: NOW });
    assert.deepEqual(report.sessions.map((row) => row.session_id), ['old-start-recent-activity']);
    assert.equal(report.totals.total_tokens.known, 5100);
    assert.equal(report.sessions[0].usage_at, START);
    const dated = await buildSessionUsageReport({ codexHomeDir: home, since: '2026-10-07', now: NOW });
    assert.deepEqual(dated.totals, report.totals);
  });

  it('filters current project exactly and supports project and session fragments', async (t) => {
    const root = await fixture(t);
    const cwd = join(root, 'project');
    await mkdir(cwd);
    await rollout(root, 'session-a', [count(tokens(1, 2))], { project: cwd });
    await rollout(root, 'session-b', [count(tokens(10, 20))], { project: `${cwd}-other` });
    const current = await buildSessionUsageReport({ codexHomeDir: root, cwd, project: 'current' });
    assert.deepEqual(current.sessions.map((row) => row.session_id), ['session-a']);
    const fragment = await buildSessionUsageReport({ codexHomeDir: root, project: 'PROJECT', session: 'ION-B' });
    assert.equal(fragment.totals.total_tokens.known, 30);
    const all = await buildSessionUsageReport({ codexHomeDir: root, project: 'all' });
    assert.equal(all.matched_sessions, 2);
  });

  it('sorts by activity with deterministic ties and places unknown token counts last', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'a', [count(tokens(100, 0), START)]);
    await rollout(home, 'c', [{ type: 'event_msg', timestamp: RECENT }]);
    await rollout(home, 'b', [count(tokens(10, 0))]);
    const recent = await buildSessionUsageReport({ codexHomeDir: home });
    assert.deepEqual(recent.sessions.map((row) => row.session_id), ['b', 'c', 'a']);
    const byTokens = await buildSessionUsageReport({ codexHomeDir: home, sort: 'tokens' });
    assert.deepEqual(byTokens.sessions.map((row) => row.session_id), ['a', 'b', 'c']);
  });

  it('reports an empty source and skipped unidentifiable files without invented sessions', async (t) => {
    const home = await fixture(t);
    const empty = await buildSessionUsageReport({ codexHomeDir: join(home, 'missing') });
    assert.equal(empty.matched_sessions, 0);
    assert.equal(empty.totals.total_tokens.known, null);
    await mkdir(join(home, 'sessions'));
    await writeFile(join(home, 'sessions', 'rollout-empty.jsonl'), '');
    await writeFile(join(home, 'sessions', 'rollout-bad.jsonl'), '{}\n');
    const report = await buildSessionUsageReport({ codexHomeDir: home });
    assert.equal(report.diagnostics.skipped_files, 2);
    assert.equal(report.matched_sessions, 0);
  });

  it('keeps unknown timestamps unfiltered but excludes them from a dated selection', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'unknown', [count(tokens(1, 2), 'invalid')], { start: 'invalid' });
    assert.equal((await buildSessionUsageReport({ codexHomeDir: home })).matched_sessions, 1);
    assert.equal((await buildSessionUsageReport({ codexHomeDir: home, since: '7d', now: NOW })).matched_sessions, 0);
  });

  it('surfaces unreadable directories instead of reporting an empty usage total', {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  }, async (t) => {
    const home = await fixture(t);
    const directory = join(home, 'sessions');
    await mkdir(directory);
    await chmod(directory, 0);
    try {
      await assert.rejects(buildSessionUsageReport({ codexHomeDir: home }), { code: 'EACCES' });
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('fails explicitly on aggregate overflow', async (t) => {
    const home = await fixture(t);
    await rollout(home, 'large', [count({ total_tokens: Number.MAX_SAFE_INTEGER })]);
    await rollout(home, 'one', [count({ total_tokens: 1 })]);
    await assert.rejects(buildSessionUsageReport({ codexHomeDir: home }), /safe integer range/);
  });

  it('validates programmatic limits, sort and time filters before scanning', async () => {
    for (const limit of [0, -1, 1.5, 501, NaN]) await assert.rejects(buildSessionUsageReport({ limit }), /limit/);
    await assert.rejects(buildSessionUsageReport({ sort: 'bad' as 'recent' }), /sort/);
    await assert.rejects(buildSessionUsageReport({ since: 'not-a-date' }), /since/);
    await assert.rejects(buildSessionUsageReport({ since: `${'9'.repeat(400)}d` }), /since/);
  });
});
