/**
 * Base mode lifecycle management for oh-my-codex
 * All execution modes (autopilot, ralph, ultrawork, ecomode) share this base.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

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

export type ModeName = 'autopilot' | 'ralph' | 'ultrawork' | 'ecomode' |
  'ultrapilot' | 'team' | 'pipeline' | 'ultraqa' | 'ralplan';

const EXCLUSIVE_MODES: ModeName[] = ['autopilot', 'ralph', 'ultrawork', 'ultrapilot'];

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
          const otherState = JSON.parse(await readFile(otherPath, 'utf-8'));
          if (otherState.active) {
            throw new Error(`Cannot start ${mode}: ${other} is already active. Run cancel first.`);
          }
        } catch (e) {
          if ((e as Error).message.includes('Cannot start')) throw e;
        }
      }
    }
  }

  const state: ModeState = {
    active: true,
    mode,
    iteration: 0,
    max_iterations: maxIterations,
    current_phase: 'starting',
    task_description: taskDescription,
    started_at: new Date().toISOString(),
  };

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

  const updated = { ...current, ...updates };
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

/**
 * Check if mode should continue (not exceeded max iterations, still active)
 */
export function shouldContinue(state: ModeState): boolean {
  return state.active && state.iteration < state.max_iterations;
}
