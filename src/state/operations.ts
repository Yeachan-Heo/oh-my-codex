import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withModeRuntimeContext } from './mode-state-context.js';
import {
  getAllScopedStatePaths,
  getAuthoritativeActiveStateDirs,
  getReadScopedStateDirs,
  getReadScopedStatePaths,
  getStateDir,
  getStatePath,
  resolveStateScope,
  resolveWorkingDirectoryForState,
  validateSessionId,
  validateStateModeSegment,
} from '../mcp/state-paths.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import { RALPH_PHASES, validateAndNormalizeRalphState } from '../ralph/contract.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import {
  SKILL_ACTIVE_STATE_MODE,
  readSkillActiveState,
  syncCanonicalSkillStateForMode,
  writeSkillActiveStateCopies,
} from './skill-active.js';
import { isTrackedWorkflowMode } from './workflow-transition.js';
import { reconcileWorkflowTransition } from './workflow-transition-reconcile.js';

export const SUPPORTED_STATE_READ_MODES = [
  'autopilot',
  'autoresearch',
  'team',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'deep-interview',
  'skill-active',
] as const;

export type SupportedStateReadMode = (typeof SUPPORTED_STATE_READ_MODES)[number];
export type StateOperationName =
  | 'state_read'
  | 'state_write'
  | 'state_clear'
  | 'state_list_active'
  | 'state_get_status';

export interface StateOperationResponse {
  payload: unknown;
  isError?: boolean;
}

const stateWriteQueues = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const tail = stateWriteQueues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = tail.finally(() => gate);
  stateWriteQueues.set(path, queued);

  await tail.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (stateWriteQueues.get(path) === queued) {
      stateWriteQueues.delete(path);
    }
  }
}

async function writeAtomicFile(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

async function writeClearedSessionScopedModeState(
  path: string,
  mode: string,
  sessionId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const clearedState = withModeRuntimeContext({}, {
    mode,
    active: false,
    current_phase: 'cleared',
    updated_at: nowIso,
    completed_at: nowIso,
    session_id: sessionId,
  });
  await writeAtomicFile(path, JSON.stringify(clearedState, null, 2));
}

function readModeSupportsStrictValidation(mode: string): mode is SupportedStateReadMode {
  return SUPPORTED_STATE_READ_MODES.includes(mode as SupportedStateReadMode);
}

function validateStrictReadableMode(mode: unknown): string {
  const normalized = validateStateModeSegment(mode);
  if (!readModeSupportsStrictValidation(normalized)) {
    throw new Error(`mode must be one of: ${SUPPORTED_STATE_READ_MODES.join(', ')}`);
  }
  return normalized;
}

async function initializeStateEnvironment(cwd: string, effectiveSessionId?: string): Promise<void> {
  await mkdir(getStateDir(cwd), { recursive: true });
  if (effectiveSessionId) {
    await mkdir(getStateDir(cwd, effectiveSessionId), { recursive: true });
  }
  const { ensureTmuxHookInitialized } = await import('../cli/tmux-hook.js');
  await ensureTmuxHookInitialized(cwd);
}

async function listStateSessionIds(cwd: string): Promise<string[]> {
  const sessionsDir = join(getStateDir(cwd), 'sessions');
  if (!existsSync(sessionsDir)) return [];
  const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((entry) => entry.trim().length > 0);
}

function hasExplicitStateField(
  fields: Record<string, unknown>,
  customState: unknown,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(fields, key)
    || (
      customState != null
      && Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, key)
    );
}

export async function listStateStatuses(
  cwd: string,
  explicitSessionId?: string,
  mode?: string,
  options: { authoritativeActiveDecision?: boolean } = {},
): Promise<Record<string, unknown>> {
  const stateDirs = options.authoritativeActiveDecision
    ? await getAuthoritativeActiveStateDirs(cwd, explicitSessionId)
    : await getReadScopedStateDirs(cwd, explicitSessionId);
  const statuses: Record<string, unknown> = {};
  const seenModes = new Set<string>();

  for (const stateDir of stateDirs) {
    if (!existsSync(stateDir)) continue;
    const files = await readdir(stateDir);
    for (const file of files) {
      if (!file.endsWith('-state.json')) continue;
      const currentMode = file.replace('-state.json', '');
      if (!mode && currentMode === SKILL_ACTIVE_STATE_MODE) continue;
      if (mode && currentMode !== mode) continue;
      if (seenModes.has(currentMode)) continue;
      seenModes.add(currentMode);
      try {
        const data = JSON.parse(await readFile(join(stateDir, file), 'utf-8'));
        statuses[currentMode] = {
          active: data.active,
          phase: data.current_phase,
          path: join(stateDir, file),
          data,
        };
      } catch {
        statuses[currentMode] = { error: 'malformed state file' };
      }
    }
  }

  return statuses;
}


