import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sleep } from '../sleep.js';

describe('sleep resource cleanup', () => {
  it('removes abort listeners after timer resolution to avoid resource leaks', async () => {
    const controller = new AbortController();
    let adds = 0;
    let removes = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);

    controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      if (args[0] === 'abort') adds += 1;
      return originalAdd(...args);
    }) as AbortSignal['addEventListener'];
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal['removeEventListener']>) => {
      if (args[0] === 'abort') removes += 1;
      return originalRemove(...args);
    }) as AbortSignal['removeEventListener'];

    await sleep(1, controller.signal);

    assert.equal(adds, 1);
    assert.equal(removes, 1);
  });

  it('rejects already-aborted signals without registering resource-leaking listeners', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    let adds = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
      if (args[0] === 'abort') adds += 1;
      return originalAdd(...args);
    }) as AbortSignal['addEventListener'];

    await assert.rejects(() => sleep(100, controller.signal), /stop/);
    assert.equal(adds, 0);
  });
});
