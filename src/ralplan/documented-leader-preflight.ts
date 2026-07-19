import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { join, relative } from 'node:path';
import type { ResolvedRuntimeStateScope } from '../mcp/state-paths.js';
import { withCrossProcessFileLockSync } from '../subagents/tracker.js';
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

const MAX_PREFLIGHT_SEED_BYTES = 16 * 1024;
const SKILL_SEED_KEYS = new Set(['version', 'active', 'skill', 'keyword', 'phase', 'activated_at', 'updated_at', 'source', 'session_id', 'thread_id', 'turn_id', 'owner_codex_session_id', 'initialized_mode', 'initialized_state_path', 'active_skills']);
const SKILL_ENTRY_SEED_KEYS = new Set(['skill', 'phase', 'active', 'activated_at', 'updated_at', 'session_id', 'thread_id', 'turn_id', 'owner_codex_session_id']);

const MODE_SEED_KEYS = new Set(['active', 'mode', 'current_phase', 'started_at', 'updated_at', 'session_id', 'thread_id', 'turn_id', 'owner_codex_session_id']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRegularBoundedFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= MAX_PREFLIGHT_SEED_BYTES;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function matchesCurrentSession(value: Record<string, unknown>, sessionId: string): boolean {
  return ['session_id', 'owner_codex_session_id'].every((key) => value[key] === undefined || value[key] === sessionId);
}

function matchingOptionalIdentity(skill: Record<string, unknown>, mode: Record<string, unknown>, activeSkill: Record<string, unknown>): boolean {
  return ['thread_id', 'turn_id'].every((key) => {
    const values = [skill[key], mode[key], activeSkill[key]].filter((value) => value !== undefined);
    return values.every((value) => typeof value === 'string') && new Set(values).size <= 1;
  });
}


/** Neutralize only an untouched current keyword-detector Ralplan routing seed. */
export function neutralizeKeywordSeededRalplanState(scope: ResolvedRuntimeStateScope): void {
  const sessionId = scope.sessionId?.trim();
  if (!sessionId || !scope.isSessionScoped || scope.metadata?.sessionId !== sessionId) return;
  const skillPath = join(scope.stateDir, 'skill-active-state.json');
  const modePath = join(scope.stateDir, 'ralplan-state.json');
  const initializedPath = relative(scope.cwd, modePath).replace(/\\/g, '/');
  if (!isRegularBoundedFile(skillPath) || !isRegularBoundedFile(modePath)) return;

  withCrossProcessFileLockSync(skillPath, () => {
    if (!isRegularBoundedFile(skillPath) || !isRegularBoundedFile(modePath)) return;
    let skill: Record<string, unknown>;
    let mode: Record<string, unknown>;
    let skillRaw: string;
    let modeRaw: string;
    try {
      skillRaw = readFileSync(skillPath, 'utf8');
      modeRaw = readFileSync(modePath, 'utf8');
      skill = JSON.parse(skillRaw) as Record<string, unknown>;
      mode = JSON.parse(modeRaw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!isPlainRecord(skill) || !isPlainRecord(mode) || !hasOnlyKeys(skill, SKILL_SEED_KEYS) || !hasOnlyKeys(mode, MODE_SEED_KEYS)) return;
    const activeSkills = skill.active_skills;
    if (!Array.isArray(activeSkills) || activeSkills.length !== 1 || !isPlainRecord(activeSkills[0]) || !hasOnlyKeys(activeSkills[0], SKILL_ENTRY_SEED_KEYS)) return;
    const activeSkill = activeSkills[0];
    if (
      skill.active !== true || skill.skill !== 'ralplan' || skill.phase !== 'planning' || skill.source !== 'keyword-detector'
      || skill.initialized_mode !== 'ralplan' || skill.initialized_state_path !== initializedPath
      || activeSkill.skill !== 'ralplan' || activeSkill.phase !== 'planning' || activeSkill.active !== true || activeSkill.session_id !== sessionId
      || !matchesCurrentSession(skill, sessionId) || !matchesCurrentSession(mode, sessionId) || !matchingOptionalIdentity(skill, mode, activeSkill)
      || mode.mode !== 'ralplan' || mode.active !== true || mode.current_phase !== 'planning'
    ) return;
    const now = new Date().toISOString();
    const nextSkill = { ...skill, active: false, phase: 'blocked', updated_at: now, active_skills: [{ ...activeSkill, active: false, phase: 'blocked', updated_at: now }] };
    const nextMode = { ...mode, active: false, current_phase: 'blocked', updated_at: now };
    const skillTemporaryPath = `${skillPath}.${process.pid}.preflight.tmp`;
    const modeTemporaryPath = `${modePath}.${process.pid}.preflight.tmp`;
    try {
      writeFileSync(skillTemporaryPath, `${JSON.stringify(nextSkill, null, 2)}\n`, { flag: 'wx' });
      writeFileSync(modeTemporaryPath, `${JSON.stringify(nextMode, null, 2)}\n`, { flag: 'wx' });
      renameSync(modeTemporaryPath, modePath);
      try {
        renameSync(skillTemporaryPath, skillPath);
      } catch (error) {
        const rollbackPath = `${modePath}.${process.pid}.preflight.rollback.tmp`;
        writeFileSync(rollbackPath, modeRaw, { flag: 'wx' });
        renameSync(rollbackPath, modePath);
        throw error;
      }
    } finally {
      for (const path of [skillTemporaryPath, modeTemporaryPath]) {
        try { unlinkSync(path); } catch { /* temporary file was never created or already published */ }
      }
    }
  });
}
