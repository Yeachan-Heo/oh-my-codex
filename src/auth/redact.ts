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
