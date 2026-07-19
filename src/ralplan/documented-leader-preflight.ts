import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, open, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { getBaseStateDir, normalizeSessionId, resolveWritableStateScope } from '../mcp/state-paths.js';
import { getExplicitSkillDefinition } from '../hooks/keyword-registry.js';
import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const UNSUPPORTED_DOCUMENTED_LEADER_PROOF = 'unsupported_documented_leader_proof' as const;
export const UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.' }) });
export const UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.' }) });
type PreToolUseDenial = typeof UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE | typeof UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;
export interface Codex01445PreToolUseDependencies { resolveInstalledRoleName: typeof resolveInstalledRoleName; platform: NodeJS.Platform; }
const defaultDependencies: Codex01445PreToolUseDependencies = { resolveInstalledRoleName, platform: process.platform };
function readCommand(payload: Record<string, unknown>): string | undefined { if (payload.tool_name !== 'Bash' || !payload.tool_input || typeof payload.tool_input !== 'object' || Array.isArray(payload.tool_input)) return undefined; const command = (payload.tool_input as Record<string, unknown>).command; return typeof command === 'string' ? command : undefined; }
export function parseCodex01445AdaptedRoleIntentCommand(command: string, platform: NodeJS.Platform = process.platform): { role: string } | null { const placeholder = platform === 'win32' ? '"%CODEX_THREAD_ID%"' : '"$CODEX_THREAD_ID"'; const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const match = command.match(new RegExp(`^omx ralplan role-intent write --role ([A-Za-z0-9_-]{1,64}) --parent-thread ${escaped} --json$`)); return match?.[1] ? { role: match[1] } : null; }
export function evaluateCodex01445PreToolUse(payload: Record<string, unknown>, overrides: Partial<Codex01445PreToolUseDependencies> = {}): PreToolUseDenial | undefined { const command = readCommand(payload); if (!command) return undefined; const dependencies = { ...defaultDependencies, ...overrides }; const parsed = parseCodex01445AdaptedRoleIntentCommand(command, dependencies.platform); if (!parsed) return undefined; return dependencies.resolveInstalledRoleName(parsed.role) ? UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE : UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE; }

const MAX_BYTES = 128 * 1024;
const MAX_GENERATION_BYTES = 64 * 1024;
const MAX_GENERATIONS = 32;
const GENERATION_PREFIX = '.ralplan-neutralization-';
const COMMIT_SUFFIX = '.commit.json';
const GENERATION_VERSION = 1;
type OverlayKind = 'ralplan' | 'skill';
type FaultPoint = 'data-create' | 'data-write' | 'data-sync' | 'commit-create' | 'commit-write' | 'commit-sync' | 'directory-sync' | 'commit-final-write' | 'commit-final-sync';
/** @internal Test-only hooks; no CLI argument reaches these hooks. */
export const RALPLAN_NEUTRALIZE_TEST_SEAM: { fail?: (point: FaultPoint) => void | Promise<void>; random?: () => Buffer; directorySync?: () => void | Promise<void>; afterPin?: (directory: string) => void | Promise<void>; onError?: (error: unknown) => void; platform?: NodeJS.Platform } = {};

