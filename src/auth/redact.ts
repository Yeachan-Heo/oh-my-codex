import { StringDecoder } from "node:string_decoder";

const JSON_OAUTH_TOKEN_FIELD_PATTERN = /(["'](?:access_token|refresh_token|id_token)["']\s*:\s*)(["'])(?:\\.|(?!\2)[^\\])*\2/gi;

const SECRET_PATTERNS: RegExp[] = [
  JSON_OAUTH_TOKEN_FIELD_PATTERN,
  /\b(?:access|refresh|id)_token\b\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:session|auth|api)[_-]?token\b\s*[:=]\s*["']?[^"'\s,}]+/gi,
];

export function redactAuthSecrets(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (pattern === JSON_OAUTH_TOKEN_FIELD_PATTERN) {
        return match.replace(/(:\s*)(["']).*\2$/s, "$1$2[REDACTED]$2");
      }
      const separator = match.match(/[:=]/)?.[0];
      if (separator) return `${match.slice(0, match.indexOf(separator) + 1)} [REDACTED]`;
      if (/^bearer\s/i.test(match)) return "Bearer [REDACTED]";
      return "[REDACTED]";
    });
  }
  return text;
}

const MAX_STDERR_RECORD_LENGTH = 64 * 1024;
/**
 * A boundary decision only inspects the tail of the buffer, so a small window
 * of suppressed text is as authoritative as the whole record.
 */
const SECRET_BOUNDARY_WINDOW_LENGTH = 256;

/** Keep pretty-printed token fields together when the value starts on the next line. */
const INCOMPLETE_SECRET_PATTERN = /(?:["']?(?:access_token|refresh_token|id_token|(?:session|auth|api)[_-]?token)["']?\s*[:=]?|\bbearer)\s*$/i;

/**
 * Retains the trailing bytes needed to judge the next newline boundary.
 * Whitespace runs are collapsed so an unbounded blank tail cannot push a key
 * name out of the window; the boundary pattern ends in `\s*$` and matches a
 * collapsed run identically.
 */
function appendSecretBoundaryWindow(window: string, text: string): string {
  const joined = `${window}${text}`.replace(/\s{2,}/g, " ");
  return joined.length > SECRET_BOUNDARY_WINDOW_LENGTH
    ? joined.slice(-SECRET_BOUNDARY_WINDOW_LENGTH)
    : joined;
}

/** Redact complete stderr records rather than arbitrary OS pipe chunks. */
export function createAuthStderrRedactor(emit: (text: string) => void): {
  write: (chunk: Buffer) => void;
  end: () => void;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  // Trailing bytes of the suppressed record, kept so suppression can end at a
  // boundary that is provably not inside a pretty-printed token field.
  let suppressedBoundaryWindow = "";
  const accept = (text: string) => {
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (dropping) {
        // Never release suppressed bytes. Resume only once a newline boundary
        // is reached whose retained tail cannot precede a secret value.
        suppressedBoundaryWindow = appendSecretBoundaryWindow(suppressedBoundaryWindow, part);
        if (!part.endsWith("\n")) continue;
        if (INCOMPLETE_SECRET_PATTERN.test(suppressedBoundaryWindow)) continue;
        dropping = false;
        suppressedBoundaryWindow = "";
        continue;
      }
      pending += part;
      if (pending.length > MAX_STDERR_RECORD_LENGTH) {
        emit("[omx auth] oversized stderr record suppressed\n");
        suppressedBoundaryWindow = appendSecretBoundaryWindow("", pending);
        pending = "";
        dropping = true;
        continue;
      }
      if (!part.endsWith("\n")) continue;
      if (!INCOMPLETE_SECRET_PATTERN.test(pending)) {
        emit(redactAuthSecrets(pending));
        pending = "";
      }
    }
  };
  return {
    write: (chunk) => accept(decoder.write(chunk)),
    end: () => {
      accept(decoder.end());
      if (pending) emit(redactAuthSecrets(pending));
      pending = "";
    },
  };
}
