import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED_TOOLS = [
  'project_memory_read',
  'project_memory_write',
  'project_memory_add_note',
  'project_memory_add_directive',
  'notepad_read',
  'notepad_write_priority',
  'notepad_write_working',
  'notepad_write_manual',
  'notepad_prune',
  'notepad_stats',
] as const;

describe('mcp/memory-server module contract', () => {
  it('declares expected memory and notepad MCP tools', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/memory-server.ts'), 'utf8');
    const toolNames = Array.from(src.matchAll(/name:\s*'([^']+)'/g)).map((m) => m[1]);

    for (const tool of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(tool), `missing tool declaration: ${tool}`);
    }
  });

  it('retains section helpers and stdio bootstrap', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/memory-server.ts'), 'utf8');
    assert.match(src, /resolveWorkingDirectoryForState/);
    assert.match(src, /function extractSection\(content: string, section: string\): string/);
    assert.match(src, /function replaceSection\(content: string, section: string, newContent: string\): string/);
    assert.match(src, /function appendToSection\(content: string, section: string, entry: string\): string/);
    assert.match(src, /server\.connect\(transport\)\.catch\(console\.error\);/);
  });
});
