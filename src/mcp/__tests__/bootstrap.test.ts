import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyzeDuplicateSiblingState,
  MCP_ENTRYPOINT_MARKER_ENV,
  effectivePretrafficSiblings,
  extractMcpEntrypointMarker,
  isParentProcessAlive,
  parseProcessTable,
  resolveCurrentMcpEntrypointMarker,
  resolveDuplicateSiblingWatchdogInitialDelayMs,
  shouldAutoStartMcpServer,
  shouldBackoffWatchdog,
  shouldSelfExitForDuplicateSibling,
  shouldSelfExitForHardCap,
  type DuplicateSiblingObservation,
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

  it('lets post-traffic older duplicates self-exit only after the conservative idle window', () => {
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
      true,
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
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 70_000, 9_000, 1_000),
      true,
    );
  });

  it('uses the later of duplicate observation and last traffic for post-traffic idle', () => {
    const observation = {
      status: 'older_duplicate' as const,
      entrypoint: 'state-server.js',
      matchingPids: [101, 140],
      newerSiblingPids: [140],
    };

    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 13_999, 10_000, 12_000, 1_000, 2_000),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 14_000, 10_000, 12_000, 1_000, 2_000),
      true,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 13_999, 12_000, 10_000, 1_000, 2_000),
      false,
    );
    assert.equal(
      shouldSelfExitForDuplicateSibling(observation, 14_000, 12_000, 10_000, 1_000, 2_000),
      true,
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

describe('mcp pre-traffic hard cap', () => {
  function buildPsFixture(pids: number[], parentPid: number, marker: string) {
    return pids.map((pid) => ({
      pid,
      ppid: parentPid,
      command: `node /tmp/dist/mcp/${marker}`,
    }));
  }

  it('exits the oldest pre-traffic siblings until count drops to cap', () => {
    const parentPid = 1224;
    const marker = 'state-server.js';
    const pids = [101, 102, 103, 104, 105, 106]; // 6 siblings, oldest first
    const processes = buildPsFixture(pids, parentPid, marker);
    const cap = 4;
    // Oldest 2 (101, 102) are pre-traffic; PIDs 103-106 have already received traffic.
    const pretraffic = [101, 102];

    const verdicts = pids.map((pid) => {
      const observation = analyzeDuplicateSiblingState(processes, pid, parentPid, marker);
      return shouldSelfExitForHardCap(observation, pretraffic, cap, pid);
    });

    // exitCount = min(6 - 4, 2) = 2; both pre-traffic siblings exit, the 4 active-traffic ones stay.
    assert.deepEqual(verdicts, [true, true, false, false, false, false]);
  });

  it('selects victims from pre-traffic siblings even when an active sibling holds the oldest PID slot', () => {
    // Codex review (2026-05-06) regression: with matchingPids=[1..5] and PID 1 already in traffic,
    // the cap must still be enforced by selecting from the pre-traffic subset [2..5].
    const parentPid = 55;
    const marker = 'state-server.js';
    const pids = [1, 2, 3, 4, 5];
    const processes = buildPsFixture(pids, parentPid, marker);
    const pretraffic = [2, 3, 4, 5]; // PID 1 has already transitioned to traffic
    const cap = 4;

    const verdicts = pids.map((pid) => {
      const observation = analyzeDuplicateSiblingState(processes, pid, parentPid, marker);
      return shouldSelfExitForHardCap(observation, pretraffic, cap, pid);
    });

    // Total = 5 > cap = 4; exitCount = min(1, 4) = 1; oldest pre-traffic sibling (PID 2) self-exits.
    assert.deepEqual(verdicts, [false, true, false, false, false]);
  });

  it('keeps the lone unique pre-traffic server alive at cap=1 (boundary)', () => {
    const processes = buildPsFixture([101], 55, 'state-server.js');
    const observation = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    assert.equal(
      shouldSelfExitForHardCap(observation, [101], 1, 101),
      false,
      'with cap=1 and a single sibling, the lone server must not self-exit',
    );
  });

  it('returns false when sibling count exactly equals cap (no overshoot)', () => {
    const processes = buildPsFixture([101, 102, 103, 104], 55, 'state-server.js');
    const pretraffic = [101, 102, 103, 104];
    const verdicts = pretraffic.map((pid) => {
      const observation = analyzeDuplicateSiblingState(processes, pid, 55, 'state-server.js');
      return shouldSelfExitForHardCap(observation, pretraffic, 4, pid);
    });
    assert.deepEqual(
      verdicts,
      [false, false, false, false],
      'at length === cap, the cap must keep all siblings (not exit oldest)',
    );
  });

  it('never exits siblings that have received stdin traffic', () => {
    const processes = buildPsFixture([101, 102, 103, 104, 105], 55, 'state-server.js');
    const observation = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    // PID 101 has graduated to traffic, so the ledger excludes it from the pre-traffic set.
    const pretraffic = [102, 103, 104, 105];
    assert.equal(
      shouldSelfExitForHardCap(observation, pretraffic, 4, 101),
      false,
      'active-traffic sibling must never be hard-cap exited',
    );
  });

  it('returns false when cap is 0 (disabled)', () => {
    const processes = buildPsFixture([101, 102, 103, 104, 105], 55, 'state-server.js');
    const observation = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    assert.equal(shouldSelfExitForHardCap(observation, [101, 102, 103, 104, 105], 0, 101), false);
  });

  it('returns false when sibling count is below cap', () => {
    const processes = buildPsFixture([101, 102], 55, 'state-server.js');
    const observation = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    assert.equal(shouldSelfExitForHardCap(observation, [101, 102], 4, 101), false);
  });

  it('returns false when no pre-traffic siblings are known to the ledger (empty pretraffic)', () => {
    const processes = buildPsFixture([101, 102, 103, 104, 105], 55, 'state-server.js');
    const observation = analyzeDuplicateSiblingState(processes, 101, 55, 'state-server.js');
    assert.equal(
      shouldSelfExitForHardCap(observation, [], 4, 101),
      false,
      'an empty pre-traffic set means no killable victims; the cap must skip',
    );
  });

  it('preserves ambiguous-state safety (returns false)', () => {
    const observation: DuplicateSiblingObservation = {
      status: 'ambiguous',
      entrypoint: 'state-server.js',
      matchingPids: [],
      newerSiblingPids: [],
    };
    assert.equal(shouldSelfExitForHardCap(observation, [101], 4, 101), false);
  });

  describe('effectivePretrafficSiblings (in-memory authoritative override for self)', () => {
    it('returns the full set when selfLastTrafficAtMs is null', () => {
      const result = effectivePretrafficSiblings([101, 102, 103], 101, null);
      assert.deepEqual(result, [101, 102, 103]);
    });

    it('excludes self when local traffic has been observed but ledger has not flushed', () => {
      const result = effectivePretrafficSiblings([101, 102, 103], 101, 1_700_000_000_000);
      assert.deepEqual(
        result,
        [102, 103],
        'self must be excluded so the cap cannot evict an already-claimed transport',
      );
    });

    it('returns the set unchanged when self is not in it', () => {
      const result = effectivePretrafficSiblings([102, 103], 101, 1_700_000_000_000);
      assert.deepEqual(result, [102, 103]);
    });

    it('does not mutate the input array', () => {
      const input = [101, 102, 103];
      effectivePretrafficSiblings(input, 101, 42);
      assert.deepEqual(input, [101, 102, 103]);
    });
  });

  it('does not evict self when local stdin traffic is observed but ledger has not yet flushed', () => {
    // Reproduces the bot's race: the ledger still reports PID 101 as 'start' because the
    // fire-and-forget 'traffic' append has not flushed, but in memory we already saw stdin.
    const parentPid = 1224;
    const marker = 'state-server.js';
    const pids = [101, 102, 103, 104, 105]; // 5 siblings, cap=4 → over by 1
    const processes = buildPsFixture(pids, parentPid, marker);
    const ledgerPretraffic = [101, 102, 103, 104, 105]; // ledger says all are pre-traffic
    const observation = analyzeDuplicateSiblingState(processes, 101, parentPid, marker);
    const localLastTrafficAtMs = 1_700_000_000_500;

    const effective = effectivePretrafficSiblings(ledgerPretraffic, 101, localLastTrafficAtMs);
    assert.equal(
      shouldSelfExitForHardCap(observation, effective, 4, 101),
      false,
      'PID 101 has received local traffic; the cap must not evict it even if the ledger lags',
    );
  });
});

describe('mcp duplicate watchdog defensive instrumentation', () => {
  it('wraps the duplicate-sibling watchdog body in try/catch with telemetry', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');
    const runIdx = src.indexOf('const runDuplicateSiblingWatchdog =');
    assert.ok(runIdx > 0, 'runDuplicateSiblingWatchdog must exist in bootstrap.ts');
    const tail = src.slice(runIdx, runIdx + 4_096);
    assert.match(tail, /try\s*\{/, 'watchdog body must be wrapped in try { ... }');
    assert.match(
      tail,
      /catch[\s\S]*?duplicate_watchdog_error/,
      'watchdog must emit duplicate_watchdog_error in its catch handler',
    );
  });

  it('backs off the watchdog interval to a configurable backoff value when cap is exceeded', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');
    assert.match(
      src,
      /clearInterval\(duplicateSiblingWatchdog\)/,
      'back-off must clear the existing watchdog interval',
    );
    assert.match(
      src,
      /duplicateSiblingBackoffIntervalMs/,
      'back-off must use the configured backoff interval (>= 30000ms default)',
    );
    assert.match(
      src,
      /shouldBackoffWatchdog\(observation/,
      'back-off must be gated on shouldBackoffWatchdog',
    );
  });

  it('exposes a configurable backoff interval >= 30000ms by default', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/bootstrap.ts'), 'utf8');
    assert.match(
      src,
      /DEFAULT_DUPLICATE_SIBLING_BACKOFF_INTERVAL_MS\s*=\s*30_000/,
      'default backoff interval should be 30000ms',
    );
  });
});

describe('mcp watchdog back-off detection', () => {
  it('returns true when sibling count exceeds cap', () => {
    const observation: DuplicateSiblingObservation = {
      status: 'older_duplicate',
      entrypoint: 'state-server.js',
      matchingPids: [101, 102, 103, 104, 105],
      newerSiblingPids: [102, 103, 104, 105],
    };
    assert.equal(shouldBackoffWatchdog(observation, 4), true);
  });

  it('returns false at or below cap', () => {
    const observation: DuplicateSiblingObservation = {
      status: 'older_duplicate',
      entrypoint: 'state-server.js',
      matchingPids: [101, 102, 103, 104],
      newerSiblingPids: [102, 103, 104],
    };
    assert.equal(shouldBackoffWatchdog(observation, 4), false);
  });

  it('returns false when cap is 0', () => {
    const observation: DuplicateSiblingObservation = {
      status: 'older_duplicate',
      entrypoint: 'state-server.js',
      matchingPids: [101, 102, 103, 104, 105, 106],
      newerSiblingPids: [102, 103, 104, 105, 106],
    };
    assert.equal(shouldBackoffWatchdog(observation, 0), false);
  });
});
