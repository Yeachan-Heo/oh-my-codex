import { existsSync } from 'fs';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

interface TeamPathDeps {
  teamDir: (teamName: string, cwd: string) => string;
  taskClaimLockDir: (teamName: string, taskId: string, cwd: string) => string;
  mailboxLockDir: (teamName: string, workerName: string, cwd: string) => string;
}

const LOCK_OWNER_RETRY_MS = 25;
const LOCK_LEASE_FILE = 'lease';

async function isStaleLock(lockDir: string, lockStaleMs: number): Promise<boolean> {
  const leasePath = join(lockDir, LOCK_LEASE_FILE);
  try {
    const leaseInfo = await stat(leasePath);
    return Date.now() - leaseInfo.mtimeMs > lockStaleMs;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') return false;
  }

  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > lockStaleMs;
  } catch {
    return false;
  }
}

function startLockLeaseHeartbeat(lockDir: string, ownerPath: string, ownerToken: string, lockStaleMs: number): () => void {
  const leasePath = join(lockDir, LOCK_LEASE_FILE);
  const heartbeatMs = Math.max(1, Math.floor(lockStaleMs / 3));
  let refreshing = false;
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const owner = await readFile(ownerPath, 'utf8');
      if (owner.trim() !== ownerToken) return;
      const now = new Date();
      await utimes(leasePath, now, now);
    } catch {
      // A missing or replaced lock must never be recreated by a stale owner.
    } finally {
      refreshing = false;
    }
  };
  const timer = setInterval(() => { void refresh(); }, heartbeatMs);
  timer.unref();
  return () => clearInterval(timer);
}

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function maybeRecoverStaleLock(lockDir: string, lockStaleMs: number): Promise<boolean> {
  if (!await isStaleLock(lockDir, lockStaleMs)) return false;
  await rm(lockDir, { recursive: true, force: true });
  return true;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withScalingLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const stateRoot = dirname(dirname(deps.teamDir(teamName, cwd)));
  const lockDir = join(stateRoot, '.team-locks', `${teamName}.scaling`);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 10_000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
        await writeFile(join(lockDir, LOCK_LEASE_FILE), ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring scaling lock for team ${teamName}`);
      }
      await sleep(50);
    }
  }

  const stopHeartbeat = startLockLeaseHeartbeat(lockDir, ownerPath, ownerToken, lockStaleMs);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withTeamLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const stateRoot = dirname(dirname(deps.teamDir(teamName, cwd)));
  const lockDir = join(stateRoot, '.team-locks', `${teamName}.membership`);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
        await writeFile(join(lockDir, LOCK_LEASE_FILE), ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring team task lock for ${teamName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  const stopHeartbeat = startLockLeaseHeartbeat(lockDir, ownerPath, ownerToken, lockStaleMs);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withTaskClaimLock<T>(
  teamName: string,
  taskId: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lockDir = deps.taskClaimLockDir(teamName, taskId, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) return { ok: false };
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    try {
      await writeFile(ownerPath, ownerToken, 'utf8');
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    return { ok: true, value: await fn() };
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withMailboxLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const root = deps.teamDir(teamName, cwd);
  if (!existsSync(root)) {
    throw new Error(`Team ${teamName} not found`);
  }
  const lockDir = deps.mailboxLockDir(teamName, workerName, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring mailbox lock for ${teamName}/${workerName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}
