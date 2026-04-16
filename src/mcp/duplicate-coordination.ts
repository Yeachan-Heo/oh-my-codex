import { watch as fsWatch } from 'node:fs';
import { mkdir, open, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerName } from './bootstrap.js';

const DUPLICATE_REGISTRY_VERSION = 'v1';
const DUPLICATE_REGISTRY_ROOT = ['oh-my-codex', 'mcp-duplicate', DUPLICATE_REGISTRY_VERSION] as const;
const DEFAULT_PRE_TRAFFIC_GRACE_MS = 2_000;
const PRESENCE_FILE_PATTERN = /^presence-(\d+)\.json$/;
const OWNER_FILE_NAME = 'owner.json';

interface PresenceRecord {
  pid: number;
  parentPid: number;
  serverName: McpServerName;
  createdAtMs: number;
}

interface OwnerRecord {
  pid: number;
  parentPid: number;
  serverName: McpServerName;
  claimedAtMs: number;
}

interface DuplicateRegistryScope {
  parentPid: number;
  serverName: McpServerName;
}

interface RegistrySnapshot {
  liveOwnerPid: number | null;
  hasLiveNewerSibling: boolean;
}

interface DirectoryWatcher {
  close(): void;
}

export interface DuplicateCoordinator {
  markFirstTraffic(): Promise<void>;
  dispose(): Promise<void>;
}

export interface DuplicateCoordinatorOptions {
  parentPid: number;
  selfPid: number;
  serverName: McpServerName;
  lifecycleDebugEnabled: boolean;
  shutdown: (reason: string) => void | Promise<void>;
  preTrafficGraceMs?: number;
}

export interface DuplicateCoordinatorDeps {
  now?: () => number;
  signalProcess?: typeof process.kill;
  tmpDir?: string;
  watchDirectory?: (
    directory: string,
    onChange: () => void,
    onError: (error: unknown) => void,
  ) => DirectoryWatcher;
}

export interface ResolveDuplicateRegistryDirOptions {
  parentPid: number;
  serverName: McpServerName;
  tmpDir?: string;
}

/**
 * Keep hot-path duplicate coordination out of .omx/state. This registry is ephemeral,
 * runtime-only coordination data, so it lives in an OS-local tmpdir scope instead.
 */
export function resolveDuplicateRegistryDir(options: ResolveDuplicateRegistryDirOptions): string {
  return join(
    options.tmpDir ?? tmpdir(),
    ...DUPLICATE_REGISTRY_ROOT,
    resolveUserScope(),
    String(options.parentPid),
    options.serverName,
  );
}

