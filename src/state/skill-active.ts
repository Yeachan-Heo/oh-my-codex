import { existsSync } from 'fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { omxStateDir } from '../utils/paths.js';
import {
  assertWorkflowTransitionAllowed,
  isTrackedWorkflowMode,
  pickPrimaryWorkflowMode,
} from './workflow-transition.js';

export const SKILL_ACTIVE_STATE_MODE = 'skill-active';
export const SKILL_ACTIVE_STATE_FILE = `${SKILL_ACTIVE_STATE_MODE}-state.json`;

export const CANONICAL_WORKFLOW_SKILLS = [
  'autopilot',
  'autoresearch',
  'team',
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
  initialized_mode?: string;
  initialized_state_path?: string;
  input_lock?: unknown;
  active_skills?: SkillActiveEntry[];
  [key: string]: unknown;
}

export interface SyncCanonicalSkillStateOptions {
  cwd: string;
  mode: string;
  active: boolean;
  currentPhase?: string;
  sessionId?: string;
  threadId?: string;
  turnId?: string;
  nowIso?: string;
  source?: string;
  allSessions?: boolean;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function entryKey(entry: Pick<SkillActiveEntry, 'skill' | 'session_id'>): string {
  return `${entry.skill}::${safeString(entry.session_id).trim()}`;
}

function filterRootEntriesForSession(entries: SkillActiveEntry[], sessionId?: string): SkillActiveEntry[] {
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
  const inheritedKeys = new Set(filterRootEntriesForSession(rootEntries, sessionId).map(entryKey));
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

function sanitizeInheritedSkillActiveBase(
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

export function listActiveSkills(raw: unknown): SkillActiveEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  const state = raw as SkillActiveStateLike;
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
    };
    deduped.set(entryKey(topLevelEntry), topLevelEntry);
  }

  return [...deduped.values()];
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
    active_skills: activeSkills.length > 0 ? activeSkills : undefined,
  };
}

export function getSkillActiveStatePaths(cwd: string, sessionId?: string): {
  rootPath: string;
  sessionPath?: string;
} {
  const rootPath = join(omxStateDir(cwd), SKILL_ACTIVE_STATE_FILE);
  const normalizedSession = safeString(sessionId).trim();
  if (!normalizedSession) return { rootPath };
  return {
    rootPath,
    sessionPath: join(omxStateDir(cwd), 'sessions', normalizedSession, SKILL_ACTIVE_STATE_FILE),
  };
}

export async function readSkillActiveState(path: string): Promise<SkillActiveStateLike | null> {
  try {
    return normalizeSkillActiveState(JSON.parse(await readFile(path, 'utf-8')));
  } catch {
    return null;
  }
}

export async function writeSkillActiveStateCopies(
  cwd: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike | null,
): Promise<void> {
  const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
  const normalized = { version: 1, ...state };
  const normalizedRoot = rootState === null
    ? null
    : { version: 1, ...(rootState ?? normalized) };
  if (normalizedRoot !== null) {
    const rootPayload = JSON.stringify(normalizedRoot, null, 2);
    await mkdir(dirname(rootPath), { recursive: true });
    await writeFile(rootPath, rootPayload);
  }

  if (sessionPath) {
    const sessionPayload = JSON.stringify(normalized, null, 2);
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, sessionPayload);
  }
}

export async function readVisibleSkillActiveState(cwd: string, sessionId?: string): Promise<SkillActiveStateLike | null> {
  const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
  if (sessionPath && existsSync(sessionPath)) {
    return readSkillActiveState(sessionPath);
  }
  if (sessionPath) return null;
  if (!existsSync(rootPath)) return null;
  return readSkillActiveState(rootPath);
}

export function tracksCanonicalWorkflowSkill(mode: string): mode is CanonicalWorkflowSkill {
  return (CANONICAL_WORKFLOW_SKILLS as readonly string[]).includes(mode);
}

export async function syncCanonicalSkillStateForMode(options: SyncCanonicalSkillStateOptions): Promise<void> {
  const {
    cwd,
    mode,
    active,
    currentPhase,
    sessionId,
    threadId,
    turnId,
    nowIso = new Date().toISOString(),
    source = 'state-server',
    allSessions = false,
  } = options;

  if (!tracksCanonicalWorkflowSkill(mode)) return;

  const { rootPath, sessionPath } = getSkillActiveStatePaths(cwd, sessionId);
  const existingRoot = await readSkillActiveState(rootPath);
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
  const visibleEntries = normalizedSessionId
    ? [...rootEntries, ...sessionOnlyEntries]
    : rootEntries.filter((entry) => safeString(entry.session_id).trim().length === 0);

  if (active && isTrackedWorkflowMode(mode)) {
    const currentWorkflowModes = visibleEntries
      .map((entry) => entry.skill)
      .filter(isTrackedWorkflowMode);
    assertWorkflowTransitionAllowed(currentWorkflowModes, mode, 'write');
  }

  const applyEntriesToState = (
    base: SkillActiveStateLike | null,
    entries: SkillActiveEntry[],
    fallbackMode: string,
    targetSessionId?: string,
  ): SkillActiveStateLike => {
    const inheritedBase = sanitizeInheritedSkillActiveBase(base, targetSessionId);
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
    await writeSkillActiveStateCopies(cwd, nextSessionState, sessionId, nextRootState);
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
    });
  }
  const nextRootEntries = allSessions
    ? rootEntries.filter((entry) => entry.skill !== mode)
    : [...sessionScopedRootMirrorEntries, ...nextRootScopedEntries];

  const nextRootState = applyEntriesToState(existingRoot, nextRootEntries, mode);
  await writeSkillActiveStateCopies(cwd, nextRootState, undefined, nextRootState);

  const sessionsDir = join(omxStateDir(cwd), 'sessions');
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
      await unlink(sessionPath).catch(() => {});
      continue;
    }

    const nextSessionState = applyEntriesToState(
      existingSessionState ?? existingRoot,
      nextSessionEntries,
      nextSessionEntries[0]?.skill || mode,
      sessionId,
    );
    await writeSkillActiveStateCopies(cwd, nextSessionState, sessionId, nextRootState);
  }
}