export async function listActiveStateModes(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<string[]> {
  const cwd = resolveWorkingDirectoryForState(workingDirectory);
  const sessionId = validateSessionId(explicitSessionId);
  const statuses = await listStateStatuses(cwd, sessionId, undefined, {
    authoritativeActiveDecision: true,
  });
  return Object.entries(statuses)
    .filter(([, status]) => Boolean((status as { active?: unknown }).active))
    .map(([mode]) => mode);
}

export async function executeStateOperation(
  name: StateOperationName,
  rawArgs: Record<string, unknown> = {},
): Promise<StateOperationResponse> {
  let cwd: string;
  let explicitSessionId: string | undefined;

  try {
    cwd = resolveWorkingDirectoryForState(rawArgs.workingDirectory as string | undefined);
    explicitSessionId = validateSessionId(rawArgs.session_id);
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }

  try {
    switch (name) {
      case 'state_read': {
        const mode = validateStrictReadableMode(rawArgs.mode);
        const paths = await getReadScopedStatePaths(mode, cwd, explicitSessionId);
        const path = paths.find((candidate) => existsSync(candidate));
        if (!path) {
          return { payload: { exists: false, mode } };
        }
        const data = JSON.parse(await readFile(path, 'utf-8'));
        return { payload: data };
      }

      case 'state_write': {
        const stateScope = await resolveStateScope(cwd, explicitSessionId);
        const effectiveSessionId = stateScope.sessionId;
        await initializeStateEnvironment(cwd, effectiveSessionId);

        const mode = validateStateModeSegment(rawArgs.mode);
        const path = getStatePath(mode, cwd, effectiveSessionId);
        const {
          mode: _mode,
          workingDirectory: _workingDirectory,
          session_id: _sessionId,
          state: customState,
          ...fields
        } = rawArgs;
        let validationError: string | null = null;
        let transitionMessage: string | undefined;
        let ensureRalphArtifacts = false;

        await withStateWriteLock(path, async () => {
          let existing: Record<string, unknown> = {};
          if (existsSync(path)) {
            try {
              existing = JSON.parse(await readFile(path, 'utf-8'));
            } catch (error) {
              process.stderr.write(`[state] Failed to parse state file: ${error}\n`);
            }
          }

          const mergedRaw = {
            ...existing,
            ...fields,
            ...((customState as Record<string, unknown>) || {}),
          } as Record<string, unknown>;
          if (!hasExplicitStateField(fields, customState, 'run_outcome')) {
            delete mergedRaw.run_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'lifecycle_outcome')) {
            delete mergedRaw.lifecycle_outcome;
          }
          if (!hasExplicitStateField(fields, customState, 'terminal_outcome')) {
            delete mergedRaw.terminal_outcome;
          }

          if (
            mode === 'ralph' &&
            effectiveSessionId &&
            typeof mergedRaw.owner_omx_session_id !== 'string'
          ) {
            mergedRaw.owner_omx_session_id = effectiveSessionId;
          }

          if (mode === 'ralph') {
            const originalPhase = mergedRaw.current_phase;
            const validation = validateAndNormalizeRalphState(mergedRaw);
            if (!validation.ok || !validation.state) {
              validationError = validation.error || `ralph.current_phase must be one of: ${RALPH_PHASES.join(', ')}`;
              return;
            }
            if (
              typeof originalPhase === 'string' &&
              typeof validation.state.current_phase === 'string' &&
              validation.state.current_phase !== originalPhase
            ) {
              validation.state.ralph_phase_normalized_from = originalPhase;
            }
            Object.assign(mergedRaw, validation.state);
            ensureRalphArtifacts = true;
          }

          if (mode !== SKILL_ACTIVE_STATE_MODE) {
            const runOutcomeValidation = applyRunOutcomeContract(mergedRaw);
            if (!runOutcomeValidation.ok || !runOutcomeValidation.state) {
              validationError = runOutcomeValidation.error || 'Invalid run outcome state';
              return;
            }
            Object.assign(mergedRaw, runOutcomeValidation.state);
          }

          if (isTrackedWorkflowMode(mode) && mergedRaw.active === true) {
            try {
              if (!effectiveSessionId) {
                for (const sessionId of await listStateSessionIds(cwd)) {
                  const sessionTransition = await reconcileWorkflowTransition(cwd, mode, {
                    action: 'write',
                    sessionId,
                    source: 'state-operations',
                  });
                  transitionMessage ??= sessionTransition.transitionMessage;
                }
              }

              const transition = await reconcileWorkflowTransition(cwd, mode, {
                action: 'write',
                sessionId: effectiveSessionId,
                source: 'state-operations',
              });
              transitionMessage ??= transition.transitionMessage;
            } catch (error) {
              validationError = (error as Error).message;
              return;
            }
          }

          const merged = withModeRuntimeContext(existing, mergedRaw);
          await writeAtomicFile(path, JSON.stringify(merged, null, 2));
        });

        if (validationError) {
          return {
            payload: { error: validationError },
            isError: true,
          };
        }

        if (mode === SKILL_ACTIVE_STATE_MODE) {
          const state = await readSkillActiveState(path);
          if (state) {
            await writeSkillActiveStateCopies(cwd, state, effectiveSessionId);
          }
        } else {
          if (mode === 'ralph' && ensureRalphArtifacts) {
            await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId);
          }
          const data = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
          await syncCanonicalSkillStateForMode({
            cwd,
            mode,
            active: data.active === true,
            currentPhase: typeof data.current_phase === 'string' ? data.current_phase : undefined,
            sessionId: effectiveSessionId,
            source: 'state-operations',
          });
        }

        return {
          payload: {
            success: true,
            mode,
            path,
            ...(transitionMessage ? { transition: transitionMessage } : {}),
          },
        };
      }

      case 'state_clear': {
        const stateScope = await resolveStateScope(cwd, explicitSessionId);
        const effectiveSessionId = stateScope.sessionId;
        await initializeStateEnvironment(cwd, effectiveSessionId);

        const mode = validateStateModeSegment(rawArgs.mode);
        const allSessions = rawArgs.all_sessions === true;

        if (!allSessions) {
          const path = getStatePath(mode, cwd, effectiveSessionId);
          if (
            mode !== SKILL_ACTIVE_STATE_MODE
            && effectiveSessionId
            && existsSync(getStatePath(mode, cwd))
          ) {
            await writeClearedSessionScopedModeState(path, mode, effectiveSessionId);
          } else if (existsSync(path)) {
            await unlink(path);
          }
          if (mode !== SKILL_ACTIVE_STATE_MODE) {
            await syncCanonicalSkillStateForMode({
              cwd,
              mode,
              active: false,
              sessionId: effectiveSessionId,
              source: 'state-operations',
            });
          }
          return { payload: { cleared: true, mode, path } };
        }

        const removedPaths: string[] = [];
        const paths = await getAllScopedStatePaths(mode, cwd);
        for (const path of paths) {
          if (!existsSync(path)) continue;
          await unlink(path);
          removedPaths.push(path);
        }
        if (mode !== SKILL_ACTIVE_STATE_MODE) {
          await syncCanonicalSkillStateForMode({
            cwd,
            mode,
            active: false,
            source: 'state-operations',
          });
        }

        return {
          payload: {
            cleared: true,
            mode,
            all_sessions: true,
            removed: removedPaths.length,
            paths: removedPaths,
            warning: 'all_sessions clears global and session-scoped state files',
          },
        };
      }

      case 'state_list_active': {
        const activeModes = await listActiveStateModes(cwd, explicitSessionId);
        return { payload: { active_modes: activeModes } };
      }

      case 'state_get_status': {
        const mode = typeof rawArgs.mode === 'string' ? rawArgs.mode.trim() : undefined;
        const statuses = await listStateStatuses(cwd, explicitSessionId, mode || undefined);
        return { payload: { statuses } };
      }
    }
  } catch (error) {
    return {
      payload: { error: (error as Error).message },
      isError: true,
    };
  }
}
