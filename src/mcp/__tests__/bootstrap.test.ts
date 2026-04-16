import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isParentProcessAlive,
  shouldAutoStartMcpServer,
  type McpServerName,
} from '../bootstrap.js';

const ALL_SERVERS: readonly McpServerName[] = [
  'state',
  'memory',
  'code_intel',
  'trace',
  'wiki',
] as const;

const SERVER_DISABLE_ENV: Record<McpServerName, string> = {
  state: 'OMX_STATE_SERVER_DISABLE_AUTO_START',
  memory: 'OMX_MEMORY_SERVER_DISABLE_AUTO_START',
  code_intel: 'OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START',
  trace: 'OMX_TRACE_SERVER_DISABLE_AUTO_START',
  wiki: 'OMX_WIKI_SERVER_DISABLE_AUTO_START',
};

const SERVER_ENTRYPOINTS: Array<{ server: McpServerName; file: string }> = [
  { server: 'state', file: 'src/mcp/state-server.ts' },
  { server: 'memory', file: 'src/mcp/memory-server.ts' },
  { server: 'code_intel', file: 'src/mcp/code-intel-server.ts' },
  { server: 'trace', file: 'src/mcp/trace-server.ts' },
  { server: 'wiki', file: 'src/mcp/wiki-server.ts' },
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

describe('mcp parent watchdog liveness checks', () => {
  it('treats missing or root-like parent pids as gone', () => {
    assert.equal(isParentProcessAlive(0, () => true), false);
    assert.equal(isParentProcessAlive(1, () => true), false);
    assert.equal(isParentProcessAlive(Number.NaN, () => true), false);
  });

  it('treats kill(0) success as parent alive', () => {
    assert.equal(isParentProcessAlive(42, () => true), true);
  });

  it('treats ESRCH as parent gone and EPERM as still alive', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' });
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' });

    assert.equal(isParentProcessAlive(42, () => {
      throw missing;
    }), false);
    assert.equal(isParentProcessAlive(42, () => {
      throw denied;
    }), true);
  });
});

describe('mcp shared stdio lifecycle contract', () => {
  it('keeps shared stdio lifecycle wiring in bootstrap', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');

    assert.match(src, /StdioServerTransport/, 'bootstrap should own stdio transport creation');
    assert.match(src, /server\.connect\(/, 'bootstrap should own MCP server connection');
    assert.match(src, /stdin/i, 'bootstrap should react to stdin/client disconnect');
    assert.match(src, /parent_gone/, 'bootstrap should watch for the parent process disappearing');
    assert.match(src, /isParentProcessAlive\(trackedParentPid\)/, 'bootstrap should probe parent liveness directly');
    assert.match(src, /process\.exit\(0\)/, 'bootstrap should force child exit after shutdown completes');
    assert.match(src, /SIGTERM/, 'bootstrap should handle SIGTERM');
    assert.match(src, /SIGINT/, 'bootstrap should handle SIGINT');
    assert.match(src, /createDuplicateCoordinator/, 'bootstrap should keep duplicate coordination in the shared layer');
    assert.match(src, /once\(['"]data['"],\s*handleFirstTraffic\)/, 'bootstrap should treat first traffic as a one-shot event');
    assert.doesNotMatch(src, /ps axww -o pid=,ppid=,command=/, 'bootstrap must not shell out to ps in the hot path');
    assert.doesNotMatch(src, /listProcessTable\(/, 'bootstrap must not call process-table scanners');
    assert.doesNotMatch(src, /execFileSync\(/, 'bootstrap must not import or call execFileSync for duplicate coordination');
    assert.doesNotMatch(src, /DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS/, 'bootstrap must not keep duplicate polling intervals');
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
