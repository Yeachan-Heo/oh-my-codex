import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildRunState, syncRunStateFromModeState } from '../run-state.js';

describe('run state sync', () => {
  it('preserves canonical askuserQuestion lifecycle while keeping legacy blocked_on_user outcome', () => {
    const state = buildRunState(
      {
        mode: 'deep-interview',
        active: false,
        run_outcome: 'blocked_on_user',
        lifecycle_outcome: 'askuserQuestion',
      },
      null,
      '2026-04-19T00:00:00.000Z',
    );

    assert.equal(state.outcome, 'blocked_on_user');
    assert.equal(state.lifecycle_outcome, 'askuserQuestion');
  });

  it('writes canonical askuserQuestion lifecycle to run-state.json during sync', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-run-state-'));
    try {
      const synced = await syncRunStateFromModeState(
        {
          mode: 'deep-interview',
          active: false,
          run_outcome: 'blocked_on_user',
          lifecycle_outcome: 'askuserQuestion',
        },
        wd,
      );

      const persisted = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'run-state.json'), 'utf-8'),
      ) as typeof synced;

      assert.equal(synced.outcome, 'blocked_on_user');
      assert.equal(synced.lifecycle_outcome, 'askuserQuestion');
      assert.equal(persisted.lifecycle_outcome, 'askuserQuestion');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
