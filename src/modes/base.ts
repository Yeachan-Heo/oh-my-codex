/**
 * Base mode lifecycle management for oh-my-codex
 * All execution modes (autopilot, ralph, ultrawork, team, ultraqa, ralplan) share this base.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { withModeRuntimeContext } from '../state/mode-state-context.js';
import { validateAndNormalizeRalphState } from '../ralph/contract.js';

export interface ModeState {
  active: boolean;
  mode: string;
  iteration: number;
  max_iterations: number;
  current_phase: string;
  task_description?: string;
  started_at: string;
  completed_at?: string;
  last_turn_at?: string;
  error?: string;
  [key: string]: unknown;
}

export type ModeName = 'autopilot' | 'ralph' | 'ultrawork' | 'team' | 'ultraqa' | 'ralplan';

/** @deprecated These mode names were removed in v4.6. Use the canonical modes instead. */
export type DeprecatedModeName = 'ultrapilot' | 'pipeline' | 'ecomode';

const DEPRECATED_MODES: Record<DeprecatedModeName, string> = {
  ultrapilot: 'Use "team" instead. ultrapilot has been merged into team mode.',
  pipeline: 'Use "team" instead. pipeline has been merged into team mode.',
  ecomode: 'Use "ultrawork" instead. ecomode has been merged into ultrawork mode.',
};

/**
 * Check if a mode name is deprecated and return a warning message if so.
 * Returns null if the mode is not deprecated.
 */
export function getDeprecationWarning(mode: string): string | null {
  const warning = DEPRECATED_MODES[mode as DeprecatedModeName];
  if (!warning) return null;
  return `[DEPRECATED] Mode "${mode}" is deprecated. ${warning}`;
}

const EXCLUSIVE_MODES: ModeName[] = ['autopilot', 'ralph', 'ultrawork'];

function normalizeRalphModeStateOrThrow(state: ModeState): ModeState {
  const originalPhase = state.current_phase;
  const validation = validateAndNormalizeRalphState(state as Record<string, unknown>);
  if (!validation.ok || !validation.state) {
    throw new Error(validation.error || 'Invalid ralph mode state');
  }
  const normalized = validation.state as ModeState;
  if (
    typeof originalPhase === 'string'
    && typeof normalized.current_phase === 'string'
    && normalized.current_phase !== originalPhase
  ) {
    normalized.ralph_phase_normalized_from = originalPhase;
  }
  return normalized;
}

function stateDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), '.omx', 'state');
}

function statePath(mode: string, projectRoot?: string): string {
  return join(stateDir(projectRoot), `${mode}-state.json`);
}

/**
 * Start a mode. Checks for exclusive mode conflicts.
 */
export async function startMode(
  mode: ModeName,
  taskDescription: string,
  maxIterations: number = 50,
  projectRoot?: string
): Promise<ModeState> {
  const dir = stateDir(projectRoot);
  await mkdir(dir, { recursive: true });

  // Check for exclusive mode conflicts
  if (EXCLUSIVE_MODES.includes(mode)) {
    for (const other of EXCLUSIVE_MODES) {
      if (other === mode) continue;
      const otherPath = statePath(other, projectRoot);
      if (existsSync(otherPath)) {
        try {
          const raw = await readFile(otherPath, 'utf-8');
          const otherState = JSON.parse(raw) as { active?: unknown };
          if (otherState.active) {
            throw new Error(`Cannot start ${mode}: ${other} is already active. Run cancel first.`);
          }
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err?.message.includes('Cannot start')) throw err;
          if (err?.code === 'ENOENT') continue;
          throw new Error(
            `Cannot start ${mode}: ${other} state file is malformed or unreadable (${otherPath}). Run cancel or repair the state file.`
          );
        }
      }
    }
  }

  const stateBase: ModeState = {
    active: true,
    mode,
    iteration: 0,
    max_iterations: maxIterations,
    current_phase: 'starting',
    task_description: taskDescription,
    started_at: new Date().toISOString(),
  };

  const withContext = withModeRuntimeContext({}, stateBase) as ModeState;
  const state = mode === 'ralph'
    ? normalizeRalphModeStateOrThrow(withContext)
    : withContext;
  await writeFile(statePath(mode, projectRoot), JSON.stringify(state, null, 2));
  return state;
}

/**
 * Read current mode state
 */
export async function readModeState(mode: string, projectRoot?: string): Promise<ModeState | null> {
  const path = statePath(mode, projectRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Update mode state (merge fields)
 */
export async function updateModeState(
  mode: string,
  updates: Partial<ModeState>,
  projectRoot?: string
): Promise<ModeState> {
  const current = await readModeState(mode, projectRoot);
  if (!current) throw new Error(`Mode ${mode} not found`);

  const updatedBase = { ...current, ...updates };
  const normalizedBase = mode === 'ralph'
    ? normalizeRalphModeStateOrThrow(updatedBase as ModeState)
    : updatedBase;
  const updated = withModeRuntimeContext(current, normalizedBase) as ModeState;
  await writeFile(statePath(mode, projectRoot), JSON.stringify(updated, null, 2));
  return updated;
}

/**
 * Cancel a mode
 */
export async function cancelMode(mode: string, projectRoot?: string): Promise<void> {
  const state = await readModeState(mode, projectRoot);
  if (state && state.active) {
    await updateModeState(mode, {
      active: false,
      current_phase: 'cancelled',
      completed_at: new Date().toISOString(),
    }, projectRoot);
  }
}

/**
 * Cancel all active modes
 */
export async function cancelAllModes(projectRoot?: string): Promise<string[]> {
  const { readdir } = await import('fs/promises');
  const dir = stateDir(projectRoot);
  const cancelled: string[] = [];

  if (!existsSync(dir)) return cancelled;

  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith('-state.json')) continue;
    const mode = f.replace('-state.json', '');
    const state = await readModeState(mode, projectRoot);
    if (state?.active) {
      await cancelMode(mode, projectRoot);
      cancelled.push(mode);
    }
  }
  return cancelled;
}

/**
 * List all active modes
 */
export async function listActiveModes(projectRoot?: string): Promise<Array<{ mode: string; state: ModeState }>> {
  const { readdir } = await import('fs/promises');
  const dir = stateDir(projectRoot);
  const active: Array<{ mode: string; state: ModeState }> = [];

  if (!existsSync(dir)) return active;

  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith('-state.json')) continue;
    const mode = f.replace('-state.json', '');
    const state = await readModeState(mode, projectRoot);
    if (state?.active) {
      active.push({ mode, state });
    }
  }
  return active;
}
