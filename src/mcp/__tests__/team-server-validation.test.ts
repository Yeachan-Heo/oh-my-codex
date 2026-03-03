import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('team-server validation', () => {
  it('should reject session names with special characters', () => {
    const validPattern = /^[a-zA-Z0-9_-]+$/;

    assert.ok(validPattern.test('omx-team-123'));
    assert.ok(validPattern.test('my_team'));
    assert.ok(!validPattern.test('team:1.0'));
    assert.ok(!validPattern.test('team;rm -rf /'));
    assert.ok(!validPattern.test(''));
    assert.ok(!validPattern.test('team name'));
  });
});
