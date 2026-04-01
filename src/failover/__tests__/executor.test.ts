import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderTracker } from '../tracker.js';

describe('executeWithFailover (unit logic)', () => {
  it('tracker correctly chains failover across providers', () => {
    const tracker = new ProviderTracker({
      order: ['codex', 'claude', 'gemini', 'grok'],
      cooldownMs: 60_000,
    });

    // Simulate codex being rate limited
    tracker.recordError('codex', 'rate limit exceeded');
    assert.equal(tracker.isProviderAvailable('codex'), false);

    // Next provider should skip codex
    const next1 = tracker.getNextAvailableProvider('codex');
    assert.equal(next1, 'claude');

    // Simulate claude also being rate limited
    tracker.recordError('claude', '429 Too Many Requests');
    const next2 = tracker.getNextAvailableProvider('codex');
    assert.equal(next2, 'gemini');

    // Record the failover chain
    tracker.recordFailover('codex', 'claude', 'rate_limit', 0);
    tracker.recordFailover('claude', 'gemini', 'rate_limit', 1);
    const events = tracker.getEvents();
    assert.equal(events.length, 2);
  });

  it('failover stops when maxRetries is reached conceptually', () => {
    const tracker = new ProviderTracker({
      order: ['codex', 'claude'],
      cooldownMs: 60_000,
      maxRetries: 1,
    });

    tracker.recordError('codex', 'rate limit');
    tracker.recordError('claude', 'rate limit');

    // Both are rate limited, no next available
    const next = tracker.getNextAvailableProvider();
    assert.equal(next, null);

    const config = tracker.getConfig();
    assert.equal(config.maxRetries, 1);
  });

  it('tracks multiple providers usage independently', () => {
    const tracker = new ProviderTracker();
    tracker.recordUsage('codex', 100, 200);
    tracker.recordUsage('claude', 300, 400);
    tracker.recordUsage('grok', 500, 600);

    assert.equal(tracker.getUsage('codex').totalTokens, 300);
    assert.equal(tracker.getUsage('claude').totalTokens, 700);
    assert.equal(tracker.getUsage('grok').totalTokens, 1100);
  });
});
