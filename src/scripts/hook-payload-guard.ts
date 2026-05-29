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

export const MAX_NOTIFY_COMPACT_SCAN_BYTES = 2 * 1024 * 1024;
export const MAX_NOTIFY_RETAINED_TEXT_BYTES = 16 * 1024;

export interface CompactNotifyPayloadView {
  intake: "compact";
  payloadCompacted: true;
  rawPayloadBytes: number;
  rawPayloadBytesScanned: number;
  type: string;
  cwd: string;
  threadId: string;
  turnId: string;
  sessionId: string;
  client: string;
  mode: string;
  producerSource: string;
  projectName: string;
  latestInputText: string;
  latestInputTruncated: boolean;
  inputMessageCount: number | null;
  inputMessageCountPartial: boolean;
  inputMessagesTruncated: boolean;
  outputPreview: string;
  outputPreviewTruncated: boolean;
  isNotifyFallbackTaskComplete: boolean;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8ByteLength(value) <= maxBytes) return { value, truncated: false };
  const buffer = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return { value: buffer.toString("utf-8").replace(/\uFFFD$/u, ""), truncated: true };
}

function notifyScalarFieldName(key: string): keyof Pick<CompactNotifyPayloadView,
  "type" | "cwd" | "threadId" | "turnId" | "sessionId" | "client" | "mode" | "producerSource" | "projectName"
> | "lastAssistantMessage" | "inputMessages" | null {
  switch (key) {
    case "type": return "type";
    case "cwd": return "cwd";
    case "thread-id":
    case "thread_id": return "threadId";
    case "turn-id":
    case "turn_id": return "turnId";
    case "session-id":
    case "session_id": return "sessionId";
    case "client": return "client";
    case "mode": return "mode";
    case "source": return "producerSource";
    case "project-name":
    case "project_name": return "projectName";
    case "last-assistant-message":
    case "last_assistant_message": return "lastAssistantMessage";
    case "input-messages":
    case "input_messages": return "inputMessages";
    default: return null;
  }
}

function skipJsonValue(raw: string, index: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < raw.length; cursor += 1) {
    const char = raw[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      if (depth === 0) return cursor;
      depth -= 1;
    } else if (char === "," && depth === 0) {
      return cursor + 1;
    }
  }
  return raw.length;
}

function readInputMessagesArray(raw: string, arrayStart: number): {
  endIndex: number;
  latest: string;
  latestTruncated: boolean;
  count: number;
  partial: boolean;
  truncated: boolean;
  fallbackComplete: boolean;
} {
  let index = skipJsonWhitespace(raw, arrayStart);
  if (raw[index] !== "[") {
    return { endIndex: index, latest: "", latestTruncated: false, count: 0, partial: false, truncated: true, fallbackComplete: false };
  }
  index += 1;
  let count = 0;
  let latest = "";
  let latestTruncated = false;
  let partial = true;
  let truncated = false;
  let fallbackComplete = false;
  while (index < raw.length) {
    index = skipJsonWhitespace(raw, index);
    const char = raw[index];
    if (char === "]") {
      partial = false;
      index += 1;
      break;
    }
    if (char === '"') {
      const item = readJsonStringLiteral(raw, index);
      if (!item) {
        truncated = true;
        break;
      }
      count += 1;
      const retained = truncateUtf8(item.value, MAX_NOTIFY_RETAINED_TEXT_BYTES);
      latest = retained.value;
      latestTruncated = retained.truncated;
      truncated = truncated || retained.truncated;
      if (item.value.includes("[notify-fallback] synthesized from rollout task_complete")) {
        fallbackComplete = true;
      }
      index = skipJsonWhitespace(raw, item.endIndex);
      if (raw[index] === ",") index += 1;
      continue;
    }
    truncated = true;
    index = skipJsonValue(raw, index);
  }
  return { endIndex: index, latest, latestTruncated, count, partial, truncated: truncated || partial, fallbackComplete };
}

export function extractCompactNotifyPayloadView(rawPayload: string): CompactNotifyPayloadView {
  const rawPayloadBytes = utf8ByteLength(rawPayload);
  const scanBuffer = Buffer.from(rawPayload, "utf-8").subarray(0, MAX_NOTIFY_COMPACT_SCAN_BYTES);
  const raw = scanBuffer.toString("utf-8");
  const view: CompactNotifyPayloadView = {
    intake: "compact",
    payloadCompacted: true,
    rawPayloadBytes,
    rawPayloadBytesScanned: scanBuffer.byteLength,
    type: "",
    cwd: "",
    threadId: "",
    turnId: "",
    sessionId: "",
    client: "",
    mode: "",
    producerSource: "",
    projectName: "",
    latestInputText: "",
    latestInputTruncated: false,
    inputMessageCount: null,
    inputMessageCountPartial: rawPayloadBytes > scanBuffer.byteLength,
    inputMessagesTruncated: rawPayloadBytes > scanBuffer.byteLength,
    outputPreview: "",
    outputPreviewTruncated: false,
    isNotifyFallbackTaskComplete: false,
  };

  let depth = 0;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index];
    if (char === '"') {
      const key = readJsonStringLiteral(raw, index);
      if (!key) break;
      index = key.endIndex;
      const afterKey = skipJsonWhitespace(raw, index);
      if (depth !== 1 || raw[afterKey] !== ":") continue;
      const field = notifyScalarFieldName(key.value);
      if (!field) {
        index = skipJsonValue(raw, afterKey + 1);
        continue;
      }
      const valueStart = skipJsonWhitespace(raw, afterKey + 1);
      if (field === "inputMessages") {
        const array = readInputMessagesArray(raw, valueStart);
        view.latestInputText = array.latest;
        view.latestInputTruncated = array.latestTruncated;
        view.inputMessageCount = array.count;
        view.inputMessageCountPartial = array.partial || rawPayloadBytes > scanBuffer.byteLength;
        view.inputMessagesTruncated = array.truncated || rawPayloadBytes > scanBuffer.byteLength || rawPayloadBytes > MAX_NOTIFY_ARGV_JSON_BYTES;
        view.isNotifyFallbackTaskComplete = array.fallbackComplete;
        index = array.endIndex;
        continue;
      }
      const value = readJsonStringLiteral(raw, valueStart);
      if (!value) {
        index = skipJsonValue(raw, valueStart);
        continue;
      }
      if (field === "lastAssistantMessage") {
        const retained = truncateUtf8(value.value, MAX_NOTIFY_RETAINED_TEXT_BYTES);
        view.outputPreview = retained.value;
        view.outputPreviewTruncated = retained.truncated;
      } else {
        (view as unknown as Record<string, string>)[field] = truncateUtf8(value.value, MAX_NOTIFY_RETAINED_TEXT_BYTES).value;
      }
      index = value.endIndex;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return view;
}
