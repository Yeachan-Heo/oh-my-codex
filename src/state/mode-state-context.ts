import { randomUUID } from 'crypto';
import { readExactPaneProofSync } from '../team/exact-pane.js';
import { spawnPlatformCommandSync } from '../utils/platform-command.js';

import { execFileSync } from 'child_process';

export interface ModeStateContextLike {
  active?: unknown;
  mode?: unknown;
  tmux_pane_id?: unknown;
  tmux_pane_pid?: unknown;
  tmux_pane_owner_id?: unknown;
  tmux_pane_set_at?: unknown;
  tmux_session_name?: unknown;
  tmux_window_id?: unknown;
  [key: string]: unknown;
}

export function captureTmuxPaneFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TMUX_PANE;
  if (typeof value !== 'string') return null;
  const pane = value.trim();
  return pane.length > 0 ? pane : null;
}

export function captureTmuxWindowForPane(pane: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!pane || !env.TMUX || env.OMX_TMUX_HUD_OWNER !== '1') return null;
  try {
    const tmux = env.TMUX_BINARY || 'tmux';
    const windowId = execFileSync(tmux, ['display-message', '-p', '-t', pane, '#{window_id}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    return windowId.length > 0 ? windowId : null;
  } catch {
    return null;
  }
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export const OMX_RALPH_PANE_OWNER_OPTION = '@omx_ralph_pane_owner_id';

interface RalphPaneBinding {
  paneId: string;
  panePid: number;
  sessionName: string;
  paneOwnerId: string;
}

function clearRalphPaneBinding(state: ModeStateContextLike): void {
  delete state.tmux_pane_id;
  delete state.tmux_pane_pid;
  delete state.tmux_pane_owner_id;
  delete state.tmux_session_name;
  delete state.tmux_pane_set_at;
  delete state.tmux_window_id;
}

function captureRalphPaneBinding(paneId: string): RalphPaneBinding | null {
  const initialProof = readExactPaneProofSync(paneId);
  if (initialProof.status !== 'live') return null;

  const paneOwnerId = `ralph:${randomUUID()}`;
  const effectProof = readExactPaneProofSync(initialProof.paneId);
  if (effectProof.status !== 'live' || effectProof.pid !== initialProof.pid) return null;
  const tagged = spawnPlatformCommandSync(
    'tmux',
    ['set-option', '-p', '-t', effectProof.paneId, OMX_RALPH_PANE_OWNER_OPTION, paneOwnerId],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).result;
  if (tagged.error || tagged.status !== 0) return null;

  const owner = spawnPlatformCommandSync(
    'tmux',
    ['show-option', '-qv', '-p', '-t', initialProof.paneId, OMX_RALPH_PANE_OWNER_OPTION],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).result;
  if (owner.error || owner.status !== 0 || typeof owner.stdout !== 'string' || owner.stdout.trim() !== paneOwnerId) {
    return null;
  }

  const finalProof = readExactPaneProofSync(initialProof.paneId);
  if (finalProof.status !== 'live' || finalProof.pid !== initialProof.pid) return null;

  const session = spawnPlatformCommandSync(
    'tmux',
    ['display-message', '-p', '-t', finalProof.paneId, '#{session_name}'],
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).result;
  if (session.error || session.status !== 0 || typeof session.stdout !== 'string') return null;
  const sessionName = session.stdout.trim();
  if (sessionName === '') return null;

  return {
    paneId: finalProof.paneId,
    panePid: finalProof.pid,
    sessionName,
    paneOwnerId,
  };
}

export function withModeRuntimeContext<T extends ModeStateContextLike>(
  existing: ModeStateContextLike,
  next: T,
  options?: { env?: NodeJS.ProcessEnv; nowIso?: string }
): T {
  const env = options?.env ?? process.env;
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const wasActive = existing.active === true;
  const isActive = next.active === true;
  const isRalphActivation = !wasActive && isActive && next.mode === 'ralph';

  if (isRalphActivation) clearRalphPaneBinding(next);

  const hasPane = hasNonEmptyString(next.tmux_pane_id);
  if (isActive && (!wasActive || !hasPane)) {
    const pane = captureTmuxPaneFromEnv(env);
    if (pane) {
      next.tmux_pane_id = pane;
      const windowId = captureTmuxWindowForPane(pane, env);
      if (windowId) next.tmux_window_id = windowId;
      if (!hasNonEmptyString(next.tmux_pane_set_at)) {
        next.tmux_pane_set_at = nowIso;
      }
    }
  }

  const ralphPaneId = typeof next.tmux_pane_id === 'string' ? next.tmux_pane_id.trim() : '';
  if (isRalphActivation && ralphPaneId) {
    const binding = captureRalphPaneBinding(ralphPaneId);
    if (binding) {
      next.tmux_pane_id = binding.paneId;
      next.tmux_pane_pid = binding.panePid;
      next.tmux_session_name = binding.sessionName;
      next.tmux_pane_owner_id = binding.paneOwnerId;
    } else {
      clearRalphPaneBinding(next);
    }
  }

  return next;
}
