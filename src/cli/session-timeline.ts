import { writeFile } from 'node:fs/promises';
import { buildSessionTimeline, type SessionTimelineOptions, type SessionTimelineReport } from '../session-history/timeline.js';

const HELP = `Usage: omx session timeline <session-id> [options]

Inspect tool calls, turn boundaries, and compactions in a local active or archived session.
Use an exact session id or a unique prefix. Only metadata is displayed.

Options:
  --kind <kind>        all | tools | turns | compactions (default: all)
  --tool <name>        Select calls to an exact tool name
  --namespace <name>   Select calls in an exact tool namespace
  --status <status>    completed | failed | incomplete
  --min-duration <ms>  Select paired calls with at least this observed duration
  --sort <order>       chronological | duration (default: chronological)
  --offset <n>         Skip n matching events (default: 0)
  --limit <n>          Return 1-10000 matching events (default: 100)
  --codex-home <path>  Inspect only the supplied Codex home
  --json              Emit structured JSON
  --output <path>      Save to a new owner-only file; never overwrite existing files
  -h, --help           Show this help

Summary counts cover the whole session, before filters and pagination.
Durations measure call-to-result timestamps, not CPU time. Overlapping calls add up.
Completed means a result was recorded without an explicit failure, not proven success.
Incomplete means no uniquely matched result; it does not prove a call is still running.

Examples:
  omx session timeline <id>
  omx session timeline <id> --kind tools --sort duration --limit 10
  omx session timeline <id> --status failed --json --output failures.json
`;

export function parseSessionTimelineArgs(args: string[]): { options: SessionTimelineOptions; json: boolean; output?: string } {
  const parsed: { options: SessionTimelineOptions; json: boolean; output?: string } = { options: { session: '' }, json: false };
  const valuedFlags = new Set(['--kind', '--tool', '--namespace', '--status', '--min-duration', '--sort', '--offset', '--limit', '--codex-home', '--output']);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--json') { parsed.json = true; continue; }
    if (!token.startsWith('-')) {
      if (parsed.options.session) throw new Error(`Unexpected positional argument for timeline: ${token}`);
      parsed.options.session = token.trim();
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (!valuedFlags.has(flag)) throw new Error(`Unknown session timeline option: ${token}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value?.trim() || (separator < 0 && value.startsWith('-'))) throw new Error(`Missing value after ${flag}.`);
    switch (flag) {
      case '--kind':
        if (value !== 'all' && value !== 'tools' && value !== 'turns' && value !== 'compactions') {
          throw new Error('Invalid --kind: expected all, tools, turns, or compactions.');
        }
        parsed.options.kind = value;
        break;
      case '--status':
        if (value !== 'completed' && value !== 'failed' && value !== 'incomplete') {
          throw new Error('Invalid --status: expected completed, failed, or incomplete.');
        }
        parsed.options.status = value;
        break;
      case '--sort':
        if (value !== 'chronological' && value !== 'duration') throw new Error('Invalid --sort: expected chronological or duration.');
        parsed.options.sort = value;
        break;
      case '--limit':
      case '--offset':
      case '--min-duration': {
        const min = flag === '--limit' ? 1 : 0;
        const max = flag === '--limit' ? 10_000 : Number.MAX_SAFE_INTEGER;
        const number = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
          throw new Error(`Invalid ${flag}: expected an integer between ${min} and ${max}.`);
        }
        if (flag === '--limit') parsed.options.limit = number;
        else if (flag === '--offset') parsed.options.offset = number;
        else parsed.options.minDurationMs = number;
        break;
      }
      case '--tool': parsed.options.tool = value; break;
      case '--namespace': parsed.options.namespace = value; break;
      case '--codex-home': parsed.options.codexHomeDir = value; break;
      case '--output': parsed.output = value; break;
    }
  }
  if (!parsed.options.session) throw new Error(`Missing session id.\n${HELP}`);
  return parsed;
}

function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function duration(value: number | null): string {
  return value === null ? 'unknown' : `${value}ms`;
}

function toolName(name: string | null, namespace: string | null): string {
  const label = plain(name ?? '(unknown)');
  return namespace === null ? label : `${label} namespace=${plain(namespace)}`;
}

export function formatSessionTimeline(report: SessionTimelineReport): string {
  const { summary, selection, diagnostics } = report;
  const lines = [
    `Session timeline: ${plain(report.session_id)}${report.archived ? ' (archived)' : ''}`,
    `Started: ${report.started_at ?? 'unknown'}; last activity: ${report.last_activity_at ?? 'unknown'}; span: ${duration(report.duration_ms)}`,
    `Whole session: ${summary.tool_calls} tool call(s), ${summary.completed} completed, ${summary.failed} failed, ${summary.incomplete} incomplete, ${summary.orphan_outputs} orphan output(s).`,
    `Turns: ${summary.turns_started} started, ${summary.turns_completed} completed, ${summary.turns_aborted} aborted; compactions: ${summary.compactions}.`,
    'Metadata only. Completed is not proven success; incomplete is not proof of a running call.',
    'Durations are observed call-to-result intervals; parallel calls overlap.',
  ];
  if (summary.tools.length) {
    lines.push('', 'Tools (whole session):');
    for (const tool of summary.tools) {
      lines.push(`  ${toolName(tool.name, tool.namespace)}: calls=${tool.calls} completed=${tool.completed} failed=${tool.failed} incomplete=${tool.incomplete} measured=${tool.measured_calls} total=${duration(tool.total_duration_ms)} max=${duration(tool.max_duration_ms)}`);
    }
  }
  lines.push('', `Events: ${report.events.length} shown, ${selection.matched_events} match(es), offset=${selection.offset}, sort=${selection.sort}.`);
  if (!report.events.length) lines.push('No events matched this page.');
  for (const event of report.events) {
    const prefix = `L${event.line_number} ${event.timestamp ?? 'unknown'} ${event.kind}`;
    if (event.kind === 'tool') {
      lines.push(`${prefix} ${toolName(event.name, event.namespace)} ${event.status} duration=${duration(event.duration_ms)} call=${plain(event.call_id ?? '(missing)')} result=${event.result_line_number === null ? 'none' : `L${event.result_line_number}`}${event.exit_code === null ? '' : ` exit=${event.exit_code}`}`);
    } else if (event.kind === 'orphan_output') {
      lines.push(`${prefix} ${event.status} call=${plain(event.call_id ?? '(missing)')}${event.exit_code === null ? '' : ` exit=${event.exit_code}`}`);
    } else if (event.kind === 'compaction') lines.push(prefix);
    else lines.push(`${prefix} turn=${plain(event.turn_id ?? '(unknown)')}`);
  }
  if (selection.has_more) lines.push(`More events available; use --offset ${selection.offset + report.events.length} with the same filters and sort.`);
  if (Object.values(diagnostics).some((count) => count > 0)) {
    lines.push('', `Read gaps: malformed=${diagnostics.malformed_records} invalid_timestamps=${diagnostics.invalid_timestamps} reversed_tool_timestamps=${diagnostics.reversed_tool_timestamps} ambiguous_call_ids=${diagnostics.ambiguous_call_ids}.`);
  }
  return `${lines.join('\n')}\n`;
}

export async function sessionTimelineCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    console.log(HELP.trim());
    return;
  }
  const parsed = parseSessionTimelineArgs(args);
  const report = await buildSessionTimeline(parsed.options);
  const content = parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatSessionTimeline(report);
  if (parsed.output) {
    await writeFile(parsed.output, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    console.error(`Saved session timeline to ${plain(parsed.output)}`);
  } else {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(content, (error) => error ? reject(error) : resolve());
    });
  }
}
