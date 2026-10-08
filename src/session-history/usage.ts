import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { listRolloutFiles, parseSinceSpec, resolveSessionSearchCodexHomeDirs, type SessionSearchOptions } from './search.js';

export const SESSION_TOKEN_FIELDS = [
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens',
] as const;
export type SessionTokenField = typeof SESSION_TOKEN_FIELDS[number];
export type SessionTokenUsage = Record<SessionTokenField, number | null>;

export interface SessionUsageOptions extends Pick<SessionSearchOptions, 'cwd' | 'codexHomeDir' | 'codexHomeDirs' | 'since' | 'project' | 'session' | 'now'> {
  limit?: number;
  sort?: 'recent' | 'tokens';
}

export interface SessionUsageSummary {
  known: number | null;
  known_sessions: number;
  unknown_sessions: number;
}

export interface SessionUsageRow {
  session_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  usage_at: string | null;
  cwd_basename: string | null;
  cwd_hash: string | null;
  archived: boolean;
  transcript_copies: number;
  usage: SessionTokenUsage;
}

export interface SessionUsageReport {
  schema_version: 1;
  scope: 'session-cumulative';
  generated_at: string;
  matched_sessions: number;
  sessions_with_usage: number;
  truncated: boolean;
  totals: Record<SessionTokenField, SessionUsageSummary>;
  diagnostics: {
    scanned_files: number;
    skipped_files: number;
    malformed_records: number;
    invalid_usage_fields: number;
    duplicate_transcripts: number;
  };
  sessions: SessionUsageRow[];
}

type JsonRecord = Record<string, unknown>;
type Diagnostics = SessionUsageReport['diagnostics'];
interface Candidate {
  row: SessionUsageRow;
  project: string | null;
}

function object(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function time(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : Date.parse(value);
}

function emptyUsage(): SessionTokenUsage {
  return { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null, total_tokens: null };
}

function hasUsage(usage: SessionTokenUsage): boolean {
  return SESSION_TOKEN_FIELDS.some((field) => usage[field] !== null);
}

function readUsage(value: unknown, diagnostics: Diagnostics): SessionTokenUsage | null {
  const raw = object(value);
  if (!raw) return null;
  const usage = emptyUsage();
  for (const field of SESSION_TOKEN_FIELDS) {
    const count = raw[field];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[field] = count;
    else if (count !== undefined && count !== null) diagnostics.invalid_usage_fields++;
  }
  return hasUsage(usage) ? usage : null;
}

async function inspectTranscript(path: string, archived: boolean, diagnostics: Diagnostics): Promise<Candidate | null> {
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) return null;
    // Bound the read to this snapshot even while the session keeps appending.
    const stream = handle.createReadStream({ encoding: 'utf-8', end: info.size - 1, autoClose: false });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let candidate: Candidate | null = null;
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        let record: JsonRecord | null = null;
        try { record = object(JSON.parse(line)); } catch { /* Partial trailing records are ignored. */ }
        if (!record) {
          diagnostics.malformed_records++;
          if (!candidate) return null;
          continue;
        }
        const payload = object(record.payload);
        if (!candidate) {
          const id = string(payload?.id);
          if (record.type !== 'session_meta' || !id) return null;
          const project = string(payload?.cwd);
          const startedAt = timestamp(payload?.timestamp) ?? timestamp(record.timestamp);
          candidate = { project, row: {
            session_id: id, started_at: startedAt, last_activity_at: startedAt, usage_at: null,
            cwd_basename: project ? basename(project.replace(/\\/g, '/')) : null,
            cwd_hash: project ? createHash('sha256').update(project).digest('hex').slice(0, 12) : null,
            archived, transcript_copies: 1, usage: emptyUsage(),
          } };
        }
        const at = timestamp(record.timestamp) ?? timestamp(payload?.timestamp);
        if (time(at) > time(candidate.row.last_activity_at)) candidate.row.last_activity_at = at;
        if (record.type !== 'event_msg' || payload?.type !== 'token_count') continue;
        const usage = readUsage(object(payload.info)?.total_token_usage, diagnostics);
        if (usage) {
          // The last cumulative snapshot replaces earlier counters; last_token_usage
          // and repeated rate-limit events must never be summed into it.
          candidate.row.usage = usage;
          candidate.row.usage_at = at;
        }
      }
    } finally {
      reader.close();
      stream.destroy();
    }
    return candidate;
  } finally {
    await handle.close();
  }
}

