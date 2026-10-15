import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSessionTimeline, type TimelineToolEvent } from '../timeline.js';
import { readResolvedSessionTranscriptLines, revalidateTranscriptMatches, resolveSessionTranscript } from '../transcript.js';

const START = '2026-10-14T10:00:00.000Z';
function time(seconds: number): string { return new Date(Date.parse(START) + seconds * 1000).toISOString(); }
function record(type: string, payload: unknown, seconds = 0) { return { type, timestamp: time(seconds), payload }; }
function call(id: string | null, seconds: number, name = 'exec', namespace?: string) {
  return record('response_item', {
    type: 'function_call', name, call_id: id, arguments: 'PRIVATE_ARGUMENTS',
    ...(namespace === undefined ? {} : { namespace }),
  }, seconds);
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
      kind: 'tool', name: 'exec', namespace: null, call_id: 'slow', status: 'failed', line_number: 3,
      timestamp: time(1), result_line_number: 6, completed_at: time(5), duration_ms: 4000, exit_code: 2,
    });
    assert.equal(report.duration_ms, 10_000);
    assert.equal(report.last_activity_at, time(10));
    assert.deepEqual(report.summary, {
      events: 8, tool_calls: 3, completed: 1, failed: 1, incomplete: 1, orphan_outputs: 0,
      turns_started: 2, turns_completed: 1, turns_aborted: 1, compactions: 1,
      tools: [
        { name: 'exec', namespace: null, calls: 2, completed: 0, failed: 1, incomplete: 1, measured_calls: 1, total_duration_ms: 4000, max_duration_ms: 4000 },
        { name: 'search', namespace: null, calls: 1, completed: 1, failed: 0, incomplete: 0, measured_calls: 1, total_duration_ms: 1000, max_duration_ms: 1000 },
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

  it('coalesces paired top-level and event-message compaction records', async () => {
    await fixture([
      record('compacted', { message: 'PRIVATE_COMPACTION' }, 1),
      record('event_msg', { type: 'token_count', input_tokens: 1200, cached_input_tokens: 400 }, 2),
      record('event_msg', { type: 'context_compacted', tokens_before: 1200, tokens_after: 300 }, 3),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.equal(report.summary.compactions, 1);
    assert.deepEqual(report.events, [{ kind: 'compaction', line_number: 2, timestamp: time(1) }]);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_COMPACTION/);
  });

  it('does not coalesce unrelated compactions across turn boundaries', async () => {
    await fixture([
      record('compacted', {}, 1),
      record('event_msg', { type: 'task_started', turn_id: 'turn-1' }, 2),
      record('event_msg', { type: 'task_complete', turn_id: 'turn-1' }, 3),
      record('event_msg', { type: 'context_compacted' }, 4),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.equal(report.summary.compactions, 2);
    assert.deepEqual(report.events.filter((event) => event.kind === 'compaction').map((event) => event.timestamp), [time(1), time(4)]);
  });

  it('recognizes explicit failures without classifying arbitrary output text as errors', async () => {
    const results: Array<[unknown, string, number | null]> = [
      [{ exit_code: 1 }, 'failed', 1],
      ['{"metadata":{"exit_code":-1},"output":"private"}', 'failed', -1],
      [{ isError: true, exit_code: 0 }, 'failed', 0],
      [{ is_error: true }, 'failed', null],
      ['Chunk ID: abc\nWall time: 1 seconds\nProcess exited with code 7\nFinal output:\nprivate', 'failed', 7],
      ['Process exited with code 1\nstderr:\nError: test suite failed', 'failed', 1],
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

  it('uses MCP lifecycle errors for paired and output-less calls', async () => {
    await fixture([
      call('mcp-failed', 1, 'read', 'mcp__filesystem'),
      call('mcp-completed', 2, 'read', 'mcp__filesystem'),
      call('mcp-transport-error', 3, 'read', 'mcp__filesystem'),
      call('mcp-output-less', 4, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-failed', result: { Ok: { isError: true } },
      }, 3),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-completed', result: { Ok: { isError: false } },
      }, 4),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-transport-error', result: { Err: 'PRIVATE_MCP_TRANSPORT_ERROR' },
      }, 5),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-output-less', result: { Ok: { isError: true } },
      }, 6),
      output('mcp-failed', 5, 'Wall time: 0.1 seconds\nOutput:\nPermission denied'),
      output('mcp-completed', 6, 'Wall time: 0.1 seconds\nOutput:\nRead complete'),
      output('mcp-transport-error', 7, 'Wall time: 0.1 seconds\nOutput:\nConnection failed'),
    ]);
    const options = { session: 'timeline-id', codexHomeDir: home };
    const report = await buildSessionTimeline(options);
    assert.deepEqual(report.events.map((event) => event.kind === 'tool' ? [event.call_id, event.status, event.exit_code] : null), [
      ['mcp-failed', 'failed', null], ['mcp-completed', 'completed', null], ['mcp-transport-error', 'failed', null],
      ['mcp-output-less', 'failed', null],
    ]);
    assert.equal(report.summary.failed, 3);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.incomplete, 0);
    const outputLess = report.events.find((event) => event.kind === 'tool' && event.call_id === 'mcp-output-less');
    assert.equal(outputLess?.kind === 'tool' ? outputLess.result_line_number : null, 9);
    assert.equal(outputLess?.kind === 'tool' ? outputLess.completed_at : null, time(6));
    assert.equal(outputLess?.kind === 'tool' ? outputLess.duration_ms : null, 2000);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_MCP_TRANSPORT_ERROR/);
    const failures = await buildSessionTimeline({ ...options, status: 'failed' });
    assert.deepEqual(failures.events.map((event) => event.kind === 'tool' ? event.call_id : null), [
      'mcp-failed', 'mcp-transport-error', 'mcp-output-less',
    ]);
  });

  it('finalizes successful MCP lifecycle results without output and refines later output', async () => {
    await fixture([
      call('mcp-output-less', 1, 'read', 'mcp__filesystem'),
      call('mcp-late-output', 2, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-output-less', result: { Ok: { isError: false } },
      }, 3),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'mcp-late-output', result: { Ok: { isError: false } },
      }, 4),
      output('mcp-late-output', 5, { exit_code: 2 }),
    ]);
    const options = { session: 'timeline-id', codexHomeDir: home };
    const report = await buildSessionTimeline(options);
    assert.deepEqual(report.events.map((event) => event.kind === 'tool' ? [
      event.call_id, event.status, event.result_line_number, event.duration_ms, event.exit_code,
    ] : null), [
      ['mcp-output-less', 'completed', 4, 2000, null],
      ['mcp-late-output', 'failed', 6, 3000, 2],
    ]);
    assert.equal(report.summary.completed, 1);
    assert.equal(report.summary.failed, 1);
    assert.deepEqual((await buildSessionTimeline({ ...options, status: 'completed' })).events.map((event) => event.kind), ['tool']);
    assert.deepEqual((await buildSessionTimeline({ ...options, status: 'failed' })).events.map((event) => event.kind), ['tool']);
  });

  it('allows call ID reuse after successful and failed MCP lifecycle results without output', async () => {
    await fixture([
      call('reused-after-lifecycle', 1, 'read', 'mcp__filesystem'),
      call('reused-after-failure', 1, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'reused-after-lifecycle', result: { Ok: { isError: false } },
      }, 2),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'reused-after-failure', result: { Err: 'PRIVATE_ERROR' },
      }, 2),
      call('reused-after-lifecycle', 3, 'read', 'mcp__filesystem'),
      call('reused-after-failure', 3, 'read', 'mcp__filesystem'),
      output('reused-after-lifecycle', 5, { exit_code: 2 }),
      output('reused-after-failure', 5, { exit_code: 0 }),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => event.kind === 'tool' ? [
      event.call_id, event.status, event.result_line_number, event.duration_ms, event.exit_code,
    ] : null), [
      ['reused-after-lifecycle', 'completed', 4, 1000, null],
      ['reused-after-failure', 'failed', 5, 1000, null],
      ['reused-after-lifecycle', 'failed', 8, 2000, 2],
      ['reused-after-failure', 'completed', 9, 2000, 0],
    ]);
    assert.equal(report.diagnostics.ambiguous_call_ids, 0);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ERROR/);
  });

  it('retains unmatched MCP lifecycle results and coalesces a later orphan output', async () => {
    await fixture([
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'orphan-with-output', result: { Err: 'PRIVATE_TRANSPORT_ERROR' },
      }, 1),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'orphan-with-output', output: 'Connection failed' } },
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'orphan-without-output', result: { Ok: { isError: true } },
      }, 3),
      record('event_msg', { type: 'mcp_tool_call_end', result: { Ok: { isError: false } } }, 4),
    ]);
    const options = { session: 'timeline-id', codexHomeDir: home };
    const report = await buildSessionTimeline(options);
    assert.deepEqual(report.events.map((event) => event.kind === 'orphan_output' ? [
      event.line_number, event.timestamp, event.call_id, event.status,
    ] : null), [
      [3, time(1), 'orphan-with-output', 'failed'],
      [4, time(3), 'orphan-without-output', 'failed'],
      [5, time(4), null, 'completed'],
    ]);
    assert.equal(report.summary.orphan_outputs, 3);
    assert.equal(report.summary.tool_calls, 0);
    assert.equal((await buildSessionTimeline({ ...options, status: 'failed' })).events.length, 2);
    assert.equal((await buildSessionTimeline({ ...options, status: 'completed' })).events.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TRANSPORT_ERROR/);
  });

  it('preserves lifecycle timing when later output timestamps are missing or invalid', async () => {
    await fixture([
      call('missing-output-time', 1, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'missing-output-time', result: { Ok: { isError: false } },
      }, 2),
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'missing-output-time', output: 'done' } },
      call('invalid-output-time', 4, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'invalid-output-time', result: { Ok: { isError: false } },
      }, 5),
      { ...output('invalid-output-time', 6), timestamp: 'PRIVATE_INVALID_TIMESTAMP' },
      call('valid-output-time', 7, 'read', 'mcp__filesystem'),
      record('event_msg', {
        type: 'mcp_tool_call_end', call_id: 'valid-output-time', result: { Ok: { isError: false } },
      }, 8),
      output('valid-output-time', 10),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => event.kind === 'tool' ? [
      event.call_id, event.result_line_number, event.completed_at, event.duration_ms,
    ] : null), [
      ['missing-output-time', 4, time(2), 1000],
      ['invalid-output-time', 7, time(5), 1000],
      ['valid-output-time', 10, time(10), 3000],
    ]);
    assert.equal(report.summary.tools[0].measured_calls, 3);
    assert.equal(report.summary.tools[0].total_duration_ms, 5000);
    assert.equal((await buildSessionTimeline({
      session: 'timeline-id', codexHomeDir: home, minDurationMs: 1000,
    })).events.length, 3);
    assert.equal(report.diagnostics.invalid_timestamps, 1);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_INVALID_TIMESTAMP/);
  });

  it('revalidates stale active transcript matches after an archive move', async () => {
    const activePath = await fixture([], 'archive-race');
    const archivedPath = join(home, 'archived_sessions', 'rollout-archive-race.jsonl');
    await mkdir(join(home, 'archived_sessions'), { recursive: true });
    const discovered = {
      path: activePath, id: 'archive-race', startedAt: START, cwd: '/PRIVATE_PROJECT', archived: false,
    };
    await rename(activePath, archivedPath);

    const matches = await revalidateTranscriptMatches([
      discovered,
      { ...discovered, path: archivedPath, archived: true },
    ]);
    assert.deepEqual(matches, [{ ...discovered, path: archivedPath, archived: true }]);
  });

  it('does not guess pairings for missing or duplicate outstanding call IDs', async () => {
    await fixture([
      output('orphan', 0, { isError: true }),
      call(null, 1), output(null, 2),
      call('duplicate', 3),
      record('event_msg', { type: 'mcp_tool_call_end', call_id: 'duplicate', result: { Ok: { isError: true } } }, 4),
      call('duplicate', 5), call('duplicate', 6),
      record('event_msg', { type: 'mcp_tool_call_end', call_id: 'duplicate', result: { Ok: { isError: true } } }, 7),
      output('duplicate', 8), output('duplicate', 9),
    ]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.equal(report.summary.incomplete, 3);
    assert.equal(report.summary.orphan_outputs, 5);
    assert.equal(report.summary.failed, 1); // The first call failed while its ID was still unique.
    assert.equal(report.diagnostics.ambiguous_call_ids, 1);
    assert.equal(report.summary.tools[0].total_duration_ms, 1000);
    const failures = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home, status: 'failed' });
    assert.equal(failures.events.length, 3);
    assert.equal(failures.events[0].kind, 'orphan_output');
    assert.equal(failures.events[1].kind, 'tool');
    if (failures.events[1].kind === 'tool') assert.equal(failures.events[1].call_id, 'duplicate');
    assert.equal(failures.events[2].kind, 'orphan_output');
    if (failures.events[2].kind === 'orphan_output') assert.equal(failures.events[2].call_id, 'duplicate');
  });

  it('allows sequential ID reuse after a result without joining separate calls', async () => {
    await fixture([call('reuse', 1), output('reuse', 2), call('reuse', 3), output('reuse', 5)]);
    const report = await buildSessionTimeline({ session: 'timeline-id', codexHomeDir: home });
    assert.deepEqual(report.events.map((event) => (event as TimelineToolEvent).duration_ms), [1000, 2000]);
    assert.equal(report.diagnostics.ambiguous_call_ids, 0);
  });

  it('keeps namespace as part of tool summary and filter identity', async () => {
    await fixture([
      call('server-a', 1, 'read', 'mcp__server-a'), call('server-b', 2, 'read', 'mcp__server-b'),
      output('server-a', 3), output('server-b', 4),
    ]);
    const options = { session: 'timeline-id', codexHomeDir: home };
    const report = await buildSessionTimeline(options);
    assert.deepEqual(report.summary.tools.map(({ namespace, name, calls }) => ({ namespace, name, calls })), [
      { namespace: 'mcp__server-a', name: 'read', calls: 1 },
      { namespace: 'mcp__server-b', name: 'read', calls: 1 },
    ]);
    assert.equal((await buildSessionTimeline({ ...options, tool: 'read' })).events.length, 2);

    const filtered = await buildSessionTimeline({ ...options, tool: 'read', namespace: 'mcp__server-b' });
    assert.equal(filtered.selection.namespace, 'mcp__server-b');
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].kind, 'tool');
    if (filtered.events[0].kind === 'tool') assert.equal(filtered.events[0].namespace, 'mcp__server-b');
  });

  it('re-resolves a transcript moved to the archive before the timeline opens it', async () => {
    const activePath = await fixture([call('archived-call', 1)], 'archive-race');
    const options = { session: 'archive-race', codexHomeDir: home };
    let transcript = await resolveSessionTranscript(options);
    const archivedPath = join(home, 'archived_sessions', 'rollout-archive-race.jsonl');
    await mkdir(join(home, 'archived_sessions'), { recursive: true });
    await rename(activePath, archivedPath);

    const lines: string[] = [];
    for await (const line of readResolvedSessionTranscriptLines(options, transcript, (resolved) => {
      transcript = resolved;
    })) lines.push(line);
    assert.equal(transcript.archived, true);
    assert.equal(transcript.path, archivedPath);
    assert.equal(lines.length, 2);

    const report = await buildSessionTimeline(options);
    assert.equal(report.archived, true);
    assert.equal(report.summary.tool_calls, 1);
  });

  it('does not replace a missing exact session with another prefix match during retry', async () => {
    const selectedPath = await fixture([], 'abc');
    await fixture([], 'abcd');
    const options = { session: 'abc', codexHomeDir: home };
    const transcript = await resolveSessionTranscript(options);
    await unlink(selectedPath);

    let resolvedAnotherTranscript = false;
    const readLines = async () => {
      for await (const _line of readResolvedSessionTranscriptLines(options, transcript, () => {
        resolvedAnotherTranscript = true;
      })) { /* drain the selected transcript */ }
    };
    await assert.rejects(readLines(), /selected transcript changed during inspection/);
    assert.equal(resolvedAnotherTranscript, false);
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
