import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { getBaseStateDir, type BeforeWritableCommit } from '../mcp/state-paths.js';
import { isTerminalRunOutcome, normalizeRunOutcome, normalizeTerminalLifecycleOutcome } from '../runtime/run-outcome.js';
import {
  assertWorkflowTransitionAllowed,
  isTrackedWorkflowMode,
  pickPrimaryWorkflowMode,
} from './workflow-transition.js';
import { readNeutralizedRoutingOverlay } from '../ralplan/documented-leader-preflight.js';

export const SKILL_ACTIVE_STATE_MODE = 'skill-active';
export const SKILL_ACTIVE_STATE_FILE = `${SKILL_ACTIVE_STATE_MODE}-state.json`;

const ROOT_SKILL_ACTIVE_LOCK_TIMEOUT_MS = 2_000;
const ROOT_SKILL_ACTIVE_LOCK_RETRY_MS = 10;
const ROOT_SKILL_ACTIVE_LOCK_STALE_MS = 10_000;

export class SkillActiveStateWriteError extends Error {
  readonly code: 'lock-timeout' | 'lock-lost' | 'malformed-root' | 'atomic-replace-failed';

  constructor(code: SkillActiveStateWriteError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SkillActiveStateWriteError';
    this.code = code;
  }
}

export const CANONICAL_WORKFLOW_SKILLS = [
  'autopilot',
  'autoresearch',
  'team',
  'ultragoal',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
] as const;

export type CanonicalWorkflowSkill = (typeof CANONICAL_WORKFLOW_SKILLS)[number];

export interface SkillActiveEntry {
  skill: string;
  phase?: string;
  active?: boolean;
  activated_at?: string;
  updated_at?: string;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  owner_codex_session_id?: string;
}

export interface SkillActiveStateLike {
  version?: number;
  active?: boolean;
  skill?: string;
  keyword?: string;
  phase?: string;
  activated_at?: string;
  updated_at?: string;
  source?: string;
  session_id?: string;
  thread_id?: string;
  turn_id?: string;
  owner_codex_session_id?: string;
  initialized_mode?: string;
  initialized_state_path?: string;
  input_lock?: unknown;
  active_skills?: SkillActiveEntry[];
  [key: string]: unknown;
}

export interface SyncCanonicalSkillStateOptions {
  cwd: string;
  baseStateDir?: string;
  mode: string;
  active: boolean;
  currentPhase?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  ownerCodexSessionId?: string;
  nowIso?: string;
  source?: string;
  allSessions?: boolean;
  beforeCommit?: BeforeWritableCommit;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function entryKey(entry: Pick<SkillActiveEntry, 'skill' | 'session_id'>): string {
  return `${entry.skill}::${safeString(entry.session_id).trim()}`;
}

function rootMirrorEntriesForCanonicalSession(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
  const normalizedSessionId = safeString(sessionId).trim();
  if (!normalizedSessionId) return entries;
  return entries.filter((entry) => {
    const entrySessionId = safeString(entry.session_id).trim();
    return entrySessionId.length === 0 || entrySessionId === normalizedSessionId;
  });
}

function filterSessionOnlyEntries(
  sessionState: SkillActiveStateLike | null,
  rootEntries: SkillActiveEntry[],
  sessionId: string,
): SkillActiveEntry[] {
  const inheritedKeys = new Set(rootMirrorEntriesForCanonicalSession(rootEntries, sessionId).map(entryKey));
  return listActiveSkills(sessionState ?? {}).filter((entry) => (
    safeString(entry.session_id).trim() === sessionId
    && !inheritedKeys.has(entryKey(entry))
  ));
}

function normalizeSkillActiveEntry(raw: unknown): SkillActiveEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const skill = safeString((raw as Record<string, unknown>).skill).trim();
  if (!skill) return null;

  return {
    ...raw as Record<string, unknown>,
    skill,
    phase: safeString((raw as Record<string, unknown>).phase).trim() || undefined,
    active: (raw as Record<string, unknown>).active !== false,
    activated_at: safeString((raw as Record<string, unknown>).activated_at).trim() || undefined,
    updated_at: safeString((raw as Record<string, unknown>).updated_at).trim() || undefined,
    session_id: safeString((raw as Record<string, unknown>).session_id).trim() || undefined,
    thread_id: safeString((raw as Record<string, unknown>).thread_id).trim() || undefined,
    turn_id: safeString((raw as Record<string, unknown>).turn_id).trim() || undefined,
    owner_codex_session_id: safeString((raw as Record<string, unknown>).owner_codex_session_id).trim() || undefined,
  };
}

