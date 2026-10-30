import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');

describe('tmux-hook status is read-only', () => {
  for (const configured of [false, true]) {
    it(configured ? 'preserves an existing configuration' : 'does not initialize a missing configuration', () => {
      const root = mkdtempSync(join(tmpdir(), 'omx-hook-status-'));
      const file = join(root, '.omx', 'tmux-hook.json');
      const payload = JSON.stringify({
        enabled: false, target: { type: 'pane', value: '%999' }, allowed_modes: ['team'],
        cooldown_ms: 15000, max_injections_per_session: 200, prompt_template: 'x',
        marker: 'x', dry_run: true, log_level: 'info', skip_if_scrolling: true,
      });
      try {
        if (configured) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, payload);
        }
        const env: NodeJS.ProcessEnv = { ...process.env, OMX_ROOT: root, OMX_AUTO_UPDATE: '0' };
        for (const name of ['TMUX', 'TMUX_PANE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name];
        const result = spawnSync(process.execPath, [bin, 'tmux-hook', 'status'], {
          cwd: root, env, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(result.status, 0, result.stderr || String(result.error));
        assert.equal(existsSync(file), configured);
        if (configured) {
          assert.equal(readFileSync(file, 'utf8'), payload);
          assert.match(result.stdout, /Enabled: no/);
        } else {
          assert.match(result.stdout, /Config: missing/);
          assert.equal(existsSync(join(root, '.omx')), false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('rejects an invalid existing empty target without rewriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'omx-hook-placeholder-'));
    const file = join(root, '.omx', 'tmux-hook.json');
    try {
      mkdirSync(dirname(file), { recursive: true });
      const payload = JSON.stringify({
        enabled: false, target: { type: 'pane', value: '' }, allowed_modes: ['team'],
        cooldown_ms: 15000, max_injections_per_session: 200, prompt_template: 'x',
        marker: 'x', dry_run: true, log_level: 'info', skip_if_scrolling: true,
      });
      writeFileSync(file, payload);
      const env: NodeJS.ProcessEnv = { ...process.env, OMX_ROOT: root, OMX_AUTO_UPDATE: '0' };
      for (const name of ['TMUX', 'TMUX_PANE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name];
      const result = spawnSync(process.execPath, [bin, 'tmux-hook', 'status'], {
        cwd: root, env, encoding: 'utf8', timeout: 15000,
      });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /target\.value.*non-empty string/);
      assert.equal(readFileSync(file, 'utf8'), payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads an existing state snapshot without changing configuration or state', () => {
    const root = mkdtempSync(join(tmpdir(), 'omx-hook-state-'));
    const file = join(root, '.omx', 'tmux-hook.json');
    const stateFile = join(root, '.omx', 'state', 'tmux-hook-state.json');
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      const config = JSON.stringify({
        enabled: false, target: { type: 'pane', value: '%999' }, allowed_modes: ['team'],
        cooldown_ms: 15000, max_injections_per_session: 200, prompt_template: 'x',
        marker: 'x', dry_run: true, log_level: 'info', skip_if_scrolling: true,
      });
      const state = JSON.stringify({ total_injections: 7, last_reason: 'test', pane_counts: { '%999': 7 } });
      writeFileSync(file, config);
      writeFileSync(stateFile, state);
      const env: NodeJS.ProcessEnv = { ...process.env, OMX_ROOT: root, OMX_AUTO_UPDATE: '0' };
      for (const name of ['TMUX', 'TMUX_PANE', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name];
      const result = spawnSync(process.execPath, [bin, 'tmux-hook', 'status'], {
        cwd: root, env, encoding: 'utf8', timeout: 15000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /Total Injections: 7/);
      assert.match(result.stdout, /Tracked Panes: 1/);
      assert.equal(readFileSync(file, 'utf8'), config);
      assert.equal(readFileSync(stateFile, 'utf8'), state);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
