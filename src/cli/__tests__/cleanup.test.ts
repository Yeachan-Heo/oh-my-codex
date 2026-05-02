import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupCommand,
  cleanupOmxMcpProcesses,
  cleanupStaleTmpDirectories,
  extractOmxMcpEntrypoint,
  findCleanupCandidates,
  findDuplicateSiblingCleanupCandidates,
  findLaunchSafeCleanupCandidates,
  isOmxMcpProcess,
  listOmxProcesses,
  type ProcessEntry,
} from '../cleanup.js';

const CURRENT_SESSION_PROCESSES: ProcessEntry[] = [
  { pid: 700, ppid: 500, command: 'codex' },
  { pid: 701, ppid: 700, command: 'node /repo/bin/omx.js cleanup --dry-run' },
  {
    pid: 710,
    ppid: 700,
    command: 'node /repo/oh-my-codex/dist/mcp/state-server.js',
  },
  {
    pid: 800,
    ppid: 1,
    command: 'node /tmp/oh-my-codex/dist/mcp/memory-server.js',
  },
  {
    pid: 810,
    ppid: 42,
    command: 'node /tmp/worktree/dist/mcp/trace-server.js',
  },
  {
    pid: 820,
    ppid: 50,
    command: 'codex --model gpt-5',
  },
  {
    pid: 821,
    ppid: 820,
    command: 'node /tmp/other-session/dist/mcp/state-server.js',
  },
  {
    pid: 830,
    ppid: 50,
    command: 'node /repo/bin/omx.js autoresearch --topic launch',
  },
  {
    pid: 831,
    ppid: 830,
    command: 'node /tmp/parallel-session/dist/mcp/memory-server.js',
  },
  {
    pid: 900,
    ppid: 1,
    command: 'node /tmp/not-omx/other-server.js',
  },
];

