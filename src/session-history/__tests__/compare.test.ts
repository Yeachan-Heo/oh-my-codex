import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionComparison, compareMetric, type SessionCompareOptions } from '../compare.js';

const START = '2026-10-26T10:00:00.000Z';
function time(ms: number): string { return new Date(Date.parse(START) + ms).toISOString(); }
function record(type: string, payload: unknown, ms = 0) { return { type, timestamp: time(ms), payload }; }
function call(id: string, duration = 1000, name: string | null = 'exec', namespace: string | null = null, code = 0) {
  return [
    record('response_item', { type: 'function_call', call_id: id, name, namespace, arguments: 'PRIVATE_ARGUMENTS' }),
    record('response_item', { type: 'function_call_output', call_id: id, output: { exit_code: code, output: 'PRIVATE_OUTPUT' } }, duration),
  ];
}

describe('compareMetric', () => {
  it('keeps unknown distinct from zero and handles a zero denominator', () => {
    assert.deepEqual(compareMetric(100, 120), { baseline: 100, candidate: 120, delta: 20, percent_change: 20 });
    assert.deepEqual(compareMetric(100, 0), { baseline: 100, candidate: 0, delta: -100, percent_change: -100 });
    assert.deepEqual(compareMetric(0, 0), { baseline: 0, candidate: 0, delta: 0, percent_change: 0 });
    assert.deepEqual(compareMetric(0, 1), { baseline: 0, candidate: 1, delta: 1, percent_change: null });
    for (const [before, after] of [[null, 2], [2, null], [null, null]]) {
      assert.deepEqual(compareMetric(before, after), { baseline: before, candidate: after, delta: null, percent_change: null });
    }
  });
});

