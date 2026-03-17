import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanupOmxMcpProcesses,
  findCleanupCandidates,
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
    pid: 811,
    ppid: 810,
    command: 'node /tmp/worktree/dist/mcp/team-server.js',
  },
  {
    pid: 900,
    ppid: 1,
    command: 'node /tmp/not-omx/other-server.js',
  },
];

describe('findCleanupCandidates', () => {
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
          pid: 811,
          ppid: 810,
          command: 'node /tmp/worktree/dist/mcp/team-server.js',
          reason: 'outside-current-session',
        },
      ],
    );
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
    assert.equal(result.candidates.length, 3);
    assert.equal(signalCount, 0);
    assert.match(lines.join('\n'), /Dry run: would terminate 3 orphaned OMX MCP server process/);
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
        ...CURRENT_SESSION_PROCESSES.filter((processEntry) => processEntry.pid !== 811),
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
});
