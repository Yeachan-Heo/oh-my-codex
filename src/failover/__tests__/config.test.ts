import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadFailoverConfig } from '../config.js';

describe('loadFailoverConfig', () => {
  it('returns defaults when no env vars or config file', () => {
    const config = loadFailoverConfig({}, '/tmp/nonexistent-dir-for-test');
    assert.equal(config.enabled, true);
    assert.deepEqual(config.order, ['codex', 'claude', 'gemini', 'qwen', 'grok']);
    assert.equal(config.cooldownMs, 60_000);
    assert.equal(config.maxRetries, 3);
  });

  it('respects OMX_FAILOVER_ENABLED=0', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ENABLED: '0' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.enabled, false);
  });

  it('respects OMX_FAILOVER_ENABLED=true', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ENABLED: 'true' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.enabled, true);
  });

  it('respects OMX_FAILOVER_ORDER', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ORDER: 'grok,claude,codex' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.deepEqual(config.order, ['grok', 'claude', 'codex']);
  });

  it('filters invalid providers from OMX_FAILOVER_ORDER', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ORDER: 'grok,invalid,claude' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.deepEqual(config.order, ['grok', 'claude']);
  });

  it('respects OMX_FAILOVER_COOLDOWN_MS', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_COOLDOWN_MS: '30000' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.cooldownMs, 30_000);
  });

  it('respects OMX_FAILOVER_MAX_RETRIES', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_MAX_RETRIES: '5' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.maxRetries, 5);
  });

  it('ignores invalid OMX_FAILOVER_COOLDOWN_MS values', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_COOLDOWN_MS: 'abc' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.cooldownMs, 60_000);
  });

  it('ignores negative OMX_FAILOVER_MAX_RETRIES', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_MAX_RETRIES: '-1' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.maxRetries, 3);
  });

  it('handles OMX_FAILOVER_ENABLED=false', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ENABLED: 'false' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(config.enabled, false);
  });

  it('falls back to defaults for empty OMX_FAILOVER_ORDER', () => {
    const config = loadFailoverConfig(
      { OMX_FAILOVER_ORDER: '' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.deepEqual(config.order, ['codex', 'claude', 'gemini', 'qwen', 'grok']);
  });
});
