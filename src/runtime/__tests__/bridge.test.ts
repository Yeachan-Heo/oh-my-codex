import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRuntimeBinaryPath } from '../bridge.js';

describe('resolveRuntimeBinaryPath', () => {
  it('prefers explicit OMX_RUNTIME_BINARY override', () => {
    const previous = process.env.OMX_RUNTIME_BINARY;
    try {
      process.env.OMX_RUNTIME_BINARY = '/custom/runtime';
      const actual = resolveRuntimeBinaryPath({
        debugPath: '/debug/runtime',
        releasePath: '/release/runtime',
        fallbackBinary: 'omx-runtime',
        exists: () => false,
      });
      assert.equal(actual, '/custom/runtime');
    } finally {
      if (typeof previous === 'string') process.env.OMX_RUNTIME_BINARY = previous;
      else delete process.env.OMX_RUNTIME_BINARY;
    }
  });

  it('prefers debug build over release and PATH fallback', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: (candidate) => candidate === '/debug/runtime' || candidate === '/release/runtime',
    });
    assert.equal(actual, '/debug/runtime');
  });

  it('falls back to release build when debug is unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: (candidate) => candidate === '/release/runtime',
    });
    assert.equal(actual, '/release/runtime');
  });

  it('falls back to PATH binary when local builds are unavailable', () => {
    const actual = resolveRuntimeBinaryPath({
      debugPath: '/debug/runtime',
      releasePath: '/release/runtime',
      fallbackBinary: 'omx-runtime',
      exists: () => false,
    });
    assert.equal(actual, 'omx-runtime');
  });
});
