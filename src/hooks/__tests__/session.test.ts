import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __createDefaultPidProbeForTests,
  appendPromptSessionProvenanceRejection,
  closeLaunchSessionBindingOnce,
  establishLaunchSessionBinding,
  finalizeBoundOnce,
  __resetSessionPointerTransactionDependenciesForTests,
  __setSessionPointerTransactionDependenciesForTests,
  inspectSessionPointerLock,
  isSessionPointerLaunchAbort,
  isSessionStale,
  readSessionPointer,
  readSessionState,
  readUsableSessionState,
  reconcileNativeSessionStart,
  recoverSessionPointerLock,
  resetSessionMetrics,
  resolveSessionPointerContext,
  writeSessionEnd,
  updateDetachedSessionMetadata,
  writeSessionStart,
  type LaunchSessionBinding,
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

async function linuxProcessStartTicks(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf-8');
  const closingParen = stat.lastIndexOf(')');
  assert.notEqual(closingParen, -1);
  const fieldsAfterCommand = stat.slice(closingParen + 2).trim().split(/\s+/);
  const startTicks = Number.parseInt(fieldsAfterCommand[19] ?? '', 10);
  assert.equal(Number.isInteger(startTicks), true);
  return startTicks;
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
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, sessionId);
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;

      const state = await readSessionState(cwd);
      assert.ok(state);
      assert.equal(state.session_id, sessionId);
      assert.equal(state.cwd, cwd);
      assert.equal(state.pid, process.pid);
      assert.equal(isSessionStale(state), false);

      const sessionPath = join(cwd, '.omx', 'state', 'session.json');
      assert.equal(existsSync(sessionPath), true);

      await finalizeBoundOnce(binding, 'test');

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
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits the session-end warning only after successful end finalization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-durability-'));
    const originalWrite = process.stderr.write;
    const warnings: string[] = [];
    process.stderr.write = ((value: string) => {
      warnings.push(value);
      return true;
    }) as typeof process.stderr.write;
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-end-durability');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      await writeSessionEnd(cwd, 'sess-end-durability', {
        binding,
        context: binding.context,
        platform: 'win32',
        regularFileSync: async () => { throw codedError('EPERM'); },
      });
      assert.deepEqual(warnings, [
        '[omx] warning: Windows EPERM regular-file fsync unsupported in session pointer end; operation succeeded with degraded durability.\n',
      ]);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      process.stderr.write = originalWrite;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps session-end durability warnings silent when finalization or release fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-durability-failure-'));
    const originalWrite = process.stderr.write;
    const warnings: string[] = [];
    process.stderr.write = ((value: string) => {
      warnings.push(value);
      return true;
    }) as typeof process.stderr.write;
    const regularFileSync = async () => { throw codedError('EPERM'); };
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-end-release-failure');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const establishedBinding = binding;
      await withPointerDependencies({
        fs: {
          rmdir: async () => { throw new Error('release failure'); },
        },
      }, async () => {
        await assert.rejects(writeSessionEnd(cwd, 'sess-end-release-failure', {
          binding: establishedBinding,
          context: establishedBinding.context,
          platform: 'win32',
          regularFileSync,
        }));
      });
      assert.deepEqual(warnings, []);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      process.stderr.write = originalWrite;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not delete the current session pointer when ending a different session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-owner-'));
    try {
      await writeSessionStart(cwd, 'sess-current');
      const beforePointer = await readFile(resolveSessionPointerContext(cwd).sessionPath, 'utf-8');
      const stateDir = join(cwd, '.omx', 'state');
      const sessionPath = join(stateDir, 'session.json');
      const currentHudPath = join(stateDir, 'sessions', 'sess-current', 'hud-state.json');
      const endingHudPath = join(stateDir, 'sessions', 'sess-ending', 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(join(stateDir, 'sessions', 'sess-ending'), { recursive: true });
      await writeFile(currentHudPath, JSON.stringify({ turn_count: 2 }), 'utf-8');
      await writeFile(endingHudPath, JSON.stringify({ turn_count: 1 }), 'utf-8');

      await assert.rejects(() => writeSessionEnd(cwd, 'sess-ending'), isSessionPointerLaunchAbort);

      const state = await readSessionState(cwd);
      assert.equal(state?.session_id, 'sess-current');
      assert.equal(await readFile(sessionPath, 'utf-8'), beforePointer);
      assert.equal(existsSync(currentHudPath), true);
      assert.equal(existsSync(endingHudPath), true);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', 'session-history.jsonl')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('removes canonical and native session-scoped hud state on session end', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-hud-cleanup-'));
    const canonicalSessionId = 'omx-launch-hud';
    const nativeSessionId = 'codex-native-hud';
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, canonicalSessionId, { nativeSessionId });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const stateDir = join(cwd, '.omx', 'state');
      const rootHudPath = join(stateDir, 'hud-state.json');
      const canonicalHudPath = join(stateDir, 'sessions', canonicalSessionId, 'hud-state.json');
      const nativeHudPath = join(stateDir, 'sessions', nativeSessionId, 'hud-state.json');
      await mkdir(join(stateDir, 'sessions', canonicalSessionId), { recursive: true });
      await mkdir(join(stateDir, 'sessions', nativeSessionId), { recursive: true });
      await writeFile(rootHudPath, JSON.stringify({ last_turn_at: 'root', turn_count: 1 }), 'utf-8');
      await writeFile(canonicalHudPath, JSON.stringify({ last_turn_at: 'canonical', turn_count: 2 }), 'utf-8');
      await writeFile(nativeHudPath, JSON.stringify({ last_turn_at: 'native', turn_count: 9 }), 'utf-8');

      await finalizeBoundOnce(binding, 'test');

      assert.equal(existsSync(rootHudPath), false);
      assert.equal(existsSync(canonicalHudPath), false);
      assert.equal(existsSync(nativeHudPath), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves canonical session id while reconciling native SessionStart metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-reconcile-'));
    try {
      const established = await writeSessionStart(cwd, 'omx-launch-1');

      const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-1', {
        pid: 54321,
        platform: 'win32',
      });

      assert.equal(reconciled.session_id, 'omx-launch-1');
      assert.equal(reconciled.native_session_id, 'codex-native-1');
      assert.equal(reconciled.pid, 54321);
      assert.equal(reconciled.platform, 'win32');
      assert.equal(reconciled.launch_lineage_token, established.launch_lineage_token);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-launch-1');
      assert.equal(persisted?.native_session_id, 'codex-native-1');
      assert.equal(persisted?.pid, 54321);
      assert.equal(persisted?.launch_lineage_token, established.launch_lineage_token);

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

  it('routes existing detached metadata updates through the exact binding', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-preserve-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-launch-1', {
        nativeSessionId: 'codex-native-1',
        tmuxSessionName: 'omx-detached-demo',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;

      const withPaneResult = await updateDetachedSessionMetadata(binding, {
        tmuxSessionName: 'omx-detached-demo',
        tmuxPaneId: '%42',
      });
      assert.equal(withPaneResult.kind, 'committed-released');
      const withPane = await readSessionState(cwd);
      assert.equal(withPane?.native_session_id, 'codex-native-1');
      assert.equal(withPane?.tmux_session_name, 'omx-detached-demo');
      assert.equal(withPane?.tmux_pane_id, '%42');

      const withoutPaneResult = await updateDetachedSessionMetadata(binding, {
        tmuxSessionName: 'omx-detached-demo',
      });
      assert.equal(withoutPaneResult.kind, 'committed-released');
      const withoutPane = await readSessionState(cwd);
      assert.equal(withoutPane?.native_session_id, 'codex-native-1');
      assert.equal(withoutPane?.tmux_session_name, 'omx-detached-demo');
      assert.equal(withoutPane?.tmux_pane_id, '%42');
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('lets an owner OMX launch session end the fresh native session it spawned', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-end-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      await reconcileNativeSessionStart(cwd, 'codex-native-new', {
        pid: process.pid,
        platform: 'win32',
      });

      await finalizeBoundOnce(binding, 'test');

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
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves owner OMX metadata when reconciling the same fresh native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-reconcile-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
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

      await finalizeBoundOnce(binding, 'test');
      assert.equal(await readSessionState(cwd), null);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('carries the owner OMX launch session across chained native SessionStart replacements', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-chain-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-a',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
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

      await finalizeBoundOnce(binding, 'test');
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
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains wrapper lineage when a wrapper-owned native session is replaced', async () => {
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
      assert.equal(reconciled.previous_native_session_id, 'codex-native-old');
      assert.equal(reconciled.owner_omx_session_id, 'codex-native-old');
      assert.equal(reconciled.pid, 54321);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-new');
      assert.equal(persisted?.native_session_id, 'codex-native-new');
      assert.equal(persisted?.previous_native_session_id, 'codex-native-old');
      assert.equal(persisted?.owner_omx_session_id, 'codex-native-old');
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

  it('atomically quarantines dead pre-rename temporary owner evidence and stays idempotent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-dead-temp-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(join(context.lockPath, `owner.${TEST_TOKEN}.tmp`), JSON.stringify(validLockOwner()), 'utf-8');
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead' }, async () => {
        const inspected = await inspectSessionPointerLock(cwd);
        assert.equal(inspected.status, 'dead');
        assert.equal(inspected.evidenceSource, 'owner-temp');
        assert.equal(inspected.safeToRecover, true);
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true);
        assert.equal(recovered.action, 'quarantined');
        assert.equal(existsSync(context.lockPath), false);
        assert.equal(existsSync(recovered.quarantinePath!), true);
        const repeated = await recoverSessionPointerLock(cwd);
        assert.equal(repeated.recovered, false);
        assert.equal(repeated.action, 'none');
        assert.equal(repeated.status, 'absent');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not recover a dead canonical owner because owner.json is not an exact acquisition claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-dead-canonical-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead' }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.status, 'dead');
        assert.equal(recovered.evidenceSource, 'owner.json');
        assert.equal(recovered.safeToRecover, false);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.equal(existsSync(context.lockPath), true);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('distinguishes a paused live pre-rename owner from the same owner after SIGKILL', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('Linux process start identity is required for deterministic PID reuse protection.');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-sigkill-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });
    try {
      assert.ok(child.pid);
      await once(child, 'spawn');
      const context = resolveSessionPointerContext(cwd);
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(join(context.lockPath, `owner.${TEST_TOKEN}.tmp`), JSON.stringify(validLockOwner({
        pid: child.pid,
        pid_start_ticks: await linuxProcessStartTicks(child.pid),
      })), 'utf-8');

      const paused = await recoverSessionPointerLock(cwd);
      assert.equal(paused.status, 'live');
      assert.equal(paused.recovered, false);
      assert.equal(paused.action, 'none');
      assert.equal(existsSync(context.lockPath), true);

      child.kill('SIGKILL');
      const [exitCode, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
      assert.equal(exitCode, null);
      assert.equal(signal, 'SIGKILL');

      const orphaned = await recoverSessionPointerLock(cwd);
      assert.equal(orphaned.status, 'dead');
      assert.equal(orphaned.recovered, true);
      assert.equal(orphaned.action, 'quarantined');
      assert.equal(existsSync(context.lockPath), false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed for live pre-rename, PID reuse, malformed, and ambiguous lock evidence', async () => {
    const cases: Array<{ name: string; files: Array<[string, string]>; probePid: 'alive' | 'dead'; identity?: ReturnType<typeof matchingProcessIdentity> }> = [
      { name: 'live-temp', files: [[`owner.${TEST_TOKEN}.tmp`, JSON.stringify(validLockOwner())]], probePid: 'alive', identity: matchingProcessIdentity() },
      { name: 'reused', files: [['owner.json', JSON.stringify(validLockOwner())]], probePid: 'alive', identity: { status: 'matching', startTicks: 2 } },
      { name: 'malformed', files: [['owner.json', '{']], probePid: 'dead' },
      { name: 'ambiguous', files: [['owner.json', JSON.stringify(validLockOwner())], [`owner.${SUCCESSOR_TOKEN}.tmp`, JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN }))]], probePid: 'dead' },
    ];
    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-lock-recovery-${testCase.name}-`));
      try {
        const context = resolveSessionPointerContext(cwd);
        await mkdir(context.lockPath, { recursive: true });
        await Promise.all(testCase.files.map(async ([name, contents]) => await writeFile(join(context.lockPath, name), contents, 'utf-8')));
        await withPointerDependencies({
          token: () => SUCCESSOR_TOKEN,
          probePid: () => testCase.probePid,
          readProcessIdentity: () => testCase.identity ?? matchingProcessIdentity(),
        }, async () => {
          const before = await readdir(context.lockPath);
          const recovered = await recoverSessionPointerLock(cwd);
          assert.equal(recovered.recovered, false);
          assert.equal(recovered.action, 'none');
          assert.equal(recovered.safeToRecover, false);
          assert.deepEqual(await readdir(context.lockPath), before);
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('claims stale evidence before quarantine so a successor cannot be mistaken for it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(join(context.lockPath, `owner.${TEST_TOKEN}.tmp`), JSON.stringify(validLockOwner()), 'utf-8');
      const renames: Array<[string, string]> = [];
      let successorBlocked = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          rename: async (from, to) => {
            renames.push([from, to]);
            await rename(from, to);
            if (from.endsWith(`owner.${TEST_TOKEN}.tmp`)) {
              await assert.rejects(mkdir(context.lockPath), { code: 'EEXIST' });
              successorBlocked = true;
            }
          },
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true);
      });
      assert.equal(successorBlocked, true);
      assert.match(renames[0]![0], /owner\.transaction_token_123456\.tmp$/);
      assert.match(renames[0]![1], new RegExp(`owner\\.${TEST_TOKEN}\\.${SUCCESSOR_TOKEN}\\.recovery$`));
      assert.match(renames[1]![0], new RegExp(`owner\\.${TEST_TOKEN}\\.${SUCCESSOR_TOKEN}\\.recovery$`));
      assert.equal(renames[1]![1].includes('.quarantine.'), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not claim a successor lock when the inspected orphan is displaced before the exact temp rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-successor-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const staleTemp = join(context.lockPath, `owner.${TEST_TOKEN}.tmp`);
      const successorTemp = join(context.lockPath, `owner.${SUCCESSOR_TOKEN}.tmp`);
      const displacedPath = `${context.lockPath}.displaced`;
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(staleTemp, JSON.stringify(validLockOwner()), 'utf-8');
      let displaced = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          rename: async (from, to) => {
            if (!displaced && from === staleTemp) {
              displaced = true;
              await rename(context.lockPath, displacedPath);
              await mkdir(context.lockPath);
              await writeFile(successorTemp, JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })), 'utf-8');
            }
            await rename(from, to);
          },
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /changed before recovery claim/i);
      });
      assert.equal(displaced, true);
      assert.deepEqual(await readdir(context.lockPath), [`owner.${SUCCESSOR_TOKEN}.tmp`]);
      assert.equal(await readFile(successorTemp, 'utf-8'), JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not quarantine a successor live lock displaced into the canonical path after claim revalidation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-post-claim-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const staleTemp = join(context.lockPath, `owner.${TEST_TOKEN}.tmp`);
      const successorTemp = join(context.lockPath, `owner.${SUCCESSOR_TOKEN}.tmp`);
      const displacedPath = `${context.lockPath}.claimed-displaced`;
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(staleTemp, JSON.stringify(validLockOwner()), 'utf-8');
      let displaced = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          rmdir: async (path) => {
            if (!displaced && path === context.lockPath) {
              displaced = true;
              await rename(context.lockPath, displacedPath);
              await mkdir(context.lockPath);
              await writeFile(successorTemp, JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })), 'utf-8');
            }
            await rmdir(path);
          },
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /canonical lock directory was not empty/i);
        assert.ok(recovered.quarantinePath);
      });
      assert.equal(displaced, true);
      assert.deepEqual(await readdir(context.lockPath), [`owner.${SUCCESSOR_TOKEN}.tmp`]);
      assert.equal(await readFile(successorTemp, 'utf-8'), JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })));
    } finally {
      await rm(cwd, { recursive: true, force: true });
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

  it('publishes the owner and pointer on Windows when regular-file fsync reports EPERM', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-windows-eperm-'));
    let syncCalls = 0;
    const regularFileSync = async (platform: NodeJS.Platform) => {
      assert.equal(platform, 'win32');
      syncCalls += 1;
      throw codedError('EPERM');
    };
    try {
      const state = await writeSessionStart(cwd, 'sess-windows-eperm', {
        platform: 'win32',
        regularFileSync,
      });
      const context = resolveSessionPointerContext(cwd);
      assert.equal(state.session_id, 'sess-windows-eperm');
      assert.equal(syncCalls, 2, 'owner publication and pointer publication must both attempt fsync');
      assert.equal(existsSync(join(context.lockPath, 'owner.json')), false, 'lock owner is removed after commit');
      assert.equal(JSON.parse(await readFile(context.sessionPath, 'utf8')).session_id, 'sess-windows-eperm');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('emits one post-release warning for a degraded session start and stays silent for synced or failed transactions', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-durability-warning-'));
    const originalWrite = process.stderr.write;
    const warnings: Array<{ value: string; lockExists: boolean }> = [];
    let warningCwd = cwd;
    process.stderr.write = ((value: string) => {
      warnings.push({ value, lockExists: existsSync(resolveSessionPointerContext(warningCwd).lockPath) });
      return true;
    }) as typeof process.stderr.write;
    const regularFileSync = async () => { throw codedError('EPERM'); };
    try {
      await writeSessionStart(cwd, 'sess-degraded-start', { platform: 'win32', regularFileSync });
      assert.deepEqual(warnings, [{
        value: '[omx] warning: Windows EPERM regular-file fsync unsupported in session pointer start/reconcile; operation succeeded with degraded durability.\n',
        lockExists: false,
      }]);

      warnings.length = 0;
      const syncedCwd = join(cwd, 'synced');
      await mkdir(syncedCwd);
      warningCwd = syncedCwd;
      await writeSessionStart(syncedCwd, 'sess-synced-start', { platform: 'win32' });
      assert.deepEqual(warnings, []);
      const failedCwd = join(cwd, 'failed');
      await mkdir(failedCwd);
      warningCwd = failedCwd;

      await withPointerDependencies({
        fs: {
          rename: async (from, to) => {
            if (to === resolveSessionPointerContext(failedCwd).sessionPath) throw new Error('rename failure');
            await rename(from, to);
          },
        },
      }, async () => {
        await assert.rejects(writeSessionStart(failedCwd, 'sess-failed-start', { platform: 'win32', regularFileSync }));
      });
      assert.deepEqual(warnings, []);
    } finally {
      process.stderr.write = originalWrite;
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
              return 'synced' as const;
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
              return 'synced' as const;
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
      const established = await establishLaunchSessionBinding(cwd, 'sess-history', { platform: 'win32' });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true });
      await rm(join(cwd, '.omx', 'logs'), { recursive: true, force: true });
      await writeFile(join(cwd, '.omx', 'logs'), 'not-a-directory', 'utf-8');
      await assert.rejects(finalizeBoundOnce(established.binding, 'history-failure'));
      assert.equal((await readSessionState(cwd))?.session_id, 'sess-history');
      await rm(join(cwd, '.omx', 'logs'), { force: true });

      await writeFile(context.sessionPath, '{ malformed', 'utf-8');
      await assert.rejects(
        writeSessionEnd(cwd, 'sess-history', { binding: established.binding }),
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

describe('bound launch authority', () => {
  it('returns one private binding and only capability-free metadata updates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-authority-'));
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-authority');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      assert.match(established.binding.launchLineageToken, /^[A-Za-z0-9_-]{16,128}$/);
      assert.equal('handle' in established.binding, false);
      const metadata = await updateDetachedSessionMetadata(established.binding, {
        tmuxSessionName: 'omx-authority', tmuxPaneId: '%42',
      });
      assert.equal(metadata.kind, 'committed-released');
      assert.equal((await readSessionState(cwd))?.launch_lineage_token, established.binding.launchLineageToken);
      const firstFinalization = finalizeBoundOnce(established.binding, 'test');
      const secondFinalization = finalizeBoundOnce(established.binding, 'duplicate');
      assert.equal(firstFinalization, secondFinalization);
      const finalized = await firstFinalization;
      assert.equal(finalized.finalized, true);
      assert.equal(finalized.cleanup.comparison?.status, 'matched');
      assert.equal(existsSync(resolveSessionPointerContext(cwd).sessionPath), false);
      assert.equal((await closeLaunchSessionBindingOnce(established.binding)).status, 'closed');
      assert.equal((await closeLaunchSessionBindingOnce(established.binding)).status, 'closed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('anchors capability acquisition and finalization to context.baseStateDir rather than cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-selected-root-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const baseStateDir = join(cwd, 'selected', 'state');
      const context = {
        cwd,
        baseStateDir,
        rootSource: 'cwd-default' as const,
        sessionPath: join(baseStateDir, 'session.json'),
        lockPath: join(baseStateDir, 'session.json.lock'),
      };
      const established = await establishLaunchSessionBinding(cwd, 'sess-selected-root', { context });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      assert.equal(binding.context.baseStateDir, baseStateDir);
      assert.equal(existsSync(context.sessionPath), true);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'session.json')), false);
      assert.equal((await finalizeBoundOnce(binding, 'selected-root')).finalized, true);
      assert.equal(existsSync(context.sessionPath), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects forged and changed-incarnation detached metadata before lifecycle mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-metadata-hostile-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-metadata-hostile');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      const original = await readFile(context.sessionPath, 'utf-8');
      let mkdirCalls = 0;

      await withPointerDependencies({
        fs: { mkdir: async (path, options) => { mkdirCalls += 1; await mkdir(path, options); } },
      }, async () => {
        const forged = await updateDetachedSessionMetadata({ ...binding } as LaunchSessionBinding, { tmuxPaneId: '%forged' });
        assert.equal(forged.kind, 'precommit-aborted');
      });
      assert.equal(mkdirCalls, 0);
      assert.equal(await readFile(context.sessionPath, 'utf-8'), original);
      assert.equal(existsSync(context.lockPath), false);

      const parsed = JSON.parse(original) as Partial<SessionState>;
      const state: SessionState = { ...parsed, session_id: binding.canonicalSessionId } as SessionState;
      const changed = JSON.stringify({ ...state, started_at: '1999-01-01T00:00:00.000Z' }, null, 2);
      await writeFile(context.sessionPath, changed, 'utf-8');
      const denied = await updateDetachedSessionMetadata(binding, { tmuxPaneId: '%changed' });
      assert.equal(denied.kind, 'precommit-aborted');
      assert.equal(await readFile(context.sessionPath, 'utf-8'), changed);
      assert.equal(existsSync(context.lockPath), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rechecks supported directory identity under the metadata lock before pointer mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-metadata-race-'));
    const retainedCwd = `${cwd}-retained`;
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-metadata-race');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      const original = await readFile(context.sessionPath, 'utf-8');
      let replaced = false;

      let result: Awaited<ReturnType<typeof updateDetachedSessionMetadata>> | undefined;
      await withPointerDependencies({
        fs: {
          mkdir: async (path, options) => {
            if (!replaced && String(path) === context.baseStateDir) {
              replaced = true;
              await rename(cwd, retainedCwd);
              await mkdir(context.baseStateDir, { recursive: true });
              await writeFile(context.sessionPath, original, 'utf-8');
              return;
            }
            await mkdir(path, options);
          },
        },
      }, async () => { result = await updateDetachedSessionMetadata(binding as LaunchSessionBinding, { tmuxPaneId: '%race' }); });

      assert.equal(result?.kind, 'precommit-aborted');
      assert.equal(await readFile(context.sessionPath, 'utf-8'), original);
      assert.equal(await readFile(join(retainedCwd, '.omx', 'state', 'session.json'), 'utf-8'), original);
      assert.equal(existsSync(context.lockPath), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
      await rm(retainedCwd, { recursive: true, force: true });
    }
  });

  it('permits an ordinary absent launch when directory identity is unsupported', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-unsupported-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-unsupported', { platform: 'win32' });

      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      assert.deepEqual(binding.directoryIdentity, { kind: 'unsupported', reason: 'platform' });
      assert.equal((await readSessionState(cwd))?.session_id, 'sess-binding-unsupported');
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('establishment preflight is absent-only under the selected pointer lock and preserves every existing pointer byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-session-binding-preflight-'));
    try {
      const cases: Array<{ name: string; raw: string; probePid?: 'dead' | 'indeterminate' }> = [
        { name: 'usable', raw: JSON.stringify(makeState({ cwd: join(root, 'usable'), pid: process.pid, platform: 'linux', pid_start_ticks: 1 })) },
        { name: 'stale-dead', raw: JSON.stringify(makeState({ cwd: join(root, 'stale-dead'), pid: 424242, platform: 'linux', pid_start_ticks: 1 })), probePid: 'dead' },
        { name: 'malformed', raw: '{ malformed pointer' },
        { name: 'foreign', raw: JSON.stringify(makeState({ cwd: join(root, 'foreign', 'other'), platform: 'win32' })) },
        { name: 'indeterminate', raw: JSON.stringify(makeState({ cwd: join(root, 'indeterminate'), pid: 424242, platform: 'linux', pid_start_ticks: 1 })), probePid: 'indeterminate' },
      ];
      for (const testCase of cases) {
        const cwd = join(root, testCase.name);
        const context = resolveSessionPointerContext(cwd);
        const order: string[] = [];
        await mkdir(context.baseStateDir, { recursive: true });
        await writeFile(context.sessionPath, testCase.raw, 'utf-8');
        await withPointerDependencies({
          probePid: () => testCase.probePid ?? 'alive',
          readProcessIdentity: () => matchingProcessIdentity(),
          fs: {
            mkdir: async (path, options) => { order.push(`mkdir:${path}`); await mkdir(path, options); },
            readFile: async (path, encoding) => { order.push(`read:${path}`); return await readFile(path, encoding); },
            rename: async (from, to) => { order.push(`rename:${from}:${to}`); await rename(from, to); },
            unlink: async (path) => { order.push(`unlink:${path}`); await rm(path, { force: false }); },
          },
        }, async () => {
          const established = await establishLaunchSessionBinding(cwd, `sess-preflight-${testCase.name}`);
          assert.equal(established.kind, 'precommit-aborted', testCase.name);
        });
        assert.equal(await readFile(context.sessionPath, 'utf-8'), testCase.raw, testCase.name);
        assert.ok(order.indexOf(`mkdir:${context.lockPath}`) < order.indexOf(`read:${context.sessionPath}`), testCase.name);
        assert.equal(order.filter((entry) => entry === `rename:${context.sessionPath}`).length, 0, testCase.name);
        assert.equal(order.filter((entry) => entry === `unlink:${context.sessionPath}`).length, 0, testCase.name);
        assert.equal(existsSync(context.lockPath), false, testCase.name);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('denies an absent bound pointer without creating synthetic terminal history', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-absent-finalization-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-absent-finalization');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      await rm(context.sessionPath);
      const finalized = await finalizeBoundOnce(binding, 'absent');
      assert.equal(finalized.finalized, false);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', 'session-history.jsonl')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`)), true);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects unbound usable finalization before changing any lifecycle bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-unbound-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-unbound');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      const dailyPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const hudPath = join(cwd, '.omx', 'state', 'hud-state.json');
      const metricsPath = join(cwd, '.omx', 'metrics.json');
      await writeFile(historyPath, 'history-sentinel\n', 'utf-8');
      await writeFile(hudPath, 'hud-sentinel\n', 'utf-8');
      await writeFile(metricsPath, 'metrics-sentinel\n', 'utf-8');
      const before = {
        pointer: await readFile(context.sessionPath, 'utf-8'),
        history: await readFile(historyPath, 'utf-8'),
        daily: await readFile(dailyPath, 'utf-8'),
        hud: await readFile(hudPath, 'utf-8'),
        metrics: await readFile(metricsPath, 'utf-8'),
      };

      await assert.rejects(() => writeSessionEnd(cwd, 'sess-binding-unbound'), isSessionPointerLaunchAbort);

      assert.equal(await readFile(context.sessionPath, 'utf-8'), before.pointer);
      assert.equal(await readFile(historyPath, 'utf-8'), before.history);
      assert.equal(await readFile(dailyPath, 'utf-8'), before.daily);
      assert.equal(await readFile(hudPath, 'utf-8'), before.hud);
      assert.equal(await readFile(metricsPath, 'utf-8'), before.metrics);
      assert.equal(existsSync(context.lockPath), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a compatible tokenless pointer and refuses to establish cleanup authority from it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-tokenless-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await reconcileNativeSessionStart(cwd, 'native-compatible-tokenless');
      const beforeUpdate = await readFile(context.sessionPath, 'utf-8');
      await assert.rejects(
        () => writeSessionStart(cwd, 'native-compatible-tokenless', { tmuxPaneId: '%42' }),
        isSessionPointerLaunchAbort,
      );
      assert.equal((await readSessionState(cwd))?.launch_lineage_token, undefined);
      const afterUpdate = await readFile(context.sessionPath, 'utf-8');
      assert.equal(afterUpdate, beforeUpdate);

      const established = await establishLaunchSessionBinding(cwd, 'native-compatible-tokenless');
      assert.equal(established.kind, 'precommit-aborted');
      if (established.kind !== 'precommit-aborted') return;
      assert.equal(established.abort.committed, false);
      assert.equal(established.abort.code, 'session_pointer_owner_conflict');
      assert.equal((await readSessionState(cwd))?.launch_lineage_token, undefined);
      assert.equal(afterUpdate.includes('launch_lineage_token'), false);
      assert.equal(await readFile(context.sessionPath, 'utf-8'), afterUpdate);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a compatible malformed lineage token without granting cleanup authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-malformed-token-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const tokenless = await reconcileNativeSessionStart(cwd, 'native-compatible-malformed-token');
      await writeFile(context.sessionPath, JSON.stringify({ ...tokenless, launch_lineage_token: 'bad' }), 'utf-8');

      const beforeUpdate = await readFile(context.sessionPath, 'utf-8');
      await assert.rejects(
        () => writeSessionStart(cwd, 'native-compatible-malformed-token', { tmuxPaneId: '%42' }),
        isSessionPointerLaunchAbort,
      );
      const afterUpdate = await readFile(context.sessionPath, 'utf-8');
      assert.equal(afterUpdate, beforeUpdate);
      assert.match(afterUpdate, /"launch_lineage_token":"bad"|"launch_lineage_token": "bad"/);
      assert.equal((await reconcileNativeSessionStart(cwd, 'native-compatible-malformed-token')).launch_lineage_token, 'bad');
      const beforeEstablishment = await readFile(context.sessionPath, 'utf-8');

      const established = await establishLaunchSessionBinding(cwd, 'native-compatible-malformed-token');
      assert.equal(established.kind, 'precommit-aborted');
      if (established.kind !== 'precommit-aborted') return;
      assert.equal(established.abort.committed, false);
      assert.equal(await readFile(context.sessionPath, 'utf-8'), beforeEstablishment);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves malformed pointer bytes when binding establishment aborts before commit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-malformed-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const malformed = '{ malformed pointer';
      await mkdir(context.baseStateDir, { recursive: true });
      await writeFile(context.sessionPath, malformed, 'utf-8');

      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-malformed');
      assert.equal(established.kind, 'precommit-aborted');
      if (established.kind !== 'precommit-aborted') return;
      assert.equal(established.abort.committed, false);
      assert.equal(established.abort.code, 'session_pointer_unusable');
      assert.equal(established.abort.pointerStatus, 'malformed');
      assert.equal(await readFile(context.sessionPath, 'utf-8'), malformed);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('finalizes only its exact stale-dead native pointer after history is retained', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-stale-dead-'));
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-stale-dead');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      await reconcileNativeSessionStart(cwd, 'native-binding-stale-dead', { pid: 424242 });
      await withPointerDependencies({ probePid: () => 'dead' }, async () => {
        const finalized = await finalizeBoundOnce(established.binding, 'test');
        assert.equal(finalized.finalized, true);
      });
      await closeLaunchSessionBindingOnce(established.binding);
      assert.equal(existsSync(resolveSessionPointerContext(cwd).sessionPath), false);
      const history = await readFile(join(cwd, '.omx', 'logs', 'session-history.jsonl'), 'utf-8');
      assert.match(history, /native-binding-stale-dead/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a stale-dead pointer whose bound lineage token does not match', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-stale-mismatch-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-stale-mismatch');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      const state = await reconcileNativeSessionStart(cwd, 'native-binding-stale-mismatch', { pid: 424242 });
      await writeFile(context.sessionPath, JSON.stringify({ ...state, launch_lineage_token: FOREIGN_TOKEN }), 'utf-8');
      await withPointerDependencies({ probePid: () => 'dead' }, async () => {
        const denied = await finalizeBoundOnce(binding as LaunchSessionBinding, 'test');
        assert.equal(denied.finalized, false);
      });
      assert.equal(existsSync(context.sessionPath), true);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', 'session-history.jsonl')), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves usable and stale bound pointers without the exact valid lineage token before any mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-token-gate-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-token-gate');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      const context = resolveSessionPointerContext(cwd);
      const state = await readSessionState(cwd);
      assert.ok(state);
      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');
      const dailyPath = join(cwd, '.omx', 'logs', `omx-${todayIsoDate()}.jsonl`);
      const hudPath = join(cwd, '.omx', 'state', 'hud-state.json');
      const metricsPath = join(cwd, '.omx', 'metrics.json');
      await writeFile(historyPath, 'history-sentinel\n', 'utf-8');
      await writeFile(hudPath, 'hud-sentinel\n', 'utf-8');
      await writeFile(metricsPath, 'metrics-sentinel\n', 'utf-8');
      const lifecycleBytes = {
        history: await readFile(historyPath, 'utf-8'),
        daily: await readFile(dailyPath, 'utf-8'),
        hud: await readFile(hudPath, 'utf-8'),
        metrics: await readFile(metricsPath, 'utf-8'),
      };
      const cases: Array<{ name: string; state: SessionState; probePid?: 'dead' | 'indeterminate' }> = [
        { name: 'tokenless usable', state: (() => { const { launch_lineage_token: _, ...tokenless } = state; return tokenless; })() },
        { name: 'malformed usable', state: { ...state, launch_lineage_token: 'bad' } },
        { name: 'mismatched usable', state: { ...state, launch_lineage_token: FOREIGN_TOKEN } },
        { name: 'replaced usable', state: { ...state, launch_lineage_token: SUCCESSOR_TOKEN } },
        { name: 'same-token changed incarnation', state: { ...state, started_at: '1999-01-01T00:00:00.000Z' } },
        { name: 'unknown identity', state: { ...state, pid: 424242 }, probePid: 'indeterminate' },
        {
          name: 'tokenless stale native',
          state: (() => {
            const { launch_lineage_token: _, ...tokenless } = state;
            return { ...tokenless, native_session_id: 'native-tokenless-stale', pid: 424242 };
          })(),
          probePid: 'dead',
        },
      ];

      for (const testCase of cases) {
        const raw = JSON.stringify(testCase.state);
        let mkdirCalls = 0;
        let unlinkCalls = 0;
        await writeFile(context.sessionPath, raw, 'utf-8');
        await withPointerDependencies({
          probePid: () => testCase.probePid ?? 'alive',
          fs: {
            mkdir: async (path, options) => { mkdirCalls += 1; await mkdir(path, options); },
            unlink: async (path) => { if (path === context.sessionPath) unlinkCalls += 1; await rm(path, { force: false }); },
          },
        }, async () => {
          await assert.rejects(
            writeSessionEnd(cwd, binding!.canonicalSessionId, { binding }),
            isSessionPointerLaunchAbort,
          );
        });
        assert.equal(await readFile(context.sessionPath, 'utf-8'), raw, testCase.name);
        assert.ok(mkdirCalls <= 1, testCase.name);
        assert.equal(unlinkCalls, 0, testCase.name);
        assert.equal(existsSync(context.lockPath), false, testCase.name);
        assert.equal(await readFile(historyPath, 'utf-8'), lifecycleBytes.history, testCase.name);
        assert.equal(await readFile(dailyPath, 'utf-8'), lifecycleBytes.daily, testCase.name);
        assert.equal(await readFile(hudPath, 'utf-8'), lifecycleBytes.hud, testCase.name);
        assert.equal(await readFile(metricsPath, 'utf-8'), lifecycleBytes.metrics, testCase.name);
      }
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('denies selected-root replacement under lock before pointer publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-establish-root-race-'));
    const displacedRoot = join(cwd, 'displaced-state');
    try {
      const context = resolveSessionPointerContext(cwd);
      let replaced = false;
      let established: Awaited<ReturnType<typeof establishLaunchSessionBinding>> | undefined;
      await withPointerDependencies({
        fs: {
          openAndSync: async (path) => {
            if (!replaced && path.startsWith(`${context.sessionPath}.tmp-`)) {
              replaced = true;
              await rename(context.baseStateDir, displacedRoot);
              await mkdir(context.baseStateDir, { recursive: true });
            }
            return 'synced' as const;
          },
        },
      }, async () => { established = await establishLaunchSessionBinding(cwd, 'sess-establish-root-race'); });
      assert.ok(established);
      assert.notEqual(established.kind, 'committed-released');
      assert.equal(existsSync(context.sessionPath), false);
      assert.equal(existsSync(join(displacedRoot, 'session.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('returns committed blocked evidence when selected root changes after pointer rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-establish-post-rename-race-'));
    const displacedRoot = join(cwd, 'displaced-after-rename');
    try {
      const context = resolveSessionPointerContext(cwd);
      let replaced = false;
      let established: Awaited<ReturnType<typeof establishLaunchSessionBinding>> | undefined;
      await withPointerDependencies({
        fs: {
          rename: async (from, to) => {
            await rename(from, to);
            if (!replaced && to === context.sessionPath) {
              replaced = true;
              await rename(context.baseStateDir, displacedRoot);
              await mkdir(context.baseStateDir, { recursive: true });
            }
          },
        },
      }, async () => { established = await establishLaunchSessionBinding(cwd, 'sess-establish-post-rename-race'); });
      assert.ok(established);
      assert.equal(established.kind, 'committed-release-failed');
      assert.equal(existsSync(context.sessionPath), false);
      assert.equal(existsSync(join(displacedRoot, 'session.json')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('denies same-path replacement before creating state, lock, history, or HUD artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-replaced-path-'));
    const retainedCwd = `${cwd}-retained`;
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-binding-replaced-path');
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;

      await rename(cwd, retainedCwd);
      await mkdir(cwd);
      const context = resolveSessionPointerContext(cwd);

      const finalized = await finalizeBoundOnce(binding, 'test');
      assert.equal(finalized.finalized, false);
      assert.equal(finalized.cleanup.comparison?.status, 'denied');
      assert.equal(existsSync(context.baseStateDir), false);
      assert.equal(existsSync(context.lockPath), false);
      assert.equal(existsSync(join(cwd, '.omx', 'logs', 'session-history.jsonl')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'hud-state.json')), false);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
      await rm(retainedCwd, { recursive: true, force: true });
    }
  });

  it('keeps native absent reconciliation tokenless without backfill', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-tokenless-'));
    try {
      assert.equal((await reconcileNativeSessionStart(cwd, 'native-tokenless')).launch_lineage_token, undefined);
      assert.equal((await reconcileNativeSessionStart(cwd, 'native-tokenless')).launch_lineage_token, undefined);
      assert.equal((await readSessionState(cwd))?.launch_lineage_token, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('allows authorized unsupported-capability stale-dead finalization without weakening bound lineage checks', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-unsupported-lifecycle-'));
    let ordinary: LaunchSessionBinding | undefined;
    let stale: LaunchSessionBinding | undefined;
    try {
      const ordinaryEstablished = await establishLaunchSessionBinding(cwd, 'sess-unsupported-ordinary', { platform: 'win32' });
      assert.equal(ordinaryEstablished.kind, 'committed-released');
      if (ordinaryEstablished.kind !== 'committed-released') return;
      ordinary = ordinaryEstablished.binding;
      assert.deepEqual(ordinary.directoryIdentity, { kind: 'unsupported', reason: 'platform' });

      const ordinaryFinalized = await finalizeBoundOnce(ordinary, 'ordinary-unsupported');
      assert.equal(ordinaryFinalized.finalized, true);
      assert.equal(existsSync(resolveSessionPointerContext(cwd).sessionPath), false);
      assert.equal((await closeLaunchSessionBindingOnce(ordinary)).status, 'closed');

      const staleEstablished = await establishLaunchSessionBinding(cwd, 'sess-unsupported-stale', {
        nativeSessionId: 'native-unsupported-stale',
        platform: 'win32',
      });
      assert.equal(staleEstablished.kind, 'committed-released');
      if (staleEstablished.kind !== 'committed-released') return;
      stale = staleEstablished.binding;
      await reconcileNativeSessionStart(cwd, 'native-unsupported-stale', { pid: 424242, platform: 'win32' });
      const context = resolveSessionPointerContext(cwd);
      const historyPath = join(cwd, '.omx', 'logs', 'session-history.jsonl');

      await withPointerDependencies({ probePid: () => 'dead' }, async () => {
        const finalized = await finalizeBoundOnce(stale as LaunchSessionBinding, 'stale-unsupported');
        assert.equal(finalized.finalized, true);
        assert.equal(finalized.cleanup.comparison?.status, 'matched');
        assert.match(finalized.cleanup.comparison?.reason ?? '', /unsupported-directory-capability:platform/);
      });
      assert.equal(existsSync(context.sessionPath), false);
      const history = await readFile(historyPath, 'utf-8');
      assert.match(history, /native-unsupported-stale/);
    } finally {
      if (ordinary) await closeLaunchSessionBindingOnce(ordinary).catch(() => {});
      if (stale) await closeLaunchSessionBindingOnce(stale).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves native lineage and tmux metadata across an authorized native-ID replacement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-lineage-metadata-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'sess-native-lineage-metadata', {
        nativeSessionId: 'native-before',
        tmuxSessionName: 'omx-native-lineage',
        tmuxPaneId: '%88',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;

      const reconciled = await reconcileNativeSessionStart(cwd, 'native-after', { pid: process.pid });
      assert.equal(reconciled.session_id, 'native-after');
      assert.equal(reconciled.native_session_id, 'native-after');
      assert.equal(reconciled.owner_omx_session_id, binding.canonicalSessionId);
      assert.equal(reconciled.previous_native_session_id, 'native-before');
      assert.equal(reconciled.launch_lineage_token, binding.launchLineageToken);
      assert.equal(reconciled.tmux_session_name, 'omx-native-lineage');
      assert.equal(reconciled.tmux_pane_id, '%88');
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('reports owner unlink residue and does not rmdir it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-unlink-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      let rmdirCalls = 0;
      await withPointerDependencies({
        token: () => TEST_TOKEN,
        fs: {
          unlink: async (path) => {
            if (path.endsWith(`.release-${TEST_TOKEN}/owner.json`)) throw new Error('owner unlink failure');
            await rm(path, { force: false });
          },
          rmdir: async (path) => { rmdirCalls += 1; await rm(path, { recursive: false }); },
        },
      }, async () => {
        const result = await establishLaunchSessionBinding(cwd, 'sess-owner-unlink');
        assert.equal(result.kind, 'committed-release-failed');
        if (result.kind === 'committed-release-failed') {
          assert.equal(result.secondaryFailures[0]?.phase, 'remove-release-owner');
          assert.equal(result.lockDisposition, 'released-with-residue');
        }
      });
      assert.equal(rmdirCalls, 0);
      assert.equal(existsSync(`${context.lockPath}.release-${TEST_TOKEN}`), true);
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