function regularSingleLink(stat: Awaited<ReturnType<typeof lstat>>, max = MAX_BYTES): boolean { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max; }
async function readPinned(path: string, max = MAX_BYTES): Promise<Buffer | null> { try { const before = await lstat(path); if (!regularSingleLink(before, max)) return null; const bytes = await readFile(path); const after = await lstat(path); return regularSingleLink(after, max) && before.dev === after.dev && before.ino === after.ino && before.size === after.size && bytes.length === before.size ? bytes : null; } catch { return null; } }
async function pinDirectory(directory: string): Promise<{ path: string; close: () => Promise<void> } | null> {
  const platform = RALPLAN_NEUTRALIZE_TEST_SEAM.platform ?? process.platform;
  const descriptorRoot = platform === 'linux' ? '/proc/self/fd' : platform === 'darwin' ? '/dev/fd' : null;
  if (!descriptorRoot) return null;
  try {
    const before = await lstat(directory);
    if (before.isSymbolicLink() || !before.isDirectory()) return null;
    const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const [opened, current] = await Promise.all([handle.stat(), lstat(directory)]);
    if (!current.isDirectory() || current.isSymbolicLink() || opened.dev !== before.dev || opened.ino !== before.ino || current.dev !== before.dev || current.ino !== before.ino) { await handle.close(); return null; }
    return { path: `${descriptorRoot}/${handle.fd}`, close: () => handle.close() };
  } catch { return null; }
}
function object(bytes: Buffer): Record<string, unknown> | null { try { const parsed = JSON.parse(bytes.toString('utf8')); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
function digest(ralplan: Buffer, skill: Buffer): string { return createHash('sha256').update('ralplan-state.json\0').update(ralplan).update('\0skill-active-state.json\0').update(skill).digest('hex'); }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function hasOnlyKeys(state: Record<string, unknown>, allowed: ReadonlySet<string>): boolean { return Object.keys(state).every((key) => allowed.has(key)); }
function isRalplanProducerKeyword(value: unknown): boolean {
  if (!isNonEmptyString(value)) return false;
  const keyword = value.trim();
  if (/^consensus plan$/iu.test(keyword)) return true;
  const match = /^\$(?:oh-my-codex:)?([a-z0-9_-]+)$/iu.exec(keyword);
  return match?.[1] !== undefined && getExplicitSkillDefinition(match[1])?.skill === 'ralplan';
}
const RALPLAN_KEYS = new Set(['active', 'mode', 'current_phase', 'started_at', 'updated_at', 'session_id', 'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id', 'tmux_pane_id', 'tmux_pane_set_at', 'tmux_window_id']);
const SKILL_KEYS = new Set(['version', 'active', 'skill', 'keyword', 'phase', 'activated_at', 'updated_at', 'source', 'session_id', 'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id', 'active_skills', 'initialized_mode', 'initialized_state_path']);
const ENTRY_KEYS = new Set(['skill', 'phase', 'active', 'activated_at', 'updated_at', 'session_id', 'owner_omx_session_id', 'owner_codex_session_id', 'thread_id', 'turn_id']);
function exactSession(value: unknown, sessionId: string): boolean { return typeof value === 'string' && value === sessionId; }
function correlatedOptional(states: readonly Record<string, unknown>[], key: string): boolean { const values = states.map((state) => state[key]); if (values.every((value) => value === undefined)) return true; return values.every(isNonEmptyString) && values.every((value) => value === values[0]); }
function isProducerTimestamp(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function routingOnlyRalplan(state: Record<string, unknown>, sessionId: string): boolean { return state.active === true && state.mode === 'ralplan' && state.current_phase === 'planning' && isProducerTimestamp(state.started_at) && isProducerTimestamp(state.updated_at) && exactSession(state.session_id, sessionId) && (!('owner_omx_session_id' in state) || exactSession(state.owner_omx_session_id, sessionId)) && ['owner_codex_session_id', 'thread_id', 'turn_id', 'tmux_pane_id', 'tmux_pane_set_at', 'tmux_window_id'].every((key) => !(key in state) || isNonEmptyString(state[key])) && hasOnlyKeys(state, RALPLAN_KEYS); }
function routingOnlySkill(state: Record<string, unknown>, sessionId: string): Record<string, unknown> | null {
  const expectedPath = `.omx/state/sessions/${sessionId}/ralplan-state.json`;
  const entries = Array.isArray(state.active_skills) ? state.active_skills : null;
  const topLevelValid = state.version === 1
    && state.active === true
    && state.skill === 'ralplan'
    && state.phase === 'planning'
    && isRalplanProducerKeyword(state.keyword)
    && state.source === 'keyword-detector'
    && state.initialized_mode === 'ralplan'
    && state.initialized_state_path === expectedPath
    && isProducerTimestamp(state.activated_at)
    && isProducerTimestamp(state.updated_at)
    && exactSession(state.session_id, sessionId)
    && (!('owner_omx_session_id' in state) || exactSession(state.owner_omx_session_id, sessionId))
    && ['owner_codex_session_id', 'thread_id', 'turn_id'].every((key) => !(key in state) || isNonEmptyString(state[key]))
    && entries !== null
    && entries.length === 1
    && hasOnlyKeys(state, SKILL_KEYS);
  if (!topLevelValid) return null;
  const entry = entries![0];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const item = entry as Record<string, unknown>;
  const entryValid = item.skill === 'ralplan'
    && item.active === true
    && item.phase === 'planning'
    && isProducerTimestamp(item.activated_at)
    && isProducerTimestamp(item.updated_at)
    && exactSession(item.session_id, sessionId)
    && (!('owner_omx_session_id' in item) || exactSession(item.owner_omx_session_id, sessionId))
    && ['owner_codex_session_id', 'thread_id', 'turn_id'].every((key) => !(key in item) || isNonEmptyString(item[key]))
    && hasOnlyKeys(item, ENTRY_KEYS);
  return entryValid ? item : null;
}
function routingOnlyPair(ralplan: Record<string, unknown>, skill: Record<string, unknown>, sessionId: string): boolean {
  const entry = routingOnlySkill(skill, sessionId);
  const modeValid = routingOnlyRalplan(ralplan, sessionId);
  const correlationValid = entry !== null
    && ['owner_codex_session_id', 'thread_id', 'turn_id'].every((key) => correlatedOptional([ralplan, skill, entry], key))
    && ralplan.started_at === skill.activated_at
    && skill.activated_at === entry.activated_at
    && ralplan.updated_at === skill.updated_at
    && skill.updated_at === entry.updated_at;
  if (!modeValid || !entry || !correlationValid) {
    RALPLAN_NEUTRALIZE_TEST_SEAM.onError?.(new Error(`pair validation failed: mode=${modeValid} skill=${entry !== null} correlation=${correlationValid}`));
  }
  return modeValid && entry !== null && correlationValid;
}
function neutralized(state: Record<string, unknown>, kind: OverlayKind): Record<string, unknown> { const next: Record<string, unknown> = { ...state, active: false, phase: 'cancelled', current_phase: 'cancelled' }; if (kind === 'skill' && Array.isArray(state.active_skills)) next.active_skills = state.active_skills.map((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry as Record<string, unknown>, active: false, phase: 'cancelled', current_phase: 'cancelled' } : entry); return next; }
function collectOwners(baseStateDir: string, sessionId: string): Set<string> { const owners = new Set([sessionId]); try { const pointerPath = join(baseStateDir, 'session.json'); if (realpathSync(pointerPath) !== pointerPath || !lstatSync(pointerPath).isFile()) return owners; const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as Record<string, unknown>; for (const key of ['session_id', 'native_session_id', 'codex_session_id', 'owner_omx_session_id', 'owner_codex_session_id']) { const value = normalizeSessionId(pointer[key]); if (value) owners.add(value); } } catch {} return owners; }
interface Generation { version: number; digest: string; canonical: { ralplan: { sha256: string; size: number }; skill: { sha256: string; size: number } }; }
function validGeneration(candidate: unknown, expectedDigest: string, ralplan: Buffer, skill: Buffer): candidate is Generation { if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false; const item = candidate as Partial<Generation>; const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex'); return item.version === GENERATION_VERSION && item.digest === expectedDigest && item.canonical?.ralplan?.sha256 === hash(ralplan) && item.canonical.ralplan.size === ralplan.length && item.canonical?.skill?.sha256 === hash(skill) && item.canonical.skill.size === skill.length; }
interface Commit { version: number; digest: string; dataFile: string; committed: boolean; }
function validCommit(candidate: unknown, expectedDigest: string, dataFile: string): candidate is Commit { if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false; const item = candidate as Partial<Commit>; return item.version === GENERATION_VERSION && item.digest === expectedDigest && item.dataFile === dataFile && item.committed === true; }
async function readGeneration(directory: string, expectedDigest: string, ralplan: Buffer, skill: Buffer): Promise<Generation | null> { const names = await readdir(directory).catch(() => [] as string[]); const prefix = `${GENERATION_PREFIX}${expectedDigest}-`; for (const commitName of names.filter((name) => name.startsWith(prefix) && name.endsWith(COMMIT_SUFFIX)).sort().slice(0, MAX_GENERATIONS)) { const token = commitName.slice(prefix.length, -COMMIT_SUFFIX.length); if (!/^[0-9a-f]{48}$/.test(token)) continue; const dataFile = `${prefix}${token}.json`; const commitBytes = await readPinned(join(directory, commitName), MAX_GENERATION_BYTES); if (!commitBytes || !validCommit(object(commitBytes), expectedDigest, dataFile)) continue; const dataBytes = await readPinned(join(directory, dataFile), MAX_GENERATION_BYTES); if (!dataBytes) continue; const parsed = object(dataBytes); if (validGeneration(parsed, expectedDigest, ralplan, skill)) return parsed; } return null; }
export async function readNeutralizedRoutingOverlay(path: string, kind: OverlayKind): Promise<Record<string, unknown> | null> { const directory = join(path, '..'); const sessionId = normalizeSessionId(basename(directory)); if (!sessionId || basename(join(directory, '..')) !== 'sessions') return null; const pinned = await pinDirectory(directory); if (!pinned) return null; try { const ralplanPath = kind === 'ralplan' ? join(pinned.path, 'ralplan-state.json') : join(pinned.path, 'ralplan-state.json'); const skillPath = kind === 'skill' ? join(pinned.path, 'skill-active-state.json') : join(pinned.path, 'skill-active-state.json'); const [ralplan, skill] = await Promise.all([readPinned(ralplanPath), readPinned(skillPath)]); if (!ralplan || !skill) return null; const canonicalRalplan = object(ralplan); const canonicalSkill = object(skill); if (!canonicalRalplan || !canonicalSkill || !routingOnlyPair(canonicalRalplan, canonicalSkill, sessionId)) return null; const generation = await readGeneration(pinned.path, digest(ralplan, skill), ralplan, skill); return generation ? neutralized(kind === 'ralplan' ? canonicalRalplan : canonicalSkill, kind) : null; } finally { await pinned.close(); } }
async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY); try { await RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync?.(); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('directory-sync'); await handle.sync(); } finally { await handle.close(); } }
export async function neutralizeOwnedRoutingRalplan(cwd: string): Promise<boolean> { try { const ownerSessionId = normalizeSessionId(process.env.OMX_SESSION_ID); if (!ownerSessionId) return false; const scope = await resolveWritableStateScope(cwd); if (scope.source !== 'session' || !scope.sessionId) return false; const sessionId = scope.sessionId; const base = getBaseStateDir(cwd); const pinned = await pinDirectory(scope.stateDir); if (!pinned) return false; try { await RALPLAN_NEUTRALIZE_TEST_SEAM.afterPin?.(scope.stateDir); const owners = collectOwners(base, sessionId); if (!owners.has(ownerSessionId)) return false; const [ralplanBytes, skillBytes] = await Promise.all([readPinned(join(pinned.path, 'ralplan-state.json')), readPinned(join(pinned.path, 'skill-active-state.json'))]); if (!ralplanBytes || !skillBytes) return false; const ralplan = object(ralplanBytes); const skill = object(skillBytes); if (!ralplan || !skill) return false; if (!routingOnlyPair(ralplan, skill, sessionId)) { RALPLAN_NEUTRALIZE_TEST_SEAM.onError?.(new Error('routing-only pair rejected')); return false; } const pairDigest = digest(ralplanBytes, skillBytes); const record: Generation = { version: GENERATION_VERSION, digest: pairDigest, canonical: { ralplan: { sha256: createHash('sha256').update(ralplanBytes).digest('hex'), size: ralplanBytes.length }, skill: { sha256: createHash('sha256').update(skillBytes).digest('hex'), size: skillBytes.length } } }; const bytes = Buffer.from(`${JSON.stringify(record)}\n`); const random = RALPLAN_NEUTRALIZE_TEST_SEAM.random ?? (() => randomBytes(24)); for (let attempt = 0; attempt < 4; attempt += 1) { const token = random().toString('hex'); if (!/^[0-9a-f]{48}$/.test(token)) return false; const dataFile = `${GENERATION_PREFIX}${pairDigest}-${token}.json`; const commitFile = `${GENERATION_PREFIX}${pairDigest}-${token}${COMMIT_SUFFIX}`; let dataHandle: Awaited<ReturnType<typeof open>> | undefined; let commitHandle: Awaited<ReturnType<typeof open>> | undefined; try { await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-create'); dataHandle = await open(join(pinned.path, dataFile), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-write'); await dataHandle.writeFile(bytes); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('data-sync'); await dataHandle.sync(); await dataHandle.close(); dataHandle = undefined; const pending = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: false } satisfies Commit)}\n`); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-create'); commitHandle = await open(join(pinned.path, commitFile), fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-write'); await commitHandle.writeFile(pending); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-sync'); await commitHandle.sync(); await syncDirectory(pinned.path); const committed = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: true } satisfies Commit)}\n`); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-final-write'); await commitHandle.write(committed, 0, committed.length, 0); await commitHandle.truncate(committed.length); await RALPLAN_NEUTRALIZE_TEST_SEAM.fail?.('commit-final-sync'); await commitHandle.sync(); await commitHandle.close(); return true; } catch (error) { RALPLAN_NEUTRALIZE_TEST_SEAM.onError?.(error); if (commitHandle) { try { const pending = Buffer.from(`${JSON.stringify({ version: GENERATION_VERSION, digest: pairDigest, dataFile, committed: false } satisfies Commit)}\n`); await commitHandle.write(pending, 0, pending.length, 0); await commitHandle.truncate(pending.length); await commitHandle.sync(); } catch {} } await dataHandle?.close().catch(() => {}); await commitHandle?.close().catch(() => {}); if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; return false; } } return false; } finally { await pinned.close(); } } catch (error) { RALPLAN_NEUTRALIZE_TEST_SEAM.onError?.(error); return false; } }
