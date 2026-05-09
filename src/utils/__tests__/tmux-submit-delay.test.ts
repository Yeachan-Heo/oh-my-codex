import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  DEFAULT_TMUX_SUBMIT_SETTLE_MS,
  resolveTmuxSubmitSettleMs,
} from '../tmux-submit-delay.js';

describe('resolveTmuxSubmitSettleMs', () => {
  it('uses the compatibility default when no override is provided', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-delay-empty-'));
    try {
      assert.equal(resolveTmuxSubmitSettleMs(codexHome), DEFAULT_TMUX_SUBMIT_SETTLE_MS);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('uses persistent [omx] tmux_submit_settle_ms from config.toml', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-delay-'));
    try {
      await writeFile(join(codexHome, 'config.toml'), '[omx]\ntmux_submit_settle_ms = 275\n');
      assert.equal(resolveTmuxSubmitSettleMs(codexHome), 275);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('ignores invalid config.toml delay values', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-tmux-delay-'));
    try {
      await writeFile(join(codexHome, 'config.toml'), '[omx]\ntmux_submit_settle_ms = -1\n');
      assert.equal(resolveTmuxSubmitSettleMs(codexHome), DEFAULT_TMUX_SUBMIT_SETTLE_MS);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});
