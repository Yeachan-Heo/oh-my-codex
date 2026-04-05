import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { captureTmuxPaneFromEnv } from '../../state/mode-state-context.js';
import { resolveCodexPane } from '../tmux-hook-engine.js';
import { safeString } from './utils.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RALPH_TERMINAL_PHASES = new Set(['complete', 'failed', 'cancelled']);
const RALPH_RESUME_LOCK_STALE_MS = 10_000;
const RALPH_RESUME_LOCK_TIMEOUT_MS = 5_000;
const RALPH_RESUME_LOCK_RETRY_MS = 25;

interface RalphSessionResumeHooks {
  afterLockAcquired?: () => Promise<void> | void;
  afterTargetWrite?: () => Promise<void> | void;
}

interface RalphSessionResumeParams {
  stateDir: string;
  payloadSessionId: string;
  payloadThreadId?: string;
  env?: NodeJS.ProcessEnv;
  hooks?: RalphSessionResumeHooks;
}

export interface RalphSessionResumeResult {
  currentOmxSessionId: string;
  resumed: boolean;
  updatedCurrentOwner: boolean;
  reason: string;
  sourcePath?: string;
  targetPath?: string;
}

interface RalphStateCandidate {
  sessionId: string;
  path: string;
  state: Record<string, unknown>;
}

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRecoverStaleLock(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs <= RALPH_RESUME_LOCK_STALE_MS) {
      return false;
    }
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function withRalphResumeLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockDir = join(stateDir, '.lock.ralph-session-resume');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + RALPH_RESUME_LOCK_TIMEOUT_MS;
  await mkdir(dirname(lockDir), { recursive: true }).catch(() => {});

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir)) continue;
      if (Date.now() > deadline) return null;
      await sleep(RALPH_RESUME_LOCK_RETRY_MS);
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
      // Lock may already be gone after stale recovery or process interruption.
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  await rename(tempPath, path);
}

function isTerminalRalphPhase(value: unknown): boolean {
  return RALPH_TERMINAL_PHASES.has(safeString(value).trim().toLowerCase());
}

function isActiveRalphCandidate(state: Record<string, unknown> | null): state is Record<string, unknown> {
  if (!state || typeof state !== 'object') return false;
  return state.active === true && !isTerminalRalphPhase(state.current_phase);
}

async function readCurrentOmxSessionId(stateDir: string): Promise<string> {
  const session = await readJson(join(stateDir, 'session.json'));
  const sessionId = safeString(session?.session_id).trim();
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
}

function resolveResumePane(env: NodeJS.ProcessEnv = process.env): string {
  const injectedPane = captureTmuxPaneFromEnv(env);
  if (env !== process.env && injectedPane) return injectedPane;
  return resolveCodexPane() || injectedPane || '';
}

function bindCurrentPane(state: Record<string, unknown>, nowIso: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const paneId = resolveResumePane(env);
  if (!paneId) return state;

  return {
    ...state,
    tmux_pane_id: paneId,
    tmux_pane_set_at: nowIso,
  };
}

async function scanMatchingRalphCandidates(
  stateDir: string,
  currentOmxSessionId: string,
  payloadSessionId: string,
  payloadThreadId: string,
): Promise<RalphStateCandidate[]> {
  const sessionsRoot = join(stateDir, 'sessions');
  if (!existsSync(sessionsRoot)) return [];

  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const matches: RalphStateCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name) || entry.name === currentOmxSessionId) continue;
    const path = join(sessionsRoot, entry.name, 'ralph-state.json');
    if (!existsSync(path)) continue;
    const state = await readJson(path);
    if (!isActiveRalphCandidate(state)) continue;
    const ownerSessionId = safeString(state.owner_codex_session_id).trim();
    const ownerThreadId = safeString(state.owner_codex_thread_id).trim();
    if (ownerSessionId) {
      if (!payloadSessionId || ownerSessionId !== payloadSessionId) continue;
    } else if (!payloadThreadId || !ownerThreadId || ownerThreadId !== payloadThreadId) {
      continue;
    }
    matches.push({
      sessionId: entry.name,
      path,
      state,
    });
  }
  return matches;
}

