import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
  constants,
} from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { sleepSync } from "../utils/sleep.js";
import type {
  TrackedJob,
  TrackedJobRegistry,
  TrackedJobSource,
  TrackedJobStatus,
} from "./types.js";

const REGISTRY_VERSION = 1;
const REGISTRY_PATH = join(homedir(), ".omx", "state", "tracked-jobs.json");
const REGISTRY_LOCK_PATH = join(homedir(), ".omx", "state", "tracked-jobs.lock");
const SECURE_FILE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_WAIT_TIMEOUT_MS = 4_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 10_000;
const VALID_STATUSES = new Set<TrackedJobStatus>([
  "running",
  "finished",
  "stopped",
  "failed",
]);

interface RegistryLockHandle {
  fd: number;
  token: string;
}

interface LockFileSnapshot {
  raw: string;
  pid: number | null;
  token: string | null;
}

function createEmptyRegistry(): TrackedJobRegistry {
  return {
    version: REGISTRY_VERSION,
    jobs: {},
  };
}

function ensureRegistryDir(): void {
  const registryDir = dirname(REGISTRY_PATH);
  if (!existsSync(registryDir)) {
    mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  }
}

function sleepMs(ms: number): void {
  sleepSync(ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

function readLockSnapshot(): LockFileSnapshot | null {
  try {
    const raw = readFileSync(REGISTRY_LOCK_PATH, "utf-8");
    const trimmed = raw.trim();

    if (!trimmed) {
      return { raw, pid: null, token: null };
    }

    try {
      const parsed = JSON.parse(trimmed) as { pid?: unknown; token?: unknown };
      const pid = typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null;
      const token =
        typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
      return { raw, pid, token };
    } catch {
      const [pidStr] = trimmed.split(":");
      const parsedPid = Number.parseInt(pidStr ?? "", 10);
      return {
        raw,
        pid: Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : null,
        token: null,
      };
    }
  } catch {
    return null;
  }
}

function removeLockIfUnchanged(snapshot: LockFileSnapshot): boolean {
  try {
    const currentRaw = readFileSync(REGISTRY_LOCK_PATH, "utf-8");
    if (currentRaw !== snapshot.raw) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    unlinkSync(REGISTRY_LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

function acquireRegistryLock(): RegistryLockHandle | null {
  ensureRegistryDir();
  const started = Date.now();

  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const token = randomUUID();
      const fd = openSync(
        REGISTRY_LOCK_PATH,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        SECURE_FILE_MODE,
      );
      const lockPayload = JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
        token,
      });
      writeSync(fd, lockPayload, null, "utf-8");
      return { fd, token };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }

      try {
        const lockAgeMs = Date.now() - statSync(REGISTRY_LOCK_PATH).mtimeMs;
        if (lockAgeMs > LOCK_STALE_MS) {
          const snapshot = readLockSnapshot();
          if (!snapshot) {
            sleepMs(LOCK_RETRY_MS);
            continue;
          }

          if (snapshot.pid !== null && isPidAlive(snapshot.pid)) {
            sleepMs(LOCK_RETRY_MS);
            continue;
          }

          if (removeLockIfUnchanged(snapshot)) {
            continue;
          }
        }
      } catch {
        // Lock may disappear between stat/unlink attempts.
      }

      sleepMs(LOCK_RETRY_MS);
    }
  }

  return null;
}

function acquireRegistryLockOrWait(maxWaitMs: number = LOCK_WAIT_TIMEOUT_MS): RegistryLockHandle | null {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const lock = acquireRegistryLock();
    if (lock !== null) {
      return lock;
    }
    if (Date.now() - started < maxWaitMs) {
      sleepMs(LOCK_RETRY_MS);
    }
  }
  return null;
}

function releaseRegistryLock(lock: RegistryLockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // Ignore close errors.
  }

  const snapshot = readLockSnapshot();
  if (!snapshot || snapshot.token !== lock.token) {
    return;
  }

  removeLockIfUnchanged(snapshot);
}

function withRegistryLockOrWait<T>(onLocked: () => T, onLockUnavailable: () => T): T {
  const lock = acquireRegistryLockOrWait();
  if (lock === null) {
    return onLockUnavailable();
  }
  try {
    return onLocked();
  } finally {
    releaseRegistryLock(lock);
  }
}

