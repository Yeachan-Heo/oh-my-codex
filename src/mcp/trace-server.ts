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
import { existsSync } from 'fs';

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

async function readLogFiles(logsDir: string, last?: number): Promise<TraceEntry[]> {
  if (!existsSync(logsDir)) return [];

  const files = (await readdir(logsDir))
    .filter(f => f.startsWith('turns-') && f.endsWith('.jsonl'))
    .sort();

  const entries: TraceEntry[] = [];

  for (const file of files) {
    const content = await readFile(join(logsDir, file), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
  }

  // Sort by timestamp
  entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  if (last && last > 0) {
    return entries.slice(-last);
  }
  return entries;
}

// ── State file readers for mode timeline ────────────────────────────────────

interface ModeEvent {
  timestamp: string;
  event: string;
  mode: string;
  details?: Record<string, unknown>;
}

async function readModeEvents(stateDir: string): Promise<ModeEvent[]> {
  if (!existsSync(stateDir)) return [];

  const events: ModeEvent[] = [];
  const files = await readdir(stateDir);

  for (const f of files) {
    if (!f.endsWith('-state.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
      const mode = f.replace('-state.json', '');

      if (data.started_at) {
        events.push({
          timestamp: data.started_at,
          event: 'mode_start',
          mode,
          details: { phase: data.current_phase, active: data.active },
        });
      }
      if (data.completed_at) {
        events.push({
          timestamp: data.completed_at,
          event: 'mode_end',
          mode,
          details: { phase: data.current_phase },
        });
      }
    } catch { /* skip */ }
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
  const stateDir = join(omxDir, 'state');

  switch (name) {
    case 'trace_timeline': {
      const last = a.last as number | undefined;
      const filter = (a.filter as string) || 'all';

      const [turns, modeEvents] = await Promise.all([
        filter !== 'modes' ? readLogFiles(logsDir, last) : Promise.resolve([]),
        filter !== 'turns' ? readModeEvents(stateDir) : Promise.resolve([]),
      ]);

      // Merge and sort by timestamp
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
      const [turns, modeEvents, metrics] = await Promise.all([
        readLogFiles(logsDir),
        readModeEvents(stateDir),
        readMetrics(omxDir),
      ]);

      // Turn statistics
      const turnsByType: Record<string, number> = {};
      for (const t of turns) {
        const type = t.type || 'unknown';
        turnsByType[type] = (turnsByType[type] || 0) + 1;
      }

      // Mode statistics
      const modesByName: Record<string, { starts: number; ends: number }> = {};
      for (const e of modeEvents) {
        if (!modesByName[e.mode]) modesByName[e.mode] = { starts: 0, ends: 0 };
        if (e.event === 'mode_start') modesByName[e.mode].starts++;
        if (e.event === 'mode_end') modesByName[e.mode].ends++;
      }

      // Timing
      const firstTurn = turns.length > 0 ? turns[0].timestamp : null;
      const lastTurn = turns.length > 0 ? turns[turns.length - 1].timestamp : null;
      let durationMs = 0;
      if (firstTurn && lastTurn) {
        durationMs = new Date(lastTurn).getTime() - new Date(firstTurn).getTime();
      }

      return text({
        turns: {
          total: turns.length,
          byType: turnsByType,
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

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
