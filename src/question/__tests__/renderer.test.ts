import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  computeAdaptiveQuestionPaneHeight,
  formatQuestionAnswerForInjection,
  formatQuestionAnswersForInjection,
  injectQuestionAnswerToPane,
  injectQuestionAnswersToPane,
  launchQuestionRenderer,
  resolveQuestionRendererStrategy,
} from '../renderer.js';
import { buildSendPaneArgvs } from '../../notifications/tmux-detector.js';

describe('resolveQuestionRendererStrategy', () => {
  it('prefers inside-tmux when TMUX is present', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('fails closed when tmux exists but TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'unsupported',
    );
  });

  it('uses inline-tty on Windows when no tmux bridge exists but the current terminal is interactive', () => {
    assert.equal(
      resolveQuestionRendererStrategy(
        {} as NodeJS.ProcessEnv,
        '/usr/bin/tmux',
        { platform: 'win32', stdinIsTTY: true, stdoutIsTTY: true },
      ),
      'inline-tty',
    );
  });

  it('supports explicit host-pane bridge hints when TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_RETURN_PANE: '%77' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_LEADER_PANE_ID: '%88' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('uses a detached Windows console for native psmux return bridges', () => {
    assert.equal(
      resolveQuestionRendererStrategy(
        { TMUX: 'psmux-session', TMUX_PANE: '%44' } as NodeJS.ProcessEnv,
        'C:/Program Files/psmux/psmux.exe',
        { platform: 'win32' },
      ),
      'windows-console',
    );
    assert.equal(
      resolveQuestionRendererStrategy(
        { OMX_QUESTION_RETURN_PANE: '%45' } as NodeJS.ProcessEnv,
        'C:/Program Files/psmux/psmux.exe',
        { platform: 'win32' },
      ),
      'windows-console',
    );
  });

  it('supports persisted workflow pane bridges when TMUX is absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-strategy-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        tmux_pane_id: '%91',
      }, null, 2));

      assert.equal(
        resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux', { cwd, sessionId: 'sess-stateful' }),
        'inside-tmux',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects malformed explicit host-pane bridge hints', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_RETURN_PANE: 'not-a-pane' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'unsupported',
    );
  });

  it('uses noop test renderer override when requested', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_TEST_RENDERER: 'noop' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'test-noop',
    );
  });

  it('fails closed when neither attached tmux nor tmux binary exists', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, undefined),
      'unsupported',
    );
  });
});


describe('adaptive question pane sizing', () => {
  it('computes large adaptive heights with caps and fallback-sized terminals', () => {
    assert.equal(computeAdaptiveQuestionPaneHeight(50, 10), 30);
    assert.equal(computeAdaptiveQuestionPaneHeight(50, 42), 42);
    assert.equal(computeAdaptiveQuestionPaneHeight(20, 50), 18);
    assert.equal(computeAdaptiveQuestionPaneHeight(Number.NaN, 10), 24);
    assert.equal(computeAdaptiveQuestionPaneHeight(9, 20), 7);
  });
});

