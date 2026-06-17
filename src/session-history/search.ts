import { createReadStream, existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codexHome } from '../utils/paths.js';
import { discoverProjectRuntimeCodexHomes } from '../cli/project-runtime-codex-homes.js';
type JsonRecord = Record<string, unknown>;

export interface SessionSearchOptions {
  query: string;
  limit?: number;
  session?: string;
  since?: string;
  project?: string;
  context?: number;
  caseSensitive?: boolean;
  cwd?: string;
  now?: number;
  codexHomeDir?: string;
  codexHomeDirs?: string[];
}

export interface SessionSearchResult {
  session_id: string;
  timestamp: string | null;
  cwd: string | null;
  transcript_path: string;
  transcript_path_relative: string;
  record_type: string;
  line_number: number;
  snippet: string;
}

export interface SessionSearchReport {
  query: string;
  searched_files: number;
  matched_sessions: number;
  results: SessionSearchResult[];
  sources: SessionSearchSourceReport[];
}
interface SessionMeta {
  sessionId: string;
  timestamp: string | null;
  cwd: string | null;
}

interface SearchableText {
  text: string;
  recordType: string;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_CONTEXT = 80;
const MAX_LIMIT = 100;
const MAX_CONTEXT = 400;
const DURATION_RE = /^(\d+)([smhdw])$/i;

export interface SessionSearchSourceReport {
  codex_home: string;
  searched_files: number;
}
interface ResolvedSessionSearchCodexHome {
  dir: string;
  publicLabel: string;
}


function clampInteger(value: number, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

async function normalizeExistingCodexHomeDirs(candidates: Array<string | ResolvedSessionSearchCodexHome>): Promise<ResolvedSessionSearchCodexHome[]> {
  const seen = new Set<string>();
  const dirs: ResolvedSessionSearchCodexHome[] = [];
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
      publicLabel: typeof candidate === 'string' ? absolute : candidate.publicLabel,
    });
  }
  return dirs;
}

async function resolveSessionSearchCodexHomeSources(options: Pick<SessionSearchOptions, 'cwd' | 'codexHomeDir' | 'codexHomeDirs'> = {}): Promise<ResolvedSessionSearchCodexHome[]> {
  const cwd = options.cwd ?? process.cwd();
  if (options.codexHomeDirs && options.codexHomeDirs.length > 0) {
    return normalizeExistingCodexHomeDirs(options.codexHomeDirs);
  }
  if (options.codexHomeDir) {
    return normalizeExistingCodexHomeDirs([options.codexHomeDir]);
  }
  const projectHomes = await discoverProjectRuntimeCodexHomes(cwd);
  return normalizeExistingCodexHomeDirs([
    codexHome(),
    ...projectHomes.map((home) => ({
      dir: home.path,
      publicLabel: home.source === 'madmax-run' ? home.publicLabel ?? 'madmax:runtime-codex-home' : home.path,
    })),
  ]);
}

export async function resolveSessionSearchCodexHomeDirs(options: Pick<SessionSearchOptions, 'cwd' | 'codexHomeDir' | 'codexHomeDirs'> = {}): Promise<string[]> {
  return (await resolveSessionSearchCodexHomeSources(options)).map((source) => source.dir);
}
function normalizeProjectFilter(project: string | undefined, cwd: string): string | undefined {
  if (!project) return undefined;
  const trimmed = project.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'current') return cwd;
  if (trimmed === 'all') return undefined;
  return trimmed;
}

export function parseSinceSpec(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const durationMatch = DURATION_RE.exec(trimmed);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return now - amount * multipliers[unit];
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) return timestamp;
  throw new Error(`Invalid --since value "${value}". Use formats like 7d, 24h, or 2026-03-10.`);
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
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(path);
      }
    }
  }

  return files.sort((a, b) => b.localeCompare(a));
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

function collectTextFragments(value: unknown, fragments: string[]): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') fragments.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, fragments);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as JsonRecord)) {
    if (key === 'base_instructions' || key === 'developer_instructions') continue;
    collectTextFragments(child, fragments);
  }
}

function extractSessionMeta(parsed: JsonRecord | null): SessionMeta | null {
  if (!parsed || parsed.type !== 'session_meta') return null;
  const payload = parsed.payload;
  if (!payload || typeof payload !== 'object') return null;
  const typedPayload = payload as JsonRecord;
  const sessionId = asString(typedPayload.id);
  if (!sessionId) return null;
  return {
    sessionId,
    timestamp: asString(typedPayload.timestamp),
    cwd: asString(typedPayload.cwd),
  };
}

