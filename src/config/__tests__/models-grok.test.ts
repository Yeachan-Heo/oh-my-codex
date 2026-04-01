import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getGrokDefaultModel, OMX_DEFAULT_GROK_MODEL } from '../models.js';

describe('getGrokDefaultModel', () => {
  it('returns built-in default when no env var or config', () => {
    const model = getGrokDefaultModel({}, '/tmp/nonexistent-dir-for-test');
    assert.equal(model, OMX_DEFAULT_GROK_MODEL);
  });

  it('respects OMX_DEFAULT_GROK_MODEL env var', () => {
    const model = getGrokDefaultModel(
      { OMX_DEFAULT_GROK_MODEL: 'grok-3-mini' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(model, 'grok-3-mini');
  });

  it('ignores empty env var and returns default', () => {
    const model = getGrokDefaultModel(
      { OMX_DEFAULT_GROK_MODEL: '  ' },
      '/tmp/nonexistent-dir-for-test',
    );
    assert.equal(model, OMX_DEFAULT_GROK_MODEL);
  });

  it('built-in default is grok-3', () => {
    assert.equal(OMX_DEFAULT_GROK_MODEL, 'grok-3');
  });
});
