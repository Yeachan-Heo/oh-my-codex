import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getBaseStateDir, getStateDir, validateSessionId, validateStateModeSegment } from '../mcp/state-paths.js';

export type WorkflowOwnerSnapshotSource = 'session' | 'root' | 'compatibility' | 'none';
export type WorkflowOwnerMatch = boolean | 'ambiguous';

export interface WorkflowOwnerSnapshot {
  mode: string;
  active: boolean;
  terminal: boolean;
  source: WorkflowOwnerSnapshotSource;
  reason: string;
  statePath: string;
  state: Record<string, unknown> | null;
  ownerOmxSessionId?: string;
  ownerCodexSessionId?: string;
  currentOmxSessionId?: string;
  currentCodexSessionId?: string;
  ownerMatches: WorkflowOwnerMatch;
  blockingReason?: string;
  sourcePaths: string[];
}

export interface ResolveWorkflowOwnerSnapshotOptions {
  cwd: string;
  mode: string;
  currentOmxSessionId?: string;
  currentCodexSessionId?: string;
  terminalPhases?: Iterable<string>;
  includeCompatibility?: boolean;
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeSessionId(value: string | undefined): string {
  const trimmed = safeString(value);
  if (!trimmed) return '';
  try {
    return validateSessionId(trimmed) ?? '';
  } catch {
    return '';
  }
}

function isTerminalState(state: Record<string, unknown>, terminalPhases: Set<string>): boolean {
  if (state.active !== true) return true;
  if (safeString(state.completed_at)) return true;
  const phase = safeString(state.current_phase).toLowerCase();
  return phase !== '' && terminalPhases.has(phase);
}

function resolveOwnerMatches(args: {
  source: WorkflowOwnerSnapshotSource;
  state: Record<string, unknown>;
  currentOmxSessionId: string;
  currentCodexSessionId: string;
}): {
  ownerMatches: WorkflowOwnerMatch;
  ownerOmxSessionId?: string;
  ownerCodexSessionId?: string;
  blockingReason?: string;
} {
  const ownerOmxSessionId = safeString(args.state.owner_omx_session_id)
    || safeString(args.state.omx_session_id)
    || safeString(args.state.session_id);
  const ownerCodexSessionId = safeString(args.state.owner_codex_session_id)
    || safeString(args.state.codex_session_id)
    || safeString(args.state.native_session_id);

  if (ownerOmxSessionId && args.currentOmxSessionId) {
    return {
      ownerMatches: ownerOmxSessionId === args.currentOmxSessionId,
      ownerOmxSessionId,
      ownerCodexSessionId: ownerCodexSessionId || undefined,
      blockingReason: ownerOmxSessionId === args.currentOmxSessionId ? undefined : 'owner_omx_session_mismatch',
    };
  }

  if (args.source === 'session' && args.currentOmxSessionId) {
    return {
      ownerMatches: true,
      ownerOmxSessionId: ownerOmxSessionId || undefined,
      ownerCodexSessionId: ownerCodexSessionId || undefined,
    };
  }

  if (ownerCodexSessionId && args.currentCodexSessionId) {
    return {
      ownerMatches: ownerCodexSessionId === args.currentCodexSessionId,
      ownerOmxSessionId: ownerOmxSessionId || undefined,
      ownerCodexSessionId,
      blockingReason: ownerCodexSessionId === args.currentCodexSessionId ? undefined : 'owner_codex_session_mismatch',
    };
  }

  if ((ownerOmxSessionId && !args.currentOmxSessionId) || (ownerCodexSessionId && !args.currentCodexSessionId)) {
    return {
      ownerMatches: 'ambiguous',
      ownerOmxSessionId: ownerOmxSessionId || undefined,
      ownerCodexSessionId: ownerCodexSessionId || undefined,
      blockingReason: 'owner_present_current_session_missing',
    };
  }

  if (!args.currentOmxSessionId && !args.currentCodexSessionId) {
    return { ownerMatches: true };
  }

  return { ownerMatches: 'ambiguous', blockingReason: 'owner_missing_current_session_present' };
}

function buildInactiveSnapshot(args: {
  mode: string;
  reason: string;
  source: WorkflowOwnerSnapshotSource;
  statePath?: string;
  state?: Record<string, unknown> | null;
  currentOmxSessionId: string;
  currentCodexSessionId: string;
  sourcePaths: string[];
  ownerMatches?: WorkflowOwnerMatch;
  blockingReason?: string;
  terminal?: boolean;
}): WorkflowOwnerSnapshot {
  return {
    mode: args.mode,
    active: false,
    terminal: args.terminal ?? false,
    source: args.source,
    reason: args.reason,
    statePath: args.statePath ?? '',
    state: args.state ?? null,
    currentOmxSessionId: args.currentOmxSessionId || undefined,
    currentCodexSessionId: args.currentCodexSessionId || undefined,
    ownerMatches: args.ownerMatches ?? false,
    blockingReason: args.blockingReason,
    sourcePaths: args.sourcePaths,
  };
}

function readCompatibilityEntry(skillActive: Record<string, unknown> | null, mode: string): Record<string, unknown> | null {
  if (!skillActive) return null;
  const entries = Array.isArray(skillActive.active_skills) ? skillActive.active_skills : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (safeString(candidate.skill) === mode && candidate.active !== false) return candidate;
  }
  if (safeString(skillActive.skill) === mode && skillActive.active !== false) return skillActive;
  return null;
}

