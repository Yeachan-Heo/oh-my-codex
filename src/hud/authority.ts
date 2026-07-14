import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { acquireHudLifecycleLock, releaseHudLifecycleLock, type HudLifecycleLockDeps } from './lifecycle-lock.js';
import { resolveHudControlPlaneDomain, type ResolvedHudControlPlaneDomain } from '../mcp/state-paths.js';
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
  resolveDomain?: (options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ResolvedHudControlPlaneDomain>;
  lifecycleLockDeps?: HudLifecycleLockDeps;
  processStartIdentity?: (pid: number) => Promise<string | undefined>;
  probeLeaseProcess?: (lease: HudAuthorityLease) => Promise<'live' | 'dead' | 'reused' | 'uncertain'>;
}

interface HudAuthorityState {
  owner: 'hud';
  pid: number;
  cwd: string;
  heartbeat_at: string;
  last_spawn_at?: string;
  last_skip_at?: string;
  next_allowed_at?: string;
  cooldown_ms: number;
  jitter_ms: number;
  skip_count: number;
  last_status: 'spawned' | 'skipped' | 'failed' | 'locked';
  last_reason: string;
  last_error?: string;
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
  if (typeof state.skip_count !== 'number' || !Number.isInteger(state.skip_count) || state.skip_count < 0) {
    throw new Error('authority state skip_count must be a non-negative integer');
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

async function writeAuthorityStateUnlessNewerCooldown(path: string, state: HudAuthorityState): Promise<boolean> {
  const currentState = await readAuthorityState(path).catch(() => null);
  const currentNextAllowedMs = parseIsoMs(currentState?.next_allowed_at);
  const candidateNextAllowedMs = parseIsoMs(state.next_allowed_at);
  if (currentNextAllowedMs !== null && candidateNextAllowedMs !== null && currentNextAllowedMs > candidateNextAllowedMs) {
    return true;
  }
  return writeAuthorityState(path, state);
}

export interface HudAuthorityLease {
  version: 2;
  domainKey: string;
  baseStateDir: string;
  rootSource: ResolvedHudControlPlaneDomain['rootSource'];
  pid: number;
  platform: NodeJS.Platform;
  processStartIdentity: string;
  claimant: string;
  token: string;
  generation: string;
  heartbeatAt: string;
}

function claimantIdentity(domain: ResolvedHudControlPlaneDomain): string {
  return JSON.stringify(domain.claimant);
}

function isLease(value: unknown): value is HudAuthorityLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Partial<HudAuthorityLease>;
  return lease.version === 2
    && typeof lease.domainKey === 'string' && lease.domainKey.length > 0
    && typeof lease.baseStateDir === 'string' && lease.baseStateDir.length > 0
    && typeof lease.rootSource === 'string' && lease.rootSource.length > 0
    && typeof lease.pid === 'number' && Number.isInteger(lease.pid) && lease.pid > 0
    && typeof lease.platform === 'string' && lease.platform.length > 0
    && typeof lease.processStartIdentity === 'string' && lease.processStartIdentity.trim().length > 0
    && typeof lease.claimant === 'string'
    && typeof lease.token === 'string' && lease.token.length > 0
    && typeof lease.generation === 'string' && lease.generation.length > 0
    && parseIsoMs(lease.heartbeatAt) !== null;
}

async function readAuthorityLease(path: string): Promise<HudAuthorityLease | null | 'uncertain'> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isLease(value) ? value : 'uncertain';
  } catch (error) {
    return isNotFoundError(error) ? null : 'uncertain';
  }
}

async function writeAuthorityLease(path: string, lease: HudAuthorityLease): Promise<boolean> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(lease, null, 2));
    await rename(tempPath, path);
    return true;
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
    return false;
  }
}

async function defaultProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      const content = await readFile(`/proc/${pid}/stat`, 'utf8');
      const closeParen = content.lastIndexOf(')');
      const fields = closeParen < 0 ? [] : content.slice(closeParen + 2).trim().split(/\s+/);
      const startTime = fields[19];
      return startTime ? `linux:${startTime}` : undefined;
    } catch {
      return undefined;
    }
  }

  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const startTime = result.status === 0 ? result.stdout.trim() : '';
    return startTime ? `darwin:${startTime}` : undefined;
  }

  if (process.platform === 'win32') {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: 'utf8', windowsHide: true });
    const startTime = result.status === 0 ? result.stdout.trim() : '';
    return startTime ? `win32:${startTime}` : undefined;
  }

  return undefined;
}

