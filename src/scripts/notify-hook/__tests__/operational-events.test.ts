import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildOperationalContext } from '../operational-events.js';

describe('buildOperationalContext', () => {
  it('preserves newly added canonical runtime event names in normalized_event', () => {
    for (const normalizedEvent of [
      'run.heartbeat',
      'run.blocked_on_user',
      'run.blocked_on_system',
      'worker.assigned',
      'worker.stalled',
      'worker.recovered',
    ]) {
      const context = buildOperationalContext({
        cwd: process.cwd(),
        normalizedEvent,
        status: normalizedEvent,
      });
      assert.equal(context.normalized_event, normalizedEvent);
      assert.equal(context.status, normalizedEvent);
    }
  });
});