function extractSearchableTexts(parsed: JsonRecord | null, rawLine: string): SearchableText[] {
  if (!parsed) {
    return [{ text: rawLine, recordType: 'raw' }];
  }

  const topType = asString(parsed.type) ?? 'unknown';
  const texts: SearchableText[] = [];

  if (topType === 'session_meta') {
    const payload = parsed.payload;
    if (payload && typeof payload === 'object') {
      const meta = payload as JsonRecord;
      const summary = [meta.id, meta.cwd, meta.agent_role, meta.agent_nickname]
        .flatMap((value) => (typeof value === 'string' && value.trim() !== '') ? [value] : [])
        .join(' ')
        .trim();
      if (summary) texts.push({ text: summary, recordType: 'session_meta' });
    }
    return texts;
  }

  if (topType === 'event_msg') {
    const payload = parsed.payload;
    const payloadType = payload && typeof payload === 'object'
      ? asString((payload as JsonRecord).type) ?? 'unknown'
      : 'unknown';
    const fragments: string[] = [];
    collectTextFragments(payload, fragments);
    const text = fragments.join(' \n ').trim();
    if (text) {
      texts.push({ text, recordType: `event_msg:${payloadType}` });
    }
    return texts;
  }

  if (topType === 'response_item') {
    const payload = parsed.payload;
    if (!payload || typeof payload !== 'object') return texts;

    const typedPayload = payload as JsonRecord;
    const payloadType = asString(typedPayload.type) ?? 'unknown';
    if (payloadType === 'message') {
      const role = asString(typedPayload.role) ?? 'unknown';
      if (role !== 'assistant' && role !== 'user') return texts;
      const fragments: string[] = [];
      collectTextFragments(typedPayload.content, fragments);
      const text = fragments.join(' \n ').trim();
      if (text) texts.push({ text, recordType: `response_item:${payloadType}:${role}` });
      return texts;
    }

    const fragments: string[] = [];
    if (payloadType === 'function_call') {
      const name = asString(typedPayload.name);
      if (name) fragments.push(name);
      const argumentsText = asString(typedPayload.arguments);
      if (argumentsText) fragments.push(argumentsText);
    } else if (payloadType === 'function_call_output') {
      const outputText = typedPayload.output;
      collectTextFragments(outputText, fragments);
    } else {
      collectTextFragments(typedPayload, fragments);
    }

    const text = fragments.join(' \n ').trim();
    if (text) texts.push({ text, recordType: `response_item:${payloadType}` });
    return texts;
  }

  return [{ text: rawLine, recordType: topType }];
}

function buildSnippet(text: string, query: string, context: number, caseSensitive: boolean): string | null {
  if (text === '') return null;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index < 0) return null;

  const start = Math.max(0, index - context);
  const end = Math.min(text.length, index + query.length + context);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function normalizeDarwinPathAlias(value: string): string {
  return process.platform === 'darwin' ? value.replaceAll('/private/var/', '/var/') : value;
}

function matchesFilter(value: string | null, filter: string | undefined, caseSensitive: boolean): boolean {
  if (!filter) return true;
  if (!value) return false;
  const normalizedValue = normalizeDarwinPathAlias(value);
  const normalizedFilter = normalizeDarwinPathAlias(filter);
  if (caseSensitive) return normalizedValue.includes(normalizedFilter);
  return normalizedValue.toLowerCase().includes(normalizedFilter.toLowerCase());
}

