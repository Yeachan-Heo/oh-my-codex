import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSidecarArgs } from '../index.js';

describe('parseSidecarArgs', () => {
  it('does not consume the next flag when width is missing its value', () => {
    const parsed = parseSidecarArgs(['demo', '--width', '--json']);

    assert.equal(parsed.teamName, 'demo');
    assert.equal(parsed.flags.width, 48);
    assert.equal(parsed.flags.json, true);
  });

  it('does not consume the next flag when interval is missing its value', () => {
    const parsed = parseSidecarArgs(['demo', '--interval-ms', '--watch']);

    assert.equal(parsed.teamName, 'demo');
    assert.equal(parsed.flags.intervalMs, 1000);
    assert.equal(parsed.flags.watch, true);
  });
});
