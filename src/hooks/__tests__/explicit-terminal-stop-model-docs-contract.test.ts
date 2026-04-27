import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadSurface } from './prompt-guidance-test-helpers.js';

describe('explicit terminal stop model docs contract', () => {
  it('documents the canonical terminal lifecycle vocabulary', () => {
    const doc = loadSurface('docs/contracts/explicit-terminal-stop-model.md');

    assert.match(doc, /`finished`/);
    assert.match(doc, /`blocked`/);
    assert.match(doc, /`failed`/);
    assert.match(doc, /`userinterlude`/);
    assert.match(doc, /`askuserQuestion`/);
  });

  it('keeps cancelled internal-only and preserves blocked_on_user as a legacy compatibility value', () => {
    const doc = loadSurface('docs/contracts/explicit-terminal-stop-model.md');

    assert.match(doc, /`blocked_on_user` \| compatibility-only user-wait signal/i);
    assert.match(doc, /`cancelled`, `canceled`, `abort`, `aborted` \| internal legacy\/admin stop compatibility only/i);
    assert.match(doc, /It is \*\*not\*\* a canonical user-facing terminal lifecycle outcome/i);
  });

  it('distinguishes userinterlude from askuserQuestion', () => {
    const doc = loadSurface('docs/contracts/explicit-terminal-stop-model.md');

    assert.match(doc, /`userinterlude` \| The user intentionally interrupted or paused the run\./i);
    assert.match(doc, /`askuserQuestion` \| OMX must ask the user a blocking question before safe progress can continue\./i);
    assert.match(doc, /should normally be backed by `omx question`/i);
  });

  it('forbids optional terminal handoff softeners in active workflow outputs', () => {
    const doc = loadSurface('docs/contracts/explicit-terminal-stop-model.md');

    assert.match(doc, /the handoff should be explicit and structured/i);
    assert.match(doc, /If you want, I can/i);
    assert.match(doc, /Would you like me to continue\?/i);
    assert.match(doc, /If you'd like, I can/i);
  });

  it('documents canonical-field precedence over legacy compatibility fields', () => {
    const doc = loadSurface('docs/contracts/explicit-terminal-stop-model.md');

    assert.match(doc, /a dedicated canonical lifecycle field such as `lifecycle_outcome`/i);
    assert.match(doc, /the canonical lifecycle field wins/i);
  });
});
