import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  buildDetachedSessionRollbackSteps,
  cleanupDetachedPreReportSession,
  cleanupDetachedPreReportSessionForTest,
  cleanupDetachedLeaderSessionAfterFailureForTest,
  detachedLeaderFailureErrorForTest,
  DetachedLaunchSafetyError,
  isDetachedFailedReportAuthorizedForTest,
  isDetachedReadyReportAuthorized,
  isDetachedSessionPointerAbortCarried,
  reportDetachedSessionPointerGuidance,
  resolveDetachedLeaderPaneForTest,
  type DetachedBootstrapReport,
} from '../index.js';
import { isRealTmuxAvailable, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

function skipUnlessTmux(t: TestContext): boolean {
  if (process.platform === 'win32') {
    t.skip('detached tmux leader tests are not supported on win32');
    return false;
  }
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for #3578 detached diagnostics tests');
  t.skip('tmux is not installed');
  return false;
}

const emptyReport = (): DetachedBootstrapReport => ({ transitions: ['D0'], rollback: { attempted: [], failures: [] } });

describe('#3578 detached launch diagnostics', () => {
  describe('Windows detached leader identity', () => {
    it('accepts an inherited pane when the tmux session id differs from the OMX session id', () => {
      assert.equal(resolveDetachedLeaderPaneForTest({
        sessionName: 'omx-session',
        inheritedPane: '%42',
        platform: 'win32',
        leaderPid: 901,
        requireInheritedPane: false,
        identityOutput: 'omx-session\t$7\t%42',
        paneSnapshot: '%42\t0\t901',
      }), '%42');
      assert.throws(() => resolveDetachedLeaderPaneForTest({
        sessionName: 'omx-session',
        expectedTmuxSessionId: '$1',
        inheritedPane: '%42',
        platform: 'win32',
        leaderPid: 901,
        requireInheritedPane: false,
        identityOutput: 'omx-session\t$7\t%42',
        paneSnapshot: '%42\t0\t901',
      }), /inherited pane identity is unavailable/);
    });

    it('authorizes Windows ready and failed reports by pane identity when process PIDs differ', () => {
      const expected = {
        nonce: 'windows-nonce',
        sessionId: 'omx-session-id',
        sessionName: 'omx-session',
        shouldAttach: true,
        leaderPaneId: '%42',
        leaderPanePid: 901,
      };
      const ready = { version: 1 as const, kind: 'ready' as const, ...expected, paneId: '%42', leaderPid: 1201 };
      const failed = { version: 1 as const, kind: 'failed' as const, ...expected, paneId: '%42', leaderPid: 1201 };
      assert.equal(isDetachedReadyReportAuthorized(ready, expected, 'win32'), true);
      assert.equal(isDetachedReadyReportAuthorized(ready, expected, 'linux'), false);
      assert.equal(isDetachedFailedReportAuthorizedForTest(failed, expected, 'win32'), true);
      assert.equal(isDetachedFailedReportAuthorizedForTest(failed, expected, 'linux'), false);
      assert.equal(isDetachedFailedReportAuthorizedForTest({ ...failed, paneId: '%43' }, expected, 'win32'), false);
    });
  });

  describe('exact failing-step and cause reporting', () => {
    it('carries the exact bootstrap step name next to the coarse phase', () => {
      const cause = new Error('leader authority blocked tmux mutation history-limit');
      const stepError = new DetachedLaunchSafetyError('pane-id', cause, emptyReport(), 'tag-session');
      assert.equal(stepError.step, 'tag-session');
      assert.match(stepError.message, /during pane-id \(tag-session\)/);
      assert.match(stepError.message, /history-limit/);
      // The state machine's rewrap preserves the step across propagation.
      const rewrapped = new DetachedLaunchSafetyError(stepError.phase, stepError.cause, emptyReport(), stepError.step);
      assert.equal(rewrapped.step, 'tag-session');
    });

    it('keeps distinct step names for post-new-session mutations that previously collapsed into pane-id', () => {
      for (const step of ['tag-session', 'split-and-capture-hud-pane', 'register-resize-hook', 'schedule-delayed-resize']) {
        const error = new DetachedLaunchSafetyError('pane-id', new Error('boom'), emptyReport(), step);
        assert.equal(error.step, step);
        assert.match(error.message, new RegExp(`\\(${step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
      }
      // new-session keeps the legacy inert-session phase and needs no step suffix.
      const inert = new DetachedLaunchSafetyError('inert-session', new Error('no pane id'), emptyReport(), 'new-session');
      assert.match(inert.message, /during inert-session \(new-session\)/);
    });

    it('renders the step only when it differs from the phase', () => {
      const withoutStep = new DetachedLaunchSafetyError('completion', new Error('timed out'), emptyReport());
      assert.equal(withoutStep.step, undefined);
      assert.doesNotMatch(withoutStep.message, /\(/);
      const report = JSON.parse(`{"phase":"pane-id","step":"split-and-capture-hud-pane","failure":"boom"}`);
      assert.equal(report.step, 'split-and-capture-hud-pane');
    });
  });

  describe('bounded abort-code propagation through AggregateError', () => {
    it('rebuilds the bounded abort marker from a validated failed report', () => {
      const carried = detachedLeaderFailureErrorForTest({
        error: 'Session pointer sess-live-owner conflicts with an active session; launch aborted',
        abortCode: 'session_pointer_owner_conflict',
      });
      assert.equal(isDetachedSessionPointerAbortCarried(carried), true);
      assert.equal((carried as { code?: string }).code, 'session_pointer_owner_conflict');

      const plain = detachedLeaderFailureErrorForTest({ error: 'detached leader setup failed' });
      assert.equal(isDetachedSessionPointerAbortCarried(plain), false);
    });

    it('finds the abort marker inside the D2 AggregateError wrap', () => {
      // executeDetachedLaunchStateMachine wraps completion failures as
      // AggregateError([leaderError]) before the outer launcher sees them.
      const leaderError = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_unusable' });
      const wrapped = new AggregateError([leaderError], 'preLaunch session-instructions failed: unusable');
      assert.equal(isDetachedSessionPointerAbortCarried(wrapped), true);
      // Negative: ordinary nested errors never carry the marker.
      assert.equal(isDetachedSessionPointerAbortCarried(new AggregateError([new Error('x')], 'y')), false);
      assert.equal(isDetachedSessionPointerAbortCarried(new Error('session_pointer_owner_conflict')), false);
    });
  });

  describe('detached session-pointer guidance', () => {
    it('does not advise creating a separate root for an existing resume owner conflict', () => {
      const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_owner_conflict' });
      const captured: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => { captured.push(String(chunk)); return true; };
      try { reportDetachedSessionPointerGuidance(carried, '/tmp', true); }
      finally { (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite; }
      assert.match(captured.join(''), /resume conflicts with an existing OMX runtime owner/);
      assert.doesNotMatch(captured.join(''), /POSIX: OMX_ROOT/);
    });

    it('provides bounded recovery diagnostics for a resume stale pointer', () => {
      const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_unusable' });
      const captured: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => { captured.push(String(chunk)); return true; };
      try { reportDetachedSessionPointerGuidance(carried, '/tmp', true); }
      finally { (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite; }
      assert.match(captured.join(''), /session pointer recover/);
      assert.match(captured.join(''), /Do not delete the pointer/);
    });
    it('prints the ordinary OMX_ROOT guidance for a carried owner conflict, gated on cwd-default', () => {
      const wd = mkdtempSync(join(tmpdir(), 'omx-3578-guidance-'));
      const cwd = join(wd, 'checkout');
      try {
        const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_owner_conflict' });
        const wrapped = new AggregateError([carried], 'preLaunch session-instructions failed');
        const captured: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
          captured.push(String(chunk));
          return true;
        };
        try {
          reportDetachedSessionPointerGuidance(wrapped, cwd);
        } finally {
          (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite;
        }
        const output = captured.join('');
        assert.match(output, /concurrent conversations in this checkout require distinct user-specified OMX_ROOT values/);
        assert.match(output, /POSIX: OMX_ROOT="\$HOME\/\.omx\/instances\/second-conversation" omx/);
        assert.match(output, /OMX does not reroute or allocate one automatically/);
      } finally {
        rmSync(wd, { recursive: true, force: true });
      }
    });

    it('points stale/unusable pointers at doctor instead of OMX_ROOT rerouting', () => {
      const carried = detachedLeaderFailureErrorForTest({ abortCode: 'session_pointer_unusable' });
      const captured: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        captured.push(String(chunk));
        return true;
      };
      try {
        reportDetachedSessionPointerGuidance(carried, '/tmp');
      } finally {
        (process.stderr as { write: (chunk: string) => boolean }).write = originalWrite;
      }
      const output = captured.join('');
      assert.match(output, /run `omx doctor` for the exact pointer status/);
      assert.doesNotMatch(output, /distinct user-specified OMX_ROOT/);
      // Negative: an ordinary detached failure prints no pointer guidance at all.
      captured.length = 0;
      const restore = process.stderr.write.bind(process.stderr);
      (process.stderr as { write: (chunk: string) => boolean }).write = (chunk: string) => {
        captured.push(String(chunk));
        return true;
      };
      try {
        reportDetachedSessionPointerGuidance(new Error('detached leader readiness timed out'), '/tmp');
      } finally {
        (process.stderr as { write: (chunk: string) => boolean }).write = restore;
      }
      assert.equal(captured.length, 0);
    });
  });

  describe('identity-fenced cleanup when the leader pane is absent', () => {
    it('lets a failed leader clean its exact owned session after the parent exits', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-leader-owned-failure-cleanup';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'leader-failure-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        cleanupDetachedLeaderSessionAfterFailureForTest(authority, authority.ownerId);
        const sessions = fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n');
        assert.equal(sessions.includes(sessionName), false, 'failed leader must clean its exact owned session');
        assert.equal(sessions.includes(foreignSessionName), true, 'failed leader cleanup must not touch unrelated sessions');
      });
    });

    it('rejects empty ownership after the tag phase was attempted', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-owner-phase-fence';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-phase-fence');
        fixture.run(['set-option', '-t', sessionName, '@omx_detached_owner_tag_attempted', '1']);
        cleanupDetachedLeaderSessionAfterFailureForTest(authority, authority.ownerId);
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'empty owner after tag attempt must preserve');
      });
    });

    it('rechecks the tag-attempt marker inside the destructive predicate', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-owner-phase-interposition';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-phase-interposition');
        cleanupDetachedLeaderSessionAfterFailureForTest(authority, authority.ownerId, () => {
          // Simulate tag-session completing after any earlier observation but
          // before the single queued destructive predicate evaluates.
          fixture.run(['set-option', '-t', sessionName, '@omx_detached_owner_tag_attempted', '1']);
        });
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'same-command marker recheck must preserve');
      });
    });

    interface SessionAuthority {
      paneId: string;
      panePid: number;
      sessionName: string;
      sessionId: string;
      sessionCreated: string;
      windowId: string;
      windowIndex: string;
      ownerId: string;
    }

    const captureSession = (fixture: { run: (args: string[]) => string }, sessionName: string, ownerId: string): SessionAuthority => {
      const [paneId, panePidRaw, , sessionId, sessionCreated, windowIndex, windowId] = fixture.run([
        'list-panes', '-t', sessionName, '-F',
        '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_index}\t#{window_id}',
      ]).trim().split('\t');
      assert.ok(paneId && panePidRaw && sessionId && sessionCreated && windowId);
      return {
        paneId: paneId!,
        panePid: Number(panePidRaw),
        sessionName,
        sessionId: sessionId!,
        sessionCreated: sessionCreated!,
        windowIndex: (windowIndex ?? '0')!,
        windowId: windowId!,
        ownerId,
      };
    };

    it('cleans up through the session fence after a normal leader exit removed the pane', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-leader-gone';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const hudPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300',
        ]);
        const authority = captureSession(fixture, sessionName, 'owner-3578-a');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        // Normal leader exit with remain-on-exit off removes the leader pane; the
        // HUD-only session is exactly the leak #3578 reports.
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(
          fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(authority.paneId),
          false,
          'fixture must reproduce the removed-leader-pane topology',
        );
        assert.equal(fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(hudPaneId!), true);
        cleanupDetachedPreReportSession(authority);
        await new Promise((resolve) => setTimeout(resolve, 300));
        // has-session exits 1 once the exact owned session is destroyed: the
        // leak #3578 reported is its continued survival, so non-zero is the pass.
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), false, 'the exact owned HUD-only session must be destroyed');
      });
    });

    it('cleans a retained dead leader before the session owner tag is installed', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-pre-tag-retained';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const hudPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300',
        ]);
        const authority = captureSession(fixture, sessionName, 'pre-tag-owner');
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(
          fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']),
          '1',
          'the retained dead leader must reproduce the pre-tag rollback topology',
        );
        assert.equal(
          fixture.run(['display-message', '-p', '-t', sessionName, '#{@omx_instance_id}']).trim(),
          '',
          'the pre-tag fixture must not install an owner tag',
        );
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        cleanupDetachedPreReportSession(authority, true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), false, 'the exact pre-tag session must be destroyed');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(foreignSessionName), true, 'the unrelated session must survive');
        assert.equal(fixture.run(['list-panes', '-s', '-t', foreignSessionName, '-F', '#{pane_id}']).includes(hudPaneId), false);
      });
    });

    it('refuses cleanup when a replacement session reuses the exact session name (negative identity race)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-reuse-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const authority = captureSession(fixture, sessionName, 'owner-3578-b');
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        // Race: a replacement session takes the same name with different
        // session_id/session_created before cleanup runs, while the original
        // session is still in the pre-tag owner-unset state.
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        assert.throws(
          () => cleanupDetachedPreReportSession(authority, true),
          /topology changed before cleanup/,
          'a name-reusing replacement session must never be killed',
        );
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'the replacement session must survive');
      });
    });

    it('refuses cleanup when the session identity matches but the owner tag is foreign (negative identity)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-foreign-owner';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        // A surviving HUD pane keeps the session alive after the leader pane is
        // gone, so cleanup must route through the session fence and be refused
        // there by the foreign owner tag.
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-3578-c');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'foreign-owner']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'a foreign owner tag must fail the session fence closed',
        );
        // The HUD-only session is deliberately preserved: identity could not be proven.
        const survivors = fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).trim().split('\n').filter(Boolean);
        assert.equal(survivors.length > 0, true, 'the unproven session must be preserved');
      });
    });

    it('refuses cleanup when a tagged session loses ownership before rollback (post-tag unset)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-post-tag-unset';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'post-tag-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        fixture.run(['set-option', '-u', '-t', sessionName, '@omx_instance_id']);
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'an owner tag removed after tag-session must not be treated as pre-tag state',
        );
        const sessions = fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n');
        assert.equal(sessions.includes(sessionName), true, 'the unowned exact session must survive');
        assert.equal(sessions.includes(foreignSessionName), true, 'the unrelated session must survive');
      });
    });

    it('keeps the rollback step builder targeting the named session only', () => {
      const steps = buildDetachedSessionRollbackSteps('omx-3578-target', null, null, null);
      const kill = steps.find((step) => step.name === 'kill-session');
      assert.ok(kill);
      assert.deepEqual(kill.args, ['kill-session', '-t', 'omx-3578-target']);
    });

    it('preserves without mutation when the exact session disappears before cleanup (destroyed session)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-destroyed';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-destroyed');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        fixture.run(['kill-session', '-t', sessionName]);
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'destroyed exact session must fail closed without mutation',
        );
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'replacement-after-destroy']);
        assert.throws(
          () => cleanupDetachedPreReportSession(authority),
          /topology changed before cleanup/,
          'replacement after destroyed session must never be killed',
        );
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'replacement session must survive');
      });
    });

    it('preserves the exact session when ownership drifts after the topology probe and before cleanup (race)', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-probe-sink-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        const hudPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300',
        ]);
        const authority = captureSession(fixture, sessionName, 'owner-race');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(
          fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']),
          '1',
          'the captured leader pane must be retained dead so the old pane sink would be eligible',
        );
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        assert.throws(
          () => cleanupDetachedPreReportSessionForTest(authority, () => {
            // This callback is the deterministic interposition point between
            // detachedPreReportLeaderPaneState and the destructive sink.
            fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'foreign-race-owner']);
          }),
          /topology changed before cleanup/,
          'ownership drift in the exact probe-to-sink interval must fail closed',
        );
        assert.equal(fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(hudPaneId), true, 'HUD pane must survive race');
        assert.equal(fixture.run(['list-panes', '-s', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(authority.paneId), true, 'leader pane must survive race');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'HUD session must survive race');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(foreignSessionName), true, 'unrelated session must survive race');
      });
    });

    it('preserves the session when authenticated readiness arrives at the destructive boundary', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-ready-handoff-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'ready-handoff-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        assert.equal(fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']), '0');
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        let lateReadyReport: {
          version: 1;
          kind: 'ready';
          nonce: string;
          sessionId: string;
          sessionName: string;
          paneId: string;
          leaderPid: number;
        } | undefined;
        const expected = {
          nonce: 'ready-handoff-nonce',
          sessionId: authority.sessionId,
          sessionName,
          shouldAttach: false,
          leaderPaneId: authority.paneId,
          leaderPanePid: authority.panePid,
        };
        const cleanupStartedAt = Date.now();
        cleanupDetachedPreReportSessionForTest(
          authority,
          () => {},
          false,
          () => false,
          () => {
            // Completion has already read false. A valid ready report lands
            // after that read; the live-pane branch must preserve immediately
            // without entering the failed-report retry wait.
            lateReadyReport = {
              version: 1,
              kind: 'ready',
              nonce: expected.nonce,
              sessionId: expected.sessionId,
              sessionName: expected.sessionName,
              paneId: authority.paneId,
              leaderPid: authority.panePid,
            };
          },
        );
        assert.ok(Date.now() - cleanupStartedAt < 1_000, 'ordinary timeout must not wait for failed-report retry');
        assert.equal(isDetachedReadyReportAuthorized(lateReadyReport, expected), true, 'the late report must be authenticated');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'ready session must survive');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(foreignSessionName), true, 'unrelated session must survive');
      });
    });

    it('keeps timeout rollback nonblocking and lets the leader clean a later authenticated failure', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-late-failure-async';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 3']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'late-failure-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        const expected = {
          nonce: 'late-failure-nonce',
          sessionId: authority.sessionId,
          sessionName,
          leaderPaneId: authority.paneId,
          leaderPanePid: authority.panePid,
        };
        let failedReport: {
          version: 1;
          kind: 'failed';
          nonce: string;
          sessionId: string;
          sessionName: string;
          paneId: string;
          leaderPid: number;
        } | undefined;
        const timeoutStartedAt = Date.now();
        cleanupDetachedPreReportSessionForTest(authority, () => {}, false, () => false);
        assert.ok(Date.now() - timeoutStartedAt < 1_000, 'plain timeout must return without synchronous retry wait');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true);
        setTimeout(() => {
          failedReport = {
            version: 1,
            kind: 'failed',
            nonce: expected.nonce,
            sessionId: expected.sessionId,
            sessionName,
            paneId: authority.paneId,
            leaderPid: authority.panePid,
          };
          cleanupDetachedLeaderSessionAfterFailureForTest(authority, authority.ownerId);
        }, 100);
        for (let attempt = 0; attempt < 100 && fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(isDetachedFailedReportAuthorizedForTest(failedReport, expected, 'linux'), true, 'late failure must be authenticated');
        const sessions = fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n');
        assert.equal(sessions.includes(sessionName), false, 'the leader-owned late-failed session must be cleaned');
        assert.equal(sessions.includes(foreignSessionName), true, 'the unrelated session must survive');
      });
    });

    it('retries cleanup after an authenticated failed report while the leader is still live', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-failed-live-retry';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'failed-live-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        assert.equal(fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']), '0');
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        let failedReport: {
          version: 1;
          kind: 'failed';
          nonce: string;
          sessionId: string;
          sessionName: string;
          paneId: string;
          leaderPid: number;
        } | undefined;
        const failedExpected = {
          nonce: 'failed-live-nonce',
          sessionId: authority.sessionId,
          sessionName,
          leaderPaneId: authority.paneId,
          leaderPanePid: authority.panePid,
        };
        cleanupDetachedPreReportSessionForTest(
          authority,
          () => {
            // The authenticated failed report is observable before the leader
            // exits. Cleanup must retain responsibility instead of returning
            // success and deleting the marker.
            failedReport = {
              version: 1,
              kind: 'failed',
              nonce: failedExpected.nonce,
              sessionId: failedExpected.sessionId,
              sessionName: failedExpected.sessionName,
              paneId: authority.paneId,
              // Native Windows reports the spawned Node PID, not the
              // PowerShell-owned tmux pane PID.
              leaderPid: authority.panePid + 1,
            };
          },
          false,
          () => false,
          undefined,
          true,
          () => isDetachedFailedReportAuthorizedForTest(failedReport, failedExpected, 'win32'),
        );
        assert.equal(isDetachedFailedReportAuthorizedForTest(failedReport, failedExpected, 'win32'), true);
        assert.equal(isDetachedFailedReportAuthorizedForTest(failedReport, failedExpected, 'linux'), false);
        const sessions = fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n');
        assert.equal(sessions.includes(sessionName), false, 'the exact failed session must be cleaned after leader exit');
        assert.equal(sessions.includes(foreignSessionName), true, 'the unrelated session must survive retry');
      });
    });

    it('preserves a respawned leader when its pane is revived after the dead-pane probe', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-respawn-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'respawn-race-owner');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']), '1');
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);
        let lateReadyReport: {
          version: 1;
          kind: 'ready';
          nonce: string;
          sessionId: string;
          sessionName: string;
          paneId: string;
          leaderPid: number;
        } | undefined;
        const expected = {
          nonce: 'respawn-race-nonce',
          sessionId: authority.sessionId,
          sessionName,
          shouldAttach: false,
          leaderPaneId: authority.paneId,
          leaderPanePid: authority.panePid,
        };
        assert.throws(
          () => cleanupDetachedPreReportSessionForTest(
            authority,
            () => {
              // respawn-pane retains the captured pane id but changes its
              // process identity only after the non-atomic dead-pane probe.
              fixture.run(['respawn-pane', '-k', '-t', authority.paneId, 'sleep 300']);
            },
            false,
            () => {
              assert.equal(lateReadyReport, undefined);
              return false;
            },
            () => {
              const respawnedPid = Number(fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_pid}']));
              lateReadyReport = {
                version: 1,
                kind: 'ready',
                nonce: expected.nonce,
                sessionId: expected.sessionId,
                sessionName: expected.sessionName,
                paneId: authority.paneId,
                leaderPid: respawnedPid,
              };
            },
          ),
          /topology changed before cleanup/,
          'a respawned pane with a changed PID must fail closed',
        );
        assert.equal(isDetachedReadyReportAuthorized(lateReadyReport, expected), true, 'the respawned ready report must still be pane-authenticated');
        const sessions = fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n');
        assert.equal(sessions.includes(sessionName), true, 'the respawned live session must survive');
        assert.equal(sessions.includes(foreignSessionName), true, 'the unrelated session must survive');
      });
    });

    it('preserves a replacement session when the captured leader disappears and its name is reused after the probe', async (t) => {
      if (!skipUnlessTmux(t)) return;
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-3578-disappear-reuse-race';
        fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 5']);
        fixture.run(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, 'sleep 300']);
        const authority = captureSession(fixture, sessionName, 'owner-disappear-reuse');
        fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', authority.ownerId]);
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        await new Promise((resolve) => setTimeout(resolve, 5_500));
        assert.equal(
          fixture.run(['display-message', '-p', '-t', authority.paneId, '#{pane_dead}']),
          '1',
          'the captured leader pane must be dead before the interposed reuse',
        );
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 300']);

        assert.throws(
          () => cleanupDetachedPreReportSessionForTest(authority, () => {
            // The exact leader pane/session disappears only after the
            // non-atomic topology probe has completed. The name is immediately
            // reused by a different session, which must not receive cleanup.
            fixture.run(['kill-session', '-t', sessionName]);
            fixture.run(['new-session', '-d', '-s', sessionName, '-c', fixture.sessionName, 'sleep 300']);
            fixture.run(['set-option', '-t', sessionName, '@omx_instance_id', 'replacement-owner']);
          }),
          /topology changed before cleanup/,
          'a vanished and name-reused leader must fail closed',
        );
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(sessionName), true, 'replacement session must survive race');
        assert.equal(fixture.run(['list-sessions', '-F', '#{session_name}']).split('\n').includes(foreignSessionName), true, 'unrelated session must survive race');
      });
    });
  });
});
