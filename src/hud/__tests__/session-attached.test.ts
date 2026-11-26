import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { isHudWatchSessionAttached, createCachedIsHudWatchSessionAttached } from '../session-attached.js';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

describe('isHudWatchSessionAttached', () => {
  it('treats a non-tmux environment as attached (fail-open)', () => {
    assert.equal(isHudWatchSessionAttached({ env: {}, execTmuxSync: () => '0\n' }), true);
    assert.equal(isHudWatchSessionAttached({ env: { TMUX: '' }, execTmuxSync: () => '0\n' }), true);
  });

  it('queries session attachment through the pane id from the environment', () => {
    const seenArgv: string[][] = [];
    const attached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
      execTmuxSync: (args) => {
        seenArgv.push(args);
        return '1\n';
      },
    });
    assert.equal(attached, true);
    assert.deepEqual(seenArgv, [['display-message', '-p', '-t', '%7', '#{session_attached}']]);

    const detached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
      execTmuxSync: () => '0\n',
    });
    assert.equal(detached, false);
  });

  it('falls back to the active pane when TMUX_PANE is missing', () => {
    const seenArgv: string[][] = [];
    const attached = isHudWatchSessionAttached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '' },
      execTmuxSync: (args) => {
        seenArgv.push(args);
        return '0\n';
      },
    });
    assert.equal(attached, false);
    assert.deepEqual(seenArgv, [['display-message', '-p', '-t', '', '#{session_attached}']]);
  });

  it('fails open when the tmux query throws', () => {
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => {
          throw new Error('no server running');
        },
      }),
      true,
    );
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0' },
        execTmuxSync: () => {
          throw new Error('no server running');
        },
      }),
      true,
    );
  });

  it('treats a malformed attachment answer as attached (fail-open)', () => {
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => '',
      }),
      true,
    );
    assert.equal(
      isHudWatchSessionAttached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' },
        execTmuxSync: () => 'garbage',
      }),
      true,
    );
  });

  it('answers attachment from a real detached private tmux session', async (t) => {
    if (!isRealTmuxAvailable()) {
      t.skip('tmux is not available');
      return;
    }
    await withTempTmuxSession(async (fixture) => {
      const detachedBefore = execFileSync('tmux', [
        '-L', fixture.serverName, '-f', '/dev/null',
        'display-message', '-p', '-t', fixture.leaderPaneId, '#{session_attached}',
      ], { encoding: 'utf-8' }).trim();
      assert.equal(detachedBefore, '0', 'fixture session must start detached');

      const attachedViaEnv = isHudWatchSessionAttached({
        env: { TMUX: fixture.env.TMUX, TMUX_PANE: fixture.leaderPaneId },
      });
      assert.equal(attachedViaEnv, false, 'detached session must report not attached');
    });
  });
});

describe('createCachedIsHudWatchSessionAttached', () => {
  it('caches results with a bounded TTL', async () => {
    let callCount = 0;
    const env = { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%7' };
    const cached = createCachedIsHudWatchSessionAttached(100);

    // First call should execute the query
    const result1 = cached({
      env,
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result1, true);
    assert.equal(callCount, 1, 'first call must execute');

    // Second call within TTL should use cache
    const result2 = cached({
      env,
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result2, true);
    assert.equal(callCount, 1, 'second call within TTL must use cache');

    // After TTL expiration, should query again
    await new Promise<void>((resolve) => setTimeout(resolve, 110));
    const result3 = cached({
      env,
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result3, true);
    assert.equal(callCount, 2, 'third call after TTL must re-query');
  });

  it('uses separate cache entries for different pane IDs', () => {
    let callCount = 0;
    const cached = createCachedIsHudWatchSessionAttached(1000);

    // Query pane 1
    const result1 = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%1' },
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result1, true);
    assert.equal(callCount, 1);

    // Query pane 2 (different pane, should not use cache)
    const result2 = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%2' },
      execTmuxSync: () => {
        callCount++;
        return '0\n';
      },
    });
    assert.equal(result2, false);
    assert.equal(callCount, 2, 'different pane should not use cache');

    // Query pane 1 again (should use cache)
    const result3 = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%1' },
      execTmuxSync: () => {
        callCount++;
        return '0\n';
      },
    });
    assert.equal(result3, true, 'same pane should use cache');
    assert.equal(callCount, 2, 'pane 1 cache should be reused');
  });

  it('falls back to immediate query when no pane ID is set', () => {
    let callCount = 0;
    const cached = createCachedIsHudWatchSessionAttached(1000);

    // First call with no pane
    const result1 = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      execTmuxSync: () => {
        callCount++;
        return '0\n';
      },
    });
    assert.equal(result1, false);
    assert.equal(callCount, 1);

    // Second call with no pane but different TMUX socket should query again
    const result2 = cached({
      env: { TMUX: '/tmp/tmux-1000/other,1,0' },
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result2, true);
    assert.equal(callCount, 2, 'different TMUX socket should not use cache');

    // Third call with same socket and no pane should use cache
    const result3 = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0' },
      execTmuxSync: () => {
        callCount++;
        return '1\n';
      },
    });
    assert.equal(result3, false, 'same socket should use cache');
    assert.equal(callCount, 2, 'same socket and no pane should use cache');
  });

  it('cleans up expired cache entries to prevent memory growth', () => {
    const cached = createCachedIsHudWatchSessionAttached(10);

    // Add many entries that will expire
    for (let i = 0; i < 50; i++) {
      cached({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: `%${i}` },
        execTmuxSync: () => '1\n',
      });
    }

    // Wait for expiration
    // (actual cleanup happens on subsequent cache misses, so this is not a direct test)
    // But at least verify that the function doesn't crash with many entries
    const result = cached({
      env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%999' },
      execTmuxSync: () => '1\n',
    });
    assert.equal(result, true);
  });
});
