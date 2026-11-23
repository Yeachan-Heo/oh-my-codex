import { buildSessionTimeline, type SessionTimelineReport, type TimelineToolSummary } from './timeline.js';
import type { SessionTranscriptOptions } from './transcript.js';

export interface SessionCompareOptions extends Omit<SessionTranscriptOptions, 'session'> {
  baseline: string;
  candidate: string;
  baselineHome?: string;
  candidateHome?: string;
  tool?: string;
  namespace?: string;
  sort?: 'regression' | 'name' | 'duration';
  limit?: number;
  maxDurationIncrease?: number;
}

export interface MetricComparison {
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  percent_change: number | null;
}

export const SESSION_COMPARE_METRICS = [
  'duration_ms', 'tool_calls', 'completed', 'failed', 'incomplete', 'orphan_outputs',
  'turns_started', 'turns_completed', 'turns_aborted', 'compactions',
] as const;
export const TOOL_COMPARE_METRICS = [
  'calls', 'completed', 'failed', 'incomplete', 'measured_calls',
  'total_duration_ms', 'mean_duration_ms', 'max_duration_ms',
] as const;
type ToolMeasurements = Omit<TimelineToolSummary, 'name' | 'namespace'> & { mean_duration_ms: number | null };
type SessionSnapshot = Pick<SessionTimelineReport, 'session_id' | 'archived' | 'started_at' | 'last_activity_at' | 'diagnostics'>;

export interface SessionRegression {
  scope: 'session' | 'tool';
  name: string | null;
  namespace: string | null;
  metric: 'failed' | 'incomplete' | 'mean_duration_ms' | 'turns_aborted';
  comparison: MetricComparison;
}

export interface SessionToolComparison {
  name: string | null;
  namespace: string | null;
  presence: 'both' | 'added' | 'removed';
  baseline: ToolMeasurements | null;
  candidate: ToolMeasurements | null;
  metrics: Record<typeof TOOL_COMPARE_METRICS[number], MetricComparison>;
  latency_comparable: boolean;
  regressions: SessionRegression[];
}

export interface SessionCompareReport {
  schema_version: 1;
  baseline: SessionSnapshot;
  candidate: SessionSnapshot;
  privacy: SessionTimelineReport['privacy'];
  metrics: Record<typeof SESSION_COMPARE_METRICS[number], MetricComparison>;
  assessment: {
    status: 'regression' | 'inconclusive' | 'no_regression';
    max_duration_increase_percent: number;
    regressions: SessionRegression[];
    gaps: Array<{ side: 'baseline' | 'candidate'; code: string; count: number }>;
    tools_compared: number;
    latency_comparisons: number;
  };
  selection: {
    tool: string | null;
    namespace: string | null;
    sort: 'regression' | 'name' | 'duration';
    limit: number;
    matched_tools: number;
    truncated: boolean;
  };
  tools: SessionToolComparison[];
}

export function compareMetric(baseline: number | null, candidate: number | null): MetricComparison {
  const delta = baseline === null || candidate === null ? null : candidate - baseline;
  const percent = delta === null || baseline === null ? null
    : baseline === 0 ? (candidate === 0 ? 0 : null) : delta / baseline * 100;
  return {
    baseline, candidate, delta,
    // A positive value against zero has no finite relative change.
    percent_change: percent,
  };
}

function measurements(tool: TimelineToolSummary | undefined): ToolMeasurements | null {
  if (!tool) return null;
  const { name: _name, namespace: _namespace, ...counts } = tool;
  return {
    ...counts,
    mean_duration_ms: tool.measured_calls > 0 && tool.total_duration_ms !== null
      ? tool.total_duration_ms / tool.measured_calls : null,
  };
}

function toolKey(tool: Pick<TimelineToolSummary, 'name' | 'namespace'>): string {
  // Keep null, literal placeholder names, and delimiters distinct.
  return JSON.stringify([tool.namespace, tool.name]);
}

function compareTool(baseline: TimelineToolSummary | undefined, candidate: TimelineToolSummary | undefined, threshold: number): SessionToolComparison {
  const identity = (baseline ?? candidate)!;
  const before = measurements(baseline);
  const after = measurements(candidate);
  const metrics = Object.fromEntries(TOOL_COMPARE_METRICS.map((field) => {
    const absent = field.endsWith('_ms') ? null : 0;
    return [field, compareMetric(before ? before[field] : absent, after ? after[field] : absent)];
  })) as SessionToolComparison['metrics'];
  const latencyComparable = before !== null && after !== null
    && before.calls > 0 && after.calls > 0
    && before.measured_calls === before.calls && after.measured_calls === after.calls;
  const regressions: SessionRegression[] = [];
  const add = (metric: SessionRegression['metric'], comparison: MetricComparison) => {
    regressions.push({ scope: 'tool', name: identity.name, namespace: identity.namespace, metric, comparison });
  };
  for (const metric of ['failed', 'incomplete'] as const) {
    if ((metrics[metric].delta ?? 0) > 0) add(metric, metrics[metric]);
  }
  const mean = metrics.mean_duration_ms;
  if (latencyComparable && mean.baseline !== null && mean.candidate !== null) {
    const allowed = mean.baseline * (1 + threshold / 100);
    // Fractional means can differ by a few ULPs at the exact threshold.
    const tolerance = Number.EPSILON * Math.max(Math.abs(allowed), Math.abs(mean.candidate)) * 4;
    if (mean.candidate - allowed > tolerance) add('mean_duration_ms', mean);
  }
  return {
    name: identity.name, namespace: identity.namespace,
    presence: !before ? 'added' : !after ? 'removed' : 'both',
    baseline: before, candidate: after, metrics, latency_comparable: latencyComparable, regressions,
  };
}

