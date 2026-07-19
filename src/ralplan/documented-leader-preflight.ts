import { randomBytes } from 'crypto';
import { constants as fsConstants, lstatSync, readFileSync, realpathSync, type Stats } from 'fs';
import { lstat, open, readFile, rename, rm } from 'fs/promises';
import { join } from 'path';

import { getBaseStateDir, getStatePath, normalizeSessionId, resolveWritableStateScope } from '../mcp/state-paths.js';
import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const UNSUPPORTED_DOCUMENTED_LEADER_PROOF = 'unsupported_documented_leader_proof' as const;

export const UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
  }),
});

export const UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.',
  }),
});

type PreToolUseDenial = typeof UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE
  | typeof UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;

export interface Codex01445PreToolUseDependencies {
  resolveInstalledRoleName: typeof resolveInstalledRoleName;
  platform: NodeJS.Platform;
}

const defaultDependencies: Codex01445PreToolUseDependencies = {
  resolveInstalledRoleName,
  platform: process.platform,
};

function readCommand(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Bash') return undefined;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Recognize only the canonical standalone adapted role-intent invocation. The
 * environment placeholder is matched lexically and is never expanded or used
 * as authority. Wrappers, assignments, compounds, redirects, duplicate flags,
 * alternate ordering, and malformed commands deliberately fall through to the
 * CLI parser.
 */
export function parseCodex01445AdaptedRoleIntentCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { role: string } | null {
  const parentPlaceholder = platform === 'win32'
    ? '"%CODEX_THREAD_ID%"'
    : '"$CODEX_THREAD_ID"';
  const escapedPlaceholder = parentPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^omx ralplan role-intent write --role ([A-Za-z0-9_-]{1,64}) --parent-thread ${escapedPlaceholder} --json$`,
  );
  const match = command.match(pattern);
  return match?.[1] ? { role: match[1] } : null;
}

export function evaluateCodex01445PreToolUse(
  payload: Record<string, unknown>,
  overrides: Partial<Codex01445PreToolUseDependencies> = {},
): PreToolUseDenial | undefined {
  const command = readCommand(payload);
  if (!command) return undefined;
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseCodex01445AdaptedRoleIntentCommand(command, dependencies.platform);
  if (!parsed) return undefined;
  if (!dependencies.resolveInstalledRoleName(parsed.role)) return UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;
  return UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE;
}

function collectRoutingOwnerIds(baseStateDir: string, canonicalSessionId: string): Set<string> {
  const ownerIds = new Set([canonicalSessionId]);
  try {
    const pointerPath = join(baseStateDir, 'session.json');
    if (realpathSync(pointerPath) !== pointerPath || !lstatSync(pointerPath).isFile()) return ownerIds;
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf-8')) as Record<string, unknown>;
    for (const field of ['session_id', 'native_session_id', 'codex_session_id', 'owner_omx_session_id', 'owner_codex_session_id']) {
      const ownerId = normalizeSessionId(pointer[field]);
      if (ownerId) ownerIds.add(ownerId);
    }
  } catch {}
  return ownerIds;
}


function hasContradictoryRoutingOwner(state: Record<string, unknown>, ownerIds: Set<string>): boolean {
  for (const field of ['session_id', 'owner_omx_session_id', 'owner_codex_session_id']) {
    if (!Object.prototype.hasOwnProperty.call(state, field)) continue;
    const ownerId = normalizeSessionId(state[field]);
    if (!ownerId || !ownerIds.has(ownerId)) return true;
  }
  return false;
}

const MAX_ROUTING_STATE_BYTES = 128 * 1024;
const MAX_ROLLBACK_ATTEMPTS = 2;

type TransactionPoint =
  | 'temp-create'
  | 'temp-write'
  | 'temp-sync'
  | 'first-publish'
  | 'second-publish'
  | 'directory-sync'
  | 'read-back'
  | 'cleanup'
  | 'rollback';
type DirectorySyncPhase = 'prepare' | 'publish' | 'rollback' | 'cleanup';

/** @internal Test-only hooks; no CLI argument reaches these hooks. */
export const RALPLAN_NEUTRALIZE_TEST_SEAM: {
  fail?: (point: TransactionPoint) => void | Promise<void>;
  random?: () => Buffer;
  beforePublish?: (index: number) => void | Promise<void>;
  beforeRollback?: (index: number) => void | Promise<void>;
  directorySync?: (phase: DirectorySyncPhase) => void | Promise<void>;
} = {};

interface PinnedFile {
  path: string;
  bytes: Buffer;
  stat: Stats;
  state: Record<string, unknown>;
}

interface StagedFile {
  path: string;
  bytes: Buffer;
  stat: Stats;
}

interface PublishedFile {
  path: string;
  stat: Stats;
  next: Buffer;
  backup: string;
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function pinRegularState(path: string): Promise<PinnedFile | null> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ROUTING_STATE_BYTES) return null;

  const bytes = await readFile(path);
  const after = await lstat(path);
  if (!sameFile(stat, after) || bytes.length !== stat.size) return null;

  try {
    const state = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return state && !Array.isArray(state) ? { path, bytes, stat, state } : null;
  } catch {
    return null;
  }
}

async function stillPinned(file: PinnedFile): Promise<boolean> {
  try {
    const stat = await lstat(file.path);
    return !stat.isSymbolicLink()
      && stat.isFile()
      && stat.nlink === 1
      && sameFile(stat, file.stat)
      && (await readFile(file.path)).equals(file.bytes);
  } catch {
    return false;
  }
}

function ordinaryRoutingSeed(state: Record<string, unknown>, ownerIds: Set<string>, kind: 'ralplan' | 'skill'): boolean {
  if (hasContradictoryRoutingOwner(state, ownerIds)
    || state.active !== true
    || state.completed_at !== undefined
    || state.cancelled_at !== undefined
    || state.ralplan_consensus_gate !== undefined) return false;

  if (kind === 'ralplan') {
    return state.mode === 'ralplan'
      && state.current_phase === 'planning'
      && state.planning_complete !== true
      && !(typeof state.iteration === 'number' && state.iteration > 0);
  }
  return state.active_skill === 'ralplan' || state.skill === 'ralplan' || state.mode === 'ralplan';
}

async function fault(point: TransactionPoint): Promise<void> {
  await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.(point);
}

function temporaryPath(directory: string, label: string): string {
  const random = RALPLAN_NEUTRALIZE_TEST_SEAM.random ?? (() => randomBytes(24));
  return join(directory, `.${label}.${random().toString('hex')}`);
}

async function createStaged(directory: string, label: string, bytes: Buffer): Promise<StagedFile> {
  await fault('temp-create');
  const path = temporaryPath(directory, label);
  const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await fault('temp-write');
    await handle.writeFile(bytes);
    await fault('temp-sync');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !(await readFile(path)).equals(bytes)) {
    throw new Error('staged state changed before use');
  }
  return { path, bytes, stat };
}

async function stagedStillOwned(file: StagedFile): Promise<boolean> {
  try {
    const stat = await lstat(file.path);
    return !stat.isSymbolicLink()
      && stat.isFile()
      && stat.nlink === 1
      && sameFile(stat, file.stat)
      && (await readFile(file.path)).equals(file.bytes);
  } catch {
    return false;
  }
}

function removeStaged(staged: StagedFile[], path: string): void {
  const index = staged.findIndex((file) => file.path === path);
  if (index >= 0) staged.splice(index, 1);
}

async function removeOwnedStaged(file: StagedFile): Promise<boolean> {
  if (!await stagedStillOwned(file)) return false;
  await rm(file.path);
  return true;
}

async function syncDirectory(directory: string, phase: DirectorySyncPhase): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync?.(phase);
    await fault('directory-sync');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function neutralized(state: Record<string, unknown>, kind: 'ralplan' | 'skill'): Buffer {
  const now = new Date().toISOString();
  const next: Record<string, unknown> = {
    ...state,
    active: false,
    phase: 'cancelled',
    current_phase: 'cancelled',
    completed_at: now,
    last_turn_at: now,
  };
  if (kind === 'skill' && Array.isArray(state.active_skills)) {
    next.active_skills = state.active_skills.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const candidate = entry as Record<string, unknown>;
      return candidate.skill === 'ralplan' ? { ...candidate, active: false, phase: 'cancelled', current_phase: 'cancelled' } : candidate;
    });
  }
  return Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
}

async function publishedStillOwned(file: PublishedFile): Promise<boolean> {
  try {
    const stat = await lstat(file.path);
    return !stat.isSymbolicLink() && stat.isFile() && sameFile(stat, file.stat) && (await readFile(file.path)).equals(file.next);
  } catch {
    return false;
  }
}

async function rollbackPublished(directory: string, published: PublishedFile[], staged: StagedFile[]): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ROLLBACK_ATTEMPTS; attempt += 1) {
    try {
      let restored = false;
      for (let index = published.length - 1; index >= 0; index -= 1) {
        const file = published[index];
        await RALPLAN_NEUTRALIZE_TEST_SEAM.beforeRollback?.(index);
        await fault('rollback');
        const backup = staged.find((candidate) => candidate.path === file.backup);
        if (!await publishedStillOwned(file) || !backup || !await stagedStillOwned(backup)) {
          throw new Error('foreign replacement during rollback');
        }
        await rename(backup.path, file.path);
        removeStaged(staged, backup.path);
        published.splice(index, 1);
        restored = true;
      }
      if (restored) await syncDirectory(directory, 'rollback');
      return true;
    } catch {
      if (attempt + 1 === MAX_ROLLBACK_ATTEMPTS) return false;
    }
  }
  return false;
}

export async function neutralizeOwnedRoutingRalplan(cwd: string): Promise<boolean> {
  const ownerSessionId = normalizeSessionId(process.env.OMX_SESSION_ID);
  if (!ownerSessionId) return false;

  const staged: StagedFile[] = [];
  const published: PublishedFile[] = [];
  let directory = '';
  let committed = false;
  let preserveRecoveryFiles = false;

  try {
    const scope = await resolveWritableStateScope(cwd);
    if (scope.source !== 'session' || !scope.sessionId) return false;

    const baseStateDir = getBaseStateDir(cwd);
    const sessionsDir = join(baseStateDir, 'sessions');
    directory = join(sessionsDir, scope.sessionId);
    if (realpathSync(baseStateDir) !== baseStateDir
      || realpathSync(sessionsDir) !== sessionsDir
      || realpathSync(directory) !== directory
      || lstatSync(sessionsDir).isSymbolicLink()
      || lstatSync(directory).isSymbolicLink()) return false;

    const ownerIds = collectRoutingOwnerIds(baseStateDir, scope.sessionId);
    if (!ownerIds.has(ownerSessionId)) return false;

    const [ralplan, skill] = await Promise.all([
      pinRegularState(getStatePath('ralplan', cwd, scope.sessionId)),
      pinRegularState(join(directory, 'skill-active-state.json')),
    ]);
    if (!ralplan || !skill || !ordinaryRoutingSeed(ralplan.state, ownerIds, 'ralplan') || !ordinaryRoutingSeed(skill.state, ownerIds, 'skill')) return false;

    const originals = [ralplan, skill];
    const next = [neutralized(ralplan.state, 'ralplan'), neutralized(skill.state, 'skill')];
    const backups: StagedFile[] = [];
    for (let index = 0; index < originals.length; index += 1) {
      const backup = await createStaged(directory, `ralplan-recovery-${index}`, originals[index].bytes);
      backups.push(backup);
      staged.push(backup);
    }
    const replacements: StagedFile[] = [];
    for (let index = 0; index < next.length; index += 1) {
      const replacement = await createStaged(directory, `ralplan-next-${index}`, next[index]);
      replacements.push(replacement);
      staged.push(replacement);
    }
    await syncDirectory(directory, 'prepare');

    for (let index = 0; index < originals.length; index += 1) {
      await RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish?.(index);
      if (!await stillPinned(originals[index])) throw new Error('canonical state changed before publish');
      await fault(index === 0 ? 'first-publish' : 'second-publish');
      if (!await stagedStillOwned(replacements[index])) throw new Error('replacement temporary changed before publish');
      await rename(replacements[index].path, originals[index].path);
      removeStaged(staged, replacements[index].path);
      const stat = await lstat(originals[index].path);
      if (stat.isSymbolicLink() || !stat.isFile() || !(await readFile(originals[index].path)).equals(next[index])) throw new Error('published state changed');
      published.push({ path: originals[index].path, stat, next: next[index], backup: backups[index].path });
    }

    await syncDirectory(directory, 'publish');
    await fault('read-back');
    if (!(await Promise.all(published.map(publishedStillOwned))).every(Boolean)) throw new Error('canonical state changed after publish');
    committed = true;

    try {
      for (const backup of backups) {
        await fault('cleanup');
        if (!await removeOwnedStaged(backup)) throw new Error('recovery temporary changed before cleanup');
        removeStaged(staged, backup.path);
      }
      await syncDirectory(directory, 'cleanup');
    } catch {
      // The durable canonical pair is already committed. Recovery-file cleanup is best effort.
    }
    return true;
  } catch {
    if (committed) return true;
    preserveRecoveryFiles = !await rollbackPublished(directory, published, staged);
    return false;
  } finally {
    if (!preserveRecoveryFiles) {
      for (const file of staged) {
        try {
          await removeOwnedStaged(file);
        } catch {}
      }
    }
  }
}