function preferSnapshot(a: SessionUsageRow, b: SessionUsageRow): boolean {
  if (hasUsage(a.usage) !== hasUsage(b.usage)) return hasUsage(a.usage);
  if (time(a.usage_at) !== time(b.usage_at)) return time(a.usage_at) > time(b.usage_at);
  // Timestamp ties favor the more advanced recorded total, then field coverage.
  if (a.usage.total_tokens !== b.usage.total_tokens) return (a.usage.total_tokens ?? -1) > (b.usage.total_tokens ?? -1);
  return SESSION_TOKEN_FIELDS.filter((field) => a.usage[field] !== null).length
    > SESSION_TOKEN_FIELDS.filter((field) => b.usage[field] !== null).length;
}

async function matchesProject(project: string | null, filter: string | undefined, cwd: string): Promise<boolean> {
  if (!filter || filter === 'all') return true;
  if (!project) return false;
  if (filter !== 'current') return project.toLowerCase().includes(filter.toLowerCase());
  const [actual, expected] = await Promise.all([
    realpath(project).catch(() => resolve(project)),
    realpath(cwd).catch(() => resolve(cwd)),
  ]);
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

export function summarizeSessionUsage(rows: SessionUsageRow[]): Record<SessionTokenField, SessionUsageSummary> {
  return Object.fromEntries(SESSION_TOKEN_FIELDS.map((field) => {
    let known: number | null = null;
    let knownSessions = 0;
    for (const row of rows) {
      const value = row.usage[field];
      if (value === null) continue;
      known = (known ?? 0) + value;
      if (!Number.isSafeInteger(known)) throw new Error(`Session usage total exceeds the safe integer range: ${field}`);
      knownSessions++;
    }
    return [field, { known, known_sessions: knownSessions, unknown_sessions: rows.length - knownSessions }];
  })) as Record<SessionTokenField, SessionUsageSummary>;
}

export async function buildSessionUsageReport(options: SessionUsageOptions = {}): Promise<SessionUsageReport> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Session usage limit must be an integer between 1 and 500.');
  const sort = options.sort ?? 'recent';
  if (sort !== 'recent' && sort !== 'tokens') throw new Error('Session usage sort must be recent or tokens.');
  const now = options.now ?? Date.now();
  const cutoff = parseSinceSpec(options.since, now);
  if (cutoff !== null && !Number.isFinite(cutoff)) throw new Error('Invalid --since duration.');
  const diagnostics: Diagnostics = { scanned_files: 0, skipped_files: 0, malformed_records: 0, invalid_usage_fields: 0, duplicate_transcripts: 0 };
  const sessions = new Map<string, SessionUsageRow>();
  for (const home of await resolveSessionSearchCodexHomeDirs(options)) {
    for (const archived of [false, true]) {
      for (const path of await listRolloutFiles(join(home, archived ? 'archived_sessions' : 'sessions'), true)) {
        diagnostics.scanned_files++;
        const candidate = await inspectTranscript(path, archived, diagnostics);
        if (!candidate) { diagnostics.skipped_files++; continue; }
        const row = candidate.row;
        if (options.session && !row.session_id.toLowerCase().includes(options.session.toLowerCase())) continue;
        if (!await matchesProject(candidate.project, options.project, options.cwd ?? process.cwd())) continue;
        const existing = sessions.get(row.session_id);
        if (!existing) { sessions.set(row.session_id, row); continue; }
        diagnostics.duplicate_transcripts++;
        if (preferSnapshot(row, existing)) { existing.usage = row.usage; existing.usage_at = row.usage_at; }
        if (time(row.last_activity_at) > time(existing.last_activity_at)) existing.last_activity_at = row.last_activity_at;
        if (row.started_at !== null && (existing.started_at === null || time(row.started_at) < time(existing.started_at))) existing.started_at = row.started_at;
        existing.archived = existing.archived && row.archived;
        existing.transcript_copies++;
      }
    }
  }
  const rows = [...sessions.values()].filter((row) => cutoff === null || time(row.last_activity_at) >= cutoff);
  rows.sort((a, b) => {
    if (sort === 'tokens' && a.usage.total_tokens !== b.usage.total_tokens) return (b.usage.total_tokens ?? -1) - (a.usage.total_tokens ?? -1);
    if (time(a.last_activity_at) !== time(b.last_activity_at)) return time(b.last_activity_at) - time(a.last_activity_at);
    return a.session_id.localeCompare(b.session_id);
  });
  return {
    schema_version: 1, scope: 'session-cumulative', generated_at: new Date(now).toISOString(),
    matched_sessions: rows.length, sessions_with_usage: rows.filter((row) => hasUsage(row.usage)).length,
    truncated: rows.length > limit, totals: summarizeSessionUsage(rows), diagnostics,
    sessions: rows.slice(0, limit),
  };
}
