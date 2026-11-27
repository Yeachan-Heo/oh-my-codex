import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { kill } from 'node:process';
import { getPackageRoot } from '../utils/package.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export interface RunHudAuthorityTickOptions {
  cwd: string;
  nodePath?: string;
  packageRoot?: string;
  pollMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  minIntervalMs?: number;
  jitterMs?: number;
}

export interface RunHudAuthorityTickDeps {
  runProcess?: (
    nodePath: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    },
  ) => Promise<void> | void;
  nowMs?: () => number;
  random?: () => number;
  onLockAcquired?: () => Promise<void> | void;
  spawn?: (nodePath: string, args: string[], options: Record<string, unknown>) => { pid?: number; unref: () => void; on?: (event: 'error', listener: (error: Error) => void) => unknown };
  kill?: (pid: number, signal?: number | string) => void;
}

interface HudAuthorityState {
  owner: 'hud';
  pid: number;
  cwd: string;
  heartbeat_at: string;
  last_spawn_at?: string;
  next_allowed_at?: string;
  cooldown_ms: number;
  jitter_ms: number;
  last_status: 'spawned' | 'skipped' | 'failed' | 'locked';
  last_reason: string;
  last_error?: string;
  idle_streak?: number;
  state_fingerprint?: string;
}

interface AuthorityLock {
  path: string;
  token: string;
}

class AuthorityStateReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(`failed to read HUD authority state: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function isDeletedCwdMarkerPath(path: string): boolean {
  const currentPath = path.trim();
  return /(?:^|\s)\(deleted\)\s*$/.test(currentPath) && !existsSync(currentPath);
}

async function defaultRunProcess(
  nodePath: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<void> {
  const result = spawnSync(nodePath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
    const suffix = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? 'unknown'}`;
    throw new Error(output ? `hud authority tick failed with ${suffix}: ${output}` : `hud authority tick failed with ${suffix}`);
  }
  if (result.error) {
    throw new Error(`hud authority tick failed: ${result.error.message}`);
  }
}

function asPositiveNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asNonNegativeNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Idle ticks double the spawn interval up to this cap; activity or a HUD-visible
// state change drops back to the minimum interval.
const AUTHORITY_IDLE_MAX_INTERVAL_MS = 60_000;

// Cheap signature of what the HUD renders or the authority must drain (mode state files, teams,
// team dispatch queues, sessions).
async function readHudStateFingerprint(stateDir: string): Promise<string> {
  const parts: string[] = [];
  const collect = async (dir: string, label: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('notify-fallback')) continue;
      if (entry.isDirectory()) {
        if (label === '' && entry.name === 'team') {
          for (const team of await readdir(join(dir, entry.name)).catch(() => [])) {
            const requestsMtimeMs = (await stat(join(dir, entry.name, team, 'dispatch', 'requests.json')).catch(() => null))?.mtimeMs ?? 0;
            parts.push(`team/${team}@${requestsMtimeMs}`);
          }
        } else if (label === '' && entry.name === 'sessions') {
          for (const session of await readdir(join(dir, entry.name)).catch(() => [])) {
            await collect(join(dir, entry.name, session), `sessions/${session}/`);
          }
        }
      } else if (entry.name.endsWith('-state.json') || (label === '' && entry.name === 'dispatch.json')) {
        const mtimeMs = (await stat(join(dir, entry.name)).catch(() => null))?.mtimeMs ?? 0;
        parts.push(`${label}${entry.name}@${mtimeMs}`);
      }
    }
  };
  await collect(stateDir, '');
  return parts.sort().join('|');
}

async function isWatcherCycleIdle(stateDir: string): Promise<boolean> {
  try {
    const watcherState = JSON.parse(await readFile(join(stateDir, 'notify-fallback-state.json'), 'utf-8'));
    return Number(watcherState?.adaptive_poll?.idle_streak) > 0;
  } catch {
    return false;
  }
}

