/**
 * OMX HUD - Statusline composer
 *
 * Renders HudRenderContext into formatted ANSI strings.
 */

import type { HudRenderContext, HudPreset } from './types.js';
import { green, yellow, cyan, dim, bold, getRalphColor, RESET } from './colors.js';

const SEP = dim(' | ');

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

// ============================================================================
// Element Renderers
// ============================================================================

function renderGitBranch(ctx: HudRenderContext): string | null {
  if (!ctx.gitBranch) return null;
  return cyan(ctx.gitBranch);
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
  const phase = ctx.autopilot.current_phase || 'active';
  return yellow(`autopilot:${phase}`);
}

function renderTeam(ctx: HudRenderContext): string | null {
  if (!ctx.team) return null;
  const count = ctx.team.agent_count;
  const name = ctx.team.team_name;
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
  const phase = ctx.pipeline.current_phase || 'active';
  return cyan(`pipeline:${phase}`);
}

function renderTurns(ctx: HudRenderContext): string | null {
  if (!ctx.metrics) return null;
  return dim(`turns:${ctx.metrics.session_turns}`);
}

function renderTokens(ctx: HudRenderContext): string | null {
  if (!ctx.metrics) return null;

  const total =
    ctx.metrics.session_total_tokens
    ?? ((ctx.metrics.session_input_tokens ?? 0) + (ctx.metrics.session_output_tokens ?? 0));

  if (!Number.isFinite(total) || total <= 0) return null;
  return dim(`tokens:${formatTokenCount(total)}`);
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