export function extractSessionIdFromInitializedStatePath(pathValue: unknown): string | undefined {
  const pathText = safeString(pathValue).trim();
  if (!pathText) return undefined;
  const normalized = pathText.replace(/\\/g, '/');
  const match = /(?:^|\/)sessions\/([^/]+)\/[^/]+-state\.json$/.exec(normalized);
  return match?.[1];
}

function baseInitializationMatchesTargetSession(
  base: SkillActiveStateLike | null,
  targetSessionId?: string,
): boolean {
  const normalizedTargetSessionId = safeString(targetSessionId).trim();
  if (!normalizedTargetSessionId) return true;

  const initializedPathSessionId = extractSessionIdFromInitializedStatePath(base?.initialized_state_path);
  if (initializedPathSessionId && initializedPathSessionId !== normalizedTargetSessionId) {
    return false;
  }

  const baseSessionId = safeString(base?.session_id).trim();
  if (baseSessionId && baseSessionId !== normalizedTargetSessionId) {
    return false;
  }

  return true;
}

function sanitizeWriterBaseForSession(
  base: SkillActiveStateLike | null,
  targetSessionId?: string,
): SkillActiveStateLike {
  const inherited = { ...(base ?? {}) };
  if (!baseInitializationMatchesTargetSession(base, targetSessionId)) {
    delete inherited.initialized_mode;
    delete inherited.initialized_state_path;
    delete inherited.input_lock;
    delete inherited.context_snapshot_path;
    delete inherited.prd_path;
    delete inherited.test_spec_path;
    delete inherited.task_slug;
    delete inherited.task_description;
    delete inherited.owner_omx_session_id;
    delete inherited.owner_codex_session_id;
    delete inherited.owner_codex_thread_id;
    delete inherited.tmux_pane_id;
  }
  return inherited;
}

export function isTerminalSkillActivePhase(phase: unknown): boolean {
  const normalized = safeString(phase).trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === 'cleared') return true;
  const runOutcome = normalizeRunOutcome(normalized).outcome;
  if (isTerminalRunOutcome(runOutcome)) return true;
  return Boolean(normalizeTerminalLifecycleOutcome(normalized).outcome);
}

export function isTerminalSkillActiveState(state: SkillActiveStateLike): boolean {
  if (state.active === false) return true;
  if (isTerminalSkillActivePhase(state.phase)) return true;
  if (safeString(state.completed_at).trim().length > 0) return true;
  const runOutcome = normalizeRunOutcome(state.run_outcome).outcome;
  if (isTerminalRunOutcome(runOutcome)) return true;
  const lifecycleOutcome = normalizeTerminalLifecycleOutcome(state.lifecycle_outcome ?? state.terminal_outcome).outcome;
  return Boolean(lifecycleOutcome);
}

export function clearTerminalSkillActiveMarkers<T extends SkillActiveStateLike>(state: T): T {
  const next = { ...state };
  if (isTerminalSkillActivePhase(next.phase)) delete next.phase;
  delete next.completed_at;
  delete next.cancel_reason;
  delete next.run_outcome;
  delete next.lifecycle_outcome;
  delete next.terminal_outcome;
  delete next.terminal_reason;
  return next;
}

export function listActiveSkills(raw: unknown): SkillActiveEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const state = raw as SkillActiveStateLike;
  if (isTerminalSkillActiveState(state)) return [];
  const deduped = new Map<string, SkillActiveEntry>();

  if (Array.isArray(state.active_skills)) {
    for (const candidate of state.active_skills) {
      const normalized = normalizeSkillActiveEntry(candidate);
      if (!normalized || normalized.active === false) continue;
      deduped.set(entryKey(normalized), normalized);
    }
  }

  const topLevelSkill = safeString(state.skill).trim();
  if (deduped.size === 0 && state.active === true && topLevelSkill) {
    const topLevelEntry = {
      skill: topLevelSkill,
      phase: safeString(state.phase).trim() || undefined,
      active: true,
      activated_at: safeString(state.activated_at).trim() || undefined,
      updated_at: safeString(state.updated_at).trim() || undefined,
      session_id: safeString(state.session_id).trim() || undefined,
      thread_id: safeString(state.thread_id).trim() || undefined,
      turn_id: safeString(state.turn_id).trim() || undefined,
      owner_codex_session_id: safeString(state.owner_codex_session_id).trim() || undefined,
    };
    deduped.set(entryKey(topLevelEntry), topLevelEntry);
  }

  return [...deduped.values()];
}

/**
 * Returns whether a canonical compatibility record may speak for the requested
 * transition scope. A foreign outer session never authenticates unowned legacy
 * child entries for a root or different-session caller.
 */
export function isTransitionCanonicalStateOwned(raw: unknown, sessionId?: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const outerSessionId = safeString((raw as SkillActiveStateLike).session_id).trim();
  const normalizedSessionId = safeString(sessionId).trim();
  return normalizedSessionId ? !outerSessionId || outerSessionId === normalizedSessionId : !outerSessionId;
}

