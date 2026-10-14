import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionTimeline, type TimelineToolEvent } from '../timeline.js';

const START = '2026-10-14T10:00:00.000Z';
function time(seconds: number): string { return new Date(Date.parse(START) + seconds * 1000).toISOString(); }
function record(type: string, payload: unknown, seconds = 0) { return { type, timestamp: time(seconds), payload }; }
function call(id: string | null, seconds: number, name = 'exec') {
  return record('response_item', { type: 'function_call', name, call_id: id, arguments: 'PRIVATE_ARGUMENTS' }, seconds);
}
function output(id: string | null, seconds: number, result: unknown = { exit_code: 0 }) {
  return record('response_item', { type: 'function_call_output', call_id: id, output: result }, seconds);
}

describe('buildSessionTimeline', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'omx-timeline-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  async function fixture(records: unknown[], id = 'timeline-id', archived = false, directory = home): Promise<string> {
    const root = join(directory, archived ? 'archived_sessions' : 'sessions/2026/10/14');
    await mkdir(root, { recursive: true });
    const path = join(root, `rollout-${id}.jsonl`);
    await writeFile(path, [
      record('session_meta', { id, timestamp: START, cwd: '/PRIVATE_PROJECT', instructions: 'PRIVATE_INSTRUCTIONS' }),
      ...records,
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    return path;
  }

  it('pairs interleaved calls by ID and summarizes the complete session in source order', async () => {
    const path = await fixture([
      record('event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      call('slow', 1), call('fast', 2, 'search'),
      output('fast', 3), output('slow', 5, { exit_code: 2 }),
      record('event_msg', { type: 'context_compacted' }, 6),
      record('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 7),
      record('event_msg', { type: 'task_started', turn_id: 'turn-2' }, 8),
      call('pending', 9),
      record('event_msg', { type: 'turn_aborted', turn_id: 'turn-2' }, 10),
    ]);
    const before = await readFile(path, 'utf-8');
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => event.kind), [
      'turn_start', 'tool', 'tool', 'compaction', 'turn_complete', 'turn_start', 'tool', 'turn_aborted',
    ]);
    assert.deepEqual(report.events[1], {
      kind: 'tool', name: 'exec', call_id: 'slow', status: 'failed', line_number: 3,
      timestamp: time(1), result_line_number: 6, completed_at: time(5), duration_ms: 4000, exit_code: 2,
    });
    assert.equal(report.duration_ms, 10_000);
    assert.equal(report.last_activity_at, time(10));
    assert.deepEqual(report.summary, {
      events: 8, tool_calls: 3, completed: 1, failed: 1, incomplete: 1, orphan_outputs: 0,
      turns_started: 2, turns_completed: 1, turns_aborted: 1, compactions: 1,
      tools: [
        { name: 'exec', calls: 2, completed: 0, failed: 1, incomplete: 1, measured_calls: 1, total_duration_ms: 4000, max_duration_ms: 4000 },
        { name: 'search', calls: 1, completed: 1, failed: 0, incomplete: 0, measured_calls: 1, total_duration_ms: 1000, max_duration_ms: 1000 },
      ],
    });
    assert.equal(await readFile(path, 'utf-8'), before);
  });

  it('retains only metadata, including for custom tools and compaction records', async () => {
    await fixture([
      record('response_item', { type: 'message', role: 'user', content: 'PRIVATE_MESSAGE' }),
      record('response_item', { type: 'reasoning', summary: 'PRIVATE_REASONING' }),
      record('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: 'PRIVATE_PATCH' }, 1),
      record('response_item', { type: 'custom_tool_call_output', call_id: 'patch', output: 'PRIVATE_OUTPUT' }, 2),
      record('compacted', { message: 'PRIVATE_COMPACTION', replacement_history: ['PRIVATE_HISTORY'] }, 3),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|rollout-|codex_home|transcript_path/);
    assert.equal(report.privacy.mode, 'metadata-only');
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.compactions, 1);
    assert.equal((report.events[0] as TimelineToolEvent).duration_ms, 1000);
  });

  it('recognizes explicit failures without classifying arbitrary output text as errors', async () => {
    const results: Array<[unknown, string, number | null]> = [
      [{ exit_code: 1 }, 'failed', 1],
      ['{"metadata":{"exit_code":-1},"output":"private"}', 'failed', -1],
      [{ isError: true, exit_code: 0 }, 'failed', 0],
      [{ is_error: true }, 'failed', null],
      ['Chunk ID: abc\nWall time: 1 seconds\nProcess exited with code 7\nFinal output:\nprivate', 'failed', 7],
      ['Wall time: 0.1 seconds\r\nExit code: 3\r\nOutput:\r\nprivate', 'failed', 3],
      ['Chunk ID: abc\nWall time: 1 seconds\nProcess exited with code 0\nFinal output:\nProcess exited with code 8', 'completed', 0],
      ['Error: this is quoted program output, not a status', 'completed', null],
      ['Wall time: this is ordinary text\nProcess exited with code 9', 'completed', null],
      [{ output: { exit_code: 9 }, isError: false }, 'completed', null],
      [{ exit_code: '1' }, 'completed', null],
      [{ exit_code: 1.5 }, 'completed', null],
      [null, 'completed', null],
    ];
    await fixture(results.flatMap(([result], index) => [call(`call-${index}`, index), output(`call-${index}`, index + 1, result)]));
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => {
      assert.equal(event.kind, 'tool');
      const tool = event as TimelineToolEvent;
      return [tool.status, tool.exit_code];
    }), results.map(([, status, code]) => [status, code]));
  });

  it('does not guess pairings for missing or duplicate outstanding call IDs', async () => {
    await fixture([
      output('orphan', 0, { isError: true }),
      call(null, 1), output(null, 2),
      call('duplicate', 3), call('duplicate', 4), call('duplicate', 5),
      output('duplicate', 6), output('duplicate', 7),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.equal(report.summary.incomplete, 4);
    assert.equal(report.summary.orphan_outputs, 4);
    assert.equal(report.summary.failed, 0); // The orphan failure cannot be attributed to a call.
    assert.equal(report.diagnostics.ambiguous_call_ids, 1);
    assert.equal(report.summary.tools[0].total_duration_ms, null);
    const failures = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home, status: 'failed' });
    assert.equal(failures.events.length, 1);
    assert.equal(failures.events[0].kind, 'orphan_output');
  });

  it('allows sequential ID reuse after a result without joining separate calls', async () => {
    await fixture([call('reuse', 1), output('reuse', 2), call('reuse', 3), output('reuse', 5)]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => (event as TimelineToolEvent).duration_ms), [1000, 2000]);
    assert.equal(report.diagnostics.ambiguous_call_ids, 0);
  });

  it('keeps missing, invalid, and reversed timestamps unknown and reports gaps', async () => {
    const noTime = call('missing', 0);
    const invalid = { ...call('invalid', 0), timestamp: 'PRIVATE_INVALID_TIMESTAMP' };
    const path = await fixture([
      { type: noTime.type, payload: noTime.payload }, output('missing', 2),
      invalid, output('invalid', 3),
      call('reversed', 6), output('reversed', 4),
      call('zero', 7), output('zero', 7),
    ]);
    await appendFile(path, '\ninvalid\nnull\n[]\n{"partial":');
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => (event as TimelineToolEvent).duration_ms), [null, null, null, 0]);
    assert.deepEqual(report.diagnostics, {
      malformed_records: 4, invalid_timestamps: 1, reversed_tool_timestamps: 1, ambiguous_call_ids: 0,
    });
    assert.equal(report.summary.completed, 4);
    assert.equal(report.summary.tools[0].measured_calls, 1);
    assert.equal(report.summary.tools[0].total_duration_ms, 0);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/);
  });

  it('uses record order for chronology even when timestamps go backwards', async () => {
    await fixture([call('first', 4), output('first', 5), call('second', 1), output('second', 2)]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => (event as TimelineToolEvent).call_id), ['first', 'second']);
    assert.equal(report.last_activity_at, time(5));
  });

  it('filters and paginates after pairing while keeping whole-session summaries', async () => {
    await fixture([
      record('event_msg', { type: 'task_started' }),
      call('short', 1), call('long', 2), call('other', 3, 'search'),
      output('short', 2), output('long', 12, { exit_code: 1 }), output('other', 8),
      call('unfinished', 13), record('compacted', {}, 14),
    ]);
    const options = { session: 'timeline-id', codexHomeDir: home };
    const all = await buildSessionTimeline(options);
    const first = await buildSessionTimeline({ ...options, kind: 'tools', sort: 'duration', limit: 1 });
    assert.equal((first.events[0] as TimelineToolEvent).call_id, 'long');
    assert.equal(first.selection.matched_events, 4);
    assert.equal(first.selection.has_more, true);
    const second = await buildSessionTimeline({ ...options, kind: 'tools', sort: 'duration', offset: 1, limit: 1 });
    assert.equal((second.events[0] as TimelineToolEvent).call_id, 'other');
    assert.deepEqual(second.summary, all.summary);
    const filtered = await buildSessionTimeline({ ...options, tool: 'exec', minDurationMs: 1000, status: 'completed' });
    assert.deepEqual(filtered.events.map((event) => (event as TimelineToolEvent).call_id), ['short']);
    const unknownDuration = await buildSessionTimeline({ ...options, status: 'incomplete', minDurationMs: 0 });
    assert.equal(unknownDuration.events.length, 0);
    const pastEnd = await buildSessionTimeline({ ...options, offset: 999 });
    assert.equal(pastEnd.selection.has_more, false);
    assert.equal(pastEnd.events.length, 0);
    assert.deepEqual(pastEnd.summary, all.summary);
    assert.equal((await buildSessionTimeline({ ...options, kind: 'turns' })).events[0].kind, 'turn_start');
    assert.equal((await buildSessionTimeline({ ...options, kind: 'compactions' })).events[0].kind, 'compaction');
  });

  it('resolves archived prefixes, exact IDs, and source ambiguity consistently with export', async () => {
    await fixture([call('active', 1)], 'abc');
    await fixture([call('archived', 1)], 'abcd', true);
    const exact = await buildSessionTimeline({ session: 'abc', codexHomeDir: home });
    assert.equal(exact.archived, false);
    const archived = await buildSessionTimeline({ session: 'abcd', codexHomeDir: home });
    assert.equal(archived.archived, true);
    await assert.rejects(buildSessionTimeline({ session: 'ab', codexHomeDir: home }), /Multiple transcripts/);
    await assert.rejects(buildSessionTimeline({ session: 'missing', codexHomeDir: home }), /No local session/);
    const other = join(home, 'other');
    await fixture([], 'abc', false, other);
    await assert.rejects(buildSessionTimeline({ session: 'abc', codexHomeDirs: [home, other] }), /--codex-home/);
  });

  it('reports empty and message-only histories without inventing turns or durations', async () => {
    await fixture([record('event_msg', { type: 'user_message', message: 'private' }, 2)]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.equal(report.events.length, 0);
    assert.equal(report.summary.turns_started, 0);
    assert.equal(report.last_activity_at, time(2));
  });

  it('validates numeric limits for programmatic callers before reading files', async () => {
    for (const options of [{ limit: 0 }, { limit: 10_001 }, { offset: -1 }, { offset: 1.5 }, { minDurationMs: Infinity }]) {
      await assert.rejects(buildSessionTimeline({ session: 'absent', codexHomeDir: home, ...options }), /Invalid --/);
    }
  });
});
