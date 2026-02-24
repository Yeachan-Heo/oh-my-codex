import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTeamWorkerCliBinaryAvailable,
  buildScrollCopyBindings,
  buildWorkerStartupCommand,
  chooseTeamLeaderPaneId,
  createTeamSession,
  enableMouseScrolling,
  isNativeWindows,
  isTmuxAvailable,
  isWsl2,
  isWorkerAlive,
  killWorker,
  killWorkerByPaneId,
  listTeamSessions,
  resolveTeamWorkerCli,
  resolveTeamWorkerCliPlan,
  sanitizeTeamName,
  shouldAttemptAdaptiveRetry,
  sendToWorker,
  sleepFractionalSeconds,
  translateWorkerLaunchArgsForCli,
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

describe('chooseTeamLeaderPaneId', () => {
  it('keeps preferred pane when it is not HUD', () => {
    const panes = [
      { paneId: '%1', currentCommand: 'node', startCommand: "'codex'" },
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%1'), '%1');
  });

  it('switches away from HUD preferred pane to first non-HUD pane', () => {
    const panes = [
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
      { paneId: '%1', currentCommand: 'node', startCommand: "'codex'" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%2'), '%1');
  });

  it('falls back to preferred pane when all panes are HUD panes', () => {
    const panes = [
      { paneId: '%2', currentCommand: 'node', startCommand: "node omx hud --watch" },
      { paneId: '%3', currentCommand: 'node', startCommand: "node omx hud --watch" },
    ];
    assert.equal(chooseTeamLeaderPaneId(panes, '%2'), '%2');
  });
});

describe('sendToWorker validation', () => {
  it('rejects text over 200 chars', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, 'a'.repeat(200)),
      /< 200/i
    );
  });

  it('rejects empty/whitespace text', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, '   '),
      /non-empty/i
    );
  });

  it('rejects injection marker', () => {
    assert.throws(
      () => sendToWorker('omx-team-x', 1, `hello [OMX_TMUX_INJECT]`),
      /marker/i
    );
  });
});

describe('shouldAttemptAdaptiveRetry', () => {
  it('returns false when adaptive retry is disabled', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, false, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when strategy is not auto', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('queue', true, true, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when pane was not initially busy', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', false, true, '❯ hello', 'hello'),
      false,
    );
  });

  it('returns false when trigger text is missing from latest capture', () => {
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, '❯ ready prompt', 'hello'),
      false,
    );
  });

  it('returns false when latest capture still shows active task markers', () => {
    const activeCapture = '• Doing work (2m 10s • esc to interrupt)\n❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, activeCapture, 'hello'),
      false,
    );
  });

  it('returns true only when auto+busy and latest capture is ready with visible text', () => {
    const readyCapture = '❯ hello';
    assert.equal(
      shouldAttemptAdaptiveRetry('auto', true, true, readyCapture, 'hello'),
      true,
    );
  });
});

