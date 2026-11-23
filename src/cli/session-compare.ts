import { writeFile } from 'node:fs/promises';
import {
  buildSessionComparison, SESSION_COMPARE_METRICS, TOOL_COMPARE_METRICS,
  type MetricComparison, type SessionCompareOptions, type SessionCompareReport,
} from '../session-history/compare.js';

const HELP = `Usage: omx session compare <baseline-id> <candidate-id> [options]

Compare local session execution metrics and namespace-aware tool performance.
Use exact ids or unique prefixes; active and archived transcripts are supported.

Options:
  --codex-home <path>              Inspect both sessions in this Codex home
  --baseline-home <path>           Override the home for the baseline session
  --candidate-home <path>          Override the home for the candidate session
  --tool <name>                    Display an exact tool name
  --namespace <name>               Display an exact tool namespace
  --sort <order>                   regression | name | duration (default: regression)
  --limit <n>                      Display 1-1000 tools (default: 20)
  --max-duration-increase <pct>    Allowed mean tool duration increase (default: 20)
  --fail-on-regression             Exit 2 for regressions, 3 for inconclusive evidence
  --json                          Emit structured JSON
  --output <path>                  Save to a new owner-only file; never overwrite
  -h, --help                       Show this help

Assessment covers both whole sessions, before display filters or limits.
Regressions: increased per-tool failures/incomplete calls, aborted turns, or mean
tool duration above the threshold when both tools have fully measured calls.
Missing measurements remain unknown; read gaps produce an inconclusive assessment.
Durations are observed call-to-result intervals, not CPU time. Compare similar work.
Reports exclude conversation text, tool arguments/outputs, and filesystem paths.

Examples:
  omx session compare <before> <after> --sort duration
  omx session compare <before> <after> --json --output comparison.json
  omx session compare <before> <after> --max-duration-increase 10 --fail-on-regression
`;

export interface ParsedSessionCompareArgs {
  options: SessionCompareOptions;
  json: boolean;
  failOnRegression: boolean;
  output?: string;
}

