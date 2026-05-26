import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hudCommand, runWatchMode } from '../index.js';
import { renderHud } from '../render.js';
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

describe('runWatchMode', () => {
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
    assert.ok(plain.includes('G003-next: Next team checkpoint (pending)'));
  });

  it('runs authority tick after each rendered frame', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let authorityCalls = 0;

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
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
  it('reuses a same-session HUD pane when TMUX_PANE is empty instead of splitting a duplicate', async () => {
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
if [[ "$1" == "list-panes" ]]; then
  printf '%s\\n' '%1	codex	codex'
  printf '%s\\n' "%2	node	exec env OMX_SESSION_ID='sess-a' OMX_TMUX_HUD_LEADER_PANE='%1' /node /omx.js hud --watch"
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
    };
    const previousLog = console.log;
    const logs: string[] = [];
    try {
      process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      process.env.TMUX_PANE = '';
      process.env.OMX_SESSION_ID = 'sess-a';
      console.log = (message?: unknown) => { logs.push(String(message ?? '')); };

      await hudCommand(['--tmux']);

      const tmuxLog = await readFile(logPath, 'utf8');
      assert.match(tmuxLog, /display-message -p #\{pane_id\}/);
      assert.match(tmuxLog, /list-panes -t %1 -F #\{pane_id\}\t#\{pane_current_command\}\t#\{pane_start_command\}/);
      assert.match(tmuxLog, /resize-pane -t %2 -y \d+/);
      assert.doesNotMatch(tmuxLog, /split-window/);
      assert.ok(logs.some((line) => line.includes('Reused existing HUD pane')));
    } finally {
      console.log = previousLog;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
