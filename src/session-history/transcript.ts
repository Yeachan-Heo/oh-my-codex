import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { listRolloutFiles, resolveSessionSearchCodexHomeDirs, type SessionSearchOptions } from './search.js';

type JsonRecord = Record<string, unknown>;

export interface SessionTranscriptOptions extends Pick<SessionSearchOptions, 'cwd' | 'codexHomeDir' | 'codexHomeDirs'> {
  session: string;
}

export interface SessionTranscript {
  path: string;
  id: string;
  startedAt: string | null;
  cwd: string | null;
  archived: boolean;
}

export async function revalidateTranscriptMatches(matches: SessionTranscript[]): Promise<SessionTranscript[]> {
  const current: SessionTranscript[] = [];
  for (const match of matches) {
    const transcript = await readTranscriptMeta(match.path, match.archived);
    if (transcript?.id === match.id) current.push(transcript);
  }
  return current;
}

function asObject(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseRecord(line: string): JsonRecord | null {
  try {
    return asObject(JSON.parse(line));
  } catch {
    return null;
  }
}

export async function* readSessionTranscriptLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, 'utf-8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    stream.destroy();
  }
}

async function readTranscriptMeta(path: string, archived: boolean): Promise<SessionTranscript | null> {
  try {
    for await (const line of readSessionTranscriptLines(path)) {
      const record = parseRecord(line);
      const payload = asObject(record?.payload);
      const id = asString(payload?.id);
      if (record?.type !== 'session_meta' || !id) return null;
      return {
        path, id, archived,
        startedAt: asString(payload?.timestamp) ?? asString(record.timestamp),
        cwd: asString(payload?.cwd),
      };
    }
  } catch (error) {
    // A running Codex instance can move a transcript into the archive during discovery.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return null;
}

export async function resolveSessionTranscript(options: SessionTranscriptOptions): Promise<SessionTranscript> {
  const selector = options.session.trim();
  if (!selector) throw new Error('Missing session id. Use an exact id or a unique prefix.');
  const matches: SessionTranscript[] = [];
  const homes = await resolveSessionSearchCodexHomeDirs(options);
  for (const home of homes) {
    for (const archived of [false, true]) {
      const files = await listRolloutFiles(join(home, archived ? 'archived_sessions' : 'sessions'));
      for (const file of files) {
        const meta = await readTranscriptMeta(file, archived);
        if (meta?.id.startsWith(selector)) matches.push(meta);
      }
    }
  }
  const exact = matches.filter((match) => match.id === selector);
  let candidates = exact.length > 0 ? exact : matches;
  if (candidates.length > 1) candidates = await revalidateTranscriptMatches(candidates);
  if (candidates.length === 0) throw new Error(`No local session matches "${selector}".`);
  if (candidates.length > 1) {
    const ids = [...new Set(candidates.map((match) => match.id))].sort().join(', ');
    throw new Error(`Multiple transcripts match "${selector}" (${ids}). Use a full session id and --codex-home to narrow the source.`);
  }
  return candidates[0];
}

export async function* readResolvedSessionTranscriptLines(
  options: SessionTranscriptOptions,
  transcript: SessionTranscript,
  onResolved: (transcript: SessionTranscript) => void,
): AsyncGenerator<string> {
  let yieldedLine = false;
  try {
    for await (const line of readSessionTranscriptLines(transcript.path)) {
      yieldedLine = true;
      yield line;
    }
  } catch (error) {
    // Codex can move an active transcript into the archive after resolution but before open.
    if (yieldedLine || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const selectedId = transcript.id;
    const refreshed = await resolveSessionTranscript({ ...options, session: selectedId });
    if (refreshed.id !== selectedId) throw new Error('The selected transcript changed during inspection. Try again.');
    onResolved(refreshed);
    yield* readSessionTranscriptLines(refreshed.path);
  }
}
