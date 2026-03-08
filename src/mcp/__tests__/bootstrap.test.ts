import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoStartMcpServer } from '../bootstrap.js';

describe('mcp bootstrap auto-start guard', () => {
  it('allows auto-start by default', () => {
    assert.equal(shouldAutoStartMcpServer('state', {}), true);
    assert.equal(shouldAutoStartMcpServer('memory', {}), true);
    assert.equal(shouldAutoStartMcpServer('code_intel', {}), true);
    assert.equal(shouldAutoStartMcpServer('trace', {}), true);
  });

  it('disables all servers when global disable flag is set', () => {
    const env = { OMX_MCP_SERVER_DISABLE_AUTO_START: '1' };
    assert.equal(shouldAutoStartMcpServer('state', env), false);
    assert.equal(shouldAutoStartMcpServer('memory', env), false);
    assert.equal(shouldAutoStartMcpServer('code_intel', env), false);
    assert.equal(shouldAutoStartMcpServer('trace', env), false);
  });

  it('disables per-server using server-specific flags', () => {
    assert.equal(shouldAutoStartMcpServer('state', { OMX_STATE_SERVER_DISABLE_AUTO_START: '1' }), false);
    assert.equal(shouldAutoStartMcpServer('memory', { OMX_MEMORY_SERVER_DISABLE_AUTO_START: '1' }), false);
    assert.equal(shouldAutoStartMcpServer('code_intel', { OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START: '1' }), false);
    assert.equal(shouldAutoStartMcpServer('trace', { OMX_TRACE_SERVER_DISABLE_AUTO_START: '1' }), false);
  });
});