describe('launchQuestionRenderer', () => {
  it('fails before building UI argv or invoking tmux when no visible renderer is available', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '';
    try {
      assert.throws(
        () => launchQuestionRenderer(
          {
            cwd: '/repo',
            recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
            env: {} as NodeJS.ProcessEnv,
          },
          {
            strategy: 'unsupported',
            execTmux: (args) => {
              calls.push(args);
              return '';
            },
            sleepSync: () => {},
          },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /visible renderer/i);
          assert.match(error.message, /attached tmux pane/i);
          assert.match(error.message, /Run omx question from inside tmux/i);
          assert.doesNotMatch(error.message, /tmux is unavailable/i);
          return true;
        },
      );
    } finally {
      process.argv[1] = originalArgv1;
    }

    assert.deepEqual(calls, []);
  });

  it('opens an interactive foreground split when already inside an attached tmux session', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%42\n';
          if (args[0] === 'list-panes') return '0\t%42\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%42');
    assert.equal(result.return_target, '%11');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.ok(!splitCall.includes('-d'));
    assert.ok(splitCall.includes('-t'));
    assert.ok(splitCall.includes('%11'));
    assert.notEqual(splitCall[3], '12');
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.ok(splitCall.includes('-e'));
    assert.ok(splitCall.includes('OMX_SESSION_ID=s1'));
    assert.ok(splitCall.includes('OMX_QUESTION_RETURN_TARGET=%11'));
    assert.ok(splitCall.includes('OMX_QUESTION_RETURN_TRANSPORT=tmux-send-keys'));
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %42 -F #{pane_dead}\t#{pane_id}'));
  });

  it('targets the explicit leader pane even when the caller is already inside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-leader.json',
        sessionId: 's1',
        env: {
          TMUX: '/tmp/tmux-demo',
          TMUX_PANE: '%22',
          OMX_QUESTION_RETURN_PANE: '%44',
        } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
          if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%45\n';
          if (args[0] === 'list-panes') return '0\t%45\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.target, '%45');
    assert.equal(result.return_target, '%44');
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.deepEqual(splitCall.slice(0, 6), ['split-window', '-v', '-l', '24', '-t', '%44']);
  });

  it('fails closed before splitting when inside a detached tmux session', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-detached.json',
          sessionId: 's1',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '0\n';
            if (args[0] === 'split-window') return '%99\n';
            return '';
          },
          sleepSync: () => {},
        },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /visible renderer/i);
        assert.match(error.message, /no attached client/i);
        assert.match(error.message, /attached tmux pane/i);
        return true;
      },
    );

    assert.deepEqual(calls, [['display-message', '-p', '-t', '%11', '#{session_attached}']]);
  });

  it('targets an explicit host pane when launching from a container without TMUX', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-bridge.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { OMX_QUESTION_RETURN_PANE: '%77' } as NodeJS.ProcessEnv,
      },
      {
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'split-window') return '%78\n';
          if (args[0] === 'list-panes') return '0\t%78\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%78');
    assert.equal(result.return_target, '%77');
    assert.equal(result.return_transport, 'tmux-send-keys');
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.ok(!splitCall.includes('-d'));
    assert.deepEqual(splitCall.slice(0, 3), ['split-window', '-v', '-l']);
    assert.equal(splitCall[3], '24');
    assert.ok(splitCall.includes('-t'));
    assert.ok(splitCall.includes('%77'));
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %78 -F #{pane_dead}\t#{pane_id}'));
  });

  it('opens a detached Windows console instead of a psmux split pane when a return bridge is present', () => {
    const tmuxCalls: string[][] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = launchQuestionRenderer(
      {
        cwd: 'C:/repo',
        recordPath: 'C:/repo/.omx/state/sessions/s1/questions/question-bridge.json',
        sessionId: 's1',
        nowIso: '2026-04-24T00:00:00.000Z',
        env: { TMUX: 'psmux-session', TMUX_PANE: '%44' } as NodeJS.ProcessEnv,
        platform: 'win32',
      },
      {
        execTmux: (args) => {
          tmuxCalls.push(args);
          return '';
        },
        spawnDetachedRenderer: (command, args, options) => {
          spawnCalls.push({ command, args, options: options as Record<string, unknown> });
          return { pid: 1234, unref: () => {} };
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'windows-console');
    assert.equal(result.target, 'pid:1234');
    assert.equal(result.pid, 1234);
    assert.equal(result.return_target, '%44');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.deepEqual(tmuxCalls, []);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]?.command, 'cmd.exe');
    assert.deepEqual(spawnCalls[0]?.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(spawnCalls[0]?.args[3] || '', /start "OMX Question" \/wait/);
    assert.match(spawnCalls[0]?.args[3] || '', /"question" "--ui" "--state-path"/);
    assert.match(spawnCalls[0]?.args[3] || '', /question-bridge\.json"/);
    assert.equal(spawnCalls[0]?.options.cwd, 'C:/repo');
    assert.equal(spawnCalls[0]?.options.detached, true);
    assert.equal(spawnCalls[0]?.options.windowsHide, true);
    const env = spawnCalls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(env.OMX_SESSION_ID, 's1');
    assert.equal(env.OMX_QUESTION_RETURN_TARGET, '%44');
    assert.equal(env.OMX_QUESTION_RETURN_TRANSPORT, 'tmux-send-keys');
  });

  it('targets a persisted workflow pane when launching from a container without TMUX', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-persisted-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        tmux_pane_id: '%91',
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(stateDir, 'questions', 'question-bridge.json'),
          sessionId: 'sess-stateful',
          env: {} as NodeJS.ProcessEnv,
        },
        {
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'split-window') return '%92\n';
            if (args[0] === 'list-panes') return '0\t%92\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.renderer, 'tmux-pane');
      assert.equal(result.target, '%92');
      assert.equal(result.return_target, '%91');
      assert.equal(result.return_transport, 'tmux-send-keys');
      const splitCall = calls.find((call) => call[0] === 'split-window');
      assert.ok(splitCall);
      assert.deepEqual(splitCall.slice(0, 3), ['split-window', '-v', '-l']);
      assert.equal(splitCall[3], '24');
      assert.ok(splitCall.includes('%91'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails before prompting state when a reported split pane is already gone', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%42\n';
            throw new Error("can't find pane: %42");
          },
          sleepSync: () => {},
        },
      ),
      /Question UI pane %42 disappeared immediately after launch/,
    );

    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %42 -F #{pane_dead}\t#{pane_id}'));
  });

  it('uses inline-tty on Windows without invoking tmux when no attached tmux pane is available', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-inline.json',
        sessionId: 's1',
        nowIso: '2026-04-23T00:00:00.000Z',
        env: {} as NodeJS.ProcessEnv,
        platform: 'win32',
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
      {
        execTmux: (args) => {
          calls.push(args);
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'inline-tty');
    assert.equal(result.target, 'inline-tty');
    assert.deepEqual(calls, []);
  });

  it('falls back to the persisted session mode pane when Bash/tool env lost TMUX_PANE', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'planning',
        tmux_pane_id: '%91',
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(cwd, '.omx', 'state', 'sessions', 'sess-stateful', 'questions', 'question-3.json'),
          sessionId: 'sess-stateful',
          env: { TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%77\n';
            if (args[0] === 'list-panes') return '0\t%77\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%91');
      assert.equal(result.return_transport, 'tmux-send-keys');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%91', '#{session_attached}']);
      assert.ok(calls.some((call) => call[0] === 'split-window'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('prefers session-scoped persisted panes over root workflow fallback panes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-precedence-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionStateDir = join(rootStateDir, 'sessions', 'sess-stateful');
      mkdirSync(sessionStateDir, { recursive: true });
      writeFileSync(join(rootStateDir, 'team-state.json'), JSON.stringify({
        active: true,
        mode: 'team',
        current_phase: 'executing',
        tmux_pane_id: '%10',
      }, null, 2));
      writeFileSync(join(sessionStateDir, 'ralplan-state.json'), JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'planning',
        tmux_pane_id: '%91',
      }, null, 2));

      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(sessionStateDir, 'questions', 'question-4.json'),
          sessionId: 'sess-stateful',
          env: { TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%77\n';
            if (args[0] === 'list-panes') return '0\t%77\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%91');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes direct tmux argv so non-POSIX default shells do not parse a shell string', () => {
    const calls: string[][] = [];
    launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/question with spaces.json',
        sessionId: 'sess-123',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%428' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%77\n';
          if (args[0] === 'list-panes') return '0\t%77\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%428', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.equal(splitCall.some((part) => /question --ui --state-path/.test(part)), false);
    assert.equal(splitCall.some((part) => /^'.*'$/.test(part)), false);
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/question with spaces.json',
    ]);
  });

  it('resolves the leader return target before opening the question pane', () => {
    const calls: string[][] = [];
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalTmux = process.env.TMUX;
    process.env.TMUX_PANE = '%200';
    process.env.TMUX = '/tmp/tmux-leader';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/question-4.json',
          sessionId: 'sess-123',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%200' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') {
              process.env.TMUX_PANE = '%201';
              return '%201\n';
            }
            if (args[0] === 'list-panes') return '0\t%201\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%200');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%200', '#{session_attached}']);
    } finally {
      if (typeof originalTmuxPane === 'string') process.env.TMUX_PANE = originalTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof originalTmux === 'string') process.env.TMUX = originalTmux;
      else delete process.env.TMUX;
    }
  });

  it('uses detached sessions outside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: {} as NodeJS.ProcessEnv,
      },
      {
        strategy: 'detached-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'has-session') return '';
          return 'omx-question-question-2\n';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-session');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.ok(calls[0]?.includes('-d'));
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-2.json',
    ]);
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('fails when a detached tmux session disappears immediately after launch', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {} as NodeJS.ProcessEnv,
        },
        {
          strategy: 'detached-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'new-session') return 'omx-question-question-2\n';
            throw new Error('can\'t find session: omx-question-question-2');
          },
          sleepSync: () => {},
        },
      ),
      /Question UI session omx-question-question-2 disappeared immediately after launch/,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('prefers the current launcher path over a stale ambient OMX_ENTRY_PATH when spawning the UI', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/dist/cli/omx.js';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-3.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {
            TMUX: '/tmp/tmux-demo',
            TMUX_PANE: '%11',
            OMX_ENTRY_PATH: '/stale/global/dist/cli/omx.js',
          } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%42\n';
            if (args[0] === 'list-panes') return '0\t%42\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.target, '%42');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
      const splitCall = calls.find((call) => call[0] === 'split-window');
      assert.ok(splitCall);
      assert.equal(splitCall.includes('/repo/dist/cli/omx.js'), true);
      assert.equal(splitCall.includes('/stale/global/dist/cli/omx.js'), false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe('question answer injection', () => {
  it('formats other answers into a single-line continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswerForInjection({
        kind: 'other',
        value: 'hello\nworld',
        selected_labels: ['Other'],
        selected_values: ['hello\nworld'],
        other_text: 'hello\nworld',
      }),
      '[omx question answered] hello world',
    );
  });

  it('formats batch answers into one continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswersForInjection([
        {
          question_id: 'first',
          answer: {
            kind: 'option',
            value: 'a',
            selected_labels: ['A'],
            selected_values: ['a'],
          },
        },
        {
          question_id: 'second',
          answer: {
            kind: 'multi',
            value: ['b', 'custom\nvalue'],
            selected_labels: ['B', 'Other'],
            selected_values: ['b', 'custom\nvalue'],
            other_text: 'custom\nvalue',
          },
        },
      ]),
      '[omx question answered] first: a; second: b, custom value',
    );
  });

  it('injects the answered text back into the requester pane and submits with isolated double C-m', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswerToPane(
      '%11',
      {
        kind: 'option',
        value: 'proceed',
        selected_labels: ['Proceed'],
        selected_values: ['proceed'],
      },
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, buildSendPaneArgvs('%11', '[omx question answered] proceed', true));
    assert.deepEqual(sleeps, [120, 100]);
    assert.equal(calls.some((argv) => argv.includes('Enter')), false);
  });

  it('injects all batch answers back into the requester pane', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswersToPane(
      '%11',
      [
        {
          question_id: 'first',
          answer: {
            kind: 'option',
            value: 'a',
            selected_labels: ['A'],
            selected_values: ['a'],
          },
        },
        {
          question_id: 'second',
          answer: {
            kind: 'option',
            value: 'd',
            selected_labels: ['D'],
            selected_values: ['d'],
          },
        },
      ],
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, buildSendPaneArgvs('%11', '[omx question answered] first: a; second: d', true));
    assert.deepEqual(sleeps, [120, 100]);
  });
});
