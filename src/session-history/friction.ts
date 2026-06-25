import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { discoverProjectRuntimeCodexHomes } from '../cli/project-runtime-codex-homes.js';
import { codexHome } from '../utils/paths.js';
import { parseSinceSpec } from './search.js';

type JsonRecord = Record<string, unknown>;

export interface SessionFrictionOptions {
  limit?: number;
  session?: string;
  since?: string;
  project?: string;
  cwd?: string;
  now?: number;
  codexHomeDir?: string;
  codexHomeDirs?: string[];
}

export interface SessionFrictionSourceReport {
  codex_home: string;
  scanned_files: number;
}

export interface SessionFrictionRisk {
  code: string;
  severity: 'info' | 'warn' | 'high';
  message: string;
}

export interface SessionFrictionSessionReport {
  session_id: string;
  started_at: string | null;
  last_activity_at: string | null;
  age_minutes: number | null;
  idle_minutes: number | null;
  cwd_basename: string | null;
  cwd_hash: string | null;
  source: {
    codex_home: string;
    transcript_ref: string;
  };
  counters: {
    records: number;
    malformed_records: number;
    bytes: number;
    user_turns: number;
    assistant_turns: number;
    tool_calls: number;
    tool_outputs: number;
  };
  context_growth: {
    approx_transcript_kb: number;
    avg_record_bytes: number;
    tool_call_ratio: number;
  };
  idle_gaps: {
    max_gap_minutes: number | null;
    gaps_over_30m: number;
    gaps_over_2h: number;
  };
  tool_names: Array<{ name: string; count: number }>;
  risks: SessionFrictionRisk[];
}

export interface SessionFrictionReport {
  generated_at: string;
  privacy: {
    mode: 'metadata-only';
    excludes: string[];
  };
  scanned_files: number;
  sources: SessionFrictionSourceReport[];
  sessions: SessionFrictionSessionReport[];
}

interface ResolvedCodexHomeSource {
  dir: string;
  publicLabel: string;
}

interface SessionMeta {
  sessionId: string;
  timestamp: string | null;
  cwd: string | null;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const DEFAULT_SINCE = '14d';
const DANGER_BYTES = 1_500_000;
const WARN_BYTES = 750_000;
const DANGER_RECORDS = 5000;
const WARN_RECORDS = 2500;
const STALE_MINUTES = 24 * 60;
const OLD_SESSION_MINUTES = 7 * 24 * 60;

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value == null || value <= 0) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

function safeParseJson(line: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asObject(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function extractSessionMeta(parsed: JsonRecord | null): SessionMeta | null {
  if (!parsed || parsed.type !== 'session_meta') return null;
  const payload = asObject(parsed.payload);
  if (!payload) return null;
  const sessionId = asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    timestamp: asString(payload.timestamp) ?? asString(parsed.timestamp),
    cwd: asString(payload.cwd),
  };
}

function extractRecordTimestamp(parsed: JsonRecord | null): number | null {
  if (!parsed) return null;
  const candidates = [
    asString(parsed.timestamp),
    asString(asObject(parsed.payload)?.timestamp),
    asString(asObject(parsed.payload)?.created_at),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const value = Date.parse(candidate);
    if (!Number.isNaN(value)) return value;
  }
  return null;
}

function normalizeProjectFilter(project: string | undefined, cwd: string): string | undefined {
  if (!project) return undefined;
  const trimmed = project.trim();
  if (trimmed === '' || trimmed === 'all') return undefined;
  if (trimmed === 'current') return cwd;
  return trimmed;
}

function normalizeDarwinPathAlias(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function matchesFilter(value: string | null, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!value) return false;
  return normalizeDarwinPathAlias(value).toLowerCase().includes(normalizeDarwinPathAlias(filter).toLowerCase());
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function publicCwdBasename(cwd: string | null): string | null {
  if (!cwd) return null;
  return basename(cwd) || null;
}

function roundMinutes(ms: number): number {
  return Math.round(ms / 60_000);
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

async function normalizeExistingCodexHomeDirs(candidates: Array<string | ResolvedCodexHomeSource>): Promise<ResolvedCodexHomeSource[]> {
  const seen = new Set<string>();
  const dirs: ResolvedCodexHomeSource[] = [];
  for (const candidate of candidates) {
    const rawDir = typeof candidate === 'string' ? candidate : candidate.dir;
    const trimmed = rawDir.trim();
    if (trimmed === '') continue;
    const absolute = resolve(trimmed);
    if (!existsSync(absolute)) continue;
    const key = await realpath(absolute).catch(() => absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({
      dir: absolute,
      publicLabel: typeof candidate === 'string' ? 'codex-home' : candidate.publicLabel,
    });
  }
  return dirs;
}

async function resolveCodexHomeSources(options: Pick<SessionFrictionOptions, 'cwd' | 'codexHomeDir' | 'codexHomeDirs'>): Promise<ResolvedCodexHomeSource[]> {
  const cwd = options.cwd ?? process.cwd();
  if (options.codexHomeDirs && options.codexHomeDirs.length > 0) {
    return normalizeExistingCodexHomeDirs(options.codexHomeDirs);
  }
  if (options.codexHomeDir) {
    return normalizeExistingCodexHomeDirs([{ dir: options.codexHomeDir, publicLabel: 'explicit-codex-home' }]);
  }
  const projectHomes = await discoverProjectRuntimeCodexHomes(cwd);
  return normalizeExistingCodexHomeDirs([
    { dir: codexHome(), publicLabel: 'default-codex-home' },
    ...projectHomes.map((home) => ({
      dir: home.path,
      publicLabel: home.source === 'madmax-run' ? home.publicLabel ?? 'madmax:runtime-codex-home' : 'project-runtime-codex-home',
    })),
  ]);
}

async function listRolloutFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) files.push(path);
    }
  }
  return files;
}

