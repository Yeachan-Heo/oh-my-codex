/**
 * HUD type definitions for oh-my-codex
 */

/** Ralph loop state for HUD display */
export interface RalphStateForHud {
  active: boolean;
  iteration: number;
  max_iterations: number;
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

/** Team state for HUD display */
export interface TeamStateForHud {
  active: boolean;
  current_phase?: string;
  agent_count?: number;
  team_name?: string;
}

/** Ecomode state for HUD display */
export interface EcomodeStateForHud {
  active: boolean;
}

/** Pipeline state for HUD display */
export interface PipelineStateForHud {
  active: boolean;
  current_phase?: string;
}

/** Metrics tracked by notify hook */
export interface HudMetrics {
  total_turns: number;
  session_turns: number;
  last_activity: string;
  session_input_tokens?: number;
  session_output_tokens?: number;
  session_total_tokens?: number;
}

/** HUD notify state written by notify hook */
export interface HudNotifyState {
  last_turn_at: string;
  turn_count: number;
  last_agent_output?: string;
}

/** All data needed to render one HUD frame */
export interface HudRenderContext {
  version: string | null;
  gitBranch: string | null;
  ralph: RalphStateForHud | null;
  ultrawork: UltraworkStateForHud | null;
  autopilot: AutopilotStateForHud | null;
  team: TeamStateForHud | null;
  ecomode: EcomodeStateForHud | null;
  pipeline: PipelineStateForHud | null;
  metrics: HudMetrics | null;
  hudNotify: HudNotifyState | null;
}

/** HUD preset names */
export type HudPreset = 'minimal' | 'focused' | 'full';

/** HUD configuration stored in .omx/hud-config.json */
export interface HudConfig {
  preset: HudPreset;
}

/** Default HUD configuration */
export const DEFAULT_HUD_CONFIG: HudConfig = {
  preset: 'focused',
};

/** CLI flags for omx hud */
export interface HudFlags {
  watch: boolean;
  json: boolean;
  tmux: boolean;
  preset?: HudPreset;
}