export async function resolveWorkflowOwnerSnapshot(
  options: ResolveWorkflowOwnerSnapshotOptions,
): Promise<WorkflowOwnerSnapshot> {
  const mode = validateStateModeSegment(options.mode);
  const currentOmxSessionId = normalizeSessionId(options.currentOmxSessionId);
  const currentCodexSessionId = safeString(options.currentCodexSessionId);
  const terminalPhases = new Set([...(options.terminalPhases ?? [])].map((phase) => safeString(phase).toLowerCase()).filter(Boolean));
  const baseStateDir = getBaseStateDir(options.cwd);
  const canonicalPaths: Array<{ source: 'session' | 'root'; path: string }> = [];
  const sourcePaths: string[] = [];

  if (currentOmxSessionId) {
    canonicalPaths.push({ source: 'session', path: join(getStateDir(options.cwd, currentOmxSessionId), `${mode}-state.json`) });
  } else {
    canonicalPaths.push({ source: 'root', path: join(baseStateDir, `${mode}-state.json`) });
  }

  for (const candidate of canonicalPaths) {
    sourcePaths.push(candidate.path);
    const state = await readJsonIfExists(candidate.path);
    if (!state) continue;
    const owner = resolveOwnerMatches({ source: candidate.source, state, currentOmxSessionId, currentCodexSessionId });
    const terminal = isTerminalState(state, terminalPhases);
    if (terminal) {
      return {
        mode,
        active: false,
        terminal: true,
        source: candidate.source,
        reason: 'terminal',
        statePath: candidate.path,
        state,
        ownerOmxSessionId: owner.ownerOmxSessionId,
        ownerCodexSessionId: owner.ownerCodexSessionId,
        currentOmxSessionId: currentOmxSessionId || undefined,
        currentCodexSessionId: currentCodexSessionId || undefined,
        ownerMatches: owner.ownerMatches,
        blockingReason: owner.blockingReason,
        sourcePaths,
      };
    }
    if (owner.ownerMatches !== true) {
      return {
        mode,
        active: false,
        terminal: false,
        source: candidate.source,
        reason: owner.ownerMatches === 'ambiguous' ? 'owner_ambiguous' : 'owner_mismatch',
        statePath: candidate.path,
        state,
        ownerOmxSessionId: owner.ownerOmxSessionId,
        ownerCodexSessionId: owner.ownerCodexSessionId,
        currentOmxSessionId: currentOmxSessionId || undefined,
        currentCodexSessionId: currentCodexSessionId || undefined,
        ownerMatches: owner.ownerMatches,
        blockingReason: owner.blockingReason,
        sourcePaths,
      };
    }
    return {
      mode,
      active: true,
      terminal: false,
      source: candidate.source,
      reason: 'active',
      statePath: candidate.path,
      state,
      ownerOmxSessionId: owner.ownerOmxSessionId,
      ownerCodexSessionId: owner.ownerCodexSessionId,
      currentOmxSessionId: currentOmxSessionId || undefined,
      currentCodexSessionId: currentCodexSessionId || undefined,
      ownerMatches: true,
      sourcePaths,
    };
  }

  if (currentOmxSessionId) {
    return buildInactiveSnapshot({
      mode,
      reason: 'blocked_by_current_session',
      source: 'none',
      currentOmxSessionId,
      currentCodexSessionId,
      sourcePaths,
      blockingReason: 'session_scoped_state_missing',
    });
  }

  if (options.includeCompatibility === true) {
    const compatibilityPath = join(baseStateDir, 'skill-active-state.json');
    sourcePaths.push(compatibilityPath);
    const entry = readCompatibilityEntry(await readJsonIfExists(compatibilityPath), mode);
    if (entry) {
      return {
        mode,
        active: true,
        terminal: false,
        source: 'compatibility',
        reason: 'compatibility_active',
        statePath: compatibilityPath,
        state: entry,
        currentOmxSessionId: currentOmxSessionId || undefined,
        currentCodexSessionId: currentCodexSessionId || undefined,
        ownerMatches: true,
        sourcePaths,
      };
    }
  }

  return buildInactiveSnapshot({
    mode,
    reason: 'cleared',
    source: 'none',
    currentOmxSessionId,
    currentCodexSessionId,
    sourcePaths,
  });
}
