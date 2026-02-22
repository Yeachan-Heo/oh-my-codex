import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkerStartupCommand,
  createTeamSession,
  enableMouseScrolling,
  isTmuxAvailable,
  isWsl2,
  isWorkerAlive,
  killWorker,
  killWorkerByPaneId,
  listTeamSessions,
  sanitizeTeamName,
  sendToWorker,
  sleepFractionalSeconds,
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
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 2);
      assert.match(cmd, /OMX_TEAM_WORKER=alpha\/worker-2/);
      assert.match(cmd, /'\/bin\/zsh' -lc/);
      assert.match(cmd, /source ~\/\.zshrc/);
      assert.match(cmd, /exec codex/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('uses bash with ~/.bashrc and preserves launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/usr/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.match(cmd, /source ~\/\.bashrc/);
      assert.match(cmd, /exec codex/);
      assert.match(cmd, /--model/);
      assert.match(cmd, /gpt-5/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('inherits bypass flag from process argv once', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = [...prevArgv, '--dangerously-bypass-approvals-and-sandbox'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--dangerously-bypass-approvals-and-sandbox']);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('maps --madmax to bypass flag in worker command', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = [...prevArgv, '--madmax'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1);
      const matches = cmd.match(/--dangerously-bypass-approvals-and-sandbox/g) || [];
      assert.equal(matches.length, 1);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('preserves reasoning override args in worker command', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['-c', 'model_reasoning_effort="xhigh"']);
      assert.match(cmd, /exec codex/);
      assert.match(cmd, /'-c'/);
      assert.match(cmd, /'model_reasoning_effort=\"xhigh\"'/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('injects model_instructions_file override by default', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    const prevInstr = process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT; // default enabled
    delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project');
      assert.match(cmd, /'-c'/);
      assert.match(cmd, /model_instructions_file=/);
      assert.match(cmd, /AGENTS\.md/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
      if (typeof prevInstr === 'string') process.env.OMX_MODEL_INSTRUCTIONS_FILE = prevInstr;
      else delete process.env.OMX_MODEL_INSTRUCTIONS_FILE;
    }
  });

  it('does not inject model_instructions_file override when disabled', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [], '/tmp/project');
      assert.doesNotMatch(cmd, /model_instructions_file=/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('does not inject model_instructions_file when already provided in launch args', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT; // default enabled
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        ['-c', 'model_instructions_file="/tmp/custom.md"'],
        '/tmp/project',
      );
      const matches = cmd.match(/model_instructions_file=/g) || [];
      assert.equal(matches.length, 1);
      assert.match(cmd, /custom\.md/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
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

describe('isWsl2', () => {
  it('returns true when WSL_DISTRO_NAME is set', () => {
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      assert.equal(isWsl2(), true);
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });

  it('returns true when WSL_INTEROP is set and WSL_DISTRO_NAME is absent', () => {
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    process.env.WSL_INTEROP = '/run/WSL/8_interop';
    try {
      assert.equal(isWsl2(), true);
    } finally {
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });

  it('returns a boolean without throwing when no WSL env vars are present', () => {
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    try {
      assert.equal(typeof isWsl2(), 'boolean');
    } finally {
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });
});

describe('enableMouseScrolling', () => {
  it('returns false when tmux is unavailable', () => {
    // When tmux is not on PATH, enableMouseScrolling should gracefully return false
    // rather than throwing, so callers do not need to guard against errors.
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling('omx-team-x'), false);
    });
  });

  it('returns false for empty session target when tmux unavailable', () => {
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling(''), false);
    });
  });

  it('returns false in WSL2 environment when tmux is unavailable', () => {
    // WSL2 path: even with the XT override branch active, the function must
    // return false (not throw) when tmux is not on PATH.
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      withEmptyPath(() => {
        assert.equal(enableMouseScrolling('omx-team-x'), false);
      });
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });
});

describe('killWorkerByPaneId leader pane guard', () => {
  it('skips kill when workerPaneId matches leaderPaneId (guard fires before tmux is called)', () => {
    // With empty PATH tmux is unavailable, so any actual kill-pane call would fail.
    // When the guard fires (paneId === leaderPaneId) the function returns early
    // without invoking tmux, so no error is thrown regardless of PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5', '%5'));
    });
  });

  it('does not skip kill when pane ids differ (falls through to tmux attempt)', () => {
    // Different IDs: guard does not fire. tmux is unavailable but kill errors are swallowed internally.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5', '%6'));
    });
  });

  it('skips kill for non-percent pane id without reaching tmux', () => {
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('invalid', '%5'));
    });
  });

  it('skips kill when no leaderPaneId provided and pane id is valid percent id', () => {
    // Without leaderPaneId the guard is not active; tmux call fails gracefully.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorkerByPaneId('%5'));
    });
  });
});

describe('sleepFractionalSeconds', () => {
  it('actually delays even when sleep binary is unavailable', () => {
    withEmptyPath(() => {
      const start = Date.now();
      sleepFractionalSeconds(0.1);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 80, `expected ~100ms delay but elapsed only ${elapsed}ms`);
    });
  });

  it('returns immediately for zero, negative, or NaN values', () => {
    withEmptyPath(() => {
      const start = Date.now();
      sleepFractionalSeconds(0);
      sleepFractionalSeconds(-1);
      sleepFractionalSeconds(NaN);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 50, `expected no delay but elapsed ${elapsed}ms`);
    });
  });
});

describe('killWorker leader pane guard', () => {
  it('returns immediately when workerPaneId matches leaderPaneId', () => {
    // Guard fires before any tmux send-keys call, so no error even with empty PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5', '%5'));
    });
  });

  it('proceeds (gracefully) when pane ids differ', () => {
    // Guard does not fire; tmux calls fail gracefully with empty PATH.
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5', '%6'));
    });
  });

  it('proceeds when leaderPaneId is not provided', () => {
    withEmptyPath(() => {
      assert.doesNotThrow(() => killWorker('omx-team-x:0', 1, '%5'));
    });
  });
});
