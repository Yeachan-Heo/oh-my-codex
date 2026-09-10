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

/** Redact complete stderr records rather than arbitrary OS pipe chunks. */
export function createAuthStderrRedactor(emit: (text: string) => void): {
  write: (chunk: Buffer) => void;
  end: () => void;
} {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let dropping = false;
  // Keep pretty-printed token fields together when the value starts on the next line.
  const incompleteSecret = /(?:["']?(?:access_token|refresh_token|id_token|(?:session|auth|api)[_-]?token)["']?\s*[:=]?|\bbearer)\s*$/i;
  const accept = (text: string) => {
    if (dropping) return;
    for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      pending += part;
      // A newline after overflow might still precede a pretty-printed secret value.
      // Without its buffered prefix, no later boundary is provably safe to emit.
      if (pending.length > 64 * 1024) {
        emit("[omx auth] oversized stderr record; remaining stderr suppressed\n");
        pending = "";
        dropping = true;
        return;
      }
      if (!part.endsWith("\n")) continue;
      if (!incompleteSecret.test(pending)) {
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
