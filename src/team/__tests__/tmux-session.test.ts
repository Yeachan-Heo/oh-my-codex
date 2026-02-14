import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerStartupCommand,
  createTeamSession,
  isTmuxAvailable,
  isWorkerAlive,
  listTeamSessions,
  sanitizeTeamName,
  sendToWorker,
  waitForWorkerReady,
} from '../tmux-session.js';

function withEmptyPath<T>(fn: () => T): T {
  const prev = process.env.PATH;
  process.env.PATH = '';
  try {
    return fn();
  } finally {
    if (typeof prev === 'string') process.env.PATH = prev;
    else delete process.env.PATH;
  }
}

describe('sanitizeTeamName', () => {
  it('lowercases and strips invalid chars', () => {
    assert.equal(sanitizeTeamName('My Team!'), 'my-team');
  });

  it('truncates to 30 chars', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitizeTeamName(long).length, 30);
  });

  it('rejects empty after sanitization', () => {
    assert.throws(() => sanitizeTeamName('!!!'), /empty/i);
  });
});

describe('sendToWorker validation', () => {
  it('rejects text over 200 chars', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, 'a'.repeat(200)),
      /< 200/i
    );
  });

  it('rejects injection marker', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, `hello [OMX_TMUX_INJECT]`),
      /marker/i
    );
  });
});

describe('buildWorkerStartupCommand', () => {
  it('uses zsh with ~/.zshrc and exec codex', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/zsh';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 2);
      assert.match(cmd, /OMX_TEAM_WORKER=alpha\/worker-2/);
      assert.match(cmd, /'\/bin\/zsh' -lc/);
      assert.match(cmd, /source ~\/\.zshrc/);
      assert.match(cmd, /exec codex/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });

  it('uses bash with ~/.bashrc and preserves launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/usr/bin/bash';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.match(cmd, /source ~\/\.bashrc/);
      assert.match(cmd, /exec codex/);
      assert.match(cmd, /--model/);
      assert.match(cmd, /gpt-5/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });

  it('inherits bypass flag from process argv once', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    process.argv = [...prevArgv, '--dangerously-bypass-approvals-and-sandbox'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--dangerously-bypass-approvals-and-sandbox']);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });

  it('maps --madmax to bypass flag in worker command', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    process.argv = [...prevArgv, '--madmax'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
    }
  });
});

describe('tmux-dependent functions when tmux is unavailable', () => {
  it('isTmuxAvailable returns false', () => {
    withEmptyPath(() => {
      assert.equal(isTmuxAvailable(), false);
    });
  });

  it('createTeamSession throws', () => {
    withEmptyPath(() => {
      assert.throws(
        () => createTeamSession('My Team', 1, process.cwd()),
        /tmux is not available/i
      );
    });
  });

  it('listTeamSessions returns empty', () => {
    withEmptyPath(() => {
      assert.deepEqual(listTeamSessions(), []);
    });
  });

  it('waitForWorkerReady returns false on timeout', () => {
    withEmptyPath(() => {
      assert.equal(waitForWorkerReady('omx-team-x', 1, 1), false);
    });
  });
});

describe('isWorkerAlive', () => {
  it('does not require pane_current_command to match "codex"', () => {
    // This was a real failure mode: tmux reports pane_current_command=node for the Codex TUI,
    // which caused workers to be treated as dead and the leader to clean up state too early.
    withEmptyPath(() => {
      assert.equal(isWorkerAlive('omx-team-x', 1), false);
    });
  });
});
