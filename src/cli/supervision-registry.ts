/**
 * Registry of repeat-problem checks, keyed by stable check id (Refs #4217).
 *
 * This is data only: ids, areas, severity and descriptions. The detection logic lives in
 * supervision.ts (CHECK_RUNNERS). The past issues/PRs a check was derived from are NOT
 * stored here; they are a per-user "history" mapping check id -> issue/PR numbers
 * (see supervision-history.iqdoctor.ts), so a later per-user history (PR 3) can map any
 * user's own issues onto the same ids without touching check logic.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type CheckArea = 'leader' | 'resource' | 'autopilot' | 'hook' | 'hud' | 'agents' | 'question' | 'root' | 'setup';

export interface RepeatProblem {
  /** Stable, kebab-case id. Never rename; history files and issue fingerprints depend on it. */
  id: string;
  area: CheckArea;
  title: string;
  severity: Severity;
  /** persistent = visible in files on disk; sampled = observed live and may not recur. */
  repro: 'persistent' | 'sampled';
}

/** check id -> past issue/PR numbers the problem class was observed in. */
export type RepeatProblemHistory = Readonly<Record<string, readonly number[]>>;

export const REPEAT_PROBLEM_REGISTRY: readonly RepeatProblem[] = [
  { id: 'silver-rule-lane-reuse', area: 'leader', title: 'Silver Rule: replacement subagent spawned while a reusable lane exists', severity: 'medium', repro: 'persistent' },
  { id: 'ralplan-lane-reuse', area: 'leader', title: 'ralplan active with default/improvised reviewer subagents', severity: 'high', repro: 'persistent' },
  { id: 'native-subagent-blocker', area: 'leader', title: 'Native subagent support/capacity blocker recorded while a workflow is active', severity: 'high', repro: 'persistent' },
  { id: 'hud-cpu-load', area: 'resource', title: 'hud --watch above 2% of a core (#4202 gate)', severity: 'high', repro: 'sampled' },
  { id: 'hud-duplicate-panes', area: 'resource', title: 'More than one HUD watch pane per leader/window', severity: 'high', repro: 'persistent' },
  { id: 'process-rss', area: 'resource', title: 'omx / hud process resident memory', severity: 'medium', repro: 'sampled' },
  { id: 'disk-growth', area: 'resource', title: '.omx/state, logs or Codex rollouts exceed size thresholds', severity: 'low', repro: 'persistent' },
  { id: 'autopilot-phase-illegal', area: 'autopilot', title: 'Persisted autopilot phase is not a legal state', severity: 'high', repro: 'persistent' },
  { id: 'team-phase-transition-illegal', area: 'autopilot', title: 'Illegal phase transition in a team phase log (autopilot team child phase)', severity: 'high', repro: 'persistent' },
  { id: 'autopilot-phase-stuck', area: 'autopilot', title: 'Active autopilot phase has not progressed past the timeout', severity: 'medium', repro: 'persistent' },
  { id: 'autopilot-gate-loop', area: 'autopilot', title: 'Stop-hook / autopilot gate re-entry loop', severity: 'critical', repro: 'persistent' },
  { id: 'stop-hook-invalid-json', area: 'hook', title: 'Native hook dispatch / invalid Stop JSON errors in today’s hook log', severity: 'high', repro: 'persistent' },
  { id: 'hud-authority-churn', area: 'hud', title: 'Rendered HUD model disagrees with .omx/state', severity: 'high', repro: 'persistent' },
  { id: 'native-agent-toml-drift', area: 'agents', title: 'Native agent TOML drift (omx doctor)', severity: 'medium', repro: 'persistent' },
  { id: 'question-outside-tmux', area: 'question', title: '`omx question` needs tmux but the live session has no tmux pane', severity: 'high', repro: 'persistent' },
  { id: 'stale-omx-root', area: 'root', title: 'Process bound to a stale or foreign OMX_ROOT', severity: 'high', repro: 'persistent' },
  { id: 'hud-deleted-cwd', area: 'root', title: 'HUD watch bound to a deleted cwd', severity: 'medium', repro: 'sampled' },
  { id: 'setup-cache-drift', area: 'setup', title: 'Plugin cache / setup drift after update (omx doctor)', severity: 'high', repro: 'persistent' },
];

export function sourcesFor(history: RepeatProblemHistory, id: string): number[] {
  return [...(history[id] ?? [])];
}
