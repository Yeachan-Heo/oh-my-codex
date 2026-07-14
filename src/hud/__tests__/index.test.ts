import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hudCommand, resolveHudWatchCwd, runWatchMode } from '../index.js';
import { renderHud } from '../render.js';
import { OMX_TMUX_HUD_OWNER_ENV } from '../reconcile.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV } from '../tmux.js';
import type { HudFlags, HudRenderContext } from '../types.js';

const WATCH_FLAGS: HudFlags = {
  watch: true,
  json: false,
  tmux: false,
};

function emptyCtx(): HudRenderContext {
  return {
    version: null,
    gitBranch: null,
    ralph: null,
    ultrawork: null,
    autopilot: null,
    ralplan: null,
    deepInterview: null,
    autoresearch: null,
    ultraqa: null,
    team: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout(promise: Promise<void>, message: string, timeoutMs = 1000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  process.exitCode = undefined;
});

describe('hudCommand reconcile entrypoint', () => {
  it('runs tmux reconciliation without changing the exit code when repair succeeds', async () => {
    let reconciledCwd: string | null = null;

    await hudCommand(['--reconcile-tmux'], {
      cwd: '/repo',
      reconcileHudForPromptSubmit: async (cwd) => {
        reconciledCwd = cwd;
        return { status: 'recreated', paneId: '%9', desiredHeight: 3, duplicateCount: 0 };
      },
    });

    assert.equal(reconciledCwd, '/repo');
    assert.equal(process.exitCode, undefined);
  });

  it('sets a non-zero exit code when tmux reconciliation fails', async () => {
    await hudCommand(['--reconcile-tmux'], {
      cwd: '/repo',
      reconcileHudForPromptSubmit: async () => (
        { status: 'failed', paneId: null, desiredHeight: 3, duplicateCount: 0 }
      ),
    });

    assert.equal(process.exitCode, 1);
  });
});

describe('runWatchMode', () => {
  it('resolves a live cwd when the HUD launch path was reused by another run', () => {
    const resolved = resolveHudWatchCwd('/home/tools/calc', {
      getCwd: () => '/home/tools/calc',
      readProcCwd: () => '/home/tools/calc.noninteractive-aborted-20260527T233204Z',
      realpath: (path) => {
        if (path === '/home/tools/calc') return '/dev/inode/new-calc-run';
        if (path === '/home/tools/calc.noninteractive-aborted-20260527T233204Z') {
          return '/dev/inode/old-aborted-run';
        }
        return path;
      },
    });

    assert.equal(resolved, '/home/tools/calc.noninteractive-aborted-20260527T233204Z');
  });

  it('keeps the launch cwd when live and launch paths resolve to the same directory', () => {
    const resolved = resolveHudWatchCwd('/workspace/link', {
      getCwd: () => '/workspace/link',
      readProcCwd: () => '/workspace/real',
      realpath: () => '/dev/inode/same-project',
    });

    assert.equal(resolved, '/workspace/link');
  });

  it('does not select a proc deleted-cwd marker over the safer launch cwd', () => {
    const resolved = resolveHudWatchCwd('/tmp/omx-doctor-plugin-hook-smoke', {
      getCwd: () => '/tmp/omx-doctor-plugin-hook-smoke',
      readProcCwd: () => '/tmp/omx-doctor-plugin-hook-smoke (deleted)',
      realpath: (path) => {
        if (path === '/tmp/omx-doctor-plugin-hook-smoke') return '/dev/inode/reused-safe-path';
        throw new Error(`deleted marker path should not be resolved: ${path}`);
      },
    });

    assert.equal(resolved, '/tmp/omx-doctor-plugin-hook-smoke');
  });

  it('follows a live cwd whose literal name ends with the deleted marker text', () => {
    const resolved = resolveHudWatchCwd('/tmp/stale-launch', {
      getCwd: () => '/tmp/live workspace (deleted)',
      readProcCwd: () => '/tmp/live workspace (deleted)',
      realpath: (path) => {
        if (path === '/tmp/stale-launch') return '/dev/inode/stale-launch';
        if (path === '/tmp/live workspace (deleted)') return '/dev/inode/live-literal-marker';
        return path;
      },
    });

    assert.equal(resolved, '/tmp/live workspace (deleted)');
  });

  it('follows a live literal deleted-marker cwd when process cwd is an alias to the same directory', () => {
    const resolved = resolveHudWatchCwd('/tmp/stale-launch', {
      getCwd: () => '/tmp/link-to-live',
      readProcCwd: () => '/tmp/live workspace (deleted)',
      realpath: (path) => {
        if (path === '/tmp/stale-launch') return '/dev/inode/stale-launch';
        if (path === '/tmp/link-to-live') return '/dev/inode/live-literal-marker';
        if (path === '/tmp/live workspace (deleted)') return '/dev/inode/live-literal-marker';
        return path;
      },
    });

    assert.equal(resolved, '/tmp/live workspace (deleted)');
  });

  it('keeps manual watch rendering-only even when the live cwd changes', async () => {
    const seenConfigCwds: string[] = [];
    const seenStateCwds: string[] = [];
    const seenAuthorityCwds: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/home/tools/calc', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      resolveWatchCwdFn: () => '/home/tools/calc.noninteractive-aborted-20260527T233204Z',
      readHudConfigFn: async (cwd) => {
        seenConfigCwds.push(cwd);
        return { preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } };
      },
      readAllStateFn: async (cwd) => {
        seenStateCwds.push(cwd);
        return emptyCtx();
      },
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async ({ cwd }) => { seenAuthorityCwds.push(cwd); },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(seenConfigCwds, ['/home/tools/calc.noninteractive-aborted-20260527T233204Z']);
    assert.deepEqual(seenStateCwds, ['/home/tools/calc.noninteractive-aborted-20260527T233204Z']);
    assert.deepEqual(seenAuthorityCwds, []);
  });

  it('restores cursor and clears interval on SIGINT', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let clearCount = 0;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => ({ ...emptyCtx(), gitBranch: config?.git.display ?? null }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (ctx) => `frame:${ctx.gitBranch}`,
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => { clearCount += 1; },
    });

    await flush();
    assert.ok(sigintHandler, 'SIGINT handler should be registered');

    sigintHandler?.();
    await promise;

    assert.equal(clearCount, 1);
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25l')), 'cursor should be hidden in watch mode');
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25h\x1b[2J\x1b[H')), 'cursor should be restored on SIGINT');
    assert.ok(writes.some((chunk) => chunk.includes('frame:repo-branch')));
  });

  it('coalesces ticks so slow renders do not overlap', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;

    let callCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const firstRenderGate = deferred();
    const firstReadStarted = deferred();
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => {
        callCount += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (callCount === 1) {
            firstReadStarted.resolve();
            await firstRenderGate.promise;
          } else if (callCount === 2) {
            secondReadStarted.resolve();
          }
          return emptyCtx();
        } finally {
          inFlight -= 1;
        }
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    assert.ok(timerTick, 'interval tick should be registered');
    await withTimeout(firstReadStarted.promise, 'first render should start before exercising queued ticks');

    // Trigger multiple ticks while first render is deterministically blocked.
    timerTick?.();
    timerTick?.();

    firstRenderGate.resolve();
    await withTimeout(secondReadStarted.promise, 'queued rerender should start after first render is released');

    sigintHandler?.();
    await promise;

    assert.equal(maxInFlight, 1);
    assert.equal(callCount, 2, 'multiple overlapping ticks should collapse to one queued rerender');
  });


  it('renders combined ultragoal and team state as one stable watch frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => ({
        ...emptyCtx(),
        team: { active: true, agent_count: 2, team_name: 'hud-fix' },
        ultragoal: {
          active: true,
          status: 'in_progress',
          total: 3,
          complete: 1,
          pending: 1,
          inProgress: 1,
          failed: 0,
          reviewBlocked: 0,
          needsUserDecision: 0,
          progressTotal: 3,
          activeGoal: {
            id: 'G002-team',
            title: 'Team HUD summary',
            objective: 'avoid duplicated focused tmux HUD content',
            status: 'in_progress',
            index: 2,
          },
          nextGoals: [{
            id: 'G003-next',
            title: 'Next team checkpoint',
            objective: 'keep combined team ultragoal compact',
            status: 'pending',
            index: 3,
          }],
        },
      }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: renderHud,
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    const plain = writes.join('').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert.equal((plain.match(/team:2 workers/g) ?? []).length, 1);
    assert.equal((plain.match(/ultragoal 1\/3/g) ?? []).length, 1);
    assert.ok(plain.includes('ultragoal 1/3 + team:2 workers'));
    assert.ok(plain.includes('G002-team: Team HUD summary'));
    assert.ok(!plain.includes('G003-next: Next team checkpoint (pending)'));
  });

  it('passes adaptive active-ultragoal line budget to watch rendering', async () => {
    const maxLines: Array<number | undefined> = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => ({
        ...emptyCtx(),
        ultragoal: {
          active: true,
          status: 'in_progress',
          total: 1,
          complete: 0,
          pending: 0,
          inProgress: 1,
          failed: 0,
          reviewBlocked: 0,
          needsUserDecision: 0,
          progressTotal: 1,
        },
      }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (_ctx, _preset, options) => {
        maxLines.push(options?.maxLines);
        return 'frame';
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(maxLines, [3]);
  });

  it('passes compact no-ultragoal line budget to watch rendering', async () => {
    const maxLines: Array<number | undefined> = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: (_ctx, _preset, options) => {
        maxLines.push(options?.maxLines);
        return 'frame';
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.deepEqual(maxLines, [2]);
  });

  it('does not write an extra terminal row beyond the rendered watch frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'line-one\nline-two',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.ok(writes.some((chunk) => chunk.includes('line-one\nline-two\x1b[K\x1b[J')));
    assert.ok(!writes.some((chunk) => chunk.includes('line-two\x1b[K\n\x1b[J')));
  });

  it('resizes an OMX-owned running HUD pane when the adaptive budget changes', async () => {
    const resized: Array<{ paneId: string; heightLines: number }> = [];
    const registered: Array<{ hudPaneId: string; leaderPaneId: string | undefined; heightLines: number }> = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let callCount = 0;
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {
        TMUX: '1',
        TMUX_PANE: '%hud',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
        [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%leader',
      },
      readAllStateFn: async () => {
        callCount += 1;
        if (callCount === 2) secondReadStarted.resolve();
        return {
          ...emptyCtx(),
          ultragoal: callCount === 1 ? null : {
            active: true,
            status: 'in_progress',
            total: 1,
            complete: 0,
            pending: 0,
            inProgress: 1,
            failed: 0,
            reviewBlocked: 0,
            needsUserDecision: 0,
            progressTotal: 1,
          },
        };
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      resizeTmuxPaneFn: (paneId, heightLines) => {
        resized.push({ paneId, heightLines });
        return true;
      },
      registerHudResizeHookFn: (hudPaneId, leaderPaneId, heightLines) => {
        registered.push({ hudPaneId, leaderPaneId, heightLines });
        return true;
      },
    });

    await flush();
    timerTick?.();
    await withTimeout(secondReadStarted.promise, 'second render should observe active ultragoal');
    sigintHandler?.();
    await promise;

    assert.deepEqual(resized, [
      { paneId: '%hud', heightLines: 2 },
      { paneId: '%hud', heightLines: 3 },
    ]);
    assert.deepEqual(registered, [
      { hudPaneId: '%hud', leaderPaneId: '%leader', heightLines: 2 },
      { hudPaneId: '%hud', leaderPaneId: '%leader', heightLines: 3 },
    ]);
  });

  it('runs authority ticks only for managed HUD watchers', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let authorityCalls = 0;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {
        TMUX: '1',
        TMUX_PANE: '%hud',
        OMX_SESSION_ID: 'session-a',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
        [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%leader',
      },
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
      runAuthorityTickFn: async ({ cwd }) => { authorityCalls += 1; assert.equal(cwd, '/tmp'); },
    });

    await flush();
    sigintHandler?.();
    await promise;

    assert.equal(authorityCalls, 1);
    assert.ok(writes.some((chunk) => chunk.includes('frame')));
  });

  it('keeps rendering when the authority tick fails after a frame', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let renderCount = 0;
    let authorityCalls = 0;
    const firstAuthorityAttempted = deferred();
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {
        TMUX: '1',
        TMUX_PANE: '%hud',
        OMX_SESSION_ID: 'session-a',
        [OMX_TMUX_HUD_OWNER_ENV]: '1',
        [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%leader',
      },
      readAllStateFn: async () => {
        renderCount += 1;
        if (renderCount === 2) secondReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: (text) => { errors.push(text); },
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 1) {
          firstAuthorityAttempted.resolve();
          throw new Error('dist is rebuilding');
        }
      },
    });

    await withTimeout(firstAuthorityAttempted.promise, 'first authority tick should run');
    await flush();
    assert.equal(process.exitCode, undefined);
    assert.ok(errors.some((line) => line.includes('HUD watch authority tick failed: dist is rebuilding')));

    timerTick?.();
    await withTimeout(secondReadStarted.promise, 'watch should render again after authority tick failure');
    sigintHandler?.();
    await promise;

    assert.equal(renderCount, 2);
    assert.equal(authorityCalls, 2);
    assert.equal(process.exitCode, undefined);
    assert.equal((writes.join('').match(/frame/g) ?? []).length, 2);
    assert.ok(!errors.some((line) => line.includes('HUD watch render failed')));
  });

  it('handles render failures gracefully and restores terminal state', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    let clearCount = 0;

    await runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async (_cwd, config) => {
        throw new Error('boom');
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      writeStdout: (text) => { writes.push(text); },
      writeStderr: (text) => { errors.push(text); },
      registerSigint: () => {},
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => { clearCount += 1; },
    });

    assert.equal(clearCount, 1);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('HUD watch render failed: boom')));
    assert.ok(writes.some((chunk) => chunk.includes('\x1b[?25h\x1b[2J\x1b[H')));
  });
});

