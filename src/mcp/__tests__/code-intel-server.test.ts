import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

    assert.match(src, /const args = \['--noEmit', '--pretty', 'false', '--incremental', 'true', '--tsBuildInfoFile', tsBuildInfoFile\]/);
    assert.match(src, /new Server\(\s*\{ name: 'omx-code-intel', version: '0\.1\.0' \}/);
  });

  it('delegates stdio lifecycle bootstrapping to the shared MCP bootstrap helper', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/code-intel-server.ts'), 'utf8');

    assert.match(src, /autoStartStdioMcpServer\('code_intel', server\)/);
    assert.doesNotMatch(src, /new StdioServerTransport\(\)/);
    assert.doesNotMatch(src, /server\.connect\(transport\)\.catch\(console\.error\);/);
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

  it('skips tsc diagnostics when the project has no tsconfig', async () => {
    const previous = process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
    process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = '1';

    const projectDir = await mkdtemp(join(tmpdir(), 'omx-code-intel-'));

    try {
      const { runTscDiagnostics } = await import(`../code-intel-server.js?ts=${Date.now()}`);
      let called = false;

      const result = await runTscDiagnostics(
        '',
        projectDir,
        undefined,
        async () => {
          called = true;
          throw new Error('tsc runner should not be called without a tsconfig');
        },
      );

      assert.equal(called, false);
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.command, 'tsc skipped: no tsconfig found');
    } finally {
      if (previous === undefined) {
        delete process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
      } else {
        process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = previous;
      }
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('redirects incremental build-info writes outside the workspace for tsc diagnostics', async () => {
    const previous = process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
    process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = '1';
    const projectDir = await mkdtemp(join(tmpdir(), 'omx-code-intel-incremental-'));
    await writeFile(join(projectDir, 'tsconfig.json'), '{"compilerOptions":{"incremental":true}}\n');
    try {
      const { runTscDiagnostics } = await import(`../code-intel-server.js?incremental=${Date.now()}`);
      let observedArgs: string[] = [];
      await runTscDiagnostics('', projectDir, undefined, async (_command: string, args: string[]) => {
        observedArgs = args;
        return { stdout: '', stderr: '' };
      });
      assert.deepEqual(observedArgs.slice(0, 5), ['tsc', '--noEmit', '--pretty', 'false', '--incremental']);
      assert.equal(observedArgs[5], 'true');
      assert.equal(observedArgs[6], '--tsBuildInfoFile');
      assert.ok(observedArgs[7]);
      assert.equal(resolve(observedArgs[7]!).startsWith(resolve(projectDir)), false);
      assert.equal(existsSync(observedArgs[7]!), false);
    } finally {
      if (previous === undefined) delete process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START;
      else process.env.OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START = previous;
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
