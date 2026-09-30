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
  DETACHED_LEADER_READY_TIMEOUT_MS,
  cleanupDetachedPreReportSession,
  cleanupDetachedHudPane,
  cleanupFinalizedDetachedHud,
  decodeDetachedLeaderPayload,
  describeDetachedLeaderFailure,
  publishDetachedReleaseMarker,
  parseDetachedLeaderPaneIdByPid,
  isDetachedReadyReportAuthorized,
  probeExactDetachedSessionExists,
  resolveDetachedAttachExitStatus,
} from '../index.js';
import { isRealTmuxAvailable, tmuxSessionExists, withTempTmuxSession } from '../../team/__tests__/tmux-test-fixture.js';
import type { TempTmuxSessionFixture } from '../../team/__tests__/tmux-test-fixture.js';

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
  sessionName: string;
  sessionId: string;
  sessionCreated: string;
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

function createOwnedHud(fixture: TempTmuxSessionFixture, ownerId: string): DetachedHudAuthority {
  const operationMarker = randomUUID();
  const [paneId, panePidRaw, sessionName, sessionId, sessionCreated, windowId] = fixture.run([
    'split-window', '-d', '-P', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}',
    '-t', fixture.sessionName, `env OMX_DETACHED_HUD_OPERATION=${operationMarker} sleep 120`,
  ]).trim().split('\t');
  const panePid = Number(panePidRaw);
  assert.ok(paneId && sessionName && sessionId && sessionCreated && windowId);
  assert.equal(Number.isSafeInteger(panePid) && panePid > 0, true);
  fixture.run(['set-option', '-pq', '-t', paneId, '@omx_hud_owner', ownerId]);
  return { paneId, panePid, sessionName, sessionId, sessionCreated, windowId, operationMarker };
}