describe('hudCommand --tmux', () => {
  it('removes duplicate same-leader HUD panes and reuses one when launched with --tmux', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'omx-hud-tmux-duplicate-test-'));
    const logPath = join(tmp, 'tmux.log');
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin);
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, `#!/usr/bin/env bash
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "display-message" && "$*" == *'#{session_id}'* ]]; then
  printf '$7\t@3\n'
  exit 0
fi
if [[ "$1" == "display-message" && "$*" == *'#S'* ]]; then
  printf 'managed-session\n'
  exit 0
fi
if [[ "$1" == "show-option" && "$*" == *'-p -t %1 @omx_pane_instance_id'* ]]; then
  printf 'sess-a\n'
  exit 0
fi
if [[ "$1" == "list-panes" ]]; then
  printf '%s\n' '%1\tzsh\t0\t0\t100\t30\t29\t100\t32\tsess-a\tsess-a\tzsh\t/tmp'
  printf '%s\n' "%2\tnode\t0\t30\t100\t2\t31\t100\t32\tsess-a\tsess-a\texec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_LEADER_PANE='%1' /node /omx.js hud --watch\t/tmp"
  printf '%s\n' "%3\tnode\t0\t28\t100\t2\t29\t100\t32\tsess-a\tsess-a\texec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_LEADER_PANE='%1' /node /omx.js hud --watch\t/tmp"
  exit 0
fi
if [[ "$1" == "resize-pane" || "$1" == "set-hook" || "$1" == "kill-pane" ]]; then
  exit 0
fi
if [[ "$1" == "split-window" ]]; then
  echo '%9'
  exit 0
fi
exit 0
`);
    await chmod(tmuxPath, 0o755);

    const previousEnv = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      OMX_SESSION_ID: process.env.OMX_SESSION_ID,
      OMX_ROOT: process.env.OMX_ROOT,
    };
    try {
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '%1';
      process.env.OMX_SESSION_ID = 'sess-a';
      process.env.OMX_ROOT = tmp;
      await mkdir(join(tmp, '.omx', 'state'), { recursive: true });
      await writeFile(join(tmp, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: 'sess-a',
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: process.cwd(),
        pid: 0,
        tmux_session_name: 'managed-session',
        tmux_pane_id: '%1',
      }));

      await hudCommand(['--tmux']);

      const tmuxLog = await readFile(logPath, 'utf8');
      assert.match(
        tmuxLog,
        /list-panes -t %1 -F #\{pane_id\}\x1f#\{pane_current_command\}(?:\x1f#\{[^}]+\})*\x1f#\{pane_start_command\}\x1f#\{pane_current_path\}/,
      );
      assert.match(tmuxLog, /kill-pane -t %3/);
      assert.match(tmuxLog, /resize-pane -t %2 -y \d+/);
      assert.doesNotMatch(tmuxLog, /split-window/);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
  it('reuses a same-session HUD pane only after the current leader pane is verified', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'omx-hud-tmux-test-'));
    const logPath = join(tmp, 'tmux.log');
    const fakeBin = join(tmp, 'bin');
    await mkdir(fakeBin);
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ "$1" == "display-message" && "$*" == *'#{pane_id}'* ]]; then
  echo '%1'
  exit 0
