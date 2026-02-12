/**
 * OMX State Management MCP Server
 * Provides state read/write/clear/list tools for workflow modes
 * Storage: .omx/state/{mode}-state.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, readdir, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const SUPPORTED_MODES = [
  'autopilot', 'ultrapilot', 'team', 'pipeline',
  'ralph', 'ultrawork', 'ultraqa', 'ecomode', 'ralplan',
] as const;

type Mode = typeof SUPPORTED_MODES[number];

function getStateDir(workingDirectory?: string): string {
  return join(workingDirectory || process.cwd(), '.omx', 'state');
}

function getStatePath(mode: string, workingDirectory?: string): string {
  return join(getStateDir(workingDirectory), `${mode}-state.json`);
}

const server = new Server(
  { name: 'omx-state', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'state_read',
      description: 'Read state for a specific mode. Returns JSON state data or indicates no state exists.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES], description: 'The mode to read state for' },
          workingDirectory: { type: 'string', description: 'Working directory override' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_write',
      description: 'Write/update state for a specific mode. Creates directories if needed.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          active: { type: 'boolean' },
          iteration: { type: 'number' },
          max_iterations: { type: 'number' },
          current_phase: { type: 'string' },
          task_description: { type: 'string' },
          started_at: { type: 'string' },
          completed_at: { type: 'string' },
          error: { type: 'string' },
          state: { type: 'object', description: 'Additional custom fields' },
          workingDirectory: { type: 'string' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_clear',
      description: 'Clear/delete state for a specific mode.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          workingDirectory: { type: 'string' },
        },
        required: ['mode'],
      },
    },
    {
      name: 'state_list_active',
      description: 'List all currently active modes.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'state_get_status',
      description: 'Get detailed status for a specific mode or all modes.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...SUPPORTED_MODES] },
          workingDirectory: { type: 'string' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const wd = (args as Record<string, unknown>)?.workingDirectory as string | undefined;

  switch (name) {
    case 'state_read': {
      const mode = (args as Record<string, unknown>).mode as string;
      const path = getStatePath(mode, wd);
      if (!existsSync(path)) {
        return { content: [{ type: 'text', text: JSON.stringify({ exists: false, mode }) }] };
      }
      const data = await readFile(path, 'utf-8');
      return { content: [{ type: 'text', text: data }] };
    }

    case 'state_write': {
      const mode = (args as Record<string, unknown>).mode as string;
      const stateDir = getStateDir(wd);
      await mkdir(stateDir, { recursive: true });
      const path = getStatePath(mode, wd);

      let existing: Record<string, unknown> = {};
      if (existsSync(path)) {
        try {
          existing = JSON.parse(await readFile(path, 'utf-8'));
        } catch { /* start fresh */ }
      }

      const { mode: _m, workingDirectory: _w, state: customState, ...fields } = args as Record<string, unknown>;
      const merged = { ...existing, ...fields, ...(customState as Record<string, unknown> || {}) };
      await writeFile(path, JSON.stringify(merged, null, 2));
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, mode, path }) }] };
    }

    case 'state_clear': {
      const mode = (args as Record<string, unknown>).mode as string;
      const path = getStatePath(mode, wd);
      if (existsSync(path)) {
        await unlink(path);
      }
      return { content: [{ type: 'text', text: JSON.stringify({ cleared: true, mode }) }] };
    }

    case 'state_list_active': {
      const stateDir = getStateDir(wd);
      const active: string[] = [];
      if (existsSync(stateDir)) {
        const files = await readdir(stateDir);
        for (const f of files) {
          if (!f.endsWith('-state.json')) continue;
          try {
            const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
            if (data.active) {
              active.push(f.replace('-state.json', ''));
            }
          } catch { /* skip malformed */ }
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ active_modes: active }) }] };
    }

    case 'state_get_status': {
      const mode = (args as Record<string, unknown>)?.mode as string | undefined;
      const stateDir = getStateDir(wd);
      const statuses: Record<string, unknown> = {};

      if (!existsSync(stateDir)) {
        return { content: [{ type: 'text', text: JSON.stringify({ statuses: {} }) }] };
      }

      const files = await readdir(stateDir);
      for (const f of files) {
        if (!f.endsWith('-state.json')) continue;
        const m = f.replace('-state.json', '');
        if (mode && m !== mode) continue;
        try {
          const data = JSON.parse(await readFile(join(stateDir, f), 'utf-8'));
          statuses[m] = { active: data.active, phase: data.current_phase, path: join(stateDir, f), data };
        } catch {
          statuses[m] = { error: 'malformed state file' };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ statuses }) }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

// Start server
const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