// A changed fingerprint lifts idle backoff, leaving only the minimum interval.
function resolveNextAllowedMs(state: HudAuthorityState | null, fingerprint: string): number | null {
  const nextAllowedMs = parseIsoMs(state?.next_allowed_at);
  const lastSpawnMs = parseIsoMs(state?.last_spawn_at);
  if (state && lastSpawnMs !== null && state.state_fingerprint !== fingerprint) {
    return lastSpawnMs + state.cooldown_ms + state.jitter_ms;
  }
  return nextAllowedMs;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function resolveHudWatcherScript(packageRoot: string, scriptName: 'notify-fallback-watcher.js' | 'notify-hook.js', cwd: string, env: NodeJS.ProcessEnv): string {
  const packageScript = join(packageRoot, 'dist', 'scripts', scriptName);
  if (existsSync(packageScript)) return packageScript;

  const entryPath = resolveOmxCliEntryPath({ cwd, env });
  if (entryPath && entryPath.endsWith('/dist/cli/omx.js')) {
    const entryRoot = dirname(dirname(dirname(entryPath)));
    const entryScript = join(entryRoot, 'dist', 'scripts', scriptName);
    if (existsSync(entryScript)) return entryScript;
  }

  return packageScript;
}

function isAuthorityStatus(value: unknown): value is HudAuthorityState['last_status'] {
  return value === 'spawned' || value === 'skipped' || value === 'failed' || value === 'locked';
}

function validateAuthorityState(value: unknown): HudAuthorityState {
  if (typeof value !== 'object' || value === null) {
    throw new Error('authority state must be an object');
  }
  const state = value as Partial<HudAuthorityState>;
  if (state.owner !== 'hud') throw new Error('authority state owner must be hud');
  if (typeof state.pid !== 'number' || !Number.isInteger(state.pid) || state.pid <= 0) {
    throw new Error('authority state pid must be a positive integer');
  }
  if (typeof state.cwd !== 'string' || !state.cwd) throw new Error('authority state cwd must be a non-empty string');
  if (parseIsoMs(state.heartbeat_at) === null) throw new Error('authority state heartbeat_at must be a valid ISO timestamp');
  if (parseIsoMs(state.next_allowed_at) === null) throw new Error('authority state next_allowed_at must be a valid ISO timestamp');
  if (typeof state.cooldown_ms !== 'number' || !Number.isFinite(state.cooldown_ms) || state.cooldown_ms < 0) {
    throw new Error('authority state cooldown_ms must be a non-negative number');
  }
  if (typeof state.jitter_ms !== 'number' || !Number.isFinite(state.jitter_ms) || state.jitter_ms < 0) {
    throw new Error('authority state jitter_ms must be a non-negative number');
  }
  if (!isAuthorityStatus(state.last_status)) throw new Error('authority state last_status is invalid');
  if (typeof state.last_reason !== 'string' || !state.last_reason) {
    throw new Error('authority state last_reason must be a non-empty string');
  }
  return state as HudAuthorityState;
}

async function readAuthorityState(path: string): Promise<HudAuthorityState | null> {
  try {
    return validateAuthorityState(JSON.parse(await readFile(path, 'utf-8')));
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw new AuthorityStateReadError(path, error);
  }
}

async function writeAuthorityState(path: string, state: HudAuthorityState): Promise<boolean> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true }).catch(() => {});
    await writeFile(tempPath, JSON.stringify(state, null, 2));
    await rename(tempPath, path);
    return true;
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    return false;
  }
}

