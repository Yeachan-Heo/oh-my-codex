import { buildSessionUsageReport, SESSION_TOKEN_FIELDS, type SessionUsageOptions, type SessionUsageReport } from '../session-history/usage.js';

const HELP = `Usage: omx session usage [options]

Summarize recorded cumulative token usage for local active and archived sessions.
Cached input and reasoning output are subsets, not additional tokens or billing estimates.

Options:
  --since <spec>       Select sessions active since 7d, 24h, or an ISO date (default: all)
  --project <scope>    current | all | <cwd-fragment> (default: all)
  --session <id>       Filter by session id or id fragment
  --limit <n>          Show 1-500 sessions (default: 20); totals include all matches
  --sort <order>       recent | tokens (default: recent)
  --codex-home <path>  Inspect only the supplied Codex home
  --json               Emit structured JSON with per-field measurement coverage
  -h, --help           Show this help

--since selects sessions by activity, not token consumption within a billing period.
The report excludes message text, tool arguments/outputs, and full filesystem paths.
`;

export function parseSessionUsageArgs(args: string[]): { options: SessionUsageOptions; json: boolean } {
  const options: SessionUsageOptions = {};
  let json = false;
  const valuedFlags = new Set(['--since', '--project', '--session', '--limit', '--sort', '--codex-home']);
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--json') { json = true; continue; }
    const separator = token.indexOf('=');
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (!valuedFlags.has(flag)) throw new Error(`Unknown session usage argument: ${token}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value?.trim() || (separator < 0 && value.startsWith('-'))) throw new Error(`Missing value after ${flag}.`);
    switch (flag) {
      case '--since': options.since = value; break;
      case '--project': options.project = value; break;
      case '--session': options.session = value; break;
      case '--codex-home': options.codexHomeDir = value; break;
      case '--limit':
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 500) {
          throw new Error('Invalid --limit: expected an integer between 1 and 500.');
        }
        options.limit = Number(value);
        break;
      case '--sort':
        if (value !== 'recent' && value !== 'tokens') throw new Error('Invalid --sort: expected recent or tokens.');
        options.sort = value;
        break;
    }
  }
  return { options, json };
}

function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function formatSessionUsageReport(report: SessionUsageReport): string {
  const lines = [
    'Session token usage (recorded cumulative counters; not a billing estimate)',
    `${report.matched_sessions} matched session(s); ${report.sessions_with_usage} with recorded usage.`,
    'Cached input and reasoning output are subsets of input and output.',
  ];
  for (const field of SESSION_TOKEN_FIELDS) {
    const total = report.totals[field];
    lines.push(`${field}: ${total.known ?? 'unknown'} (${total.known_sessions} known, ${total.unknown_sessions} unknown sessions)`);
  }
  for (const row of report.sessions) {
    lines.push('', `session: ${plain(row.session_id)}${row.archived ? ' (archived)' : ''}`);
    lines.push(`project: ${plain(row.cwd_basename ?? 'unknown')} (${row.cwd_hash ?? 'unknown'})`);
    lines.push(`last activity: ${row.last_activity_at ?? 'unknown'}; usage snapshot: ${row.usage_at ?? 'unknown'}`);
    lines.push(SESSION_TOKEN_FIELDS.map((field) => `${field}=${row.usage[field] ?? 'unknown'}`).join(' '));
  }
  if (report.truncated) lines.push('', `Showing ${report.sessions.length} of ${report.matched_sessions} sessions; totals include all matches.`);
  if (report.diagnostics.malformed_records || report.diagnostics.skipped_files || report.diagnostics.invalid_usage_fields) {
    lines.push('', `Read gaps: ${report.diagnostics.skipped_files} skipped file(s), ${report.diagnostics.malformed_records} malformed record(s), ${report.diagnostics.invalid_usage_fields} invalid usage field(s).`);
  }
  return lines.join('\n');
}

export async function sessionUsageCommand(args: string[]): Promise<void> {
  if (args.some((arg) => arg === '--help' || arg === '-h') || args[0] === 'help') {
    console.log(HELP.trim());
    return;
  }
  const parsed = parseSessionUsageArgs(args);
  const report = await buildSessionUsageReport(parsed.options);
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatSessionUsageReport(report));
}