describe('findCleanupCandidates', () => {
  it('does not treat legacy team-server entrypoints as active OMX MCP processes', () => {
    assert.equal(isOmxMcpProcess('node /tmp/worktree/dist/mcp/team-server.js'), false);
  });

  it('extracts first-party MCP entrypoints for duplicate grouping', () => {
    assert.equal(
      extractOmxMcpEntrypoint('node /repo/oh-my-codex/dist/mcp/state-server.js'),
      'state-server.js',
    );
    assert.equal(
      extractOmxMcpEntrypoint('node C:\\repo\\oh-my-codex\\dist\\mcp\\code-intel-server.cjs'),
      'code-intel-server.cjs',
    );
    assert.equal(extractOmxMcpEntrypoint('node /tmp/worktree/dist/mcp/team-server.js'), null);
  });

  it('selects orphaned OMX MCP processes while preserving the current session tree', () => {
    assert.deepEqual(
      findCleanupCandidates(CURRENT_SESSION_PROCESSES, 701),
      [
        {
          pid: 800,
          ppid: 1,
          command: 'node /tmp/oh-my-codex/dist/mcp/memory-server.js',
          reason: 'ppid=1',
        },
        {
          pid: 810,
          ppid: 42,
          command: 'node /tmp/worktree/dist/mcp/trace-server.js',
          reason: 'outside-current-session',
        },
        {
          pid: 821,
          ppid: 820,
          command: 'node /tmp/other-session/dist/mcp/state-server.js',
          reason: 'outside-current-session',
        },
        {
          pid: 831,
          ppid: 830,
          command: 'node /tmp/parallel-session/dist/mcp/memory-server.js',
          reason: 'outside-current-session',
        },
      ],
    );
  });

  it('limits launch-safe cleanup to OMX MCP processes with no live Codex or OMX launch ancestor', () => {
    assert.deepEqual(
      findLaunchSafeCleanupCandidates(CURRENT_SESSION_PROCESSES, 701),
      [
        {
          pid: 800,
          ppid: 1,
          command: 'node /tmp/oh-my-codex/dist/mcp/memory-server.js',
          reason: 'ppid=1',
        },
        {
          pid: 810,
          ppid: 42,
          command: 'node /tmp/worktree/dist/mcp/trace-server.js',
          reason: 'outside-current-session',
        },
      ],
    );
  });

  it('selects older duplicate siblings under a reused current Codex parent', () => {
    const reusedParentProcesses: ProcessEntry[] = [
      { pid: 700, ppid: 500, command: 'codex app-server' },
      { pid: 701, ppid: 700, command: 'node /repo/bin/omx.js cleanup --dry-run' },
      {
        pid: 710,
        ppid: 700,
        command: 'node /repo/oh-my-codex/dist/mcp/state-server.js',
      },
      {
        pid: 730,
        ppid: 700,
        command: 'node /repo/oh-my-codex/dist/mcp/state-server.js',
      },
      {
        pid: 740,
        ppid: 700,
        command: 'node /repo/oh-my-codex/dist/mcp/memory-server.js',
      },
    ];

    assert.deepEqual(findDuplicateSiblingCleanupCandidates(reusedParentProcesses), [
      {
        pid: 710,
        ppid: 700,
        command: 'node /repo/oh-my-codex/dist/mcp/state-server.js',
        reason: 'duplicate-sibling',
      },
    ]);
    assert.deepEqual(findCleanupCandidates(reusedParentProcesses, 701), [
      {
        pid: 710,
        ppid: 700,
        command: 'node /repo/oh-my-codex/dist/mcp/state-server.js',
        reason: 'duplicate-sibling',
      },
    ]);
    assert.deepEqual(findLaunchSafeCleanupCandidates(reusedParentProcesses, 701), []);
  });

  it('keeps live-session MCPs protected, including duplicate siblings', () => {
    const processes: ProcessEntry[] = [
      { pid: 700, ppid: 500, command: 'codex app-server' },
      { pid: 701, ppid: 700, command: 'node /repo/bin/omx.js cleanup --dry-run' },
      { pid: 710, ppid: 700, command: 'node /repo/dist/mcp/state-server.js' },
      { pid: 711, ppid: 700, command: 'node /repo/dist/mcp/state-server.js' },
      { pid: 720, ppid: 700, command: 'node /repo/dist/mcp/wiki-server.js' },
      { pid: 900, ppid: 800, command: 'codex --model gpt-5' },
      { pid: 901, ppid: 900, command: 'node /repo/dist/mcp/trace-server.js' },
    ];

    assert.deepEqual(findLaunchSafeCleanupCandidates(processes, 701), []);
  });

  it('preserves same-parent first-party MCP siblings under live Codex and OMX ancestors during launch-safe cleanup', () => {
    const processes: ProcessEntry[] = [
      { pid: 100, ppid: 1, command: 'codex app-server' },
      { pid: 110, ppid: 100, command: 'node /repo/bin/omx.js launch' },
      { pid: 111, ppid: 110, command: 'node /repo/bin/omx.js cleanup --launch-safe' },
      { pid: 120, ppid: 100, command: 'node /repo/dist/mcp/state-server.js' },
      { pid: 121, ppid: 100, command: 'node /repo/dist/mcp/state-server.js' },
      { pid: 130, ppid: 110, command: 'node /repo/dist/mcp/memory-server.js' },
      { pid: 131, ppid: 110, command: 'node /repo/dist/mcp/memory-server.js' },
    ];

    assert.deepEqual(findCleanupCandidates(processes, 111), [
      {
        pid: 120,
        ppid: 100,
        command: 'node /repo/dist/mcp/state-server.js',
        reason: 'duplicate-sibling',
      },
      {
        pid: 130,
        ppid: 110,
        command: 'node /repo/dist/mcp/memory-server.js',
        reason: 'duplicate-sibling',
      },
    ]);
    assert.deepEqual(findLaunchSafeCleanupCandidates(processes, 111), []);
  });

  it('keeps detached MCP candidates whose ancestor chain is live but unrelated to Codex or OMX launchers', () => {
    const unrelatedAncestorProcesses: ProcessEntry[] = [
      { pid: 701, ppid: 700, command: 'node /repo/bin/omx.js' },
      { pid: 840, ppid: 841, command: 'node /tmp/unrelated/dist/mcp/state-server.js' },
      { pid: 841, ppid: 842, command: 'node worker.js' },
      { pid: 842, ppid: 1, command: 'bash' },
    ];

    assert.deepEqual(findLaunchSafeCleanupCandidates(unrelatedAncestorProcesses, 701), [
      {
        pid: 840,
        ppid: 841,
        command: 'node /tmp/unrelated/dist/mcp/state-server.js',
        reason: 'outside-current-session',
      },
    ]);
  });

  it('always preserves ppid=1 orphan candidates even if pid 1 matches a protected ancestor predicate', () => {
    const reparentedProcesses: ProcessEntry[] = [
      { pid: 1, ppid: 0, command: 'codex' },
      { pid: 701, ppid: 700, command: 'node /repo/bin/omx.js' },
      { pid: 840, ppid: 1, command: 'node /tmp/reparented/dist/mcp/state-server.js' },
    ];

    assert.deepEqual(findLaunchSafeCleanupCandidates(reparentedProcesses, 701), [
      {
        pid: 840,
        ppid: 1,
        command: 'node /tmp/reparented/dist/mcp/state-server.js',
        reason: 'ppid=1',
      },
    ]);
  });
});