describe('buildWorkerStartupCommand', () => {
  it('auto-selects claude worker CLI from claude model', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    delete process.env.OMX_TEAM_WORKER_CLI; // auto
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'claude-3-7-sonnet']);
      assert.match(cmd, /exec claude/);
      assert.match(cmd, /--dangerously-skip-permissions/);
      assert.doesNotMatch(cmd, /--model/);
      assert.doesNotMatch(cmd, /model_instructions_file=/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('respects explicit OMX_TEAM_WORKER_CLI override', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      process.env.OMX_TEAM_WORKER_CLI = 'codex';
      const codexCmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'claude-3-7-sonnet']);
      assert.match(codexCmd, /exec codex/);

      process.env.OMX_TEAM_WORKER_CLI = 'claude';
      const claudeCmd = buildWorkerStartupCommand('alpha', 1, ['--model', 'gpt-5']);
      assert.match(claudeCmd, /exec claude/);
      assert.match(claudeCmd, /--dangerously-skip-permissions/);
      assert.doesNotMatch(claudeCmd, /--model/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('translates codex-only flags for claude workers', () => {
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_TEAM_WORKER_CLI = 'claude';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1, [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c', 'model_instructions_file="/tmp/custom.md"',
        '--model', 'claude-3-7-sonnet',
      ]);
      assert.match(cmd, /exec claude/);
      assert.match(cmd, /--dangerously-skip-permissions/);
      assert.doesNotMatch(cmd, /dangerously-bypass-approvals-and-sandbox/);
      assert.doesNotMatch(cmd, /model_instructions_file=/);
      assert.doesNotMatch(cmd, /--model/);
      assert.doesNotMatch(cmd, /claude-3-7-sonnet/);
    } finally {
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

  it('maps --madmax to claude skip-permissions in claude mode', () => {
    const prevArgv = process.argv;
    const prevShell = process.env.SHELL;
    const prevCli = process.env.OMX_TEAM_WORKER_CLI;
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.SHELL = '/bin/bash';
    process.env.OMX_TEAM_WORKER_CLI = 'claude';
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    process.argv = [...prevArgv, '--madmax'];
    try {
      const cmd = buildWorkerStartupCommand('alpha', 1);
      const matches = cmd.match(/--dangerously-skip-permissions/g) || [];
      assert.equal(matches.length, 1);
      assert.doesNotMatch(cmd, /dangerously-bypass-approvals-and-sandbox/);
    } finally {
      process.argv = prevArgv;
      if (typeof prevShell === 'string') process.env.SHELL = prevShell;
      else delete process.env.SHELL;
      if (typeof prevCli === 'string') process.env.OMX_TEAM_WORKER_CLI = prevCli;
      else delete process.env.OMX_TEAM_WORKER_CLI;
      if (typeof prevBypass === 'string') process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = prevBypass;
      else delete process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    }
  });

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

  it('injects canonical team state env vars when provided', () => {
    const prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    const prevBypass = process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT;
    process.env.OMX_BYPASS_DEFAULT_SYSTEM_PROMPT = '0';
    try {
      const cmd = buildWorkerStartupCommand(
        'alpha',
        1,
        [],
        '/tmp/worker-cwd',
        {
          OMX_TEAM_STATE_ROOT: '/tmp/leader/.omx/state',
          OMX_TEAM_LEADER_CWD: '/tmp/leader',
        },
      );
      assert.match(cmd, /OMX_TEAM_STATE_ROOT=\/tmp\/leader\/\.omx\/state/);
      assert.match(cmd, /OMX_TEAM_LEADER_CWD=\/tmp\/leader/);
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

describe('team worker CLI helpers', () => {
  it('resolveTeamWorkerCli auto-detects claude models', () => {
    assert.equal(resolveTeamWorkerCli(['--model', 'claude-3-7-sonnet'], {}), 'claude');
    assert.equal(resolveTeamWorkerCli(['--model=claude-sonnet-4-6'], {}), 'claude');
    assert.equal(resolveTeamWorkerCli(['--model', 'gpt-5'], {}), 'codex');
    assert.equal(resolveTeamWorkerCli([], {}), 'codex');
  });

  it('translateWorkerLaunchArgsForCli preserves args for codex', () => {
    const args = ['--model', 'gpt-5', '-c', 'model_reasoning_effort="xhigh"'];
    assert.deepEqual(translateWorkerLaunchArgsForCli('codex', args), args);
  });

  it('translateWorkerLaunchArgsForCli maps reasoning override for claude', () => {
    assert.deepEqual(
      translateWorkerLaunchArgsForCli('claude', ['-c', 'model_reasoning_effort="xhigh"', '--model', 'claude-3-7-sonnet']),
      ['--dangerously-skip-permissions'],
    );
  });

  it('assertTeamWorkerCliBinaryAvailable throws clear error when binary missing', () => {
    assert.throws(
      () => assertTeamWorkerCliBinaryAvailable('claude', () => false),
      /not available on PATH/i,
    );
  });

  it('resolveTeamWorkerCliPlan supports mixed per-worker CLI map', () => {
    const plan = resolveTeamWorkerCliPlan(
      4,
      [],
      { OMX_TEAM_WORKER_CLI_MAP: 'codex,codex,claude,claude' },
    );
    assert.deepEqual(plan, ['codex', 'codex', 'claude', 'claude']);
  });

  it('resolveTeamWorkerCliPlan accepts single-value map and expands to all workers', () => {
    const plan = resolveTeamWorkerCliPlan(
      3,
      [],
      { OMX_TEAM_WORKER_CLI_MAP: 'claude' },
    );
    assert.deepEqual(plan, ['claude', 'claude', 'claude']);
  });

  it('resolveTeamWorkerCliPlan supports auto entries in CLI map', () => {
    const plan = resolveTeamWorkerCliPlan(
      2,
      ['--model', 'claude-3-7-sonnet'],
      { OMX_TEAM_WORKER_CLI_MAP: 'auto,codex' },
    );
    assert.deepEqual(plan, ['claude', 'codex']);
  });

  it('resolveTeamWorkerCliPlan auto entries ignore OMX_TEAM_WORKER_CLI override', () => {
    const plan = resolveTeamWorkerCliPlan(
      1,
      ['--model', 'claude-3-7-sonnet'],
      {
        OMX_TEAM_WORKER_CLI: 'codex',
        OMX_TEAM_WORKER_CLI_MAP: 'auto',
      },
    );
    assert.deepEqual(plan, ['claude']);
  });

  it('resolveTeamWorkerCliPlan rejects map lengths that do not match workerCount', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(4, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,claude' }),
      /expected 1 or 4/i,
    );
  });

  it('resolveTeamWorkerCliPlan rejects empty entries in CLI map', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(2, [], { OMX_TEAM_WORKER_CLI_MAP: 'codex,' }),
      /empty entries are not allowed/i,
    );
  });

  it('resolveTeamWorkerCliPlan reports invalid entry errors with OMX_TEAM_WORKER_CLI_MAP', () => {
    assert.throws(
      () => resolveTeamWorkerCliPlan(1, [], { OMX_TEAM_WORKER_CLI_MAP: 'claudee' }),
      /OMX_TEAM_WORKER_CLI_MAP/i,
    );
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

describe('isNativeWindows', () => {
  it('returns true when process.platform is win32 and not WSL2', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevDistro = process.env.WSL_DISTRO_NAME;
    const prevInterop = process.env.WSL_INTEROP;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      assert.equal(isNativeWindows(), true);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
      if (typeof prevInterop === 'string') process.env.WSL_INTEROP = prevInterop;
      else delete process.env.WSL_INTEROP;
    }
  });

  it('returns false when process.platform is win32 but WSL2 is detected', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const prevDistro = process.env.WSL_DISTRO_NAME;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      if (typeof prevDistro === 'string') process.env.WSL_DISTRO_NAME = prevDistro;
      else delete process.env.WSL_DISTRO_NAME;
    }
  });

  it('returns false on Linux', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  it('returns false on macOS', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      assert.equal(isNativeWindows(), false);
    } finally {
      if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
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
  it('uses ceil(ms) so sub-millisecond positive values still sleep', () => {
    const calls: number[] = [];
    const captureSleep = (ms: number): void => {
      calls.push(ms);
    };

    sleepFractionalSeconds(0.1, captureSleep);
    sleepFractionalSeconds(0.0001, captureSleep);

    assert.deepEqual(calls, [100, 1]);
  });

  it('ignores invalid values and clamps extreme sleeps to 60s max', () => {
    const calls: number[] = [];
    const captureSleep = (ms: number): void => {
      calls.push(ms);
    };

    sleepFractionalSeconds(0, captureSleep);
    sleepFractionalSeconds(-1, captureSleep);
    sleepFractionalSeconds(NaN, captureSleep);
    sleepFractionalSeconds(Number.POSITIVE_INFINITY, captureSleep);
    sleepFractionalSeconds(999_999, captureSleep);

    assert.deepEqual(calls, [60_000]);
  });
});

describe('buildScrollCopyBindings (issue #206)', () => {
  it('returns a non-empty array of tmux command arg arrays', () => {
    const bindings = buildScrollCopyBindings();
    assert.ok(Array.isArray(bindings));
    assert.ok(bindings.length > 0);
    for (const b of bindings) {
      assert.ok(Array.isArray(b), 'each binding must be an array');
      assert.ok(b.length > 0, 'each binding must have at least one element');
      assert.equal(typeof b[0], 'string', 'first element must be a string');
    }
  });

  it('includes WheelUpPane binding that enters copy-mode (fixes viewport scroll)', () => {
    const bindings = buildScrollCopyBindings();
    const wheelUp = bindings.find((b) => b.includes('WheelUpPane'));
    assert.ok(wheelUp, 'WheelUpPane binding must be present');
    assert.ok(wheelUp.some((tok) => tok.includes('copy-mode')), 'WheelUpPane binding must activate copy-mode');
    assert.ok(wheelUp.some((tok) => tok.includes('pane_in_mode')), 'WheelUpPane must check pane_in_mode to avoid double-entry');
  });

  it('WheelUpPane binding is in the root key table (-n flag)', () => {
    const bindings = buildScrollCopyBindings();
    const wheelUp = bindings.find((b) => b.includes('WheelUpPane'));
    assert.ok(wheelUp, 'WheelUpPane binding must be present');
    const nIdx = wheelUp.indexOf('-n');
    assert.ok(nIdx !== -1, 'WheelUpPane binding must use -n (root table) flag');
    assert.equal(wheelUp[nIdx + 1], 'WheelUpPane');
  });

  it('includes MouseDragEnd1Pane binding that copies selection to clipboard (fixes copy)', () => {
    const bindings = buildScrollCopyBindings();
    const dragEnd = bindings.find((b) => b.includes('MouseDragEnd1Pane'));
    assert.ok(dragEnd, 'MouseDragEnd1Pane binding must be present');
    assert.ok(dragEnd.includes('copy-selection-and-cancel'), 'drag-end binding must copy the selection');
  });

  it('MouseDragEnd1Pane binding is in copy-mode key table (-T copy-mode)', () => {
    const bindings = buildScrollCopyBindings();
    const dragEnd = bindings.find((b) => b.includes('MouseDragEnd1Pane'));
    assert.ok(dragEnd, 'MouseDragEnd1Pane binding must be present');
    const tIdx = dragEnd.indexOf('-T');
    assert.ok(tIdx !== -1, 'drag-end binding must specify a key table with -T');
    assert.equal(dragEnd[tIdx + 1], 'copy-mode', 'drag-end binding must be in copy-mode table');
  });
});

describe('enableMouseScrolling scroll and copy setup (issue #206)', () => {
  it('returns false gracefully when scroll-copy setup fails because tmux is unavailable', () => {
    // With empty PATH the initial "mouse on" call fails, so the function returns
    // false before any binding calls are made. No throw must occur.
    withEmptyPath(() => {
      assert.equal(enableMouseScrolling('omx-team-x'), false);
    });
  });

  it('does not throw when WSL2 env is set and tmux is unavailable (regression + #206)', () => {
    const prev = process.env.WSL_DISTRO_NAME;
    process.env.WSL_DISTRO_NAME = 'Ubuntu-22.04';
    try {
      withEmptyPath(() => {
        assert.doesNotThrow(() => enableMouseScrolling('omx-team-x'));
      });
    } finally {
      if (typeof prev === 'string') process.env.WSL_DISTRO_NAME = prev;
      else delete process.env.WSL_DISTRO_NAME;
    }
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
