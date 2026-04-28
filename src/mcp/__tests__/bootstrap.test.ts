import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyzeDuplicateSiblingState,
  MCP_ENTRYPOINT_MARKER_ENV,
  extractMcpEntrypointMarker,
  isParentProcessAlive,
  parseProcessTable,
  resolveCurrentMcpEntrypointMarker,
  resolveDuplicateSiblingWatchdogInitialDelayMs,
  shouldAutoStartMcpServer,
  shouldSelfExitForDuplicateSibling,
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
  it('keeps server connection immediate and duplicate process-table scans delayed', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');
    const connectIndex = src.indexOf('server.connect(transport)');
    const duplicateDelayIndex = src.indexOf('duplicateSiblingInitialDelayTimer = setTimeout');

    assert.ok(connectIndex > 0, 'bootstrap should still connect the MCP transport');
    assert.ok(duplicateDelayIndex > 0, 'bootstrap should delay duplicate-sibling process scans');
    assert.ok(
      connectIndex > duplicateDelayIndex,
      'duplicate-sibling scan delay must not wrap or delay server.connect',
    );
    assert.match(
      src,
      /const transport = new StdioServerTransport\(\);/,
      'transport construction should remain eager',
    );
  });

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
    assert.match(src, /analyzeDuplicateSiblingState/, 'bootstrap should keep duplicate sibling detection in the shared layer');
    assert.match(src, /shouldSelfExitForDuplicateSibling/, 'bootstrap should gate self-exit conservatively in the shared layer');
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

