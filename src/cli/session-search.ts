import { inspectSessionPointerLock, recoverSessionPointerLock } from '../hooks/session.js';
import { buildSessionFrictionReport, type SessionFrictionReport, type SessionFrictionOptions } from '../session-history/friction.js';
import { searchSessionHistory, type SessionSearchReport, type SessionSearchOptions } from '../session-history/search.js';

const HELP = `omx session - Search and summarize local session history

Usage:
  omx session search <query> [options]
  omx session friction [options]
  omx session lock <inspect|recover> [--cwd <path>] [--json]

Options for search:
  --limit <n>          Maximum results to return (default: 10)
  --session <id>       Restrict to a specific session id or id fragment
  --since <spec>       Restrict by recency (examples: 7d, 24h, 2026-03-10)
  --project <scope>    Filter by project context: current | all | <cwd-fragment>
  --codex-home <path>  Search only the supplied Codex home (escape hatch)
  --context <n>        Snippet context characters (default: 80)
  --case-sensitive     Match query using exact case
  --json               Emit structured JSON
  -h, --help           Show this help

Options for friction:
  --limit <n>          Maximum sessions to inspect (default: 5)
  --session <id>       Restrict to a specific session id or id fragment
  --since <spec>       Restrict by recency (default: 14d)
  --project <scope>    Filter by project context: current | all | <cwd-fragment>
  --codex-home <path>  Inspect only the supplied Codex home (escape hatch)
  --json               Emit structured JSON

Options for lock:
  --cwd <path>         Inspect or recover the session pointer lock for this directory
  --json               Emit structured JSON
  -h, --help           Show this help

Examples:
  omx session search "worker inbox path"
  omx session search all_workers_idle --since 7d --limit 5
  omx session friction --project current
  omx session friction --session <id> --json
  omx session lock inspect --json
  omx session lock recover --cwd /path/to/project
`;

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

export interface ParsedSessionSearchArgs {
  options: SessionSearchOptions;
  json: boolean;
}

export interface ParsedSessionFrictionArgs {
  options: SessionFrictionOptions;
  json: boolean;
}

export interface ParsedSessionLockArgs {
  cwd: string;
  json: boolean;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag} value "${value}". Expected a non-negative integer.`);
  }
  return parsed;
}

export function parseSessionLockArgs(args: string[]): ParsedSessionLockArgs {
  let cwd = process.cwd();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--cwd') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value after --cwd.');
      }
      cwd = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--cwd=')) {
      const value = token.slice('--cwd='.length);
      if (!value) {
        throw new Error('Missing value after --cwd.');
      }
      cwd = value;
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unexpected positional argument for lock: ${token}`);
  }

  return { cwd, json };
}

