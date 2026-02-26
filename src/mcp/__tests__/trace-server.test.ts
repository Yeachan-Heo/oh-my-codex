import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFile } from 'node:fs/promises';

describe('trace-server session-scoped mode discovery', () => {
  it('includes mode events from session-scoped state files', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { readModeEvents } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess1' }));

      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2020-01-01T00:00:00.000Z',
        completed_at: '2020-01-01T00:00:01.000Z',
      }));

      const events = await readModeEvents(wd);
      assert.ok(events.some((e: { event: string; mode: string }) => e.event === 'mode_start' && e.mode === 'ralph'));
      assert.ok(events.some((e: { event: string; mode: string }) => e.event === 'mode_end' && e.mode === 'ralph'));
      assert.ok(events.every((e: { details?: { scope?: string } }) => e.details?.scope === 'session'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not include unrelated session mode events when a current session is active', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { readModeEvents } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionA = join(stateDir, 'sessions', 'sessA');
      const sessionB = join(stateDir, 'sessions', 'sessB');
      await mkdir(sessionA, { recursive: true });
      await mkdir(sessionB, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sessA' }));

      await writeFile(join(sessionA, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2020-01-01T00:00:00.000Z',
      }));
      await writeFile(join(sessionB, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2020-01-02T00:00:00.000Z',
      }));

      const events = await readModeEvents(wd);
      assert.ok(events.some((e: { timestamp: string }) => e.timestamp === '2020-01-01T00:00:00.000Z'));
      assert.equal(events.some((e: { timestamp: string }) => e.timestamp === '2020-01-02T00:00:00.000Z'), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('trace-server log readers', () => {
  it('returns only the most recent entries when last is provided', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { readLogFiles } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-test-'));
    try {
      const logsDir = join(wd, '.omx', 'logs');
      await mkdir(logsDir, { recursive: true });

      const entries = Array.from({ length: 5000 }, (_, i) => ({
        timestamp: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
        type: i % 2 === 0 ? 'assistant' : 'user',
      }));

      const firstHalf = `${entries.slice(0, 2500).map(e => JSON.stringify(e)).join('\n')}\n`;
      const secondHalf = `${entries.slice(2500).map(e => JSON.stringify(e)).join('\n')}\n`;

      await writeFile(join(logsDir, 'turns-2020-01-01.jsonl'), firstHalf);
      await writeFile(join(logsDir, 'turns-2020-01-02.jsonl'), secondHalf);

      const result = await readLogFiles(logsDir, 75);
      assert.equal(result.length, 75);
      assert.deepEqual(
        result.map((e: { timestamp: string }) => e.timestamp),
        entries.slice(-75).map(e => e.timestamp),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('summarizes log history incrementally without materializing turn entries', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { summarizeLogFiles } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-test-'));
    try {
      const logsDir = join(wd, '.omx', 'logs');
      await mkdir(logsDir, { recursive: true });

      await writeFile(join(logsDir, 'turns-2020-01-01.jsonl'), [
        JSON.stringify({ timestamp: '2020-01-02T00:00:00.000Z', type: 'assistant' }),
        'not-json',
        JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', type: 'user' }),
      ].join('\n'));

      await writeFile(join(logsDir, 'turns-2020-01-02.jsonl'), [
        JSON.stringify({ timestamp: '2020-01-03T00:00:00.000Z', type: 'assistant' }),
        JSON.stringify({ timestamp: '2020-01-02T12:00:00.000Z', type: 'assistant' }),
      ].join('\n'));

      const summary = await summarizeLogFiles(logsDir);
      assert.equal(summary.totalTurns, 4);
      assert.deepEqual(summary.turnsByType, { assistant: 3, user: 1 });
      assert.equal(summary.firstTimestamp, '2020-01-01T00:00:00.000Z');
      assert.equal(summary.lastTimestamp, '2020-01-03T00:00:00.000Z');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('trace-server workingDirectory handling', () => {
  it('normalizes workingDirectory via state-paths resolver', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/trace-server.ts'), 'utf8');
    assert.match(src, /resolveWorkingDirectoryForState/);
  });
});