export function listTransitionActiveSkills(raw: unknown, sessionId?: string): SkillActiveEntry[] {
  if (!isTransitionCanonicalStateOwned(raw, sessionId)) return [];
  const entries = listActiveSkills(raw);
  const normalizedSessionId = safeString(sessionId).trim();
  if (normalizedSessionId) {
    return entries.filter((entry) => safeString(entry.session_id).trim() === normalizedSessionId);
  }
  return entries.filter((entry) => safeString(entry.session_id).trim().length === 0);
}

/** Owner metadata for read-only provenance preflight; never infers ownership from storage. */
export function listSkillActiveOwnerCodexSessionIds(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const state = raw as SkillActiveStateLike;
  const owners = [
    safeString(state.owner_codex_session_id).trim(),
    ...listActiveSkills(state).map((entry) => safeString(entry.owner_codex_session_id).trim()),
  ].filter(Boolean);
  return [...new Set(owners)];
}

export function normalizeSkillActiveState(raw: unknown): SkillActiveStateLike | null {
  if (!raw || typeof raw !== 'object') return null;
  const state = raw as SkillActiveStateLike;
  const activeSkills = listActiveSkills(state);
  const primary = activeSkills.find((entry) => entry.skill === safeString(state.skill).trim()) ?? activeSkills[0];
  const skill = safeString(state.skill).trim() || primary?.skill || '';
  if (!skill && activeSkills.length === 0) return null;

  return {
    ...state,
    version: typeof state.version === 'number' ? state.version : 1,
    active: typeof state.active === 'boolean' ? state.active : activeSkills.length > 0,
    skill,
    keyword: safeString(state.keyword).trim(),
    phase: safeString(state.phase).trim() || primary?.phase || '',
    activated_at: safeString(state.activated_at).trim() || primary?.activated_at || '',
    updated_at: safeString(state.updated_at).trim() || primary?.updated_at || '',
    source: safeString(state.source).trim() || undefined,
    session_id: safeString(state.session_id).trim() || primary?.session_id || undefined,
    thread_id: safeString(state.thread_id).trim() || primary?.thread_id || undefined,
    turn_id: safeString(state.turn_id).trim() || primary?.turn_id || undefined,
    owner_codex_session_id: safeString(state.owner_codex_session_id).trim() || primary?.owner_codex_session_id || undefined,
    active_skills: activeSkills.length > 0 ? activeSkills : undefined,
  };
}

export function getSkillActiveStatePaths(cwd: string, sessionId?: string): {
  rootPath: string;
  sessionPath?: string;
} {
  return getSkillActiveStatePathsForStateDir(getBaseStateDir(cwd), sessionId);
}

export function getSkillActiveStatePathsForStateDir(stateDir: string, sessionId?: string): {
  rootPath: string;
  sessionPath?: string;
} {
  const rootPath = join(stateDir, SKILL_ACTIVE_STATE_FILE);
  const normalizedSession = safeString(sessionId).trim();
  if (!normalizedSession) return { rootPath };
  return {
    rootPath,
    sessionPath: join(stateDir, 'sessions', normalizedSession, SKILL_ACTIVE_STATE_FILE),
  };
}

export async function readSkillActiveState(path: string): Promise<SkillActiveStateLike | null> {
  try {
    const canonical = JSON.parse(await readFile(path, 'utf-8'));
    const overlay = await readNeutralizedRoutingOverlay(path, 'skill');
    return normalizeSkillActiveState(overlay ?? canonical);
  } catch {
    return null;
  }
}

