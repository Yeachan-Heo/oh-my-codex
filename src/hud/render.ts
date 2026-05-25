/**
 * OMX HUD - Statusline composer
 *
 * Renders HudRenderContext into formatted ANSI strings.
 */

import type { HudRenderContext, HudPreset } from './types.js';
import { green, yellow, cyan, dim, bold, getRalphColor, isColorEnabled, RESET } from './colors.js';
import { HUD_TMUX_MAX_HEIGHT_LINES } from './constants.js';

const SEP = dim(' | ');
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

export interface RenderHudOptions {
  maxWidth?: number;
  maxLines?: number;
}

function sanitizeDynamicText(value: string): string {
  return value.replace(CONTROL_CHARS_RE, '');
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_SGR_RE, '');
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
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
  if (!Number.isFinite(iteration) || !Number.isFinite(max_iterations)) {
    return yellow('ralph');
  }
  const safeIteration = iteration as number;
  const safeMaxIterations = max_iterations as number;
  if (!isColorEnabled()) return `ralph:${safeIteration}/${safeMaxIterations}`;
  const color = getRalphColor(safeIteration, safeMaxIterations);
  return `${color}ralph:${safeIteration}/${safeMaxIterations}${RESET}`;
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

function renderRalplan(ctx: HudRenderContext): string | null {
  if (!ctx.ralplan) return null;
  const iteration = ctx.ralplan.iteration;
  const planningComplete = ctx.ralplan.planning_complete === true;
  if (typeof iteration === 'number' && Number.isFinite(iteration)) {
    const max = planningComplete ? iteration : '?';
    return cyan(`ralplan:${iteration}/${max}`);
  }
  const phase = sanitizeDynamicText(ctx.ralplan.current_phase || 'active') || 'active';
  return cyan(`ralplan:${phase}`);
}

function renderDeepInterview(ctx: HudRenderContext): string | null {
  if (!ctx.deepInterview) return null;
  const phase = sanitizeDynamicText(ctx.deepInterview.current_phase || 'active') || 'active';
  const lockSuffix = ctx.deepInterview.input_lock_active ? ':lock' : '';
  return yellow(`interview:${phase}${lockSuffix}`);
}

function renderAutoresearch(ctx: HudRenderContext): string | null {
  if (!ctx.autoresearch) return null;
  const phase = sanitizeDynamicText(ctx.autoresearch.current_phase || 'active') || 'active';
  return cyan(`research:${phase}`);
}

function renderUltraqa(ctx: HudRenderContext): string | null {
  if (!ctx.ultraqa) return null;
  const phase = sanitizeDynamicText(ctx.ultraqa.current_phase || 'active') || 'active';
  return green(`qa:${phase}`);
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


function truncateDynamicText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return '…';
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function renderUltragoal(ctx: HudRenderContext): string | null {
  if (!ctx.ultragoal?.active) return null;
  const total = ctx.ultragoal.progressTotal;
  const complete = ctx.ultragoal.complete;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(complete)) return null;

  const progress = `ultragoal ${complete}/${total}`;
  const id = ctx.ultragoal.activeGoal?.id ? sanitizeDynamicText(ctx.ultragoal.activeGoal.id) : '';
  const title = ctx.ultragoal.activeGoal?.title ? sanitizeDynamicText(ctx.ultragoal.activeGoal.title) : '';
  const rawObjective = ctx.ultragoal.activeGoal?.objective ? sanitizeDynamicText(ctx.ultragoal.activeGoal.objective) : '';
  const objective = rawObjective ? truncateDynamicText(rawObjective, 96) : '';
  const heading = [id, title].filter(Boolean).join(': ');
  const summary = heading ? `${progress} ▶ ${heading}` : progress;
  return cyan(objective ? `${summary} · objective: ${objective}` : summary);
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
  if (Number.isNaN(lastAt)) return null;
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - lastAt) / 1000));

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
  if (Number.isNaN(startedAt)) return null;
  const now = Date.now();
  const diffSec = Math.max(0, Math.round((now - startedAt) / 1000));

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
  renderRalplan,
  renderDeepInterview,
  renderAutoresearch,
  renderUltraqa,
  renderTeam,
  renderUltragoal,
  renderTurns,
];

