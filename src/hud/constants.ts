export const HUD_TMUX_HEIGHT_LINES = 2;
export const HUD_TMUX_ULTRAGOAL_HEIGHT_LINES = 3;
export const HUD_TMUX_TEAM_HEIGHT_LINES = 3;
export const HUD_TMUX_MAX_HEIGHT_LINES = 3;
// Minimum existing-tmux window height (in lines) required before `omx` will
// force a launch-time HUD split. Below this, creating the 2-line HUD pane would
// leave the Codex TUI too cramped to read, so we skip the launch-time split and
// let the later reconcile path add the HUD when there is room. (closes #2754)
export const HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES = 45;
export const HUD_RESIZE_RECONCILE_DELAY_SECONDS = 2;

/**
 * Shared cramped-window heuristic for the tmux HUD split. Both the launch path
 * (src/cli/index.ts) and the prompt-submit reconcile path (src/hud/reconcile.ts)
 * use this so a height-constrained existing tmux window never gets a HUD split
 * that would steal rows from the Codex TUI and make it unreadable. When the
 * window height is unknown/invalid (null/undefined/NaN/<=0) we keep the default
 * behavior and allow the HUD. (closes #2754)
 */
export function isTmuxWindowTooCrampedForHudSplit(
  windowHeight: number | null | undefined,
  minWindowHeight: number = HUD_TMUX_MIN_LAUNCH_WINDOW_HEIGHT_LINES,
): boolean {
  if (typeof windowHeight !== "number" || !Number.isFinite(windowHeight) || windowHeight <= 0) {
    return false;
  }
  return windowHeight < minWindowHeight;
}