export function parseSessionCompareArgs(args: string[]): ParsedSessionCompareArgs {
  const parsed: ParsedSessionCompareArgs = { options: { baseline: '', candidate: '' }, json: false, failOnRegression: false };
  const ids: string[] = [];
  const valued = new Set(['--codex-home', '--baseline-home', '--candidate-home', '--tool', '--namespace', '--sort', '--limit', '--max-duration-increase', '--output']);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--json') { parsed.json = true; continue; }
    if (token === '--fail-on-regression') { parsed.failOnRegression = true; continue; }
    if (!token.startsWith('-')) {
      if (!token.trim() || ids.length === 2) throw new Error(`Unexpected session comparison argument: ${token}`);
      ids.push(token.trim());
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (!valued.has(flag)) throw new Error(`Unknown session compare option: ${token}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value?.trim() || (separator < 0 && value.startsWith('-'))) throw new Error(`Missing value after ${flag}.`);
    switch (flag) {
      case '--codex-home': parsed.options.codexHomeDir = value; break;
      case '--baseline-home': parsed.options.baselineHome = value; break;
      case '--candidate-home': parsed.options.candidateHome = value; break;
      case '--tool': parsed.options.tool = value; break;
      case '--namespace': parsed.options.namespace = value; break;
      case '--output': parsed.output = value; break;
      case '--sort':
        if (value !== 'regression' && value !== 'name' && value !== 'duration') throw new Error('Invalid --sort: expected regression, name, or duration.');
        parsed.options.sort = value;
        break;
      case '--limit':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000) {
          throw new Error('Invalid --limit: expected an integer between 1 and 1000.');
        }
        parsed.options.limit = Number(value);
        break;
      case '--max-duration-increase':
        if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1_000_000) {
          throw new Error('Invalid --max-duration-increase: expected a percentage between 0 and 1000000.');
        }
        parsed.options.maxDurationIncrease = Number(value);
        break;
    }
  }
  if (ids.length !== 2) throw new Error(`Expected baseline and candidate session ids.\n${HELP}`);
  [parsed.options.baseline, parsed.options.candidate] = ids;
  return parsed;
}

function plain(value: string): string { return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
function number(value: number | null): string { return value === null ? 'unknown' : String(Math.round(value * 100) / 100); }
function signed(value: number | null): string { return value === null ? 'unknown' : `${value > 0 ? '+' : ''}${number(value)}`; }
function change(value: MetricComparison): string {
  const percent = value.percent_change === null ? 'n/a' : `${signed(value.percent_change)}%`;
  return `${number(value.baseline)} -> ${number(value.candidate)} (delta=${signed(value.delta)}, ${percent})`;
}
function toolName(name: string | null, namespace: string | null): string {
  return `${plain(name ?? '(unknown)')}${namespace === null ? '' : ` namespace=${plain(namespace)}`}`;
}

export function formatSessionComparison(report: SessionCompareReport): string {
  const { assessment, selection } = report;
  const lines = [
    `Session comparison: ${plain(report.baseline.session_id)} -> ${plain(report.candidate.session_id)}`,
    `Baseline: ${report.baseline.archived ? 'archived' : 'active history'}; candidate: ${report.candidate.archived ? 'archived' : 'active history'}.`,
    `Assessment: ${assessment.status}; ${assessment.regressions.length} regression(s); allowed mean duration increase=${assessment.max_duration_increase_percent}%.`,
    'Whole-session assessment; display filters and limits do not change the result.',
    'Metadata only. Durations are observed intervals, not CPU time; parallel calls overlap.',
    'Completed is not proven success; incomplete is not proof of a running call. Compare similar workloads.',
    '', 'Session metrics (candidate minus baseline):',
  ];
  for (const metric of SESSION_COMPARE_METRICS) lines.push(`  ${metric}: ${change(report.metrics[metric])}`);
  lines.push('', `Tools: ${report.tools.length} shown, ${selection.matched_tools} match(es); ${assessment.latency_comparisons} fully measured comparison(s).`);
  if (!report.tools.length) lines.push('No tools matched this selection.');
  for (const tool of report.tools) {
    lines.push(`  ${toolName(tool.name, tool.namespace)} (${tool.presence}); latency comparable=${tool.latency_comparable}`);
    for (const metric of TOOL_COMPARE_METRICS) lines.push(`    ${metric}: ${change(tool.metrics[metric])}`);
  }
  if (selection.truncated) lines.push(`Showing ${report.tools.length} of ${selection.matched_tools} tools; increase --limit or use --tool/--namespace.`);
  if (assessment.regressions.length) {
    lines.push('', 'Regressions (whole sessions):');
    for (const regression of assessment.regressions) {
      lines.push(`  ${regression.scope === 'session' ? 'session' : toolName(regression.name, regression.namespace)} ${regression.metric}: ${change(regression.comparison)}`);
    }
  }
  if (assessment.gaps.length) {
    lines.push('', 'Evidence gaps:');
    for (const gap of assessment.gaps) lines.push(`  ${gap.side}: ${gap.code}=${gap.count}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function sessionCompareCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    console.log(HELP.trim());
    return;
  }
  const parsed = parseSessionCompareArgs(args);
  const report = await buildSessionComparison(parsed.options);
  const content = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatSessionComparison(report);
  if (parsed.output) {
    await writeFile(parsed.output, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    console.error(`Saved session comparison to ${plain(parsed.output)}`);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(content, (error) => error ? reject(error) : resolve());
    });
  }
  // Finish writing the report before the CLI entry point exits with this code.
  if (parsed.failOnRegression && report.assessment.status !== 'no_regression') {
    process.exitCode = report.assessment.status === 'regression' ? 2 : 3;
  }
}
