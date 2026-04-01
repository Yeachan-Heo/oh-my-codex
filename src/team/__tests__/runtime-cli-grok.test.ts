import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentTypes } from '../runtime-cli.js';

describe('normalizeAgentTypes with grok', () => {
  it('accepts grok as valid agent type', () => {
    const result = normalizeAgentTypes(['grok'], 3);
    assert.deepEqual(result, ['grok']);
  });

  it('accepts mixed agent types including grok', () => {
    const result = normalizeAgentTypes(['codex', 'claude', 'grok'], 3);
    assert.deepEqual(result, ['codex', 'claude', 'grok']);
  });

  it('rejects unknown provider names', () => {
    assert.throws(
      () => normalizeAgentTypes(['unknown'], 1),
      /Invalid agentTypes entries: unknown/,
    );
  });

  it('rejects mixed valid and invalid entries', () => {
    assert.throws(
      () => normalizeAgentTypes(['grok', 'fake'], 2),
      /Invalid agentTypes entries: fake/,
    );
  });

  it('validates length must be 1 or workerCount', () => {
    assert.throws(
      () => normalizeAgentTypes(['grok', 'claude'], 3),
      /agentTypes length must be 1 or 3/,
    );
  });

  it('accepts all five providers', () => {
    const result = normalizeAgentTypes(['codex', 'claude', 'gemini', 'grok'], 4);
    assert.deepEqual(result, ['codex', 'claude', 'gemini', 'grok']);
  });
});
