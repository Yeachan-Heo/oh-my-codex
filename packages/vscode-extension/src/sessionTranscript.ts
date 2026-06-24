import type { DirectSessionHandle } from './types';

const MAX_TRANSCRIPT_CHARS = 12_000;

export function trimTranscript(value: string, maxChars = MAX_TRANSCRIPT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `... trimmed ${value.length - maxChars} chars ...\n${value.slice(-maxChars)}`;
}

export function formatSessionMessage(
  status: string,
  handle: Pick<DirectSessionHandle, 'session_id' | 'log_path'> | null,
  transcript: string,
): string {
  const lines = [`Status: ${status}`];
  if (handle) {
    lines.push(`Session: ${handle.session_id}`);
    lines.push(`Log: ${handle.log_path}`);
  }
  if (transcript.trim()) {
    lines.push('', transcript.trimEnd());
  }
  return lines.join('\n');
}
