import { execFileSync } from 'child_process';

export interface ModeStateContextLike {
  active?: unknown;
  tmux_pane_id?: unknown;
  tmux_pane_set_at?: unknown;
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

export function withModeRuntimeContext<T extends ModeStateContextLike>(
  existing: ModeStateContextLike,
  next: T,
  options?: { env?: NodeJS.ProcessEnv; nowIso?: string }
): T {
  const env = options?.env ?? process.env;
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const wasActive = existing.active === true;
  const isActive = next.active === true;
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

  return next;
}