export async function reconcileRalphSessionResume({
  stateDir,
  payloadSessionId,
  payloadThreadId = '',
  env = process.env,
  hooks,
}: RalphSessionResumeParams): Promise<RalphSessionResumeResult> {
  const lockedResult = await withRalphResumeLock(stateDir, async () => {
    await hooks?.afterLockAcquired?.();

    const currentOmxSessionId = await readCurrentOmxSessionId(stateDir);
    if (!currentOmxSessionId) {
      return {
        currentOmxSessionId: '',
        resumed: false,
        updatedCurrentOwner: false,
        reason: 'current_omx_session_missing',
      };
    }

    const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
    const currentRalphPath = join(currentSessionDir, 'ralph-state.json');
    const currentRalphExists = existsSync(currentRalphPath);
    const currentRalphState = currentRalphExists
      ? await readJson(currentRalphPath)
      : null;
    const nowIso = new Date().toISOString();

    if (currentRalphState && currentRalphState.active === true) {
      let changed = false;
      const updated: Record<string, unknown> = { ...currentRalphState };
      const normalizedPayloadThreadId = safeString(payloadThreadId).trim();
      if (safeString(updated.owner_omx_session_id).trim() !== currentOmxSessionId) {
        updated.owner_omx_session_id = currentOmxSessionId;
        changed = true;
      }
      if (payloadSessionId && !safeString(updated.owner_codex_session_id).trim()) {
        updated.owner_codex_session_id = payloadSessionId;
        changed = true;
      }
      if (
        !safeString(updated.owner_codex_session_id).trim()
        && normalizedPayloadThreadId
        && safeString(updated.owner_codex_thread_id).trim() !== normalizedPayloadThreadId
      ) {
        updated.owner_codex_thread_id = normalizedPayloadThreadId;
        changed = true;
      }
      if (
        typeof updated.owner_codex_thread_id === 'string'
        && safeString(updated.owner_codex_session_id).trim()
      ) {
        delete updated.owner_codex_thread_id;
        changed = true;
      }
      const currentPaneId = resolveResumePane(env);
      const currentStatePaneId = safeString(updated.tmux_pane_id).trim();
      if (currentPaneId && currentPaneId !== currentStatePaneId) {
        Object.assign(updated, bindCurrentPane(updated, nowIso, env));
        changed = true;
      }
      if (changed) {
        await writeJsonAtomic(currentRalphPath, updated);
      }
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: changed,
        reason: 'current_ralph_active',
        targetPath: currentRalphPath,
      };
    }

    if (currentRalphExists) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: currentRalphState ? 'current_ralph_present' : 'current_ralph_unreadable',
        targetPath: currentRalphPath,
      };
    }

    const normalizedPayloadSessionId = safeString(payloadSessionId).trim();
    const normalizedPayloadThreadId = safeString(payloadThreadId).trim();
    if (!normalizedPayloadSessionId && !normalizedPayloadThreadId) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: 'payload_codex_identity_missing',
      };
    }

    const candidates = await scanMatchingRalphCandidates(
      stateDir,
      currentOmxSessionId,
      normalizedPayloadSessionId,
      normalizedPayloadThreadId,
    );
    if (candidates.length !== 1) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: candidates.length === 0 ? 'no_matching_prior_ralph' : 'multiple_matching_prior_ralphs',
      };
    }

    const source = candidates[0];
    await mkdir(currentSessionDir, { recursive: true });

    const nextState = bindCurrentPane({
      ...source.state,
      owner_omx_session_id: currentOmxSessionId,
      ...(normalizedPayloadSessionId ? { owner_codex_session_id: normalizedPayloadSessionId } : {}),
    }, nowIso, env);
    if (safeString(nextState.owner_codex_session_id).trim()) {
      delete nextState.owner_codex_thread_id;
    }
    delete nextState.completed_at;
    delete nextState.stop_reason;

    const previousState: Record<string, unknown> = {
      ...source.state,
      active: false,
      current_phase: 'cancelled',
      completed_at: nowIso,
      stop_reason: 'ownership_transferred',
    };

    await writeJsonAtomic(currentRalphPath, nextState);
    try {
      await hooks?.afterTargetWrite?.();
      await writeJsonAtomic(source.path, previousState);
    } catch (error) {
      await rm(currentRalphPath, { force: true }).catch(() => {});
      throw error;
    }

    return {
      currentOmxSessionId,
      resumed: true,
      updatedCurrentOwner: false,
      reason: 'resumed_same_codex_session',
      sourcePath: source.path,
      targetPath: currentRalphPath,
    };
  });

  if (lockedResult) {
    return lockedResult;
  }

  return {
    currentOmxSessionId: '',
    resumed: false,
    updatedCurrentOwner: false,
    reason: 'resume_lock_timeout',
  };
}
