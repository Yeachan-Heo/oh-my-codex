import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

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

describe('trace-server large log processing', () => {
  it('readTurnTimeline keeps only last N entries while reporting total availability', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { readTurnTimeline } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-timeline-'));
    try {
      const logsDir = join(wd, '.omx', 'logs');
      await mkdir(logsDir, { recursive: true });

      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(JSON.stringify({
          timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
          type: i % 2 === 0 ? 'user' : 'assistant',
          turn_id: `turn-${i}`,
        }));
      }
      await writeFile(join(logsDir, 'turns-2026-01-01.jsonl'), `${lines.join('\n')}\n`);

      const timeline = await readTurnTimeline(logsDir, 25);
      assert.equal(timeline.totalAvailable, 2000);
      assert.equal(timeline.entries.length, 25);
      assert.match(timeline.entries[0].turn_id ?? '', /^turn-\d+$/);
      assert.match(timeline.entries[24].turn_id ?? '', /^turn-\d+$/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('summarizeTurns aggregates counts incrementally without materializing full logs', async () => {
    process.env.OMX_TRACE_SERVER_DISABLE_AUTO_START = '1';
    const { summarizeTurns } = await import('../trace-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-trace-summary-'));
    try {
      const logsDir = join(wd, '.omx', 'logs');
      await mkdir(logsDir, { recursive: true });

      const dayOne = [
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'user' },
        { timestamp: '2026-01-01T00:00:01.000Z', type: 'assistant' },
        { timestamp: '2026-01-01T00:00:02.000Z', type: 'assistant' },
      ];
      const dayTwo = [
        { timestamp: '2026-01-02T00:00:00.000Z', type: 'user' },
        { timestamp: '2026-01-02T00:00:01.000Z', type: 'tool' },
        { timestamp: '2026-01-02T00:00:02.000Z', type: 'assistant' },
      ];
      await writeFile(join(logsDir, 'turns-2026-01-01.jsonl'), `${dayOne.map((v) => JSON.stringify(v)).join('\n')}\n`);
      await writeFile(join(logsDir, 'turns-2026-01-02.jsonl'), `${dayTwo.map((v) => JSON.stringify(v)).join('\n')}\n`);

      const summary = await summarizeTurns(logsDir);
      assert.equal(summary.total, 6);
      assert.deepEqual(summary.byType, { user: 2, assistant: 3, tool: 1 });
      assert.equal(summary.firstAt, '2026-01-01T00:00:00.000Z');
      assert.equal(summary.lastAt, '2026-01-02T00:00:02.000Z');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
