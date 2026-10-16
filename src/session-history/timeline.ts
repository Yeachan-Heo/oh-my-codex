import { readResolvedSessionTranscriptLines, resolveSessionTranscript, type SessionTranscriptOptions } from './transcript.js';

type JsonRecord = Record<string, unknown>;
export type TimelineKindFilter = 'all' | 'tools' | 'turns' | 'compactions';
export type ToolStatus = 'completed' | 'failed' | 'incomplete';

export interface SessionTimelineOptions extends SessionTranscriptOptions {
  kind?: TimelineKindFilter;
  tool?: string;
  namespace?: string;
  status?: ToolStatus;
  minDurationMs?: number;
  sort?: 'chronological' | 'duration';
  offset?: number;
  limit?: number;
}

interface EventLocation {
  line_number: number;
  timestamp: string | null;
}

export interface TimelineToolEvent extends EventLocation {
  kind: 'tool';
  name: string | null;
  namespace: string | null;
  call_id: string | null;
  status: ToolStatus;
  result_line_number: number | null;
  completed_at: string | null;
  duration_ms: number | null;
  exit_code: number | null;
}

export type SessionTimelineEvent = TimelineToolEvent | (EventLocation & (
  | { kind: 'turn_start' | 'turn_complete' | 'turn_aborted'; turn_id: string | null }
  | { kind: 'compaction' }
  | { kind: 'orphan_output'; call_id: string | null; status: 'completed' | 'failed'; exit_code: number | null }
));

type OrphanOutputEvent = EventLocation & {
  kind: 'orphan_output';
  call_id: string | null;
  status: 'completed' | 'failed';
  exit_code: number | null;
};

export interface TimelineToolSummary {
  name: string | null;
  namespace: string | null;
  calls: number;
  completed: number;
  failed: number;
  incomplete: number;
  measured_calls: number;
  total_duration_ms: number | null;
  max_duration_ms: number | null;
}

export interface SessionTimelineReport {
  schema_version: 1;
  session_id: string;
  archived: boolean;
  started_at: string | null;
  last_activity_at: string | null;
  duration_ms: number | null;
  privacy: { mode: 'metadata-only'; excludes: string[] };
  summary: {
    events: number;
    tool_calls: number;
    completed: number;
    failed: number;
    incomplete: number;
    orphan_outputs: number;
    turns_started: number;
    turns_completed: number;
    turns_aborted: number;
    compactions: number;
    tools: TimelineToolSummary[];
  };
  diagnostics: {
    malformed_records: number;
    invalid_timestamps: number;
    reversed_tool_timestamps: number;
    ambiguous_call_ids: number;
  };
  selection: {
    kind: TimelineKindFilter;
    tool: string | null;
    status: ToolStatus | null;
    min_duration_ms: number | null;
    sort: 'chronological' | 'duration';
    offset: number;
    limit: number;
    matched_events: number;
    has_more: boolean;
    namespace: string | null;
  };
  events: SessionTimelineEvent[];
}

