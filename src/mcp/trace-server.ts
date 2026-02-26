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
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { listModeStateFilesWithScopePreference } from './state-paths.js';

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

async function listTurnLogFiles(logsDir: string): Promise<string[]> {
  if (!existsSync(logsDir)) return [];
  return (await readdir(logsDir))
    .filter(f => f.startsWith('turns-') && f.endsWith('.jsonl'))
    .sort();
}

async function* iterateTurnEntries(logsDir: string): AsyncGenerator<TraceEntry> {
  const files = await listTurnLogFiles(logsDir);
  for (const file of files) {
    const stream = createReadStream(join(logsDir, file), { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as TraceEntry;
      } catch {
        // skip malformed
      }
    }
  }
}

function sortByTimestampAsc(entries: TraceEntry[]): void {
  entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

function pushLastEntry(buffer: TraceEntry[], entry: TraceEntry, max: number): void {
  if (buffer.length < max) {
    buffer.push(entry);
    return;
  }
  buffer.shift();
  buffer.push(entry);
}

export async function readTurnTimeline(logsDir: string, last?: number): Promise<{ entries: TraceEntry[]; totalAvailable: number }> {
  if (!existsSync(logsDir)) return { entries: [], totalAvailable: 0 };

  const keepLast = typeof last === 'number' && Number.isFinite(last) && last > 0;
  const entries: TraceEntry[] = [];
  let totalAvailable = 0;

  for await (const entry of iterateTurnEntries(logsDir)) {
    totalAvailable++;
    if (keepLast) {
      pushLastEntry(entries, entry, Math.floor(last));
    } else {
      entries.push(entry);
    }
  }

  sortByTimestampAsc(entries);
  return { entries, totalAvailable };
}

interface TurnSummary {
  total: number;
  byType: Record<string, number>;
  firstAt: string | null;
  lastAt: string | null;
}

export async function summarizeTurns(logsDir: string): Promise<TurnSummary> {
  let total = 0;
  const byType: Record<string, number> = {};
  let firstAt: string | null = null;
  let lastAt: string | null = null;

  for await (const entry of iterateTurnEntries(logsDir)) {
    total++;
    const type = entry.type || 'unknown';
    byType[type] = (byType[type] || 0) + 1;

    if (entry.timestamp) {
      if (!firstAt || entry.timestamp < firstAt) firstAt = entry.timestamp;
      if (!lastAt || entry.timestamp > lastAt) lastAt = entry.timestamp;
    }
  }

  return { total, byType, firstAt, lastAt };
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
  const wd = (a.workingDirectory as string) || process.cwd();
  const omxDir = join(wd, '.omx');
  const logsDir = join(omxDir, 'logs');

  switch (name) {
    case 'trace_timeline': {
      const last = a.last as number | undefined;
      const filter = (a.filter as string) || 'all';

      const [turns, modeEvents] = await Promise.all([
        filter !== 'modes' ? readTurnTimeline(logsDir, last) : Promise.resolve({ entries: [], totalAvailable: 0 }),
        filter !== 'turns' ? readModeEvents(wd) : Promise.resolve([]),
      ]);

      type TimelineEntry = { timestamp: string; type: string; [key: string]: unknown };
      const timeline: TimelineEntry[] = [
        ...turns.entries.map(t => ({
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
      const totalAvailable = filter === 'turns'
        ? turns.totalAvailable
        : (filter === 'modes' ? modeEvents.length : turns.totalAvailable + modeEvents.length);

      return text({
        entryCount: result.length,
        totalAvailable,
        filter,
        timeline: result,
      });
    }

    case 'trace_summary': {
      const [turnSummary, modeEvents, metrics] = await Promise.all([
        summarizeTurns(logsDir),
        readModeEvents(wd),
        readMetrics(omxDir),
      ]);

      const modesByName: Record<string, { starts: number; ends: number }> = {};
      for (const e of modeEvents) {
        if (!modesByName[e.mode]) modesByName[e.mode] = { starts: 0, ends: 0 };
        if (e.event === 'mode_start') modesByName[e.mode].starts++;
        if (e.event === 'mode_end') modesByName[e.mode].ends++;
      }

      const firstTurn = turnSummary.firstAt;
      const lastTurn = turnSummary.lastAt;
      let durationMs = 0;
      if (firstTurn && lastTurn) {
        durationMs = new Date(lastTurn).getTime() - new Date(firstTurn).getTime();
      }

      return text({
        turns: {
          total: turnSummary.total,
          byType: turnSummary.byType,
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

if (process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START !== '1') {
  const transport = new StdioServerTransport();
  server.connect(transport).catch(console.error);
}
