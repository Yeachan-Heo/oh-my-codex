import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getBaseStateDir, getStatePath, normalizeSessionId, resolveWritableStateScope } from '../mcp/state-paths.js';
import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const UNSUPPORTED_DOCUMENTED_LEADER_PROOF = 'unsupported_documented_leader_proof' as const;

export const UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
  }),
});
export const UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.' }),
});
type PreToolUseDenial = typeof UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE | typeof UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;

export interface Codex01445PreToolUseDependencies { resolveInstalledRoleName: typeof resolveInstalledRoleName; platform: NodeJS.Platform; }
const defaultDependencies: Codex01445PreToolUseDependencies = { resolveInstalledRoleName, platform: process.platform };
function readCommand(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Bash' || !payload.tool_input || typeof payload.tool_input !== 'object' || Array.isArray(payload.tool_input)) return undefined;
  const command = (payload.tool_input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}
export function parseCodex01445AdaptedRoleIntentCommand(command: string, platform: NodeJS.Platform = process.platform): { role: string } | null {
  const placeholder = platform === 'win32' ? '"%CODEX_THREAD_ID%"' : '"$CODEX_THREAD_ID"';
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(new RegExp(`^omx ralplan role-intent write --role ([A-Za-z0-9_-]{1,64}) --parent-thread ${escaped} --json$`));
  return match?.[1] ? { role: match[1] } : null;
}
export function evaluateCodex01445PreToolUse(payload: Record<string, unknown>, overrides: Partial<Codex01445PreToolUseDependencies> = {}): PreToolUseDenial | undefined {
  const command = readCommand(payload); if (!command) return undefined;
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseCodex01445AdaptedRoleIntentCommand(command, dependencies.platform);
  if (!parsed) return undefined;
  return dependencies.resolveInstalledRoleName(parsed.role) ? UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE : UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;
}

const MAX_BYTES = 128 * 1024;
const MAX_GENERATION_BYTES = 64 * 1024;
const MAX_GENERATIONS = 32;
const GENERATION_PREFIX = '.ralplan-neutralization-';
const COMMIT_SUFFIX = '.commit.json';
const GENERATION_VERSION = 1;
type OverlayKind = 'ralplan' | 'skill';
type FaultPoint = 'data-create' | 'data-write' | 'data-sync' | 'commit-create' | 'commit-write' | 'commit-sync' | 'directory-sync' | 'commit-final-write' | 'commit-final-sync';
/** @internal Test-only hooks; no CLI argument reaches these hooks. */
export const RALPLAN_NEUTRALIZE_TEST_SEAM: { fail?: (point: FaultPoint) => void | Promise<void>; random?: () => Buffer; directorySync?: () => void | Promise<void> } = {};

function regularSingleLink(stat: Awaited<ReturnType<typeof lstat>>, max = MAX_BYTES): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max;
}
async function readPinned(path: string, max = MAX_BYTES): Promise<Buffer | null> {
  try {
    const before = await lstat(path); if (!regularSingleLink(before, max)) return null;
    const bytes = await readFile(path); const after = await lstat(path);
    return regularSingleLink(after, max) && before.dev === after.dev && before.ino === after.ino && before.size === after.size && bytes.length === before.size ? bytes : null;
  } catch { return null; }
}
function object(bytes: Buffer): Record<string, unknown> | null {
  try { const parsed = JSON.parse(bytes.toString('utf8')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; }
}
function digest(ralplan: Buffer, skill: Buffer): string {
  return createHash('sha256').update('ralplan-state.json\0').update(ralplan).update('\0skill-active-state.json\0').update(skill).digest('hex');
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function optionalNonEmptyStrings(state: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => !Object.prototype.hasOwnProperty.call(state, key) || isNonEmptyString(state[key]));
}
function ownerMatches(state: Record<string, unknown>, owners: Set<string>): boolean {
  for (const key of ['session_id', 'owner_omx_session_id', 'owner_codex_session_id']) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
    const value = normalizeSessionId(state[key]); if (!value || !owners.has(value)) return false;
  }
  return true;
}
function hasOnlyKeys(state: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(state).every((key) => allowed.has(key));
}