function snapshot(report: SessionTimelineReport): SessionSnapshot {
  return {
    session_id: report.session_id, archived: report.archived,
    started_at: report.started_at, last_activity_at: report.last_activity_at,
    diagnostics: report.diagnostics,
  };
}

function compareName(a: SessionToolComparison, b: SessionToolComparison): number {
  return toolKey(a).localeCompare(toolKey(b));
}

export async function buildSessionComparison(options: SessionCompareOptions): Promise<SessionCompareReport> {
  if (!options.baseline?.trim() || !options.candidate?.trim()) throw new Error('Comparison requires baseline and candidate session ids.');
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid --limit: expected an integer between 1 and 1000.');
  const sort = options.sort ?? 'regression';
  if (!['regression', 'name', 'duration'].includes(sort)) throw new Error('Invalid --sort: expected regression, name, or duration.');
  const threshold = options.maxDurationIncrease ?? 20;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000) {
    throw new Error('Invalid --max-duration-increase: expected a percentage between 0 and 1000000.');
  }
  for (const field of ['tool', 'namespace', 'baselineHome', 'candidateHome'] as const) {
    if (options[field] !== undefined && !options[field]?.trim()) throw new Error(`Comparison option ${field} must not be empty.`);
  }
  const inspect = (session: string, home: string | undefined) => buildSessionTimeline({
    session, cwd: options.cwd,
    codexHomeDir: home ?? options.codexHomeDir,
    codexHomeDirs: home ? undefined : options.codexHomeDirs,
    // Timeline summaries cover every event regardless of the returned event page.
    limit: 1,
  });
  const baseline = await inspect(options.baseline, options.baselineHome);
  const candidate = await inspect(options.candidate, options.candidateHome);
  const metrics = Object.fromEntries(SESSION_COMPARE_METRICS.map((field) => [field,
    compareMetric(field === 'duration_ms' ? baseline.duration_ms : baseline.summary[field],
      field === 'duration_ms' ? candidate.duration_ms : candidate.summary[field]),
  ])) as SessionCompareReport['metrics'];
  const before = new Map(baseline.summary.tools.map((tool) => [toolKey(tool), tool]));
  const after = new Map(candidate.summary.tools.map((tool) => [toolKey(tool), tool]));
  const tools = [...new Set([...before.keys(), ...after.keys()])]
    .map((key) => compareTool(before.get(key), after.get(key), threshold));
  const regressions = tools.flatMap((tool) => tool.regressions);
  if ((metrics.turns_aborted.delta ?? 0) > 0) regressions.push({
    scope: 'session', name: null, namespace: null, metric: 'turns_aborted', comparison: metrics.turns_aborted,
  });
  const gaps: SessionCompareReport['assessment']['gaps'] = [];
  for (const [side, report] of [['baseline', baseline], ['candidate', candidate]] as const) {
    for (const [code, count] of Object.entries(report.diagnostics)) {
      if (count > 0) gaps.push({ side, code, count });
    }
    const unmeasured = report.summary.tool_calls - report.summary.tools.reduce((sum, tool) => sum + tool.measured_calls, 0);
    if (unmeasured > 0) gaps.push({ side, code: 'unmeasured_tool_calls', count: unmeasured });
    if (report.summary.incomplete > 0) gaps.push({ side, code: 'incomplete_tool_calls', count: report.summary.incomplete });
    if (report.summary.orphan_outputs > 0) gaps.push({ side, code: 'orphan_outputs', count: report.summary.orphan_outputs });
    const unclosedTurns = report.summary.turns_started - report.summary.turns_completed - report.summary.turns_aborted;
    if (unclosedTurns > 0) gaps.push({ side, code: 'unclosed_turns', count: unclosedTurns });
    if (report.summary.tool_calls === 0) gaps.push({ side, code: 'no_tool_calls', count: 1 });
  }
  const selected = tools.filter((tool) => (options.tool === undefined || tool.name === options.tool)
    && (options.namespace === undefined || tool.namespace === options.namespace));
  selected.sort((a, b) => {
    if (sort === 'regression') {
      const severity = b.regressions.length - a.regressions.length;
      if (severity) return severity;
    }
    if (sort !== 'name') {
      const aDelta = a.metrics.mean_duration_ms.delta;
      const bDelta = b.metrics.mean_duration_ms.delta;
      if (aDelta !== bDelta) return aDelta === null ? 1 : bDelta === null ? -1 : bDelta - aDelta;
    }
    return compareName(a, b);
  });
  return {
    schema_version: 1, baseline: snapshot(baseline), candidate: snapshot(candidate), privacy: baseline.privacy,
    metrics,
    assessment: {
      status: regressions.length > 0 ? 'regression' : gaps.length > 0 ? 'inconclusive' : 'no_regression',
      max_duration_increase_percent: threshold, regressions, gaps,
      tools_compared: tools.length, latency_comparisons: tools.filter((tool) => tool.latency_comparable).length,
    },
    selection: {
      tool: options.tool ?? null, namespace: options.namespace ?? null, sort, limit,
      matched_tools: selected.length, truncated: selected.length > limit,
    },
    tools: selected.slice(0, limit),
  };
}
