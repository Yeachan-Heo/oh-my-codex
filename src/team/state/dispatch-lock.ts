import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { assertTeamLockNotStale } from './locks.js';

const OMX_DISPATCH_LOCK_TIMEOUT_ENV = 'OMX_DISPATCH_LOCK_TIMEOUT_MS';
const DEFAULT_DISPATCH_LOCK_TIMEOUT_MS = 15_000;
const MIN_DISPATCH_LOCK_TIMEOUT_MS = 1_000;
const MAX_DISPATCH_LOCK_TIMEOUT_MS = 120_000;
const DISPATCH_LOCK_INITIAL_POLL_MS = 25;
const DISPATCH_LOCK_MAX_POLL_MS = 500;
const LOCK_STALE_MS = 5 * 60 * 1000;

export function resolveDispatchLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OMX_DISPATCH_LOCK_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_DISPATCH_LOCK_TIMEOUT_MS;
  return Math.max(MIN_DISPATCH_LOCK_TIMEOUT_MS, Math.min(MAX_DISPATCH_LOCK_TIMEOUT_MS, Math.floor(parsed)));
}

export async function withDispatchLock<T>(
  teamName: string,
  cwd: string,
  teamDir: (teamName: string, cwd: string) => string,
  dispatchLockDir: (teamName: string, cwd: string) => string,
  fn: () => Promise<T>,
): Promise<T> {
  const root = teamDir(teamName, cwd);
  if (!existsSync(root)) throw new Error(`Team ${teamName} not found`);

  const lockDir = dispatchLockDir(teamName, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const timeoutMs = resolveDispatchLockTimeoutMs(process.env);
  const deadline = Date.now() + timeoutMs;
  let pollMs = DISPATCH_LOCK_INITIAL_POLL_MS;

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

      await assertTeamLockNotStale(lockDir, LOCK_STALE_MS);

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out acquiring dispatch lock for ${teamName} after ${timeoutMs}ms. ` +
          `Set ${OMX_DISPATCH_LOCK_TIMEOUT_ENV} to increase (current: ${timeoutMs}ms, max: ${MAX_DISPATCH_LOCK_TIMEOUT_MS}ms).`
        );
      }

      const jitter = 0.5 + Math.random() * 0.5;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(pollMs * jitter)));
      pollMs = Math.min(pollMs * 2, DISPATCH_LOCK_MAX_POLL_MS);
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
      // best effort
    }
  }
}
