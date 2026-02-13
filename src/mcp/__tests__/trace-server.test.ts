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
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      await mkdir(sessionDir, { recursive: true });

      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'execution',
        started_at: '2020-01-01T00:00:00.000Z',
        completed_at: '2020-01-01T00:00:01.000Z',
      }));

      const events = await readModeEvents(wd);
      assert.ok(events.some((e: { event: string; mode: string }) => e.event === 'mode_start' && e.mode === 'ralph'));
      assert.ok(events.some((e: { event: string; mode: string }) => e.event === 'mode_end' && e.mode === 'ralph'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

