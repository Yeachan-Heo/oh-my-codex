/**
 * OMX Trace MCP Server
 * Provides trace timeline and summary tools for debugging agent flows.
 * Reads .omx/logs/ turn JSONL files produced by the notify hook.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { listModeStateFilesWithScopePreference, resolveWorkingDirectoryForState } from './state-paths.js';
import { shouldAutoStartMcpServer } from './bootstrap.js';

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

interface TraceEntry {
  timestamp: string;
  type: string;
  thread_id?: string;
  turn_id?: string;
  input_preview?: string;
  output_preview?: string;
}

function compareTraceTimestamp(a: TraceEntry, b: TraceEntry): number {
  return (a.timestamp || '').localeCompare(b.timestamp || '');
}

function keepLastEntries(entries: TraceEntry[], entry: TraceEntry, limit: number): void {
  if (limit <= 0) return;

  if (entries.length < limit) {
    entries.push(entry);
    entries.sort(compareTraceTimestamp);
    return;
  }

  if (compareTraceTimestamp(entry, entries[0]) <= 0) return;

  entries[0] = entry;
  let i = 0;
  while (i + 1 < entries.length && compareTraceTimestamp(entries[i], entries[i + 1]) > 0) {
    [entries[i], entries[i + 1]] = [entries[i + 1], entries[i]];
    i++;
  }
}

async function* iterateLogEntries(logsDir: string): AsyncGenerator<TraceEntry> {
  if (!existsSync(logsDir)) return;

  const files = (await readdir(logsDir))
    .filter(f => f.startsWith('turns-') && f.endsWith('.jsonl'))
    .sort();

  for (const file of files) {
    const rl = createInterface({
      input: createReadStream(join(logsDir, file), { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as TraceEntry;
      } catch { /* skip malformed */ }
    }
  }
}

export async function readLogFiles(logsDir: string, last?: number): Promise<TraceEntry[]> {
  if (last && last > 0) {
    const entries: TraceEntry[] = [];
    for await (const entry of iterateLogEntries(logsDir)) {
      keepLastEntries(entries, entry, last);
    }
    return entries;
  }

  const entries: TraceEntry[] = [];
  for await (const entry of iterateLogEntries(logsDir)) {
    entries.push(entry);
  }

  entries.sort(compareTraceTimestamp);
  return entries;
}

