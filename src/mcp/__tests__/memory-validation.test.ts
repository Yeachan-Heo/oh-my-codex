import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotepadPruneDaysOld } from '../memory-validation.js';

describe('parseNotepadPruneDaysOld', () => {
  it('rejects negative values', () => {
    const parsed = parseNotepadPruneDaysOld(-1);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.match(parsed.error, /non-negative integer/i);
    }
  });

  it('accepts zero', () => {
    const parsed = parseNotepadPruneDaysOld(0);
    assert.deepEqual(parsed, { ok: true, days: 0 });
  });

  it('accepts large positive integers', () => {
    const parsed = parseNotepadPruneDaysOld(3650);
    assert.deepEqual(parsed, { ok: true, days: 3650 });
  });

  it('rejects non-integer values', () => {
    const parsed = parseNotepadPruneDaysOld(1.5);
    assert.equal(parsed.ok, false);
  });

  it('uses default for undefined input', () => {
    const parsed = parseNotepadPruneDaysOld(undefined);
    assert.deepEqual(parsed, { ok: true, days: 7 });
  });
});
