import type { AuthConfig } from "./config.js";

export interface CodexExitSignal {
  status?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  structuredError?: unknown;
}

const DEFAULT_PATTERNS = [
  /\b429\b/i,
  /\bquota\b/i,
  /rate\s*limit(?:ed|s)?/i,
  /too\s+many\s+requests/i,
];

function structuredText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const status = record.status ?? record.statusCode ?? record.code ?? "";
    const type = record.type ?? record.error ?? "";
    const message = record.message ?? "";
    return `${status} ${type} ${message}`;
  }
  return String(value);
}

export function isQuotaError(signal: CodexExitSignal, config?: Pick<AuthConfig, "quotaPatterns">): boolean {
  const haystack = [
    structuredText(signal.structuredError),
    signal.stderr ?? "",
    signal.stdout ?? "",
  ].join("\n");
  if (!haystack.trim()) return false;
  if (DEFAULT_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
  return (config?.quotaPatterns ?? []).some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(haystack);
    } catch {
      return haystack.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}
