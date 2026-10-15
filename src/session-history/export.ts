import { readResolvedSessionTranscriptLines, resolveSessionTranscript, type SessionTranscriptOptions } from './transcript.js';

type JsonRecord = Record<string, unknown>;

export interface SessionExportOptions extends SessionTranscriptOptions {
  includeTools?: boolean;
}

interface EntryLocation {
  timestamp: string | null;
  line_number: number;
  text: string;
}

export type SessionExportEntry = EntryLocation & (
  | { kind: 'message'; role: 'user' | 'assistant' }
  | { kind: 'tool_call' | 'tool_output'; name: string | null; call_id: string | null }
);

export interface SessionExportDocument {
  schema_version: 1;
  session_id: string;
  started_at: string | null;
  cwd: string | null;
  archived: boolean;
  skipped_records: number;
  entries: SessionExportEntry[];
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

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((item): string[] => {
    const block = asObject(item);
    if (!block) return typeof item === 'string' ? [item] : [];
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      return typeof block.text === 'string' ? [block.text] : [];
    }
    if (block.type === 'input_image' || block.type === 'image') return ['[Image]'];
    if (block.type === 'input_audio' || block.type === 'audio') return ['[Audio]'];
    return [];
  }).join('\n');
}

function toolText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

export async function exportSessionHistory(options: SessionExportOptions): Promise<SessionExportDocument> {
  let transcript = await resolveSessionTranscript(options);
  const messages: SessionExportEntry[] = [];
  const eventMessages: SessionExportEntry[] = [];
  const tools: SessionExportEntry[] = [];
  const toolNames = new Map<string, string>();
  let lineNumber = 0;
  let skippedRecords = 0;

  for await (const line of readResolvedSessionTranscriptLines(options, transcript, (resolved) => {
    transcript = resolved;
  })) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    const record = parseRecord(line);
    if (lineNumber === 1 && (record?.type !== 'session_meta' || asObject(record.payload)?.id !== transcript.id)) {
      throw new Error('The selected transcript changed during export. Try again.');
    }
    if (!record) {
      skippedRecords += 1;
      continue;
    }
    const payload = asObject(record.payload);
    if (!payload) continue;
    const location = { timestamp: asString(record.timestamp), line_number: lineNumber };
    if (record.type === 'response_item' && payload.type === 'message') {
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      if (payload.channel === 'analysis') continue;
      const text = messageText(payload.content);
      if (text) messages.push({ ...location, kind: 'message', role: payload.role, text });
    } else if (record.type === 'event_msg' && (payload.type === 'user_message' || payload.type === 'agent_message')) {
      if (payload.channel === 'analysis') continue;
      const text = asString(payload.message);
      if (text) eventMessages.push({
        ...location, kind: 'message', role: payload.type === 'user_message' ? 'user' : 'assistant', text,
      });
    } else if (record.type === 'response_item' && options.includeTools) {
      const callId = asString(payload.call_id);
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const name = asString(payload.name);
        if (callId && name) toolNames.set(callId, name);
        tools.push({
          ...location, kind: 'tool_call', name, call_id: callId,
          text: toolText(payload.type === 'custom_tool_call' ? payload.input : payload.arguments),
        });
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        tools.push({
          ...location, kind: 'tool_output', call_id: callId,
          name: callId ? toolNames.get(callId) ?? null : null,
          text: toolText(payload.output),
        });
      }
    }
  }

  // Codex writes event messages as well as response items for the same turn.
  // Prefer response messages; event-only transcripts use the older event form.
  const entries = [...(messages.length > 0 ? messages : eventMessages), ...tools]
    .sort((left, right) => left.line_number - right.line_number);
  return {
    schema_version: 1,
    session_id: transcript.id,
    started_at: transcript.startedAt,
    cwd: transcript.cwd,
    archived: transcript.archived,
    skipped_records: skippedRecords,
    entries,
  };
}

function codeDelimiter(text: string, minimum: number): string {
  const runs = text.match(/`+/g) ?? [];
  return '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), minimum));
}

function inlineCode(value: string): string {
  const text = value.replace(/[\r\n]/g, ' ');
  const delimiter = codeDelimiter(text, 1);
  return `${delimiter} ${text} ${delimiter}`;
}

export function renderSessionMarkdown(document: SessionExportDocument): string {
  const lines = [
    '# Session export', '',
    `- Session: ${inlineCode(document.session_id)}`,
    `- Started: ${inlineCode(document.started_at ?? 'unknown')}`,
    `- Project: ${inlineCode(document.cwd ?? 'unknown')}`,
    `- Archived: ${document.archived ? 'yes' : 'no'}`,
  ];
  if (document.skipped_records > 0) {
    lines.push(`- Skipped malformed records: ${document.skipped_records}`);
  }
  if (document.entries.length === 0) lines.push('', '_No exportable messages._');
  for (const entry of document.entries) {
    const title = entry.kind === 'message'
      ? (entry.role === 'user' ? 'User' : 'Assistant')
      : (entry.kind === 'tool_call' ? 'Tool call' : 'Tool output');
    lines.push('', `## ${title}`, '');
    if (entry.timestamp) lines.push(`Time: ${inlineCode(entry.timestamp)}`, '');
    if (entry.kind === 'message') {
      lines.push(entry.text);
    } else {
      if (entry.name) lines.push(`Tool: ${inlineCode(entry.name)}`, '');
      if (entry.call_id) lines.push(`Call: ${inlineCode(entry.call_id)}`, '');
      const fence = codeDelimiter(entry.text, 3);
      lines.push(fence, entry.text, fence);
    }
  }
  return `${lines.join('\n')}\n`;
}
