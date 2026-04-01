import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getProviderDisplayInfo, formatProvidersTable } from '../providers.js';

describe('providers command', () => {
  it('returns info for all five providers', () => {
    const infos = getProviderDisplayInfo({});
    assert.equal(infos.length, 5);
    const names = infos.map((i) => i.provider);
    assert.ok(names.includes('codex'));
    assert.ok(names.includes('claude'));
    assert.ok(names.includes('gemini'));
    assert.ok(names.includes('qwen'));
    assert.ok(names.includes('grok'));
  });

  it('detects missing API keys', () => {
    const infos = getProviderDisplayInfo({});
    // Without any env vars set, all API keys should be missing
    for (const info of infos) {
      assert.equal(info.apiKeySet, false);
    }
  });

  it('detects API key when set', () => {
    const infos = getProviderDisplayInfo({ XAI_API_KEY: 'test-key' });
    const grok = infos.find((i) => i.provider === 'grok');
    assert.ok(grok);
    assert.equal(grok.apiKeySet, true);
  });

  it('formatProvidersTable returns non-empty string', () => {
    const infos = getProviderDisplayInfo({});
    const table = formatProvidersTable(infos);
    assert.ok(table.length > 0);
    assert.ok(table.includes('Provider'));
    assert.ok(table.includes('Priority'));
    assert.ok(table.includes('codex'));
    assert.ok(table.includes('grok'));
  });

  it('formatProvidersTable shows failover status', () => {
    const infos = getProviderDisplayInfo({ OMX_FAILOVER_ENABLED: '1' });
    const table = formatProvidersTable(infos);
    assert.ok(table.includes('Failover:'));
  });
});
