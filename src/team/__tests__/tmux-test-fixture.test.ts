import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { isRealTmuxAvailable, tmuxSessionExists, withTempTmuxSession } from './tmux-test-fixture.js';

function skipUnlessTmux(t: TestContext): void {
  if (!isRealTmuxAvailable()) {
    t.skip('tmux is not available in this environment');
  }
}

describe('withTempTmuxSession', () => {
  it('provides isolated tmux env and cleans up on success', async (t) => {
    skipUnlessTmux(t);
    const ambientTmuxPane = process.env.TMUX_PANE;
    let sessionName = '';

    await withTempTmuxSession(async (fixture) => {
      sessionName = fixture.sessionName;
      assert.match(fixture.sessionName, /^omx-test-/);
      assert.equal(process.env.TMUX, fixture.env.TMUX);
      assert.equal(process.env.TMUX_PANE, fixture.leaderPaneId);
      assert.equal(fixture.sessionExists(), true);
      if (ambientTmuxPane) {
        assert.notEqual(fixture.leaderPaneId, ambientTmuxPane);
      }
    });

    assert.equal(tmuxSessionExists(sessionName), false);
  });

  it('cleans up when the callback throws', async (t) => {
    skipUnlessTmux(t);
    let sessionName = '';

    await assert.rejects(
      () => withTempTmuxSession(async (fixture) => {
        sessionName = fixture.sessionName;
        throw new Error('fixture boom');
      }),
      /fixture boom/,
    );

    assert.equal(tmuxSessionExists(sessionName), false);
  });
});
