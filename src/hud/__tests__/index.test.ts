import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runWatchMode } from '../index.js';
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
    team: null,
    metrics: null,
    hudNotify: null,
    session: null,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
      readAllStateFn: async () => emptyCtx(),
      readHudConfigFn: async () => ({ preset: 'focused' }),
      renderHudFn: () => 'frame',
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
  });

  it('coalesces ticks so slow renders do not overlap', async () => {
    const writes: string[] = [];
    let sigintHandler: (() => void) | undefined;
    let timerTick: (() => void) | undefined;

    let callCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirstRender: (() => void) | undefined;
    const firstRenderGate = new Promise<void>((resolve) => {
      releaseFirstRender = resolve;
    });

    const promise = runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => {
        callCount += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (callCount === 1) {
            await firstRenderGate;
          }
          return emptyCtx();
        } finally {
          inFlight -= 1;
        }
      },
      readHudConfigFn: async () => ({ preset: 'focused' }),
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

    // Trigger multiple ticks while first render is still blocked.
    timerTick?.();
    timerTick?.();

    releaseFirstRender?.();
    await flush();
    await flush();

    sigintHandler?.();
    await promise;

    assert.equal(maxInFlight, 1);
    assert.equal(callCount, 2, 'multiple overlapping ticks should collapse to one queued rerender');
  });

  it('handles render failures gracefully and restores terminal state', async () => {
    const writes: string[] = [];
    const errors: string[] = [];
    let clearCount = 0;

    await runWatchMode('/tmp', WATCH_FLAGS, {
      isTTY: true,
      env: {},
      readAllStateFn: async () => {
        throw new Error('boom');
      },
      readHudConfigFn: async () => ({ preset: 'focused' }),
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