describe('buildSessionComparison', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'omx-compare-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  async function fixture(id: string, records: unknown[], archived = false, directory = home): Promise<string> {
    const root = join(directory, archived ? 'archived_sessions' : 'sessions/2026/10/26');
    await mkdir(root, { recursive: true });
    const path = join(root, `rollout-${id}.jsonl`);
    await writeFile(path, [
      record('session_meta', { id, timestamp: START, cwd: '/PRIVATE_PROJECT', instructions: 'PRIVATE_INSTRUCTIONS' }),
      ...records,
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    return path;
  }

  function compare(extra: Partial<SessionCompareOptions> = {}) {
    return buildSessionComparison({ baseline: 'baseline', candidate: 'candidate', codexHomeDir: home, ...extra });
  }

  it('compares whole-session counts and means without treating workload growth as latency regression', async () => {
    const source = await fixture('baseline', [
      record('event_msg', { type: 'task_started', turn_id: 'before' }),
      ...call('b', 1000), record('event_msg', { type: 'task_complete', turn_id: 'before' }, 2000),
    ], true);
    await fixture('candidate', [
      record('event_msg', { type: 'task_started', turn_id: 'after' }),
      ...call('c1', 1000), ...call('c2', 1000),
      record('event_msg', { type: 'task_complete', turn_id: 'after' }, 3000),
    ]);
    const original = await readFile(source, 'utf-8');
    const report = await compare();
    assert.equal(report.baseline.archived, true);
    assert.equal(report.candidate.archived, false);
    assert.equal(report.metrics.duration_ms.delta, 1000);
    assert.equal(report.metrics.tool_calls.delta, 1);
    assert.equal(report.metrics.turns_completed.delta, 0);
    assert.equal(report.tools[0].metrics.total_duration_ms.delta, 1000);
    assert.equal(report.tools[0].metrics.mean_duration_ms.delta, 0);
    assert.equal(report.tools[0].candidate?.measured_calls, 2);
    assert.equal(report.assessment.status, 'no_regression');
    assert.equal(report.assessment.latency_comparisons, 1);
    assert.equal(report.tools[0].latency_comparable, true);
    assert.equal(await readFile(source, 'utf-8'), original);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|rollout-|transcript_path|"(?:call_id|turn_id)":/);
    assert.equal(report.privacy.mode, 'metadata-only');
  });

  it('pairs parallel calls through the existing timeline and respects namespaces', async () => {
    const a = call('a', 1000, 'read', 'filesystem');
    const b = call('b', 2000, 'read', 'browser');
    await fixture('baseline', [a[0], b[0], a[1], b[1]]);
    await fixture('candidate', [...call('c', 2000, 'read', 'filesystem'), ...call('d', 1000, 'read', 'browser')]);
    const report = await compare({ sort: 'duration' });
    assert.deepEqual(report.tools.map((tool) => [tool.namespace, tool.metrics.mean_duration_ms.delta]), [
      ['filesystem', 1000], ['browser', -1000],
    ]);
    assert.equal(report.assessment.regressions.length, 1);
    assert.equal(report.assessment.regressions[0].namespace, 'filesystem');
    assert.equal(report.assessment.regressions[0].comparison.percent_change, 100);
  });

  it('does not merge missing names, literal placeholders, or delimiter-bearing namespaces', async () => {
    const records = [
      ...call('1', 1000, null), ...call('2', 1000, '(unknown)'),
      ...call('3', 1000, 'b:c', 'a'), ...call('4', 1000, 'c', 'a:b'),
      ...call('5', 1000, 'exec', 'null'), ...call('6', 1000, 'exec', null),
    ];
    await fixture('baseline', records);
    await fixture('candidate', records);
    const report = await compare({ sort: 'name' });
    assert.equal(report.tools.length, 6);
    assert.equal(report.assessment.latency_comparisons, 6);
    assert.equal(report.assessment.regressions.length, 0);
  });

  it('shows added and removed tools with zero count baselines but unknown timing deltas', async () => {
    await fixture('baseline', [...call('b', 1000, 'removed'), ...call('shared', 1000)]);
    await fixture('candidate', [...call('c', 500, 'added'), ...call('shared', 1000)]);
    const report = await compare({ sort: 'name' });
    const added = report.tools.find((tool) => tool.name === 'added')!;
    const removed = report.tools.find((tool) => tool.name === 'removed')!;
    assert.equal(added.presence, 'added');
    assert.equal(added.baseline, null);
    assert.equal(added.metrics.calls.delta, 1);
    assert.equal(added.metrics.mean_duration_ms.baseline, null);
    assert.equal(added.metrics.total_duration_ms.delta, null);
    assert.equal(removed.presence, 'removed');
    assert.equal(removed.candidate, null);
    assert.equal(removed.metrics.calls.delta, -1);
    assert.equal(removed.metrics.mean_duration_ms.candidate, null);
    assert.equal(removed.latency_comparable, false);
    assert.equal(report.assessment.latency_comparisons, 1);
  });

  it('detects per-tool failures even when aggregate failures stay unchanged', async () => {
    await fixture('baseline', [...call('b', 1000, 'old', null, 1)]);
    await fixture('candidate', [...call('c', 1000, 'new', null, 1)]);
    const report = await compare();
    assert.equal(report.metrics.failed.delta, 0);
    assert.equal(report.assessment.status, 'regression');
    assert.equal(report.assessment.regressions[0].name, 'new');
    assert.equal(report.assessment.regressions[0].metric, 'failed');
  });

  it('detects incomplete calls and aborted turns, retaining regressions alongside gaps', async () => {
    await fixture('baseline', call('b'));
    await fixture('candidate', [call('c')[0], record('event_msg', { type: 'turn_aborted' })]);
    const report = await compare();
    assert.equal(report.assessment.status, 'regression');
    assert.deepEqual(report.assessment.regressions.map((row) => row.metric), ['incomplete', 'turns_aborted']);
    assert.equal(report.tools[0].latency_comparable, false);
    assert.equal(report.tools[0].candidate?.mean_duration_ms, null);
    assert.ok(report.assessment.gaps.some((gap) => gap.code === 'incomplete_tool_calls'));
  });

  it('uses a strict threshold and handles measured zero durations', async () => {
    await fixture('baseline', call('b', 1000));
    await fixture('candidate', call('c', 1200));
    assert.equal((await compare()).assessment.status, 'no_regression');
    assert.equal((await compare({ maxDurationIncrease: 19.9 })).assessment.status, 'regression');
    assert.equal((await compare({ maxDurationIncrease: 1000 })).assessment.status, 'no_regression');
    await fixture('baseline', call('b', 0));
    const zero = await compare();
    assert.equal(zero.assessment.status, 'regression');
    assert.equal(zero.tools[0].metrics.mean_duration_ms.percent_change, null);
    await fixture('candidate', call('c', 0));
    assert.equal((await compare()).assessment.status, 'no_regression');
  });

  it('keeps full precision when evaluating small latency changes', async () => {
    await fixture('baseline', [...call('b1', 1), ...call('b2', 2), ...call('b3', 1)]);
    await fixture('candidate', [...call('c1', 1), ...call('c2', 2), ...call('c3', 2)]);
    const report = await compare({ maxDurationIncrease: 24.99 });
    assert.equal(report.assessment.status, 'regression');
    assert.equal(report.tools[0].baseline?.mean_duration_ms, 4 / 3);
    assert.equal(report.tools[0].candidate?.mean_duration_ms, 5 / 3);
    assert.equal((await compare({ maxDurationIncrease: 25 })).assessment.status, 'no_regression');
  });

  it('does not pass a session with recorded turns that have no terminal boundary', async () => {
    await fixture('baseline', call('b'));
    await fixture('candidate', [record('event_msg', { type: 'task_started' }), ...call('c')]);
    const report = await compare();
    assert.equal(report.assessment.status, 'inconclusive');
    assert.ok(report.assessment.gaps.some((gap) => gap.side === 'candidate' && gap.code === 'unclosed_turns' && gap.count === 1));
  });

  it('does not use a partial set of timings to declare a latency regression', async () => {
    const missingTime = { ...call('missing', 500)[1], timestamp: 'invalid' };
    await fixture('baseline', [...call('b', 1000), call('missing')[0], missingTime]);
    await fixture('candidate', call('c', 5000));
    const report = await compare();
    assert.equal(report.tools[0].baseline?.measured_calls, 1);
    assert.equal(report.tools[0].metrics.mean_duration_ms.delta, 4000);
    assert.equal(report.tools[0].latency_comparable, false);
    assert.equal(report.assessment.status, 'inconclusive');
    assert.ok(report.assessment.gaps.some((gap) => gap.side === 'baseline' && gap.code === 'invalid_timestamps'));
    assert.equal(report.assessment.regressions.length, 0);
  });

  it('reports malformed tails, ambiguous calls, reversed timestamps, and orphan outputs as gaps', async () => {
    await fixture('baseline', call('b'));
    const path = await fixture('candidate', [
      ...call('c'), call('duplicate')[0], call('duplicate')[0], call('duplicate')[1],
      { ...call('reversed')[0], timestamp: time(2000) }, call('reversed', 1000)[1],
      call('orphan')[1],
    ]);
    await appendFile(path, '{"type":');
    const report = await compare();
    for (const code of ['malformed_records', 'ambiguous_call_ids', 'reversed_tool_timestamps', 'orphan_outputs']) {
      assert.ok(report.assessment.gaps.some((gap) => gap.side === 'candidate' && gap.code === code), code);
    }
    assert.equal(report.candidate.diagnostics.malformed_records, 1);
  });

  it('does not give an empty or conversation-only history a passing assessment', async () => {
    await fixture('baseline', []);
    await fixture('candidate', [record('response_item', { type: 'message', role: 'user', content: 'PRIVATE_MESSAGE' })]);
    const report = await compare();
    assert.equal(report.assessment.status, 'inconclusive');
    assert.deepEqual(report.assessment.gaps, [
      { side: 'baseline', code: 'no_tool_calls', count: 1 },
      { side: 'candidate', code: 'no_tool_calls', count: 1 },
    ]);
    assert.equal(report.tools.length, 0);
  });

  it('evaluates all tools before display filtering, sorting, or limiting', async () => {
    await fixture('baseline', [...call('b', 1000, 'slow'), ...call('b2', 1000, 'fast', 'web')]);
    await fixture('candidate', [...call('c', 5000, 'slow'), ...call('c2', 1000, 'fast', 'web')]);
    const limited = await compare({ limit: 1 });
    assert.equal(limited.tools[0].name, 'slow');
    assert.equal(limited.selection.truncated, true);
    assert.equal(limited.selection.matched_tools, 2);
    const filtered = await compare({ tool: 'fast', namespace: 'web' });
    assert.equal(filtered.tools.length, 1);
    assert.equal(filtered.tools[0].name, 'fast');
    assert.equal(filtered.assessment.status, 'regression');
    assert.equal(filtered.assessment.regressions[0].name, 'slow');
    const empty = await compare({ namespace: 'absent' });
    assert.equal(empty.tools.length, 0);
    assert.equal(empty.assessment.status, 'regression');
    assert.equal(empty.metrics.tool_calls.candidate, 2);
  });

  it('does not truncate aggregate metrics to the timeline event page', async () => {
    const records = Array.from({ length: 150 }, (_, i) => call(String(i), 1000)).flat();
    await fixture('baseline', records);
    await fixture('candidate', records);
    const report = await compare();
    assert.equal(report.tools[0].candidate?.calls, 150);
    assert.equal(report.tools[0].candidate?.total_duration_ms, 150000);
    assert.equal(report.assessment.status, 'no_regression');
  });

  it('supports unique prefixes and separate homes for snapshots with the same session id', async () => {
    const beforeHome = join(home, 'before');
    const afterHome = join(home, 'after');
    await fixture('same-id', call('b'), true, beforeHome);
    await fixture('same-id', call('c', 3000), false, afterHome);
    const report = await compare({
      baseline: 'same', candidate: 'same-id', baselineHome: beforeHome, candidateHome: afterHome,
      codexHomeDirs: [home], // Side-specific selectors take precedence over discovered homes.
    });
    assert.equal(report.baseline.session_id, 'same-id');
    assert.equal(report.candidate.session_id, 'same-id');
    assert.equal(report.assessment.status, 'regression');
    assert.equal(report.tools[0].metrics.mean_duration_ms.delta, 2000);
  });

  it('rejects missing or ambiguous selections instead of comparing an arbitrary transcript', async () => {
    await fixture('baseline', call('b'));
    await assert.rejects(compare(), /No local session matches/);
    await fixture('candidate-one', call('c1'));
    await fixture('candidate-two', call('c2'));
    await assert.rejects(compare(), /Multiple transcripts match/);
  });

  for (const options of [
    { baseline: '' }, { candidate: ' ' }, { limit: 0 }, { limit: 1001 }, { limit: 1.5 },
    { maxDurationIncrease: -1 }, { maxDurationIncrease: NaN }, { maxDurationIncrease: Infinity },
    { maxDurationIncrease: 1000001 }, { sort: 'bogus' }, { tool: '' }, { namespace: ' ' }, { candidateHome: '' },
  ]) {
    it(`validates options before reading history: ${JSON.stringify(options)}`, async () => {
      await assert.rejects(compare(options as Partial<SessionCompareOptions>));
    });
  }
});