async function readRootStateForWrite(rootPath: string): Promise<SkillActiveStateLike | null> {
  let raw: string;
  try {
    raw = await readFile(rootPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SkillActiveStateWriteError('malformed-root', `unreadable root skill-active state: ${rootPath}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillActiveStateWriteError('malformed-root', `malformed root skill-active state: ${rootPath}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SkillActiveStateWriteError('malformed-root', `malformed root skill-active state: ${rootPath}`);
  }
  return normalizeSkillActiveState(parsed) ?? parsed as SkillActiveStateLike;
}

interface RootSkillActiveLock {
  path: string;
  token: string;
}

function lockOwnerPath(lockPath: string, token?: string): string {
  return join(lockPath, token ? `owner-${token}` : 'owner');
}


type LockOwnerMetadata =
  | { kind: 'valid'; token: string }
  | { kind: 'ownerless' }
  | { kind: 'ambiguous' };

async function inspectLockOwner(lockPath: string): Promise<LockOwnerMetadata> {
  try {
    const entries = await readdir(lockPath);
    const ownerEntries = entries.filter((entry) => entry === 'owner' || entry.startsWith('owner-'));
    const knownOwnerlessEntries = entries.filter((entry) => entry.startsWith('pending-') || entry.startsWith('released-'));
    if (ownerEntries.length === 0) {
      if (entries.length === 0) return { kind: 'ownerless' };
      if (entries.length === 1 && knownOwnerlessEntries.length === 1) {
        const entry = knownOwnerlessEntries[0];
        const expectedToken = entry.slice(entry.indexOf('-') + 1);
        const content = (await readFile(join(lockPath, entry), 'utf-8')).trim();
        return content === expectedToken ? { kind: 'ownerless' } : { kind: 'ambiguous' };
      }
      return { kind: 'ambiguous' };
    }
    if (ownerEntries.length !== 1 || entries.length !== 1) return { kind: 'ambiguous' };
    const ownerName = ownerEntries[0];
    const owner = (await readFile(join(lockPath, ownerName), 'utf-8')).trim();
    if (!owner) return { kind: 'ambiguous' };
    if (ownerName === 'owner' || ownerName.slice('owner-'.length) === owner) {
      return { kind: 'valid', token: owner };
    }
    return { kind: 'ambiguous' };
  } catch {
    return { kind: 'ambiguous' };
  }
}

async function readLockOwner(lockPath: string): Promise<string | null> {
  const metadata = await inspectLockOwner(lockPath);
  return metadata.kind === 'valid' ? metadata.token : null;
}

async function assertRootSkillActiveLockOwner(lock: RootSkillActiveLock): Promise<void> {
  if (await readLockOwner(lock.path) !== lock.token) {
    throw new SkillActiveStateWriteError('lock-lost', `root skill-active lock ownership was lost: ${lock.path}`);
  }
}

function ownerProcessIsDead(token: string): boolean {
  const pid = Number.parseInt(token.split('-', 1)[0] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function lockPendingPath(lockPath: string, token: string): string {
  return join(lockPath, `pending-${token}`);
}

function lockReleasedPath(lockPath: string, token: string): string {
  return `${lockPath}.released-${token}`;
}

async function reclaimOwnerlessStaleLock(lockPath: string): Promise<boolean> {
  const firstStat = await stat(lockPath);
  const firstMetadata = await inspectLockOwner(lockPath);
  if (firstMetadata.kind !== 'ownerless') return false;
  const firstEntries = await readdir(lockPath);
  const pendingEntry = firstEntries.length === 1 && firstEntries[0].startsWith('pending-');
  const markerPrefix = `${basename(lockPath)}.released-`;
  const markerEntries = (await readdir(dirname(lockPath))).filter((entry) => entry.startsWith(markerPrefix));
  if (markerEntries.length > 1) return false;
  let releaseMarkerPath: string | undefined;
  if (markerEntries.length === 1) {
    const markerName = markerEntries[0];
    const markerToken = markerName.slice(markerPrefix.length);
    if ((await readFile(join(dirname(lockPath), markerName), 'utf-8')).trim() !== markerToken) return false;
    releaseMarkerPath = join(dirname(lockPath), markerName);
  }
  if (!releaseMarkerPath && !pendingEntry && Date.now() - firstStat.mtimeMs <= ROOT_SKILL_ACTIVE_LOCK_STALE_MS) return false;

  const confirmedStat = await stat(lockPath);
  const confirmedMetadata = await inspectLockOwner(lockPath);
  const confirmedEntries = await readdir(lockPath);
  if (
    confirmedMetadata.kind !== 'ownerless'
    || confirmedStat.mtimeMs !== firstStat.mtimeMs
    || confirmedStat.ctimeMs !== firstStat.ctimeMs
    || confirmedEntries.length !== firstEntries.length
    || confirmedEntries[0] !== firstEntries[0]
  ) return false;

  const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockPath, stalePath);
  } catch {
    return false;
  }

  try {
    if ((await inspectLockOwner(stalePath)).kind === 'ownerless') {
      await rm(stalePath, { recursive: true, force: true });
      if (releaseMarkerPath) await unlink(releaseMarkerPath).catch(() => undefined);
    }
  } catch {
    // The path was replaced or removed; leave any successor untouched.
  }
  return true;
}

async function sleepForRootLock(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ROOT_SKILL_ACTIVE_LOCK_RETRY_MS));
}