function assertProcessDead(pid: number): void {
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove a detached-leader working directory once nothing is still writing to it.
 *
 * Subtests that intentionally preserve the HUD pane leave `omx hud --watch` running
 * against `<wd>/.omx/state` on a 1s tick. Recursive removal races that writer:
 * `force` only suppresses ENOENT, so a file recreated mid-walk surfaces as
 * `ENOTEMPTY: directory not empty, rmdir '<wd>/.omx/state'`. Wait for the writer to
 * exit, then retry to absorb any in-flight tick.
 */
async function cleanupDetachedWorkdir(wd: string, hudPanePid?: number): Promise<void> {
  if (hudPanePid !== undefined) {
    const deadline = Date.now() + TEST_TIMEOUT_MS;
    while (processAlive(hudPanePid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assertProcessDead(hudPanePid);
  }
  await rm(wd, { recursive: true, force: true, maxRetries: 10, retryDelay: POLL_INTERVAL_MS });
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
  const splitFormatIndex = splitArgs.indexOf('-F');
  assert.ok(splitFormatIndex >= 0 && splitArgs[splitFormatIndex + 1] === '#{pane_id}');
  splitArgs[splitFormatIndex + 1] = '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}\tRECEIPT';
  const splitReceipt = fixture.run(splitArgs).trim().split('\t');
  assert.equal(splitReceipt.length, 7, 'the HUD split must return the seven-field production receipt');
  const [paneId, panePidRaw, hudSessionName, hudSessionId, sessionCreated, windowId, observedReceipt] = splitReceipt;
  assert.match(observedReceipt ?? '', /^RECEIPT$/, 'the HUD split receipt must terminate with the literal receipt marker');
  const panePid = Number(panePidRaw);
  assert.equal(Number.isSafeInteger(panePid) && panePid > 0, true);
  assert.notEqual(windowId, '');
  // The production split sink tags the created HUD pane with the session owner
  // before any finalize step runs.
  fixture.run(['set-option', '-pq', '-t', paneId, '@omx_hud_owner', sessionId]);

  const ready = await readReportWhen(releaseMarkerPath, (report) => report.kind === 'ready');
  assert.equal(ready.nonce, nonce);
  assert.equal(ready.sessionId, sessionId);
  assert.equal(ready.sessionName, sessionName);
  assert.equal(Number.isSafeInteger(ready.leaderPid) && ready.leaderPid > 0, true);
  const hud = { paneId, panePid, sessionName: hudSessionName, sessionId: hudSessionId, sessionCreated, windowId, operationMarker };
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
  it('keeps the detached readiness window above slow macOS prelaunch completion', () => {
    assert.equal(DETACHED_LEADER_READY_TIMEOUT_MS, 120_000);
  });

  it('preserves and validates shouldAttach across detached payload encode and decode', () => {
    const payload = {
      cwd: '/tmp/project',
      sessionName: 'omx-session',
      sessionId: 'omx-session-id',
      codexCmd: 'codex',
      preLaunchOptions: {
        enableNotifyFallbackAuthority: false,
        worktreeDirty: false,
        shouldAttach: false,
      },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    assert.equal(decodeDetachedLeaderPayload(encoded).preLaunchOptions.shouldAttach, false);
    const invalid = Buffer.from(JSON.stringify({
      ...payload,
      preLaunchOptions: { ...payload.preLaunchOptions, shouldAttach: 'false' },
    })).toString('base64url');
    assert.throws(() => decodeDetachedLeaderPayload(invalid), /invalid detached leader payload/);
  });

  it('preserves bounded nested detached failure causes without control characters', () => {
    const failure = new AggregateError(
      [new Error('metadata bind denied'), new Error('session pointer unusable\nretry denied')],
      'leader finalization failed',
    );
    assert.equal(
      describeDetachedLeaderFailure(failure),
      'leader finalization failed: metadata bind denied: session pointer unusable retry denied',
    );
  });

  it('includes bounded stderr summary at the beginning when error has stderr property', () => {
    const error = Object.assign(new Error('setup failed'), {
      stderr: 'command not found: node',
      status: 127,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /command not found: node/);
    assert.match(result, /status=127/);
    assert.match(result, /setup failed/);
  });

  it('truncates long stderr to 255 characters with ellipsis marker', () => {
    const longStderr = 'x'.repeat(300);
    const error = Object.assign(new Error('stderr test'), {
      stderr: longStderr,
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /^x{255}…/);
  });

  it('handles Buffer stderr by converting to string', () => {
    const error = Object.assign(new Error('buffer stderr test'), {
      stderr: Buffer.from('buffer stderr content'),
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /buffer stderr content/);
  });

  it('redacts absolute paths from stderr and error messages', () => {
    const error = Object.assign(new Error('failed at /home/user/project/src/file.ts'), {
      stderr: 'error in /var/log/app.log',
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /\/home\/user/);
    assert.doesNotMatch(result, /\/var\/log/);
    assert.match(result, /\[path\]/);
  });

  it('redacts secret patterns from stderr and error messages', () => {
    const error = Object.assign(new Error('auth failed with sk-proj-abc12345def'), {
      stderr: 'Bearer token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /sk-proj-abc12345def/);
    assert.doesNotMatch(result, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
    assert.match(result, /\[redacted\]/);
  });

  it('handles stderr-only errors without message', () => {
    const error = Object.assign(new Error(), {
      stderr: 'connection refused',
      status: 0,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /connection refused/);
    assert.match(result, /status=0/);
    assert.ok(result.length <= 1024);
  });

  it('never includes captured subprocess stdout', () => {
    const error = Object.assign(new Error('Command failed: tmux new-session'), {
      status: 1,
      stdout: 'UNRELATED_STDOUT_PAYLOAD',
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /UNRELATED_STDOUT_PAYLOAD/);
    assert.match(result, /status=1/);
  });

  it('includes signal information when present', () => {
    const error = Object.assign(new Error('terminated'), {
      signal: 'SIGTERM',
      stderr: 'cleanup failed',
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /signal=SIGTERM/);
    assert.match(result, /cleanup failed/);
  });

  it('includes code information when present', () => {
    const error = Object.assign(new Error('io error'), {
      code: 'ENOENT',
      stderr: 'file not found',
    });
    const result = describeDetachedLeaderFailure(error);
    assert.match(result, /code=ENOENT/);
    assert.match(result, /file not found/);
  });

  it('walks nested AggregateError causes and includes stderr from any level', () => {
    const innerError = Object.assign(new Error('inner failure'), {
      stderr: 'inner stderr content',
    });
    const aggregated = new AggregateError(
      [innerError, new Error('other error')],
      'aggregate failed',
    );
    const result = describeDetachedLeaderFailure(aggregated);
    // Should include both the nested stderr and the error chain
    assert.match(result, /inner stderr content/);
    assert.match(result, /aggregate failed/);
    assert.match(result, /inner failure/);
  });

  it('redacts the whole bearer credential including base64 punctuation', () => {
    const error = Object.assign(new Error('auth failed'), {
      stderr: 'Authorization: Bearer abc+SECRET/rest== denied',
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /SECRET|rest==/);
    assert.match(result, /\[redacted\] denied/);
  });

  it('redacts fine-grained GitHub access tokens', () => {
    const error = Object.assign(new Error('push failed'), {
      stderr: 'auth github_pat_11AAAAAAA0abcdefGHIJKL_mnopqrstuvWXYZ0123456789 rejected',
      status: 128,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /github_pat_|mnopqrstuv/);
    assert.match(result, /^auth \[redacted\] rejected \| status=128/);
  });

  it('keeps exit metadata from a failure wrapped in an AggregateError', () => {
    const child = Object.assign(new Error('release failed'), { stderr: 'failed', status: 23, signal: 'SIGKILL' });
    const result = describeDetachedLeaderFailure(new AggregateError([child], 'detached abort failed'));
    assert.match(result, /^failed \| status=23 \| signal=SIGKILL \| detached abort failed: release failed$/);
  });

  it('keeps each nested failure\'s exit metadata attributed to its own stderr', () => {
    const first = Object.assign(new Error('kill-pane failed'), { stderr: 'no pane', status: 1 });
    const second = Object.assign(new Error('rm failed'), { stderr: 'busy', signal: 'SIGKILL', code: 'EBUSY' });
    const result = describeDetachedLeaderFailure(new AggregateError([first, second], 'cleanup failed'));
    assert.equal(
      result,
      'no pane | status=1 | busy | signal=SIGKILL | code=EBUSY | cleanup failed: kill-pane failed: rm failed',
    );
  });

  it('includes the cause of an AggregateError alongside its errors', () => {
    const cause = Object.assign(new Error('spawn failed'), { stderr: 'tmux socket missing', status: 2 });
    const child = Object.assign(new Error('kill-pane failed'), { stderr: 'no pane', status: 1 });
    const result = describeDetachedLeaderFailure(new AggregateError([child], 'cleanup failed', { cause }));
    assert.match(result, /^no pane \| status=1 \| tmux socket missing \| status=2 \| cleanup failed/);
  });

  it('drops non-symbolic signal and code values instead of echoing them', () => {
    const error = Object.assign(new Error('x'), {
      stderr: 'boom',
      status: 1,
      signal: '\u001b]52;c;Y2xpcA==\u0007',
      code: 'ghp_abcdefghijklmnop /home/user/secret',
    });
    const result = describeDetachedLeaderFailure(error);
    assert.equal(result, 'boom | status=1 | x');
  });

  it('reserves space for exit metadata when many long stderrs are aggregated', () => {
    const children = [1, 2, 3, 4, 5].map((n) =>
      Object.assign(new Error(`step ${n} failed`), { stderr: String(n).repeat(400), status: 10 + n }));
    const result = describeDetachedLeaderFailure(new AggregateError(children, 'cleanup failed'));
    assert.ok(result.length <= 1024, `${result.length}`);
    for (const n of [1, 2, 3, 4, 5]) assert.match(result, new RegExp(`\\| status=${10 + n}(?: |$)`));
    assert.match(result, /cleanup failed: step 1 failed/);
  });

  it('never echoes failed-command argv, even values split by unquoted whitespace', () => {
    const error = Object.assign(
      new Error('Command failed: tmux new-session -d -e OMX_TEAM_WORKER_LAUNCH_ARGS=alpha beta-secret -e OMX_SESSION_ID=omx-1\nboom'),
      { stderr: 'boom', status: 1 },
    );
    const result = describeDetachedLeaderFailure(error);
    assert.equal(result, 'boom | status=1 | Command failed: tmux new-session [argv redacted]');
  });

  it('strips terminal escape sequences and control bytes from stderr', () => {
    const error = Object.assign(new Error('x'), {
      stderr: '\u001b[31mred\u001b[0m \u001b]52;c;Y2xpcA==\u0007tail\u0007\u009b',
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.doesNotMatch(result, /[\u0000-\u001f\u007f-\u009f]/);
    assert.doesNotMatch(result, /Y2xpcA/);
    assert.match(result, /^red tail \| status=1/);
  });

  it('bounds total output to 1024 characters', () => {
    const longMessage = 'y'.repeat(600);
    const longStderr = 'z'.repeat(600);
    const error = Object.assign(new Error(longMessage), {
      stderr: longStderr,
      status: 1,
    });
    const result = describeDetachedLeaderFailure(error);
    assert.ok(result.length <= 1024, `Expected <= 1024 chars, got ${result.length}`);
  });

  it('derives the detached leader pane from the live pane PID instead of inherited TMUX_PANE', () => {
    const snapshot = [
      '%1\t0\t111',
      '%2\t1\t222',
      '%3\t0\t333',
    ].join('\n');
    assert.equal(parseDetachedLeaderPaneIdByPid(snapshot, 333), '%3');
    assert.throws(() => parseDetachedLeaderPaneIdByPid(snapshot, 222), /pane identity is unavailable/);
    assert.throws(
      () => parseDetachedLeaderPaneIdByPid(`${snapshot}\n%4\t0\t333`, 333),
      /pane identity is unavailable/,
    );
  });

  it('authenticates normal detached and Hermes ready reports with separate authority contracts', () => {
    const report = {
      version: 1 as const,
      kind: 'ready' as const,
      nonce: 'nonce',
      sessionId: 'session',
      sessionName: 'name',
      paneId: '%9',
      leaderPid: 900,
    };
    const expected = {
      nonce: 'nonce',
      sessionId: 'session',
      sessionName: 'name',
      leaderPaneId: '%9',
      leaderPanePid: 901,
    };
    assert.equal(isDetachedReadyReportAuthorized(report, { ...expected, shouldAttach: true }), false);
    assert.equal(isDetachedReadyReportAuthorized(report, { ...expected, shouldAttach: false }), true);
    assert.equal(
      isDetachedReadyReportAuthorized({ ...report, paneId: '%8' }, { ...expected, shouldAttach: false }),
      false,
    );
  });

  it('cleans an exact retained dead pane with its owner tag and rejects changed identity', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      fixture.run(['set-option', '-g', 'remain-on-exit', 'on']);
      const snapshot = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName,
        '#{session_name}\t#{session_id}\t#{session_created}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const [sessionName, sessionId, sessionCreated, windowId, paneId, panePidRaw] = snapshot;
      const panePid = Number(panePidRaw);
      if (!sessionName || !sessionId || !sessionCreated || !windowId || !paneId || !Number.isSafeInteger(panePid)) {
        throw new Error('invalid retained-pane topology fixture');
      }
      fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'missing-owner-tag']);
      process.kill(panePid, 'SIGTERM');
      await poll('retained dead pane', () => fixture.run(['display-message', '-p', '-t', paneId, '#{pane_dead}']) === '1' ? true : undefined);
      const authority = {
        paneId, panePid, sessionName, sessionId, sessionCreated, windowId,
        windowIndex: '0', ownerId: 'missing-owner-tag',
      };
      fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', 'foreign-owner']);
      assert.throws(
        () => cleanupDetachedPreReportSession(authority),
        /topology changed before cleanup/,
      );
      assert.equal(fixture.sessionExists(sessionName), true);
      fixture.run(['set-option', '-t', fixture.sessionName, '@omx_instance_id', authority.ownerId]);
      cleanupDetachedPreReportSession(authority);
      await poll('pre-report session destruction', () => !fixture.sessionExists(sessionName) ? true : undefined);
    });
  });
  it('removes the proven HUD so the last leader pane closes the session without touching unrelated panes', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const [leaderPaneId, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const hud = createOwnedHud(fixture, 'owner-zero');
      if (!leaderPaneId) throw new Error('invalid HUD teardown fixture');
      assert.equal(cleanupDetachedHudPane(hud, 'owner-zero'), true);
      await poll('proven HUD pane removal', () => !fixture.run(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').includes(hud.paneId) ? true : undefined);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
      await poll('last-pane session destruction', () => !fixture.sessionExists() ? true : undefined);
    });

    await withTempTmuxSession(async (fixture) => {
      const [, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const userPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const staleHudProof = createOwnedHud(fixture, 'owner-user-pane');
      assert.equal(cleanupDetachedHudPane(staleHudProof, 'owner-user-pane'), true);
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      // A stale proof must be an ordinary fail-closed preserve, never a throw.
      assert.equal(cleanupDetachedHudPane(staleHudProof, 'owner-user-pane'), false, 'a stale proof must fail closed as a boolean false');
      assert.equal(fixture.run(['display-message', '-p', '-t', replacementPaneId, '#{pane_id}']), replacementPaneId);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
      await poll('unrelated pane survives leader exit', () => fixture.sessionExists() ? true : undefined);
      assert.equal(fixture.run(['display-message', '-p', '-t', userPaneId, '#{pane_id}']), userPaneId);
    });
  });

  it('treats a stale or missing HUD proof target as an ordinary preserved mismatch without destroying the server', async (t) => {
    if (!skipUnlessTmux(t)) return;
    // Stale proof after the proven HUD was already removed and the pane id was
    // replaced by a new pane. The stale `-t %N` target must resolve to an
    // ordinary fail-closed preserve result: no throw, no server/session loss,
    // and no harm to the replacement or foreign panes.
    await withTempTmuxSession(async (fixture) => {
      const [, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const userPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const staleHudProof = createOwnedHud(fixture, 'stale-proof-owner');
      assert.equal(cleanupDetachedHudPane(staleHudProof, 'stale-proof-owner'), true);
      await poll('proven HUD removal', () => !paneExists(fixture, staleHudProof.paneId) ? true : undefined);
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      assert.equal(cleanupDetachedHudPane(staleHudProof, 'stale-proof-owner'), false, 'a stale proof must fail closed as a boolean false');
      assert.doesNotThrow(() => cleanupDetachedHudPane(staleHudProof, 'stale-proof-owner'));
      assert.equal(paneExists(fixture, replacementPaneId), true, 'the replacement pane must survive a stale proof');
      assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive a stale proof');
      assert.equal(fixture.run(['display-message', '-p', '-t', userPaneId, '#{pane_id}']), userPaneId);
      process.kill(Number(leaderPidRaw), 'SIGTERM');
    });

    // Missing proof target: the proof pane id no longer exists anywhere.
    await withTempTmuxSession(async (fixture) => {
      const missingProof = createOwnedHud(fixture, 'missing-proof-owner');
      assert.equal(cleanupDetachedHudPane(missingProof, 'missing-proof-owner'), true);
      await poll('proven HUD removal', () => !paneExists(fixture, missingProof.paneId) ? true : undefined);
      const ghostProof = { ...missingProof, paneId: '%999999' };
      assert.equal(cleanupDetachedHudPane(ghostProof, 'missing-proof-owner'), false, 'a missing proof target must fail closed as a boolean false');
      assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive a missing proof target');
    });
  });

  it('preserves the tmux server, leader, replacement pane, and foreign session across a stale HUD proof attack', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const fixtureServer = await withTempTmuxSession(async (fixture) => {
      const [leaderPaneId, leaderPidRaw] = fixture.run([
        'display-message', '-p', '-t', fixture.sessionName, '#{pane_id}\t#{pane_pid}',
      ]).split('\t');
      const staleProof = createOwnedHud(fixture, 'attack-owner');
      // Remove the proven HUD and let its pane id be recycled by a replacement pane.
      assert.equal(cleanupDetachedHudPane(staleProof, 'attack-owner'), true);
      await poll('proven HUD removal', () => !paneExists(fixture, staleProof.paneId) ? true : undefined);
      const replacementPaneId = fixture.run([
        'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', fixture.sessionName, 'sleep 120',
      ]);
      const foreignSessionName = `${fixture.sessionName}-foreign`;
      fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', fixture.sessionName, 'sleep 120']);
      // The stale proof must fail closed without killing the server, session, or panes.
      assert.equal(cleanupDetachedHudPane(staleProof, 'attack-owner'), false, 'a stale proof must fail closed as a boolean false');
      assert.equal(fixture.sessionExists(), true, 'leader session must survive');
      assert.equal(tmuxSessionExists(foreignSessionName, fixture.serverName), true, 'foreign session must survive');
      assert.equal(paneExists(fixture, leaderPaneId), true, 'leader pane must survive');
      assert.equal(paneExists(fixture, replacementPaneId), true, 'replacement pane must survive');
      // The server must still be reachable for ordinary commands after the attack.
      assert.ok(fixture.run(['list-sessions', '-F', '#{session_name}']).includes(fixture.sessionName));
      return fixture.serverName;
    });
    // Server liveness must persist past the fixture scope: the cleanup kill-server
    // in withTempTmuxSession proves termination is fixture-owned, not attack-owned.
    assert.ok(typeof fixtureServer === 'string');
  });

  it('preserves the leader, session, and foreign panes across normal child-exit teardown with a recycled HUD proof', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-stale-seam-'));
    // This subtest preserves every leader-session pane (remain-on-exit keeps the
    // dead leader visible), so the HUD watcher keeps running until fixture teardown.
    let hudPanePid: number | undefined;
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-stale-seam';
        const sessionId = 'detached-stale-seam-session';
        const sentinel = join(wd, 'child-release');
        // The child blocks on a sentinel so the HUD proof can be recycled before
        // the leader reaches normal child-exit teardown.
        const fakeChild = writeChild(wd, 'while [ ! -f child-release ]; do sleep 0.1; done\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'stale-seam-nonce', fakeChild);
        hudPanePid = started.hud.panePid;
        // Retain the dead leader pane: with remain-on-exit on, an executed
        // `kill-pane -t leaderPaneId` destroys the pane (and the session when it
        // is the last one), while a preserved zero-mutation teardown leaves it
        // visible as dead. This makes the leader kill observable even after the
        // leader process has exited normally.
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        // Remove the proven HUD out from under the leader's retained proof and
        // recycle its pane id, exactly like the stale-proof attack, then add a
        // replacement pane and a foreign session that must all survive teardown.
        assert.equal(cleanupDetachedHudPane(started.hud, sessionId), true);
        await poll('proven HUD removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        const replacementPaneId = fixture.run([
          'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sessionName, '-c', wd, 'sleep 300',
        ]);
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', wd, 'sleep 300']);
        // Release the child into its normal exit and let the leader finalize.
        writeFileSync(sentinel, 'released\n');
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 0);
        await poll('retained dead leader pane', () => fixture.run([
          'display-message', '-p', '-t', started.leaderPaneId, '#{pane_dead}',
        ]) === '1' ? true : undefined);

        // Fail-closed teardown: the recycled HUD proof must suppress the leader
        // kill entirely, leaving the leader, session, and every bystander intact.
        assert.equal(paneExists(fixture, started.leaderPaneId), true, 'the dead leader pane must be retained, not killed');
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true, 'the leader session must survive zero-mutation teardown');
        assert.equal(paneExists(fixture, replacementPaneId), true, 'the replacement pane must survive zero-mutation teardown');
        assert.equal(tmuxSessionExists(foreignSessionName, fixture.serverName), true, 'the foreign session must survive zero-mutation teardown');
        assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive zero-mutation teardown');
      });
    } finally {
      await cleanupDetachedWorkdir(wd, hudPanePid);
    }
  });
  it('removes only the matching bootstrap HUD after a finalized leader failure', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const ownerId = 'finalized-failure-owner';
      const expected = createOwnedHud(fixture, ownerId);
      assert.equal(cleanupFinalizedDetachedHud(expected, ownerId), true);
      await poll('bootstrap HUD removal', () => !paneExists(fixture, expected.paneId) ? true : undefined);
    });
  });

  it('preserves a bootstrap HUD when its proof or owner changes before finalized failure cleanup', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const mutations: Array<readonly [string, (fixture: TempTmuxSessionFixture, proof: DetachedHudAuthority) => DetachedHudAuthority]> = [
      ['owner', (fixture, proof) => {
        fixture.run(['set-option', '-pq', '-t', proof.paneId, '@omx_hud_owner', 'foreign-owner']);
        return proof;
      }],
      ['pane PID', (_fixture, proof) => ({ ...proof, panePid: proof.panePid + 1 })],
      ['session creation', (_fixture, proof) => ({ ...proof, sessionCreated: `${Number(proof.sessionCreated) + 1}` })],
      ['window topology', (_fixture, proof) => ({ ...proof, windowId: '@999999' })],
      ['operation marker', (_fixture, proof) => ({ ...proof, operationMarker: randomUUID() })],
    ];
    for (const [name, mutate] of mutations) {
      await withTempTmuxSession(async (fixture) => {
        const ownerId = `finalized-failure-${name}`;
        const expected = createOwnedHud(fixture, ownerId);
        assert.equal(cleanupFinalizedDetachedHud(mutate(fixture, expected), ownerId), false, name);
        assert.equal(paneExists(fixture, expected.paneId), true, name);
      });
    }
  });


  it('tears down the proven HUD pane and session after a zero-status child exit', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-zero-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-zero';
        const sessionId = 'detached-zero-session';
        const fakeChild = writeChild(wd, 'sleep 1\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'zero-nonce', fakeChild);
        // Retain the dead leader pane: the teardown must still kill it, proving
        // the leader kill runs when and only when HUD cleanup succeeded.
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 0);
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        // Under remain-on-exit retention, only the teardown's own leader
        // kill-pane can destroy this pane: natural exit would retain it dead.
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('leader session destruction', () => !tmuxSessionExists(sessionName, fixture.serverName) ? true : undefined);
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
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
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('preserves the HUD pane and session after signal-derived child death', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-signal-'));
    // This subtest deliberately preserves the HUD pane, so its `omx hud --watch`
    // is still writing `<wd>/.omx/state` when the test body returns.
    let hudPanePid: number | undefined;
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
        hudPanePid = started.hud.panePid;
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 143);
        assert.equal(paneExists(fixture, started.hud.paneId), true);
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd, hudPanePid);
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
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        assert.equal(paneExists(fixture, foreignPaneId), true);
        assert.doesNotThrow(() => process.kill(foreignPanePid, 0));
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true);
        assert.equal(fixture.sessionExists(), true);
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('tears down the matching HUD and leader from a non-current window while preserving foreign windows and sessions', async (t) => {
    if (!skipUnlessTmux(t)) return;
    const wd = mkdtempSync(join(tmpdir(), 'omx-detached-leader-cross-window-'));
    try {
      await withTempTmuxSession(async (fixture) => {
        const sessionName = 'omx-detached-cross-window';
        const sessionId = 'detached-cross-window-session';
        const sentinel = join(wd, 'child-release');
        // Block the child on a sentinel so the session topology can change
        // before the leader reaches normal child-exit teardown.
        const fakeChild = writeChild(wd, 'while [ ! -f child-release ]; do sleep 0.1; done\nexit 0');
        const started = await startDetachedLeader(fixture, wd, sessionName, sessionId, 'cross-window-nonce', fakeChild);
        // Retain the dead leader pane so the leader kill stays observable under
        // remain-on-exit even after the leader process exits normally.
        fixture.run(['set-option', '-t', sessionName, 'remain-on-exit', 'on']);
        // An attached user creates and selects another window in the leader
        // session: the proven HUD stays in the original (now non-current)
        // window while the session's current window moves to window 1.
        const foreignWindowPaneId = fixture.run([
          'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${sessionName}:`, '-c', wd, 'sleep 300',
        ]);
        fixture.run(['select-window', '-t', `${sessionName}:1`]);
        assert.equal(
          fixture.run(['display-message', '-p', '-t', sessionName, '#{window_id}']),
          fixture.run(['display-message', '-p', '-t', foreignWindowPaneId, '#{window_id}']),
          'the selected window must be the foreign window, not the HUD window',
        );
        assert.equal(
          fixture.run(['list-panes', '-t', sessionName, '-F', '#{pane_id}']).split('\n').includes(started.hud.paneId),
          false,
          'a window-scoped listing must not see the HUD in the non-current window',
        );
        const foreignSessionName = `${sessionName}-foreign`;
        fixture.run(['new-session', '-d', '-s', foreignSessionName, '-c', wd, 'sleep 300']);
        // Release the child into its normal exit and let the leader finalize.
        writeFileSync(sentinel, 'released\n');
        const terminal = await readReportWhen(started.releaseMarkerPath, (report) => report.kind === 'terminal');
        assert.equal(terminal.finalized, true);
        assert.equal(terminal.exitStatus, 0);
        // Session-wide proof enumeration must still authenticate the HUD in the
        // non-current window, so teardown removes the HUD and the gated leader.
        await poll('leader pane removal', () => !paneExists(fixture, started.leaderPaneId) ? true : undefined);
        await poll('HUD pane removal', () => !paneExists(fixture, started.hud.paneId) ? true : undefined);
        await poll('HUD process exit', () => !processAlive(started.hud.panePid) ? true : undefined);
        assertProcessDead(started.hud.panePid);
        // The user-added window keeps its live pane, so the leader session is
        // deliberately preserved (#3266 contract): natural closure happens only
        // when no other panes remain. The foreign window pane, the foreign
        // session on the same server, and the private fixture session survive.
        assert.equal(paneExists(fixture, foreignWindowPaneId), true, 'the foreign window pane must survive cross-window teardown');
        assert.equal(tmuxSessionExists(sessionName, fixture.serverName), true, 'the leader session must survive with a preserved user pane');
        assert.equal(tmuxSessionExists(foreignSessionName, fixture.serverName), true, 'the foreign session must survive cross-window teardown');
        assert.equal(fixture.sessionExists(), true, 'the private fixture session must survive cross-window teardown');
      });
    } finally {
      await cleanupDetachedWorkdir(wd);
    }
  });

  it('removes the proven HUD from a non-current window without harming an impostor pane in another window', async (t) => {
    if (!skipUnlessTmux(t)) return;
    await withTempTmuxSession(async (fixture) => {
      const ownerId = 'cross-window-impostor-owner';
      const expected = createOwnedHud(fixture, ownerId);
      // Create an impostor pane in another window carrying the same operation
      // marker text and the same owner tag but none of the proof's pane
      // identity: it must not become an authority match, must not be harmed,
      // and must not stop the exact proof from authorizing the real HUD.
      const impostorWindowPaneId = fixture.run([
        'new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${fixture.sessionName}:`,
        `env OMX_DETACHED_HUD_OPERATION=${expected.operationMarker} sleep 120`,
      ]);
      fixture.run(['set-option', '-pq', '-t', impostorWindowPaneId, '@omx_hud_owner', ownerId]);
      fixture.run(['select-window', '-t', `${fixture.sessionName}:1`]);
      assert.equal(
        fixture.run(['display-message', '-p', '-t', fixture.sessionName, '#{window_id}']),
        fixture.run(['display-message', '-p', '-t', impostorWindowPaneId, '#{window_id}']),
        'the selected window must be the impostor window, not the HUD window',
      );
      assert.equal(cleanupDetachedHudPane(expected, ownerId), true, 'the exact proof must still authorize the real HUD');
      await poll('proven HUD removal', () => !paneExists(fixture, expected.paneId) ? true : undefined);
      assert.equal(paneExists(fixture, impostorWindowPaneId), true, 'the impostor pane in the other window must be preserved');
    });
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
    const hud = { paneId: '%1', panePid: 123, sessionName: 'session', sessionId: '$1', sessionCreated: '1', windowId: '@1', operationMarker: 'operation' };
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
