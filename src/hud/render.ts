/**
 * OMX HUD - Statusline composer
 *
 * Renders HudRenderContext into formatted ANSI strings.
 */

import type { HudRenderContext, HudPreset } from './types.js';
import { green, yellow, cyan, dim, bold, getRalphColor, RESET } from './colors.js';

const SEP = dim(' | ');
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function sanitizeDynamicText(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '');
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function isCurrentSessionMetrics(ctx: HudRenderContext): boolean {
  if (!ctx.metrics || !ctx.session?.started_at || !ctx.metrics.last_activity) return true;

  const sessionStart = new Date(ctx.session.started_at).getTime();
  const lastActivity = new Date(ctx.metrics.last_activity).getTime();
  if (!Number.isFinite(sessionStart) || !Number.isFinite(lastActivity)) return true;

  return lastActivity >= sessionStart;
}

// ============================================================================
// Element Renderers
// ============================================================================

function renderGitBranch(ctx: HudRenderContext): string | null {
  if (!ctx.gitBranch) return null;
  const gitBranch = sanitizeDynamicText(ctx.gitBranch);
  if (!gitBranch) return null;
  return cyan(gitBranch);
}

function renderRalph(ctx: HudRenderContext): string | null {
  if (!ctx.ralph) return null;
  const { iteration, max_iterations } = ctx.ralph;
  const color = getRalphColor(iteration, max_iterations);
  return `${color}ralph:${iteration}/${max_iterations}${RESET}`;
}

function renderUltrawork(ctx: HudRenderContext): string | null {
  if (!ctx.ultrawork) return null;
  return cyan('ultrawork');
}

function renderAutopilot(ctx: HudRenderContext): string | null {
  if (!ctx.autopilot) return null;
  const phase = sanitizeDynamicText(ctx.autopilot.current_phase || 'active') || 'active';
  return yellow(`autopilot:${phase}`);
}

function renderTeam(ctx: HudRenderContext): string | null {
  if (!ctx.team) return null;
  const count = ctx.team.agent_count;
  const name = ctx.team.team_name ? sanitizeDynamicText(ctx.team.team_name) : '';
  if (count !== undefined && count > 0) {
    return green(`team:${count} workers`);
  }
  if (name) {
    return green(`team:${name}`);
  }
  return green('team');
}

function renderEcomode(ctx: HudRenderContext): string | null {
  if (!ctx.ecomode) return null;
  return dim('ecomode');
}

function renderPipeline(ctx: HudRenderContext): string | null {
  if (!ctx.pipeline) return null;
  const phase = sanitizeDynamicText(ctx.pipeline.current_phase || 'active') || 'active';
  return cyan(`pipeline:${phase}`);
}

function renderTurns(ctx: HudRenderContext): string | null {
  if (!ctx.metrics || !isCurrentSessionMetrics(ctx)) return null;
  return dim(`turns:${ctx.metrics.session_turns}`);
}

function renderTokens(ctx: HudRenderContext): string | null {
  if (!ctx.metrics || !isCurrentSessionMetrics(ctx)) return null;

  const total =
    ctx.metrics.session_total_tokens
    ?? ((ctx.metrics.session_input_tokens ?? 0) + (ctx.metrics.session_output_tokens ?? 0));

  if (!Number.isFinite(total) || total <= 0) return null;
  return dim(`tokens:${formatTokenCount(total)}`);
}

function renderQuota(ctx: HudRenderContext): string | null {
  if (!ctx.metrics || !isCurrentSessionMetrics(ctx)) return null;
  const fiveHour = ctx.metrics.five_hour_limit_pct;
  const weekly = ctx.metrics.weekly_limit_pct;

  const parts: string[] = [];
  if (typeof fiveHour === 'number' && Number.isFinite(fiveHour) && fiveHour > 0) parts.push(`5h:${Math.round(fiveHour)}%`);
  if (typeof weekly === 'number' && Number.isFinite(weekly) && weekly > 0) parts.push(`wk:${Math.round(weekly)}%`);
  if (parts.length === 0) return null;
  return dim(`quota:${parts.join(',')}`);
}

function renderLastActivity(ctx: HudRenderContext): string | null {
  if (!ctx.hudNotify?.last_turn_at) return null;
  const lastAt = new Date(ctx.hudNotify.last_turn_at).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - lastAt) / 1000);

  if (diffSec < 60) return dim(`last:${diffSec}s ago`);
  const diffMin = Math.round(diffSec / 60);
  return dim(`last:${diffMin}m ago`);
}

function renderTotalTurns(ctx: HudRenderContext): string | null {
  if (!ctx.metrics?.total_turns) return null;
  return dim(`total-turns:${ctx.metrics.total_turns}`);
}

function renderSessionDuration(ctx: HudRenderContext): string | null {
  if (!ctx.session?.started_at) return null;
  const startedAt = new Date(ctx.session.started_at).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - startedAt) / 1000);

  if (diffSec < 60) return dim(`session:${diffSec}s`);
  if (diffSec < 3600) return dim(`session:${Math.round(diffSec / 60)}m`);
  const hours = Math.floor(diffSec / 3600);
  const mins = Math.round((diffSec % 3600) / 60);
  return dim(`session:${hours}h${mins}m`);
}

// ============================================================================
// Preset Configurations
// ============================================================================

type ElementRenderer = (ctx: HudRenderContext) => string | null;

const MINIMAL_ELEMENTS: ElementRenderer[] = [
  renderGitBranch,
  renderRalph,
  renderUltrawork,
  renderTeam,
  renderTurns,
];

const FOCUSED_ELEMENTS: ElementRenderer[] = [
  renderGitBranch,
  renderRalph,
  renderUltrawork,
  renderAutopilot,
  renderTeam,
  renderPipeline,
  renderEcomode,
  renderTurns,
  renderTokens,
  renderQuota,
  renderSessionDuration,
  renderLastActivity,
];

const FULL_ELEMENTS: ElementRenderer[] = [
  renderGitBranch,
  renderRalph,
  renderUltrawork,
  renderAutopilot,
  renderTeam,
  renderPipeline,
  renderEcomode,
  renderTurns,
  renderTokens,
  renderQuota,
  renderSessionDuration,
  renderLastActivity,
  renderTotalTurns,
];

function getElements(preset: HudPreset): ElementRenderer[] {
  switch (preset) {
    case 'minimal': return MINIMAL_ELEMENTS;
    case 'full': return FULL_ELEMENTS;
    case 'focused':
    default: return FOCUSED_ELEMENTS;
  }
}

// ============================================================================
// Main Render
// ============================================================================

/** Render the HUD statusline from context and preset */
export function renderHud(ctx: HudRenderContext, preset: HudPreset): string {
  const elements = getElements(preset);
  const parts = elements
    .map(fn => fn(ctx))
    .filter((s): s is string => s !== null);

  const ver = ctx.version ? `#${ctx.version.replace(/^v/, '')}` : '';
  const label = bold(`[OMX${ver}]`);

  if (parts.length === 0) {
    return label + ' ' + dim('No active modes.');
  }

  return label + ' ' + parts.join(SEP);
}
