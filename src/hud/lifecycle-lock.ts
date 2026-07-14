import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OWNER_FILE = 'owner.json';
const LOCK_VERSION = 1;

export interface HudLifecycleLockOwner {
  version: 1;
  token: string;
  generation: string;
  domainKey: string;
  pid: number;
  platform: NodeJS.Platform;
  processStartIdentity: string;
  acquiredAt: string;
}

export interface HudLifecycleLock {
  path: string;
  token: string;
  generation: string;
  domainKey: string;
}

export type HudLifecycleLockStatus = 'acquired' | 'locked' | 'locked_uncertain' | 'failed';

export interface HudLifecycleLockResult {
  status: HudLifecycleLockStatus;
  lock?: HudLifecycleLock;
}

export interface HudLifecycleLockOptions {
  path: string;
  domainKey: string;
  staleMs: number;
}

export interface HudLifecycleLockDeps {
  nowMs?: () => number;
  token?: () => string;
  generation?: () => string;
  afterQuarantine?: (quarantinePath: string) => Promise<void> | void;
  processStartIdentity?: (pid: number) => Promise<string | undefined>;
  probeProcess?: (owner: HudLifecycleLockOwner) => Promise<'live' | 'dead' | 'reused' | 'uncertain'>;
}

type OwnerRead = { kind: 'missing' } | { kind: 'uncertain' } | { kind: 'owner'; owner: HudLifecycleLockOwner };

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isOwner(value: unknown): value is HudLifecycleLockOwner {
  if (typeof value !== 'object' || value === null) return false;
  const owner = value as Partial<HudLifecycleLockOwner>;
  return owner.version === LOCK_VERSION
    && typeof owner.token === 'string' && owner.token.length > 0
    && typeof owner.generation === 'string' && owner.generation.length > 0
    && typeof owner.domainKey === 'string' && owner.domainKey.length > 0
    && typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.platform === 'string' && owner.platform.length > 0
    && typeof owner.processStartIdentity === 'string' && owner.processStartIdentity.trim().length > 0
    && typeof owner.acquiredAt === 'string' && Number.isFinite(Date.parse(owner.acquiredAt));
}

async function readOwner(lockPath: string): Promise<OwnerRead> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(lockPath, OWNER_FILE), 'utf8'));
    return isOwner(parsed) ? { kind: 'owner', owner: parsed } : { kind: 'uncertain' };
  } catch (error) {
    return isNotFound(error) ? { kind: 'missing' } : { kind: 'uncertain' };
  }
}

async function lockStat(lockPath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    return await stat(lockPath);
  } catch {
    return undefined;
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

async function defaultProbeProcess(owner: HudLifecycleLockOwner): Promise<'live' | 'dead' | 'reused' | 'uncertain'> {
  if (owner.platform !== process.platform) return 'uncertain';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    return code === 'ESRCH' ? 'dead' : 'uncertain';
  }
  const currentIdentity = await defaultProcessStartIdentity(owner.pid);
  if (currentIdentity && currentIdentity !== owner.processStartIdentity) return 'reused';
  return currentIdentity ? 'live' : 'uncertain';
}

function ownerMatches(left: HudLifecycleLockOwner, right: HudLifecycleLockOwner): boolean {
  return left.token === right.token
    && left.generation === right.generation
    && left.domainKey === right.domainKey
    && left.pid === right.pid
    && left.platform === right.platform
    && left.processStartIdentity === right.processStartIdentity
    && left.acquiredAt === right.acquiredAt;
}

function isProvenStale(owner: HudLifecycleLockOwner, nowMs: number, staleMs: number, probe: 'live' | 'dead' | 'reused' | 'uncertain'): boolean {
  const acquiredAt = Date.parse(owner.acquiredAt);
  return Number.isFinite(acquiredAt)
    && acquiredAt <= nowMs
    && nowMs - acquiredAt >= staleMs
    && (probe === 'dead' || probe === 'reused');
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return isNotFound(error);
  }
}

async function restoreQuarantine(quarantinePath: string, lockPath: string, owner: HudLifecycleLockOwner): Promise<void> {
  if (!(await pathIsAbsent(lockPath))) return;
  const current = await readOwner(quarantinePath);
  if (current.kind !== 'owner' || !ownerMatches(current.owner, owner)) return;
  await rename(quarantinePath, lockPath).catch(() => {});
}

