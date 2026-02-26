import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { watchRenderLoop } from '../index.js';

describe('watchRenderLoop', () => {
  it('does not overlap renders when a render takes longer than the interval', async () => {
    const abortController = new AbortController();
    let tickCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;

    await watchRenderLoop(async () => {
      tickCount += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;

      if (tickCount >= 3) {
        abortController.abort();
      }
    }, {
      intervalMs: 1,
      signal: abortController.signal,
    });

    assert.equal(tickCount, 3);
    assert.equal(maxInFlight, 1);
  });

  it('continues after render errors and reports them via onError', async () => {
    const abortController = new AbortController();
    const errors: unknown[] = [];
    let tickCount = 0;

    await watchRenderLoop(async () => {
      tickCount += 1;
      if (tickCount === 1) {
        throw new Error('render failed');
      }
      if (tickCount >= 3) {
        abortController.abort();
      }
    }, {
      intervalMs: 0,
      signal: abortController.signal,
      onError: (error) => errors.push(error),
    });

    assert.equal(tickCount, 3);
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /render failed/);
  });

  it('exits promptly when aborted while waiting between ticks', async () => {
    const abortController = new AbortController();
    let tickCount = 0;

    const loop = watchRenderLoop(async () => {
      tickCount += 1;
      if (tickCount === 1) {
        setTimeout(() => abortController.abort(), 10);
      }
    }, {
      intervalMs: 10_000,
      signal: abortController.signal,
    });

    await loop;
    assert.equal(tickCount, 1);
  });
});
