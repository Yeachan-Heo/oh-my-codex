/**
 * OMX Project Memory & Notepad MCP Server
 * Provides persistent project memory and session notepad tools
 * Storage: .omx/project-memory.json, .omx/notepad.md
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { join } from 'path';
import { existsSync, readFileSync, statSync } from 'fs';
import { withCrossProcessFileLockSync } from '../subagents/tracker.js';
import { parseNotepadPruneDaysOld } from './memory-validation.js';
import { autoStartStdioMcpServer } from './bootstrap.js';
import { resolveWorkingDirectoryForState } from './state-paths.js';

function getMemoryPath(wd: string): string {
  return join(wd, '.omx', 'project-memory.json');
}

function getNotepadPath(wd: string): string {
  return join(wd, '.omx', 'notepad.md');
}

interface ProjectMemory {
  techStack?: string;
  build?: string;
  conventions?: string;
  structure?: string;
  notes?: Array<{ category: string; content: string; timestamp: string }>;
  directives?: Array<{ directive: string; priority: string; context?: string; timestamp: string }>;
}

function readProjectMemory(path: string): ProjectMemory {
  const value: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid project memory object at ${path}`);
  }
  return value as ProjectMemory;
}

const server = new Server(
  { name: 'omx-memory', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

export function buildMemoryServerTools() {
  return [
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
    {
      name: 'notepad_prune',
      description: 'Prune Working Memory entries older than N days (default: 7).',
      inputSchema: {
        type: 'object',
        properties: {
          daysOld: { type: 'integer', minimum: 0, description: 'Prune entries older than this many days (default: 7)' },
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'notepad_stats',
      description: 'Get statistics about the notepad (size, entry count, oldest entry).',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildMemoryServerTools(),
}));

export async function handleMemoryToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
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

  const memoryWrite = ['project_memory_write', 'project_memory_add_note', 'project_memory_add_directive'].includes(name);
  const notepadWrite = ['notepad_write_priority', 'notepad_write_working', 'notepad_write_manual', 'notepad_prune'].includes(name);
  if (memoryWrite || notepadWrite) {
    const path = memoryWrite ? getMemoryPath(wd) : getNotepadPath(wd);
    return withCrossProcessFileLockSync(path, (lock) => handleMemoryOperation(name, a, wd, (contents) => {
      lock.assertOwnership();
      lock.publish(contents);
    }));
  }
  return handleMemoryOperation(name, a, wd);
}

function handleMemoryOperation(
  name: string, a: Record<string, unknown>, wd: string, publish?: (contents: string) => void,
) {
  switch (name) {
    // === Project Memory ===
    case 'project_memory_read': {
      const memPath = getMemoryPath(wd);
      if (!existsSync(memPath)) {
        return text({ exists: false });
      }
      let data: ProjectMemory = {};
      try {
        data = readProjectMemory(memPath);
      } catch {
        data = {};
      }
      const section = a.section as string | undefined;
      if (section && section !== 'all' && section in data) {
        return text((data as Record<string, unknown>)[section]);
      }
      return text(data);
    }

    case 'project_memory_write': {
      const memPath = getMemoryPath(wd);
      const merge = a.merge as boolean;
      const newMem = a.memory as Record<string, unknown>;
      if (merge && existsSync(memPath)) {
        const existing = readProjectMemory(memPath);
        const merged = { ...existing, ...newMem };
        publish!(JSON.stringify(merged, null, 2));
      } else {
        publish!(JSON.stringify(newMem, null, 2));
      }
      return text({ success: true });
    }

    case 'project_memory_add_note': {
      const memPath = getMemoryPath(wd);
      let data: ProjectMemory = {};
      if (existsSync(memPath)) {
        data = readProjectMemory(memPath);
      }
      if (!data.notes) data.notes = [];
      data.notes.push({
        category: a.category as string,
        content: a.content as string,
        timestamp: new Date().toISOString(),
      });
      publish!(JSON.stringify(data, null, 2));
      return text({ success: true, noteCount: data.notes.length });
    }

    case 'project_memory_add_directive': {
      const memPath = getMemoryPath(wd);
      let data: ProjectMemory = {};
      if (existsSync(memPath)) {
        data = readProjectMemory(memPath);
      }
      if (!data.directives) data.directives = [];
      data.directives.push({
        directive: a.directive as string,
        priority: (a.priority as string) || 'normal',
        context: a.context as string | undefined,
        timestamp: new Date().toISOString(),
      });
      publish!(JSON.stringify(data, null, 2));
      return text({ success: true, directiveCount: data.directives.length });
    }

    // === Notepad ===
    case 'notepad_read': {
      const notePath = getNotepadPath(wd);
      if (!existsSync(notePath)) {
        return text({ exists: false, content: '' });
      }
      const content = readFileSync(notePath, 'utf-8');
      const section = a.section as string | undefined;
      if (section && section !== 'all') {
        const sectionContent = extractSection(content, section);
        return text({ section, content: sectionContent });
      }
      return text({ content });
    }

    case 'notepad_write_priority': {
      const notePath = getNotepadPath(wd);
      const content = a.content as string;
      let existing: string;
      try {
        existing = readFileSync(notePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          existing = '';
        } else {
          throw err;
        }
      }
      existing = replaceSection(existing, 'PRIORITY', content.slice(0, 500));
      publish!(existing);
      return text({ success: true });
    }

    case 'notepad_write_working': {
      const notePath = getNotepadPath(wd);
      const entry = `\n[${new Date().toISOString()}] ${a.content as string}`;
      let existing: string;
      try {
        existing = readFileSync(notePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          existing = '';
        } else {
          throw err;
        }
      }
      existing = appendToSection(existing, 'WORKING MEMORY', entry);
      publish!(existing);
      return text({ success: true });
    }

    case 'notepad_write_manual': {
      const notePath = getNotepadPath(wd);
      const entry = `\n${a.content as string}`;
      let existing: string;
      try {
        existing = readFileSync(notePath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          existing = '';
        } else {
          throw err;
        }
      }
      existing = appendToSection(existing, 'MANUAL', entry);
      publish!(existing);
      return text({ success: true });
    }

    case 'notepad_prune': {
      const notePath = getNotepadPath(wd);
      if (!existsSync(notePath)) {
        return text({ pruned: 0, message: 'No notepad file found' });
      }
      const parsedDays = parseNotepadPruneDaysOld(a.daysOld);
      if (!parsedDays.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: parsedDays.error }) }],
          isError: true,
        };
      }
      const days = parsedDays.days;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const content = readFileSync(notePath, 'utf-8');
      const workingSection = extractSection(content, 'WORKING MEMORY');
      if (!workingSection) {
        return text({ pruned: 0, message: 'No working memory entries found' });
      }
      const lines = workingSection.split('\n');
      let pruned = 0;
      const kept: string[] = [];
      for (const line of lines) {
        const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
        if (match) {
          const entryTime = new Date(match[1]).getTime();
          if (entryTime < cutoff) {
            pruned++;
            continue;
          }
        }
        kept.push(line);
      }
      if (pruned > 0) {
        const updated = replaceSection(content, 'WORKING MEMORY', kept.join('\n'));
        publish!(updated);
      }
      return text({ pruned, remaining: kept.filter(l => l.match(/^\[/)).length });
    }

    case 'notepad_stats': {
      const notePath = getNotepadPath(wd);
      if (!existsSync(notePath)) {
        return text({ exists: false, size: 0, entryCount: 0, oldestEntry: null });
      }
      const content = readFileSync(notePath, 'utf-8');
      const stats = statSync(notePath);
      const workingSection = extractSection(content, 'WORKING MEMORY');
      const timestamps: string[] = [];
      if (workingSection) {
        for (const line of workingSection.split('\n')) {
          const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
          if (match) timestamps.push(match[1]);
        }
      }
      const prioritySection = extractSection(content, 'PRIORITY');
      const manualSection = extractSection(content, 'MANUAL');
      return text({
        exists: true,
        size: stats.size,
        sections: {
          priority: prioritySection ? prioritySection.length : 0,
          working: timestamps.length,
          manual: manualSection ? manualSection.split('\n').filter(l => l.trim()).length : 0,
        },
        entryCount: timestamps.length,
        oldestEntry: timestamps.length > 0 ? timestamps[0] : null,
        newestEntry: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null,
      });
    }

    default:
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
  }
}

server.setRequestHandler(CallToolRequestSchema, handleMemoryToolCall);

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

autoStartStdioMcpServer('memory', server);
