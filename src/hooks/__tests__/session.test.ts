import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __createDefaultPidProbeForTests,
  appendPromptSessionProvenanceRejection,
  __resetSessionPointerTransactionDependenciesForTests,
  __setSessionPointerTransactionDependenciesForTests,
  isSessionPointerLaunchAbort,
  isSessionStale,
  readSessionPointer,
  readSessionState,
  readUsableSessionState,
  reconcileNativeSessionStart,
  resetSessionMetrics,
  resolveSessionPointerContext,
  writeSessionEnd,
  writeSessionStart,
  type SessionState,
} from '../session.js';

interface SessionHistoryEntry {
  session_id: string;
  native_session_id?: string;
  started_at: string;
  ended_at: string;
  cwd: string;
  pid: number;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: 'sess-1',
    started_at: '2026-02-26T00:00:00.000Z',
    cwd: '/tmp/project',
    pid: 12345,
    ...overrides,
  };
}

const TEST_TOKEN = 'transaction_token_123456';
const FOREIGN_TOKEN = 'foreign_token_123456789';
const SUCCESSOR_TOKEN = 'successor_token_123456789';

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function withPointerDependencies(
  overrides: Parameters<typeof __setSessionPointerTransactionDependenciesForTests>[0],
  run: () => Promise<void>,
): Promise<void> {
  __setSessionPointerTransactionDependenciesForTests(overrides);
  try {
    await run();
  } finally {
    __resetSessionPointerTransactionDependenciesForTests();
  }
}

async function withOwnerEnvironment(sessionId: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.OMX_SESSION_ID;
  if (sessionId === undefined) delete process.env.OMX_SESSION_ID;
  else process.env.OMX_SESSION_ID = sessionId;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.OMX_SESSION_ID;
    else process.env.OMX_SESSION_ID = previous;
  }
}

function matchingProcessIdentity() {
  return { status: 'matching' as const, startTicks: 1 };
}

async function writeLockOwner(cwd: string, owner: Record<string, unknown>): Promise<string> {
  const context = resolveSessionPointerContext(cwd);
  await mkdir(context.lockPath, { recursive: true });
  await writeFile(join(context.lockPath, 'owner.json'), JSON.stringify(owner), 'utf-8');
  return context.lockPath;
}

function validLockOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    token: TEST_TOKEN,
    pid: process.pid,
    platform: 'linux',
    pid_start_ticks: 1,
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('session lifecycle manager', () => {
  it('resets session metrics files with zeroed counters', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-'));
    try {
      await resetSessionMetrics(cwd);

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const metrics = JSON.parse(await readFile(metricsPath, 'utf-8')) as {
        total_turns: number;
        session_turns: number;
      };
      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };

      assert.equal(metrics.total_turns, 0);
      assert.equal(metrics.session_turns, 0);
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes hud session metrics into the active session scope when session id is provided', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-metrics-scoped-'));
    try {
      await resetSessionMetrics(cwd, 'sess-scoped');

      const metricsPath = join(cwd, '.omx', 'metrics.json');
      const hudPath = join(cwd, '.omx', 'state', 'sessions', 'sess-scoped', 'hud-state.json');
      assert.equal(existsSync(metricsPath), true);
      assert.equal(existsSync(hudPath), true);

      const hud = JSON.parse(await readFile(hudPath, 'utf-8')) as {
        turn_count: number;
      };
      assert.equal(hud.turn_count, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('treats symlinked cwd aliases as authoritative for the same session state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-cwd-alias-'));
    const aliasCwd = `${cwd}-alias`;
    try {
      await symlink(cwd, aliasCwd, process.platform === 'win32' ? 'junction' : 'dir');
      await writeSessionStart(cwd, 'sess-alias');

      const usable = await readUsableSessionState(aliasCwd);
      assert.ok(usable);
      assert.equal(usable?.session_id, 'sess-alias');
      assert.equal(usable?.cwd, cwd);
    } finally {
      await rm(aliasCwd, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('writes session start/end lifecycle artifacts and archives session history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lifecycle-'));
    const sessionId = 'sess-lifecycle-1';
    try {
      await writeSessionStart(cwd, sessionId);

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, sessionId);
      assert.equal(state.cwd, cwd);
      assert.equal(state.pid, process.pid);
      assert.equal(isSessionStale(state), false);

      const sessionPath = join(cwd, '.omx', 'state', 'session.json');
      assert.equal(existsSync(sessionPath), true);

      await writeSessionEnd(cwd, sessionId);

      assert.equal(existsSync(sessionPath), false);

      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      assert.equal(existsSync(historyPath), true);

      const historyLines = (await readFile(historyPath, 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);

      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry;
      assert.equal(historyEntry.session_id, sessionId);
      assert.equal(historyEntry.cwd, cwd);
      assert.equal(typeof historyEntry.started_at, 'string');
      assert.equal(typeof historyEntry.ended_at, 'string');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      assert.equal(existsSync(dailyLogPath), true);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"event":"session_end"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not delete the current session pointer when ending a different session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-owner-'));
    try {
      await writeSessionStart(cwd, 'sess-current');
      const stateDir = join(cwd, '.omx', 'state');
      const sessionPath = join(stateDir, 'session.json');
      const currentHudPath = join(stateDir, 'sessions', 'sess-current', 'hud-state.json');
      const endingHudPath = join(stateDir, 'sessions', 'sess-ending', 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-ending'), { recursive: true });
      await writeFile(currentHudPath, JSON.stringify({ turn_count: 2 }), 'utf-8');
      await writeFile(endingHudPath, JSON.stringify({ turn_count: 1 }), 'utf-8');

      await writeSessionEnd(cwd, 'sess-ending');

      const state = await readSessionState(cwd);
      assert.equal(state?.session_id, 'sess-current');
      assert.equal(existsSync(sessionPath), true);
      assert.equal(existsSync(currentHudPath), true);
      assert.equal(existsSync(endingHudPath), false);

      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);
      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry & {
        preserved_active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'sess-ending');
      assert.equal(historyEntry.started_at, 'unknown');
      assert.equal(historyEntry.preserved_active_session_id, 'sess-current');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes canonical and native session-scoped hud state on session end', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-hud-cleanup-'));
    const canonicalSessionId = 'omx-launch-hud';
    const nativeSessionId = 'codex-native-hud';
    try {
      await writeSessionStart(cwd, canonicalSessionId, { nativeSessionId });
      const stateDir = join(cwd, '.omx', 'state');
      const rootHudPath = join(stateDir, 'hud-state.json');
      const canonicalHudPath = join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json');
      const nativeHudPath = join(stateDir, 'sessions', nativeSessionId, 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', canonicalSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', nativeSessionId), { recursive: true });
      await writeFile(rootHudPath, JSON.stringify({ last_turn_at: 'root', turn_count: 1 }), 'utf-8');
      await writeFile(canonicalHudPath, JSON.stringify({ last_turn_at: 'canonical', turn_count: 2 }), 'utf-8');
      await writeFile(nativeHudPath, JSON.stringify({ last_turn_at: 'native', turn_count: 9 }), 'utf-8');

      await writeSessionEnd(cwd, canonicalSessionId);

      assert.equal(existsSync(rootHudPath), false);
      assert.equal(existsSync(canonicalHudPath), false);
      assert.equal(existsSync(nativeHudPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves canonical session id while reconciling native SessionStart metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-reconcile-'));
    try {
      await writeSessionStart(cwd, 'omx-launch-1');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-1', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-launch-1');
      assert.equal(reconciled.native_session_id, 'codex-native-1');
      assert.equal(reconciled.pid, 54321);
      assert.equal(reconciled.platform, 'win32');

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-launch-1');
      assert.equal(persisted?.native_session_id, 'codex-native-1');
      assert.equal(persisted?.pid, 54321);

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"session_start_reconciled"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-1"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('starts a fresh native session while retaining the owner OMX launch session when native SessionStart changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fresh-'));
    try {
      await writeSessionStart(cwd, 'omx-old-session', {
        nativeSessionId: 'codex-native-old',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-new');
      assert.equal(reconciled.native_session_id, 'codex-native-new');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-old');
      assert.equal(reconciled.owner_omx_session_id, 'omx-old-session');
      assert.match(reconciled.native_session_switched_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(reconciled.pid, 54321);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-new');
      assert.equal(persisted?.native_session_id, 'codex-native-new');
      assert.equal(persisted?.previous_native_session_id, 'codex-native-old');
      assert.equal(persisted?.owner_omx_session_id, 'omx-old-session');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"event":"native_session_replaced"/);
      assert.match(dailyLog, /"event":"session_start"/);
      assert.match(dailyLog, /"previous_native_session_id":"codex-native-old"/);
      assert.match(dailyLog, /"native_session_id":"codex-native-new"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves existing native and tmux bindings on same-session start updates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-preserve-'));
    try {
      await writeSessionStart(cwd, 'omx-launch-1', {
        nativeSessionId: 'codex-native-1',
        tmuxSessionName: 'omx-detached-demo',
      });

      const withPane = await writeSessionStart(cwd, 'omx-launch-1', {
        tmuxSessionName: 'omx-detached-demo',
        tmuxPaneId: '%42',
      });

      assert.equal(withPane.native_session_id, 'codex-native-1');
      assert.equal(withPane.tmux_session_name, 'omx-detached-demo');
      assert.equal(withPane.tmux_pane_id, '%42');

      const withoutPane = await writeSessionStart(cwd, 'omx-launch-1', {
        tmuxSessionName: 'omx-detached-demo',
      });

      assert.equal(withoutPane.native_session_id, 'codex-native-1');
      assert.equal(withoutPane.tmux_session_name, 'omx-detached-demo');
      assert.equal(withoutPane.tmux_pane_id, '%42');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets an owner OMX launch session end the fresh native session it spawned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-end-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      await writeSessionEnd(cwd, 'omx-owner-session');

      assert.equal(await readSessionState(cwd), null);
      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      assert.equal(historyLines.length, 1);
      const historyEntry = JSON.parse(historyLines[0]) as SessionHistoryEntry & {
        active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'omx-owner-session');
      assert.equal(historyEntry.native_session_id, 'codex-native-new');
      assert.equal(historyEntry.active_session_id, 'codex-native-new');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves owner OMX metadata when reconciling the same fresh native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-reconcile-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-new');
      assert.equal(reconciled.native_session_id, 'codex-native-new');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-old');
      assert.equal(reconciled.owner_omx_session_id, 'omx-owner-session');
      assert.equal(reconciled.pid, process.pid);

      await writeSessionEnd(cwd, 'omx-owner-session');
      assert.equal(await readSessionState(cwd), null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('carries the owner OMX launch session across chained native SessionStart replacements', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-chain-'));
    try {
      await writeSessionStart(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-a',
      });
      await reconcileNativeSessionStart(cwd, 'codex-native-b', {
        pid: process.pid,
        platform: 'win32',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-c', {
        pid: process.pid,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-c');
      assert.equal(reconciled.native_session_id, 'codex-native-c');
      assert.equal(reconciled.previous_native_session_id, 'codex-native-b');
      assert.equal(reconciled.owner_omx_session_id, 'omx-owner-session');

      const dailyLogPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const dailyLog = await readFile(dailyLogPath, 'utf-8');
      assert.match(dailyLog, /"session_id":"omx-owner-session"/);
      assert.match(dailyLog, /"active_session_id":"codex-native-b"/);
      assert.match(dailyLog, /"previous_native_session_id":"codex-native-b"/);
      assert.match(dailyLog, /"replaced_by_native_session_id":"codex-native-c"/);

      await writeSessionEnd(cwd, 'omx-owner-session');
      assert.equal(await readSessionState(cwd), null);
      const historyLines = (await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8'))
        .trim()
        .split('\n')
        .filter(Boolean);
      const historyEntry = JSON.parse(historyLines.at(-1) ?? '{}') as SessionHistoryEntry & {
        active_session_id?: string;
      };
      assert.equal(historyEntry.session_id, 'omx-owner-session');
      assert.equal(historyEntry.native_session_id, 'codex-native-c');
      assert.equal(historyEntry.active_session_id, 'codex-native-c');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('starts a fresh canonical session when a non-OMX native session is replaced', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-non-omx-fresh-'));
    try {
      await writeSessionStart(cwd, 'codex-native-old', {
        nativeSessionId: 'codex-native-old',
      });

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-native-new');
      assert.equal(reconciled.native_session_id, 'codex-native-new');
      assert.equal(reconciled.previous_native_session_id, undefined);
      assert.equal(reconciled.pid, 54321);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-new');
      assert.equal(persisted?.native_session_id, 'codex-native-new');
      assert.equal(persisted?.previous_native_session_id, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves foreign selected-pointer evidence instead of replacing it during native reconciliation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-foreign-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
        pid: process.pid,
        platform: 'win32',
      }), 'utf-8');

      await assert.rejects(
        reconcileNativeSessionStart(cwd, 'codex-fallback-1', { platform: 'win32' }),
        (error: unknown) => isSessionPointerLaunchAbort(error)
          && error.code === 'session_pointer_unusable'
          && error.pointerStatus === 'foreign-cwd',
      );
      assert.equal(await readFile(statePath, 'utf-8'), JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
        pid: process.pid,
        platform: 'win32',
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats invalid session JSON as absent state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-invalid-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, '{ not-json', 'utf-8');
      const state = await readSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its recorded cwd points at another worktree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-mismatched-cwd-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const state = await readUsableSessionState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores session.json when its PID identity is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-stale-pointer-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-stale-pointer',
        cwd,
        pid: 4242,
        pid_start_ticks: 11,
        pid_cmdline: 'node omx',
      }), 'utf-8');

      const state = await readUsableSessionState(cwd, {
        platform: 'linux',
        isPidAlive: () => true,
        readLinuxIdentity: () => ({ startTicks: 22, cmdline: 'node omx' }),
      });
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks dead PIDs as stale', () => {
    const impossiblePid = Number.MAX_SAFE_INTEGER;
    const stale = isSessionStale({
      session_id: 'sess-stale',
      started_at: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      pid: impossiblePid,
    });
    assert.equal(stale, true);
  });
});

describe('isSessionStale', () => {
  it('returns false for a live Linux process when identity matches', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, false);
  });

  it('returns true for PID reuse on Linux when start ticks mismatch', () => {
    const state = makeState({
      pid_start_ticks: 111,
      pid_cmdline: 'node omx',
    });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 222, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when identity metadata is missing', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => ({ startTicks: 111, cmdline: 'node omx' }),
    });

    assert.equal(stale, true);
  });

  it('returns true on Linux when live identity cannot be read', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, true);
  });

  it('returns true when PID is not alive', () => {
    const state = makeState({ pid_start_ticks: 111 });

    const stale = isSessionStale(state, {
      platform: 'linux',
      isPidAlive: () => false,
    });

    assert.equal(stale, true);
  });

  it('falls back to PID liveness on non-Linux platforms', () => {
    const state = makeState();

    const stale = isSessionStale(state, {
      platform: 'darwin',
      isPidAlive: () => true,
      readLinuxIdentity: () => null,
    });

    assert.equal(stale, false);
  });
});

describe('session pointer transaction', () => {
  it('makes root resolution failures pathless typed launch aborts', async () => {
    await assert.rejects(
      writeSessionStart('bad\0cwd', 'sess-context'),
      (error: unknown) => isSessionPointerLaunchAbort(error)
        && error.code === 'session_pointer_context_failure'
        && error.operation === 'pointer-context-resolve'
        && !('pointerPath' in error),
    );
  });

  it('classifies only the exact selected pointer as absent, usable, stale, indeterminate, malformed, or foreign', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-pointer-status-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await withPointerDependencies({
        probePid: () => 'alive',
        readProcessIdentity: () => matchingProcessIdentity(),
      }, async () => {
        assert.equal((await readSessionPointer(context)).status, 'absent');
        await mkdir(context.baseStateDir, { recursive: true });
        await writeFile(context.sessionPath, JSON.stringify({
          session_id: 'sess-usable',
          started_at: '2026-07-14T00:00:00.000Z',
          cwd,
          pid: process.pid,
          platform: 'linux',
          pid_start_ticks: 1,
        }), 'utf-8');
        assert.equal((await readSessionPointer(context)).status, 'usable');

        __setSessionPointerTransactionDependenciesForTests({
          probePid: () => 'dead',
          readProcessIdentity: () => matchingProcessIdentity(),
        });
        assert.equal((await readSessionPointer(context)).status, 'stale-dead');

        __setSessionPointerTransactionDependenciesForTests({
          probePid: () => 'indeterminate',
          readProcessIdentity: () => matchingProcessIdentity(),
        });
        assert.equal((await readSessionPointer(context)).status, 'identity-indeterminate');

        await writeFile(context.sessionPath, '{ not-json', 'utf-8');
        assert.equal((await readSessionPointer(context)).status, 'malformed');
        await writeFile(context.sessionPath, JSON.stringify({
          session_id: 'sess-foreign',
          started_at: '2026-07-14T00:00:00.000Z',
          cwd: join(cwd, '..', 'foreign-worktree'),
          pid: process.pid,
          platform: 'win32',
        }), 'utf-8');
        assert.equal((await readSessionPointer(context)).status, 'foreign-cwd');
      });
    } finally {
      __resetSessionPointerTransactionDependenciesForTests();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('maps only ESRCH to a definitely dead default PID probe', () => {
    const alive = __createDefaultPidProbeForTests(() => {});
    const esrch = __createDefaultPidProbeForTests(() => { throw codedError('ESRCH'); });
    const eperm = __createDefaultPidProbeForTests(() => { throw codedError('EPERM'); });
    const unknown = __createDefaultPidProbeForTests(() => { throw codedError('EACCES'); });
    const noCode = __createDefaultPidProbeForTests(() => { throw new Error('unknown'); });
    const primitive = __createDefaultPidProbeForTests(() => { throw 'unknown'; });
    assert.equal(alive(1), 'alive');
    assert.equal(esrch(1), 'dead');
    assert.equal(eperm(1), 'indeterminate');
    assert.equal(unknown(1), 'indeterminate');
    assert.equal(noCode(1), 'indeterminate');
    assert.equal(primitive(1), 'indeterminate');
  });

  it('never reaps dead, reused, indeterminate, missing, or malformed lock evidence', async () => {
    const cases: Array<{
      name: string;
      owner?: Record<string, unknown>;
      probePid: 'dead' | 'alive' | 'indeterminate';
      identity?: {
        status: 'matching' | 'reused' | 'indeterminate';
        startTicks?: number;
        cmdlineHash?: string;
      };
      expected: string;
    }> = [
      { name: 'dead', owner: validLockOwner(), probePid: 'dead', expected: 'dead' },
      { name: 'reused', owner: validLockOwner(), probePid: 'alive', identity: { status: 'reused', startTicks: 2 }, expected: 'reused' },
      { name: 'indeterminate-probe', owner: validLockOwner(), probePid: 'indeterminate', expected: 'identity-indeterminate' },
      { name: 'indeterminate-identity', owner: validLockOwner(), probePid: 'alive', identity: { status: 'indeterminate' }, expected: 'identity-indeterminate' },
      { name: 'unsubstantiated-reuse', owner: validLockOwner(), probePid: 'alive', identity: { status: 'reused', startTicks: 1 }, expected: 'identity-indeterminate' },
      { name: 'missing-required-hash', owner: validLockOwner({ pid_cmdline_hash: 'a'.repeat(64) }), probePid: 'alive', identity: matchingProcessIdentity(), expected: 'identity-indeterminate' },
      { name: 'missing', probePid: 'alive', expected: 'missing' },
      { name: 'malformed', owner: { version: 1 }, probePid: 'alive', expected: 'malformed' },
    ];

    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-lock-${testCase.name}-`));
      try {
        const context = resolveSessionPointerContext(cwd);
        await mkdir(context.lockPath, { recursive: true });
        if (testCase.owner) {
          await writeFile(join(context.lockPath, 'owner.json'), JSON.stringify(testCase.owner), 'utf-8');
        }
        const before = await readdir(context.lockPath);
        await withPointerDependencies({
          token: () => TEST_TOKEN,
          probePid: () => testCase.probePid,
          readProcessIdentity: () => testCase.identity ?? matchingProcessIdentity(),
        }, async () => {
          await assert.rejects(
            writeSessionStart(cwd, 'sess-lock', { platform: 'win32' }),
            (error: unknown) => isSessionPointerLaunchAbort(error)
              && error.code === 'session_pointer_lock_recovery_required'
              && error.lockOwnerStatus === testCase.expected,
          );
        });
        assert.deepEqual(await readdir(context.lockPath), before);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('retries a positively matching live owner with the bounded 25/50/100 schedule before timing out', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-timeout-'));
    try {
      await writeLockOwner(cwd, validLockOwner());
      const delays: number[] = [];
      let now = 0;
      await withPointerDependencies({
        nowMs: () => now,
        sleep: async (ms) => { delays.push(ms); now += ms; },
        token: () => TEST_TOKEN,
        probePid: () => 'alive',
        readProcessIdentity: () => matchingProcessIdentity(),
      }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-timeout', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_lock_timeout'
            && error.lockOwnerStatus === 'live',
        );
      });
      assert.deepEqual(delays.slice(0, 3), [25, 50, 100]);
      assert.equal(delays.at(-1), 25);
      assert.equal(existsSync(resolveSessionPointerContext(cwd).lockPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rolls back only its unpublished owner artifacts and reports rollback ambiguity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-publish-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await withPointerDependencies({
        token: () => TEST_TOKEN,
        fs: {
          writeFile: async (path, data, options) => {
            if (path.endsWith(`owner.${TEST_TOKEN}.tmp`)) throw new Error('owner write failure');
            await writeFile(path, data, options);
          },
        },
      }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-owner-publish', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_io_failure'
            && error.operation === 'lock-owner-publish',
        );
      });
      assert.equal(existsSync(context.lockPath), false);

      await withPointerDependencies({
        token: () => TEST_TOKEN,
        fs: {
          writeFile: async (path, data, options) => {
            if (path.endsWith(`owner.${TEST_TOKEN}.tmp`)) throw new Error('owner write failure');
            await writeFile(path, data, options);
          },
          rmdir: async (path) => {
            if (path === context.lockPath) throw new Error('keep lock evidence');
            await rm(path, { recursive: false });
          },
        },
      }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-owner-residue', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_lock_recovery_required'
            && error.primaryOperation === 'lock-owner-publish'
            && error.secondaryFailures?.[0]?.phase === 'remove-unpublished-lock',
        );
      });
      assert.equal(existsSync(context.lockPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('types state-directory, pointer-read, owner-sync, owner-rename, and invalid-token failures before commit', async () => {
    const failures = [
      {
        name: 'state-dir',
        operation: 'state-dir-create',
        dependencies: (context: ReturnType<typeof resolveSessionPointerContext>) => ({
          fs: {
            mkdir: async (path: string, options?: { recursive?: boolean }) => {
              if (path === context.baseStateDir) throw new Error('state directory failure');
              await mkdir(path, options);
            },
          },
        }),
      },
      {
        name: 'pointer-read',
        operation: 'pointer-read',
        dependencies: (context: ReturnType<typeof resolveSessionPointerContext>) => ({
          token: () => TEST_TOKEN,
          fs: {
            readFile: async (path: string, encoding: 'utf8') => {
              if (path === context.sessionPath) throw new Error('pointer read failure');
              return await readFile(path, encoding);
            },
          },
        }),
      },
      {
        name: 'owner-sync',
        operation: 'lock-owner-publish',
        dependencies: (context: ReturnType<typeof resolveSessionPointerContext>) => ({
          token: () => TEST_TOKEN,
          fs: {
            openAndSync: async (path: string) => {
              if (path === join(context.lockPath, `owner.${TEST_TOKEN}.tmp`)) throw new Error('owner sync failure');
            },
          },
        }),
      },
      {
        name: 'owner-rename',
        operation: 'lock-owner-publish',
        dependencies: (context: ReturnType<typeof resolveSessionPointerContext>) => ({
          token: () => TEST_TOKEN,
          fs: {
            rename: async (from: string, to: string) => {
              if (from === join(context.lockPath, `owner.${TEST_TOKEN}.tmp`)) throw new Error('owner rename failure');
              await rename(from, to);
            },
          },
        }),
      },
    ] as const;

    for (const failure of failures) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-${failure.name}-`));
      try {
        const context = resolveSessionPointerContext(cwd);
        await withPointerDependencies(failure.dependencies(context), async () => {
          await assert.rejects(
            writeSessionStart(cwd, 'sess-precommit', { platform: 'win32' }),
            (error: unknown) => isSessionPointerLaunchAbort(error)
              && error.code === 'session_pointer_io_failure'
              && error.operation === failure.operation,
          );
        });
        assert.equal(existsSync(context.lockPath), false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-invalid-token-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await withPointerDependencies({ token: () => 'bad' }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-invalid-token', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_io_failure'
            && error.operation === 'lock-owner-publish',
        );
      });
      assert.equal(existsSync(context.lockPath), false);
      assert.equal(existsSync(`${context.sessionPath}.tmp-bad`), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('types pointer write, sync, and rename failures and removes only the owned temporary file', async () => {
    const phases = [
      { operation: 'pointer-temp-write', fail: 'write' },
      { operation: 'pointer-fsync', fail: 'sync' },
      { operation: 'pointer-rename', fail: 'rename' },
    ] as const;
    for (const phase of phases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-${phase.fail}-`));
      try {
        const context = resolveSessionPointerContext(cwd);
        const tempPath = `${context.sessionPath}.tmp-${TEST_TOKEN}`;
        await withPointerDependencies({
          token: () => TEST_TOKEN,
          fs: {
            writeFile: async (path, data, options) => {
              await writeFile(path, data, options);
              if (phase.fail === 'write' && path === tempPath) throw new Error('pointer write failure');
            },
            openAndSync: async (path) => {
              if (phase.fail === 'sync' && path === tempPath) throw new Error('pointer sync failure');
            },
            rename: async (from, to) => {
              if (phase.fail === 'rename' && from === tempPath && to === context.sessionPath) {
                throw new Error('pointer rename failure');
              }
              await rename(from, to);
            },
          },
        }, async () => {
          await assert.rejects(
            writeSessionStart(cwd, 'sess-failure', { platform: 'win32' }),
            (error: unknown) => isSessionPointerLaunchAbort(error)
              && error.code === 'session_pointer_io_failure'
              && error.operation === phase.operation,
          );
        });
        assert.equal(existsSync(tempPath), false);
        assert.equal(existsSync(context.lockPath), false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('preserves owned pointer residue and ordered cleanup evidence when cleanup or release cannot complete', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-pointer-residue-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const tempPath = `${context.sessionPath}.tmp-${TEST_TOKEN}`;
      await withPointerDependencies({
        token: () => TEST_TOKEN,
        fs: {
          writeFile: async (path, data, options) => {
            await writeFile(path, data, options);
            if (path === tempPath) throw new Error('pointer write failure');
          },
          unlink: async (path) => {
            if (path === tempPath) throw new Error('pointer temp cleanup failure');
            await rm(path, { force: false });
          },
          rmdir: async (path) => {
            if (path.endsWith(`.release-${TEST_TOKEN}`)) throw new Error('release cleanup failure');
            await rm(path, { recursive: false });
          },
        },
      }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-residue', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_lock_recovery_required'
            && error.primaryOperation === 'pointer-temp-write'
            && error.secondaryFailures?.map((failure) => failure.phase).join(',') === 'remove-pointer-temp,remove-release-dir'
            && error.secondaryFailures?.[0]?.evidencePath === tempPath,
        );
      });
      assert.equal(existsSync(tempPath), true);
      assert.equal(existsSync(`${context.lockPath}.release-${TEST_TOKEN}`), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('leaves foreign pointer temps inert and a successor commits after explicit lock recovery', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-pointer-successor-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownTempPath = `${context.sessionPath}.tmp-${TEST_TOKEN}`;
      const foreignTempPath = `${context.sessionPath}.tmp-${FOREIGN_TOKEN}`;
      await mkdir(context.baseStateDir, { recursive: true });
      await writeFile(foreignTempPath, 'foreign transaction evidence', 'utf-8');
      await withPointerDependencies({
        token: () => TEST_TOKEN,
        fs: {
          writeFile: async (path, data, options) => {
            await writeFile(path, data, options);
            if (path === ownTempPath) throw new Error('pointer write failure');
          },
          unlink: async (path) => {
            if (path === ownTempPath) throw new Error('keep own residue');
            await rm(path, { force: false });
          },
          rename: async (from, to) => {
            if (from === context.lockPath) throw new Error('preserve canonical lock');
            await rename(from, to);
          },
        },
      }, async () => {
        await assert.rejects(writeSessionStart(cwd, 'sess-first', { platform: 'win32' }), isSessionPointerLaunchAbort);
      });
      assert.equal(existsSync(foreignTempPath), true);
      assert.equal(existsSync(context.lockPath), true);

      // This is documented stopped-session operator recovery, deliberately not
      // product transaction behavior.
      await rm(context.lockPath, { recursive: true, force: true });
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN }, async () => {
        await writeSessionStart(cwd, 'sess-successor', { platform: 'win32' });
      });
      assert.equal((await readSessionState(cwd))?.session_id, 'sess-successor');
      assert.equal(existsSync(ownTempPath), true);
      assert.equal(existsSync(foreignTempPath), true);
      assert.equal(existsSync(context.lockPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('binds an owner alias only on a verified same-native/absent transition and never during replacement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-alias-'));
    try {
      const nativeOnly = await reconcileNativeSessionStart(cwd, 'native-first', {
        platform: 'win32',
        ownerOmxSessionId: 'omx-owner',
      });
      assert.equal(nativeOnly.owner_omx_session_id, undefined);

      await withOwnerEnvironment('omx-owner', async () => {
        const bound = await reconcileNativeSessionStart(cwd, 'native-first', {
          platform: 'win32',
          ownerAliasVerified: true,
        });
        assert.equal(bound.session_id, 'native-first');
        assert.equal(bound.owner_omx_session_id, 'omx-owner');

        const replacement = await reconcileNativeSessionStart(cwd, 'native-second', {
          platform: 'win32',
          ownerAliasVerified: true,
        });
        assert.equal(replacement.session_id, 'native-second');
        assert.equal(replacement.owner_omx_session_id, 'omx-owner');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves pointer evidence when history cannot be appended and rejects unusable end states before history or HUD cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-preserve-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeSessionStart(cwd, 'sess-history', { platform: 'win32' });
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
      await rm(join(cwd, '.omx', 'logs'), { recursive: true, force: true });
      await writeFile(join(cwd, '.omx', 'logs'), 'not-a-directory', 'utf-8');
      await assert.rejects(writeSessionEnd(cwd, 'sess-history'));
      assert.equal((await readSessionState(cwd))?.session_id, 'sess-history');
      await rm(join(cwd, '.omx', 'logs'), { force: true });

      await writeFile(context.sessionPath, '{ malformed', 'utf-8');
      await assert.rejects(
        writeSessionEnd(cwd, 'sess-history'),
        (error: unknown) => isSessionPointerLaunchAbort(error)
          && error.code === 'session_pointer_unusable'
          && error.pointerStatus === 'malformed',
      );
      assert.equal(await readFile(context.sessionPath, 'utf-8'), '{ malformed');
      assert.equal(existsSync(join(cwd, '.omx', 'logs', 'session-history.jsonl')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('prompt provenance diagnostics', () => {
  it('writes exactly one redacted record at the supplied selected root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-provenance-log-'));
    try {
      const stateDir = join(cwd, 'selected', '.omx', 'state');
      await appendPromptSessionProvenanceRejection({
        cwd,
        baseStateDir: stateDir,
        rootSource: 'cwd-default',
        sessionPath: join(stateDir, 'session.json'),
        lockPath: join(stateDir, 'session.json.lock'),
      }, {
        reason: 'payload_session_invalid',
        producer: 'native',
        selectedRootStatus: 'malformed',
        timestamp: '2026-07-14T00:00:00.000Z',
      });
      const log = await readFile(join(cwd, 'selected', '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`), 'utf-8');
      assert.equal(log.trim().split('\n').length, 1);
      assert.match(log, /"event":"prompt_session_provenance_rejected"/);
      assert.equal(log.includes(cwd), false);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`)), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