async function acquireRootSkillActiveStateLock(rootPath: string): Promise<RootSkillActiveLock> {
  const lockPath = `${rootPath}.lock`;
  const token = `${process.pid}-${Date.now()}-${randomBytes(12).toString('hex')}`;
  const deadline = Date.now() + ROOT_SKILL_ACTIVE_LOCK_TIMEOUT_MS;
  await mkdir(dirname(rootPath), { recursive: true });

  for (;;) {
    let createdLockDirectory = false;
    let createdLockStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      await mkdir(lockPath);
      createdLockDirectory = true;
      createdLockStat = await stat(lockPath);
      await writeFile(lockPendingPath(lockPath, token), token, { flag: 'wx' });
      await rename(lockPendingPath(lockPath, token), lockOwnerPath(lockPath, token));
      return { path: lockPath, token };
    } catch {
      if (createdLockDirectory) {
        try {
          const currentStat = await stat(lockPath);
          if (
            (await inspectLockOwner(lockPath)).kind === 'ownerless'
            && (await readdir(lockPath)).length === 0
            && createdLockStat
            && currentStat.mtimeMs === createdLockStat.mtimeMs
            && currentStat.ctimeMs === createdLockStat.ctimeMs
          ) {
            await rmdir(lockPath);
          }
        } catch {
          // The path may have been atomically taken over or removed; retry without cleanup.
        }
        continue;
      }
      try {
        const observedToken = await readLockOwner(lockPath);
        if (!observedToken) {
          await reclaimOwnerlessStaleLock(lockPath);
        } else if (ownerProcessIsDead(observedToken)) {
          const firstStat = await stat(lockPath);
          if (Date.now() - firstStat.mtimeMs > ROOT_SKILL_ACTIVE_LOCK_STALE_MS) {
            const confirmedToken = await readLockOwner(lockPath);
            const confirmedStat = await stat(lockPath);
            if (confirmedToken === observedToken && confirmedStat.mtimeMs === firstStat.mtimeMs) {
              const stalePath = `${lockPath}.stale-${process.pid}-${randomBytes(6).toString('hex')}`;
              try {
                await rename(lockPath, stalePath);
                if (await readLockOwner(stalePath) === observedToken) {
                  await rm(stalePath, { recursive: true, force: true });
                }
              } catch {
                // Another process won the stale-lock takeover race; retry.
              }
            }
          }
        }
      } catch {
        // The lock may have been released between observations; retry.
      }
      if (Date.now() >= deadline) {
        throw new SkillActiveStateWriteError('lock-timeout', `timed out waiting for root skill-active lock: ${lockPath}`);
      }
      await sleepForRootLock();
    }
  }
}

async function releaseRootSkillActiveStateLock(lock: RootSkillActiveLock): Promise<void> {
  if (await readLockOwner(lock.path) !== lock.token) return;
  const releasedPath = lockReleasedPath(lock.path, lock.token);
  try {
    await writeFile(releasedPath, lock.token, { flag: 'wx' });
    await unlink(lockOwnerPath(lock.path, lock.token));
  } catch {
    await unlink(releasedPath).catch(() => undefined);
    return;
  }

}

async function withRootSkillActiveStateLock<T>(rootPath: string, operation: (lock: RootSkillActiveLock) => Promise<T>): Promise<T> {
  const lock = await acquireRootSkillActiveStateLock(rootPath);
  try {
    await assertRootSkillActiveLockOwner(lock);
    return await operation(lock);
  } finally {
    await releaseRootSkillActiveStateLock(lock);
  }
}
function stateWithActiveEntries(
  base: SkillActiveStateLike | null,
  entries: SkillActiveEntry[],
  fallbackMode: string,
): SkillActiveStateLike {
  const inherited = entries.length > 0 ? clearTerminalSkillActiveMarkers({ ...(base ?? {}) }) : { ...(base ?? {}) };
  const primarySkill = pickPrimaryWorkflowMode(safeString(inherited.skill).trim(), entries.map((entry) => entry.skill), fallbackMode);
  const primaryEntry = entries.find((entry) => entry.skill === primarySkill) ?? entries[0];
  return {
    ...inherited,
    version: 1,
    active: entries.length > 0,
    skill: primaryEntry?.skill || primarySkill || fallbackMode,
    phase: primaryEntry?.phase || safeString(inherited.phase).trim(),
    activated_at: primaryEntry?.activated_at || safeString(inherited.activated_at).trim(),
    active_skills: entries,
  };
}

function mergeRootStateForSession(
  currentRoot: SkillActiveStateLike | null,
  sessionState: SkillActiveStateLike,
  sessionId: string,
): SkillActiveStateLike {
  const currentEntries = listActiveSkills(currentRoot ?? {});
  const hasCurrentSessionEntry = currentEntries.some((entry) => safeString(entry.session_id).trim() === sessionId);
  const incomingEntries = hasCurrentSessionEntry
    ? listActiveSkills(sessionState).filter((entry) => safeString(entry.session_id).trim() === sessionId)
    : [];
  const mergedEntries = [
    ...currentEntries.filter((entry) => safeString(entry.session_id).trim() !== sessionId),
    ...incomingEntries,
  ];
  return stateWithActiveEntries(currentRoot ?? sessionState, mergedEntries, sessionState.skill || 'skill-active');
}