function buildRisks(input: {
  records: number;
  bytes: number;
  malformedRecords: number;
  idleMinutes: number | null;
  ageMinutes: number | null;
  toolCalls: number;
  userTurns: number;
  maxGapMinutes: number | null;
}): SessionFrictionRisk[] {
  const risks: SessionFrictionRisk[] = [];
  if (input.bytes >= DANGER_BYTES || input.records >= DANGER_RECORDS) {
    risks.push({ code: 'context_bloat_high', severity: 'high', message: 'Transcript metadata suggests a very large continuation context.' });
  } else if (input.bytes >= WARN_BYTES || input.records >= WARN_RECORDS) {
    risks.push({ code: 'context_bloat_watch', severity: 'warn', message: 'Transcript metadata suggests growing continuation context.' });
  }
  if (input.idleMinutes != null && input.idleMinutes >= STALE_MINUTES) {
    risks.push({ code: 'stale_session', severity: 'warn', message: 'Last observed activity is more than 24 hours old.' });
  }
  if (input.ageMinutes != null && input.ageMinutes >= OLD_SESSION_MINUTES) {
    risks.push({ code: 'long_running_session', severity: 'warn', message: 'Session began more than 7 days ago.' });
  }
  if (input.maxGapMinutes != null && input.maxGapMinutes >= 120) {
    risks.push({ code: 'large_idle_gap', severity: 'info', message: 'Session contains idle gaps over 2 hours, which can make continuation state stale.' });
  }
  if (input.toolCalls >= 100 || (input.userTurns > 0 && input.toolCalls / input.userTurns >= 10)) {
    risks.push({ code: 'tool_heavy', severity: 'warn', message: 'Tool-call volume is high relative to user turns.' });
  }
  if (input.malformedRecords > 0) {
    risks.push({ code: 'parse_gaps', severity: 'info', message: 'Some transcript records could not be parsed as JSON.' });
  }
  if (risks.length === 0) {
    risks.push({ code: 'no_obvious_friction', severity: 'info', message: 'No obvious size, staleness, or tool-volume risk crossed default thresholds.' });
  }
  return risks;
}

