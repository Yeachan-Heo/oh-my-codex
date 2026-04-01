import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderTracker, isRateLimitError } from '../tracker.js';

describe('ProviderTracker', () => {
  it('initializes with empty usage for all configured providers', () => {
    const tracker = new ProviderTracker({ order: ['codex', 'claude', 'grok'] });
    const statuses = tracker.getAllStatuses();
    assert.equal(statuses.length, 3);
    for (const status of statuses) {
      assert.equal(status.usage.totalTokens, 0);
      assert.equal(status.usage.requestCount, 0);
      assert.equal(status.available, true);
    }
  });

  it('records token usage correctly', () => {
    const tracker = new ProviderTracker();
    tracker.recordUsage('codex', 100, 200);
    tracker.recordUsage('codex', 50, 150);
    const usage = tracker.getUsage('codex');
    assert.equal(usage.inputTokens, 150);
    assert.equal(usage.outputTokens, 350);
    assert.equal(usage.totalTokens, 500);
    assert.equal(usage.requestCount, 2);
    assert.ok(usage.lastUsedAt !== null);
  });

  it('records errors and detects rate limiting', () => {
    const tracker = new ProviderTracker({ cooldownMs: 5000 });
    tracker.recordError('claude', 'rate limit exceeded');
    const usage = tracker.getUsage('claude');
    assert.equal(usage.errorCount, 1);
    assert.equal(usage.rateLimited, true);
    assert.ok(usage.cooldownUntil !== null);
  });

  it('marks provider unavailable during cooldown', () => {
    const tracker = new ProviderTracker({ cooldownMs: 60_000 });
    tracker.recordError('gemini', '429 Too Many Requests');
    assert.equal(tracker.isProviderAvailable('gemini'), false);
  });

  it('makes provider available again after cooldown expires', () => {
    const tracker = new ProviderTracker({ cooldownMs: 1 });
    tracker.recordError('grok', 'quota exceeded');
    // Cooldown is 1ms so it should have expired already
    // Wait a tiny bit to ensure it expires
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    assert.equal(tracker.isProviderAvailable('grok'), true);
  });

  it('returns next available provider skipping excluded', () => {
    const tracker = new ProviderTracker({ order: ['codex', 'claude', 'gemini', 'grok'] });
    const next = tracker.getNextAvailableProvider('codex');
    assert.equal(next, 'claude');
  });

  it('returns next available provider skipping rate-limited ones', () => {
    const tracker = new ProviderTracker({
      order: ['codex', 'claude', 'gemini', 'grok'],
      cooldownMs: 60_000,
    });
    tracker.recordError('claude', 'rate limit');
    const next = tracker.getNextAvailableProvider('codex');
    assert.equal(next, 'gemini');
  });

  it('returns null when all providers exhausted', () => {
    const tracker = new ProviderTracker({
      order: ['codex', 'claude'],
      cooldownMs: 60_000,
    });
    tracker.recordError('codex', 'rate limit');
    tracker.recordError('claude', 'quota exceeded');
    const next = tracker.getNextAvailableProvider();
    assert.equal(next, null);
  });

  it('records failover events', () => {
    const tracker = new ProviderTracker();
    tracker.recordFailover('codex', 'claude', 'rate_limit', 1);
    tracker.recordFailover('claude', 'gemini', 'rate_limit', 2);
    const events = tracker.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].fromProvider, 'codex');
    assert.equal(events[0].toProvider, 'claude');
    assert.equal(events[1].fromProvider, 'claude');
    assert.equal(events[1].toProvider, 'gemini');
  });

  it('resets cooldown for a specific provider', () => {
    const tracker = new ProviderTracker({ cooldownMs: 60_000 });
    tracker.recordError('grok', 'rate limit');
    assert.equal(tracker.isProviderAvailable('grok'), false);
    tracker.resetCooldown('grok');
    assert.equal(tracker.isProviderAvailable('grok'), true);
  });

  it('resets all state', () => {
    const tracker = new ProviderTracker();
    tracker.recordUsage('codex', 100, 200);
    tracker.recordError('claude', 'rate limit');
    tracker.recordFailover('codex', 'claude', 'test', 1);
    tracker.reset();
    assert.equal(tracker.getUsage('codex').totalTokens, 0);
    assert.equal(tracker.getEvents().length, 0);
    assert.equal(tracker.isProviderAvailable('claude'), true);
  });

  it('getAllStatuses returns correct priority ordering', () => {
    const tracker = new ProviderTracker({ order: ['grok', 'claude', 'codex'] });
    const statuses = tracker.getAllStatuses();
    assert.equal(statuses[0].provider, 'grok');
    assert.equal(statuses[0].priority, 1);
    assert.equal(statuses[1].provider, 'claude');
    assert.equal(statuses[1].priority, 2);
    assert.equal(statuses[2].provider, 'codex');
    assert.equal(statuses[2].priority, 3);
  });

  it('handles recording usage for unknown provider gracefully', () => {
    const tracker = new ProviderTracker({ order: ['codex'] });
    tracker.recordUsage('grok', 100, 200);
    const usage = tracker.getUsage('grok');
    assert.equal(usage.totalTokens, 300);
  });
});

describe('isRateLimitError', () => {
  it('detects "rate limit" pattern', () => {
    assert.equal(isRateLimitError('Error: rate limit exceeded'), true);
  });

  it('detects "429" pattern', () => {
    assert.equal(isRateLimitError('HTTP 429 Too Many Requests'), true);
  });

  it('detects "quota exceeded" pattern', () => {
    assert.equal(isRateLimitError('Error: quota exceeded for today'), true);
  });

  it('detects "insufficient_quota" pattern', () => {
    assert.equal(isRateLimitError('insufficient_quota: billing limit reached'), true);
  });

  it('detects "too many requests" pattern', () => {
    assert.equal(isRateLimitError('too many requests, please slow down'), true);
  });

  it('detects "resource exhausted" pattern', () => {
    assert.equal(isRateLimitError('RESOURCE_EXHAUSTED: quota limit'), true);
  });

  it('does not match normal errors', () => {
    assert.equal(isRateLimitError('syntax error in code'), false);
  });

  it('does not match empty string', () => {
    assert.equal(isRateLimitError(''), false);
  });
});
