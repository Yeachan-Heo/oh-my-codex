import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __createDefaultPidProbeForTests,
  __releasePointerLockForTests,
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
  readNativeSessionOwner,
  readNativeSessionOwnerEvidence,
  reconcileNativeSessionStart,
  recoverSessionPointerLock,
  resetSessionMetrics,
  resolveSessionPointerContext,
  writeSessionEnd,
  writeNativeSessionOwner,
  updateDetachedSessionMetadata,
  writeSessionStart,
  type LaunchSessionBinding,
  type SessionState,
  type ProcessObservation,
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

function isOwnerConflict(error: unknown): boolean {
  return isSessionPointerLaunchAbort(error)
    && (error as { code?: string }).code === 'session_pointer_owner_conflict';
}

async function withPointerDependencies(
  overrides: Parameters<typeof __setSessionPointerTransactionDependenciesForTests>[0],
  run: () => Promise<void>,
): Promise<void> {
  const runtimePlatform = overrides.runtimePlatform ?? process.platform;
  __setSessionPointerTransactionDependenciesForTests({
    atomicRenameNoReplace: defaultTestAtomicRenameNoReplace,
    ...overrides,
    runtimePlatform,
  });

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

function matchingObservation(): ProcessObservation {
  return { kind: 'identity', identity: { platform: 'linux', birth: '1' } };
}

function matchingWin32Observation(): ProcessObservation {
  return { kind: 'identity', identity: { platform: 'win32', birth: '1' } };
}

async function writeLockOwner(cwd: string, owner: Record<string, unknown>): Promise<string> {
  const context = resolveSessionPointerContext(cwd);
  await mkdir(context.lockPath, { recursive: true });
  await writeFile(join(context.lockPath, 'owner.json'), JSON.stringify(owner), 'utf-8');
  return context.lockPath;
}

function validLockOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const platform = (overrides.platform ?? 'linux') as NodeJS.Platform;
  const version = overrides.version === 2 || overrides.process_identity !== undefined ? 2 : 1;
  const identity = overrides.process_identity ?? (version === 2 ? { platform, birth: '1' } : undefined);
  return {
    version,
    token: TEST_TOKEN,
    pid: process.pid,
    platform,
    ...(version === 2 && identity ? { process_identity: identity } : {}),
    ...(version === 1 ? { pid_start_ticks: 1 } : {}),
    created_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}
/** Safe test seam for capability probes: no-replace rename without overwriting destinations. */
async function defaultTestAtomicRenameNoReplace(from: string, to: string): Promise<'moved' | 'not-moved' | 'unsupported'> {
  if (existsSync(to)) return 'not-moved';
  await rename(from, to);
  return 'moved';
}

/** Wrap a lock-directory-focused seam so capability probes keep working. */
function withProbeFallback(
  contextLockPath: string,
  move: (from: string, to: string) => Promise<'moved' | 'not-moved' | 'unsupported'>,
): (from: string, to: string) => Promise<'moved' | 'not-moved' | 'unsupported'> {
  return async (from, to) => {
    if (
      from === contextLockPath
      || to === contextLockPath
      || from.startsWith(`${contextLockPath}.`)
      || to.startsWith(`${contextLockPath}.`)
    ) {
      return await move(from, to);
    }
    return await defaultTestAtomicRenameNoReplace(from, to);
  };
}

async function assertDurableDirectoryRecovery(cwd: string, options: { atomicRenameNoReplace?: Parameters<typeof __setSessionPointerTransactionDependenciesForTests>[0]['atomicRenameNoReplace'] } = {}): Promise<void> {
  const context = resolveSessionPointerContext(cwd);
  await writeLockOwner(cwd, validLockOwner());
  await withPointerDependencies({
    token: () => SUCCESSOR_TOKEN,
    probePid: () => 'dead',
    atomicRenameNoReplace: options.atomicRenameNoReplace ?? defaultTestAtomicRenameNoReplace,
  }, async () => {
    const recovered = await recoverSessionPointerLock(cwd);
    assert.equal(recovered.recovered, true, recovered.reason);
    assert.equal(recovered.action, 'quarantined');
    const parked = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
    const completed = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.completed`;
    assert.equal(existsSync(context.lockPath), false);
    assert.equal(existsSync(parked), true);
    assert.equal(existsSync(completed), true);
    assert.equal(existsSync(recovered.quarantinePath!), true);
    const quarantine = await lstat(recovered.quarantinePath!);
    const parkedOwner = await lstat(join(parked, 'owner.json'));
    assert.deepEqual({ dev: quarantine.dev, ino: quarantine.ino }, { dev: parkedOwner.dev, ino: parkedOwner.ino });
    const repeated = await recoverSessionPointerLock(cwd);
    assert.equal(repeated.recovered, false);
    assert.equal(repeated.status, 'absent');
  });
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

  it('rejects replacing a live native session pointer with another native SessionStart', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-fresh-'));
    try {
      await writeSessionStart(cwd, 'omx-old-session', {
        nativeSessionId: 'codex-native-old',
      });

      await assert.rejects(
        reconcileNativeSessionStart(cwd, 'codex-native-new', {
          pid: 54321,
          platform: 'win32',
        }),
        isOwnerConflict,
      );

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-old-session');
      assert.equal(persisted?.native_session_id, 'codex-native-old');
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

  it('lets an owner OMX launch session end after rejecting an unrelated native replacement', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-end-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-old',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      await assert.rejects(
        reconcileNativeSessionStart(cwd, 'codex-native-new', {
          pid: process.pid,
          platform: 'win32',
        }),
        isOwnerConflict,
      );

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
      assert.equal(historyEntry.native_session_id, 'codex-native-old');
      assert.equal(historyEntry.active_session_id, undefined);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves canonical session metadata when reconciling the same native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-reconcile-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
      }, async () => {
        const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
          nativeSessionId: 'codex-native-old',
          platform: 'win32',
        });
        assert.equal(established.kind, 'committed-released');
        if (established.kind !== 'committed-released') return;
        binding = established.binding;

        const reconciled = await reconcileNativeSessionStart(cwd, 'codex-native-old', {
          pid: process.pid,
          platform: 'win32',
        });

        assert.equal(reconciled.session_id, 'omx-owner-session');
        assert.equal(reconciled.native_session_id, 'codex-native-old');
        assert.equal(reconciled.previous_native_session_id, undefined);
        assert.equal(reconciled.owner_omx_session_id, undefined);
        assert.equal(reconciled.pid, process.pid);

        await finalizeBoundOnce(binding, 'test');
        assert.equal(await readSessionState(cwd), null);
      });
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects chained native SessionStart replacements and preserves the original pointer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-owner-chain-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      const established = await establishLaunchSessionBinding(cwd, 'omx-owner-session', {
        nativeSessionId: 'codex-native-a',
      });
      assert.equal(established.kind, 'committed-released');
      if (established.kind !== 'committed-released') return;
      binding = established.binding;
      await assert.rejects(reconcileNativeSessionStart(cwd, 'codex-native-b', {
        pid: process.pid,
        platform: 'win32',
      }), isOwnerConflict);
      await assert.rejects(reconcileNativeSessionStart(cwd, 'codex-native-c', {
        pid: process.pid,
        platform: 'win32',
      }), isOwnerConflict);

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'omx-owner-session');
      assert.equal(persisted?.native_session_id, 'codex-native-a');

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
      assert.equal(historyEntry.native_session_id, 'codex-native-a');
      assert.equal(historyEntry.active_session_id, undefined);
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects replacing a live wrapper-owned native session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-native-non-omx-fresh-'));
    try {
      await writeSessionStart(cwd, 'codex-native-old', {
        nativeSessionId: 'codex-native-old',
      });

      await assert.rejects(
        reconcileNativeSessionStart(cwd, 'codex-native-new', {
          pid: 54321,
          platform: 'win32',
        }),
        isOwnerConflict,
      );

      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, 'codex-native-old');
      assert.equal(persisted?.native_session_id, 'codex-native-old');
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

  it('classifies identity-less live non-Linux pointers as identity-indeterminate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-non-linux-identityless-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await mkdir(context.baseStateDir, { recursive: true });
      await writeFile(context.sessionPath, JSON.stringify({
        session_id: 'sess-darwin-identityless',
        started_at: '2026-07-14T00:00:00.000Z',
        cwd,
        pid: process.pid,
        platform: 'darwin',
      }), 'utf-8');
      await withPointerDependencies({
        runtimePlatform: 'darwin',
        probePid: () => 'alive',
        observeProcess: () => ({ kind: 'unsupported' }),
      }, async () => {
        assert.equal((await readSessionPointer(context)).status, 'identity-indeterminate');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
        observeProcess: () => matchingObservation(),
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
          observeProcess: () => matchingObservation(),
        });
        assert.equal((await readSessionPointer(context)).status, 'stale-dead');

        __setSessionPointerTransactionDependenciesForTests({
          probePid: () => 'indeterminate',
          observeProcess: () => matchingObservation(),
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

  it('covers the process identity decision table through pointer and lock inspection', async () => {
    const hashA = 'aaa'.repeat(21) + 'a';
    const hashB = 'bbb'.repeat(21) + 'b';
    const identityOwner = (identity: { platform: NodeJS.Platform; birth: string; cmdline_hash?: string }) => validLockOwner({
      pid: 4242,
      version: 2,
      platform: identity.platform,
      process_identity: identity,
    });
    const legacyOwner = (platform: NodeJS.Platform = 'linux', startTicks = 1) => validLockOwner({
      pid: 4242,
      platform,
      pid_start_ticks: startTicks,
    });
    const identitylessOwner = (platform: NodeJS.Platform) => validLockOwner({
      pid: 4242,
      platform,
      pid_start_ticks: undefined,
    });
    const identity = (platform: NodeJS.Platform, birth: string, cmdline_hash?: string): ProcessObservation => ({
      kind: 'identity',
      identity: { platform, birth, ...(cmdline_hash ? { cmdline_hash } : {}) },
    });
    const classifierCases: Array<{
      name: string;
      recordedState?: Record<string, unknown>;
      rawPointer?: string;
      runtimePlatform: NodeJS.Platform;
      probePid: 'alive' | 'dead' | 'indeterminate';
      observations: ProcessObservation[];
      lockOwner?: Record<string, unknown> | 'malformed';
      expectedPointerStatus: string;
      expectedLockStatus: string;
    }> = [
      {
        name: 'usable match',
        recordedState: {
          platform: 'linux', pid_start_ticks: 1, identity_schema_version: 2,
          process_identity: { platform: 'linux', birth: '1' },
        },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '1')],
        lockOwner: identityOwner({ platform: 'linux', birth: '1' }),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'darwin match',
        recordedState: { identity_schema_version: 2, process_identity: { platform: 'darwin', birth: '1234.567' } },
        runtimePlatform: 'darwin', probePid: 'alive', observations: [identity('darwin', '1234.567')],
        lockOwner: identityOwner({ platform: 'darwin', birth: '1234.567' }),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'windows exact FILETIME',
        recordedState: { identity_schema_version: 2, process_identity: { platform: 'win32', birth: '132580896000000000' } },
        runtimePlatform: 'win32', probePid: 'alive', observations: [identity('win32', '132580896000000000')],
        lockOwner: identityOwner({ platform: 'win32', birth: '132580896000000000' }),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'dead PID',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'dead', observations: [],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'stale-dead', expectedLockStatus: 'dead',
      },
      {
        name: 'birth mismatch',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '2'), identity('linux', '2')],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'stale-dead', expectedLockStatus: 'reused',
      },
      {
        name: 'TOCTOU retry agree',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '2'), identity('linux', '1')],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'TOCTOU retry disagree',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '2'), identity('linux', '3')],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'stale-dead', expectedLockStatus: 'reused',
      },
      {
        name: 'EPERM probePid',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'indeterminate', observations: [],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'provider denied',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [{ kind: 'denied' }],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'provider error',
        recordedState: { platform: 'linux', pid_start_ticks: 1 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [{ kind: 'error' }],
        lockOwner: legacyOwner(),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'provider unsupported',
        recordedState: { identity_schema_version: 2, process_identity: { platform: 'freebsd', birth: '1' } },
        runtimePlatform: 'freebsd', probePid: 'alive', observations: [{ kind: 'unsupported' }],
        lockOwner: identityOwner({ platform: 'freebsd', birth: '1' }),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'foreign platform',
        recordedState: { identity_schema_version: 2, process_identity: { platform: 'darwin', birth: '1' } },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '1')],
        lockOwner: identityOwner({ platform: 'darwin', birth: '1' }),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'cmdline hash match',
        recordedState: {
          identity_schema_version: 2,
          process_identity: { platform: 'linux', birth: '1', cmdline_hash: hashA },
        },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '1', hashA)],
        lockOwner: identityOwner({ platform: 'linux', birth: '1', cmdline_hash: hashA }),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'cmdline hash mismatch',
        recordedState: {
          identity_schema_version: 2,
          process_identity: { platform: 'linux', birth: '1', cmdline_hash: hashA },
        },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '1', hashB)],
        lockOwner: identityOwner({ platform: 'linux', birth: '1', cmdline_hash: hashA }),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'legacy v1 upgrade Linux',
        recordedState: { platform: 'linux', pid_start_ticks: 111 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '111')],
        lockOwner: legacyOwner('linux', 111),
        expectedPointerStatus: 'usable', expectedLockStatus: 'live',
      },
      {
        name: 'legacy v1 mismatch Linux',
        recordedState: { platform: 'linux', pid_start_ticks: 111 },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '222'), identity('linux', '222')],
        lockOwner: legacyOwner('linux', 111),
        expectedPointerStatus: 'stale-dead', expectedLockStatus: 'reused',
      },
      {
        name: 'legacy identity-less live non-Linux',
        recordedState: { platform: 'darwin' },
        runtimePlatform: 'darwin', probePid: 'alive', observations: [{ kind: 'unsupported' }],
        lockOwner: identitylessOwner('darwin'),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'future schema v3',
        recordedState: { identity_schema_version: 3, process_identity: { platform: 'linux', birth: '1' } },
        runtimePlatform: 'linux', probePid: 'alive', observations: [identity('linux', '1')],
        lockOwner: identitylessOwner('darwin'),
        expectedPointerStatus: 'identity-indeterminate', expectedLockStatus: 'identity-indeterminate',
      },
      {
        name: 'malformed JSON',
        rawPointer: '{not-json',
        runtimePlatform: 'linux', probePid: 'alive', observations: [], lockOwner: 'malformed',
        expectedPointerStatus: 'malformed', expectedLockStatus: 'malformed',
      },
      {
        name: 'same-second Darwin collision',
        recordedState: { identity_schema_version: 2, process_identity: { platform: 'darwin', birth: '1000.500' } },
        runtimePlatform: 'darwin', probePid: 'alive', observations: [identity('darwin', '1000.999'), identity('darwin', '1000.999')],
        lockOwner: identityOwner({ platform: 'darwin', birth: '1000.500' }),
        expectedPointerStatus: 'stale-dead', expectedLockStatus: 'reused',
      },
      {
        name: 'absent pointer',
        runtimePlatform: 'linux', probePid: 'alive', observations: [],
        expectedPointerStatus: 'absent', expectedLockStatus: 'absent',
      },
    ];

    for (const testCase of classifierCases) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-session-classifier-'));
      try {
        const context = resolveSessionPointerContext(cwd);
        await mkdir(context.baseStateDir, { recursive: true });
        if (testCase.rawPointer !== undefined) {
          await writeFile(context.sessionPath, testCase.rawPointer, 'utf-8');
        } else if (testCase.recordedState) {
          await writeFile(context.sessionPath, JSON.stringify({
            session_id: 'sess-classifier',
            started_at: '2026-07-14T00:00:00.000Z',
            cwd,
            pid: 4242,
            ...testCase.recordedState,
          }), 'utf-8');
        }
        if (testCase.lockOwner !== undefined) {
          await mkdir(context.lockPath, { recursive: true });
          await writeFile(
            join(context.lockPath, 'owner.json'),
            testCase.lockOwner === 'malformed' ? '{not-json' : JSON.stringify(testCase.lockOwner),
            'utf-8',
          );
        }
        let observerCalls = 0;
        const observer = (): ProcessObservation => {
          const index = observerCalls++;
          return testCase.observations[Math.min(index, Math.max(testCase.observations.length - 1, 0))] ?? { kind: 'error' };
        };
        await withPointerDependencies({
          runtimePlatform: testCase.runtimePlatform,
          probePid: () => testCase.probePid,
          observeProcess: observer,
        }, async () => {
          assert.equal((await readSessionPointer(context)).status, testCase.expectedPointerStatus, testCase.name);
        });

        let lockObserverCalls = 0;
        const lockObserver = (): ProcessObservation => {
          const index = lockObserverCalls++;
          return testCase.observations[Math.min(index, Math.max(testCase.observations.length - 1, 0))] ?? { kind: 'error' };
        };
        await withPointerDependencies({
          runtimePlatform: testCase.runtimePlatform,
          probePid: () => testCase.probePid,
          observeProcess: lockObserver,
        }, async () => {
          assert.equal((await inspectSessionPointerLock(cwd)).status, testCase.expectedLockStatus, testCase.name);
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects every schema version other than v2 as identity-indeterminate', async () => {
    const schemaVersions: unknown[] = [0, 1, -1, null, '2', 'bad', 3];
    for (const schemaVersion of schemaVersions) {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-session-identity-schema-rejection-'));
      try {
        const context = resolveSessionPointerContext(cwd);
        await mkdir(context.baseStateDir, { recursive: true });
        await writeFile(context.sessionPath, JSON.stringify({
          session_id: 'sess-schema-rejection',
          started_at: '2026-07-14T00:00:00.000Z',
          cwd,
          pid: 4242,
          platform: 'linux',
          pid_start_ticks: 1,
          identity_schema_version: schemaVersion,
        }), 'utf-8');
        await mkdir(context.lockPath, { recursive: true });
        await writeFile(join(context.lockPath, 'owner.json'), JSON.stringify(validLockOwner({
          pid: 4242,
          platform: 'darwin',
          pid_start_ticks: undefined,
        })), 'utf-8');
        await withPointerDependencies({
          runtimePlatform: 'linux',
          probePid: () => 'alive',
          observeProcess: () => matchingObservation(),
        }, async () => {
          assert.equal((await readSessionPointer(context)).status, 'identity-indeterminate', String(schemaVersion));
        });
        await withPointerDependencies({
          runtimePlatform: 'linux',
          probePid: () => 'alive',
          observeProcess: () => matchingObservation(),
        }, async () => {
          assert.equal((await inspectSessionPointerLock(cwd)).status, 'identity-indeterminate', String(schemaVersion));
        });
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
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
      observation?: ProcessObservation;
      expected: string;
    }> = [
      { name: 'dead', owner: validLockOwner(), probePid: 'dead', expected: 'dead' },
      { name: 'reused', owner: validLockOwner(), probePid: 'alive', observation: { kind: 'identity', identity: { platform: 'linux', birth: '2' } }, expected: 'reused' },
      { name: 'indeterminate-probe', owner: validLockOwner(), probePid: 'indeterminate', expected: 'identity-indeterminate' },
      { name: 'indeterminate-identity', owner: validLockOwner(), probePid: 'alive', observation: { kind: 'error' }, expected: 'identity-indeterminate' },
      { name: 'foreign-identity', owner: validLockOwner(), probePid: 'alive', observation: { kind: 'identity', identity: { platform: 'darwin', birth: '1' } }, expected: 'identity-indeterminate' },
      { name: 'missing-required-hash', owner: validLockOwner({ pid_cmdline_hash: 'a'.repeat(64) }), probePid: 'alive', observation: matchingObservation(), expected: 'identity-indeterminate' },
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
          observeProcess: () => testCase.observation ?? matchingObservation(),
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

  it('atomically quarantines dead canonical owner evidence and stays idempotent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-preserved-'));
    try { await assertDurableDirectoryRecovery(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('launches only after explicit recovery of a dead canonical owner lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recover-launch-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead' }, async () => {
        await assert.rejects(
          writeSessionStart(cwd, 'sess-blocked', { platform: 'win32' }),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_lock_recovery_required'
            && error.lockOwnerStatus === 'dead',
        );
        assert.equal(existsSync(context.lockPath), true);
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true);
        assert.equal(recovered.action, 'quarantined');
        await writeSessionStart(cwd, 'sess-after-recovery', { platform: 'win32' });
        assert.equal((await readSessionState(cwd))?.session_id, 'sess-after-recovery');
        assert.equal(existsSync(context.lockPath), false);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not claim a successor lock when the inspected dead canonical owner is displaced before the exact rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-canonical-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const successorTemp = join(context.lockPath, `owner.${SUCCESSOR_TOKEN}.tmp`);
      const displacedPath = `${context.lockPath}.displaced`;
      const staleOwner = JSON.stringify(validLockOwner());
      const successorOwner = JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN }));
      await writeLockOwner(cwd, validLockOwner());
      let displaced = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath && to === `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`) {
            displaced = true;
            await rename(from, displacedPath);
            await mkdir(context.lockPath);
            await writeFile(successorTemp, successorOwner, 'utf-8');
            return 'not-moved';
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /Atomic recovery move|recovery checkpoint/i);
      });
      assert.equal(displaced, true);
      assert.equal(await readFile(join(displacedPath, 'owner.json'), 'utf-8'), staleOwner);
      assert.deepEqual(await readdir(context.lockPath), [`owner.${SUCCESSOR_TOKEN}.tmp`]);
      assert.equal(await readFile(successorTemp, 'utf-8'), successorOwner);
      assert.equal(existsSync(ownerPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('rolls back a claim that lands on a displaced successor canonical owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-canonical-claim-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const parkedPath = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      const quarantinePath = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      const staleOwner = JSON.stringify(validLockOwner());
      const successorPid = process.pid + 100_000;
      const successorOwner = JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN, pid: successorPid }));
      await writeLockOwner(cwd, validLockOwner());
      let moved = false;
      let rollbackAttempted = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath && to === parkedPath) {
            await rename(from, to);
            await mkdir(context.lockPath);
            await writeFile(ownerPath, successorOwner, 'utf-8');
            moved = true;
            return 'moved';
          }
          if (from === parkedPath && to === context.lockPath) {
            rollbackAttempted = true;
            return 'not-moved';
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /captured object|token-bound|source pathname/i);
      });
      assert.equal(moved, true);
      assert.equal(rollbackAttempted, true);
      assert.equal(await readFile(ownerPath, 'utf-8'), successorOwner);
      assert.equal(await readFile(join(parkedPath, 'owner.json'), 'utf-8'), staleOwner);
      assert.equal(await readFile(quarantinePath, 'utf-8'), staleOwner);
      assert.equal(existsSync(checkpointPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('live canonical successor survives a refused recovery claim and stays recognizable, releasable, and acquirable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-live-successor-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const parkedPath = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      const successorPid = process.pid + 100_000;
      const successorOwner = JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN, pid: successorPid }));
      await writeLockOwner(cwd, validLockOwner());
      let rollbackAttempted = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: (pid) => pid === successorPid ? 'alive' : 'dead',
        observeProcess: () => matchingObservation(),
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath && to === parkedPath) {
            await rename(from, to);
            await mkdir(context.lockPath);
            await writeFile(ownerPath, successorOwner, 'utf-8');
            return 'moved';
          }
          if (from === parkedPath && to === context.lockPath) {
            rollbackAttempted = true;
            return 'not-moved';
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const refused = await recoverSessionPointerLock(cwd);
        assert.equal(refused.recovered, false);
        assert.equal(refused.action, 'none');
        const inspected = await inspectSessionPointerLock(cwd);
        assert.equal(inspected.status, 'live');
        assert.equal(inspected.safeToRecover, false);
        assert.equal(await readFile(ownerPath, 'utf-8'), successorOwner);
        assert.deepEqual(await __releasePointerLockForTests(cwd, SUCCESSOR_TOKEN), []);
        assert.equal(existsSync(context.lockPath), false);
        const started = await writeSessionStart(cwd, 'sess-after-survival', { platform: 'win32' });
        assert.equal(started.session_id, 'sess-after-survival');
        assert.equal(existsSync(context.lockPath), false);
      });
      assert.equal(rollbackAttempted, true);
      assert.equal(existsSync(parkedPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('fails closed without mutating a foreign target when the lock directory is replaced by a symlink before the claim rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-lock-symlink-'));
    const foreign = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-foreign-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const foreignOwner = join(foreign, 'owner.json');
      const marker = JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN }));
      let replaced = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { link: async (from, to) => {
        if (!replaced && from === ownerPath) { replaced = true; await rm(context.lockPath, { recursive: true }); await writeFile(foreignOwner, marker); await symlink(foreign, context.lockPath); }
        await link(from, to);
      } } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(foreignOwner, 'utf-8'), marker);
      assert.equal((await readdir(foreign)).some((entry) => entry.includes('.quarantine.')), false);
    } finally { await rm(cwd, { recursive: true, force: true }); await rm(foreign, { recursive: true, force: true }); }
  });

  it('does not follow an evidence symlink swapped in before the claim rename', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-evidence-symlink-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const foreign = join(cwd, 'foreign-owner');
      const marker = 'foreign evidence marker';
      let replaced = false;
      await writeLockOwner(cwd, validLockOwner());
      await writeFile(foreign, marker);
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { link: async (from, to) => {
        if (!replaced && from === ownerPath) { replaced = true; await rm(ownerPath); await symlink(foreign, ownerPath); }
        await link(from, to);
      } } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(foreign, 'utf-8'), marker);
      assert.equal(await readlink(ownerPath), foreign);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves a non-file evidence replacement as exact recovery residue without clobbering', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-evidence-directory-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const marker = join(ownerPath, 'marker');
      let replaced = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { link: async (from, to) => {
        if (!replaced && from === ownerPath) { replaced = true; await rm(ownerPath); await mkdir(ownerPath); await writeFile(marker, 'directory marker'); }
        await link(from, to);
      } } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(marker, 'utf-8'), 'directory marker');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('retries a transient token-bound park collision without allocating a second parked name', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-park-retry-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const parkedPath = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      const quarantinePath = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      const foreignMarker = 'foreign transient park destination';
      const parkAttempts: string[] = [];
      let tokenCalls = 0;
      let collision = true;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => {
          tokenCalls += 1;
          return SUCCESSOR_TOKEN;
        },
        probePid: () => 'dead',
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath && to === parkedPath) {
            parkAttempts.push(to);
            if (collision) {
              collision = false;
              await mkdir(to);
              await writeFile(join(to, 'foreign'), foreignMarker, 'utf-8');
              return 'not-moved';
            }
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const refused = await recoverSessionPointerLock(cwd);
        assert.equal(refused.recovered, false);
        assert.equal(refused.action, 'none');
        assert.equal(existsSync(checkpointPath), true);
        assert.equal(existsSync(context.lockPath), true);
        assert.equal(await readFile(join(parkedPath, 'foreign'), 'utf-8'), foreignMarker);
        await rm(parkedPath, { recursive: true, force: true });
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true, recovered.reason);
        assert.equal(recovered.action, 'quarantined');
      });
      assert.equal(tokenCalls, 1);
      assert.deepEqual(parkAttempts, [parkedPath, parkedPath]);
      assert.equal(existsSync(context.lockPath), false);
      assert.equal(existsSync(parkedPath), true);
      assert.equal(existsSync(quarantinePath), true);
      assert.equal(existsSync(checkpointPath), false);
      assert.equal(existsSync(checkpointPath.replace(/\.json$/, '.completed')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('rolls back a claim when checkpoint creation fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-checkpoint-write-fail-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      let fail = true;
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { writeFile: async (path, data, options) => { if (fail && path.includes('.recovery.')) { fail = false; throw codedError('EBUSY'); } await writeFile(path, data, options); } } }, async () => {
        assert.equal((await recoverSessionPointerLock(cwd)).recovered, false);
        assert.deepEqual(await readdir(context.lockPath), ['owner.json']);
        assert.equal((await recoverSessionPointerLock(cwd)).recovered, true);
      });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('rolls back a double-EBUSY evidence park failure so a normal retry succeeds', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-checkpoint-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const quarantinePath = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      const staleOwner = JSON.stringify(validLockOwner());
      let failures = 2;
      let tokenCalls = 0;
      let linkAttempts = 0;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => {
          tokenCalls += 1;
          return SUCCESSOR_TOKEN;
        },
        probePid: () => 'dead',
        fs: {
          link: async (from, to) => {
            if (to === quarantinePath && failures > 0) {
              failures -= 1;
              linkAttempts += 1;
              throw codedError('EBUSY');
            }
            await link(from, to);
          },
        },
      }, async () => {
        const first = await recoverSessionPointerLock(cwd);
        assert.equal(first.recovered, false);
        assert.equal(first.action, 'none');
        assert.equal(existsSync(checkpointPath), true);
        assert.equal(await readFile(ownerPath, 'utf-8'), staleOwner);
        assert.equal(existsSync(quarantinePath), false);

        const second = await recoverSessionPointerLock(cwd);
        assert.equal(second.recovered, false);
        assert.equal(second.action, 'none');
        assert.equal(existsSync(checkpointPath), true);
        assert.equal(await readFile(ownerPath, 'utf-8'), staleOwner);
        assert.equal(existsSync(quarantinePath), false);

        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true, recovered.reason);
        assert.equal(recovered.action, 'quarantined');
      });
      assert.equal(tokenCalls, 1);
      assert.equal(linkAttempts, 2);
      assert.equal(existsSync(context.lockPath), false);
      assert.equal(await readFile(quarantinePath, 'utf-8'), staleOwner);
      assert.equal(existsSync(checkpointPath), false);
      assert.equal(existsSync(checkpointPath.replace(/\.json$/, '.completed')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it('resumes an evidence-pending checkpoint without minting another recovery token', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-resume-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claimPath = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`);
      const parkPath = `${context.lockPath}.parked-${SUCCESSOR_TOKEN}`;
      const owner = JSON.stringify(validLockOwner());
      await writeLockOwner(cwd, validLockOwner());
      await link(ownerPath, claimPath);
      await rename(ownerPath, parkPath);
      const parked = await lstat(parkPath);
      const lock = await lstat(context.lockPath);
      await writeFile(`${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`, JSON.stringify({ version: 1, sourcePath: ownerPath, parkPath, lockParkPath: `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`, identity: { dev: parked.dev, ino: parked.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await withPointerDependencies({ token: () => { throw new Error('resume must reuse checkpoint token'); }, probePid: () => 'dead' }, async () => {
        const resumed = await recoverSessionPointerLock(cwd);
        assert.equal(resumed.recovered, true);
      });
      assert.equal(await readFile(`${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`, 'utf-8'), owner);
      assert.equal(existsSync(`${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`), false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('resumes the actual distinct-token evidence park path after an interruption', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-distinct-park-token-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claimToken = 'claim_token_123456789';
      const parkToken = 'park_token_123456789';
      const claimPath = join(context.lockPath, `owner.${TEST_TOKEN}.${claimToken}.recovery`);
      const parkPath = `${context.lockPath}.parked-${parkToken}`;
      await writeLockOwner(cwd, validLockOwner());
      await link(ownerPath, claimPath);
      await rename(ownerPath, parkPath);
      const parked = await lstat(parkPath);
      const lock = await lstat(context.lockPath);
      await writeFile(`${context.lockPath}.recovery.${TEST_TOKEN}.${claimToken}.json`, JSON.stringify({ version: 1, sourcePath: ownerPath, parkPath, lockParkPath: `${context.lockPath}.parked-lock-${claimToken}`, identity: { dev: parked.dev, ino: parked.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint a replacement token'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, true));
      assert.equal(await readFile(`${context.lockPath}.quarantine.${TEST_TOKEN}.${claimToken}`, 'utf-8'), JSON.stringify(validLockOwner()));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('resumes a checkpoint written before evidence parking', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-source-checkpoint-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claimPath = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`);
      const parkPath = `${context.lockPath}.parked-${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await writeLockOwner(cwd, validLockOwner());
      await link(ownerPath, claimPath);
      const owner = await lstat(ownerPath);
      const lock = await lstat(context.lockPath);
      await writeFile(checkpointPath, JSON.stringify({ version: 1, sourcePath: ownerPath, parkPath, lockParkPath: `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`, identity: { dev: owner.dev, ino: owner.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint token'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, true));
      assert.equal(existsSync(context.lockPath), false);
      assert.equal(existsSync(checkpointPath), false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('resumes after quarantine hard-link creation but before claim and park cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-dual-evidence-checkpoint-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claimPath = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`);
      const parkPath = `${context.lockPath}.parked-${SUCCESSOR_TOKEN}`;
      const quarantinePath = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await writeLockOwner(cwd, validLockOwner());
      await link(ownerPath, claimPath);
      await rename(ownerPath, parkPath);
      await link(parkPath, quarantinePath);
      const parked = await lstat(parkPath);
      const lock = await lstat(context.lockPath);
      await writeFile(checkpointPath, JSON.stringify({ version: 1, sourcePath: ownerPath, parkPath, lockParkPath: `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`, identity: { dev: parked.dev, ino: parked.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint token'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, true));
      assert.equal(await readFile(quarantinePath, 'utf-8'), JSON.stringify(validLockOwner()));
      assert.equal(existsSync(checkpointPath), false);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('reports absent recovery on a fresh workspace without a state directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-fresh-'));
    try {
      const recovered = await recoverSessionPointerLock(cwd);
      assert.equal(recovered.recovered, false);
      assert.equal(recovered.status, 'absent');
      assert.match(recovered.reason, /No session pointer lock exists/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('fails closed when recovery checkpoint discovery cannot be enumerated', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-checkpoint-readdir-error-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ probePid: () => 'dead', fs: { readdir: async () => { throw codedError('EACCES'); } } }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.status, 'io-error');
        assert.match(recovered.reason, /enumerate.*checkpoints/i);
      });
      assert.deepEqual(await readdir(context.lockPath), ['owner.json']);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('fails closed for malformed checkpoint JSON without minting a recovery token', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-malformed-checkpoint-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await writeFile(checkpointPath, '{not json', 'utf-8');
      await withPointerDependencies({ token: () => { throw new Error('must not mint token'); }, probePid: () => 'dead' }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.safeToRecover, false);
      });
      assert.equal(await readFile(checkpointPath, 'utf-8'), '{not json');
      assert.equal(await readFile(join(context.lockPath, 'owner.json'), 'utf-8'), JSON.stringify(validLockOwner()));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  for (const [label, checkpoint] of [
    ['wrong version', { version: 2, phase: 'evidence-pending', sourcePath: 'x', parkPath: 'x', identity: { dev: 0, ino: 0 } }],
    ['wrong phase', { version: 1, phase: 'claim-pending', sourcePath: 'x', parkPath: 'x', identity: { dev: 0, ino: 0 } }],
    ['out-of-root path', { version: 1, phase: 'evidence-pending', sourcePath: '/foreign/owner.json', parkPath: '/foreign/parked', identity: { dev: 0, ino: 0 } }],
  ]) it(`fails closed for ${label} checkpoint`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-invalid-checkpoint-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      const path = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await writeFile(path, JSON.stringify(checkpoint), 'utf-8');
      await withPointerDependencies({ token: () => { throw new Error('must not mint token'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(path, 'utf-8'), JSON.stringify(checkpoint));
      assert.equal(await readFile(join(context.lockPath, 'owner.json'), 'utf-8'), JSON.stringify(validLockOwner()));
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('refuses multiple checkpoints without mutating either', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-multiple-checkpoints-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      for (const token of [SUCCESSOR_TOKEN, FOREIGN_TOKEN]) await writeFile(`${context.lockPath}.recovery.${TEST_TOKEN}.${token}.json`, '{}', 'utf-8');
      await withPointerDependencies({ token: () => { throw new Error('must not mint token'); }, probePid: () => 'dead' }, async () => assert.match((await recoverSessionPointerLock(cwd)).reason, /Multiple recovery checkpoints/));
      assert.equal(existsSync(join(context.lockPath, 'owner.json')), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves a checkpoint when its claim is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-missing-claim-'));
    try {
      const context = resolveSessionPointerContext(cwd); await mkdir(context.lockPath, { recursive: true });
      const parkPath = `${context.lockPath}.parked-${SUCCESSOR_TOKEN}`; await writeFile(parkPath, 'stale', 'utf-8'); const stat = await lstat(parkPath);
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      const lock = await lstat(context.lockPath);
      await writeFile(checkpointPath, JSON.stringify({ version: 1, sourcePath: join(context.lockPath, 'owner.json'), parkPath, lockParkPath: `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`, identity: { dev: stat.dev, ino: stat.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await withPointerDependencies({ token: () => { throw new Error('must not mint token'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(checkpointPath, 'utf-8').then(Boolean), true); assert.equal(await readFile(parkPath, 'utf-8'), 'stale');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });


  it('refuses an advanced checkpoint when a live successor replaces the bound lock directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-checkpoint-successor-swap-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claimPath = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`);
      const parkPath = `${context.lockPath}.parked-${SUCCESSOR_TOKEN}`;
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      const quarantinePath = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      await writeLockOwner(cwd, validLockOwner());
      await link(ownerPath, claimPath);
      await rename(ownerPath, parkPath);
      const parked = await lstat(parkPath);
      const lock = await lstat(context.lockPath);
      await writeFile(checkpointPath, JSON.stringify({ version: 1, sourcePath: ownerPath, parkPath, lockParkPath: `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`, identity: { dev: parked.dev, ino: parked.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, phase: 'evidence-pending' }));
      await rename(parkPath, quarantinePath);
      await rm(claimPath);
      await rename(context.lockPath, `${context.lockPath}.displaced`);
      const successorPid = process.pid + 100_000;
      const successor = JSON.stringify(validLockOwner({ token: FOREIGN_TOKEN, pid: successorPid }));
      await mkdir(context.lockPath);
      await writeFile(ownerPath, successor, 'utf-8');
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint'); }, probePid: (pid) => pid === successorPid ? 'alive' : 'dead', observeProcess: () => matchingObservation() }, async () => {
        const refused = await recoverSessionPointerLock(cwd);
        assert.equal(refused.recovered, false);
        assert.match(refused.reason, /recovery state/i);
        assert.deepEqual(await readdir(context.lockPath), ['owner.json']);
        assert.equal(await readFile(ownerPath, 'utf-8'), successor);
        assert.deepEqual(await __releasePointerLockForTests(cwd, FOREIGN_TOKEN), []);
        assert.equal(existsSync(context.lockPath), false);
      });
      assert.equal(await readFile(quarantinePath, 'utf-8'), JSON.stringify(validLockOwner()));
      assert.equal(existsSync(checkpointPath), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('does not remove a live successor swapped in before final checkpoint lock removal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-final-successor-'));
    try {
      const context = resolveSessionPointerContext(cwd); const ownerPath = join(context.lockPath, 'owner.json');
      const checkpointPath = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`; const lockPark = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      await writeLockOwner(cwd, validLockOwner()); const owner = await lstat(ownerPath); const lock = await lstat(context.lockPath);
      await writeFile(checkpointPath, JSON.stringify({ version: 3, sourcePath: ownerPath, identity: { dev: owner.dev, ino: owner.ino }, evidenceIdentity: { dev: owner.dev, ino: owner.ino }, evidenceBytes: JSON.stringify(validLockOwner()), lockIdentity: { dev: lock.dev, ino: lock.ino }, lockParkPath: lockPark, phase: 'evidence-pending' }));
      const successor = JSON.stringify(validLockOwner({ token: FOREIGN_TOKEN, pid: process.pid + 100_000 })); let moved = false;
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint'); }, probePid: () => 'dead', atomicRenameNoReplace: async (from, to) => {
        if (from === context.lockPath && to === lockPark) { await rename(from, to); await mkdir(context.lockPath); await writeFile(ownerPath, successor); moved = true; return 'moved'; }
        return 'not-moved';
      } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(moved, true); assert.equal(await readFile(ownerPath, 'utf8'), successor); assert.deepEqual(await __releasePointerLockForTests(cwd, FOREIGN_TOKEN), []); assert.equal(existsSync(context.lockPath), false); assert.equal(existsSync(lockPark), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('refuses a quarantine path that appears after its preflight check without overwriting it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-quarantine-race-'));
    try {
      const context = resolveSessionPointerContext(cwd); const ownerPath = join(context.lockPath, 'owner.json'); const quarantine = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`; const foreign = 'foreign quarantine marker';
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { link: async (from, to) => { if (to === quarantine) await writeFile(to, foreign); await link(from, to); } } }, async () => {
        const result = await recoverSessionPointerLock(cwd); assert.equal(result.recovered, false); assert.match(result.reason, /EEXIST|quarantine/i);
      });
      assert.equal(await readFile(ownerPath, 'utf8'), JSON.stringify(validLockOwner())); assert.equal(await readFile(quarantine, 'utf8'), foreign);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('fails closed without mutation when a recovery claim destination appears before the no-clobber claim link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-claim-exist-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const claim = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`);
      let moved = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          writeFile: async (path, data, options) => {
            await writeFile(path, data, options);
            if (path.includes('.recovery.') && path.endsWith('.json')) await writeFile(claim, 'foreign claim');
          },
        },
        atomicRenameNoReplace: withProbeFallback(context.lockPath, async () => {
          moved = true;
          return 'moved';
        }),
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false, recovered.reason);
        assert.match(recovered.reason, /foreign|changed|claim/i);
      });
      assert.equal(moved, false);
      assert.equal(await readFile(ownerPath, 'utf8'), JSON.stringify(validLockOwner()));
      assert.equal(await readFile(claim, 'utf8'), 'foreign claim');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a swapped parked quarantine claim rather than unlinking it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-parked-claim-swap-'));
    try {
      const context = resolveSessionPointerContext(cwd); const ownerPath = join(context.lockPath, 'owner.json'); const lockPark = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`; const claim = join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`); const quarantine = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`; const checkpoint = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await writeLockOwner(cwd, validLockOwner()); const owner = await lstat(ownerPath); const lock = await lstat(context.lockPath); await link(ownerPath, claim); await link(ownerPath, quarantine); await rm(claim); await writeFile(claim, 'foreign parked claim'); await rename(context.lockPath, lockPark);
      await writeFile(checkpoint, JSON.stringify({ version: 2, sourcePath: ownerPath, identity: { dev: owner.dev, ino: owner.ino }, lockIdentity: { dev: lock.dev, ino: lock.ino }, lockParkPath: lockPark, phase: 'evidence-quarantined' }));
      await withPointerDependencies({ token: () => { throw new Error('resume must not mint'); }, probePid: () => 'dead', atomicRenameNoReplace: async (from, to) => { if (from === checkpoint) { await rename(from, to); return 'moved'; } throw new Error('directory move must not occur'); } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, true));
      assert.equal(await readFile(join(lockPark, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`), 'utf8'), 'foreign parked claim'); assert.equal(await readFile(quarantine, 'utf8'), JSON.stringify(validLockOwner())); assert.equal(existsSync(lockPark), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('fails closed without mutation when evidence lstat fails non-ENOENT before the claim', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-evidence-eacces-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const ownerPath = join(context.lockPath, 'owner.json');
      const quarantine = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`;
      let armed = false;
      let moved = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          link: async (from, to) => {
            await link(from, to);
            if (to === quarantine) armed = true;
          },
          lstat: async (path) => {
            if (armed && path === ownerPath) throw codedError('EACCES');
            return await lstat(path);
          },
        },
        atomicRenameNoReplace: withProbeFallback(context.lockPath, async () => {
          moved = true;
          return 'moved';
        }),
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false, recovered.reason);
      });
      assert.equal(moved, false);
      assert.equal(await readFile(ownerPath, 'utf8'), JSON.stringify(validLockOwner()));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores evidence and keeps the exact quarantine inspect diagnostic when quarantine lstat fails non-ENOENT', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-quarantine-eacces-'));
    try {
      const context = resolveSessionPointerContext(cwd); const ownerPath = join(context.lockPath, 'owner.json'); const quarantine = `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`; const checkpoint = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`; let armed = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', fs: { link: async (from, to) => { await link(from, to); if (to === quarantine) armed = true; }, lstat: async (path) => { if (armed && path === quarantine) throw codedError('EACCES'); return await lstat(path); } } }, async () => { const result = await recoverSessionPointerLock(cwd); assert.equal(result.recovered, false); assert.match(result.reason, /EACCES/); });
      assert.equal(await readFile(ownerPath, 'utf8'), JSON.stringify(validLockOwner())); assert.equal(await readFile(quarantine, 'utf8'), JSON.stringify(validLockOwner())); assert.equal(existsSync(checkpoint), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves a swapped parked lock directory rather than removing it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-directory-swap-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const parked = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      const original = `${parked}.original`;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: withProbeFallback(context.lockPath, async (from, to) => {
          if (from === context.lockPath && to === parked) {
            await rename(from, original);
            await mkdir(from);
            await writeFile(join(from, 'foreign'), 'foreign');
            await rename(from, to);
            return 'moved';
          }
          return await defaultTestAtomicRenameNoReplace(from, to);
        }),
      }, async () => {
        assert.equal((await recoverSessionPointerLock(cwd)).recovered, false);
      });
      assert.equal(await readFile(join(parked, 'foreign'), 'utf8'), 'foreign');
      assert.equal(existsSync(join(original, 'owner.json')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  for (const [label, checkpoint] of [
    ['wrong version', { version: 99, phase: 'evidence-pending', sourcePath: 'x', identity: { dev: 0, ino: 0 } }],
    ['wrong phase', { version: 1, phase: 'claim-pending', sourcePath: 'x', identity: { dev: 0, ino: 0 } }],
    ['out-of-root path', { version: 1, phase: 'evidence-pending', sourcePath: '/foreign/owner.json', identity: { dev: 0, ino: 0 } }],
  ]) it(`fails closed for ${label} checkpoint`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-invalid-checkpoint-'));
    try { const context = resolveSessionPointerContext(cwd); const path = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`; await writeLockOwner(cwd, validLockOwner()); await writeFile(path, JSON.stringify(checkpoint)); await withPointerDependencies({ token: () => { throw new Error('must not mint'); }, probePid: () => 'dead' }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false)); assert.equal(await readFile(path, 'utf8'), JSON.stringify(checkpoint)); assert.equal(await readFile(join(context.lockPath, 'owner.json'), 'utf8'), JSON.stringify(validLockOwner())); } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  for (const fault of ['EBUSY', 'ENOTEMPTY'] as const) it(`completes a checkpoint resume retry after one-shot atomic directory move failure ${fault}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-atomic-retry-'));
    try { const context = resolveSessionPointerContext(cwd); const checkpoint = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`; let fail = true; await writeLockOwner(cwd, validLockOwner()); await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', atomicRenameNoReplace: async (from, to) => { if (from === context.lockPath && fail) { fail = false; throw codedError(fault); } if (existsSync(to)) return 'not-moved'; await rename(from, to); return 'moved'; } }, async () => { assert.equal((await recoverSessionPointerLock(cwd)).recovered, false); assert.equal(existsSync(checkpoint), true); assert.equal(existsSync(context.lockPath), true); assert.equal((await recoverSessionPointerLock(cwd)).recovered, true); }); } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('keeps a foreign atomic destination and the source lock when no directory move occurs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-atomic-destination-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      const parked = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', atomicRenameNoReplace: async (_from, to) => {
        await mkdir(to); await writeFile(join(to, 'foreign'), 'foreign'); return 'not-moved';
      } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(await readFile(join(parked, 'foreign'), 'utf8'), 'foreign');
      assert.equal(existsSync(context.lockPath), true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('preserves a foreign directory swapped into the atomic move and rollback residue', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-atomic-source-swap-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const original = `${context.lockPath}.original`;
      const parked = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: withProbeFallback(context.lockPath, async (from, to) => {
          if (from === context.lockPath && to === parked) {
            await rename(from, original);
            await mkdir(from);
            await writeFile(join(from, 'foreign'), 'foreign');
            await rename(from, to);
            return 'moved';
          }
          if (from === parked && to === context.lockPath) return 'not-moved';
          return await defaultTestAtomicRenameNoReplace(from, to);
        }),
      }, async () => {
        assert.equal((await recoverSessionPointerLock(cwd)).recovered, false);
      });
      assert.equal(existsSync(join(original, 'owner.json')), true);
      assert.equal(await readFile(join(parked, 'foreign'), 'utf8'), 'foreign');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not overwrite a rollback destination that appears before the no-clobber rollback link', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-rollback-destination-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const parked = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
      const foreign = 'foreign rollback destination';
      let rollback = false;
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath) {
            await rename(from, to);
            await mkdir(context.lockPath);
            await writeFile(join(context.lockPath, 'foreign'), foreign);
            return 'moved';
          }
          if (from === parked && to === context.lockPath) {
            rollback = true;
            return 'not-moved';
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /captured object|token-bound|source pathname/i);
      });
      assert.equal(rollback, true);
      assert.equal(await readFile(join(context.lockPath, 'foreign'), 'utf-8'), foreign);
      assert.equal(existsSync(join(parked, 'owner.json')), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves a checkpoint replacement and foreign completed receipt collision', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-completion-collision-'));
    try {
      const context = resolveSessionPointerContext(cwd); await writeLockOwner(cwd, validLockOwner());
      const checkpoint = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`;
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', atomicRenameNoReplace: async (from, to) => {
        if (from === checkpoint) { await writeFile(to, 'foreign receipt'); return 'not-moved'; }
        await rename(from, to); return 'moved';
      } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(existsSync(checkpoint), true);
      assert.equal(await readFile(checkpoint.replace(/\.json$/, '.completed'), 'utf8'), 'foreign receipt');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('fails closed before moving a lock directory with a foreign extra entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-foreign-entry-'));
    try {
      const context = resolveSessionPointerContext(cwd); await writeLockOwner(cwd, validLockOwner()); await writeFile(join(context.lockPath, 'foreign'), 'foreign');
      let moved = false;
      await withPointerDependencies({ token: () => SUCCESSOR_TOKEN, probePid: () => 'dead', atomicRenameNoReplace: async () => { moved = true; return 'moved'; } }, async () => assert.equal((await recoverSessionPointerLock(cwd)).recovered, false));
      assert.equal(moved, false); assert.equal(await readFile(join(context.lockPath, 'foreign'), 'utf8'), 'foreign');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('resumes legacy base-v1 recovery and v2 source and parked partial recovery', async () => {
    for (const state of ['v1-source', 'v2-source', 'v2-parked'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-session-recovery-legacy-${state}-`));
      try {
        const context = resolveSessionPointerContext(cwd); const ownerPath = join(context.lockPath, 'owner.json'); const checkpoint = `${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`; const lockPark = `${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`;
        await writeLockOwner(cwd, validLockOwner()); const owner = await lstat(ownerPath); const lock = await lstat(context.lockPath);
        const base = { version: state === 'v1-source' ? 1 : 2, sourcePath: ownerPath, identity: { dev: owner.dev, ino: owner.ino }, phase: 'evidence-pending' };
        if (state === 'v2-parked') { await link(ownerPath, join(context.lockPath, `owner.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.recovery`)); await link(ownerPath, `${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`); await rename(context.lockPath, lockPark); }
        await writeFile(checkpoint, JSON.stringify(state === 'v1-source' ? base : { ...base, lockIdentity: { dev: lock.dev, ino: lock.ino }, lockParkPath: lockPark, phase: state === 'v2-parked' ? 'evidence-quarantined' : 'evidence-pending' }));
        await withPointerDependencies({ token: () => { throw new Error('legacy resume must not mint'); }, probePid: () => 'dead', atomicRenameNoReplace: async (from, to) => { if (existsSync(to)) return 'not-moved'; await rename(from, to); return 'moved'; } }, async () => {
          const recovered = await recoverSessionPointerLock(cwd); assert.equal(recovered.recovered, true, recovered.reason);
        });
        assert.equal(existsSync(checkpoint.replace(/\.json$/, '.completed')), true); assert.equal(existsSync(lockPark), true);
      } finally { await rm(cwd, { recursive: true, force: true }); }
    }
  });

  it('preserves recovery evidence when atomic directory quarantine is unsupported', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-recovery-unsupported-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      await writeLockOwner(cwd, validLockOwner());
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: async () => 'unsupported',
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.match(recovered.reason, /unsupported/i);
      });
      // Capability is probed before checkpoint/quarantine mutations.
      assert.equal(existsSync(context.lockPath), true);
      assert.equal(await readFile(join(context.lockPath, 'owner.json'), 'utf8'), JSON.stringify(validLockOwner()));
      assert.equal(existsSync(`${context.lockPath}.quarantine.${TEST_TOKEN}.${SUCCESSOR_TOKEN}`), false);
      assert.equal(existsSync(`${context.lockPath}.recovery.${TEST_TOKEN}.${SUCCESSOR_TOKEN}.json`), false);
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

      let orphaned!: Awaited<ReturnType<typeof recoverSessionPointerLock>>;
      await withPointerDependencies({
        atomicRenameNoReplace: async (from, to) => {
          await rename(from, to);
          return 'moved';
        },
      }, async () => { orphaned = await recoverSessionPointerLock(cwd); });
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
    const cases: Array<{ name: string; files: Array<[string, string]>; probePid: 'alive' | 'dead'; observation?: ProcessObservation }> = [
      { name: 'live-temp', files: [[`owner.${TEST_TOKEN}.tmp`, JSON.stringify(validLockOwner())]], probePid: 'alive', observation: matchingObservation() },
      { name: 'reused', files: [['owner.json', JSON.stringify(validLockOwner())]], probePid: 'alive', observation: { kind: 'identity', identity: { platform: 'linux', birth: '2' } } },
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
          observeProcess: () => testCase.observation ?? matchingObservation(),
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
      const links: Array<[string, string]> = [];
      let successorBlocked = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        fs: {
          link: async (from, to) => {
            links.push([from, to]);
            await link(from, to);
          },
        },
        atomicRenameNoReplace: async (from, to) => {
          if (from === context.lockPath) {
            await assert.rejects(mkdir(context.lockPath), { code: 'EEXIST' });
            successorBlocked = true;
          }
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          return 'moved';
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, true);
      });
      assert.equal(successorBlocked, true);
      assert.equal(links.length, 1);
      assert.match(links[0]![0], /owner\.transaction_token_123456\.tmp$/);
      assert.equal(links[0]![1].includes('.quarantine.'), true);
      assert.equal(existsSync(`${context.lockPath}.parked-lock-${SUCCESSOR_TOKEN}`), true);
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
          link: async (from, to) => {
            if (!displaced && from === staleTemp) {
              displaced = true;
              await rename(context.lockPath, displacedPath);
              await mkdir(context.lockPath);
              await writeFile(successorTemp, JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })), 'utf-8');
            }
            await link(from, to);
          },
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /Recovery checkpoint.*ENOENT/i);
      });
      assert.equal(displaced, true);
      assert.deepEqual(await readdir(context.lockPath), [`owner.${SUCCESSOR_TOKEN}.tmp`]);
      assert.equal(await readFile(successorTemp, 'utf-8'), JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not report recovery after a successor live lock appears during parked-lock removal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-lock-recovery-post-claim-race-'));
    try {
      const context = resolveSessionPointerContext(cwd);
      const staleTemp = join(context.lockPath, `owner.${TEST_TOKEN}.tmp`);
      const successorTemp = join(context.lockPath, `owner.${SUCCESSOR_TOKEN}.tmp`);
      await mkdir(context.lockPath, { recursive: true });
      await writeFile(staleTemp, JSON.stringify(validLockOwner()), 'utf-8');
      let displaced = false;
      await withPointerDependencies({
        token: () => SUCCESSOR_TOKEN,
        probePid: () => 'dead',
        atomicRenameNoReplace: async (from, to) => {
          if (existsSync(to)) return 'not-moved';
          await rename(from, to);
          if (!displaced && from === context.lockPath) {
            displaced = true;
            await mkdir(context.lockPath);
            await writeFile(successorTemp, JSON.stringify(validLockOwner({ token: SUCCESSOR_TOKEN })), 'utf-8');
          }
          return 'moved';
        },
      }, async () => {
        const recovered = await recoverSessionPointerLock(cwd);
        assert.equal(recovered.recovered, false);
        assert.equal(recovered.action, 'none');
        assert.match(recovered.reason, /did not leave the captured object/i);
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
        observeProcess: () => matchingObservation(),
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

  it('publishes a legacy-like Linux state when process identity capture fails', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('Linux identity publication semantics are under test.');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-identity-capture-failure-'));
    try {
      await withPointerDependencies({
        runtimePlatform: 'linux',
        observeProcess: () => ({ kind: 'error' }),
      }, async () => {
        const state = await writeSessionStart(cwd, 'sess-identity-capture-failure', { platform: 'linux' });
        assert.equal(state.platform, 'linux');
        assert.equal(Object.hasOwn(state, 'identity_schema_version'), false);
        assert.equal(Object.hasOwn(state, 'process_identity'), false);
        assert.equal(Object.hasOwn(state, 'pid_start_ticks'), false);
        const persisted = await readSessionState(cwd);
        assert.ok(persisted);
        assert.equal(Object.hasOwn(persisted, 'identity_schema_version'), false);
        assert.equal(Object.hasOwn(persisted, 'process_identity'), false);
      });
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
      await writeSessionStart(syncedCwd, 'sess-synced-start', {
        platform: 'win32',
        regularFileSync: async () => {},
      });
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
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
      }, async () => {
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

          await assert.rejects(
            reconcileNativeSessionStart(cwd, 'native-second', {
              platform: 'win32',
              ownerAliasVerified: true,
            }),
            isOwnerConflict,
          );

          const persisted = await readSessionState(cwd);
          assert.equal(persisted?.session_id, 'native-first');
          assert.equal(persisted?.owner_omx_session_id, 'omx-owner');
        });
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps native session owner sidecars isolated and rejects live cross-process reuse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-sidecar-'));
    try {
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
        probePid: () => 'alive',
      }, async () => {
        const first = await writeNativeSessionOwner(
          cwd,
          'native-owner-a',
          { pid: 11, platform: 'win32' },
        );
        const second = await writeNativeSessionOwner(
          cwd,
          'native-owner-b',
          { pid: 22, platform: 'win32' },
        );
        assert.equal(first.pid, 11);
        assert.equal(second.pid, 22);
        const firstPath = join(
          cwd,
          '.omx',
          'state',
          'sessions',
          'native-owner-a',
          'session-owner.json',
        );
        const secondPath = join(
          cwd,
          '.omx',
          'state',
          'sessions',
          'native-owner-b',
          'session-owner.json',
        );
        assert.equal(
          (JSON.parse(await readFile(firstPath, 'utf-8')) as SessionState).pid,
          11,
        );
        assert.equal(
          (JSON.parse(await readFile(secondPath, 'utf-8')) as SessionState).pid,
          22,
        );
        await writeNativeSessionOwner(cwd, 'native-owner-current', {
          pid: process.pid,
          platform: 'win32',
        });
        assert.equal(
          (await readNativeSessionOwner(cwd, 'native-owner-current'))?.pid,
          process.pid,
        );
        await assert.rejects(
          writeNativeSessionOwner(
            cwd,
            'native-owner-a',
            { pid: 22, platform: 'win32' },
          ),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_owner_conflict',
        );
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked native owner state root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-root-symlink-'));
    try {
      const externalState = join(cwd, 'external-state');
      const ownerDir = join(externalState, 'sessions', 'native-owner-root-link');
      await mkdir(ownerDir, { recursive: true });
      await writeFile(join(ownerDir, 'session-owner.json'), JSON.stringify({
        session_id: 'native-owner-root-link',
        native_session_id: 'native-owner-root-link',
        cwd,
        platform: process.platform,
      }));
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await symlink(externalState, join(cwd, '.omx', 'state'));
      assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-root-link')).status, 'malformed');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('rejects symlinked native owner directories and sidecars', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-symlink-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      const sessionsDir = join(stateDir, 'sessions');
      const externalDir = join(cwd, 'external-owner');
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(externalDir, { recursive: true });
      await writeFile(join(externalDir, 'session-owner.json'), JSON.stringify({
        session_id: 'native-owner-dir-link',
        native_session_id: 'native-owner-dir-link',
        cwd,
        platform: process.platform,
      }));
      await symlink(externalDir, join(sessionsDir, 'native-owner-dir-link'));
      assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-dir-link')).status, 'malformed');

      const fileLinkDir = join(sessionsDir, 'native-owner-file-link');
      await mkdir(fileLinkDir, { recursive: true });
      const externalFile = join(cwd, 'external-session-owner.json');
      await writeFile(externalFile, JSON.stringify({
        session_id: 'native-owner-file-link',
        native_session_id: 'native-owner-file-link',
        cwd,
        platform: process.platform,
      }));
      await symlink(externalFile, join(fileLinkDir, 'session-owner.json'));
      assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-file-link')).status, 'malformed');

      const swappedOwnerId = 'native-owner-swapped-dir';
      const swappedOwnerDir = join(sessionsDir, swappedOwnerId);
      await mkdir(swappedOwnerDir, { recursive: true });
      await writeFile(join(swappedOwnerDir, 'session-owner.json'), JSON.stringify({
        session_id: swappedOwnerId,
        native_session_id: swappedOwnerId,
        cwd,
        platform: process.platform,
      }));
      let swappedOwnerLstatCalls = 0;
      await withPointerDependencies({
        fs: {
          lstat: async (path) => {
            const stat = await lstat(path);
            const simulateSwap = path === swappedOwnerDir && ++swappedOwnerLstatCalls === 2;
            return {
              dev: Number(stat.dev) + (simulateSwap ? 1 : 0),
              ino: Number(stat.ino),
              isDirectory: () => stat.isDirectory(),
              isFile: () => stat.isFile(),
              isSymbolicLink: () => stat.isSymbolicLink(),
            };
          },
        },
      }, async () => {
        assert.equal((await readNativeSessionOwnerEvidence(cwd, swappedOwnerId)).status, 'malformed');
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('rejects owner sidecars recorded for another platform', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-platform-'));
    try {
      const ownerDir = join(
        cwd,
        '.omx',
        'state',
        'sessions',
        'native-owner-platform',
      );
      await mkdir(ownerDir, { recursive: true });
      const ownerPath = join(ownerDir, 'session-owner.json');
      const forgedPlatform: NodeJS.Platform = process.platform === 'win32'
        ? 'darwin'
        : 'win32';
      await writeFile(ownerPath, JSON.stringify({
        session_id: 'native-owner-platform',
        native_session_id: 'native-owner-platform',
        started_at: new Date().toISOString(),
        cwd,
        pid: process.pid,
        platform: forgedPlatform,
      }), 'utf-8');
      const before = await readFile(ownerPath, 'utf-8');

      assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-platform')).status, 'identity-indeterminate');
      assert.equal(await readNativeSessionOwner(cwd, 'native-owner-platform'), null);
      await assert.rejects(
        writeNativeSessionOwner(cwd, 'native-owner-platform', {
          pid: process.pid,
        }),
        (error: unknown) => isSessionPointerLaunchAbort(error)
          && error.code === 'session_pointer_unusable',
      );
      assert.equal(await readFile(ownerPath, 'utf-8'), before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('replaces only stale-dead owner evidence and preserves malformed evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-owner-recovery-'));
    try {
      assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-absent')).status, 'absent');
      await withPointerDependencies({
        probePid: (pid) => pid === 11 ? 'dead' : 'alive',
        observeProcess: () => ({ kind: 'identity', identity: { platform: 'linux' as const, birth: '1' } }),
      }, async () => {
        await writeNativeSessionOwner(
          cwd,
          'native-owner-recovery',
          { pid: 11, platform: 'linux' },
        );
        assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-recovery')).status, 'stale-dead');
        const recovered = await writeNativeSessionOwner(
          cwd,
          'native-owner-recovery',
          { pid: 22, platform: 'linux' },
        );
        assert.equal(recovered.pid, 22);

        const malformedDir = join(
          cwd,
          '.omx',
          'state',
          'sessions',
          'native-owner-malformed',
        );
        await mkdir(malformedDir, { recursive: true });
        const malformedPath = join(malformedDir, 'session-owner.json');
        await writeFile(malformedPath, '{ malformed', 'utf-8');
        assert.equal(await readNativeSessionOwner(cwd, 'native-owner-malformed'), null);
        assert.equal((await readNativeSessionOwnerEvidence(cwd, 'native-owner-malformed')).status, 'malformed');
        await assert.rejects(
          writeNativeSessionOwner(
            cwd,
            'native-owner-malformed',
            { pid: 22, platform: 'win32' },
          ),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_unusable'
            && error.pointerStatus === 'malformed',
        );

        const forgedDir = join(
          cwd,
          '.omx',
          'state',
          'sessions',
          'native-owner-forged',
        );
        await mkdir(forgedDir, { recursive: true });
        const forgedPath = join(forgedDir, 'session-owner.json');
        await writeFile(forgedPath, JSON.stringify({
          session_id: 'native-owner-other',
          native_session_id: 'native-owner-other',
          started_at: new Date().toISOString(),
          cwd,
          pid: 22,
          platform: 'linux',
          pid_start_ticks: 1,
        }), 'utf-8');
        const forgedBefore = await readFile(forgedPath, 'utf-8');
        assert.equal(await readNativeSessionOwner(cwd, 'native-owner-forged'), null);
        await assert.rejects(
          writeNativeSessionOwner(
            cwd,
            'native-owner-forged',
            { pid: 22, platform: 'linux' },
          ),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_owner_conflict',
        );
        assert.equal(await readFile(forgedPath, 'utf-8'), forgedBefore);

        const missingCwdDir = join(
          cwd,
          '.omx',
          'state',
          'sessions',
          'native-owner-missing-cwd',
        );
        await mkdir(missingCwdDir, { recursive: true });
        const missingCwdPath = join(missingCwdDir, 'session-owner.json');
        await writeFile(missingCwdPath, JSON.stringify({
          session_id: 'native-owner-missing-cwd',
          native_session_id: 'native-owner-missing-cwd',
          started_at: new Date().toISOString(),
          pid: 22,
          platform: 'linux',
          pid_start_ticks: 1,
        }), 'utf-8');
        const missingCwdBefore = await readFile(missingCwdPath, 'utf-8');
        assert.equal(await readNativeSessionOwner(cwd, 'native-owner-missing-cwd'), null);
        await assert.rejects(
          writeNativeSessionOwner(
            cwd,
            'native-owner-missing-cwd',
            { pid: 22, platform: 'linux' },
          ),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_owner_conflict',
        );
        assert.equal(await readFile(missingCwdPath, 'utf-8'), missingCwdBefore);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects cross-process native reconciliation while preserving the live selected pointer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-cross-process-selected-'));
    try {
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
        probePid: () => 'alive',
      }, async () => {
        await writeSessionStart(cwd, 'native-selected-a', {
          nativeSessionId: 'native-selected-a',
          pid: 11,
          platform: 'win32',
        });
        const context = resolveSessionPointerContext(cwd);
        const before = await readFile(context.sessionPath, 'utf-8');
        await assert.rejects(
          reconcileNativeSessionStart(
            cwd,
            'native-selected-b',
            { pid: 22, platform: 'win32' },
          ),
          (error: unknown) => isSessionPointerLaunchAbort(error)
            && error.code === 'session_pointer_owner_conflict',
        );
        assert.equal(await readFile(context.sessionPath, 'utf-8'), before);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves pointer evidence when history cannot be appended and rejects unusable end states before history or HUD cleanup', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-end-preserve-'));
    try {
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
      }, async () => {
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
      });
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

  it('preserves process_identity across detached metadata updates', async (t) => {
    if (process.platform !== 'linux') {
      t.skip('Linux v2 process identity publication semantics are under test.');
      return;
    }
    const cwd = await mkdtemp(join(tmpdir(), 'omx-session-binding-identity-preserve-'));
    let binding: LaunchSessionBinding | undefined;
    try {
      await withPointerDependencies({
        runtimePlatform: 'linux',
        observeProcess: () => matchingObservation(),
      }, async () => {
        const established = await establishLaunchSessionBinding(cwd, 'sess-binding-identity-preserve', { platform: 'linux' });
        assert.equal(established.kind, 'committed-released');
        if (established.kind !== 'committed-released') return;
        const establishedBinding = established.binding;
        binding = establishedBinding;
        const before = await readSessionState(cwd);
        assert.ok(before?.process_identity);
        const metadata = await updateDetachedSessionMetadata(establishedBinding, { tmuxPaneId: '%identity-preserved' });
        assert.equal(metadata.kind, 'committed-released');
        const after = await readSessionState(cwd);
        assert.deepEqual(after?.process_identity, before?.process_identity);
        assert.equal(after?.identity_schema_version, 2);
        assert.equal(after?.tmux_pane_id, '%identity-preserved');
        assert.equal((await finalizeBoundOnce(establishedBinding, 'identity-preserved')).finalized, true);
      });
    } finally {
      if (binding) await closeLaunchSessionBindingOnce(binding).catch(() => {});
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
          observeProcess: () => matchingObservation(),
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
      await withPointerDependencies({
        runtimePlatform: 'win32',
        observeProcess: () => matchingWin32Observation(),
      }, async () => {
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

        await withPointerDependencies({
          runtimePlatform: 'win32',
          observeProcess: () => matchingWin32Observation(),
          probePid: () => 'dead',
        }, async () => {
          const finalized = await finalizeBoundOnce(stale as LaunchSessionBinding, 'stale-unsupported');
          assert.equal(finalized.finalized, true);
          assert.equal(finalized.cleanup.comparison?.status, 'matched');
          assert.match(finalized.cleanup.comparison?.reason ?? '', /unsupported-directory-capability:platform/);
        });
        assert.equal(existsSync(context.sessionPath), false);
        const history = await readFile(historyPath, 'utf-8');
        assert.match(history, /native-unsupported-stale/);
      });
    } finally {
      if (ordinary) await closeLaunchSessionBindingOnce(ordinary).catch(() => {});
      if (stale) await closeLaunchSessionBindingOnce(stale).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves native lineage and tmux metadata when rejecting a live native-ID replacement', async () => {
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

      await assert.rejects(reconcileNativeSessionStart(cwd, 'native-after', { pid: process.pid }), isOwnerConflict);
      const persisted = await readSessionState(cwd);
      assert.equal(persisted?.session_id, binding.canonicalSessionId);
      assert.equal(persisted?.native_session_id, 'native-before');
      assert.equal(persisted?.previous_native_session_id, undefined);
      assert.equal(persisted?.launch_lineage_token, binding.launchLineageToken);
      assert.equal(persisted?.tmux_session_name, 'omx-native-lineage');
      assert.equal(persisted?.tmux_pane_id, '%88');
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