fi
if [[ "$1" == "display-message" && "$*" == *'#{session_id}'* ]]; then
  printf '$7\\t@3\\n'
  exit 0
fi
if [[ "$1" == "display-message" && "$*" == *'#S'* ]]; then
  printf 'managed-session\n'
  exit 0
fi
if [[ "$1" == "show-option" && "$*" == *'-p -t %1 @omx_pane_instance_id'* ]]; then
  printf 'sess-a\n'
  exit 0
fi
if [[ "$1" == "list-panes" ]]; then
  printf '%s\n' '%1\tcodex\t0\t0\t100\t30\t29\t100\t32\tsess-a\tsess-a\tcodex\t/tmp'
  printf '%s\n' "%2\tnode\t0\t30\t100\t2\t31\t100\t32\tsess-a\tsess-a\texec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_LEADER_PANE='%1' /node /omx.js hud --watch\t/tmp"
  exit 0
fi
if [[ "$1" == "resize-pane" || "$1" == "set-hook" ]]; then
  exit 0
fi
if [[ "$1" == "split-window" ]]; then
  echo '%9'
  exit 0
fi
exit 0
`);
    await chmod(tmuxPath, 0o755);

    const previousEnv = {
      PATH: process.env.PATH,
      TMUX: process.env.TMUX,
      TMUX_PANE: process.env.TMUX_PANE,
      OMX_SESSION_ID: process.env.OMX_SESSION_ID,
      OMX_ROOT: process.env.OMX_ROOT,
    };
    try {
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '%1';
      process.env.OMX_SESSION_ID = 'sess-a';
      process.env.OMX_ROOT = tmp;
      await mkdir(join(tmp, '.omx', 'state'), { recursive: true });
      await writeFile(join(tmp, '.omx', 'state', 'session.json'), JSON.stringify({
        session_id: 'sess-a',
        started_at: '2026-01-01T00:00:00.000Z',
        cwd: process.cwd(),
        pid: 0,
        tmux_session_name: 'managed-session',
        tmux_pane_id: '%1',
      }));

      await hudCommand(['--tmux']);

      const tmuxLog = await readFile(logPath, 'utf8');
      assert.match(
        tmuxLog,
        /list-panes -t %1 -F #\{pane_id\}\x1f#\{pane_current_command\}(?:\x1f#\{[^}]+\})*\x1f#\{pane_start_command\}\x1f#\{pane_current_path\}/,
      );
      assert.match(tmuxLog, /set-hook -t \$7/);
      assert.doesNotMatch(tmuxLog, /split-window/);
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