export async function createDuplicateCoordinator(
  options: DuplicateCoordinatorOptions,
  deps: DuplicateCoordinatorDeps = {},
): Promise<DuplicateCoordinator> {
  const now = deps.now ?? Date.now;
  const signalProcess = deps.signalProcess ?? process.kill;
  const watchDirectory = deps.watchDirectory ?? defaultWatchDirectory;
  const registryDir = resolveDuplicateRegistryDir({
    parentPid: options.parentPid,
    serverName: options.serverName,
    tmpDir: deps.tmpDir,
  });
  const selfPresencePath = getPresencePath(registryDir, options.selfPid);
  const ownerPath = join(registryDir, OWNER_FILE_NAME);
  const preTrafficGraceMs = options.preTrafficGraceMs ?? DEFAULT_PRE_TRAFFIC_GRACE_MS;

  let disposed = false;
  let firstTrafficSeen = false;
  let duplicateDetectionEnabled = true;
  let duplicateObservedAtMs: number | null = null;
  let preTrafficTimer: NodeJS.Timeout | null = null;
  let watcher: DirectoryWatcher | null = null;
  let reconcileQueue = Promise.resolve();

  const logLifecycle = (message: string, error?: unknown) => {
    if (!options.lifecycleDebugEnabled) return;
    const detail = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
    process.stderr.write(`[omx-${options.serverName}-server] ${message}${detail}\n`);
  };

  const clearGraceTimer = () => {
    if (preTrafficTimer) {
      clearTimeout(preTrafficTimer);
      preTrafficTimer = null;
    }
  };

  const clearDuplicateObservation = () => {
    duplicateObservedAtMs = null;
    clearGraceTimer();
  };

  const disablePreTrafficDuplicateDetection = (message: string, error?: unknown) => {
    if (!duplicateDetectionEnabled) return;
    duplicateDetectionEnabled = false;
    clearDuplicateObservation();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    logLifecycle(message, error);
  };

  const scheduleGraceReconcile = (delayMs: number) => {
    clearGraceTimer();
    preTrafficTimer = setTimeout(() => {
      preTrafficTimer = null;
      requestReconcile();
    }, Math.max(0, delayMs));
    preTrafficTimer.unref();
  };

  const reconcilePreTraffic = async () => {
    if (disposed || firstTrafficSeen || !duplicateDetectionEnabled) {
      clearDuplicateObservation();
      return;
    }

    try {
      const snapshot = await scanRegistryState(
        registryDir,
        {
          parentPid: options.parentPid,
          serverName: options.serverName,
        },
        options.selfPid,
        signalProcess,
      );

      if (disposed || firstTrafficSeen || !duplicateDetectionEnabled) {
        clearDuplicateObservation();
        return;
      }

      const hasLiveForeignOwner = snapshot.liveOwnerPid !== null && snapshot.liveOwnerPid !== options.selfPid;
      const duplicateCondition = hasLiveForeignOwner || snapshot.hasLiveNewerSibling;
      if (!duplicateCondition) {
        clearDuplicateObservation();
        return;
      }

      const observedAtMs = duplicateObservedAtMs ?? now();
      duplicateObservedAtMs = observedAtMs;
      const elapsedMs = now() - observedAtMs;
      if (elapsedMs >= preTrafficGraceMs) {
        clearGraceTimer();
        if (!disposed && !firstTrafficSeen) {
          void Promise.resolve(options.shutdown('superseded_duplicate_before_traffic'));
        }
        return;
      }

      scheduleGraceReconcile(preTrafficGraceMs - elapsedMs);
    } catch (error) {
      // Registry read failures are ambiguous; stay alive rather than risk a wrong self-exit.
      clearDuplicateObservation();
      logLifecycle('duplicate coordination reconcile skipped; staying alive', error);
    }
  };

  const requestReconcile = () => {
    reconcileQueue = reconcileQueue
      .catch(() => undefined)
      .then(reconcilePreTraffic);
  };

  try {
    await mkdir(registryDir, { recursive: true });
    await gcRegistryDir(
      registryDir,
      {
        parentPid: options.parentPid,
        serverName: options.serverName,
      },
      signalProcess,
    );
    await writeFile(selfPresencePath, JSON.stringify({
      pid: options.selfPid,
      parentPid: options.parentPid,
      serverName: options.serverName,
      createdAtMs: now(),
    } satisfies PresenceRecord), 'utf8');
  } catch (error) {
    logLifecycle('duplicate coordination unavailable; staying alive', error);
    return {
      async markFirstTraffic() {},
      async dispose() {},
    } satisfies DuplicateCoordinator;
  }

  try {
    watcher = watchDirectory(
      registryDir,
      () => {
        requestReconcile();
      },
      (error) => {
        // We intentionally do not fall back to polling here. Losing the hint is safer
        // than reintroducing steady-state file polling into the hot path.
        disablePreTrafficDuplicateDetection('duplicate coordination watch disabled; staying alive', error);
      },
    );
  } catch (error) {
    duplicateDetectionEnabled = false;
    logLifecycle('duplicate coordination watch unavailable; staying alive', error);
  }

  if (duplicateDetectionEnabled) {
    requestReconcile();
  }

  return {
    async markFirstTraffic() {
      if (disposed || firstTrafficSeen) return;
      firstTrafficSeen = true;
      clearGraceTimer();
      if (watcher) {
        watcher.close();
        watcher = null;
      }

      try {
        await claimOwner({
          ownerPath,
          parentPid: options.parentPid,
          selfPid: options.selfPid,
          serverName: options.serverName,
          now,
          signalProcess,
        });
      } catch (error) {
        logLifecycle('duplicate owner claim skipped', error);
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      clearGraceTimer();
      if (watcher) {
        watcher.close();
        watcher = null;
      }

      await unlinkIfExists(selfPresencePath);

      try {
        const ownerRecord = await readOwnerRecord(ownerPath, {
          parentPid: options.parentPid,
          serverName: options.serverName,
        });
        if (ownerRecord.status === 'valid' && ownerRecord.value.pid === options.selfPid) {
          await unlinkIfExists(ownerPath);
        }
      } catch {
        // Cleanup is best-effort during shutdown.
      }
    },
  } satisfies DuplicateCoordinator;
}

function defaultWatchDirectory(
  directory: string,
  onChange: () => void,
  onError: (error: unknown) => void,
): DirectoryWatcher {
  const watcher = fsWatch(directory, { persistent: false }, () => {
    onChange();
  });
  watcher.on('error', onError);
  return watcher;
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+$/, '');
  return sanitized || 'nouid';
}

