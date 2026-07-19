import { resolveInstalledRoleName } from '../subagents/tracker.js';
import { lstat, open, readFile } from 'fs/promises';
import { constants as fsConstants, lstatSync, readFileSync, realpathSync } from 'fs';
import { join } from 'path';


import { getBaseStateDir, getStatePath, normalizeSessionId, resolveWritableStateScope } from '../mcp/state-paths.js';



export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan preflight [--json]
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]

preflight and role-intent write fail closed on adapted Codex surfaces because Codex 0.144.5 does not document leader proof.
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
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveInstalledRoleName?: typeof resolveInstalledRoleName;
  neutralizeOwnedRoutingRalplan?: (cwd: string) => Promise<boolean>;


}

export async function ralplanCommand(
  args: string[],
  deps: RalplanCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }
  if (args[0] === 'preflight') {
    const json = args.length === 2 && args[1] === '--json';
    if ((args.length !== 1 && !json)) throw new Error(`Unknown ralplan preflight argument: ${args.slice(1).join(' ')}`);
    await (deps.neutralizeOwnedRoutingRalplan ?? neutralizeOwnedRoutingRalplan)(process.cwd());

    const failure = { ok: false, reason: 'unsupported_documented_leader_proof' as const };
    if (json) stdout(JSON.stringify(failure));
    else stderr('ralplan preflight failed: unsupported_documented_leader_proof');
    process.exitCode = 1;
    return;
  }

  if (args[0] !== 'role-intent' || args[1] !== 'write') {
    throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);
  }

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  const role = (deps.resolveInstalledRoleName ?? resolveInstalledRoleName)(parsed.role);
  emitRoleIntentFailure(
    role ? 'unsupported_documented_leader_proof' : 'unknown_role',
    parsed.json,
    stdout,
    stderr,
  );
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

async function neutralizeOwnedRoutingRalplan(cwd: string): Promise<boolean> {
  const ownerSessionId = normalizeSessionId(process.env.OMX_SESSION_ID);
  if (!ownerSessionId) return false;
  try {
    const scope = await resolveWritableStateScope(cwd);
    if (scope.source !== 'session' || !scope.sessionId) return false;
    const baseStateDir = getBaseStateDir(cwd);
    if (realpathSync(baseStateDir) !== baseStateDir) return false;
    const sessionsDir = join(baseStateDir, 'sessions');
    if (realpathSync(sessionsDir) !== sessionsDir || lstatSync(sessionsDir).isSymbolicLink()) return false;
    const authorityDir = join(sessionsDir, scope.sessionId);
    if (realpathSync(authorityDir) !== authorityDir || lstatSync(authorityDir).isSymbolicLink()) return false;
    const ownerIds = collectRoutingOwnerIds(baseStateDir, scope.sessionId);
    const path = getStatePath('ralplan', cwd, scope.sessionId);
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) return false;
    const originalContent = await readFile(path, 'utf-8');
    const state = JSON.parse(originalContent) as Record<string, unknown>;
    if (hasContradictoryRoutingOwner(state, ownerIds)) return false;
    if (
      state.active !== true
      || state.mode !== 'ralplan'
      || (state.session_id !== undefined && !ownerIds.has(normalizeSessionId(state.session_id) ?? ''))
      || state.current_phase !== 'planning'
      || state.planning_complete === true
      || state.ralplan_consensus_gate !== undefined
      || (typeof state.iteration === 'number' && state.iteration > 0)
    ) return false;
    const handle = await open(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      const currentStat = await handle.stat();
      if (currentStat.dev !== fileStat.dev || currentStat.ino !== fileStat.ino) return false;
      if (await handle.readFile({ encoding: 'utf-8' }) !== originalContent) return false;
      const now = new Date().toISOString();
      const neutralized = {
        ...state,
        active: false,
        current_phase: 'cancelled',
        completed_at: now,
        last_turn_at: now,
      };
      await handle.truncate(0);
      await handle.write(JSON.stringify(neutralized, null, 2), 0, 'utf-8');
      await handle.sync();
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
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
    if (arg === '--json') {
      json = true;
      continue;
    }
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
    if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
      continue;
    }
    if (arg.startsWith('--parent-thread=')) {
      parentThreadId = arg.slice('--parent-thread='.length);
      continue;
    }
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      continue;
    }
    if (arg.startsWith('--ttl-ms=')) {
      ttlMs = parseTtlMs(arg.slice('--ttl-ms='.length));
      continue;
    }
    throw new Error(`Unknown role-intent write argument: ${arg}`);
  }

  if (!role?.trim()) throw new Error('Missing --role.');
  if (!parentThreadId?.trim()) throw new Error('Missing --parent-thread.');
  return {
    role,
    parentThreadId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    json,
  };
}

function parseTtlMs(value: string): number {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('--ttl-ms must be a positive integer.');
  }
  return ttlMs;
}

function emitRoleIntentFailure(
  reason: RoleIntentFailureReason,
  json: boolean,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
