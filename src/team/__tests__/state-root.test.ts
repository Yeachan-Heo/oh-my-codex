import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { resolveCanonicalTeamStateRoot } from '../state-root.js';

describe('state-root', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omx/state', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project'),
      '/tmp/demo/project/.omx/state',
    );
  });
});

