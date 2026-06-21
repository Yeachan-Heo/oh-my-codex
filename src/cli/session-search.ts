import { searchSessionHistory, type SessionSearchReport, type SessionSearchOptions } from '../session-history/search.js';

const HELP = `omx session - Search prior local session history

Usage:
  omx session search <query> [options]

Options:
  --limit <n>          Maximum results to return (default: 10)
  --session <id>       Restrict to a specific session id or id fragment
  --since <spec>       Restrict by recency (examples: 7d, 24h, 2026-03-10)
  --project <scope>    Filter by project context: current | all | <cwd-fragment>
  --codex-home <path>  Search only the supplied Codex home (escape hatch)
  --context <n>        Snippet context characters (default: 80)
  --case-sensitive     Match query using exact case
  --json               Emit structured JSON
  -h, --help           Show this help

Examples:
  omx session search "worker inbox path"
  omx session search all_workers_idle --since 7d --limit 5
  omx session search "team api" --project current --json
`;

const HELP_TOKENS = new Set(['--help', '-h', 'help']);

export interface ParsedSessionSearchArgs {
  options: SessionSearchOptions;
  json: boolean;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flag} value "${value}". Expected a non-negative integer.`);
  }
  return parsed;
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

export async function sessionCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || HELP_TOKENS.has(subcommand)) {
    console.log(HELP.trim());
    return;
  }

  if (subcommand !== 'search') {
    throw new Error(`Unknown session subcommand: ${subcommand}\n${HELP}`);
  }

  if (args.slice(1).some((token) => HELP_TOKENS.has(token))) {
    console.log(HELP.trim());
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
