import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertInteractiveTmuxPrereqs } from '../runtime.js';

describe('assertInteractiveTmuxPrereqs', () => {
  it('accepts interactive startup when tmux context is already active', () => {
    assert.doesNotThrow(() => assertInteractiveTmuxPrereqs(true, false));
    assert.doesNotThrow(() => assertInteractiveTmuxPrereqs(true, true));
  });

  it('throws missing-tmux error when no context and tmux probe is unavailable', () => {
    assert.throws(
      () => assertInteractiveTmuxPrereqs(false, false),
      /Team mode requires tmux\. Install with: apt install tmux \/ brew install tmux/,
    );
  });

  it('throws inside-tmux error when tmux exists but no active client context', () => {
    assert.throws(
      () => assertInteractiveTmuxPrereqs(false, true),
      /Team mode requires running inside tmux current leader pane/,
    );
  });
});
