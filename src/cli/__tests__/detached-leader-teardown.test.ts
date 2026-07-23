import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it, type TestContext } from 'node:test';
import {
  applyDetachedTerminalExitStatus,
  buildDetachedSessionBootstrapSteps,
  publishDetachedReleaseMarker,
  probeExactDetachedSessionExists,
  resolveDetachedAttachExitStatus,
} from '../index.js';
import { isRealTmuxAvailable, tmuxSessionExists, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';

const TEST_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 50;
const omxBin = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'cli', 'omx.js');

interface DetachedLeaderReport {
  version: number;
  kind: string;
  nonce: string;
  sessionId: string;
  sessionName: string;
  leaderPid: number;
  finalized?: boolean;
  exitStatus?: number;
}

interface DetachedHudAuthority {
  paneId: string;
  panePid: number;
  sessionId: string;
  windowId: string;
  operationMarker: string;
}

function skipUnlessTmux(t: TestContext): boolean {
  if (process.platform === 'win32') {
    t.skip('detached tmux leader tests are not supported on win32');
    return false;
  }
  if (isRealTmuxAvailable()) return true;
  assert.equal(process.env.CI, undefined, 'CI must provide tmux for detached leader teardown regression tests');
  t.skip('tmux is not installed');
  return false;
}

async function poll<T>(description: string, predicate: () => Promise<T | undefined> | T | undefined, timeoutMs = TEST_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function readReportWhen(path: string, predicate: (report: DetachedLeaderReport) => boolean): Promise<DetachedLeaderReport> {
  return poll(`detached leader report at ${path}`, async () => {
    try {
      const report = JSON.parse(await readFile(path, 'utf-8')) as DetachedLeaderReport;
      return predicate(report) ? report : undefined;
    } catch {
      return undefined;
    }
  });
}

function paneExists(fixture: { run: (args: string[]) => string }, paneId: string): boolean {
  return fixture.run(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').includes(paneId);
}

function assertProcessDead(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
}

async function startDetachedLeader(
  fixture: {
    run: (args: string[]) => string;
  },
  wd: string,
  sessionName: string,
  sessionId: string,
  nonce: string,
  fakeChild: string,
): Promise<{ releaseMarkerPath: string; leaderPaneId: string; hud: DetachedHudAuthority }> {
  const releaseMarkerPath = join(wd, `${sessionId}.${nonce}.release`);
  const hudCmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(omxBin)} hud --watch`;
  const steps = buildDetachedSessionBootstrapSteps(
    sessionName,
    wd,
    fakeChild,
    hudCmd,
    null,
    undefined,
    undefined,
    false,
    sessionId,
    undefined,
    undefined,
    undefined,
    process.env,
    undefined,
    undefined,
    undefined,
    releaseMarkerPath,
    omxBin,
  );
  const newSession = steps.find((step) => step.name === 'new-session');
  const tagSession = steps.find((step) => step.name === 'tag-session');
  const splitHud = steps.find((step) => step.name === 'split-and-capture-hud-pane');
  assert.ok(newSession);
  assert.ok(tagSession);
  assert.ok(splitHud);

  newSession.args.splice(
    -1,
    0,
    '-e', 'OMX_AUTO_UPDATE=0',
    '-e', 'OMX_NOTIFY_FALLBACK=0',
    '-e', 'OMX_HOOK_DERIVED_SIGNALS=0',
  );
  const leaderPaneId = fixture.run(newSession.args);
  fixture.run(tagSession.args);

  const operationMarker = randomUUID();
  const splitArgs = [...splitHud.args];
  splitArgs[splitArgs.length - 1] = `env OMX_DETACHED_HUD_OPERATION=${operationMarker} ${splitArgs.at(-1)}`;
  const hudPaneId = fixture.run(splitArgs);
  const [paneId, panePidRaw, hudSessionId, windowId] = fixture.run([
    'display-message', '-p', '-t', hudPaneId, '#{pane_id}\t#{pane_pid}\t#{session_id}\t#{window_id}',
  ]).split('\t');
  const panePid = Number(panePidRaw);
  assert.equal(paneId, hudPaneId);
  assert.equal(Number.isSafeInteger(panePid) && panePid > 0, true);
  assert.notEqual(windowId, '');

  const ready = await readReportWhen(releaseMarkerPath, (report) => report.kind === 'ready');
  assert.equal(ready.nonce, nonce);
  assert.equal(ready.sessionId, sessionId);
  assert.equal(ready.sessionName, sessionName);
  assert.equal(Number.isSafeInteger(ready.leaderPid) && ready.leaderPid > 0, true);
  const hud = { paneId, panePid, sessionId: hudSessionId, windowId, operationMarker };
  publishDetachedReleaseMarker(releaseMarkerPath, nonce, sessionId, sessionName, ready.leaderPid, hud);

  return { releaseMarkerPath, leaderPaneId, hud };
}

function writeChild(wd: string, body: string): string {
  const path = join(wd, 'fake-codex.sh');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('detached leader HUD teardown', () => {
  it('tears down the proven HUD pane and session after a zero-status child exit', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-zero-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-zero';
        const sessionId = 'detached-zero-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'zero-nonce', fakeChild);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 0);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('leader session destruction', () => !tmuxSessionExists(sessionName, fixture.serverName) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('tears down the proven HUD pane and session after a nonzero child exit', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-nonzero-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-nonzero';
        const sessionId = 'detached-nonzero-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 7');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'nonzero-nonce', fakeChild);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 7);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('leader session destruction', () => !tmuxSessionExists(sessionName, fixture.serverName) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves the HUD pane and session after signal-derived child death', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-signal-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-signal';
        const sessionId = 'detached-signal-session';
        // Signal the direct child process regardless of /bin/sh -c exec behavior:
      // with exec-optimization $PPID is the leader (external-interrupt path);
      // without it, $PPID is the wrapped /bin/sh child itself (outcome.signal path).
      // Both are signal-derived exits where teardown must stay closed (exit 143).
      const fakeChild = writeChild(wd, 'sleep 1\nkill -TERM $PPID\nsleep 30');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'signal-nonce', fakeChild);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 143);
        assert.equal(paneExists(fixture, started.hud.paneId), true);
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes only the proven HUD pane while preserving a foreign pane in the leader session', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-foreign-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-foreign';
        const sessionId = 'detached-foreign-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'foreign-nonce', fakeChild);
        const foreignPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, '-c', wd, 'sleep 300',
        ]);
        const foreignPanePid = Number(fixture.run([
          'display-message', '-p', '-t', foreignPaneId, '#{pane_pid}',
        ]));
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.exitStatus, 0);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(paneExists(fixture, foreignPaneId), true);
        assert.doesNotThrow(() => process.kill(foreignPanePid, 0));
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('applies only a matching finalized terminal exit status', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-exit-status-'));
    const path = join(wd, 'marker.release');
    const previousExitCode = process.exitCode;
    try {
      writeFileSync(path, JSON.stringify({
        version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123,
        finalized: true, exitStatus: 7,
      }));
      process.exitCode = undefined;
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), true);
      assert.equal(process.exitCode, 7);

      process.exitCode = 19;
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'wrong', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);

      writeFileSync(path, JSON.stringify({ version: 1, kind: 'failed', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123, finalized: true, exitStatus: 7 }));
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);

      writeFileSync(path, JSON.stringify({ version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123, finalized: true }));
      assert.equal(applyDetachedTerminalExitStatus(path, { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 }), false);
      assert.equal(process.exitCode, 19);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('publishes an optional HUD authority proof exactly', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-release-marker-'));
    const path = join(wd, 'marker.release');
    const hud = { paneId: '%1', panePid: 123, sessionId: '$1', windowId: '@1', operationMarker: 'operation' };
    try {
      publishDetachedReleaseMarker(path, 'n', 's', 'sn', 456, hud);
      assert.deepEqual(JSON.parse(readFileSync(`${path}.release`, 'utf-8')), {
        version: 1, kind: 'release', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 456, hud,
      });

      publishDetachedReleaseMarker(path, 'n', 's', 'sn', 456);
      const withoutHud = JSON.parse(readFileSync(`${path}.release`, 'utf-8')) as Record<string, unknown>;
      assert.equal(Object.hasOwn(withoutHud, 'hud'), false);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('distinguishes destroyed-session protocol failure from manual detach', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-attach-resolution-'));
    const path = join(wd, 'marker.release');
    const expected = { nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123 };
    const previousExitCode = process.exitCode;
    try {
      // Destroyed session + missing report: finalized status is mandatory -> failure.
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => false }),
        'protocol-failure',
      );
      // Destroyed session + malformed report -> failure.
      writeFileSync(path, 'not json');
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => false }),
        'protocol-failure',
      );
      // Exact owned session provably alive with no terminal report -> manual detach stays success.
      rmSync(path, { force: true });
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => true }),
        'manual-detach',
      );
      // Ambiguous session query (tmux unreachable) fails closed without any mutation.
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, { exactSessionExists: () => undefined }),
        'protocol-failure',
      );
      // A valid finalized terminal report applies its status and never probes the session.
      writeFileSync(path, JSON.stringify({
        version: 1, kind: 'terminal', nonce: 'n', sessionId: 's', sessionName: 'sn', leaderPid: 123,
        finalized: true, exitStatus: 7,
      }));
      process.exitCode = undefined;
      assert.equal(
        resolveDetachedAttachExitStatus(path, expected, {
          exactSessionExists: () => { throw new Error('probe must not run when the status applies'); },
        }),
        'applied',
      );
      assert.equal(process.exitCode, 7);
    } finally {
      process.exitCode = previousExitCode;
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('probeExactDetachedSessionExists distinguishes live, retained-dead, and destroyed leader panes', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const sessionName = 'omx-probe-liveness';
      fixture.run(['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24', 'sleep 1', ';', 'set-option', 'remain-on-exit', 'on']);
      const paneId = fixture.run(['list-panes', '-t', sessionName, '-F', '#{pane_id}']).split('\n')[0]!;
      const fields = fixture.run([
        'display-message', '-p', '-t', paneId,
        '#{session_name}\t#{session_id}\t#{session_created}\t#{window_index}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const authority = {
        paneId,
        panePid: Number(fields[6]),
        sessionName,
        sessionId: fields[1]!,
        sessionCreated: fields[2]!,
        windowIndex: fields[3]!,
        windowId: fields[4]!,
        ownerId: 'probe-owner',
      };
      assert.equal(probeExactDetachedSessionExists(authority), true, 'live leader pane reads as surviving session');
      await poll('leader pane death', () => {
        const dead = fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']);
        return dead === '1' ? true : undefined;
      });
      assert.equal(probeExactDetachedSessionExists(authority), false, 'retained dead pane (remain-on-exit) fails closed as not-alive');
      fixture.run(['kill-session', '-t', sessionName]);
      assert.equal(probeExactDetachedSessionExists(authority), undefined, 'destroyed session is ambiguous and fails closed');
    });
  });
});