async function inspectRolloutFile(filePath: string, source: ResolvedCodexHomeSource, options: { now: number; projectFilter?: string; session?: string; sinceCutoff: number | null }): Promise<SessionFrictionSessionReport | null> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat) return null;
  if (options.sinceCutoff != null && fileStat.mtimeMs < options.sinceCutoff) return null;

  const stream = createReadStream(filePath, 'utf-8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let meta: SessionMeta | null = null;
  let records = 0;
  let malformedRecords = 0;
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let toolOutputs = 0;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let maxGapMs = 0;
  let gapsOver30m = 0;
  let gapsOver2h = 0;
  const toolNames = new Map<string, number>();

  try {
    for await (const line of reader) {
      if (line.trim() === '') continue;
      records += 1;
      const parsed = safeParseJson(line);
      if (!parsed) malformedRecords += 1;
      if (records === 1) {
        meta = extractSessionMeta(parsed) ?? { sessionId: filePath.split('rollout-')[1]?.replace(/\.jsonl$/, '') ?? basename(filePath, '.jsonl'), timestamp: null, cwd: null };
        if (!matchesFilter(meta.sessionId, options.session)) return null;
        if (!matchesFilter(meta.cwd, options.projectFilter)) return null;
      }

      const timestamp = extractRecordTimestamp(parsed);
      if (timestamp != null) {
        if (firstTimestamp == null) firstTimestamp = timestamp;
        if (lastTimestamp != null && timestamp > lastTimestamp) {
          const gap = timestamp - lastTimestamp;
          maxGapMs = Math.max(maxGapMs, gap);
          if (gap >= 30 * 60_000) gapsOver30m += 1;
          if (gap >= 120 * 60_000) gapsOver2h += 1;
        }
        lastTimestamp = Math.max(lastTimestamp ?? timestamp, timestamp);
      }

      const type = asString(parsed?.type);
      const payload = asObject(parsed?.payload);
      const payloadType = asString(payload?.type);
      if (type === 'event_msg' && payloadType === 'user_message') userTurns += 1;
      if (type === 'response_item' && payloadType === 'message') {
        const role = asString(payload?.role);
        if (role === 'user') userTurns += 1;
        if (role === 'assistant') assistantTurns += 1;
      }
      if (type === 'response_item' && payloadType === 'function_call') {
        toolCalls += 1;
        const name = asString(payload?.name);
        if (name) toolNames.set(name, (toolNames.get(name) ?? 0) + 1);
      }
      if (type === 'response_item' && payloadType === 'function_call_output') toolOutputs += 1;
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  if (!meta) return null;
  const startedAt = meta.timestamp ? Date.parse(meta.timestamp) : firstTimestamp;
  const lastActivity = lastTimestamp ?? startedAt ?? fileStat.mtimeMs;
  const ageMinutes = startedAt != null && !Number.isNaN(startedAt) ? Math.max(0, roundMinutes(options.now - startedAt)) : null;
  const idleMinutes = lastActivity != null && !Number.isNaN(lastActivity) ? Math.max(0, roundMinutes(options.now - lastActivity)) : null;
  const maxGapMinutes = maxGapMs > 0 ? roundMinutes(maxGapMs) : null;

  return {
    session_id: meta.sessionId,
    started_at: startedAt != null && !Number.isNaN(startedAt) ? new Date(startedAt).toISOString() : null,
    last_activity_at: lastActivity != null && !Number.isNaN(lastActivity) ? new Date(lastActivity).toISOString() : null,
    age_minutes: ageMinutes,
    idle_minutes: idleMinutes,
    cwd_basename: publicCwdBasename(meta.cwd),
    cwd_hash: meta.cwd ? stableHash(meta.cwd) : null,
    source: {
      codex_home: source.publicLabel,
      transcript_ref: stableHash(`${source.dir}\0${filePath}`),
    },
    counters: {
      records,
      malformed_records: malformedRecords,
      bytes: fileStat.size,
      user_turns: userTurns,
      assistant_turns: assistantTurns,
      tool_calls: toolCalls,
      tool_outputs: toolOutputs,
    },
    context_growth: {
      approx_transcript_kb: roundOne(fileStat.size / 1024),
      avg_record_bytes: records > 0 ? Math.round(fileStat.size / records) : 0,
      tool_call_ratio: userTurns > 0 ? roundOne(toolCalls / userTurns) : toolCalls,
    },
    idle_gaps: {
      max_gap_minutes: maxGapMinutes,
      gaps_over_30m: gapsOver30m,
      gaps_over_2h: gapsOver2h,
    },
    tool_names: [...toolNames.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([name, count]) => ({ name, count })),
    risks: buildRisks({
      records,
      bytes: fileStat.size,
      malformedRecords,
      idleMinutes,
      ageMinutes,
      toolCalls,
      userTurns,
      maxGapMinutes,
    }),
  };
}

export async function buildSessionFrictionReport(options: SessionFrictionOptions = {}): Promise<SessionFrictionReport> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now();
  const limit = clampLimit(options.limit);
  const sinceCutoff = parseSinceSpec(options.since ?? DEFAULT_SINCE, now);
  const projectFilter = normalizeProjectFilter(options.project ?? 'current', cwd);
  const sources = await resolveCodexHomeSources({ cwd, codexHomeDir: options.codexHomeDir, codexHomeDirs: options.codexHomeDirs });
  const sessions: SessionFrictionSessionReport[] = [];
  const sourceReports: SessionFrictionSourceReport[] = [];
  let scannedFiles = 0;

  for (const source of sources) {
    const rolloutRoot = join(source.dir, 'sessions');
    const files = (await listRolloutFiles(rolloutRoot)).sort((a, b) => b.localeCompare(a));
    let sourceScanned = 0;
    for (const filePath of files) {
      if (sessions.length >= limit) break;
      sourceScanned += 1;
      scannedFiles += 1;
      const session = await inspectRolloutFile(filePath, source, {
        now,
        projectFilter,
        session: options.session,
        sinceCutoff,
      });
      if (session) sessions.push(session);
    }
    sourceReports.push({ codex_home: source.publicLabel, scanned_files: sourceScanned });
  }

  sessions.sort((a, b) => Date.parse(b.last_activity_at ?? '') - Date.parse(a.last_activity_at ?? ''));

  return {
    generated_at: new Date(now).toISOString(),
    privacy: {
      mode: 'metadata-only',
      excludes: ['raw_prompts', 'raw_messages', 'tool_arguments', 'tool_outputs', 'tokens', 'full_transcripts', 'private_config_values'],
    },
    scanned_files: scannedFiles,
    sources: sourceReports,
    sessions: sessions.slice(0, limit),
  };
}
