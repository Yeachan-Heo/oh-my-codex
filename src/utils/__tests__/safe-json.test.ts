import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeJsonParse } from '../safe-json.js';

describe('safeJsonParse', () => {
  it('returns parsed objects rather than the fallback', () => {
    assert.deepEqual(safeJsonParse('{"enabled":true}', { enabled: false }), { enabled: true });
  });

  it('preserves valid JSON primitives including falsy values', () => {
    for (const value of [null, false, 0, '']) {
      assert.equal(safeJsonParse<unknown>(JSON.stringify(value), 'fallback'), value);
    }
  });

  it('returns the exact caller fallback for malformed or empty JSON', () => {
    const fallback = { enabled: false };
    assert.equal(safeJsonParse('{', fallback), fallback);
    assert.equal(safeJsonParse('', fallback), fallback);
  });
});
