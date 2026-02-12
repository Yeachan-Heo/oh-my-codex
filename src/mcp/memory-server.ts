/**
 * OMX Project Memory & Notepad MCP Server
 * Provides persistent project memory and session notepad tools
 * Storage: .omx/project-memory.json, .omx/notepad.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, mkdir, appendFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

function getMemoryPath(wd?: string): string {
  return join(wd || process.cwd(), '.omx', 'project-memory.json');
}

function getNotepadPath(wd?: string): string {
  return join(wd || process.cwd(), '.omx', 'notepad.md');
}

interface ProjectMemory {
  techStack?: string;
  build?: string;
  conventions?: string;
  structure?: string;
  notes?: Array<{ category: string; content: string; timestamp: string }>;
  directives?: Array<{ directive: string; priority: string; context?: string; timestamp: string }>;
}

const server = new Server(
  { name: 'omx-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Project Memory tools
    {
      name: 'project_memory_read',
      description: 'Read project memory. Can read full memory or a specific section.',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['all', 'techStack', 'build', 'conventions', 'structure', 'notes', 'directives'] },
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'project_memory_write',
      description: 'Write/update project memory. Can replace entirely or merge.',
      inputSchema: {
        type: 'object',
        properties: {
          memory: { type: 'object', description: 'Memory object to write' },
          merge: { type: 'boolean', description: 'Merge with existing (true) or replace (false)' },
          workingDirectory: { type: 'string' },
        },
        required: ['memory'],
      },
    },
    {
      name: 'project_memory_add_note',
      description: 'Add a categorized note to project memory.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Note category (build, test, deploy, env, architecture)' },
          content: { type: 'string', description: 'Note content' },
          workingDirectory: { type: 'string' },
        },
        required: ['category', 'content'],
      },
    },
    {
      name: 'project_memory_add_directive',
      description: 'Add a persistent directive to project memory.',
      inputSchema: {
        type: 'object',
        properties: {
          directive: { type: 'string', description: 'The directive text' },
          priority: { type: 'string', enum: ['high', 'normal'] },
          context: { type: 'string' },
          workingDirectory: { type: 'string' },
        },
        required: ['directive'],
      },
    },
    // Notepad tools
    {
      name: 'notepad_read',
      description: 'Read notepad content. Can read full or a specific section (priority, working, manual).',
      inputSchema: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: ['all', 'priority', 'working', 'manual'] },
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'notepad_write_priority',
      description: 'Write to Priority Context section. Replaces existing. Keep under 500 chars.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Priority content (under 500 chars)' },
          workingDirectory: { type: 'string' },
        },
        required: ['content'],
      },
    },
    {
      name: 'notepad_write_working',
      description: 'Add timestamped entry to Working Memory section.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Working memory entry' },
          workingDirectory: { type: 'string' },
        },
        required: ['content'],
      },
    },
    {
      name: 'notepad_write_manual',
      description: 'Add entry to Manual section. Never auto-pruned.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Manual entry content' },
          workingDirectory: { type: 'string' },
        },
        required: ['content'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;
  const wd = a.workingDirectory as string | undefined;

  switch (name) {
    // === Project Memory ===
    case 'project_memory_read': {
      const memPath = getMemoryPath(wd);
      if (!existsSync(memPath)) {
        return text({ exists: false });
      }
      const data: ProjectMemory = JSON.parse(await readFile(memPath, 'utf-8'));
      const section = a.section as string | undefined;
      if (section && section !== 'all' && section in data) {
        return text((data as Record<string, unknown>)[section]);
      }
      return text(data);
    }

    case 'project_memory_write': {
      const memPath = getMemoryPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      const merge = a.merge as boolean;
      const newMem = a.memory as Record<string, unknown>;
      if (merge && existsSync(memPath)) {
        const existing = JSON.parse(await readFile(memPath, 'utf-8'));
        const merged = { ...existing, ...newMem };
        await writeFile(memPath, JSON.stringify(merged, null, 2));
      } else {
        await writeFile(memPath, JSON.stringify(newMem, null, 2));
      }
      return text({ success: true });
    }

    case 'project_memory_add_note': {
      const memPath = getMemoryPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      let data: ProjectMemory = {};
      if (existsSync(memPath)) {
        data = JSON.parse(await readFile(memPath, 'utf-8'));
      }
      if (!data.notes) data.notes = [];
      data.notes.push({
        category: a.category as string,
        content: a.content as string,
        timestamp: new Date().toISOString(),
      });
      await writeFile(memPath, JSON.stringify(data, null, 2));
      return text({ success: true, noteCount: data.notes.length });
    }

    case 'project_memory_add_directive': {
      const memPath = getMemoryPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      let data: ProjectMemory = {};
      if (existsSync(memPath)) {
        data = JSON.parse(await readFile(memPath, 'utf-8'));
      }
      if (!data.directives) data.directives = [];
      data.directives.push({
        directive: a.directive as string,
        priority: (a.priority as string) || 'normal',
        context: a.context as string | undefined,
        timestamp: new Date().toISOString(),
      });
      await writeFile(memPath, JSON.stringify(data, null, 2));
      return text({ success: true, directiveCount: data.directives.length });
    }

    // === Notepad ===
    case 'notepad_read': {
      const notePath = getNotepadPath(wd);
      if (!existsSync(notePath)) {
        return text({ exists: false, content: '' });
      }
      const content = await readFile(notePath, 'utf-8');
      const section = a.section as string | undefined;
      if (section && section !== 'all') {
        const sectionContent = extractSection(content, section);
        return text({ section, content: sectionContent });
      }
      return text({ content });
    }

    case 'notepad_write_priority': {
      const notePath = getNotepadPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      const content = a.content as string;
      let existing = existsSync(notePath) ? await readFile(notePath, 'utf-8') : '';
      existing = replaceSection(existing, 'PRIORITY', content.slice(0, 500));
      await writeFile(notePath, existing);
      return text({ success: true });
    }

    case 'notepad_write_working': {
      const notePath = getNotepadPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      const entry = `\n[${new Date().toISOString()}] ${a.content as string}`;
      let existing = existsSync(notePath) ? await readFile(notePath, 'utf-8') : '';
      existing = appendToSection(existing, 'WORKING MEMORY', entry);
      await writeFile(notePath, existing);
      return text({ success: true });
    }

    case 'notepad_write_manual': {
      const notePath = getNotepadPath(wd);
      await mkdir(join(wd || process.cwd(), '.omx'), { recursive: true });
      const entry = `\n${a.content as string}`;
      let existing = existsSync(notePath) ? await readFile(notePath, 'utf-8') : '';
      existing = appendToSection(existing, 'MANUAL', entry);
      await writeFile(notePath, existing);
      return text({ success: true });
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
});

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function extractSection(content: string, section: string): string {
  const header = `## ${section.toUpperCase()}`;
  const idx = content.indexOf(header);
  if (idx < 0) return '';
  const nextHeader = content.indexOf('\n## ', idx + header.length);
  return nextHeader < 0
    ? content.slice(idx + header.length).trim()
    : content.slice(idx + header.length, nextHeader).trim();
}

function replaceSection(content: string, section: string, newContent: string): string {
  const header = `## ${section}`;
  const idx = content.indexOf(header);
  if (idx < 0) {
    return content + `\n\n${header}\n${newContent}\n`;
  }
  const nextHeader = content.indexOf('\n## ', idx + header.length);
  if (nextHeader < 0) {
    return content.slice(0, idx) + `${header}\n${newContent}\n`;
  }
  return content.slice(0, idx) + `${header}\n${newContent}\n` + content.slice(nextHeader);
}

function appendToSection(content: string, section: string, entry: string): string {
  const header = `## ${section}`;
  const idx = content.indexOf(header);
  if (idx < 0) {
    return content + `\n\n${header}${entry}\n`;
  }
  const nextHeader = content.indexOf('\n## ', idx + header.length);
  if (nextHeader < 0) {
    return content + entry;
  }
  return content.slice(0, nextHeader) + entry + content.slice(nextHeader);
}

const transport = new StdioServerTransport();
server.connect(transport).catch(console.error);