async function publishFreshLock(options: HudLifecycleLockOptions, deps: HudLifecycleLockDeps, nowMs: number): Promise<HudLifecycleLockResult> {
  const processStartIdentity = await (deps.processStartIdentity ?? defaultProcessStartIdentity)(process.pid).catch(() => undefined);
  if (typeof processStartIdentity !== 'string' || processStartIdentity.trim().length === 0) {
    return { status: 'failed' };
  }
  const token = deps.token?.() ?? randomUUID();
  const generation = deps.generation?.() ?? randomUUID();
  const owner: HudLifecycleLockOwner = {
    version: LOCK_VERSION,
    token,
    generation,
    domainKey: options.domainKey,
    pid: process.pid,
    platform: process.platform,
    processStartIdentity,
    acquiredAt: new Date(nowMs).toISOString(),
  };
  let created = false;
  try {
    await mkdir(options.path);
    created = true;
    await writeFile(join(options.path, OWNER_FILE), JSON.stringify(owner));
    const observed = await readOwner(options.path);
    if (observed.kind === 'owner' && ownerMatches(observed.owner, owner)) {
      return { status: 'acquired', lock: { path: options.path, token, generation, domainKey: options.domainKey } };
    }
  } catch (error) {
    if (!created && typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return { status: 'locked' };
    }
  }
  if (created) {
    const observed = await readOwner(options.path);
    if (observed.kind === 'owner' && ownerMatches(observed.owner, owner)) {
      await rm(options.path, { recursive: true, force: false }).catch(() => {});
    }
  }
  return { status: 'failed' };
}

export async function acquireHudLifecycleLock(
  options: HudLifecycleLockOptions,
  deps: HudLifecycleLockDeps = {},
): Promise<HudLifecycleLockResult> {
  const nowMs = deps.nowMs?.() ?? Date.now();
  const fresh = await publishFreshLock(options, deps, nowMs);
  if (fresh.status === 'acquired' || fresh.status === 'failed') return fresh;

  const observed = await readOwner(options.path);
  const observedStat = await lockStat(options.path);
  if (observed.kind !== 'owner' || !observedStat || observed.owner.domainKey !== options.domainKey) {
    return { status: 'locked_uncertain' };
  }
  const probe = await (deps.probeProcess ?? defaultProbeProcess)(observed.owner).catch(() => 'uncertain' as const);
  if (!isProvenStale(observed.owner, nowMs, options.staleMs, probe)) {
    return { status: probe === 'live' ? 'locked' : 'locked_uncertain' };
  }

  const quarantinePath = `${options.path}.quarantine.${process.pid}.${nowMs}.${randomUUID()}`;
  try {
    await rename(options.path, quarantinePath);
  } catch {
    return { status: 'locked_uncertain' };
  }
  await deps.afterQuarantine?.(quarantinePath);
  const quarantinedOwner = await readOwner(quarantinePath);
  const quarantinedStat = await lockStat(quarantinePath);
  const quarantinedProbe = quarantinedOwner.kind === 'owner'
    ? await (deps.probeProcess ?? defaultProbeProcess)(quarantinedOwner.owner).catch(() => 'uncertain' as const)
    : 'uncertain';
  if (!(await pathIsAbsent(options.path))
    || quarantinedOwner.kind !== 'owner'
    || !quarantinedStat
    || quarantinedStat.mtimeMs !== observedStat.mtimeMs
    || !ownerMatches(observed.owner, quarantinedOwner.owner)
    || !isProvenStale(quarantinedOwner.owner, nowMs, options.staleMs, quarantinedProbe)) {
    await restoreQuarantine(quarantinePath, options.path, observed.owner);
    return { status: 'locked_uncertain' };
  }
  try {
    await rm(quarantinePath, { recursive: true, force: false });
  } catch {
    return { status: 'locked_uncertain' };
  }
  return publishFreshLock(options, deps, nowMs);
}

export async function releaseHudLifecycleLock(lock: HudLifecycleLock): Promise<void> {
  const observed = await readOwner(lock.path);
  if (observed.kind !== 'owner'
    || observed.owner.token !== lock.token
    || observed.owner.generation !== lock.generation
    || observed.owner.domainKey !== lock.domainKey) return;
  const releasePath = `${lock.path}.release.${process.pid}.${randomUUID()}`;
  try {
    await rename(lock.path, releasePath);
  } catch {
    return;
  }
  const released = await readOwner(releasePath);
  if (released.kind === 'owner'
    && released.owner.token === lock.token
    && released.owner.generation === lock.generation
    && released.owner.domainKey === lock.domainKey) {
    await rm(releasePath, { recursive: true, force: false }).catch(() => {});
    return;
  }
  if (await pathIsAbsent(lock.path)) await rename(releasePath, lock.path).catch(() => {});
}