function asObject(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseRecord(value: string): JsonRecord | null {
  try { return asObject(JSON.parse(value)); } catch { return null; }
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function integerOption(value: number | undefined, fallback: number, min: number, max: number, flag: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${flag}: expected an integer between ${min} and ${max}.`);
  }
  return value;
}

// Only inspect explicit result metadata or a recognized shell-result header.
// Words such as "error" in program output are not evidence of tool failure.
function toolOutcome(output: unknown): { status: 'completed' | 'failed'; exit_code: number | null } {
  const object = asObject(output) ?? (typeof output === 'string' ? parseRecord(output) : null);
  const metadata = asObject(object?.metadata);
  const code = object?.exit_code ?? metadata?.exit_code;
  let exitCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  if (!object && typeof output === 'string') {
    const prefix = output.slice(0, 4096);
    const boundary = /\r?\n(?:Final output|Output):(?:\r?\n|$)/.exec(prefix);
    const explicitExitHeader = /^(Process exited with code -?\d+)\r?(?:\r?\n|$)/.exec(prefix);
    const header = boundary ? prefix.slice(0, boundary.index) : (explicitExitHeader?.[1] ?? '');
    if (/^(?:Chunk ID:|Wall time:|Process exited with code )/.test(header)) {
      const match = /^(?:Process exited with code|Exit code:) (-?\d+)\r?$/m.exec(header);
      if (match && Number.isSafeInteger(Number(match[1]))) exitCode = Number(match[1]);
    }
  }
  const failed = object?.isError === true || object?.is_error === true || (exitCode !== null && exitCode !== 0);
  return { status: failed ? 'failed' : 'completed', exit_code: exitCode };
}

function summarize(events: SessionTimelineEvent[]): SessionTimelineReport['summary'] {
  const summary: SessionTimelineReport['summary'] = {
    events: events.length, tool_calls: 0, completed: 0, failed: 0, incomplete: 0,
    orphan_outputs: 0, turns_started: 0, turns_completed: 0, turns_aborted: 0, compactions: 0, tools: [],
  };
  const tools = new Map<string | null, Map<string | null, TimelineToolSummary>>();
  for (const event of events) {
    if (event.kind === 'tool') {
      summary.tool_calls++;
      summary[event.status]++;
      let namespaceTools = tools.get(event.namespace);
      if (!namespaceTools) {
        namespaceTools = new Map();
        tools.set(event.namespace, namespaceTools);
      }
      let tool = namespaceTools.get(event.name);
      if (!tool) {
        tool = {
          name: event.name, namespace: event.namespace, calls: 0, completed: 0, failed: 0, incomplete: 0,
          measured_calls: 0, total_duration_ms: null, max_duration_ms: null,
        };
        namespaceTools.set(event.name, tool);
      }
      tool.calls++;
      tool[event.status]++;
      if (event.duration_ms !== null) {
        tool.measured_calls++;
        tool.total_duration_ms = (tool.total_duration_ms ?? 0) + event.duration_ms;
        tool.max_duration_ms = Math.max(tool.max_duration_ms ?? 0, event.duration_ms);
      }
    } else if (event.kind === 'orphan_output') summary.orphan_outputs++;
    else if (event.kind === 'turn_start') summary.turns_started++;
    else if (event.kind === 'turn_complete') summary.turns_completed++;
    else if (event.kind === 'turn_aborted') summary.turns_aborted++;
    else summary.compactions++;
  }
  summary.tools = [...tools.values()].flatMap((namespaceTools) => [...namespaceTools.values()]).sort((a, b) =>
    (b.total_duration_ms ?? -1) - (a.total_duration_ms ?? -1)
    || (a.namespace ?? '').localeCompare(b.namespace ?? '')
    || (a.name ?? '').localeCompare(b.name ?? ''));
  return summary;
}

export async function buildSessionTimeline(options: SessionTimelineOptions): Promise<SessionTimelineReport> {
  const limit = integerOption(options.limit, 100, 1, 10_000, '--limit');
  const offset = integerOption(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, '--offset');
  const minDuration = options.minDurationMs === undefined ? null
    : integerOption(options.minDurationMs, 0, 0, Number.MAX_SAFE_INTEGER, '--min-duration');
  const kind = options.kind ?? 'all';
  const sort = options.sort ?? 'chronological';
  if (!['all', 'tools', 'turns', 'compactions'].includes(kind)) throw new Error('Invalid --kind.');
  if (!['chronological', 'duration'].includes(sort)) throw new Error('Invalid --sort.');
  if (options.status && !['completed', 'failed', 'incomplete'].includes(options.status)) throw new Error('Invalid --status.');
  let transcript = await resolveSessionTranscript(options);
  const events: SessionTimelineEvent[] = [];
  const pending = new Map<string, TimelineToolEvent>();
  const ambiguous = new Set<string>();
  const mcpToolFailures = new Set<string>();
  const unmatchedMcpResults = new Map<string, OrphanOutputEvent>();
  let unmatchedTopLevelCompaction: (EventLocation & { kind: 'compaction' }) | null = null;
  const diagnostics = { malformed_records: 0, invalid_timestamps: 0, reversed_tool_timestamps: 0, ambiguous_call_ids: 0 };
  let startedAt = timestamp(transcript.startedAt);
  let lastActivityAt = startedAt;
  let lineNumber = 0;

  for await (const line of readResolvedSessionTranscriptLines(options, transcript, (resolved) => {
    transcript = resolved;
    startedAt = timestamp(resolved.startedAt);
    lastActivityAt = startedAt;
  })) {
    lineNumber++;
    const record = parseRecord(line);
    const payload = asObject(record?.payload);
    if (lineNumber === 1 && (record?.type !== 'session_meta' || payload?.id !== transcript.id)) {
      throw new Error('The selected transcript changed during timeline inspection. Try again.');
    }
    if (!line.trim()) continue;
    if (!record) {
      unmatchedTopLevelCompaction = null;
      diagnostics.malformed_records++;
      continue;
    }
    const rawTime = record.timestamp ?? payload?.timestamp;
    const time = timestamp(rawTime);
    if (rawTime !== undefined && rawTime !== null && time === null) diagnostics.invalid_timestamps++;
    if (time && (!lastActivityAt || Date.parse(time) > Date.parse(lastActivityAt))) lastActivityAt = time;
    const location = { line_number: lineNumber, timestamp: time };
    const isTokenCount = record.type === 'event_msg' && payload?.type === 'token_count';
    const isContextCompacted = record.type === 'event_msg' && payload?.type === 'context_compacted';
    if (unmatchedTopLevelCompaction && !isTokenCount && !isContextCompacted && record.type !== 'compacted') {
      unmatchedTopLevelCompaction = null;
    }

    if (record.type === 'compacted') {
      const compaction: EventLocation & { kind: 'compaction' } = { ...location, kind: 'compaction' };
      events.push(compaction);
      unmatchedTopLevelCompaction = compaction;
    } else if (isContextCompacted) {
      const paired = unmatchedTopLevelCompaction;
      if (paired) {
        if (!paired.timestamp) paired.timestamp = time;
        unmatchedTopLevelCompaction = null;
      } else events.push({ ...location, kind: 'compaction' });
    } else if (record.type === 'event_msg' && payload) {
      if (payload.type === 'mcp_tool_call_end') {
        const callId = asString(payload.call_id);
        const result = asObject(payload.result);
        const ok = asObject(result?.Ok);
        const failed = ok?.isError === true || (result !== null && Object.hasOwn(result, 'Err'));
        const hasLifecycleResult = result !== null && (Object.hasOwn(result, 'Ok') || Object.hasOwn(result, 'Err'));
        if (hasLifecycleResult) {
          if (callId && pending.has(callId) && !ambiguous.has(callId)) {
            if (failed) mcpToolFailures.add(callId);
            else mcpToolFailures.delete(callId);
            const call = pending.get(callId);
            if (call) {
              call.status = failed ? 'failed' : 'completed';
              call.result_line_number = lineNumber;
              call.completed_at = time;
              call.duration_ms = null;
              if (time && call.timestamp) {
                const duration = Date.parse(time) - Date.parse(call.timestamp);
                if (duration >= 0) call.duration_ms = duration;
                else diagnostics.reversed_tool_timestamps++;
              }
            }
          } else {
            const orphan: OrphanOutputEvent = {
              ...location, kind: 'orphan_output', call_id: callId,
              status: failed ? 'failed' : 'completed', exit_code: null,
            };
            if (callId && !ambiguous.has(callId)) {
              const previous = unmatchedMcpResults.get(callId);
              if (previous) events.push(previous);
              unmatchedMcpResults.set(callId, orphan);
            } else events.push(orphan);
          }
        }
      } else {
        const boundary = payload.type === 'task_started' ? 'turn_start'
          : payload.type === 'task_complete' ? 'turn_complete'
            : payload.type === 'turn_aborted' ? 'turn_aborted' : null;
        if (boundary) events.push({ ...location, kind: boundary, turn_id: asString(payload.turn_id) });
      }
    } else if (record.type === 'response_item' && payload) {
      const callId = asString(payload.call_id);
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const event: TimelineToolEvent = {
          ...location, kind: 'tool', name: asString(payload.name), namespace: asString(payload.namespace),
          call_id: callId, status: 'incomplete',
          result_line_number: null, completed_at: null, duration_ms: null, exit_code: null,
        };
        events.push(event);
        if (callId) {
          const priorLifecycleResult = unmatchedMcpResults.get(callId);
          if (priorLifecycleResult) {
            events.push(priorLifecycleResult);
            unmatchedMcpResults.delete(callId);
          }
          if (pending.has(callId)) {
            const prior = pending.get(callId);
            if (prior && prior.result_line_number !== null) {
              // Lifecycle results finalize a call even when its separate output is absent.
              pending.delete(callId);
              mcpToolFailures.delete(callId);
              pending.set(callId, event);
            } else {
              // With two outstanding calls sharing an ID, result attribution is unknowable.
              pending.delete(callId);
              ambiguous.add(callId);
              mcpToolFailures.delete(callId);
              diagnostics.ambiguous_call_ids++;
            }
          } else if (!ambiguous.has(callId)) pending.set(callId, event);
        }
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const mcpFailed = callId ? mcpToolFailures.delete(callId) : false;
        const outcome = toolOutcome(payload.output);
        const finalOutcome = mcpFailed ? { ...outcome, status: 'failed' as const } : outcome;
        const call = callId ? pending.get(callId) : undefined;
        if (!call || !callId) {
          const lifecycleResult = callId ? unmatchedMcpResults.get(callId) : undefined;
          if (lifecycleResult && callId) {
            unmatchedMcpResults.delete(callId);
            events.push({
              ...location, timestamp: time ?? lifecycleResult.timestamp, kind: 'orphan_output', call_id: callId,
              status: lifecycleResult.status === 'failed' || finalOutcome.status === 'failed' ? 'failed' : 'completed',
              exit_code: finalOutcome.exit_code ?? lifecycleResult.exit_code,
            });
          } else events.push({ ...location, kind: 'orphan_output', call_id: callId, ...finalOutcome });
          continue;
        }
        pending.delete(callId);
        Object.assign(call, finalOutcome, { result_line_number: lineNumber });
        if (time && call.timestamp) {
          const duration = Date.parse(time) - Date.parse(call.timestamp);
          if (duration >= 0) {
            call.completed_at = time;
            call.duration_ms = duration;
          } else diagnostics.reversed_tool_timestamps++;
        } else if (call.completed_at === null && time) call.completed_at = time;
      }
    }
  }

  events.push(...unmatchedMcpResults.values());
  events.sort((a, b) => a.line_number - b.line_number);

  const selected = events.filter((event) => {
    if (kind === 'tools' && event.kind !== 'tool' && event.kind !== 'orphan_output') return false;
    if (kind === 'turns' && !['turn_start', 'turn_complete', 'turn_aborted'].includes(event.kind)) return false;
    if (kind === 'compactions' && event.kind !== 'compaction') return false;
    if (options.tool && (event.kind !== 'tool' || event.name !== options.tool)) return false;
    if (options.namespace && (event.kind !== 'tool' || event.namespace !== options.namespace)) return false;
    if (options.status && (!('status' in event) || event.status !== options.status)) return false;
    if (minDuration !== null && (event.kind !== 'tool' || event.duration_ms === null || event.duration_ms < minDuration)) return false;
    return true;
  });
  if (sort === 'duration') selected.sort((a, b) =>
    (b.kind === 'tool' ? b.duration_ms ?? -1 : -1) - (a.kind === 'tool' ? a.duration_ms ?? -1 : -1)
    || a.line_number - b.line_number);
  const page = selected.slice(offset, offset + limit);
  return {
    schema_version: 1, session_id: transcript.id, archived: transcript.archived,
    started_at: startedAt, last_activity_at: lastActivityAt,
    duration_ms: startedAt && lastActivityAt ? Date.parse(lastActivityAt) - Date.parse(startedAt) : null,
    privacy: { mode: 'metadata-only', excludes: ['message text', 'instructions', 'reasoning', 'tool arguments', 'tool outputs', 'filesystem paths'] },
    summary: summarize(events), diagnostics,
    selection: {
      kind, tool: options.tool ?? null, status: options.status ?? null, min_duration_ms: minDuration,
      sort, offset, limit, matched_events: selected.length, has_more: offset + page.length < selected.length,
      namespace: options.namespace ?? null,
    },
    events: page,
  };
}
