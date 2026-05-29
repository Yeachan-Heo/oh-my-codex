export const MAX_NOTIFY_ARGV_JSON_BYTES = 64 * 1024;
export const MAX_NATIVE_STDIN_JSON_BYTES = 1024 * 1024;
export const RAW_JSON_FIELD_SCAN_BYTES = 64 * 1024;

export const CODEX_HOOK_EVENT_NAMES = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const;

export type RawCodexHookEventName = typeof CODEX_HOOK_EVENT_NAMES[number];

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function skipJsonWhitespace(raw: string, index: number): number {
  while (index < raw.length && /\s/.test(raw[index] ?? "")) index += 1;
  return index;
}

function readJsonStringLiteral(raw: string, quoteIndex: number): { value: string; endIndex: number } | null {
  if (raw[quoteIndex] !== '"') return null;
  let value = "";
  for (let index = quoteIndex + 1; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '"') return { value, endIndex: index + 1 };
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= raw.length) return null;
    const escaped = raw[index];
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        value += escaped;
        break;
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "u": {
        const hex = raw.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        return null;
    }
  }
  return null;
}

export function extractRawJsonStringField(rawInput: string, fieldNames: readonly string[]): string | null {
  const raw = rawInput.slice(0, RAW_JSON_FIELD_SCAN_BYTES);
  const wanted = new Set(fieldNames);
  let depth = 0;
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const key = readJsonStringLiteral(raw, index);
      if (!key) return null;
      index = key.endIndex;
      const afterKey = skipJsonWhitespace(raw, index);
      if (depth === 1 && raw[afterKey] === ":" && wanted.has(key.value)) {
        const valueStart = skipJsonWhitespace(raw, afterKey + 1);
        const value = readJsonStringLiteral(raw, valueStart);
        return value?.value ?? null;
      }
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }

  return null;
}

export function extractRawCodexHookEventName(rawInput: string): RawCodexHookEventName | null {
  const raw = extractRawJsonStringField(rawInput, [
    "hook_event_name",
    "hookEventName",
    "event",
    "name",
  ]);
  return CODEX_HOOK_EVENT_NAMES.includes(raw as RawCodexHookEventName)
    ? raw as RawCodexHookEventName
    : null;
}
