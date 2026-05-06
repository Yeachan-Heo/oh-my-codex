import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resetSessionMetrics,
  reconcileNativeSessionStart,
  writeSessionStart,
  writeSessionEnd,
  readSessionState,
  readUsableSessionState,
  isSessionStale,
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

  it('starts a fresh canonical session when a new native SessionStart arrives after an earlier native session', async () => {
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
      assert.equal(reconciled.pid, 54321);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-new');
      assert.equal(persisted?.native_session_id, 'codex-native-new');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to a fresh canonical session when reconciling without authoritative launch state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fallback-'));
    try {
      const statePath = join(cwd, '.omx', 'state', 'session.json');
      await resetSessionMetrics(cwd);
      await writeFile(statePath, JSON.stringify({
        session_id: 'sess-other-worktree',
        cwd: join(cwd, '..', 'different-worktree'),
      }), 'utf-8');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-fallback-1', {
        pid: 67890,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'codex-fallback-1');
      assert.equal(reconciled.native_session_id, 'codex-fallback-1');
      assert.equal(reconciled.pid, 67890);
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