async function writeRootSkillActiveStateAtomically(
  rootPath: string,
  rootState: SkillActiveStateLike,
  beforeCommit?: BeforeWritableCommit,
  lock?: RootSkillActiveLock,
): Promise<void> {
  const tempPath = `${rootPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const payload = `${JSON.stringify({ version: 1, ...rootState }, null, 2)}\n`;
  await beforeCommit?.({ site: 'skill-active.root-copy', kind: 'write', path: rootPath });
  try {
    if (lock) await assertRootSkillActiveLockOwner(lock);
    await writeFile(tempPath, payload);
    if (lock) await assertRootSkillActiveLockOwner(lock);
    await rename(tempPath, rootPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof SkillActiveStateWriteError) throw error;
    throw new SkillActiveStateWriteError('atomic-replace-failed', `failed to atomically replace root skill-active state: ${rootPath}`, { cause: error });
  }
}

export async function writeSkillActiveStateCopies(
  cwd: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike | null,
): Promise<void> {
  const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
  await writeSkillActiveStateCopiesToPaths(rootPath, sessionPath, state, rootState);
}

export async function writeSkillActiveStateCopiesForStateDir(
  stateDir: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike | null,
  options: { beforeCommit?: BeforeWritableCommit; sessionOnlyWhenRootMissing?: boolean } = {},
): Promise<void> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  await writeSkillActiveStateCopiesToPaths(
    rootPath,
    sessionPath,
    state,
    rootState,
    options.beforeCommit,
    undefined,
    options.sessionOnlyWhenRootMissing,
  );
}

export async function updateRootSkillActiveStateForStateDir(
  stateDir: string,
  update: (currentRoot: SkillActiveStateLike | null) => SkillActiveStateLike | null,
  options: { beforeCommit?: BeforeWritableCommit } = {},
): Promise<void> {
  const { rootPath } = getSkillActiveStatePathsForStateDir(stateDir);
  await withRootSkillActiveStateLock(rootPath, async (lock) => {
    const currentRoot = await readRootStateForWrite(rootPath);
    const nextRoot = update(currentRoot);
    if (nextRoot === null) return;
    await writeRootSkillActiveStateAtomically(rootPath, nextRoot, options.beforeCommit, lock);
  });
}

async function writeSkillActiveStateCopiesToPaths(
  rootPath: string,
  sessionPath: string | undefined,
  state: SkillActiveStateLike,
  rootState?: SkillActiveStateLike | null,
  beforeCommit?: BeforeWritableCommit,
  lock?: RootSkillActiveLock,
  sessionOnlyWhenRootMissing = false,
): Promise<void> {
  const normalized = { version: 1, ...state };
  const writeSessionCopy = async (): Promise<void> => {
    if (!sessionPath) return;
    const sessionPayload = `${JSON.stringify(normalized, null, 2)}\n`;
    await mkdir(dirname(sessionPath), { recursive: true });
    await beforeCommit?.({ site: 'skill-active.session-copy', kind: 'write', path: sessionPath });
    await writeFile(sessionPath, sessionPayload);
  };
  const writeRootTransaction = async (ownedLock: RootSkillActiveLock): Promise<void> => {
    const currentRoot = await readRootStateForWrite(rootPath);
    if (sessionPath && sessionOnlyWhenRootMissing && currentRoot === null) {
      await writeSessionCopy();
      return;
    }
    const nextRoot = sessionPath
      ? mergeRootStateForSession(currentRoot, normalized, safeString(normalized.session_id).trim())
      : { version: 1, ...(rootState ?? normalized) };
    await writeRootSkillActiveStateAtomically(rootPath, nextRoot, beforeCommit, ownedLock);
    await writeSessionCopy();
  };

  if (rootState !== null && lock) {
    await writeRootTransaction(lock);
  } else if (rootState !== null) {
    await withRootSkillActiveStateLock(rootPath, writeRootTransaction);
  } else {
    await writeSessionCopy();
  }
}

export async function readVisibleSkillActiveState(cwd: string, sessionId?: string): Promise<SkillActiveStateLike | null> {
  const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
  return readVisibleSkillActiveStateFromPaths(rootPath, sessionPath);
}

export async function readVisibleSkillActiveStateForStateDir(
  stateDir: string,
  sessionId?: string,
): Promise<SkillActiveStateLike | null> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  return readVisibleSkillActiveStateFromPaths(rootPath, sessionPath);
}

async function readVisibleSkillActiveStateFromPaths(
  rootPath: string,
  sessionPath?: string,
): Promise<SkillActiveStateLike | null> {
  if (sessionPath) {
    return existsSync(sessionPath) ? readSkillActiveState(sessionPath) : null;
  }

  if (!existsSync(rootPath)) return null;
  return readSkillActiveState(rootPath);
}

export function tracksCanonicalWorkflowSkill(mode: string): mode is CanonicalWorkflowSkill {
  return (CANONICAL_WORKFLOW_SKILLS as readonly string[]).includes(mode);
}

export async function syncCanonicalSkillStateForMode(options: SyncCanonicalSkillStateOptions): Promise<void> {
  const baseStateDir = options.baseStateDir ?? getBaseStateDir(options.cwd);
  const { rootPath } = getSkillActiveStatePathsForStateDir(baseStateDir);
  await withRootSkillActiveStateLock(rootPath, async (lock) => {
    await syncCanonicalSkillStateForModeUnlocked({ ...options, baseStateDir }, lock);
  });
}

async function syncCanonicalSkillStateForModeUnlocked(
  options: SyncCanonicalSkillStateOptions,
  lock: RootSkillActiveLock,
): Promise<void> {
  const {
    cwd,
    baseStateDir = getBaseStateDir(cwd),
    mode,
    active,
    currentPhase,
    sessionId,
    threadId,
    turnId,
    ownerCodexSessionId,
    nowIso = new Date().toISOString(),
    source = 'state-server',
    allSessions = false,
  } = options;

  if (!tracksCanonicalWorkflowSkill(mode)) return;

  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(baseStateDir, sessionId);
  const existingRoot = await readRootStateForWrite(rootPath);
  const existingSession = sessionPath ? await readSkillActiveState(sessionPath) : null;
  if (!existingRoot && !existingSession && !active && !options.allSessions) return;

  const normalizedSessionId = safeString(sessionId).trim();
  const allRootEntries = listActiveSkills(existingRoot ?? {});
  const rootEntries = normalizedSessionId
    ? allRootEntries.filter((entry) => safeString(entry.session_id).trim() === normalizedSessionId)
    : allRootEntries;
  const sessionOnlyEntries = normalizedSessionId
    ? listActiveSkills(existingSession ?? {}).filter((entry) => (
      safeString(entry.session_id).trim() === normalizedSessionId
      && !rootEntries.some((rootEntry) => (
        rootEntry.skill === entry.skill
        && safeString(rootEntry.session_id).trim() === safeString(entry.session_id).trim()
      ))
    ))
    : [];
  const visibleEntries = listTransitionActiveSkills(existingSession ?? existingRoot ?? {}, sessionId);

  if (active && isTrackedWorkflowMode(mode)) {
    const currentWorkflowModes = visibleEntries
      .map((entry) => entry.skill)
      .filter(isTrackedWorkflowMode);
    assertWorkflowTransitionAllowed(currentWorkflowModes, mode, 'write');
  }

  if (!normalizedSessionId && existingRoot && !isTransitionCanonicalStateOwned(existingRoot)) return;

  const applyEntriesToState = (
    base: SkillActiveStateLike | null,
    entries: SkillActiveEntry[],
    fallbackMode: string,
    targetSessionId?: string,
  ): SkillActiveStateLike => {
    const inheritedBase = entries.length > 0
      ? clearTerminalSkillActiveMarkers(sanitizeWriterBaseForSession(base, targetSessionId))
      : sanitizeWriterBaseForSession(base, targetSessionId);
    const currentPrimary = safeString(inheritedBase.skill).trim();
    const primarySkill = pickPrimaryWorkflowMode(currentPrimary, entries.map((entry) => entry.skill), fallbackMode);
    const primaryEntry = entries.find((entry) => entry.skill === primarySkill) ?? entries[0];
    return {
      ...inheritedBase,
      version: 1,
      active: entries.length > 0,
      skill: primaryEntry?.skill || primarySkill || fallbackMode,
      keyword: safeString(inheritedBase.keyword).trim(),
      phase: primaryEntry?.phase || safeString(inheritedBase.phase).trim(),
      activated_at: primaryEntry?.activated_at || safeString(inheritedBase.activated_at).trim() || nowIso,
      updated_at: nowIso,
      source: safeString(inheritedBase.source).trim() || source,
      session_id: primaryEntry?.session_id || safeString(inheritedBase.session_id).trim() || undefined,
      thread_id: primaryEntry?.thread_id || safeString(inheritedBase.thread_id).trim() || undefined,
      turn_id: primaryEntry?.turn_id || safeString(inheritedBase.turn_id).trim() || undefined,
      owner_codex_session_id: primaryEntry?.owner_codex_session_id || safeString(inheritedBase.owner_codex_session_id).trim() || undefined,
      active_skills: entries,
    };
  };

  if (normalizedSessionId) {
    const nextSessionEntries = sessionOnlyEntries.filter((entry) => entry.skill !== mode);
    if (active) {
      nextSessionEntries.push({
        skill: mode,
        phase: safeString(currentPhase).trim() || undefined,
        active: true,
        activated_at: sessionOnlyEntries.find((entry) => entry.skill === mode)?.activated_at || nowIso,
        updated_at: nowIso,
        session_id: normalizedSessionId,
        thread_id: safeString(threadId).trim() || undefined,
        turn_id: safeString(turnId).trim() || undefined,
        owner_codex_session_id: safeString(ownerCodexSessionId).trim() || undefined,
      });
    }

    const nextSessionRootEntries = rootEntries.filter((entry) => !(
      entry.skill === mode
      && safeString(entry.session_id).trim() === normalizedSessionId
    ));
    const nextRootEntries = allRootEntries.filter((entry) => !(
      entry.skill === mode
      && safeString(entry.session_id).trim() === normalizedSessionId
    ));

    const nextSessionState = applyEntriesToState(
      existingSession ?? existingRoot,
      [...nextSessionRootEntries, ...nextSessionEntries],
      mode,
      normalizedSessionId,
    );
    const nextRootState = nextRootEntries.length > 0
      ? applyEntriesToState(existingRoot, nextRootEntries, mode)
      : applyEntriesToState(
        existingSession ?? existingRoot,
        active ? nextSessionEntries : [],
        mode,
        normalizedSessionId,
      );
    const sessionPaths = getSkillActiveStatePathsForStateDir(baseStateDir, sessionId);
    await writeSkillActiveStateCopiesToPaths(
      sessionPaths.rootPath,
      sessionPaths.sessionPath,
      nextSessionState,
      nextRootState,
      options.beforeCommit,
      lock,
    );
    return;
  }

  const rootScopedEntries = rootEntries.filter((entry) => safeString(entry.session_id).trim().length === 0);
  const sessionScopedRootMirrorEntries = allSessions
    ? []
    : rootEntries.filter((entry) => safeString(entry.session_id).trim().length > 0);
  const nextRootScopedEntries = rootScopedEntries.filter((entry) => entry.skill !== mode);
  if (active) {
    nextRootScopedEntries.push({
      skill: mode,
      phase: safeString(currentPhase).trim() || undefined,
      active: true,
      activated_at: rootScopedEntries.find((entry) => entry.skill === mode)?.activated_at || nowIso,
      updated_at: nowIso,
      session_id: undefined,
      thread_id: safeString(threadId).trim() || undefined,
      turn_id: safeString(turnId).trim() || undefined,
      owner_codex_session_id: safeString(ownerCodexSessionId).trim() || undefined,
    });
  }
  const nextRootEntries = allSessions
    ? rootEntries.filter((entry) => entry.skill !== mode)
    : [...sessionScopedRootMirrorEntries, ...nextRootScopedEntries];

  const nextRootState = applyEntriesToState(existingRoot, nextRootEntries, mode);
  await writeSkillActiveStateCopiesToPaths(
    rootPath,
    undefined,
    nextRootState,
    nextRootState,
    options.beforeCommit,
    lock,
  );

  const sessionsDir = join(baseStateDir, 'sessions');
  if (!existsSync(sessionsDir)) return;

  const sessionIds = await readdir(sessionsDir).catch(() => []);
  for (const candidate of sessionIds) {
    const sessionId = safeString(candidate).trim();
    if (!sessionId) continue;

    const sessionPath = join(sessionsDir, sessionId, SKILL_ACTIVE_STATE_FILE);
    if (!existsSync(sessionPath)) continue;

    const existingSessionState = await readSkillActiveState(sessionPath);
    const sessionOnlyEntries = filterSessionOnlyEntries(existingSessionState, rootEntries, sessionId)
      .filter((entry) => !(allSessions && entry.skill === mode));
    const nextVisibleRootEntries = nextRootEntries
      .filter((entry) => safeString(entry.session_id).trim() === sessionId);
    const nextSessionEntries = [...nextVisibleRootEntries, ...sessionOnlyEntries];

    if (nextSessionEntries.length === 0) {
      await options.beforeCommit?.({ site: 'skill-active.session-unlink', kind: 'unlink', path: sessionPath });
      await unlink(sessionPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      continue;
    }

    const nextSessionState = applyEntriesToState(
      existingSessionState ?? existingRoot,
      nextSessionEntries,
      nextSessionEntries[0]?.skill || mode,
      sessionId,
    );
    await writeSkillActiveStateCopiesToPaths(
      rootPath,
      sessionPath,
      nextSessionState,
      nextRootState,
      options.beforeCommit,
      lock,
    );
  }
}
