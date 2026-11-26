import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runWatchMode } from '../index.js';
import { OMX_TMUX_HUD_OWNER_ENV } from '../reconcile.js';
import { OMX_TMUX_HUD_LEADER_PANE_ENV, type TmuxPaneSnapshot } from '../tmux.js';
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

function ownedHudPanes(heightLines = 2): TmuxPaneSnapshot[] {
  return [
    {
      paneId: '%1', currentCommand: 'codex', startCommand: 'codex', panePid: '101',
      sessionId: '$1', windowId: '@1', paneLeft: 0, paneTop: 0, paneWidth: 80,
      paneHeight: 20, paneBottom: 19, windowWidth: 80, windowHeight: 23,
    },
    {
      paneId: '%2', currentCommand: 'node', panePid: '102', sessionId: '$1', windowId: '@1',
      startCommand: "exec env OMX_SESSION_ID='detached-test' OMX_TMUX_HUD_OWNER='1' OMX_TMUX_HUD_LEADER_PANE='%1' node omx hud --watch",
      paneLeft: 0, paneTop: 21, paneWidth: 80, paneHeight: heightLines,
      paneBottom: 20 + heightLines, windowWidth: 80, windowHeight: 23,
    },
  ];
}

function ownedHudEnv(): NodeJS.ProcessEnv {
  return {
    TMUX: '/private/tmux-501/default,1,0',
    TMUX_PANE: '%2',
    OMX_SESSION_ID: 'detached-test',
    [OMX_TMUX_HUD_OWNER_ENV]: '1',
    [OMX_TMUX_HUD_LEADER_PANE_ENV]: '%1',
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

// The watch loop runs the authority tick at most once per 5s; jump the clock so each manual tick is due.
const realNow = Date.now;
let skewMs = 0;
function tick(handler: (() => void) | undefined): void {
  skewMs += 5_000;
  handler?.();
}

beforeEach(() => {
  skewMs = 0;
  mock.method(Date, 'now', () => realNow() + skewMs);
});

afterEach(() => {
  mock.restoreAll();
  process.exitCode = undefined;
});

describe('runWatchMode detached attachment gating (closes #3577)', () => {
  it('uses the layout projection to resize an owned HUD while detached', async () => {
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let projectionReads = 0;
    let paneHeight = 2;
    const resized: number[] = [];
    const hooks: number[] = [];
    const secondAuthority = deferred();
    let authorityCalls = 0;

    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'current',
      isSessionAttachedFn: () => false,
      listCurrentWindowPanesFn: () => ownedHudPanes(paneHeight),
      readHudHookHealthFn: () => 'healthy',
      readAllStateFn: async () => emptyCtx(),
      readHudLayoutProjectionFn: async () => {
        projectionReads += 1;
        return { ultragoalActive: true, teamWorkerCount: 0 };
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      resizeTmuxPaneFn: (_paneId, heightLines) => {
        resized.push(heightLines);
        paneHeight = heightLines;
        return true;
      },
      registerHudResizeHookFn: (_hudPaneId, _leaderPaneId, heightLines) => {
        hooks.push(heightLines);
        return true;
      },
      clearTmuxPaneHistoryFn: () => true,
      reconcileTmuxHudFn: async () => {},
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthority.resolve();
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    tick(timerTick);
    await withTimeout(secondAuthority.promise, 'detached layout projection tick should complete');
    sigintHandler?.();
    await promise;

    assert.equal(projectionReads, 1);
    assert.deepEqual(resized, [3]);
    assert.deepEqual(hooks, [3]);
  });

  it('avoids full state and render reads after the first owned-HUD frame while detached', async () => {
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let configReads = 0;
    let stateReads = 0;
    let renders = 0;
    let projectionReads = 0;
    let repairs = 0;
    const fourthAuthority = deferred();
    let authorityCalls = 0;

    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'current',
      isSessionAttachedFn: () => false,
      listCurrentWindowPanesFn: () => ownedHudPanes(),
      readHudHookHealthFn: () => 'healthy',
      readHudConfigFn: async () => {
        configReads += 1;
        return { preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } };
      },
      readAllStateFn: async () => {
        stateReads += 1;
        return emptyCtx();
      },
      readHudLayoutProjectionFn: async () => {
        projectionReads += 1;
        return { ultragoalActive: false, teamWorkerCount: 0 };
      },
      renderHudFn: () => {
        renders += 1;
        return 'frame';
      },
      reconcileTmuxHudFn: async () => { repairs += 1; },
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 4) fourthAuthority.resolve();
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    tick(timerTick);
    await flush();
    tick(timerTick);
    await flush();
    tick(timerTick);
    await withTimeout(fourthAuthority.promise, 'three detached projection ticks should complete');
    sigintHandler?.();
    await promise;

    assert.equal(configReads, 1);
    assert.equal(stateReads, 1);
    assert.equal(renders, 1);
    assert.equal(projectionReads, 3);
    assert.equal(repairs, 0);
  });

  it('requests repair when an owned detached HUD is missing a required hook', async () => {
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let hookChecks = 0;
    let repairs = 0;
    const repairStarted = deferred();

    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'current',
      isSessionAttachedFn: () => false,
      listCurrentWindowPanesFn: () => ownedHudPanes(),
      readHudHookHealthFn: () => {
        hookChecks += 1;
        return hookChecks === 1 ? 'healthy' : 'repair_needed';
      },
      readAllStateFn: async () => emptyCtx(),
      readHudLayoutProjectionFn: async () => ({ ultragoalActive: false, teamWorkerCount: 0 }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      reconcileTmuxHudFn: async () => {
        repairs += 1;
        repairStarted.resolve();
      },
      runAuthorityTickFn: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    tick(timerTick);
    await withTimeout(repairStarted.promise, 'missing hook should request detached HUD repair');
    sigintHandler?.();
    await promise;

    assert.equal(hookChecks, 2);
    assert.equal(repairs, 1);
  });

  it('closes its exact owned pane without mutation when leader ownership mismatches', async () => {
    let closes = 0;
    let repairs = 0;
    let resizes = 0;
    let hookWrites = 0;
    let stateReads = 0;

    await runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'mismatch',
      isSessionAttachedFn: () => false,
      readAllStateFn: async () => {
        stateReads += 1;
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      resizeTmuxPaneFn: () => { resizes += 1; return true; },
      registerHudResizeHookFn: () => { hookWrites += 1; return true; },
      reconcileTmuxHudFn: async () => { repairs += 1; },
      closeOwnedPaneFn: () => { closes += 1; },
      runAuthorityTickFn: async () => {},
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: () => {},
      setIntervalFn: () => ({}) as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });

    assert.equal(closes, 1);
    assert.equal(stateReads, 0);
    assert.equal(repairs, 0);
    assert.equal(resizes, 0);
    assert.equal(hookWrites, 0);
  });

  it('suppresses repair, resize, and hook writes while leader ownership is unknown', async () => {
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let hookChecks = 0;
    let repairs = 0;
    let resizes = 0;
    let hookWrites = 0;
    let closes = 0;
    const secondAuthority = deferred();
    let authorityCalls = 0;

    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'unknown',
      isSessionAttachedFn: () => false,
      listCurrentWindowPanesFn: () => ownedHudPanes(),
      readHudHookHealthFn: () => {
        hookChecks += 1;
        return hookChecks === 1 ? 'healthy' : 'repair_needed';
      },
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
      readHudLayoutProjectionFn: async () => ({ ultragoalActive: true, teamWorkerCount: 0 }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      resizeTmuxPaneFn: () => { resizes += 1; return true; },
      registerHudResizeHookFn: () => { hookWrites += 1; return true; },
      reconcileTmuxHudFn: async () => { repairs += 1; },
      closeOwnedPaneFn: () => { closes += 1; },
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthority.resolve();
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    tick(timerTick);
    await withTimeout(secondAuthority.promise, 'unknown owner tick should remain observational');
    sigintHandler?.();
    await promise;

    assert.equal(hookChecks, 2);
    assert.equal(repairs, 0);
    assert.equal(resizes, 0);
    assert.equal(hookWrites, 0);
    assert.equal(closes, 0);
  });

  it('backs off identical failed detached repair attempts', async () => {
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    let repairs = 0;
    let authorityCalls = 0;
    const secondAuthority = deferred();
    const secondRepair = deferred();

    const promise = runWatchMode('/repo', WATCH_FLAGS, {
      isTTY: true,
      env: ownedHudEnv(),
      isOwnerAliveFn: async () => true,
      readHudLeaderOwnerFn: () => 'current',
      isSessionAttachedFn: () => false,
      listCurrentWindowPanesFn: () => ownedHudPanes(),
      readHudHookHealthFn: () => 'repair_needed',
      readAllStateFn: async () => emptyCtx(),
      readHudLayoutProjectionFn: async () => ({ ultragoalActive: false, teamWorkerCount: 0 }),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      reconcileTmuxHudFn: async () => {
        repairs += 1;
        if (repairs === 2) secondRepair.resolve();
        return false;
      },
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthority.resolve();
      },
      writeStdout: () => {},
      writeStderr: () => {},
      registerSigint: (handler) => { sigintHandler = handler; },
      setIntervalFn: (handler) => {
        timerTick = handler;
        return ({}) as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: () => {},
    });

    await flush();
    assert.equal(repairs, 1);
    timerTick?.();
    await flush();
    assert.equal(repairs, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    timerTick?.();
    await withTimeout(secondRepair.promise, 'failed repair should retry after backoff');
    sigintHandler?.();
    await promise;

    assert.equal(repairs, 2);
  });

  it('skips render-only work while detached but keeps the authority tick running', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let authorityCalls = 0;
    let attachmentQueries = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthorityStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => {
        attachmentQueries += 1;
        return false;
      },
      readAllStateFn: async () => {
        stateReads += 1;
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthorityStarted.resolve();
      },
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
    tick(timerTick);
    await withTimeout(secondAuthorityStarted.promise, 'second authority tick should run while detached');
    sigintHandler?.();
    await promise;

    // The very first frame renders unconditionally so an attached client (or a
    // first render before any detach) never sees an empty pane.
    assert.equal(stateReads, 1, 'detached ticks must not re-read HUD state');
    assert.equal(authorityCalls, 2, 'authority tick must keep running while detached');
    assert.ok(attachmentQueries >= 2, 'attachment must be queried each tick');
    assert.equal(writes.filter((chunk) => chunk.includes('frame')).length, 1, 'only the first frame may be written while detached');
  });

  it('renders immediately on the first tick after a client reattaches', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const thirdReadStarted = deferred();
    const secondReadDone = deferred();

    let attached = false;
    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => attached,
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 2) secondReadDone.resolve();
        if (stateReads === 3) thirdReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => `frame:${stateReads}`,
      runAuthorityTickFn: async () => {},
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
    // Detached tick: suppressed render.
    attached = false;
    tick(timerTick);
    await flush();
    assert.equal(stateReads, 1, 'detached tick must not read state');

    // Reattach: the next tick renders immediately with fresh state.
    attached = true;
    tick(timerTick);
    await withTimeout(secondReadDone.promise, 'reattached tick must render immediately');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 2);
    assert.ok(writes.some((chunk) => chunk.includes('frame:2')), 'reattached frame must be written');
  });

  it('keeps rendering every tick while attached (no behavior change when attached)', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const thirdReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => true,
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 3) thirdReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {},
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
    tick(timerTick);
    tick(timerTick);
    await withTimeout(thirdReadStarted.promise, 'attached ticks must keep rendering');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 3);
    assert.equal(writes.filter((chunk) => chunk.includes('frame')).length, 3);
  });

  it('fails open and renders when the attachment probe throws', async () => {
    const writes: string[] = [];
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondReadStarted = deferred();

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => {
        throw new Error('no server running');
      },
      readAllStateFn: async () => {
        stateReads += 1;
        if (stateReads === 2) secondReadStarted.resolve();
        return emptyCtx();
      },
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {},
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
    tick(timerTick);
    await withTimeout(secondReadStarted.promise, 'failing probe must fall back to rendering');
    sigintHandler?.();
    await promise;

    assert.equal(stateReads, 2);
  });

  it('does not clear the terminal or write control sequences while detached', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthority = deferred();

    let authorityCalls = 0;
    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      isSessionAttachedFn: () => false,
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
      renderHudFn: () => 'frame',
      runAuthorityTickFn: async () => {
        authorityCalls += 1;
        if (authorityCalls === 2) secondAuthority.resolve();
      },
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
    tick(timerTick);
    await withTimeout(secondAuthority.promise, 'second detached tick should complete');
    sigintHandler?.();
    await promise;

    // Only the initial hide-cursor + first-frame clear, never a per-tick '\x1b[H' repaint.
    assert.equal(writes.filter((chunk) => chunk === '\x1b[H').length, 0, 'detached ticks must not repaint');
  });
  it('binds the default attachment probe to the injected env, not inherited process.env', async () => {
    // Regression for the review blocker on PR #3579: the default
    // isSessionAttachedFn used the inherited process.env, so a test (or any
    // caller) that injects env: {} while running inside tmux still consulted
    // the ambient TMUX/TMUX_PANE and could suppress renders. The default probe
    // must see only dependencies.env.
    const previousTmux = process.env.TMUX;
    const previousTmuxPane = process.env.TMUX_PANE;
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondReadDone = deferred();

    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    process.env.TMUX_PANE = '%7';

    let promise: Promise<void>;
    try {
      promise = runWatchMode('/tmp', WATCH_FLAGS, {
        isTTY: true,
        // Injected env has no TMUX: the default probe must treat this as
        // attached even though process.env still carries tmux variables.
        env: {},
        readAllStateFn: async () => {
          stateReads += 1;
          if (stateReads === 2) secondReadDone.resolve();
          return emptyCtx();
        },
        readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
        renderHudFn: () => 'frame',
        runAuthorityTickFn: async () => {},
        writeStdout: () => {},
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
      // Second tick must render: injected env has no TMUX, so the default
      // probe must answer "attached" regardless of the ambient tmux env.
      tick(timerTick);
      await withTimeout(secondReadDone.promise, 'injected env (no TMUX) must keep rendering despite inherited tmux env');
      sigintHandler?.();
      await promise;
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
      else delete process.env.TMUX_PANE;
    }

    assert.equal(stateReads, 2, 'ticks under an injected non-tmux env must keep rendering');
  });

  it('suppresses detached renders through the injected env when it describes tmux', async () => {
    // The mirror case: an injected env that DOES describe tmux must drive
    // suppression, proving the default probe reads dependencies.env (and not
    // merely "always attached because tests run without ambient tmux").
    const execStubHome = process.env.HOME;
    let attachmentProbes = 0;
    let stateReads = 0;
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;
    const secondAuthority = deferred();
    let authorityCalls = 0;

    // Point PATH at a fake tmux that answers session_attached=0 for any pane,
    // so the default probe (which shells out to tmux) observes "detached".
    const fakeBin = await mkdtemp(join(tmpdir(), 'omx-hud-env-bind-'));
    const tmuxPath = join(fakeBin, 'tmux');
    await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "display-message" ]; then printf \'0\\n\'; exit 0; fi\nexit 0\n');
    await chmod(tmuxPath, 0o755);
    const previousPath = process.env.PATH;

    let promise: Promise<void>;
    try {
      process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ''}`;
      // Track probe executions by observing state reads: suppressed ticks do
      // not read state, so the only way tick 2 completes without a second
      // read is a detached answer from the injected env.
      promise = runWatchMode('/tmp', WATCH_FLAGS, {
        isTTY: true,
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7', CI: '1', PATH: process.env.PATH, HOME: execStubHome ?? '' },
        readAllStateFn: async () => {
          stateReads += 1;
          return emptyCtx();
        },
        readHudConfigFn: async () => ({ preset: 'focused', git: { display: 'repo-branch' }, statusLine: { preset: 'focused' } }),
        renderHudFn: () => 'frame',
        runAuthorityTickFn: async () => {
          authorityCalls += 1;
          attachmentProbes += 1;
          if (authorityCalls === 2) secondAuthority.resolve();
        },
        writeStdout: () => {},
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
      tick(timerTick);
      await withTimeout(secondAuthority.promise, 'second detached tick should complete without a state read');
      sigintHandler?.();
      await promise;
    } finally {
      process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }

    assert.equal(stateReads, 1, 'detached ticks under an injected tmux env must not re-read HUD state');
    assert.ok(attachmentProbes >= 2, 'authority tick must keep running while detached');
  });
});
