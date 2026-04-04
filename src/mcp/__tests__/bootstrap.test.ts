import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shouldAutoStartMcpServer, type McpServerName } from '../bootstrap.js';

const ALL_SERVERS: readonly McpServerName[] = [
  'state',
  'memory',
  'code_intel',
  'trace',
] as const;

const SERVER_DISABLE_ENV: Record<McpServerName, string> = {
  state: 'OMX_STATE_SERVER_DISABLE_AUTO_START',
  memory: 'OMX_MEMORY_SERVER_DISABLE_AUTO_START',
  code_intel: 'OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START',
  trace: 'OMX_TRACE_SERVER_DISABLE_AUTO_START',
};

const SERVER_ENTRYPOINTS: Array<{ server: McpServerName; file: string }> = [
  { server: 'state', file: 'src/mcp/state-server.ts' },
  { server: 'memory', file: 'src/mcp/memory-server.ts' },
  { server: 'code_intel', file: 'src/mcp/code-intel-server.ts' },
  { server: 'trace', file: 'src/mcp/trace-server.ts' },
];

describe('mcp bootstrap auto-start guard', () => {
  it('allows auto-start by default for every OMX MCP server', () => {
    for (const server of ALL_SERVERS) {
      assert.equal(shouldAutoStartMcpServer(server, {}), true, `${server} should auto-start by default`);
    }
  });

  it('disables all servers when global disable flag is set', () => {
    const env = { OMX_MCP_SERVER_DISABLE_AUTO_START: '1' };

    for (const server of ALL_SERVERS) {
      assert.equal(shouldAutoStartMcpServer(server, env), false, `${server} should honor global disable flag`);
    }
  });

  it('disables per-server using server-specific flags', () => {
    for (const server of ALL_SERVERS) {
      assert.equal(
        shouldAutoStartMcpServer(server, { [SERVER_DISABLE_ENV[server]]: '1' }),
        false,
        `${server} should honor ${SERVER_DISABLE_ENV[server]}`,
      );
    }
  });
});

describe('mcp shared stdio lifecycle contract', () => {
  it('keeps shared stdio lifecycle wiring in bootstrap', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');

    assert.match(src, /StdioServerTransport/, 'bootstrap should own stdio transport creation');
    assert.match(src, /server\.connect\(/, 'bootstrap should own MCP server connection');
    assert.match(src, /stdin/i, 'bootstrap should react to stdin/client disconnect');
    assert.match(src, /SIGTERM/, 'bootstrap should handle SIGTERM');
    assert.match(src, /SIGINT/, 'bootstrap should handle SIGINT');
  });

  it('keeps individual server entrypoints free of duplicated raw stdio connect snippets', async () => {
    for (const { server, file } of SERVER_ENTRYPOINTS) {
      const src = await readFile(join(process.cwd(), file), 'utf8');

      assert.match(
        src,
        new RegExp(`autoStartStdioMcpServer\\(['\"]${server}['\"],\\s*server\\)`),
        `${file} should delegate ${server} startup to the shared stdio lifecycle helper`,
      );
      assert.doesNotMatch(
        src,
        /new StdioServerTransport\(\)/,
        `${file} should delegate stdio transport construction to the shared lifecycle helper`,
      );
      assert.doesNotMatch(
        src,
        /server\.connect\(transport\)\.catch\(console\.error\);/,
        `${file} should not duplicate raw server.connect(transport) bootstrap`,
      );
    }
  });
});
