import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModeState, startMode } from '../base.js';

describe('modes/base multi-state compatibility', () => {
  it('allows the approved team + ralph overlap across root and session scopes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-team-ralph-'));
    try {
      await startMode('team', 'coordinate execution', 5, wd);
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({ session_id: 'sess-team-ralph', cwd: wd, state_root: join(wd, '.omx', 'state') }),
      );

      await startMode('ralph', 'complete the approved plan', 5, wd);

      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), true);
      assert.equal(
        existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-team-ralph', 'ralph-state.json')),
        true,
      );
      assert.equal((await readModeState('team', wd))?.active, true);
      assert.equal((await readModeState('ralph', wd))?.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone autopilot + team overlaps with actionable clearing guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-team-'));
    try {
      await startMode('autopilot', 'run solo automation', 5, wd);

      await assert.rejects(
        () => startMode('team', 'attempt invalid overlap', 5, wd),
        /omx state.*omx_state\.\*/i,
      );

      const autopilotState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8'),
      ) as { active?: boolean };
      assert.equal(autopilotState.active, true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
