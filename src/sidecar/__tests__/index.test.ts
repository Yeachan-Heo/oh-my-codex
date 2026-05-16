import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSidecarArgs } from '../index.js';

describe('parseSidecarArgs', () => {
  it('parses positive integer width and interval flags', () => {
    assert.deepEqual(parseSidecarArgs(['demo', '--width=64', '--interval-ms', '250']), {
      teamName: 'demo',
      flags: { json: false, watch: false, tmux: false, width: 64, intervalMs: 250 },
    });
  });

  it('ignores numeric flags with trailing junk', () => {
    assert.deepEqual(parseSidecarArgs(['demo', '--width=64px', '--interval-ms=250ms']), {
      teamName: 'demo',
      flags: { json: false, watch: false, tmux: false, width: 48, intervalMs: 1000 },
    });
  });
});
