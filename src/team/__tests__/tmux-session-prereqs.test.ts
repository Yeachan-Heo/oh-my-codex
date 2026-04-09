import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertCreateTeamSessionPrereqs } from '../tmux-session.js';

describe('assertCreateTeamSessionPrereqs', () => {
  it('accepts team session startup when tmux context is already active', () => {
    assert.doesNotThrow(() => assertCreateTeamSessionPrereqs(true, false));
    assert.doesNotThrow(() => assertCreateTeamSessionPrereqs(true, true));
  });

  it('throws tmux-unavailable error when neither context nor tmux probe is available', () => {
    assert.throws(
      () => assertCreateTeamSessionPrereqs(false, false),
      /tmux is not available/i,
    );
  });

  it('throws tmux-context error when tmux exists but no active leader context is present', () => {
    assert.throws(
      () => assertCreateTeamSessionPrereqs(false, true),
      /team mode requires running inside tmux leader pane/i,
    );
  });
});