describe('listOmxProcesses', () => {
  it('parses valid Windows process discovery rows on win32', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const processes = listOmxProcesses(() => [
        JSON.stringify({ pid: 800, ppid: 1, command: 'node C:/tmp/oh-my-codex/dist/mcp/state-server.js' }),
        JSON.stringify({ pid: 810, ppid: 42, command: 'node C:/tmp/oh-my-codex/dist/mcp/trace-server.js' }),
      ].join('\n'));
      assert.deepEqual(processes, [
        { pid: 800, ppid: 1, command: 'node C:/tmp/oh-my-codex/dist/mcp/state-server.js' },
        { pid: 810, ppid: 42, command: 'node C:/tmp/oh-my-codex/dist/mcp/trace-server.js' },
      ]);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('drops malformed Windows process discovery rows on win32', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const processes = listOmxProcesses(() => [
        JSON.stringify({ pid: 800, ppid: 1, command: 'node C:/tmp/oh-my-codex/dist/mcp/state-server.js' }),
        JSON.stringify({ pid: 'abc', ppid: 1, command: 'node malformed.js' }),
        JSON.stringify({ pid: 901, ppid: -1, command: 'node malformed.js' }),
        JSON.stringify({ pid: 902, ppid: 20, command: '   ' }),
        '{bad json',
      ].join('\n'));
      assert.deepEqual(processes, [
        { pid: 800, ppid: 1, command: 'node C:/tmp/oh-my-codex/dist/mcp/state-server.js' },
      ]);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('falls back to BusyBox-compatible args field when command field is unsupported', () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const processes = listOmxProcesses((file, args) => {
      calls.push({ file, args });
      if (args.join(' ') === 'axww -o pid=,ppid=,command=') {
        throw new Error("ps: bad -o argument 'command'");
      }
      assert.deepEqual(args, ['axww', '-o', 'pid=,ppid=,args=']);
      return [
        '  800     1 node /tmp/oh-my-codex/dist/mcp/memory-server.js',
        '  810    42 node /tmp/oh-my-codex/dist/mcp/trace-server.js --verbose',
      ].join('\n');
    });

    assert.deepEqual(processes, [
      { pid: 800, ppid: 1, command: 'node /tmp/oh-my-codex/dist/mcp/memory-server.js' },
      { pid: 810, ppid: 42, command: 'node /tmp/oh-my-codex/dist/mcp/trace-server.js --verbose' },
    ]);
    assert.deepEqual(calls, [
      { file: 'ps', args: ['axww', '-o', 'pid=,ppid=,command='] },
      { file: 'ps', args: ['axww', '-o', 'pid=,ppid=,args='] },
    ]);
  });

  it('rethrows unrelated ps failures without masking them behind the BusyBox fallback', () => {
    assert.throws(
      () => listOmxProcesses(() => {
        throw new Error('spawn ps ENOENT');
      }),
      /spawn ps ENOENT/,
    );
  });

  it('feeds parsed Windows rows through existing cleanup candidate selection unchanged', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const parsed = listOmxProcesses(() => [
        JSON.stringify({ pid: 700, ppid: 500, command: 'codex' }),
        JSON.stringify({ pid: 701, ppid: 700, command: 'node C:/repo/bin/omx.js cleanup --dry-run' }),
        JSON.stringify({ pid: 710, ppid: 700, command: 'node C:/repo/dist/mcp/state-server.js' }),
        JSON.stringify({ pid: 800, ppid: 1, command: 'node C:/tmp/oh-my-codex/dist/mcp/memory-server.js' }),
        JSON.stringify({ pid: 810, ppid: 42, command: 'node C:/tmp/worktree/dist/mcp/trace-server.js' }),
        JSON.stringify({ pid: 900, ppid: 1, command: 'node C:/tmp/not-omx/other-server.js' }),
      ].join('\n'));

      assert.deepEqual(findCleanupCandidates(parsed, 701), [
        {
          pid: 800,
          ppid: 1,
          command: 'node C:/tmp/oh-my-codex/dist/mcp/memory-server.js',
          reason: 'ppid=1',
        },
        {
          pid: 810,
          ppid: 42,
          command: 'node C:/tmp/worktree/dist/mcp/trace-server.js',
          reason: 'outside-current-session',
        },
      ]);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});

describe('cleanupOmxMcpProcesses', () => {
  it('supports dry-run without sending signals', async () => {
    const lines: string[] = [];
    let signalCount = 0;

    const result = await cleanupOmxMcpProcesses(['--dry-run'], {
      currentPid: 701,
      listProcesses: () => CURRENT_SESSION_PROCESSES,
      sendSignal: () => {
        signalCount += 1;
      },
      writeLine: (line) => lines.push(line),
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.candidates.length, 4);
    assert.equal(signalCount, 0);
    assert.match(lines.join('\n'), /Dry run: would terminate 4 orphaned OMX MCP server process/);
    assert.match(lines.join('\n'), /PID 800/);
    assert.match(lines.join('\n'), /PID 810/);
  });

  it('sends SIGTERM, waits, and escalates with SIGKILL when needed', async () => {
    const lines: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([800, 810]);
    let fakeNow = 0;

    const result = await cleanupOmxMcpProcesses([], {
      currentPid: 701,
      listProcesses: () => [
        ...CURRENT_SESSION_PROCESSES.filter((processEntry) => processEntry.pid !== 821 && processEntry.pid !== 831),
      ],
      isPidAlive: (pid) => alive.has(pid),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === 'SIGTERM' && pid === 800) alive.delete(pid);
        if (signal === 'SIGKILL') alive.delete(pid);
      },
      sleep: async (ms) => {
        fakeNow += ms;
      },
      now: () => fakeNow,
      writeLine: (line) => lines.push(line),
    });

    assert.equal(result.terminatedCount, 2);
    assert.equal(result.forceKilledCount, 1);
    assert.deepEqual(result.failedPids, []);
    assert.deepEqual(signals, [
      { pid: 800, signal: 'SIGTERM' },
      { pid: 810, signal: 'SIGTERM' },
      { pid: 810, signal: 'SIGKILL' },
    ]);
    assert.match(lines.join('\n'), /Escalating to SIGKILL for 1 process/);
    assert.match(lines.join('\n'), /Killed 2 orphaned OMX MCP server process\(es\) \(1 required SIGKILL\)\./);
  });

  it('supports launch-safe candidate selection for automatic cleanup', async () => {
    const lines: string[] = [];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await cleanupOmxMcpProcesses([], {
      currentPid: 701,
      listProcesses: () => CURRENT_SESSION_PROCESSES,
      selectCandidates: findLaunchSafeCleanupCandidates,
      isPidAlive: () => false,
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
      },
      writeLine: (line) => lines.push(line),
    });

    assert.equal(result.terminatedCount, 2);
    assert.deepEqual(result.candidates, [
      {
        pid: 800,
        ppid: 1,
        command: 'node /tmp/oh-my-codex/dist/mcp/memory-server.js',
        reason: 'ppid=1',
      },
      {
        pid: 810,
        ppid: 42,
        command: 'node /tmp/worktree/dist/mcp/trace-server.js',
        reason: 'outside-current-session',
      },
    ]);
    assert.deepEqual(signals, [
      { pid: 800, signal: 'SIGTERM' },
      { pid: 810, signal: 'SIGTERM' },
    ]);
    assert.match(lines.join('\n'), /Found 2 orphaned OMX MCP server process/);
    assert.doesNotMatch(lines.join('\n'), /PID 821/);
    assert.doesNotMatch(lines.join('\n'), /PID 831/);
  });
});