export function parseSessionSearchArgs(args: string[]): ParsedSessionSearchArgs {
  const options: SessionSearchOptions = {
    query: '',
  };
  let json = false;
  const queryTokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--case-sensitive') {
      options.caseSensitive = true;
      continue;
    }
    if (token === '--limit' || token === '--session' || token === '--since' || token === '--project' || token === '--context' || token === '--codex-home') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value after ${token}.`);
      }
      if (token === '--limit') options.limit = parsePositiveInteger(next, token);
      if (token === '--session') options.session = next;
      if (token === '--since') options.since = next;
      if (token === '--project') options.project = next;
      if (token === '--context') options.context = parsePositiveInteger(next, token);
      if (token === '--codex-home') options.codexHomeDir = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(token.slice('--limit='.length), '--limit');
      continue;
    }
    if (token.startsWith('--session=')) {
      options.session = token.slice('--session='.length);
      continue;
    }
    if (token.startsWith('--since=')) {
      options.since = token.slice('--since='.length);
      continue;
    }
    if (token.startsWith('--project=')) {
      options.project = token.slice('--project='.length);
      continue;
    }
    if (token.startsWith('--context=')) {
      options.context = parsePositiveInteger(token.slice('--context='.length), '--context');
      continue;
    }
    if (token.startsWith('--codex-home=')) {
      options.codexHomeDir = token.slice('--codex-home='.length);
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }
    queryTokens.push(token);
  }

  options.query = queryTokens.join(' ').trim();
  if (options.query === '') {
    throw new Error(`Missing search query.\n${HELP}`);
  }

  return { options, json };
}

export function parseSessionFrictionArgs(args: string[]): ParsedSessionFrictionArgs {
  const options: SessionFrictionOptions = {};
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--limit' || token === '--session' || token === '--since' || token === '--project' || token === '--codex-home') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value after ${token}.`);
      }
      if (token === '--limit') options.limit = parsePositiveInteger(next, token);
      if (token === '--session') options.session = next;
      if (token === '--since') options.since = next;
      if (token === '--project') options.project = next;
      if (token === '--codex-home') options.codexHomeDir = next;
      index += 1;
      continue;
    }
    if (token.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(token.slice('--limit='.length), '--limit');
      continue;
    }
    if (token.startsWith('--session=')) {
      options.session = token.slice('--session='.length);
      continue;
    }
    if (token.startsWith('--since=')) {
      options.since = token.slice('--since='.length);
      continue;
    }
    if (token.startsWith('--project=')) {
      options.project = token.slice('--project='.length);
      continue;
    }
    if (token.startsWith('--codex-home=')) {
      options.codexHomeDir = token.slice('--codex-home='.length);
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown option: ${token}`);
    }
    throw new Error(`Unexpected positional argument for friction report: ${token}`);
  }

  return { options, json };
}


function formatReport(report: SessionSearchReport): string {
  if (report.results.length === 0) {
    return `No session history matches for "${report.query}". Searched ${report.searched_files} transcript(s).`;
  }

  const lines = [
    `Found ${report.results.length} match(es) across ${report.matched_sessions} session(s) in ${report.searched_files} transcript(s).`,
  ];

  for (const result of report.results) {
    lines.push('');
    lines.push(`session: ${result.session_id}`);
    lines.push(`time: ${result.timestamp ?? 'unknown'}`);
    lines.push(`cwd: ${result.cwd ?? 'unknown'}`);
    lines.push(`source: ${result.transcript_path}:${result.line_number} (${result.record_type})`);
    lines.push(`snippet: ${result.snippet}`);
  }

  return lines.join('\n');
}

function formatFrictionReport(report: SessionFrictionReport): string {
  const lines = [
    `Session friction report (${report.privacy.mode}; excludes ${report.privacy.excludes.join(', ')}).`,
    `Scanned ${report.scanned_files} transcript(s) across ${report.sources.length} source(s).`,
  ];

  if (report.sessions.length === 0) {
    lines.push('No recent local sessions matched the filters.');
    return lines.join('\n');
  }

  for (const session of report.sessions) {
    lines.push('');
    lines.push(`session: ${session.session_id}`);
    lines.push(`cwd: ${session.cwd_basename ?? 'unknown'} (${session.cwd_hash ? `hash:${session.cwd_hash}` : 'hash:unknown'})`);
    lines.push(`activity: started=${session.started_at ?? 'unknown'} last=${session.last_activity_at ?? 'unknown'} idle=${session.idle_minutes ?? 'unknown'}m age=${session.age_minutes ?? 'unknown'}m`);
    lines.push(`counts: records=${session.counters.records} user_turns=${session.counters.user_turns} assistant_turns=${session.counters.assistant_turns} tool_calls=${session.counters.tool_calls} tool_outputs=${session.counters.tool_outputs}`);
    lines.push(`size: approx=${session.context_growth.approx_transcript_kb}KB avg_record=${session.context_growth.avg_record_bytes}B tool_ratio=${session.context_growth.tool_call_ratio}`);
    lines.push(`idle_gaps: max=${session.idle_gaps.max_gap_minutes ?? 'none'}m over_30m=${session.idle_gaps.gaps_over_30m} over_2h=${session.idle_gaps.gaps_over_2h}`);
    if (session.tool_names.length > 0) {
      lines.push(`tools: ${session.tool_names.map((tool) => `${tool.name}(${tool.count})`).join(', ')}`);
    }
    lines.push(`risks: ${session.risks.map((risk) => `${risk.severity}:${risk.code}`).join(', ')}`);
    lines.push(`source: ${session.source.codex_home}:ref:${session.source.transcript_ref}`);
  }

  return lines.join('\n');
}


function formatLockResult(result: {
  status: string;
  lockPath: string;
  evidenceSource: string;
  safeToRecover: boolean;
  evidencePath?: string;
  action?: string;
  recovered?: boolean;
  reason?: string;
  quarantinePath?: string;
}): string {
  const lines = [
    `status: ${result.status}`,
    `lock: ${result.lockPath}`,
    `evidence: ${result.evidenceSource}`,
    `safe to recover: ${result.safeToRecover ? 'yes' : 'no'}`,
  ];
  if (result.action) lines.push(`action: ${result.action}`);
  if (result.recovered !== undefined) lines.push(`recovered: ${result.recovered ? 'yes' : 'no'}`);
  if (result.reason) lines.push(`reason: ${result.reason}`);
  if (result.evidencePath) lines.push(`evidence path: ${result.evidencePath}`);
  if (result.quarantinePath) lines.push(`quarantine: ${result.quarantinePath}`);
  return lines.join('\n');
}

async function sessionLockCommand(args: string[]): Promise<void> {
  const operation = args[0];
  if (!operation || HELP_TOKENS.has(operation)) {
    console.log(`Usage: omx session lock <inspect|recover> [--cwd <path>] [--json]`);
    return;
  }
  if (operation !== 'inspect' && operation !== 'recover') {
    throw new Error(`Unknown session lock operation: ${operation}`);
  }
  if (args.slice(1).some((token) => HELP_TOKENS.has(token))) {
    console.log(`Usage: omx session lock ${operation} [--cwd <path>] [--json]`);
    return;
  }

  const parsed = parseSessionLockArgs(args.slice(1));
  const result = operation === 'inspect'
    ? await inspectSessionPointerLock(parsed.cwd)
    : await recoverSessionPointerLock(parsed.cwd);
  console.log(parsed.json ? JSON.stringify(result, null, 2) : formatLockResult(result));

  if (operation === 'recover' && result.status !== 'absent' && (!('recovered' in result) || result.recovered !== true)) {
    process.exitCode = 1;
  }
}

export async function sessionCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || HELP_TOKENS.has(subcommand)) {
    console.log(HELP.trim());
    return;
  }

  if (subcommand === 'lock') {
    await sessionLockCommand(args.slice(1));
    return;
  }

  if (subcommand !== 'search' && subcommand !== 'friction') {
    throw new Error(`Unknown session subcommand: ${subcommand}\n${HELP}`);
  }

  if (args.slice(1).some((token) => HELP_TOKENS.has(token))) {
    console.log(HELP.trim());
    return;
  }

  if (subcommand === 'friction') {
    const parsed = parseSessionFrictionArgs(args.slice(1));
    const report = await buildSessionFrictionReport(parsed.options);
    if (parsed.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatFrictionReport(report));
    return;
  }

  const parsed = parseSessionSearchArgs(args.slice(1));
  const report = await searchSessionHistory(parsed.options);
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatReport(report));
}
