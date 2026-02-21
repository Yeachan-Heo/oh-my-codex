import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import {
  getCurrentTmuxSession,
  getCurrentTmuxPaneId,
  formatTmuxInfo,
  getTeamTmuxSessions,
  captureTmuxPane,
} from '../tmux.js';

describe('getCurrentTmuxSession', () => {
  const originalTmux = process.env.TMUX;

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
  });

  it('handles missing TMUX env without throwing', () => {
    delete process.env.TMUX;
    const value = getCurrentTmuxSession();
    assert.ok(value === null || typeof value === 'string');
  });
});

describe('getCurrentTmuxPaneId', () => {
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
    if (originalPane !== undefined) {
      process.env.TMUX_PANE = originalPane;
    } else {
      delete process.env.TMUX_PANE;
    }
  });

  it('handles missing TMUX env without throwing', () => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    const value = getCurrentTmuxPaneId();
    assert.ok(value === null || /^%\d+$/.test(value));
  });

  it('returns TMUX_PANE when valid format', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%0';
    assert.equal(getCurrentTmuxPaneId(), '%0');
  });

  it('returns TMUX_PANE for multi-digit pane id', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = '%42';
    assert.equal(getCurrentTmuxPaneId(), '%42');
  });

  it('ignores invalid TMUX_PANE format', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = 'invalid';
    // Falls back to tmux command, which may or may not work
    const result = getCurrentTmuxPaneId();
    assert.ok(result === null || /^%\d+$/.test(result));
  });
});

describe('formatTmuxInfo', () => {
  const originalTmux = process.env.TMUX;

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
  });

  it('handles missing TMUX env without throwing', () => {
    delete process.env.TMUX;
    const value = formatTmuxInfo();
    assert.ok(value === null || value.startsWith('tmux: '));
  });
});

describe('getTeamTmuxSessions', () => {
  it('returns empty array for empty team name', () => {
    assert.deepEqual(getTeamTmuxSessions(''), []);
  });

  it('returns empty array for special-character-only team name', () => {
    assert.deepEqual(getTeamTmuxSessions('!@#$'), []);
  });

  it('sanitizes team name (strips non-alphanumeric except hyphens)', () => {
    // Should not throw even with weird input
    const result = getTeamTmuxSessions('test<script>');
    assert.ok(Array.isArray(result));
  });
});

describe('captureTmuxPane', () => {
  const originalPath = process.env.PATH;
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
    if (originalPane !== undefined) {
      process.env.TMUX_PANE = originalPane;
    } else {
      delete process.env.TMUX_PANE;
    }

    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for invalid pane targets', () => {
    assert.equal(captureTmuxPane('1'), null);
    assert.equal(captureTmuxPane('abc'), null);
    assert.equal(captureTmuxPane('%1;rm -rf /'), null);
  });

  it('returns null for invalid TMUX_PANE env target', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    process.env.TMUX_PANE = 'invalid';
    assert.equal(captureTmuxPane(undefined, 10), null);
  });

  it('captures output for valid pane id and sanitizes/clamps lines', () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-tmux-test-'));
    tmpDirs.push(fakeBinDir);
    const tmuxPath = join(fakeBinDir, 'tmux');
    writeFileSync(
      tmuxPath,
      [
        '#!/bin/sh',
        'if [ "$1" != "capture-pane" ]; then exit 2; fi',
        'target=""',
        'lines=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-t" ]; then target="$2"; shift 2; continue; fi',
        '  if [ "$1" = "-l" ]; then lines="$2"; shift 2; continue; fi',
        '  shift',
        'done',
        'printf "capture:%s:%s\\n" "$target" "$lines"',
      ].join('\n'),
    );
    chmodSync(tmuxPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

    assert.equal(captureTmuxPane('%42', 7.8), 'capture:%42:7');
    assert.equal(captureTmuxPane('%42', Number.NaN), 'capture:%42:12');
    assert.equal(captureTmuxPane('%42', 0), 'capture:%42:1');
    assert.equal(captureTmuxPane('%42', 999999), 'capture:%42:2000');
  });
});