function resolveUserScope(): string {
  if (typeof process.getuid === 'function') {
    return sanitizePathSegment(String(process.getuid()));
  }

  const username = process.env.USERNAME?.trim();
  if (username) return sanitizePathSegment(username);
  return 'nouid';
}

function getPresencePath(registryDir: string, pid: number): string {
  return join(registryDir, `presence-${pid}.json`);
}

function isAliveForCoordination(
  pid: number,
  signalProcess: typeof process.kill,
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPresenceRecord(value: unknown, scope: DuplicateRegistryScope, expectedPid: number): value is PresenceRecord {
  if (!isObjectRecord(value)) return false;
  return value.serverName === scope.serverName
    && value.parentPid === scope.parentPid
    && value.pid === expectedPid
    && isPositiveInteger(value.createdAtMs);
}

function isOwnerRecord(value: unknown, scope: DuplicateRegistryScope): value is OwnerRecord {
  if (!isObjectRecord(value)) return false;
  return value.serverName === scope.serverName
    && value.parentPid === scope.parentPid
    && isPositiveInteger(value.pid)
    && isPositiveInteger(value.claimedAtMs);
}

type RecordReadResult<T> =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; value: T };

async function readJsonRecord<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<RecordReadResult<T>> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!validate(parsed)) {
      return { status: 'malformed' };
    }
    return { status: 'valid', value: parsed };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return { status: 'missing' };
    if (error instanceof SyntaxError) return { status: 'malformed' };
    throw error;
  }
}

async function readOwnerRecord(
  ownerPath: string,
  scope: DuplicateRegistryScope,
): Promise<RecordReadResult<OwnerRecord>> {
  return readJsonRecord(ownerPath, (value): value is OwnerRecord => isOwnerRecord(value, scope));
}

async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function gcRegistryDir(
  registryDir: string,
  scope: DuplicateRegistryScope,
  signalProcess: typeof process.kill,
): Promise<void> {
  const entryNames = await readdir(registryDir);

  for (const entryName of entryNames) {
    const presenceMatch = entryName.match(PRESENCE_FILE_PATTERN);
    if (presenceMatch) {
      const expectedPid = Number.parseInt(presenceMatch[1], 10);
      const presencePath = join(registryDir, entryName);
      const presence = await readJsonRecord(
        presencePath,
        (value): value is PresenceRecord => isPresenceRecord(value, scope, expectedPid),
      );
      if (presence.status === 'missing') continue;
      if (presence.status === 'malformed' || !isAliveForCoordination(presence.value.pid, signalProcess)) {
        await unlinkIfExists(presencePath);
      }
      continue;
    }

    if (entryName === OWNER_FILE_NAME) {
      const ownerPath = join(registryDir, entryName);
      const owner = await readOwnerRecord(ownerPath, scope);
      if (owner.status === 'missing') continue;
      if (owner.status === 'malformed' || !isAliveForCoordination(owner.value.pid, signalProcess)) {
        await unlinkIfExists(ownerPath);
      }
    }
  }
}

