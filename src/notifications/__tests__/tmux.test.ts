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
  captureTmuxPaneWithLiveness,
  sanitizeTmuxAlertText,
} from '../tmux.js';

describe('getCurrentTmuxSession', () => {
  const originalTmux = process.env.TMUX;
  const originalPidFallback = process.env.OMX_TMUX_PID_FALLBACK;

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
    if (originalPidFallback !== undefined) {
      process.env.OMX_TMUX_PID_FALLBACK = originalPidFallback;
    } else {
      delete process.env.OMX_TMUX_PID_FALLBACK;
    }
  });

  it('handles missing TMUX env without throwing', () => {
    delete process.env.TMUX;
    const value = getCurrentTmuxSession();
    assert.ok(value === null || typeof value === 'string');
  });

  it('skips ps-based pid fallback on native Windows', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    delete process.env.TMUX;
    process.env.OMX_TMUX_PID_FALLBACK = '1';
    try {
      assert.equal(getCurrentTmuxSession(), null);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});

describe('getCurrentTmuxPaneId', () => {
  const originalTmux = process.env.TMUX;
  const originalPane = process.env.TMUX_PANE;
  const originalPidFallback = process.env.OMX_TMUX_PID_FALLBACK;

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
    if (originalPidFallback !== undefined) {
      process.env.OMX_TMUX_PID_FALLBACK = originalPidFallback;
    } else {
      delete process.env.OMX_TMUX_PID_FALLBACK;
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

  it('skips ps-based pid fallback on native Windows', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    process.env.OMX_TMUX_PID_FALLBACK = '1';
    try {
      assert.equal(getCurrentTmuxPaneId(), null);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
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

describe('getTeamTmuxSessions - session matching', () => {
  const originalPath = process.env.PATH;
  const tmpDirs: string[] = [];

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeFakeTmux(sessions: string[]): void {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-tmux-team-test-'));
    tmpDirs.push(fakeBinDir);
    const tmuxPath = join(fakeBinDir, 'tmux');
    const lines = sessions.length > 0
      ? sessions.map(s => `printf '%s\\n' '${s}'`).join('\n')
      : 'true';
    writeFileSync(tmuxPath, `#!/bin/sh\n${lines}\n`);
    chmodSync(tmuxPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
  }

  it('returns canonical session name (omx-team-alpha) for team "alpha"', () => {
    makeFakeTmux(['omx-team-alpha', 'other-session']);
    assert.deepEqual(getTeamTmuxSessions('alpha'), ['omx-team-alpha']);
  });

  it('returns prefixed worker sessions (omx-team-alpha-worker1)', () => {
    makeFakeTmux(['omx-team-alpha-worker1', 'omx-team-alpha-worker2']);
    assert.deepEqual(getTeamTmuxSessions('alpha'), ['omx-team-alpha-worker1', 'omx-team-alpha-worker2']);
  });

  it('does NOT return sessions for a different team', () => {
    makeFakeTmux(['omx-team-beta', 'omx-team-beta-worker1']);
    assert.deepEqual(getTeamTmuxSessions('alpha'), []);
  });

  it('returns empty array when no matching sessions exist', () => {
    makeFakeTmux(['unrelated-session']);
    assert.deepEqual(getTeamTmuxSessions('alpha'), []);
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
    const livePid = process.pid;
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-tmux-test-'));
    tmpDirs.push(fakeBinDir);
    const tmuxPath = join(fakeBinDir, 'tmux');
    writeFileSync(
      tmuxPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "list-panes" ]; then',
        `  printf "0 ${livePid}\\n"`,
        '  exit 0',
        'fi',
        'if [ "$1" != "capture-pane" ]; then exit 2; fi',
        'target=""',
        'lines=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-t" ]; then target="$2"; shift 2; continue; fi',
        '  if [ "$1" = "-S" ]; then lines="$2"; shift 2; continue; fi',
        '  shift',
        'done',
        'printf "capture:%s:%s\\n" "$target" "$lines"',
      ].join('\n'),
    );
    chmodSync(tmuxPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

    assert.equal(captureTmuxPane('%42', 7.8), 'capture:%42:-7');
    assert.equal(captureTmuxPane('%42', Number.NaN), 'capture:%42:-12');
    assert.equal(captureTmuxPane('%42', 0), 'capture:%42:-1');
    assert.equal(captureTmuxPane('%42', 999999), 'capture:%42:-2000');
  });

  it('suppresses capture when the target pane is already dead', () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'omx-tmux-dead-pane-test-'));
    tmpDirs.push(fakeBinDir);
    const tmuxPath = join(fakeBinDir, 'tmux');
    writeFileSync(
      tmuxPath,
      [
        '#!/bin/sh',
        'if [ "$1" = "list-panes" ]; then',
        '  printf "1 99999\\n"',
        '  exit 0',
        'fi',
        'if [ "$1" = "capture-pane" ]; then',
        '  printf "stale pane output that should never be used\\n"',
        '  exit 0',
        'fi',
        'exit 2',
      ].join('\n'),
    );
    chmodSync(tmuxPath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;

    const result = captureTmuxPaneWithLiveness('%42', 12);
    assert.equal(result.live, false);
    assert.equal(result.content, null);
    assert.equal(captureTmuxPane('%42', 12), null);
  });
});

describe('sanitizeTmuxAlertText', () => {
  it('drops metadata-only lines wrapped in ANSI CSI sequences', () => {
    const raw = [
      '\x1b[?25lturns:4\x1b[?25h',
      '\x1b[38:2::255:0:0mturns:4\x1b[0m',
      '\x1b[2 qturns:4',
      '\x1b[200~turns:4\x1b[201~',
      'stderr: Error: test suite failed',
    ].join('\n');

    assert.equal(sanitizeTmuxAlertText(raw), 'stderr: Error: test suite failed');
  });

  it('drops metadata-only branch and HUD summary lines', () => {
    const raw = [
      'fix/issue-1525-post-stop-keyword-replay',
      'fix/issue-1525-post-stop-keyword-replay | ralph:2/50 | turns:4 | session:1m | last:5s ago',
      '[OMX#3] ultrawork active',
    ].join('\n');

    assert.equal(sanitizeTmuxAlertText(raw), undefined);
  });

  it('preserves real failure lines even when they resemble alert keywords', () => {
    const raw = [
      'fix/issue-1525-post-stop-keyword-replay | ralph:2/50 | turns:4 | session:1m | last:5s ago',
      'stderr: Error: test suite failed',
    ].join('\n');

    assert.equal(sanitizeTmuxAlertText(raw), 'stderr: Error: test suite failed');
  });

  it('preserves ordinary runtime lines with separators', () => {
    const raw = 'vitest summary | 12 passed | 1 failed';
    assert.equal(sanitizeTmuxAlertText(raw), raw);
  });

  it('drops metadata-only branch lines even when the branch name contains failure-like words', () => {
    const raw = 'feature/error-repro | ralph:2/50 | turns:4 | session:1m | last:5s ago';
    assert.equal(sanitizeTmuxAlertText(raw), undefined);
  });

  it('preserves a branch line when it carries a real failure marker', () => {
    const raw = 'feature/error-repro | stderr: TypeError: cannot read properties of undefined';
    assert.equal(sanitizeTmuxAlertText(raw), raw);
  });
});
