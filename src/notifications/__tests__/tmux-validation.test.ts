import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('tmux PID validation', () => {
  it('should validate PID is numeric', () => {
    const pid = parseInt('12345', 10);
    assert.ok(!isNaN(pid));
    assert.strictEqual(pid, 12345);
  });

  it('should detect NaN from malformed PID', () => {
    const pid = parseInt('not-a-pid', 10);
    assert.ok(isNaN(pid));
  });

  it('should detect NaN from empty string', () => {
    const pid = parseInt('', 10);
    assert.ok(isNaN(pid));
  });
});
