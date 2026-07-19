import { randomBytes } from 'crypto';
import { constants as fsConstants, lstatSync, readFileSync, realpathSync, type Stats } from 'fs';
import { lstat, open, readFile, rename, rm } from 'fs/promises';
import { join } from 'path';

import { resolveInstalledRoleName } from '../subagents/tracker.js';
import { getBaseStateDir, getStatePath, normalizeSessionId, resolveWritableStateScope } from '../mcp/state-paths.js';

export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan preflight [--json]
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]
`;

type RoleIntentFailureReason = 'unknown_role' | 'unsupported_documented_leader_proof';


interface ParsedRoleIntentWriteArgs {
  role: string;
  parentThreadId: string;
  sessionId?: string;
  ttlMs?: number;
  json: boolean;
}



export interface RalplanCommandDependencies {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveInstalledRoleName?: typeof resolveInstalledRoleName;
  neutralizeOwnedRoutingRalplan?: (cwd: string) => Promise<boolean>;

}

export async function ralplanCommand(args: string[], deps: RalplanCommandDependencies = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }
  if (args[0] === 'preflight') {
    const json = args.length === 2 && args[1] === '--json';
    if ((args.length !== 1 && !json)) throw new Error(`Unknown ralplan preflight argument: ${args.slice(1).join(' ')}`);
    await (deps.neutralizeOwnedRoutingRalplan ?? neutralizeOwnedRoutingRalplan)((deps.cwd ?? process.cwd)());

    const failure = { ok: false, reason: 'unsupported_documented_leader_proof' as const };
    if (json) stdout(JSON.stringify(failure));
    else stderr('ralplan preflight failed: unsupported_documented_leader_proof');
    process.exitCode = 1;
    return;
  }
  if (args[0] !== 'role-intent' || args[1] !== 'write') throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  const cwd = (deps.cwd ?? process.cwd)();
  const installedRole = (deps.resolveInstalledRoleName ?? resolveInstalledRoleName)(parsed.role, undefined, cwd);
  if (!installedRole) {
    emitRoleIntentFailure('unknown_role', parsed.json, stdout, stderr);
    return;
  }
  emitRoleIntentFailure('unsupported_documented_leader_proof', parsed.json, stdout, stderr);
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

async function createStaged(directory: string, label: string, bytes: Buffer): Promise<string> {
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
  return path;
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

async function rollbackPublished(directory: string, published: PublishedFile[], staged: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ROLLBACK_ATTEMPTS; attempt += 1) {
    try {
      let restored = false;
      for (let index = published.length - 1; index >= 0; index -= 1) {
        const file = published[index];
        await RALPLAN_NEUTRALIZE_TEST_SEAM.beforeRollback?.(index);
        await fault('rollback');
        if (!await publishedStillOwned(file)) throw new Error('foreign replacement during rollback');
        await rename(file.backup, file.path);
        staged.splice(staged.indexOf(file.backup), 1);
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

async function neutralizeOwnedRoutingRalplan(cwd: string): Promise<boolean> {
  const ownerSessionId = normalizeSessionId(process.env.OMX_SESSION_ID);
  if (!ownerSessionId) return false;

  const staged: string[] = [];
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
    const backups = await Promise.all(originals.map((file, index) => createStaged(directory, `ralplan-recovery-${index}`, file.bytes)));
    staged.push(...backups);
    const replacements = await Promise.all(next.map((bytes, index) => createStaged(directory, `ralplan-next-${index}`, bytes)));
    staged.push(...replacements);
    await syncDirectory(directory, 'prepare');

    for (let index = 0; index < originals.length; index += 1) {
      await RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish?.(index);
      if (!await stillPinned(originals[index])) throw new Error('canonical state changed before publish');
      await fault(index === 0 ? 'first-publish' : 'second-publish');
      await rename(replacements[index], originals[index].path);
      staged.splice(staged.indexOf(replacements[index]), 1);
      const stat = await lstat(originals[index].path);
      if (stat.isSymbolicLink() || !stat.isFile() || !(await readFile(originals[index].path)).equals(next[index])) throw new Error('published state changed');
      published.push({ path: originals[index].path, stat, next: next[index], backup: backups[index] });
    }

    await syncDirectory(directory, 'publish');
    await fault('read-back');
    if (!(await Promise.all(published.map(publishedStillOwned))).every(Boolean)) throw new Error('canonical state changed after publish');
    committed = true;

    try {
      for (const backup of backups) {
        await fault('cleanup');
        await rm(backup);
        staged.splice(staged.indexOf(backup), 1);
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
      for (const path of staged) {
        try {
          await rm(path);
        } catch {}
      }
    }
  }
}

function parseRoleIntentWriteArgs(args: string[]): ParsedRoleIntentWriteArgs {
  let role: string | undefined;
  let parentThreadId: string | undefined;
  let sessionId: string | undefined;
  let ttlMs: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--role' || arg === '--parent-thread' || arg === '--session' || arg === '--ttl-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}.`);
      if (arg === '--role') role = value;
      if (arg === '--parent-thread') parentThreadId = value;
      if (arg === '--session') sessionId = value;
      if (arg === '--ttl-ms') ttlMs = parseTtlMs(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) role = arg.slice('--role='.length);
    else if (arg.startsWith('--parent-thread=')) parentThreadId = arg.slice('--parent-thread='.length);
    else if (arg.startsWith('--session=')) sessionId = arg.slice('--session='.length);
    else if (arg.startsWith('--ttl-ms=')) ttlMs = parseTtlMs(arg.slice('--ttl-ms='.length));
    else throw new Error(`Unknown role-intent write argument: ${arg}`);
  }
  if (!role?.trim()) throw new Error('Missing --role.');
  if (!parentThreadId?.trim()) throw new Error('Missing --parent-thread.');
  return { role, parentThreadId, ...(sessionId === undefined ? {} : { sessionId }), ...(ttlMs === undefined ? {} : { ttlMs }), json };
}

function parseTtlMs(value: string): number {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('--ttl-ms must be a positive integer.');
  return ttlMs;
}

function emitRoleIntentFailure(reason: RoleIntentFailureReason, json: boolean, stdout: (line: string) => void, stderr: (line: string) => void): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