async function searchRolloutFile(
  filePath: string,
  options: Required<Pick<SessionSearchOptions, 'query' | 'context' | 'caseSensitive'>> & {
    limit: number;
    session?: string;
    sinceCutoff: number | null;
    projectFilter?: string;
    cwd: string;
    codexHomeDir: string;
    codexHomeDisplay: string;
  },
): Promise<{ meta: SessionMeta | null; results: SessionSearchResult[] }> {
  const stream = createReadStream(filePath, 'utf-8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const results: SessionSearchResult[] = [];
  let meta: SessionMeta | null = null;
  let lineNumber = 0;
  let skipFile = false;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      const parsed = safeParseJson(line);
      if (lineNumber === 1) {
        meta = extractSessionMeta(parsed);
        const fallbackSessionId = filePath.split('rollout-')[1]?.replace(/\.jsonl$/, '') ?? filePath;
        if (!meta) {
          meta = { sessionId: fallbackSessionId, timestamp: null, cwd: null };
        }
        const sessionTimestamp = meta.timestamp ? Date.parse(meta.timestamp) : Number.NaN;
        if (options.sinceCutoff != null && !Number.isNaN(sessionTimestamp) && sessionTimestamp < options.sinceCutoff) {
          skipFile = true;
          break;
        }
        if (!matchesFilter(meta.sessionId, options.session, options.caseSensitive)) {
          skipFile = true;
          break;
        }
        if (!matchesFilter(meta.cwd, options.projectFilter, options.caseSensitive)) {
          skipFile = true;
          break;
        }
      }

      for (const candidate of extractSearchableTexts(parsed, line)) {
        const snippet = buildSnippet(candidate.text, options.query, options.context, options.caseSensitive);
        if (!snippet || !meta) continue;
        results.push({
          session_id: meta.sessionId,
          timestamp: meta.timestamp,
          cwd: meta.cwd,
          transcript_path: join(options.codexHomeDisplay, relative(options.codexHomeDir, filePath)),
          transcript_path_relative: relative(options.codexHomeDir, filePath),
          record_type: candidate.recordType,
          line_number: lineNumber,
          snippet,
        });
        if (results.length >= options.limit) {
          return { meta, results };
        }
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return skipFile ? { meta, results: [] } : { meta, results };
}

async function searchCodexHomeDir(
  codexHomeDir: string,
  options: Required<Pick<SessionSearchOptions, 'query' | 'context' | 'caseSensitive'>> & {
    limit: number;
    session?: string;
    sinceCutoff: number | null;
    projectFilter?: string;
    cwd: string;
    codexHomeDisplay: string;
  },
): Promise<{ searchedFiles: number; matchedSessions: Set<string>; results: SessionSearchResult[] }> {
  const rolloutRoot = join(codexHomeDir, 'sessions');
  const files = await listRolloutFiles(rolloutRoot);
  const results: SessionSearchResult[] = [];
  const matchedSessions = new Set<string>();
  let searchedFiles = 0;

  for (const filePath of files) {
    if (results.length >= options.limit) break;

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat) continue;
    if (options.sinceCutoff != null && fileStat.mtimeMs < options.sinceCutoff) {
      continue;
    }

    searchedFiles += 1;
    const fileSearch = await searchRolloutFile(filePath, {
      query: options.query,
      context: options.context,
      caseSensitive: options.caseSensitive,
      limit: options.limit - results.length,
      session: options.session,
      sinceCutoff: options.sinceCutoff,
      projectFilter: options.projectFilter,
      cwd: options.cwd,
      codexHomeDir,
      codexHomeDisplay: options.codexHomeDisplay,
    });

    for (const result of fileSearch.results) {
      results.push(result);
      matchedSessions.add(result.session_id);
      if (results.length >= options.limit) break;
    }
  }

  return { searchedFiles, matchedSessions, results };
}
export async function searchSessionHistory(options: SessionSearchOptions): Promise<SessionSearchReport> {
  const query = options.query.trim();
  if (query === '') {
    throw new Error('Search query must not be empty.');
  }

  const cwd = options.cwd ?? process.cwd();
  const codexHomeSources = await resolveSessionSearchCodexHomeSources(options);
  const limit = clampInteger(options.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
  const context = clampInteger(options.context ?? DEFAULT_CONTEXT, DEFAULT_CONTEXT, MAX_CONTEXT) || DEFAULT_CONTEXT;
  const caseSensitive = options.caseSensitive === true;
  const sinceCutoff = parseSinceSpec(options.since, options.now ?? Date.now());
  const projectFilter = normalizeProjectFilter(options.project, cwd);

  const results: SessionSearchResult[] = [];
  let searchedFiles = 0;
  const matchedSessions = new Set<string>();
  const sources: SessionSearchSourceReport[] = [];

  for (const codexHomeSource of codexHomeSources) {
    const sourceSearch = await searchCodexHomeDir(codexHomeSource.dir, {
      query,
      context,
      caseSensitive,
      limit,
      session: options.session,
      sinceCutoff,
      projectFilter,
      cwd,
      codexHomeDisplay: codexHomeSource.publicLabel,
    });
    searchedFiles += sourceSearch.searchedFiles;
    sources.push({ codex_home: codexHomeSource.publicLabel, searched_files: sourceSearch.searchedFiles });
    for (const sessionId of sourceSearch.matchedSessions) matchedSessions.add(sessionId);
    for (const result of sourceSearch.results) {
      results.push(result);
    }
  }

  const limitedResults = results.slice(0, limit);
  const limitedMatchedSessions = new Set(limitedResults.map((result) => result.session_id));

  return {
    query,
    searched_files: searchedFiles,
    matched_sessions: limitedMatchedSessions.size,
    sources,
    results: limitedResults,
  };
}
