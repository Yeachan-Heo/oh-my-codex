import { bold, cyan, dim, green, isColorEnabled, setColorEnabled, yellow } from '../hud/colors.js';
import type { RenderSidecarOptions, SidecarHighlight, SidecarSnapshot, SidecarTask, SidecarWorkerSnapshot } from './types.js';

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const OSC_RE = /\x1b\][\s\S]*?(?:\u0007|\x1b\\)/g;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function clean(value: string | undefined | null): string {
  return (value ?? '').replace(OSC_RE, '').replace(ANSI_RE, '').replace(CONTROL_CHARS_RE, '').trim();
}

function visibleLength(value: string): number {
  return clean(value).length;
}

function truncate(value: string, width: number): string {
  const sanitized = clean(value);
  if (width <= 0) return '';
  if (sanitized.length <= width) return sanitized;
  if (width <= 1) return '…';
  return `${sanitized.slice(0, Math.max(0, width - 1))}…`;
}

function panel(title: string, lines: string[], width: number): string[] {
  const safeWidth = Math.max(24, width);
  const rule = '─'.repeat(Math.max(1, safeWidth - visibleLength(title) - 4));
  return [bold(`╭ ${title} ${rule}`), ...lines.map((line) => `│ ${truncate(line, safeWidth - 2)}`)];
}

function taskLabel(task: SidecarTask): string {
  const owner = task.owner ? ` @${task.owner}` : '';
  return `task-${task.id} [${task.status}]${owner} ${task.subject}`;
}

function workerLabel(worker: SidecarWorkerSnapshot): string {
  const alive = worker.alive === false ? 'dead' : worker.alive === true ? 'alive' : 'unknown';
  const task = worker.current_task ? ` task-${worker.current_task.id}` : '';
  const pane = worker.pane_id ? ` ${worker.pane_id}` : '';
  const turns = typeof worker.turns_without_progress === 'number' ? ` Δturns=${worker.turns_without_progress}` : '';
  return `${worker.name} [${worker.status.state}/${alive}] ${worker.role}${task}${pane}${turns}`;
}

function highlightLabel(highlight: SidecarHighlight): string {
  const prefix = highlight.severity === 'critical' ? '!!' : highlight.severity === 'warning' ? '!' : '·';
  return `${prefix} ${highlight.target}: ${highlight.message}`;
}

function withColorSetting<T>(enabled: boolean, fn: () => T): T {
  const previous = isColorEnabled();
  setColorEnabled(enabled);
  try {
    return fn();
  } finally {
    setColorEnabled(previous);
  }
}

export function renderSidecar(snapshot: SidecarSnapshot, options: RenderSidecarOptions = {}): string {
  const width = Math.max(32, Math.floor(options.width ?? 72));
  const maxLines = Math.max(0, Math.floor(options.height ?? 0));
  return withColorSetting(options.color !== false, () => {
    const lines: string[] = [];
    lines.push(cyan(bold(`OMX Sidecar · ${clean(snapshot.team_name)}`)));
    lines.push(dim(`phase=${clean(snapshot.phase ?? 'unknown')} generated=${clean(snapshot.generated_at)}`));
    lines.push('');

    lines.push(...panel('Topology', [snapshot.topology.summary, ...snapshot.topology.edges.map((edge) => `${edge.from} ──${edge.label ? ` ${edge.label} ` : ' '}→ ${edge.to}`)], width));
    lines.push(...panel('Agents', snapshot.workers.length > 0 ? snapshot.workers.map(workerLabel) : ['no workers found'], width));
    lines.push(...panel('Tasks', snapshot.tasks.length > 0 ? snapshot.tasks.map(taskLabel) : ['no tasks found'], width));
    lines.push(...panel('Highlights', snapshot.highlights.length > 0 ? snapshot.highlights.map(highlightLabel) : [green('no blockers detected')], width));
    lines.push(...panel('Panes', snapshot.panes.length > 0 ? snapshot.panes.map((pane) => `${pane.target} [${pane.role}] ${pane.pane_id}`) : ['no pane mapping available'], width));
    lines.push(...panel('Events', snapshot.events.length > 0 ? snapshot.events.map((event) => `${event.created_at} ${event.type} ${event.worker}${event.task_id ? ` task-${event.task_id}` : ''}${event.reason ? ` · ${event.reason}` : ''}`) : ['no recent events'], width));
    if (snapshot.source_warnings.length > 0) {
      lines.push(...panel('Warnings', snapshot.source_warnings.map((warning) => yellow(warning)), width));
    }

    const rendered = maxLines > 0 && lines.length > maxLines ? [...lines.slice(0, Math.max(0, maxLines - 1)), dim(`… ${lines.length - maxLines + 1} more lines`)] : lines;
    return rendered.join('\n');
  });
}
