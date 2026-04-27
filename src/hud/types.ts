/**
 * HUD type definitions for oh-my-codex
 */

/** Ralph loop state for HUD display */
export interface RalphStateForHud {
  active: boolean;
  iteration?: number;
  max_iterations?: number;
}

/** Ultrawork state for HUD display */
export interface UltraworkStateForHud {
  active: boolean;
  reinforcement_count?: number;
}

/** Autopilot state for HUD display */
export interface AutopilotStateForHud {
  active: boolean;
  current_phase?: string;
}

/** Ralplan state for HUD display */
export interface RalplanStateForHud {
  active: boolean;
  current_phase?: string;
  iteration?: number;
  planning_complete?: boolean;
}

/** Deep-interview state for HUD display */
export interface DeepInterviewStateForHud {
  active: boolean;
  current_phase?: string;
  input_lock_active?: boolean;
}

/** Autoresearch state for HUD display */
export interface AutoresearchStateForHud {
  active: boolean;
  current_phase?: string;
}

/** Ultraqa state for HUD display */
export interface UltraqaStateForHud {
  active: boolean;
  current_phase?: string;
}

/** Team state for HUD display */
export interface TeamStateForHud {
  active: boolean;
  current_phase?: string;
  agent_count?: number;
  team_name?: string;
}

/** Metrics tracked by notify hook */
export interface HudMetrics {
  total_turns: number;
  session_turns: number;
  last_activity: string;
  session_input_tokens?: number;
  session_output_tokens?: number;
  session_total_tokens?: number;
  five_hour_limit_pct?: number;
  weekly_limit_pct?: number;
}

/** HUD notify state written by notify hook */
export interface HudNotifyState {
  last_turn_at: string;
  turn_count: number;
  last_agent_output?: string;
}

/** Session state for HUD display */
export interface SessionStateForHud {
  session_id: string;
  started_at: string;
}

/** All data needed to render one HUD frame */
export interface HudRenderContext {
  version: string | null;
  gitBranch: string | null;
  ralph: RalphStateForHud | null;
  ultrawork: UltraworkStateForHud | null;
  autopilot: AutopilotStateForHud | null;
  ralplan: RalplanStateForHud | null;
  deepInterview: DeepInterviewStateForHud | null;
  autoresearch: AutoresearchStateForHud | null;
  ultraqa: UltraqaStateForHud | null;
  team: TeamStateForHud | null;
  metrics: HudMetrics | null;
  hudNotify: HudNotifyState | null;
  session: SessionStateForHud | null;
  /** Rust-authored runtime snapshot (present when bridge is enabled and snapshot.json exists). */
  runtimeSnapshot?: import('../runtime/bridge.js').RuntimeSnapshot | null;
}

/** HUD preset names */
export type HudPreset = 'minimal' | 'focused' | 'full';

export type HudGitDisplay = 'branch' | 'repo-branch';

export interface HudGitConfig {
  display?: HudGitDisplay;
  remoteName?: string;
  repoLabel?: string;
}

/** Status line preset configuration (drives [tui].status_line in ~/.codex/config.toml) */
export interface HudStatusLineConfig {
  preset?: HudPreset;
}

/** HUD configuration stored in .omx/hud-config.json */
export interface HudConfig {
  preset?: HudPreset;
  git?: HudGitConfig;
  statusLine?: HudStatusLineConfig;
}

export interface ResolvedHudGitConfig {
  display: HudGitDisplay;
  remoteName?: string;
  repoLabel?: string;
}

export interface ResolvedHudStatusLineConfig {
  preset: HudPreset;
}

export interface ResolvedHudConfig {
  preset: HudPreset;
  git: ResolvedHudGitConfig;
  statusLine: ResolvedHudStatusLineConfig;
}

/** Default HUD configuration */
export const DEFAULT_HUD_CONFIG: ResolvedHudConfig = {
  preset: 'focused',
  git: {
    display: 'repo-branch',
  },
  statusLine: {
    preset: 'focused',
  },
};

/** CLI flags for omx hud */
export interface HudFlags {
  watch: boolean;
  json: boolean;
  tmux: boolean;
  preset?: HudPreset;
}
