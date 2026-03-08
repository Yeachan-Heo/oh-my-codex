import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED_TOOLS = [
  'lsp_diagnostics',
  'lsp_diagnostics_directory',
  'lsp_document_symbols',
  'lsp_workspace_symbols',
  'lsp_hover',
  'lsp_find_references',
  'lsp_servers',
  'ast_grep_search',
  'ast_grep_replace',
] as const;

describe('mcp/code-intel-server module contract', () => {
  it('declares expected MCP tools and diagnostics command shape', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/code-intel-server.ts'), 'utf8');

    const toolNames = Array.from(src.matchAll(/name:\s*'([^']+)'/g)).map((m) => m[1]);
    for (const tool of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(tool), `missing tool declaration: ${tool}`);
    }

    assert.match(src, /const args = \['--noEmit', '--pretty', 'false'\]/);
    assert.match(src, /new Server\(\s*\{ name: 'omx-code-intel', version: '0\.1\.0' \}/);
  });

  it('keeps stdio auto-connect bootstrap', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/code-intel-server.ts'), 'utf8');
    assert.match(src, /const transport = new StdioServerTransport\(\);/);
    assert.match(src, /server\.connect\(transport\)\.catch\(console\.error\);/);
  });

  it('applies ast-grep rewrites only when dryRun=false', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/code-intel-server.ts'), 'utf8');
    assert.match(src, /export function buildAstGrepRunArgs/);
    assert.match(src, /if \(!options\.dryRun\) \{\s*args\.push\('--update-all'\);/);
    assert.match(src, /args\.push\('--rewrite', options\.replacement\);/);
  });

  it('keeps dry-run/search behavior distinct from apply mode', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/code-intel-server.ts'), 'utf8');
    assert.match(src, /if \(options\.replacement\) \{/);
    assert.match(src, /else \{\s*args\.push\('--json'\);/);
  });
});