describe('cleanupStaleTmpDirectories', () => {
  const tmpEntries = [
    { name: 'omx-stale-a', isDirectory: () => true },
    { name: 'omc-stale-b', isDirectory: () => true },
    { name: 'oh-my-codex-fresh', isDirectory: () => true },
    { name: 'oh-my-codex-file', isDirectory: () => false },
    { name: 'other-stale', isDirectory: () => true },
  ];

  it('supports dry-run and reports stale matching directories older than one hour', async () => {
    const lines: string[] = [];
    const removedPaths: string[] = [];
    const now = 10 * 60 * 60 * 1000;

    const removedCount = await cleanupStaleTmpDirectories(['--dry-run'], {
      tmpRoot: '/tmp',
      listTmpEntries: async () => tmpEntries,
      statPath: async (path) => ({
        mtimeMs:
          path === '/tmp/oh-my-codex-fresh'
            ? now - 30 * 60 * 1000
            : now - 2 * 60 * 60 * 1000,
      }),
      removePath: async (path) => {
        removedPaths.push(path);
      },
      now: () => now,
      writeLine: (line) => lines.push(line),
    });

    assert.equal(removedCount, 0);
    assert.deepEqual(removedPaths, []);
    assert.match(
      lines.join('\n'),
      /Dry run: would remove 2 stale OMX \/tmp directories:/,
    );
    assert.match(lines.join('\n'), /\/tmp\/omc-stale-b/);
    assert.match(lines.join('\n'), /\/tmp\/omx-stale-a/);
    assert.doesNotMatch(lines.join('\n'), /oh-my-codex-fresh/);
    assert.doesNotMatch(lines.join('\n'), /other-stale/);
  });

  it('removes only stale matching directories and returns the removed count', async () => {
    const lines: string[] = [];
    const removedPaths: string[] = [];
    const now = 10 * 60 * 60 * 1000;

    const removedCount = await cleanupStaleTmpDirectories([], {
      tmpRoot: '/tmp',
      listTmpEntries: async () => tmpEntries,
      statPath: async (path) => ({
        mtimeMs:
          path === '/tmp/oh-my-codex-fresh'
            ? now - 30 * 60 * 1000
            : now - 2 * 60 * 60 * 1000,
      }),
      removePath: async (path) => {
        removedPaths.push(path);
      },
      now: () => now,
      writeLine: (line) => lines.push(line),
    });

    assert.equal(removedCount, 2);
    assert.deepEqual(removedPaths, ['/tmp/omc-stale-b', '/tmp/omx-stale-a']);
    assert.match(lines.join('\n'), /Removed stale \/tmp directory: \/tmp\/omc-stale-b/);
    assert.match(lines.join('\n'), /Removed stale \/tmp directory: \/tmp\/omx-stale-a/);
    assert.match(lines.join('\n'), /Removed 2 stale OMX \/tmp directories\./);
  });
});

describe('cleanupCommand', () => {
  it('runs tmp cleanup after orphaned MCP cleanup', async () => {
    const calls: string[] = [];

    await cleanupCommand(['--dry-run'], {
      cleanupProcesses: async () => {
        calls.push('processes');
        return {
          dryRun: true,
          candidates: [],
          terminatedCount: 0,
          forceKilledCount: 0,
          failedPids: [],
        };
      },
      cleanupTmpDirectories: async () => {
        calls.push('tmp');
        return 0;
      },
    });

    assert.deepEqual(calls, ['processes', 'tmp']);
  });

  it('skips tmp cleanup when showing help', async () => {
    const calls: string[] = [];

    await cleanupCommand(['--help'], {
      cleanupProcesses: async () => {
        calls.push('processes');
        return {
          dryRun: true,
          candidates: [],
          terminatedCount: 0,
          forceKilledCount: 0,
          failedPids: [],
        };
      },
      cleanupTmpDirectories: async () => {
        calls.push('tmp');
        return 0;
      },
    });

    assert.deepEqual(calls, ['processes']);
  });
});