function normalizeTrackedJob(jobName: string, raw: unknown): TrackedJob | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const normalizedName =
    typeof record.jobName === "string" && record.jobName.trim() !== ""
      ? record.jobName.trim()
      : jobName;
  const status = record.status;
  const startedAt = typeof record.startedAt === "string" ? record.startedAt : null;

  if (!normalizedName || !startedAt || !VALID_STATUSES.has(status as TrackedJobStatus)) {
    return null;
  }

  const outputs = Array.isArray(record.artifacts && (record.artifacts as Record<string, unknown>).outputs)
    ? ((record.artifacts as Record<string, unknown>).outputs as unknown[])
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    : undefined;

  return {
    jobName: normalizedName,
    status: status as TrackedJobStatus,
    startedAt,
    finishedAt:
      typeof record.finishedAt === "string" || record.finishedAt === null
        ? (record.finishedAt as string | null | undefined)
        : undefined,
    pid: typeof record.pid === "number" && Number.isFinite(record.pid) ? Math.trunc(record.pid) : undefined,
    source:
      record.source && typeof record.source === "object" && !Array.isArray(record.source)
        ? {
            platform:
              typeof (record.source as Record<string, unknown>).platform === "string"
                ? ((record.source as Record<string, unknown>).platform as TrackedJobSource["platform"])
                : undefined,
            messageId:
              typeof (record.source as Record<string, unknown>).messageId === "string"
                ? ((record.source as Record<string, unknown>).messageId as string)
                : undefined,
            sessionId:
              typeof (record.source as Record<string, unknown>).sessionId === "string"
                ? ((record.source as Record<string, unknown>).sessionId as string)
                : undefined,
          }
        : undefined,
    artifacts:
      record.artifacts && typeof record.artifacts === "object" && !Array.isArray(record.artifacts)
        ? {
            promptPath:
              typeof (record.artifacts as Record<string, unknown>).promptPath === "string"
                ? ((record.artifacts as Record<string, unknown>).promptPath as string)
                : undefined,
            logPath:
              typeof (record.artifacts as Record<string, unknown>).logPath === "string"
                ? ((record.artifacts as Record<string, unknown>).logPath as string)
                : undefined,
            outputs,
          }
        : undefined,
    discord:
      record.discord && typeof record.discord === "object" && !Array.isArray(record.discord)
        ? {
            channelId:
              typeof (record.discord as Record<string, unknown>).channelId === "string"
                ? ((record.discord as Record<string, unknown>).channelId as string)
                : undefined,
            threadId:
              typeof (record.discord as Record<string, unknown>).threadId === "string"
                ? ((record.discord as Record<string, unknown>).threadId as string)
                : undefined,
          }
        : undefined,
    completion:
      record.completion && typeof record.completion === "object" && !Array.isArray(record.completion)
        ? {
            announced:
              typeof (record.completion as Record<string, unknown>).announced === "boolean"
                ? ((record.completion as Record<string, unknown>).announced as boolean)
                : undefined,
            messageId:
              typeof (record.completion as Record<string, unknown>).messageId === "string" ||
              (record.completion as Record<string, unknown>).messageId === null
                ? ((record.completion as Record<string, unknown>).messageId as string | null)
                : undefined,
          }
        : undefined,
  };
}

function normalizeRegistry(raw: unknown): TrackedJobRegistry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createEmptyRegistry();
  }

  const record = raw as Record<string, unknown>;
  const rawJobs = record.jobs;
  const jobs: Record<string, TrackedJob> = {};

  if (rawJobs && typeof rawJobs === "object" && !Array.isArray(rawJobs)) {
    for (const [jobName, value] of Object.entries(rawJobs as Record<string, unknown>)) {
      const normalized = normalizeTrackedJob(jobName, value);
      if (normalized) {
        jobs[normalized.jobName] = normalized;
      }
    }
  }

  return {
    version:
      typeof record.version === "number" && Number.isFinite(record.version)
        ? Math.trunc(record.version)
        : REGISTRY_VERSION,
    jobs,
  };
}

function readRegistryUnsafe(): TrackedJobRegistry {
  if (!existsSync(REGISTRY_PATH)) {
    return createEmptyRegistry();
  }

  try {
    const content = readFileSync(REGISTRY_PATH, "utf-8");
    if (!content.trim()) {
      return createEmptyRegistry();
    }
    return normalizeRegistry(JSON.parse(content));
  } catch {
    return createEmptyRegistry();
  }
}

function rewriteRegistryUnsafe(registry: TrackedJobRegistry): void {
  ensureRegistryDir();
  const tempPath = `${REGISTRY_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, JSON.stringify(registry, null, 2) + "\n", {
    mode: SECURE_FILE_MODE,
  });
  renameSync(tempPath, REGISTRY_PATH);
}

function normalizeForWrite(job: TrackedJob): TrackedJob | null {
  return normalizeTrackedJob(job.jobName, job);
}

function compareStartedAtDesc(left: TrackedJob, right: TrackedJob): number {
  const leftTs = Date.parse(left.startedAt);
  const rightTs = Date.parse(right.startedAt);
  const safeLeft = Number.isFinite(leftTs) ? leftTs : 0;
  const safeRight = Number.isFinite(rightTs) ? rightTs : 0;
  return safeRight - safeLeft;
}

export function getTrackedJobRegistryPath(): string {
  return REGISTRY_PATH;
}

export function loadTrackedJobRegistry(): TrackedJobRegistry {
  return readRegistryUnsafe();
}

export function listTrackedJobs(): TrackedJob[] {
  return Object.values(loadTrackedJobRegistry().jobs).sort(compareStartedAtDesc);
}

export function lookupTrackedJob(jobName: string): TrackedJob | null {
  return loadTrackedJobRegistry().jobs[jobName] ?? null;
}

export function upsertTrackedJob(job: TrackedJob): boolean {
  const normalized = normalizeForWrite(job);
  if (!normalized) {
    return false;
  }

  return withRegistryLockOrWait(
    () => {
      const registry = readRegistryUnsafe();
      registry.jobs[normalized.jobName] = normalized;
      rewriteRegistryUnsafe(registry);
      return true;
    },
    () => false,
  );
}

export function removeTrackedJob(jobName: string): boolean {
  return withRegistryLockOrWait(
    () => {
      const registry = readRegistryUnsafe();
      if (!(jobName in registry.jobs)) {
        return false;
      }
      delete registry.jobs[jobName];
      rewriteRegistryUnsafe(registry);
      return true;
    },
    () => false,
  );
}