const FOCUSED_ELEMENTS: ElementRenderer[] = [
  renderGitBranch,
  renderRalph,
  renderUltrawork,
  renderAutopilot,
  renderRalplan,
  renderDeepInterview,
  renderAutoresearch,
  renderUltraqa,
  renderTeam,
  renderUltragoal,
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
  renderRalplan,
  renderDeepInterview,
  renderAutoresearch,
  renderUltraqa,
  renderTeam,
  renderUltragoal,
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

function ellipsizeSegment(segment: string, maxWidth: number): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return '';
  if (visibleLength(segment) <= maxWidth) return segment;

  const plain = stripAnsi(segment);
  if (plain.length <= maxWidth) return plain;
  if (maxWidth <= 1) return '…';
  if (maxWidth <= 4) return `${plain.slice(0, Math.max(0, maxWidth - 1))}…`;

  const head = Math.max(1, Math.ceil((maxWidth - 1) / 2));
  const tail = Math.max(1, Math.floor((maxWidth - 1) / 2));
  return `${plain.slice(0, head)}…${plain.slice(-tail)}`;
}

function wrapHudParts(
  label: string,
  parts: string[],
  options: RenderHudOptions,
): string {
  const maxWidth = Number.isFinite(options.maxWidth) && (options.maxWidth ?? 0) > 0
    ? Math.max(12, Math.floor(options.maxWidth ?? 0))
    : Infinity;
  const maxLines = Number.isFinite(options.maxLines) && (options.maxLines ?? 0) > 0
    ? Math.max(1, Math.floor(options.maxLines ?? 0))
    : HUD_TMUX_MAX_HEIGHT_LINES;

  if (!Number.isFinite(maxWidth)) {
    return `${label} ${parts.join(SEP)}`;
  }

  const lines: string[] = [];
  const indent = ' '.repeat(Math.max(0, visibleLength(label) + 1));
  let currentLine = label;
  let hasContent = false;

  const pushLine = () => {
    lines.push(currentLine);
    currentLine = indent;
    hasContent = false;
  };

  for (const part of parts) {
    const linePrefix = hasContent ? indent : `${label} `;
    const available = Math.max(1, maxWidth - visibleLength(linePrefix));
    const segment = ellipsizeSegment(part, available);
    const separator = hasContent ? SEP : ' ';
    const candidate = `${currentLine}${separator}${segment}`;
    if (visibleLength(candidate) <= maxWidth) {
      currentLine = candidate;
      hasContent = true;
      continue;
    }

    if (lines.length + 1 < maxLines) {
      pushLine();
      currentLine = `${currentLine}${segment}`;
      hasContent = true;
      continue;
    }

    const overflow = dim('…');
    const overflowCandidate = `${currentLine}${hasContent ? SEP : ' '}${overflow}`;
    currentLine = visibleLength(overflowCandidate) <= maxWidth
      ? overflowCandidate
      : ellipsizeSegment(currentLine, maxWidth - 1) + '…';
    hasContent = true;
    break;
  }

  lines.push(currentLine);
  return lines.join('\n');
}

// ============================================================================
// Main Render
// ============================================================================

/** Render the HUD statusline from context and preset */
export function renderHud(
  ctx: HudRenderContext,
  preset: HudPreset,
  options: RenderHudOptions = {},
): string {
  const elements = getElements(preset);
  const parts = elements
    .map(fn => fn(ctx))
    .filter((s): s is string => s !== null);

  const ver = ctx.version ? `#${ctx.version.replace(/^v/, '')}` : '';
  const label = bold(`[OMX${ver}]`);

  if (parts.length === 0) {
    return wrapHudParts(label, [dim('No active modes.')], options);
  }

  return wrapHudParts(label, parts, options);
}

export function countRenderedHudLines(text: string): number {
  return text.replace(/\r/g, '').split('\n').length;
}