interface LogSummary {
  totalTurns: number;
  turnsByType: Record<string, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export async function summarizeLogFiles(logsDir: string): Promise<LogSummary> {
  const turnsByType: Record<string, number> = {};
  let totalTurns = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for await (const turn of iterateLogEntries(logsDir)) {
    totalTurns++;

    const type = turn.type || 'unknown';
    turnsByType[type] = (turnsByType[type] || 0) + 1;

    const timestamp = turn.timestamp || '';
    if (!timestamp) continue;

    if (!firstTimestamp || timestamp.localeCompare(firstTimestamp) < 0) {
      firstTimestamp = timestamp;
    }

    if (!lastTimestamp || timestamp.localeCompare(lastTimestamp) > 0) {
      lastTimestamp = timestamp;
    }
  }

  return { totalTurns, turnsByType, firstTimestamp, lastTimestamp };
}

// ── State file readers for mode timeline ────────────────────────────────────

interface ModeEvent {
  timestamp: string;
  event: string;
  mode: string;
  details?: Record<string, unknown>;
}

export async function readModeEvents(workingDirectory: string): Promise<ModeEvent[]> {
  const events: ModeEvent[] = [];
  const refs = await listModeStateFilesWithScopePreference(workingDirectory);

  for (const ref of refs) {
    try {
      const data = JSON.parse(await readFile(ref.path, 'utf-8'));
      if (data.started_at) {
        events.push({
          timestamp: data.started_at,
          event: 'mode_start',
          mode: ref.mode,
          details: {
            phase: data.current_phase,
            active: data.active,
            scope: ref.scope,
            path: ref.path,
          },
        });
      }
      if (data.completed_at) {
        events.push({
          timestamp: data.completed_at,
          event: 'mode_end',
          mode: ref.mode,
          details: {
            phase: data.current_phase,
            scope: ref.scope,
            path: ref.path,
          },
        });
      }
    } catch { /* skip malformed */ }
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ── Metrics reader ──────────────────────────────────────────────────────────

interface Metrics {
  total_turns: number;
  session_turns: number;
  last_activity: string;
  session_input_tokens?: number;
  session_output_tokens?: number;
  session_total_tokens?: number;
}

async function readMetrics(omxDir: string): Promise<Metrics | null> {
  const metricsPath = join(omxDir, 'metrics.json');
  if (!existsSync(metricsPath)) return null;
  try {
    return JSON.parse(await readFile(metricsPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'omx-trace', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'trace_timeline',
      description: 'Show chronological agent flow trace timeline. Displays turns, mode transitions, and agent activity in time order.',
      inputSchema: {
        type: 'object',
        properties: {
          last: { type: 'number', description: 'Show only the last N entries' },
          filter: {
            type: 'string',
            enum: ['all', 'turns', 'modes'],
            description: 'Filter: all (default), turns (agent turns only), modes (mode transitions only)',
          },
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'trace_summary',
      description: 'Show aggregate statistics for agent flow trace. Includes turn counts, mode usage, token consumption, and timing.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;
  let wd: string;
  try {
    wd = resolveWorkingDirectoryForState(a.workingDirectory as string | undefined);
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: (error as Error).message }) }],
      isError: true,
    };
  }
  const omxDir = join(wd, '.omx');
  const logsDir = join(omxDir, 'logs');

  switch (name) {
    case 'trace_timeline': {
      const last = a.last as number | undefined;
      const filter = (a.filter as string) || 'all';

      const [turns, modeEvents] = await Promise.all([
        filter !== 'modes' ? readLogFiles(logsDir, last) : Promise.resolve([]),
        filter !== 'turns' ? readModeEvents(wd) : Promise.resolve([]),
      ]);

      type TimelineEntry = { timestamp: string; type: string; [key: string]: unknown };
      const timeline: TimelineEntry[] = [
        ...turns.map(t => ({
          timestamp: t.timestamp,
          type: 'turn',
          turn_type: t.type,
          thread_id: t.thread_id,
          input_preview: t.input_preview,
          output_preview: t.output_preview,
        })),
        ...modeEvents.map(e => ({
          timestamp: e.timestamp,
          type: e.event,
          mode: e.mode,
          ...e.details,
        })),
      ];

      timeline.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      const result = last ? timeline.slice(-last) : timeline;

      return text({
        entryCount: result.length,
        totalAvailable: timeline.length,
        filter,
        timeline: result,
      });
    }

    case 'trace_summary': {
      const [logSummary, modeEvents, metrics] = await Promise.all([
        summarizeLogFiles(logsDir),
        readModeEvents(wd),
        readMetrics(omxDir),
      ]);

      const modesByName: Record<string, { starts: number; ends: number }> = {};
      for (const e of modeEvents) {
        if (!modesByName[e.mode]) modesByName[e.mode] = { starts: 0, ends: 0 };
        if (e.event === 'mode_start') modesByName[e.mode].starts++;
        if (e.event === 'mode_end') modesByName[e.mode].ends++;
      }

      const firstTurn = logSummary.firstTimestamp;
      const lastTurn = logSummary.lastTimestamp;
      let durationMs = 0;
      if (firstTurn && lastTurn) {
        durationMs = new Date(lastTurn).getTime() - new Date(firstTurn).getTime();
      }

      return text({
        turns: {
          total: logSummary.totalTurns,
          byType: logSummary.turnsByType,
          firstAt: firstTurn,
          lastAt: lastTurn,
          durationMs,
          durationFormatted: durationMs > 0
            ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
            : 'N/A',
        },
        modes: modesByName,
        metrics: metrics || { note: 'No metrics file found' },
      });
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

if (shouldAutoStartMcpServer('trace')) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