async function scanRegistryState(
  registryDir: string,
  scope: DuplicateRegistryScope,
  selfPid: number,
  signalProcess: typeof process.kill,
): Promise<RegistrySnapshot> {
  const entryNames = await readdir(registryDir);
  let liveOwnerPid: number | null = null;
  let hasLiveNewerSibling = false;

  for (const entryName of entryNames) {
    const presenceMatch = entryName.match(PRESENCE_FILE_PATTERN);
    if (presenceMatch) {
      const expectedPid = Number.parseInt(presenceMatch[1], 10);
      const presencePath = join(registryDir, entryName);
      const presence = await readJsonRecord(
        presencePath,
        (value): value is PresenceRecord => isPresenceRecord(value, scope, expectedPid),
      );
      if (presence.status === 'missing') continue;
      if (presence.status === 'malformed') {
        await unlinkIfExists(presencePath);
        continue;
      }
      if (!isAliveForCoordination(presence.value.pid, signalProcess)) {
        await unlinkIfExists(presencePath);
        continue;
      }
      if (presence.value.pid > selfPid) {
        hasLiveNewerSibling = true;
      }
      continue;
    }

    if (entryName === OWNER_FILE_NAME) {
      const ownerPath = join(registryDir, entryName);
      const owner = await readOwnerRecord(ownerPath, scope);
      if (owner.status === 'missing') continue;
      if (owner.status === 'malformed') {
        await unlinkIfExists(ownerPath);
        continue;
      }
      if (!isAliveForCoordination(owner.value.pid, signalProcess)) {
        await unlinkIfExists(ownerPath);
        continue;
      }
      liveOwnerPid = owner.value.pid;
    }
  }

  return { liveOwnerPid, hasLiveNewerSibling };
}

interface ClaimOwnerOptions {
  ownerPath: string;
  parentPid: number;
  selfPid: number;
  serverName: McpServerName;
  now: () => number;
  signalProcess: typeof process.kill;
}

/**
 * Owner is only a pre-traffic hint. It is not authoritative transport truth, so we
 * claim it once on first traffic and never heartbeat or overwrite a live foreign owner.
 */
async function claimOwner(options: ClaimOwnerOptions): Promise<void> {
  const scope = {
    parentPid: options.parentPid,
    serverName: options.serverName,
  } satisfies DuplicateRegistryScope;
  const ownerRecord = await readOwnerRecord(options.ownerPath, scope);

  let shouldAttemptClaim = false;
  if (ownerRecord.status === 'missing') {
    shouldAttemptClaim = true;
  } else if (ownerRecord.status === 'malformed') {
    await unlinkIfExists(options.ownerPath);
    shouldAttemptClaim = true;
  } else if (ownerRecord.value.pid === options.selfPid) {
    return;
  } else if (!isAliveForCoordination(ownerRecord.value.pid, options.signalProcess)) {
    await unlinkIfExists(options.ownerPath);
    shouldAttemptClaim = true;
  } else {
    return;
  }

  if (!shouldAttemptClaim) return;

  const handle = await open(options.ownerPath, 'wx').catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null;
    throw error;
  });
  if (!handle) return;

  try {
    await handle.writeFile(JSON.stringify({
      pid: options.selfPid,
      parentPid: options.parentPid,
      serverName: options.serverName,
      claimedAtMs: options.now(),
    } satisfies OwnerRecord), 'utf8');
  } finally {
    await handle.close();
  }
}
