import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  readSubagentTrackingState,
  readSubagentTrackingStateStrict,
  subagentTrackingPath,
  writeSubagentTrackingState,
} from '../../subagents/tracker.js';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
  try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe('#3181 durable tracker upgrade recovery', () => {
  it('filters legacy adapted provenance during tolerant tracker recovery', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        pending_role_intents: [{
          role: 'architect',
          session_id: 'synthetic-session',
          parent_thread_id: 'synthetic-parent',
          correlation_token: 'forgeable-token',
          binding_state: 'bound',
          binding_claimant_token: 'forgeable-claimant',
        }],
        sessions: {
          'synthetic-session': {
            session_id: 'synthetic-session',
            leader_thread_id: 'synthetic-parent',
            updated_at: '2026-01-01T00:00:00.000Z',
            threads: {
              'synthetic-child': {
                thread_id: 'synthetic-child',
                kind: 'subagent',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_seen_at: '2026-01-01T00:01:00.000Z',
                turn_count: 2,
                mode: 'architect',
                role: 'architect',
                provenance_kind: 'adapted',
              },
            },
          },
        },
      })}\n`);

      const state = await readSubagentTrackingState(cwd);
      assert.deepEqual(state, {
        schemaVersion: 1,
        sessions: {
          'synthetic-session': {
            session_id: 'synthetic-session',
            leader_thread_id: 'synthetic-parent',
            updated_at: '2026-01-01T00:00:00.000Z',
            threads: {
              'synthetic-child': {
                thread_id: 'synthetic-child',
                kind: 'subagent',
                first_seen_at: '2026-01-01T00:00:00.000Z',
                last_seen_at: '2026-01-01T00:01:00.000Z',
                turn_count: 2,
                mode: 'architect',
                role: 'architect',
              },
            },
          },
        },
      });
      assert.equal((JSON.parse(await readFile(path, 'utf8')) as { sessions: Record<string, { threads: Record<string, { provenance_kind?: string }> }> }).sessions['synthetic-session'].threads['synthetic-child'].provenance_kind, 'adapted');
      await writeSubagentTrackingState(cwd, state);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).sessions['synthetic-session'].threads['synthetic-child'].provenance_kind, undefined);
    });
  });

  it('strictly rejects corrupt durable tracker bytes without mutation', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      const corrupt = '{ synthetic corrupt tracker';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, corrupt);
      assert.deepEqual(await readSubagentTrackingStateStrict(cwd), { ok: false });
      assert.equal(await readFile(path, 'utf8'), corrupt);
    });
  });
});