const ROUTING_ONLY_RALPLAN_KEYS = new Set([
  'active', 'mode', 'current_phase', 'started_at', 'updated_at',
  'session_id', 'owner_omx_session_id', 'owner_codex_session_id',
  'thread_id', 'turn_id', 'tmux_pane_id', 'tmux_pane_set_at', 'tmux_window_id',
]);
const ROUTING_ONLY_RALPLAN_OPTIONAL_STRING_KEYS = [
  'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id', 'tmux_pane_id', 'tmux_pane_set_at', 'tmux_window_id',
] as const;

const ROUTING_ONLY_SKILL_KEYS = new Set([
  'version', 'active', 'skill', 'keyword', 'phase', 'activated_at', 'updated_at',
  'source', 'session_id', 'owner_omx_session_id', 'owner_codex_session_id',
  'thread_id', 'turn_id', 'active_skills', 'initialized_mode', 'initialized_state_path',
]);
const ROUTING_ONLY_SKILL_OPTIONAL_STRING_KEYS = [
  'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id',
] as const;

const ROUTING_ONLY_SKILL_ENTRY_KEYS = new Set([
  'skill', 'phase', 'active', 'activated_at', 'updated_at',
  'session_id', 'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id',
]);

function routingOnlyRalplan(state: Record<string, unknown>, owners: Set<string>): boolean {
  return state.active === true
    && state.mode === 'ralplan'
    && state.current_phase === 'planning'
    && isNonEmptyString(state.started_at)
    && isNonEmptyString(state.updated_at)
    && Boolean(normalizeSessionId(state.session_id))
    && ownerMatches(state, owners)
    && optionalNonEmptyStrings(state, ROUTING_ONLY_RALPLAN_OPTIONAL_STRING_KEYS)
    && hasOnlyKeys(state, ROUTING_ONLY_RALPLAN_KEYS);
}
function routingOnlySkill(state: Record<string, unknown>, owners: Set<string>, sessionId: string): boolean {
  if (state.version !== 1 || state.active !== true || state.skill !== 'ralplan' || state.phase !== 'planning'
    || (state.keyword !== '$ralplan' && state.keyword !== 'consensus plan') || state.source !== 'keyword-detector'
    || state.initialized_mode !== 'ralplan' || state.initialized_state_path !== `.omx/state/sessions/${sessionId}/ralplan-state.json`
    || !isNonEmptyString(state.activated_at) || !isNonEmptyString(state.updated_at)
    || normalizeSessionId(state.session_id) !== sessionId || !ownerMatches(state, owners)
    || !optionalNonEmptyStrings(state, ROUTING_ONLY_SKILL_OPTIONAL_STRING_KEYS)
    || !Array.isArray(state.active_skills) || state.active_skills.length !== 1 || !hasOnlyKeys(state, ROUTING_ONLY_SKILL_KEYS)) return false;
  const entry = state.active_skills[0];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const item = entry as Record<string, unknown>;
  return item.skill === 'ralplan' && item.active === true && item.phase === 'planning'
    && isNonEmptyString(item.activated_at) && isNonEmptyString(item.updated_at)
    && normalizeSessionId(item.session_id) === sessionId && ownerMatches(item, owners)
    && optionalNonEmptyStrings(item, ROUTING_ONLY_SKILL_OPTIONAL_STRING_KEYS)
    && hasOnlyKeys(item, ROUTING_ONLY_SKILL_ENTRY_KEYS);
}
function routingOnlyPair(ralplan: Record<string, unknown>, skill: Record<string, unknown>, owners: Set<string>): boolean {
  const sessionId = normalizeSessionId(ralplan.session_id);
  if (!sessionId || !owners.has(sessionId)) return false;
  return routingOnlyRalplan(ralplan, owners)
    && routingOnlySkill(skill, owners, sessionId);
}
function neutralized(state: Record<string, unknown>, kind: OverlayKind): Record<string, unknown> {
  const next: Record<string, unknown> = { ...state, active: false, phase: 'cancelled', current_phase: 'cancelled' };
  if (kind === 'skill' && Array.isArray(state.active_skills)) next.active_skills = state.active_skills.map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry as Record<string, unknown>, active: false, phase: 'cancelled', current_phase: 'cancelled' } : entry);
  return next;
}
function collectOwners(baseStateDir: string, sessionId: string): Set<string> {
  const owners = new Set([sessionId]);
  try {
    const pointerPath = join(baseStateDir, 'session.json');
    if (realpathSync(pointerPath) !== pointerPath || !lstatSync(pointerPath).isFile()) return owners;
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as Record<string, unknown>;
    for (const key of ['session_id', 'native_session_id', 'codex_session_id', 'owner_omx_session_id', 'owner_codex_session_id']) { const value = normalizeSessionId(pointer[key]); if (value) owners.add(value); }
  } catch {}
  return owners;
}
interface Generation { version: number; digest: string; canonical: { ralplan: { sha256: string; size: number }; skill: { sha256: string; size: number } }; }
function validGeneration(candidate: unknown, expectedDigest: string, ralplan: Buffer, skill: Buffer): candidate is Generation {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const item = candidate as Partial<Generation>;
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  return item.version === GENERATION_VERSION && item.digest === expectedDigest
    && item.canonical?.ralplan?.sha256 === hash(ralplan) && item.canonical.ralplan.size === ralplan.length
    && item.canonical?.skill?.sha256 === hash(skill) && item.canonical.skill.size === skill.length;
}
interface Commit { version: number; digest: string; dataFile: string; committed: boolean; }
function validCommit(candidate: unknown, expectedDigest: string, dataFile: string): candidate is Commit {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const item = candidate as Partial<Commit>;
  return item.version === GENERATION_VERSION && item.digest === expectedDigest && item.dataFile === dataFile && item.committed === true;
}
async function readGeneration(directory: string, expectedDigest: string, ralplan: Buffer, skill: Buffer): Promise<Generation | null> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const prefix = `${GENERATION_PREFIX}${expectedDigest}-`;
  for (const commitName of names.filter((name) => name.startsWith(prefix) && name.endsWith(COMMIT_SUFFIX)).sort().slice(0, MAX_GENERATIONS)) {
    const token = commitName.slice(prefix.length, -COMMIT_SUFFIX.length);
    if (!/^[0-9a-f]{48}$/.test(token)) continue;
    const dataFile = `${prefix}${token}.json`;
    const commitBytes = await readPinned(join(directory, commitName), MAX_GENERATION_BYTES); if (!commitBytes || !validCommit(object(commitBytes), expectedDigest, dataFile)) continue;
    const dataBytes = await readPinned(join(directory, dataFile), MAX_GENERATION_BYTES); if (!dataBytes) continue;
    const parsed = object(dataBytes); if (validGeneration(parsed, expectedDigest, ralplan, skill)) return parsed;
  }
  return null;
}
/** Returns an inert overlay only for the exact current canonical routing-only pair. */
export async function readNeutralizedRoutingOverlay(path: string, kind: OverlayKind): Promise<Record<string, unknown> | null> {
  const directory = join(path, '..');
  const ralplanPath = kind === 'ralplan' ? path : join(directory, 'ralplan-state.json');
  const skillPath = kind === 'skill' ? path : join(directory, 'skill-active-state.json');
  const sessionId = normalizeSessionId(basename(directory));
  const baseStateDir = join(directory, '..', '..');
  if (!sessionId || basename(join(directory, '..')) !== 'sessions') return null;
  const [ralplan, skill] = await Promise.all([readPinned(ralplanPath), readPinned(skillPath)]);
  if (!ralplan || !skill || basename(ralplanPath) !== 'ralplan-state.json' || basename(skillPath) !== 'skill-active-state.json') return null;
  const canonicalRalplan = object(ralplan); const canonicalSkill = object(skill);
  const owners = collectOwners(baseStateDir, sessionId);
  if (!canonicalRalplan || !canonicalSkill || !routingOnlyPair(canonicalRalplan, canonicalSkill, owners)) return null;
  const generation = await readGeneration(directory, digest(ralplan, skill), ralplan, skill);
  if (!generation) return null;
  return neutralized(kind === 'ralplan' ? canonicalRalplan : canonicalSkill, kind);
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try { await RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync?.(); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('directory-sync'); await handle.sync(); } finally { await handle.close(); }
}
export async function neutralizeOwnedRoutingRalplan(cwd: string): Promise<boolean> {
  try {
    const ownerSessionId = normalizeSessionId(process.env.OMX_SESSION_ID); if (!ownerSessionId) return false;
    const scope = await resolveWritableStateScope(cwd); if (scope.source !== 'session' || !scope.sessionId) return false;
    const base = getBaseStateDir(cwd); const directory = scope.stateDir;
    if (realpathSync(base) !== base || realpathSync(directory) !== directory || lstatSync(directory).isSymbolicLink()) return false;
    const owners = collectOwners(base, scope.sessionId); if (!owners.has(ownerSessionId)) return false;
    const [ralplanBytes, skillBytes] = await Promise.all([readPinned(getStatePath('ralplan', cwd, scope.sessionId)), readPinned(join(directory, 'skill-active-state.json'))]);
    if (!ralplanBytes || !skillBytes) return false;
    const ralplan = object(ralplanBytes); const skill = object(skillBytes);
    if (!ralplan || !skill || !routingOnlyPair(ralplan, skill, owners)) return false;
    const pairDigest = digest(ralplanBytes, skillBytes);
    const record: Generation = { version: GENERATION_VERSION, digest: pairDigest, canonical: { ralplan: { sha256: createHash('sha256').update(ralplanBytes).digest('hex'), size: ralplanBytes.length }, skill: { sha256: createHash('sha256').update(skillBytes).digest('hex'), size: skillBytes.length } } };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`); const random = RALPLAN_NEUTRALIZE_TEST_SEAM.random ?? (() => randomBytes(24));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = random().toString('hex'); if (!/^[0-9a-f]{48}$/.test(token)) return false;
      const dataFile = `${GENERATION_PREFIX}${pairDigest}-${token}.json`;
      const commitFile = `${GENERATION_PREFIX}${pairDigest}-${token}${COMMIT_SUFFIX}`;
      let dataHandle: Awaited<ReturnType<typeof open>> | undefined;
      let commitHandle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-create');
        dataHandle = await open(join(directory, dataFile), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-write'); await dataHandle.writeFile(bytes);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-sync'); await dataHandle.sync(); await dataHandle.close(); dataHandle = undefined;
        const pending = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: false } satisfies Commit)}\n`);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-create');
        commitHandle = await open(join(directory, commitFile), fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-write'); await commitHandle.writeFile(pending);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-sync'); await commitHandle.sync();
        await syncDirectory(directory);
        const committed = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: true } satisfies Commit)}\n`);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-final-write');
        await commitHandle.write(committed, 0, committed.length, 0); await commitHandle.truncate(committed.length);
        await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-final-sync');
        await commitHandle.sync(); await commitHandle.close(); commitHandle = undefined;
        return true;
      } catch (error) {
        if (commitHandle) {
          try {
            const pending = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: false } satisfies Commit)}\n`);
            await commitHandle.write(pending, 0, pending.length, 0);
            await commitHandle.truncate(pending.length);
            await commitHandle.sync();
          } catch {}
        }
        await dataHandle?.close().catch(() => {}); await commitHandle?.close().catch(() => {});
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        return false;
      }
    }
  } catch {}
  return false;
}
