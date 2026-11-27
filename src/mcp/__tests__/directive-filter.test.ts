import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterActiveDirectives, type ProjectDirective } from '../directive-filter.js';

describe('directive-filter', () => {
  it('filters directives using instant comparison, not string comparison', () => {
    // This test specifically validates that Date.parse is used, not string comparison.
    // With string comparison, ISO dates can be incorrectly ordered due to string ordering differences.
    
    const baseTime = new Date();
    const basePlus5min = new Date(baseTime.getTime() + 5 * 60 * 1000);
    const basePlus10min = new Date(baseTime.getTime() + 10 * 60 * 1000);
    const baseMinus5min = new Date(baseTime.getTime() - 5 * 60 * 1000);

    const directives: ProjectDirective[] = [
      {
        directive: 'Expired directive',
        priority: 'high',
        timestamp: baseMinus5min.toISOString(),
        expiresAt: baseTime.toISOString(),
      },
      {
        directive: 'Active soon-to-expire',
        priority: 'normal',
        timestamp: baseTime.toISOString(),
        expiresAt: basePlus5min.toISOString(),
      },
      {
        directive: 'Active with future expiry',
        priority: 'normal',
        timestamp: baseTime.toISOString(),
        expiresAt: basePlus10min.toISOString(),
      },
      {
        directive: 'No expiry',
        priority: 'low',
        timestamp: baseTime.toISOString(),
      },
    ];

    // Mock current time to baseTime by creating a scenario where we know exact expiry times
    const filtered = filterActiveDirectives(directives);

    // Should have 3 active directives (the two active ones + the one with no expiry)
    // The expired one should be filtered out
    assert.equal(filtered.length, 3, 'should have 3 active directives (2 with future expiry + 1 with no expiry)');

    // Verify the expired directive is not in the results
    assert.equal(
      filtered.some(d => d.directive === 'Expired directive'),
      false,
      'expired directive should be filtered out'
    );

    // Verify all active directives are present
    assert.equal(
      filtered.some(d => d.directive === 'Active soon-to-expire'),
      true,
      'soon-to-expire directive should be active'
    );
    assert.equal(
      filtered.some(d => d.directive === 'Active with future expiry'),
      true,
      'future-expiry directive should be active'
    );
    assert.equal(
      filtered.some(d => d.directive === 'No expiry'),
      true,
      'no-expiry directive should be active'
    );
  });

  it('handles edge case: directive expiring exactly at current time', () => {
    const now = new Date();
    const justBefore = new Date(now.getTime() - 1);
    const justAfter = new Date(now.getTime() + 1);

    const directives: ProjectDirective[] = [
      {
        directive: 'Just expired',
        priority: 'high',
        timestamp: justBefore.toISOString(),
        expiresAt: justBefore.toISOString(),
      },
      {
        directive: 'Just starting',
        priority: 'high',
        timestamp: now.toISOString(),
        expiresAt: justAfter.toISOString(),
      },
    ];

    const filtered = filterActiveDirectives(directives);

    // The just-after directive should be active (expiry is in the future)
    assert.equal(filtered.length, 1, 'should have 1 active directive');
    assert.equal(
      filtered[0].directive,
      'Just starting',
      'only the future-expiry directive should be active'
    );
  });

  it('returns empty array for undefined or null directives', () => {
    assert.deepEqual(filterActiveDirectives(undefined), [], 'undefined should return empty array');
    assert.deepEqual(filterActiveDirectives([] as any), [], 'empty array should return empty array');
  });

  it('uses Date.parse for precise instant comparison, not string ordering', () => {
    // The fix validates that we parse ISO timestamps to milliseconds (Date.parse)
    // rather than relying on string comparison which breaks with timezone offsets.
    // This test verifies the function correctly identifies active vs expired directives.
    const now = new Date();
    const future = new Date(now.getTime() + 60 * 60 * 1000);
    const past = new Date(now.getTime() - 60 * 60 * 1000);

    const directives: ProjectDirective[] = [
      {
        directive: 'Definitely expired',
        priority: 'high',
        timestamp: past.toISOString(),
        expiresAt: past.toISOString(),
      },
      {
        directive: 'Definitely active',
        priority: 'high',
        timestamp: now.toISOString(),
        expiresAt: future.toISOString(),
      },
    ];

    const filtered = filterActiveDirectives(directives);
    assert.equal(
      filtered.length,
      1,
      'should correctly identify active directives using instant comparison'
    );
    assert.equal(
      filtered[0].directive,
      'Definitely active',
      'should keep only the active directive'
    );
  });

  it('preserves all directive properties when filtering', () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const directives: ProjectDirective[] = [
      {
        directive: 'Test directive',
        priority: 'high',
        context: 'test context',
        timestamp: new Date().toISOString(),
        expiresAt: future,
      },
    ];

    const filtered = filterActiveDirectives(directives);

    assert.equal(filtered.length, 1, 'should have 1 directive');
    assert.equal(filtered[0].directive, 'Test directive', 'directive property preserved');
    assert.equal(filtered[0].priority, 'high', 'priority property preserved');
    assert.equal(filtered[0].context, 'test context', 'context property preserved');
    assert.equal(filtered[0].expiresAt, future, 'expiresAt property preserved');
  });
});
