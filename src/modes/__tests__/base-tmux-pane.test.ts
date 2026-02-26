import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMode } from '../base.js';

describe('modes/base tmux pane capture', () => {
  it('captures tmux_pane_id in mode state on startMode()', async () => {
    const prev = process.env.TMUX_PANE;
    process.env.TMUX_PANE = '%123';
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-pane-'));
    try {
      await startMode('ralph', 'test', 1, wd);
      const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'ralph-state.json'), 'utf-8'));
      assert.equal(raw.tmux_pane_id, '%123');
      assert.ok(typeof raw.tmux_pane_set_at === 'string' && raw.tmux_pane_set_at.length > 0);
    } finally {
      if (typeof prev === 'string') process.env.TMUX_PANE = prev;
      else delete process.env.TMUX_PANE;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('blocks exclusive mode startup when another exclusive state file is malformed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-malformed-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralph-state.json'), '{ "active": true');

      await assert.rejects(
        () => startMode('autopilot', 'test', 1, wd),
        /state file is malformed or unreadable/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