async function defaultProbeLeaseProcess(lease: HudAuthorityLease): Promise<'live' | 'dead' | 'reused' | 'uncertain'> {
  if (lease.platform !== process.platform) return 'uncertain';
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH' ? 'dead' : 'uncertain';
  }
  const currentIdentity = await defaultProcessStartIdentity(lease.pid);
  if (!currentIdentity) return 'uncertain';
  return currentIdentity === lease.processStartIdentity ? 'live' : 'reused';
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
    skip_count: 0,
    last_status: 'spawned',
    last_reason: 'spawned',
    ...overrides,
  };
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
  // The watcher is synchronous by design: never imply a detached child can be
  // reaped safely later. A bounded tick also keeps the shared lease short.
  const timeoutMs = Math.min(1_000, Math.max(1, options.timeoutMs ?? 1_000));
  const minIntervalMs = Math.max(
    1_000,
    asPositiveNumber(
      options.minIntervalMs ?? options.env?.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS ?? process.env.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS,
      5_000,
    ),
  );
  const jitterMaxMs = Math.max(0, asNonNegativeNumber(
    options.jitterMs ?? options.env?.OMX_HUD_AUTHORITY_JITTER_MS ?? process.env.OMX_HUD_AUTHORITY_JITTER_MS,
    250,
  ));
  const nowMs = deps.nowMs?.() ?? Date.now();
  const jitterMs = jitterMaxMs > 0 ? Math.floor((deps.random ?? Math.random)() * (jitterMaxMs + 1)) : 0;
  const mergedEnv = { ...process.env, ...options.env };
  const domain = await (deps.resolveDomain ?? resolveHudControlPlaneDomain)({ cwd, env: mergedEnv });
  const runProcess = deps.runProcess ?? defaultRunProcess;

  await mkdir(domain.baseStateDir, { recursive: true });
  const acquired = await acquireHudLifecycleLock(
    { path: domain.authorityLockPath, domainKey: domain.domainKey, staleMs: Math.max(minIntervalMs * 2, timeoutMs * 2) },
    { ...deps.lifecycleLockDeps, nowMs: deps.lifecycleLockDeps?.nowMs ?? (() => nowMs) },
  );
  // A contender must not emit state or diagnostics. The current primary owns
  // every canonical authority write, including rate-limit diagnostics.
  if (acquired.status !== 'acquired' || !acquired.lock) return;

  try {
    await deps.onLockAcquired?.();
    const claimant = claimantIdentity(domain);
    const processStartIdentity = await (deps.processStartIdentity ?? defaultProcessStartIdentity)(process.pid);
    if (typeof processStartIdentity !== 'string' || processStartIdentity.trim().length === 0) return;
    const currentLease = await readAuthorityLease(domain.authorityLeasePath);
    const ownsLease = currentLease !== null
      && currentLease !== 'uncertain'
      && currentLease.domainKey === domain.domainKey
      && currentLease.baseStateDir === domain.baseStateDir
      && currentLease.rootSource === domain.rootSource
      && currentLease.pid === process.pid
      && currentLease.platform === process.platform
      && currentLease.processStartIdentity === processStartIdentity
      && currentLease.claimant === claimant;
    const leaseProbe = currentLease !== null && currentLease !== 'uncertain'
      ? await (deps.probeLeaseProcess ?? defaultProbeLeaseProcess)(currentLease).catch(() => 'uncertain' as const)
      : 'uncertain' as const;
    const staleLease = currentLease !== null
      && currentLease !== 'uncertain'
      && currentLease.domainKey === domain.domainKey
      && currentLease.baseStateDir === domain.baseStateDir
      && currentLease.rootSource === domain.rootSource
      && nowMs - (parseIsoMs(currentLease.heartbeatAt) ?? nowMs) >= minIntervalMs * 2
      && (leaseProbe === 'dead' || leaseProbe === 'reused');
    // Malformed metadata, no immutable process identity, unrelated domains, and
    // probe uncertainty are all ownership uncertainty. Never replace them.
    if (currentLease === 'uncertain' || (currentLease !== null && !ownsLease && !staleLease)) return;
    const token = ownsLease ? currentLease.token : randomUUID();
    const generation = ownsLease ? currentLease.generation : randomUUID();
    if (!(await writeAuthorityLease(domain.authorityLeasePath, {
      version: 2,
      domainKey: domain.domainKey,
      baseStateDir: domain.baseStateDir,
      rootSource: domain.rootSource,
      pid: process.pid,
      platform: process.platform,
      processStartIdentity,
      claimant,
      token,
      generation,
      heartbeatAt: new Date(nowMs).toISOString(),
    }))) {
      return;
    }
    let previousState: HudAuthorityState | null;
    try {
      previousState = await readAuthorityState(domain.authorityStatePath);
    } catch (error) {
      const failedState = buildAuthorityState(cwd, nowMs, minIntervalMs, jitterMs, {
        last_skip_at: new Date(nowMs).toISOString(),
        next_allowed_at: new Date(nowMs + minIntervalMs + jitterMs).toISOString(),
        last_status: 'failed',
        last_reason: 'invalid_authority_state',
        last_error: error instanceof Error ? error.message : String(error),
      });
      if (!(await writeAuthorityState(domain.authorityStatePath, failedState))) {
        throw new Error('failed to persist HUD authority invalid-state diagnostic');
      }
      return;
    }

    const nextAllowedMs = parseIsoMs(previousState?.next_allowed_at);
    if (previousState && nextAllowedMs !== null && nowMs < nextAllowedMs) {
      const skippedState = buildAuthorityState(cwd, nowMs, minIntervalMs, previousState.jitter_ms, {
        last_spawn_at: previousState.last_spawn_at,
        last_skip_at: new Date(nowMs).toISOString(),
        next_allowed_at: previousState.next_allowed_at,
        skip_count: previousState.skip_count + 1,
        last_status: 'skipped',
        last_reason: 'rate_limited',
        last_error: previousState.last_error,
      });
      await writeAuthorityStateUnlessNewerCooldown(domain.authorityStatePath, skippedState);
      return;
    }

    const nextAllowedAt = new Date(nowMs + minIntervalMs + jitterMs).toISOString();
    const spawnedState = buildAuthorityState(cwd, nowMs, minIntervalMs, jitterMs, {
      last_spawn_at: new Date(nowMs).toISOString(),
      next_allowed_at: nextAllowedAt,
      skip_count: previousState?.skip_count ?? 0,
      last_status: 'spawned',
      last_reason: 'spawned',
    });
    if (!(await writeAuthorityState(domain.authorityStatePath, spawnedState))) {
      throw new Error('failed to persist HUD authority rate-limit state');
    }

    const watcherScript = resolveHudWatcherScript(packageRoot, 'notify-fallback-watcher.js', cwd, mergedEnv);
    const notifyScript = resolveHudWatcherScript(packageRoot, 'notify-hook.js', cwd, mergedEnv);
    try {
      await runProcess(nodePath, [
        watcherScript, '--once', '--authority-only', '--cwd', cwd,
        '--notify-script', notifyScript, '--poll-ms', String(pollMs),
      ], {
        cwd,
        env: {
          ...mergedEnv,
          OMX_HUD_AUTHORITY: '1',
          OMX_HUD_AUTHORITY_DOMAIN_KEY: domain.domainKey,
          OMX_HUD_AUTHORITY_STATE_PATH: domain.authorityStatePath,
          OMX_HUD_AUTHORITY_MIN_INTERVAL_MS: String(minIntervalMs),
          OMX_HUD_AUTHORITY_JITTER_MS: String(jitterMaxMs),
          OMX_HUD_AUTHORITY_LEASE_PATH: domain.authorityLeasePath,
          OMX_HUD_AUTHORITY_BASE_STATE_DIR: domain.baseStateDir,
          OMX_HUD_AUTHORITY_ROOT_SOURCE: domain.rootSource,
          OMX_HUD_AUTHORITY_LEASE_TOKEN: token,
          OMX_HUD_AUTHORITY_LEASE_GENERATION: generation,
          OMX_HUD_AUTHORITY_OWNER_PID: String(process.pid),
          OMX_HUD_AUTHORITY_OWNER_PLATFORM: process.platform,
          OMX_HUD_AUTHORITY_OWNER_START_IDENTITY: processStartIdentity,
        },
        timeoutMs,
      });
    } catch (error) {
      const failedAt = deps.nowMs?.() ?? Date.now();
      await writeAuthorityState(domain.authorityStatePath, buildAuthorityState(cwd, failedAt, minIntervalMs, jitterMs, {
        last_spawn_at: spawnedState.last_spawn_at,
        next_allowed_at: nextAllowedAt,
        skip_count: spawnedState.skip_count,
        last_status: 'failed',
        last_reason: 'child_failed',
        last_error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  } finally {
    await releaseHudLifecycleLock(acquired.lock);
  }
}