describe('mcp duplicate sibling detection', () => {
  it('resolves deterministic bounded initial duplicate scan delays', () => {
    const stateDelay = resolveDuplicateSiblingWatchdogInitialDelayMs(
      'state',
      'state-server.js',
      { duplicateSiblingInitialDelayMs: null, duplicateSiblingInitialDelayMaxMs: 1000 },
    );
    const memoryDelay = resolveDuplicateSiblingWatchdogInitialDelayMs(
      'memory',
      'memory-server.js',
      { duplicateSiblingInitialDelayMs: null, duplicateSiblingInitialDelayMaxMs: 1000 },
    );

    assert.equal(
      stateDelay,
      resolveDuplicateSiblingWatchdogInitialDelayMs(
        'state',
        'state-server.js',
        { duplicateSiblingInitialDelayMs: null, duplicateSiblingInitialDelayMaxMs: 1000 },
      ),
      'delay should be stable for a server/entrypoint',
    );
    assert.ok(stateDelay >= 0 && stateDelay <= 1000);
    assert.ok(memoryDelay >= 0 && memoryDelay <= 1000);
    assert.notEqual(stateDelay, memoryDelay, 'first-party servers should be staggered by default');
    assert.equal(
      resolveDuplicateSiblingWatchdogInitialDelayMs(
        'state',
        'state-server.js',
        { duplicateSiblingInitialDelayMs: 0, duplicateSiblingInitialDelayMaxMs: 1000 },
      ),
      0,
      'explicit zero delay should remain available for tests/operators',
    );
  });

  it('extracts same-entrypoint markers from command lines', () => {
    assert.equal(
      extractMcpEntrypointMarker('node /tmp/oh-my-codex/dist/mcp/state-server.js'),
      'state-server.js',
    );
    assert.equal(
      extractMcpEntrypointMarker('node C:\\\\tmp\\\\oh-my-codex\\\\dist\\\\mcp\\\\trace-server.ts'),
      'trace-server.ts',
    );
    assert.equal(
      extractMcpEntrypointMarker('node /tmp/dist/cli/omx.js mcp-serve state'),
      'state-server.js',
    );
    assert.equal(
      extractMcpEntrypointMarker('node /tmp/dist/cli/omx.js mcp-serve code-intel'),
      'code-intel-server.js',
    );
    assert.equal(extractMcpEntrypointMarker('node something-else.js'), null);
  });


  it('prefers an explicit MCP entrypoint marker over argv[1]', () => {
    assert.equal(
      resolveCurrentMcpEntrypointMarker(
        { [MCP_ENTRYPOINT_MARKER_ENV]: 'trace-server.js' },
        '/repo/dist/cli/omx.js',
      ),
      'trace-server.js',
    );
  });

  it('falls back to argv[1] when no explicit MCP entrypoint marker is set', () => {
    assert.equal(
      resolveCurrentMcpEntrypointMarker({}, '/repo/dist/mcp/state-server.js'),
      'state-server.js',
    );
  });

  it('parses ps output into process table entries', () => {
    assert.deepEqual(
      parseProcessTable('101 55 node /tmp/dist/mcp/state-server.js\n'),
      [{ pid: 101, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' }],
    );
  });

  it('treats a single instance as unique and no-op', () => {
    const observation = analyzeDuplicateSiblingState(
      [{ pid: 101, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' }],
      101,
      55,
      'state-server.js',
    );

    assert.equal(observation.status, 'unique');
    assert.deepEqual(observation.matchingPids, [101]);
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 10_000, 9_000, null),
      false,
    );
  });

  it('prefers the newest same-parent same-entrypoint process as survivor', () => {
    const processes = [
      { pid: 101, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' },
      { pid: 140, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' },
      { pid: 160, ppid: 55, command: 'node /tmp/dist/mcp/memory-server.js' },
    ];

    const older = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    const newest = analyzeDuplicateSiblingState(processes, 140, 55, 'state-server.js');

    assert.equal(older.status, 'older_duplicate');
    assert.deepEqual(older.newerSiblingPids, [140]);
    assert.equal(newest.status, 'newest');
    assert.deepEqual(newest.newerSiblingPids, []);
  });


  it('detects duplicate plugin-launched mcp-serve public-target siblings', () => {
    const processes = [
      { pid: 101, ppid: 55, command: 'node /repo/dist/cli/omx.js mcp-serve state' },
      { pid: 140, ppid: 55, command: 'node /repo/dist/cli/omx.js mcp-serve state' },
      { pid: 160, ppid: 55, command: 'node /repo/dist/cli/omx.js mcp-serve memory' },
    ];

    const older = analyzeDuplicateSiblingState(
      processes,
      101,
      55,
      'state-server.js',
    );
    const newest = analyzeDuplicateSiblingState(
      processes,
      140,
      55,
      'state-server.js',
    );

    assert.equal(older.status, 'older_duplicate');
    assert.deepEqual(older.matchingPids, [101, 140]);
    assert.deepEqual(older.newerSiblingPids, [140]);
    assert.equal(newest.status, 'newest');
    assert.deepEqual(newest.newerSiblingPids, []);
  });

  it('only lets older duplicates self-exit after the conservative grace window before traffic', () => {
    const observation = {
      status: 'older_duplicate' as const,
      entrypoint: 'state-server.js',
      matchingPids: [101, 140],
      newerSiblingPids: [140],
    };

    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 10_500, 9_000, null),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 11_100, 9_000, null),
      true,
    );
  });

  it('does not self-exit after any client traffic even when a newer sibling appears', () => {
    const observation = {
      status: 'older_duplicate' as const,
      entrypoint: 'state-server.js',
      matchingPids: [101, 140],
      newerSiblingPids: [140],
    };

    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 35_000, 1_000, 10_000),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 311_000, 1_000, 10_000),
      false,
    );
  });

  it('keeps an already-initialized older sibling alive when last traffic predates duplicate observation', () => {
    const observation = {
      status: 'older_duplicate' as const,
      entrypoint: 'state-server.js',
      matchingPids: [101, 140],
      newerSiblingPids: [140],
    };

    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 10_500, 9_000, 1_000),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 11_100, 9_000, 1_000),
      false,
    );
  });

  it('treats future or non-finite traffic timestamps as a do-not-self-kill marker', () => {
    const observation = {
      status: 'older_duplicate' as const,
      entrypoint: 'state-server.js',
      matchingPids: [101, 140],
      newerSiblingPids: [140],
    };

    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 499_000, 200_000, 500_000),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 900_000, 200_000, Number.NaN),
      false,
    );
  });

  it('treats ambiguous duplicate state as no-op', () => {
    const missingSelf = analyzeDuplicateSiblingState(
      [{ pid: 140, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' }],
      101,
      55,
      'state-server.js',
    );
    const mismatchedSelfMarker = analyzeDuplicateSiblingState(
      [
        { pid: 101, ppid: 55, command: 'node /tmp/dist/mcp/memory-server.js' },
        { pid: 140, ppid: 55, command: 'node /tmp/dist/mcp/state-server.js' },
      ],
      101,
      55,
      'state-server.js',
    );

    assert.equal(missingSelf.status, 'ambiguous');
    assert.equal(mismatchedSelfMarker.status, 'ambiguous');
    assert.equal(
      shouldSelfExitForDuplicateSibling(missingSelf, 50_000, 10_000, null),
      false,
    );
  });
});
