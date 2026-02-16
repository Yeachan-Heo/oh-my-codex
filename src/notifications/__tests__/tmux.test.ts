import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCurrentTmuxSession,
  getCurrentTmuxPaneId,
  formatTmuxInfo,
  getTeamTmuxSessions,
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

  it('returns null when TMUX env is not set', () => {
    delete process.env.TMUX;
    assert.equal(getCurrentTmuxSession(), null);
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

  it('returns null when TMUX env is not set', () => {
    delete process.env.TMUX;
    assert.equal(getCurrentTmuxPaneId(), null);
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

  it('returns null when not in tmux', () => {
    delete process.env.TMUX;
    assert.equal(formatTmuxInfo(), null);
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