async function tryCreateAuthorityLock(lockPath: string, nowMs: number): Promise<AuthorityLock | null> {
  const token = randomUUID();
  let createdDir = false;
  try {
    await mkdir(lockPath, { recursive: false });
    createdDir = true;
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token,
      pid: process.pid,
      acquired_at: new Date(nowMs).toISOString(),
    }, null, 2));
    return { path: lockPath, token };
  } catch {
    if (createdDir) await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

async function readAuthorityLockOwner(lockPath: string): Promise<{ token?: unknown } | null> {
  return readFile(join(lockPath, 'owner.json'), 'utf-8')
    .then((content) => JSON.parse(content) as { token?: unknown })
    .catch(() => null);
}

async function restoreMovedLock(fromPath: string, toPath: string): Promise<void> {
  const restored = await rename(fromPath, toPath).then(() => true).catch(() => false);
  if (!restored) await rm(fromPath, { recursive: true, force: true }).catch(() => {});
}

async function acquireAuthorityLock(lockPath: string, staleMs: number, nowMs: number): Promise<AuthorityLock | null> {
  const created = await tryCreateAuthorityLock(lockPath, nowMs);
  if (created) return created;

  const observedOwner = await readAuthorityLockOwner(lockPath);
  const lockStat = await stat(lockPath).catch(() => null);
  if (!lockStat || nowMs - lockStat.mtimeMs <= staleMs) return null;

  const reapPath = `${lockPath}.stale.${process.pid}.${nowMs}.${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch {
    return null;
  }

  const reapedOwner = await readAuthorityLockOwner(reapPath);
  const reapedStat = await stat(reapPath).catch(() => null);
  const reapedObservedLock = observedOwner?.token === reapedOwner?.token
    && reapedStat?.mtimeMs === lockStat.mtimeMs
    && nowMs - reapedStat.mtimeMs > staleMs;

  if (!reapedObservedLock) {
    await restoreMovedLock(reapPath, lockPath);
    return null;
  }

  await rm(reapPath, { recursive: true, force: true }).catch(() => {});
  return tryCreateAuthorityLock(lockPath, nowMs);
}

async function releaseAuthorityLock(lock: AuthorityLock): Promise<void> {
  const releasePath = `${lock.path}.release.${process.pid}.${Date.now()}.${lock.token}`;
  try {
    await rename(lock.path, releasePath);
  } catch {
    return;
  }

  const releaseOwner = await readAuthorityLockOwner(releasePath);
  if (releaseOwner?.token === lock.token) {
    await rm(releasePath, { recursive: true, force: true }).catch(() => {});
    return;
  }

  await restoreMovedLock(releasePath, lock.path);
}

function buildAuthorityState(
  cwd: string,
  nowMs: number,
  cooldownMs: number,
  jitterMs: number,
  overrides: Partial<HudAuthorityState>,
): HudAuthorityState {
  return {
    owner: 'hud',
    pid: process.pid,
    cwd,
    heartbeat_at: new Date(nowMs).toISOString(),
    cooldown_ms: cooldownMs,
    jitter_ms: jitterMs,
    last_status: 'spawned',
    last_reason: 'spawned',
    ...overrides,
  };
}

async function writeInvalidStateDiagnostic(
  path: string,
  ownerPath: string,
  cwd: string,
  nowMs: number,
  cooldownMs: number,
  jitterMs: number,
  error: unknown,
): Promise<boolean> {
  const failedState = buildAuthorityState(cwd, nowMs, cooldownMs, jitterMs, {
    next_allowed_at: new Date(nowMs + cooldownMs + jitterMs).toISOString(),
    last_status: 'failed',
    last_reason: 'invalid_authority_state',
    last_error: error instanceof Error ? error.message : String(error),
  });
  const ownerWritten = await writeAuthorityState(ownerPath, failedState);
  const stateWritten = await writeAuthorityState(path, failedState);
  return ownerWritten || stateWritten;
}

interface PersistentWatcherRecord {
  pid: number;
  started_at: string;
}

async function readPersistentWatcherRecord(path: string): Promise<PersistentWatcherRecord | null> {
  try {
    const content = JSON.parse(await readFile(path, 'utf-8'));
    if (typeof content === 'object' && content !== null && typeof content.pid === 'number' && typeof content.started_at === 'string') {
      return content as PersistentWatcherRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number, killFn?: (pid: number, signal?: number | string) => void): boolean {
  const killToUse = killFn ?? kill;
  try {
    killToUse(pid, 0);
    return true;
  } catch (error) {
    return error !== null && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ensurePersistentWatcherRunning(
  nodePath: string,
  watcherScript: string,
  cwd: string,
  notifyScript: string,
  pollMs: number,
  watcherPidPath: string,
  env: NodeJS.ProcessEnv,
  spawnFn?: RunHudAuthorityTickDeps['spawn'],
  killFn?: (pid: number, signal?: number | string) => void,
): Promise<number> {
  const existingRecord = await readPersistentWatcherRecord(watcherPidPath);
  if (existingRecord && isProcessAlive(existingRecord.pid, killFn)) {
    return existingRecord.pid;
  }

  // Spawn a new persistent watcher (without --once flag)
  const spawnToUse = spawnFn ?? spawn;
  const child = spawnToUse(nodePath, [
    watcherScript,
    '--authority-only',
    '--cwd',
    cwd,
    '--notify-script',
    notifyScript,
    '--poll-ms',
    String(pollMs),
  ], {
    cwd,
    env: {
      ...env,
      OMX_HUD_AUTHORITY_PERSISTENT: '1',
    },
    stdio: 'ignore',
    detached: true,
  });

  // spawn() reports launch failures (ENOENT, EAGAIN) as an async 'error' event and leaves pid unset.
  // Swallow the event so it cannot kill the HUD, and surface the failure through the caller's catch.
  child.on?.('error', () => {});
  const pid = child.pid;
  if (pid === undefined) throw new Error('failed to spawn persistent authority watcher');
  child.unref();

  const record: PersistentWatcherRecord = {
    pid,
    started_at: new Date().toISOString(),
  };
  await writeFile(watcherPidPath, JSON.stringify(record, null, 2)).catch(() => {});
  return pid;
}

async function writePersistentWatcherMarker(
  markerPath: string,
  fingerprintValue: string,
): Promise<boolean> {
  try {
    await mkdir(dirname(markerPath), { recursive: true }).catch(() => {});
    await writeFile(markerPath, JSON.stringify({
      type: 'authority-tick',
      fingerprint: fingerprintValue,
      requested_at: new Date().toISOString(),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export async function runHudAuthorityTick(
  options: RunHudAuthorityTickOptions,
  deps: RunHudAuthorityTickDeps = {},
): Promise<void> {
  const cwd = options.cwd;
  if (isDeletedCwdMarkerPath(cwd)) return;
  const nodePath = options.nodePath ?? process.execPath;
  const packageRoot = options.packageRoot ?? getPackageRoot();
  const pollMs = Math.max(1, options.pollMs ?? 75);
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  const minIntervalMs = Math.max(
    250,
    asPositiveNumber(
      options.minIntervalMs ?? options.env?.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS ?? process.env.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS,
      5_000,
    ),
  );
  const jitterMaxMs = Math.max(
    0,
    asNonNegativeNumber(
      options.jitterMs ?? options.env?.OMX_HUD_AUTHORITY_JITTER_MS ?? process.env.OMX_HUD_AUTHORITY_JITTER_MS,
      250,
    ),
  );
  const nowMs = deps.nowMs?.() ?? Date.now();
  const random = deps.random ?? Math.random;
  const jitterMs = jitterMaxMs > 0 ? Math.floor(random() * (jitterMaxMs + 1)) : 0;
  const mergedEnv = { ...process.env, ...options.env };
  const watcherScript = resolveHudWatcherScript(packageRoot, 'notify-fallback-watcher.js', cwd, mergedEnv);
  const notifyScript = resolveHudWatcherScript(packageRoot, 'notify-hook.js', cwd, mergedEnv);
  const authorityStateDir = join(cwd, '.omx', 'state');
  const authorityOwnerPath = join(authorityStateDir, 'notify-fallback-authority-owner.json');
  const authorityStatePath = join(authorityStateDir, 'notify-fallback-authority-state.json');
  const authorityLockPath = join(authorityStateDir, 'notify-fallback-authority.lock');
  const runProcess = deps.runProcess ?? defaultRunProcess;

  await mkdir(authorityStateDir, { recursive: true }).catch(() => {});

  let previousState: HudAuthorityState | null;
  try {
    previousState = await readAuthorityState(authorityStatePath);
  } catch (error) {
    if (!(await writeInvalidStateDiagnostic(authorityStatePath, authorityOwnerPath, cwd, nowMs, minIntervalMs, jitterMs, error))) {
      throw new Error('failed to persist HUD authority invalid-state diagnostic');
    }
    return;
  }
  const fingerprint = await readHudStateFingerprint(authorityStateDir);
  const previousNextAllowedMs = resolveNextAllowedMs(previousState, fingerprint);
  if (previousState && previousNextAllowedMs !== null && nowMs < previousNextAllowedMs) {
    return;
  }

  const lock = await acquireAuthorityLock(authorityLockPath, timeoutMs + minIntervalMs, nowMs);
  if (!lock) {
    const latestState = await readAuthorityState(authorityStatePath).catch(() => null);
    const diagnosticState = latestState ?? previousState;
    const lockedState = buildAuthorityState(cwd, nowMs, minIntervalMs, diagnosticState?.jitter_ms ?? jitterMs, {
      last_spawn_at: diagnosticState?.last_spawn_at,
      next_allowed_at: diagnosticState?.next_allowed_at,
      last_status: 'locked',
      last_reason: 'spawn_lock_active',
      last_error: diagnosticState?.last_error,
    });
    await writeAuthorityState(authorityOwnerPath, lockedState);
    return;
  }

  await deps.onLockAcquired?.();

  let lockedState: HudAuthorityState | null;
  try {
    lockedState = await readAuthorityState(authorityStatePath);
  } catch (error) {
    const diagnosticWritten = await writeInvalidStateDiagnostic(authorityStatePath, authorityOwnerPath, cwd, nowMs, minIntervalMs, jitterMs, error);
    await releaseAuthorityLock(lock);
    if (!diagnosticWritten) throw new Error('failed to persist HUD authority rate-limit state');
    return;
  }
  const lockedNextAllowedMs = resolveNextAllowedMs(lockedState, fingerprint);
  if (lockedState && lockedNextAllowedMs !== null && nowMs < lockedNextAllowedMs) {
    await releaseAuthorityLock(lock);
    return;
  }

  const nextAllowedAt = new Date(nowMs + minIntervalMs + jitterMs).toISOString();
  const spawnedState = buildAuthorityState(cwd, nowMs, minIntervalMs, jitterMs, {
    last_spawn_at: new Date(nowMs).toISOString(),
    next_allowed_at: nextAllowedAt,
    last_status: 'spawned',
    last_reason: 'spawned',
    idle_streak: lockedState?.state_fingerprint === fingerprint ? lockedState.idle_streak : 0,
    state_fingerprint: fingerprint,
  });
  await writeAuthorityState(authorityOwnerPath, spawnedState);
  if (!(await writeAuthorityState(authorityStatePath, spawnedState))) {
    await releaseAuthorityLock(lock);
    throw new Error('failed to persist HUD authority rate-limit state');
  }

  try {
    // Option B: Reuse persistent notify-fallback-watcher and wake it with a marker
    const watcherPidPath = join(authorityStateDir, 'notify-fallback-authority-watcher.json');
    const markerPath = join(authorityStateDir, 'notify-fallback-authority-tick-marker.json');
    const mergedEnv = { ...process.env, ...(options.env ?? {}), OMX_HUD_AUTHORITY: '1', OMX_HUD_AUTHORITY_MIN_INTERVAL_MS: String(minIntervalMs), OMX_HUD_AUTHORITY_JITTER_MS: String(jitterMaxMs) };

    // Only use persistent watcher if not using a custom (mocked) runProcess
    const usesPersistentWatcher = deps.runProcess === undefined || deps.runProcess === defaultRunProcess;

    if (usesPersistentWatcher) {
      // Ensure persistent watcher is running
      await ensurePersistentWatcherRunning(nodePath, watcherScript, cwd, notifyScript, pollMs, watcherPidPath, mergedEnv, deps.spawn, deps.kill);

      // Write marker to trigger authority cycle
      if (!(await writePersistentWatcherMarker(markerPath, fingerprint))) {
        throw new Error('failed to write authority tick marker');
      }

      // Wait for marker to be consumed (watcher processes it)
      let consumed = false;
      const startWaitMs = Date.now();
      const maxWaitMs = Math.min(timeoutMs, 2000);
      while (Date.now() - startWaitMs < maxWaitMs) {
        if (!existsSync(markerPath)) {
          consumed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (!consumed && existsSync(markerPath)) {
        // Marker not consumed, fall back to spawning once-mode watcher as failsafe
        await runProcess(
          nodePath,
          [
            watcherScript,
            '--once',
            '--authority-only',
            '--cwd',
            cwd,
            '--notify-script',
            notifyScript,
            '--poll-ms',
            String(pollMs),
          ],
          {
            cwd,
            env: mergedEnv,
            timeoutMs,
          },
        );
      }
    } else {
      // Fall back to spawning once-mode watcher for mocked tests
      await runProcess(
        nodePath,
        [
          watcherScript,
          '--once',
          '--authority-only',
          '--cwd',
          cwd,
          '--notify-script',
          notifyScript,
          '--poll-ms',
          String(pollMs),
        ],
        {
          cwd,
          env: mergedEnv,
          timeoutMs,
        },
      );
    }

    const idle = await isWatcherCycleIdle(authorityStateDir);
    const idleStreak = idle ? (spawnedState.idle_streak ?? 0) + 1 : 0;
    const backoffMs = idle
      ? Math.min(Math.max(minIntervalMs, AUTHORITY_IDLE_MAX_INTERVAL_MS), minIntervalMs * 2 ** Math.min(idleStreak, 16))
      : minIntervalMs;
    const settledState = {
      ...spawnedState,
      idle_streak: idleStreak,
      next_allowed_at: new Date(nowMs + backoffMs + jitterMs).toISOString(),
    };
    await writeAuthorityState(authorityOwnerPath, settledState);
    await writeAuthorityState(authorityStatePath, settledState);
  } catch (error) {
    const failedAt = deps.nowMs?.() ?? Date.now();
    const failedState = buildAuthorityState(cwd, failedAt, minIntervalMs, jitterMs, {
      last_spawn_at: spawnedState.last_spawn_at,
      next_allowed_at: nextAllowedAt,
      last_status: 'failed',
      last_reason: 'child_failed',
      last_error: error instanceof Error ? error.message : String(error),
    });
    await writeAuthorityState(authorityOwnerPath, failedState);
    await writeAuthorityState(authorityStatePath, failedState);
    throw error;
  } finally {
    await releaseAuthorityLock(lock);
  }
}
