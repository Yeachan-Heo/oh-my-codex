import { createHash } from "crypto";
import { readdir, realpath } from "fs/promises";
import { basename, dirname, join, relative, resolve, win32 } from "path";

export const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "PreCompact",
  "PostCompact",
  "Stop",
] as const;

type ManagedHookEventName = (typeof MANAGED_HOOK_EVENTS)[number];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonArray extends Array<JsonValue> {}

export type JsonValue = JsonObject | JsonArray | string | number | boolean | null;

export interface ManagedHookEntry {
  matcher?: string;
  hooks: Array<{
    type: "command";
    command: string;
    statusMessage?: string;
    timeout?: number;
  }>;
}

export interface ManagedCodexHooksConfig {
  hooks: Record<ManagedHookEventName, ManagedHookEntry[]>;
}

interface ParsedCodexHooksConfig {
  root: JsonObject;
  hooks: JsonObject;
}

export interface RemoveManagedCodexHooksResult {
  nextContent: string | null;
  removedCount: number;
}

export interface ManagedCodexHookTrustState {
  trusted_hash: string;
}

export interface CodexHooksJsonTrustStateEntry {
  trusted_hash: string;
  enabled?: boolean;
}

export interface DedupedCodexHookConfigPath {
  path: string;
  reason: "unique";
}

export interface SkippedCodexHookConfigPath {
  path: string;
  reason: "runtime_codex_home_mirror" | "duplicate_realpath";
  canonicalPath?: string;
}

export interface DiscoverCodexHookConfigPathsOptions {
  maxFiles?: number;
}

const CODEX_HOOK_EVENT_LABELS: Record<ManagedHookEventName, string> = {
  SessionStart: "session_start",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  UserPromptSubmit: "user_prompt_submit",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  Stop: "stop",
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setOwnRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function jsonValueFromUnknown(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Managed Codex hook configuration numbers must be finite JSON values.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValueFromUnknown(item));
  if (typeof value === "object") {
    const object: JsonObject = {};
    for (const [key, item] of Object.entries(value)) setOwnRecordValue(object, key, jsonValueFromUnknown(item));
    return object;
  }
  throw new TypeError("Managed Codex hook configuration must be JSON-serializable.");
}

function jsonObjectFromUnknown(value: unknown): JsonObject {
  const jsonValue = jsonValueFromUnknown(value);
  if (typeof jsonValue !== "object" || jsonValue === null || Array.isArray(jsonValue)) {
    throw new TypeError("Managed Codex hook configuration root must be a JSON object.");
  }
  return jsonValue;
}

type HookCommandPlatform = NodeJS.Platform;

function quoteCommandPart(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[$`]/g, "\\$&")}"`;
}

export function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteWindowsProcessArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;

  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }

    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }

    quoted += '\\'.repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }

  quoted += '\\'.repeat(backslashes * 2);
  quoted += '"';
  return quoted;
}

export const WINDOWS_NATIVE_HOOK_SHIM_RELATIVE_PATH = [
  "hooks",
  "omx-native-hook-windows-shim.ps1",
] as const;

export interface ManagedCodexHookOptions {
  platform?: HookCommandPlatform;
  codexHomeDir?: string;
  nodePath?: string;
  hookScriptPath?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Final hooks.json content to derive Codex hook trust keys from. Omit it to
   * retain the historical canonical-builder fallback; null declares no final artifact.
   */
  hooksContent?: string | null;
}

function resolveManagedCodexHookOptions(
  options: ManagedCodexHookOptions,
  hooksPath: string,
): ManagedCodexHookOptions {
  const platform = options.platform ?? process.platform;
  return {
    ...options,
    ...(platform === "win32" && !options.codexHomeDir
      ? { codexHomeDir: dirname(hooksPath) }
      : {}),
  };
}

const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

/**
 * Resolve an absolute path to Windows PowerShell. When PATH has been shortened
 * (e.g. by a runtime shim that dropped System32), a bare `powershell.exe` fails
 * to resolve, so prefer SystemRoot/windir and fall back to the well-known
 * default install location.
 */
export function resolveWindowsPowerShellPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const systemRoot =
    (typeof env.SystemRoot === "string" && env.SystemRoot.trim()) ||
    (typeof env.windir === "string" && env.windir.trim()) ||
    DEFAULT_WINDOWS_SYSTEM_ROOT;
  return win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function buildManagedCodexNativeHookWindowsShimPath(
  codexHomeDir: string,
): string {
  return win32.join(codexHomeDir, ...WINDOWS_NATIVE_HOOK_SHIM_RELATIVE_PATH);
}

export type ManagedCodexNativeHookWindowsShimOwnership =
  | "current"
  | "historical"
  | "modified";

function decodePowerShellSingleQuotedLiteral(value: string): string | null {
  if (value.length < 2 || value[0] !== "'" || value[value.length - 1] !== "'") return null;
  let decoded = "";
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character !== "'") {
      decoded += character;
      continue;
    }
    if (index + 1 >= value.length - 1 || value[index + 1] !== "'") return null;
    decoded += "'";
    index += 1;
  }
  return decoded;
}

function decodeGeneratedWindowsProcessArgument(value: string): string | null {
  if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
  let decoded = "";
  let index = 1;
  while (index < value.length - 1) {
    let backslashes = 0;
    while (value[index] === "\\") {
      backslashes += 1;
      index += 1;
    }
    if (index === value.length - 1) {
      if (backslashes % 2 !== 0) return null;
      decoded += "\\".repeat(backslashes / 2);
      break;
    }
    const character = value[index]!;
    if (character === '"') {
      if (backslashes % 2 === 0) return null;
      decoded += "\\".repeat((backslashes - 1) / 2) + '"';
    } else {
      decoded += "\\".repeat(backslashes) + character;
    }
    index += 1;
  }
  return quoteWindowsProcessArgument(decoded) === value ? decoded : null;
}

function isProofValidNodeExecutable(nodePath: string): boolean {
  const executable = nodePath.split(/[\\/]/).pop()?.toLowerCase();
  return isQualifiedWindowsFilesystemPath(nodePath) &&
    (executable === "node" || executable === "node.exe");
}

function isProofValidNativeHookScriptPath(hookScriptPath: string): boolean {
  return isQualifiedWindowsFilesystemPath(hookScriptPath) &&
    /(?:^|\\)dist\\scripts\\codex-native-hook\.js$/i.test(hookScriptPath);
}

/**
 * Classify a Windows native-hook shim from its raw on-disk bytes. Current
 * shims must be byte-identical to `expected`; historical shims must be the
 * complete, BOM-prefixed generated forwarding template with independently
 * proof-valid variable paths. Every other input is modified.
 */
export function classifyManagedCodexNativeHookWindowsShimOwnership(
  content: Buffer,
  expected: Buffer,
): ManagedCodexNativeHookWindowsShimOwnership {
  if (content.equals(expected)) return "current";
  if (content[0] !== 0xef || content[1] !== 0xbb || content[2] !== 0xbf) return "modified";
  const decoded = content.toString("utf-8");
  if (!Buffer.from(decoded, "utf-8").equals(content) || !decoded.startsWith("\uFEFF")) {
    return "modified";
  }

  const lines = decoded.slice(1).split("\n");
  if (lines.length !== 21 || lines[20] !== "") return "modified";
  const nodePath = lines[2]?.startsWith("$startInfo.FileName = ")
    ? decodePowerShellSingleQuotedLiteral(lines[2]!.slice("$startInfo.FileName = ".length))
    : null;
  const encodedHookScript = lines[7]?.startsWith("$startInfo.Arguments = ")
    ? decodePowerShellSingleQuotedLiteral(lines[7]!.slice("$startInfo.Arguments = ".length))
    : null;
  const hookScriptPath = encodedHookScript === null
    ? null
    : decodeGeneratedWindowsProcessArgument(encodedHookScript);
  if (
    nodePath === null ||
    hookScriptPath === null ||
    !isProofValidNodeExecutable(nodePath) ||
    !isProofValidNativeHookScriptPath(hookScriptPath)
  ) {
    return "modified";
  }

  return Buffer.from(
    buildManagedCodexNativeHookWindowsShimContent("", {
      nodePath,
      hookScriptPath,
    }),
    "utf-8",
  ).equals(content)
    ? "historical"
    : "modified";
}

export function buildManagedCodexNativeHookWindowsShimContent(
  pkgRoot: string,
  options: Pick<ManagedCodexHookOptions, "hookScriptPath" | "nodePath"> = {},
): string {
  const hookScript =
    options.hookScriptPath ??
    win32.join(pkgRoot, "dist", "scripts", "codex-native-hook.js");
  const nodePath = options.nodePath ?? process.execPath;

  // Windows PowerShell 5.1 (powershell.exe) decodes BOM-less .ps1 files using
  // the system ANSI codepage, which mojibakes non-ASCII install paths embedded
  // below and breaks the native hook (Node MODULE_NOT_FOUND, exit 1). Prepend a
  // UTF-8 BOM so the script is always read as UTF-8.
  return "\uFEFF" + [
    "$ErrorActionPreference = 'Stop'",
    "$startInfo = [System.Diagnostics.ProcessStartInfo]::new()",
    `$startInfo.FileName = ${quotePowerShellLiteral(nodePath)}`,
    "$startInfo.UseShellExecute = $false",
    "$startInfo.RedirectStandardInput = $true",
    "$startInfo.RedirectStandardOutput = $true",
    "$startInfo.RedirectStandardError = $true",
    `$startInfo.Arguments = ${quotePowerShellLiteral(quoteWindowsProcessArgument(hookScript))}`,
    "$process = [System.Diagnostics.Process]::new()",
    "$process.StartInfo = $startInfo",
    "$null = $process.Start()",
    "$stdinTask = [Console]::OpenStandardInput().CopyToAsync($process.StandardInput.BaseStream)",
    "$stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())",
    "$stderrTask = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
    "$stdinTask.Wait()",
    "$process.StandardInput.Close()",
    "$process.WaitForExit()",
    "$stdoutTask.Wait()",
    "$stderrTask.Wait()",
    "exit $process.ExitCode",
    "",
  ].join("\n");
}

export function buildManagedCodexNativeHookCommand(
  pkgRoot: string,
  optionsOrPlatform: HookCommandPlatform | ManagedCodexHookOptions = process.platform,
): string {
  const options = typeof optionsOrPlatform === "string"
    ? { platform: optionsOrPlatform }
    : optionsOrPlatform;
  const platform = options.platform ?? process.platform;

  if (platform === "win32") {
    const codexHomeDir = options.codexHomeDir ?? dirname(pkgRoot);
    const shimPath = buildManagedCodexNativeHookWindowsShimPath(codexHomeDir);
    const powerShellPath = resolveWindowsPowerShellPath(options.env);
    return `& ${quotePowerShellLiteral(powerShellPath)} -NoProfile -ExecutionPolicy Bypass -File ${quotePowerShellLiteral(shimPath)}`;
  }
  const hookScript = join(pkgRoot, "dist", "scripts", "codex-native-hook.js");

  return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(hookScript)}`;
}

function buildCommandHook(
  command: string,
  options: {
    matcher?: string;
    statusMessage?: string;
    timeout?: number;
  } = {},
): ManagedHookEntry {
  const hook = {
    type: "command",
    command,
    ...(options.statusMessage ? { statusMessage: options.statusMessage } : {}),
    ...(typeof options.timeout === "number" ? { timeout: options.timeout } : {}),
  } satisfies ManagedHookEntry["hooks"][number];

  return {
    ...(options.matcher ? { matcher: options.matcher } : {}),
    hooks: [hook],
  };
}

export function buildManagedCodexHooksConfig(
  pkgRoot: string,
  options: ManagedCodexHookOptions = {},
): ManagedCodexHooksConfig {
  const command = buildManagedCodexNativeHookCommand(pkgRoot, options);

  return {
    hooks: {
      SessionStart: [
        buildCommandHook(command, {
          matcher: "startup|resume|clear",
        }),
      ],
      PreToolUse: [
        buildCommandHook(command),
      ],
      PostToolUse: [
        buildCommandHook(command),
      ],
      UserPromptSubmit: [
        buildCommandHook(command),
      ],
      PreCompact: [
        buildCommandHook(command),
      ],
      PostCompact: [
        buildCommandHook(command),
      ],
      Stop: [
        buildCommandHook(command, {
          timeout: 30,
        }),
      ],
    },
  };
}

export interface SourceSpan {
  start: number;
  end: number;
}

type JsonNode = JsonObjectNode | JsonArrayNode | JsonScalarNode;

interface JsonObjectNode extends SourceSpan {
  kind: "object";
  value: JsonObject;
  properties: JsonProperty[];
}

interface JsonArrayNode extends SourceSpan {
  kind: "array";
  value: JsonArray;
  elements: JsonNode[];
}

interface JsonStringNode extends SourceSpan {
  kind: "string";
  value: string;
  raw: string;
}

interface JsonNumberNode extends SourceSpan {
  kind: "number";
  value: number;
  raw: string;
}

interface JsonBooleanNode extends SourceSpan {
  kind: "boolean";
  value: boolean;
  raw: string;
}

interface JsonNullNode extends SourceSpan {
  kind: "null";
  value: null;
  raw: string;
}

type JsonScalarNode = JsonStringNode | JsonNumberNode | JsonBooleanNode | JsonNullNode;

interface JsonProperty {
  key: string;
  keyNode: JsonStringNode;
  value: JsonNode;
}

const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;

type CodexHookEventName = (typeof CODEX_HOOK_EVENTS)[number];

const MATCHER_AWARE_HOOK_EVENTS = new Set<CodexHookEventName>([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
]);
const KNOWN_HOOK_EVENT_FIELDS = new Set<string>(CODEX_HOOK_EVENTS);

const KNOWN_GROUP_FIELDS = new Set(["matcher", "hooks"]);
const KNOWN_COMMAND_FIELDS = new Set([
  "type",
  "command",
  "commandWindows",
  "command_windows",
  "timeout",
  "async",
  "statusMessage",
]);
const KNOWN_ROOT_FIELDS = new Set(["hooks"]);
const KNOWN_HANDLER_TYPE_FIELD = new Set(["type"]);
const KNOWN_LEGACY_TRUST_STATE_ENTRY_FIELDS = new Set(["trusted_hash", "enabled"]);
const KNOWN_MATCHER_FIELD = new Set(["matcher"]);

export type ManagedCodexHooksPlanErrorCode =
  | "invalid_document"
  | "ambiguous_managed_handler"
  | "ambiguous_managed_group"
  | "unsafe_managed_removal"
  | "managed_trust_key_conflict";

export class ManagedCodexHooksPlanError extends Error {
  readonly code: ManagedCodexHooksPlanErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ManagedCodexHooksPlanErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ManagedCodexHooksPlanError";
    this.code = code;
    this.details = details;
  }
}

export interface CodexHooksDiagnostic {
  code: "invalid_matcher" | "async_command" | "empty_command" | "unsupported_handler";
  eventName: CodexHookEventName;
  groupIndex: number;
  handlerIndex?: number;
  message: string;
}

/** Backwards-compatible singular spelling. */
export type CodexHookDiagnostic = CodexHooksDiagnostic;

export interface CodexHookGroupOccurrence {
  eventName: CodexHookEventName;
  groupIndex: number;
  span: SourceSpan;
}

export interface CodexHookHandlerOccurrence {
  eventName: CodexHookEventName;
  groupIndex: number;
  handlerIndex: number;
  span: SourceSpan;
}

export interface CodexHookDiscoveryCommand {
  eventName: CodexHookEventName;
  groupIndex: number;
  handlerIndex: number;
  command: string;
}

export interface ValidCodexHooksConfigStrict {
  ok: true;
  root: JsonObject;
  diagnostics: CodexHooksDiagnostic[];
  groupOccurrences: CodexHookGroupOccurrence[];
  handlerOccurrences: CodexHookHandlerOccurrence[];
  discoveredCommands: CodexHookDiscoveryCommand[];
}

export interface InvalidCodexHooksConfigStrict {
  ok: false;
  error: ManagedCodexHooksPlanError;
}

export type CodexHooksConfigStrictResult =
  | ValidCodexHooksConfigStrict
  | InvalidCodexHooksConfigStrict;

export interface ManagedCodexHooksCoordinateProof {
  safe: boolean;
  shifted?: {
    kind: "group" | "handler";
    eventName: CodexHookEventName;
    oldCoordinate: readonly number[];
    newCoordinate?: readonly number[];
  };
}

export interface ManagedCodexHooksPlan {
  ok: true;
  finalContent: string | null;
  changed: boolean;
  removedCount: number;
  finalTrustState: Record<string, ManagedCodexHookTrustState>;
  hasForeignHooks: boolean;
  coordinateProof: ManagedCodexHooksCoordinateProof;
  priorTrustState: Record<string, ManagedCodexHookTrustState>;
  diagnostics: CodexHooksDiagnostic[];
  legacyTrustState: Record<string, CodexHooksJsonTrustStateEntry>;
}

export interface FailedManagedCodexHooksPlan {
  ok: false;
  error: ManagedCodexHooksPlanError;
  diagnostics: CodexHooksDiagnostic[];
}

export type ManagedCodexHooksPlanResult =
  | ManagedCodexHooksPlan
  | FailedManagedCodexHooksPlan;

export interface ManagedCodexHookTrustScan {
  ok: true;
  trustState: Record<string, ManagedCodexHookTrustState>;
  groupOccurrences: CodexHookGroupOccurrence[];
  handlerOccurrences: CodexHookHandlerOccurrence[];
}

export type ManagedCodexHookTrustScanResult =
  | ManagedCodexHookTrustScan
  | InvalidCodexHooksConfigStrict;

function planError(
  code: ManagedCodexHooksPlanErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ManagedCodexHooksPlanError {
  return new ManagedCodexHooksPlanError(code, message, details);
}

function planFailure(
  error: ManagedCodexHooksPlanError,
  diagnostics: CodexHooksDiagnostic[] = [],
): FailedManagedCodexHooksPlan {
  return { ok: false, error, diagnostics };
}

function isManagedHookEventName(value: string): value is ManagedHookEventName {
  return (MANAGED_HOOK_EVENTS as readonly string[]).includes(value);
}


function matcherIsAware(eventName: CodexHookEventName): boolean {
  return MATCHER_AWARE_HOOK_EVENTS.has(eventName);
}

function containsRustUnsupportedJavaScriptMatcherSyntax(matcher: string): boolean {
  for (let index = 0; index < matcher.length; index += 1) {
    if (matcher[index] === "\\") {
      const escaped = matcher[index + 1];
      if (!escaped || !isValidRustRegexEscape(matcher, index)) return true;
      index = skipRustRegexEscape(matcher, index) - 1;
      continue;
    }
    if (matcher[index] !== "(" || matcher[index + 1] !== "?") continue;
    const marker = matcher[index + 2];
    if (marker === "=" || marker === "!") return true;
    if (marker === "<" && (matcher[index + 3] === "=" || matcher[index + 3] === "!")) {
      return true;
    }
  }
  return false;
}

const RUST_SIMPLE_REGEX_ESCAPES = new Set([
  "A", "B", "D", "S", "W", "a", "b", "d", "f", "n", "r", "s", "t", "v", "w", "z",
]);
const RUST_ESCAPABLE_REGEX_PUNCTUATION = new Set([
  "\\", ".", "*", "+", "?", "(", ")", "|", "[", "]", "{", "}", "^", "$", "-", "/",
]);

function isHexadecimal(value: string): boolean {
  return /^[0-9A-Fa-f]+$/.test(value);
}

function skipRustRegexEscape(matcher: string, index: number): number {
  const kind = matcher[index + 1];
  if ((kind === "p" || kind === "P" || kind === "u") && matcher[index + 2] === "{") {
    const end = matcher.indexOf("}", index + 3);
    return end >= 0 ? end + 1 : matcher.length;
  }
  return index + 2 + (kind === "x" ? 2 : 0);
}

function isValidRustUnicodeProperty(property: string): boolean {
  const candidates = [property];
  const equals = property.indexOf("=");
  if (equals >= 0) {
    const name = property.slice(0, equals).toLowerCase();
    const value = property.slice(equals + 1);
    const normalizedName = name === "gc" || name === "general_category"
      ? "General_Category"
      : name === "sc" || name === "script"
        ? "Script"
        : name === "scx" || name === "script_extensions"
          ? "Script_Extensions"
          : property.slice(0, equals);
    candidates.push(`${normalizedName}=${value}`);
  } else {
    candidates.push(`Script=${property}`);
  }
  return candidates.some((candidate) => {
    try {
      new RegExp(`\\p{${candidate}}`, "u");
      return true;
    } catch {
      return false;
    }
  });
}

function isValidRustRegexEscape(matcher: string, index: number): boolean {
  const kind = matcher[index + 1];
  if (!kind) return false;
  if (RUST_SIMPLE_REGEX_ESCAPES.has(kind) || RUST_ESCAPABLE_REGEX_PUNCTUATION.has(kind)) return true;
  if (kind === "x") return matcher[index + 3] !== undefined && isHexadecimal(matcher.slice(index + 2, index + 4));
  if (kind === "u") {
    if (matcher[index + 2] !== "{") return false;
    const end = matcher.indexOf("}", index + 3);
    const codePoint = end >= 0 ? matcher.slice(index + 3, end) : "";
    if (codePoint.length === 0 || codePoint.length > 6 || !isHexadecimal(codePoint)) return false;
    const value = Number.parseInt(codePoint, 16);
    return value <= 0x10ffff && (value < 0xd800 || value > 0xdfff);
  }
  if (kind === "p" || kind === "P") {
    if (matcher[index + 2] !== "{") return false;
    const end = matcher.indexOf("}", index + 3);
    return end > index + 3 && isValidRustUnicodeProperty(matcher.slice(index + 3, end));
  }
  return false;
}


function normalizeRustMatcherForJavaScriptValidation(matcher: string): string {
  return matcher
    .replace(/\\[pP]\{[^}]+\}/g, ".")
    .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)))
    .replace(/\\A/g, "^")
    .replace(/\\z/g, "$")
    .replace(/\\a/g, "\\x07")
    .replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>")
    .replace(
      /\(\?([imsuUxR]*)(?:-([imsuUxR]+))?([:)])/g,
      (_match, enabled: string, disabled: string | undefined, terminator: string) =>
        enabled || disabled ? terminator === ":" ? "(?:" : "" : _match,
    );
}

function isValidCodexMatcher(matcher: string): boolean {
  if (matcher === "*") return true;
  if (containsRustUnsupportedJavaScriptMatcherSyntax(matcher)) return false;
  try {
    new RegExp(normalizeRustMatcherForJavaScriptValidation(matcher));
    return true;
  } catch {
    return false;
  }
}

function commandIsSkipped(command: string): boolean {
  return command.trim().length === 0;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseJsonSource(content: string): JsonNode | null {
  let cursor = 0;
  let nesting = 0;

  const skipWhitespace = (): void => {
    while ([" ", "\n", "\r", "\t"].includes(content[cursor] ?? "")) cursor += 1;
  };

  const parseString = (): JsonStringNode | null => {
    const start = cursor;
    if (content[cursor] !== '"') return null;
    cursor += 1;
    let escaped = false;
    while (cursor < content.length) {
      const char = content[cursor++]!;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        const raw = content.slice(start, cursor);
        try {
          const value = JSON.parse(raw) as unknown;
          if (typeof value !== "string" || containsLoneSurrogate(value)) return null;
          return { kind: "string", start, end: cursor, raw, value };
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  const parseValue = (): JsonNode | null => {
    skipWhitespace();
    const start = cursor;
    const current = content[cursor];
    if (current === "{") {
      if (nesting >= 128) return null;
      nesting += 1;
      try {
        cursor += 1;
        skipWhitespace();
        const properties: JsonProperty[] = [];
        const value: JsonObject = {};
        if (content[cursor] === "}") {
          cursor += 1;
          return { kind: "object", start, end: cursor, value, properties };
        }
        while (cursor < content.length) {
          skipWhitespace();
          const keyNode = parseString();
          if (!keyNode) return null;
          skipWhitespace();
          if (content[cursor] !== ":") return null;
          cursor += 1;
          const child = parseValue();
          if (!child) return null;
          properties.push({ key: keyNode.value, keyNode, value: child });
          setOwnRecordValue(value, keyNode.value, child.value);
          skipWhitespace();
          if (content[cursor] === "}") {
            cursor += 1;
            return { kind: "object", start, end: cursor, value, properties };
          }
          if (content[cursor] !== ",") return null;
          cursor += 1;
        }
        return null;
      } finally {
        nesting -= 1;
      }
    }
    if (current === "[") {
      if (nesting >= 128) return null;
      nesting += 1;
      try {
        cursor += 1;
        skipWhitespace();
        const elements: JsonNode[] = [];
        const value: JsonArray = [];
        if (content[cursor] === "]") {
          cursor += 1;
          return { kind: "array", start, end: cursor, value, elements };
        }
        while (cursor < content.length) {
          const child = parseValue();
          if (!child) return null;
          elements.push(child);
          value.push(child.value);
          skipWhitespace();
          if (content[cursor] === "]") {
            cursor += 1;
            return { kind: "array", start, end: cursor, value, elements };
          }
          if (content[cursor] !== ",") return null;
          cursor += 1;
        }
        return null;
      } finally {
        nesting -= 1;
      }
    }
    if (current === '"') return parseString();
    if (content.startsWith("true", cursor)) {
      cursor += 4;
      return { kind: "boolean", start, end: cursor, raw: "true", value: true };
    }
    if (content.startsWith("false", cursor)) {
      cursor += 5;
      return { kind: "boolean", start, end: cursor, raw: "false", value: false };
    }
    if (content.startsWith("null", cursor)) {
      cursor += 4;
      return { kind: "null", start, end: cursor, raw: "null", value: null };
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(content.slice(cursor));
    if (!number || number.index !== 0) return null;
    const value = Number(number[0]);
    if (!Number.isFinite(value)) return null;
    cursor += number[0].length;
    return {
      kind: "number",
      start,
      end: cursor,
      raw: number[0],
      value,
    };
  };

  const root = parseValue();
  skipWhitespace();
  return root && cursor === content.length ? root : null;
}

function objectProperty(node: JsonObjectNode, key: string): JsonProperty | undefined {
  return node.properties.find((property) => property.key === key);
}

function duplicateKnownProperty(node: JsonObjectNode, known: ReadonlySet<string>): string | undefined {
  const seen = new Set<string>();
  for (const property of node.properties) {
    if (!known.has(property.key)) continue;
    if (seen.has(property.key)) return property.key;
    seen.add(property.key);
  }
  return undefined;
}

function stringProperty(node: JsonObjectNode, key: string): string | undefined {
  const property = objectProperty(node, key);
  return property?.value.kind === "string" ? property.value.value : undefined;
}

function nullableStringProperty(node: JsonObjectNode, key: string): string | null | undefined {
  const property = objectProperty(node, key);
  if (!property) return undefined;
  if (property.value.kind === "null") return null;
  return property.value.kind === "string" ? property.value.value : undefined;
}

function effectiveCommandForPlatform(
  handler: JsonObjectNode,
  platform: HookCommandPlatform,
): string {
  const command = stringProperty(handler, "command")!;
  if (platform !== "win32") return command;
  const windows = nullableStringProperty(handler, "commandWindows") ??
    nullableStringProperty(handler, "command_windows");
  return windows === undefined || windows === null ? command : windows;
}

function isU64Node(node: JsonNode): boolean {
  if (node.kind !== "number" || !/^(?:0|[1-9]\d*)$/.test(node.raw)) return false;
  const maximum = "18446744073709551615";
  return node.raw.length < maximum.length ||
    (node.raw.length === maximum.length && node.raw <= maximum);
}

function validateCommandHandler(
  node: JsonObjectNode,
  eventName: CodexHookEventName,
  groupIndex: number,
  handlerIndex: number,
): ManagedCodexHooksPlanError | null {
  const duplicate = duplicateKnownProperty(node, KNOWN_COMMAND_FIELDS);
  if (duplicate) {
    return planError("invalid_document", `Duplicate command hook field ${duplicate}.`, {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  if (stringProperty(node, "command") === undefined) {
    return planError("invalid_document", "Command hooks require a string command.", {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  const windows = objectProperty(node, "commandWindows");
  const windowsAlias = objectProperty(node, "command_windows");
  if (windows && windowsAlias) {
    return planError("invalid_document", "Command hook Windows aliases cannot both be present.", {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  for (const property of [windows, windowsAlias]) {
    if (property && property.value.kind !== "string" && property.value.kind !== "null") {
      return planError("invalid_document", "Command hook Windows command must be a string or null.", {
        eventName,
        groupIndex,
        handlerIndex,
      });
    }
  }
  const timeout = objectProperty(node, "timeout");
  if (timeout && timeout.value.kind !== "null" && !isU64Node(timeout.value)) {
    return planError("invalid_document", "Command hook timeout must be an unsigned 64-bit integer or null.", {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  const asynchronous = objectProperty(node, "async");
  if (asynchronous && asynchronous.value.kind !== "boolean") {
    return planError("invalid_document", "Command hook async must be a boolean.", {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  const status = objectProperty(node, "statusMessage");
  if (status && status.value.kind !== "string" && status.value.kind !== "null") {
    return planError("invalid_document", "Command hook statusMessage must be a string or null.", {
      eventName,
      groupIndex,
      handlerIndex,
    });
  }
  return null;
}

interface StrictDocument {
  content: string;
  rootNode: JsonObjectNode;
  hooksNode?: JsonObjectNode;
  result: ValidCodexHooksConfigStrict;
}

function validateCodexHooksDocument(
  content: string,
  options: ManagedCodexHookOptions = {},
): StrictDocument | InvalidCodexHooksConfigStrict {
  const root = parseJsonSource(content);
  if (!root || root.kind !== "object") {
    return { ok: false, error: planError("invalid_document", "hooks.json must contain a JSON object.") };
  }
  const duplicateRoot = duplicateKnownProperty(root, KNOWN_ROOT_FIELDS);
  if (duplicateRoot) {
    return { ok: false, error: planError("invalid_document", `Duplicate root field ${duplicateRoot}.`) };
  }
  const rootUnknown = root.properties.find((property) => !KNOWN_ROOT_FIELDS.has(property.key));
  if (rootUnknown) {
    return {
      ok: false,
      error: planError("invalid_document", `Codex does not accept unknown root field ${rootUnknown.key}.`),
    };
  }

  const hooksProperty = objectProperty(root, "hooks");
  if (hooksProperty && hooksProperty.value.kind !== "object") {
    return { ok: false, error: planError("invalid_document", "Root hooks must be an object when present.") };
  }
  const hooksNode = hooksProperty?.value.kind === "object" ? hooksProperty.value : undefined;
  const duplicateEvent = hooksNode && duplicateKnownProperty(hooksNode, KNOWN_HOOK_EVENT_FIELDS);
  if (duplicateEvent) {
    return { ok: false, error: planError("invalid_document", `Duplicate hooks event ${duplicateEvent}.`) };
  }
  const diagnostics: CodexHooksDiagnostic[] = [];
  const groupOccurrences: CodexHookGroupOccurrence[] = [];
  const handlerOccurrences: CodexHookHandlerOccurrence[] = [];
  const discoveredCommands: CodexHookDiscoveryCommand[] = [];
  const platform = options.platform ?? process.platform;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const eventProperty = hooksNode ? objectProperty(hooksNode, eventName) : undefined;
    if (!eventProperty) continue;
    if (eventProperty.value.kind !== "array") {
      return {
        ok: false,
        error: planError("invalid_document", `${eventName} must be an array of matcher groups.`, { eventName }),
      };
    }
    for (const [groupIndex, groupNode] of eventProperty.value.elements.entries()) {
      if (groupNode.kind !== "object") {
        return {
          ok: false,
          error: planError("invalid_document", "Hook matcher groups must be objects.", { eventName, groupIndex }),
        };
      }
      groupOccurrences.push({ eventName, groupIndex, span: groupNode });
      const duplicate = duplicateKnownProperty(groupNode, KNOWN_GROUP_FIELDS);
      if (duplicate) {
        return {
          ok: false,
          error: planError("invalid_document", `Duplicate matcher group field ${duplicate}.`, { eventName, groupIndex }),
        };
      }
      const matcher = objectProperty(groupNode, "matcher");
      if (matcher && matcher.value.kind !== "string" && matcher.value.kind !== "null") {
        return {
          ok: false,
          error: planError("invalid_document", "Hook matcher must be a string or null.", { eventName, groupIndex }),
        };
      }
      const hooks = objectProperty(groupNode, "hooks");
      if (hooks && hooks.value.kind !== "array") {
        return {
          ok: false,
          error: planError("invalid_document", "Matcher group hooks must be an array when present.", { eventName, groupIndex }),
        };
      }
      const invalidMatcher =
        matcherIsAware(eventName) && matcher?.value.kind === "string" &&
        !isValidCodexMatcher(matcher.value.value);
      if (invalidMatcher) {
        diagnostics.push({
          code: "invalid_matcher",
          eventName,
          groupIndex,
          message: "Codex skips groups whose matcher is not a valid regular expression.",
        });
      }
      const handlers = hooks?.value.kind === "array" ? hooks.value.elements : [];
      for (const [handlerIndex, handlerNode] of handlers.entries()) {
        handlerOccurrences.push({ eventName, groupIndex, handlerIndex, span: handlerNode });
        if (handlerNode.kind !== "object") {
          return {
            ok: false,
            error: planError("invalid_document", "Hook handlers must be objects.", { eventName, groupIndex, handlerIndex }),
          };
        }
        const duplicateType = duplicateKnownProperty(handlerNode, KNOWN_HANDLER_TYPE_FIELD);
        if (duplicateType) {
          return {
            ok: false,
            error: planError("invalid_document", "Duplicate hook handler type field.", { eventName, groupIndex, handlerIndex }),
          };
        }
        const type = stringProperty(handlerNode, "type");
        if (type !== "command" && type !== "prompt" && type !== "agent") {
          return {
            ok: false,
            error: planError("invalid_document", "Hook handler type must be command, prompt, or agent.", {
              eventName,
              groupIndex,
              handlerIndex,
            }),
          };
        }
        if (type !== "command") {
          diagnostics.push({
            code: "unsupported_handler",
            eventName,
            groupIndex,
            handlerIndex,
            message: `Codex preserves but does not discover ${type} hook handlers.`,
          });
          continue;
        }
        const commandError = validateCommandHandler(handlerNode, eventName, groupIndex, handlerIndex);
        if (commandError) return { ok: false, error: commandError };
        const command = effectiveCommandForPlatform(handlerNode, platform);
        const asyncProperty = objectProperty(handlerNode, "async");
        const asynchronous = asyncProperty?.value.kind === "boolean" &&
          asyncProperty.value.value === true;
        if (asynchronous) {
          diagnostics.push({
            code: "async_command",
            eventName,
            groupIndex,
            handlerIndex,
            message: "Codex skips async command hook handlers.",
          });
        } else if (commandIsSkipped(command)) {
          diagnostics.push({
            code: "empty_command",
            eventName,
            groupIndex,
            handlerIndex,
            message: "Codex skips empty command hook handlers.",
          });
        } else if (!invalidMatcher) {
          discoveredCommands.push({ eventName, groupIndex, handlerIndex, command });
        }
      }
    }
  }

  return {
    content,
    rootNode: root,
    hooksNode,
    result: {
      ok: true,
      root: cloneJson(root.value),
      diagnostics,
      groupOccurrences,
      handlerOccurrences,
      discoveredCommands,
    },
  };
}

export function validateCodexHooksConfigStrict(
  content: string,
  options: ManagedCodexHookOptions = {},
): CodexHooksConfigStrictResult {
  const result = validateCodexHooksDocument(content, options);
  return "result" in result ? result.result : result;
}

/** Compatibility-only permissive JSON intake; strict plans never use this parser. */
export function parseCodexHooksConfig(content: string): ParsedCodexHooksConfig | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) return null;
    return {
      root: cloneJson(parsed),
      hooks: isPlainObject(parsed.hooks) ? cloneJson(parsed.hooks) : {},
    };
  } catch {
    return null;
  }
}

const UNQUOTED_POSIX_SHELL_ACTIVE_CHARACTERS = new Set([
  "\r", "\n", ";", "|", "&", "<", ">", "`", "$", "(", ")", "*", "?", "[", "]", "{", "}", "~", "!", "#",
]);
const UNQUOTED_POWERSHELL_ACTIVE_CHARACTERS = new Set([
  "\r", "\n", ";", "|", "<", ">", "`", "$", "(", ")", "*", "?", "[", "]", "{", "}", "~", "!", "#", "@", "%", "^",
]);

function isShellWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}

/**
 * Decode only shell-static POSIX words. The decoder preserves enough quote and
 * escape provenance to reject interpolation and shell-active syntax instead of
 * merely comparing the decoded argument values.
 */
function tokenizePosixCommand(
  command: string,
  preserveWindowsBackslashes = false,
): string[] | null {
  if (containsControlCharacter(command)) return null;
  const words: string[] = [];
  let word = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === "$" || character === "`") {
        return null;
      } else if (character === "\\" && !preserveWindowsBackslashes) {
        const escaped = command[index + 1];
        if (!escaped || escaped === "\r" || escaped === "\n") return null;
        if (["$", "`", '"', "\\"].includes(escaped)) {
          word += escaped;
          index += 1;
        } else {
          // POSIX preserves a backslash in double quotes unless it quotes a
          // shell-active character. Keep it so suffix comparisons are exact.
          word += "\\";
        }
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (UNQUOTED_POSIX_SHELL_ACTIVE_CHARACTERS.has(character)) return null;
    if (character === "\\" && !preserveWindowsBackslashes) {
      const escaped = command[index + 1];
      if (!escaped || escaped === "\r" || escaped === "\n") return null;
      word += escaped;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (isShellWhitespace(character)) {
      if (tokenStarted) {
        words.push(word);
        word = "";
        tokenStarted = false;
      }
      continue;
    }
    word += character;
    tokenStarted = true;
  }
  if (quote) return null;
  if (tokenStarted) words.push(word);
  return words.length > 0 ? words : null;
}

const ALWAYS_UNSAFE_WINDOWS_DIRECT_COMMAND_CHARACTERS = new Set(["%", "!", "$", "`"]);
const UNQUOTED_UNSAFE_WINDOWS_DIRECT_COMMAND_CHARACTERS = new Set([
  "&", "|", "<", ">", "(", ")", "^", ";", "@", "*", "?", "[", "]", "{", "}", "~",
]);

/**
 * Empty/concatenated double-quote runs have cmd/UCRT and PowerShell parsing
 * rules that this ownership grammar intentionally does not model. Reject them
 * before tokenization so they cannot disappear into an owned proof path.
 */
function containsAdjacentDoubleQuotes(command: string): boolean {
  return command.includes('""');
}


/**
 * Decode only cmd.exe-static argv. This intentionally permits only double-quote
 * grouping and the CommandLineToArgvW backslash/quote convention; all cmd
 * expansion and unquoted operator syntax is rejected during tokenization.
 */
function tokenizeWindowsDirectCommand(command: string): string[] | null {
  if (containsControlCharacter(command) || containsAdjacentDoubleQuotes(command)) return null;

  const words: string[] = [];
  let word = "";
  let tokenStarted = false;
  let quoted = false;
  for (let index = 0; index < command.length;) {
    const character = command[index]!;
    if (
      ALWAYS_UNSAFE_WINDOWS_DIRECT_COMMAND_CHARACTERS.has(character) ||
      (!quoted && UNQUOTED_UNSAFE_WINDOWS_DIRECT_COMMAND_CHARACTERS.has(character))
    ) return null;
    if (character === "\\") {
      const start = index;
      while (command[index] === "\\") index += 1;
      const count = index - start;
      if (command[index] === '"') {
        word += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 0) quoted = !quoted;
        else word += '"';
        tokenStarted = true;
        index += 1;
      } else {
        word += "\\".repeat(count);
        tokenStarted = true;
      }
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (isShellWhitespace(character)) {
      if (quoted) {
        word += character;
      } else if (tokenStarted) {
        words.push(word);
        word = "";
        tokenStarted = false;
      }
      index += 1;
      continue;
    }
    word += character;
    tokenStarted = true;
    index += 1;
  }
  if (quoted) return null;
  if (tokenStarted) words.push(word);
  return words.length > 0 && words.every((value) => !value.includes('"')) ? words : null;
}


function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

const WINDOWS_RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function isReservedWindowsDeviceComponent(component: string): boolean {
  const dot = component.indexOf(".");
  const deviceStem = (dot === -1 ? component : component.slice(0, dot)).replace(/ +$/, "");
  return WINDOWS_RESERVED_DEVICE_STEM.test(deviceStem);
}

/**
 * Managed command ownership accepts only ordinary Win32 path syntax. Namespace,
 * device, stream, and wildcard forms can be lexically static yet resolve outside
 * the filesystem path the command appears to name, so do not own them.
 */
function isValidWindowsFilesystemPath(path: string): boolean {
  if (!path || containsControlCharacter(path) || /["<>|?*]/.test(path)) return false;
  if (
    /^(?:[\\/]{3,}|[\\/]{1,2}[?.][\\/]|[\\/]{1,2}\?\?[\\/]|[\\/](?:device|globalroot)[\\/])/i.test(path)
  ) return false;

  const firstColon = path.indexOf(":");
  if (
    firstColon !== -1 &&
    (firstColon !== 1 || !/[A-Za-z]/.test(path[0]!) || path.indexOf(":", firstColon + 1) !== -1)
  ) return false;

  return path.split(/[\\/]+/).every((segment) =>
    !segment || /^[A-Za-z]:$/.test(segment) ||
      (!segment.endsWith(".") && !segment.endsWith(" ") && !isReservedWindowsDeviceComponent(segment))
  );
}

/** Accept only drive-absolute or complete UNC paths as ownership proof. */
function isQualifiedWindowsFilesystemPath(path: string): boolean {
  if (!isValidWindowsFilesystemPath(path)) return false;
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (!/^[\\/]{2}/.test(path)) return false;
  const uncSegments = path.slice(2).split(/[\\/]+/);
  return uncSegments.length >= 2 && uncSegments[0]!.length > 0 && uncSegments[1]!.length > 0;
}

function isAbsolutePosixFilesystemPath(path: string): boolean {
  return path.startsWith("/") && !containsControlCharacter(path);
}

interface StaticPowerShellCommandToken {
  value: string;
  quoted: boolean;
}

interface StaticPowerShellCommand {
  tokens: StaticPowerShellCommandToken[];
  hasCallOperator: boolean;
}

/** Decode only literal PowerShell command words; interpolation is never owned. */
function tokenizePowerShellCommand(command: string): StaticPowerShellCommand | null {
  const tokens: StaticPowerShellCommandToken[] = [];
  let word = "";
  let tokenStarted = false;
  let tokenQuoted = false;
  let quote: "'" | '"' | undefined;
  let hasCallOperator = false;

  if (containsControlCharacter(command) || containsAdjacentDoubleQuotes(command)) return null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character !== "'") {
        word += character;
        continue;
      }
      if (command[index + 1] === "'") {
        word += "'";
        index += 1;
        continue;
      }
      quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === "$" || character === "`") {
        return null;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      tokenQuoted = true;
      continue;
    }
    if (character === "&") {
      if (
        hasCallOperator ||
        tokenStarted ||
        tokens.length > 0 ||
        !isShellWhitespace(command[index + 1] ?? "")
      ) return null;
      hasCallOperator = true;
      continue;
    }
    if (UNQUOTED_POWERSHELL_ACTIVE_CHARACTERS.has(character)) return null;
    if (isShellWhitespace(character)) {
      if (tokenStarted) {
        tokens.push({ value: word, quoted: tokenQuoted });
        word = "";
        tokenStarted = false;
        tokenQuoted = false;
      }
      continue;
    }
    word += character;
    tokenStarted = true;
  }
  if (quote) return null;
  if (tokenStarted) tokens.push({ value: word, quoted: tokenQuoted });
  return tokens.length > 0 ? { tokens, hasCallOperator } : null;
}

function commandBasename(path: string, platform: HookCommandPlatform): string {
  const executable = platform === "win32"
    ? path.split(/[\\/]/).pop()
    : path.split("/").pop();
  return platform === "win32" ? executable?.toLowerCase() ?? "" : executable ?? "";
}

function isNativeHookScriptPath(path: string, platform: HookCommandPlatform): boolean {
  return platform === "win32"
    ? isQualifiedWindowsFilesystemPath(path) &&
      /(?:^|[\\/])dist[\\/]scripts[\\/]codex-native-hook\.js$/i.test(path)
    : isAbsolutePosixFilesystemPath(path) &&
      /(?:^|\/)dist\/scripts\/codex-native-hook\.js$/.test(path);
}

function hasNativeHookShimSuffix(path: string): boolean {
  return /(?:^|[\\/])hooks[\\/]omx-native-hook-windows-shim\.ps1$/i.test(path);
}

function isNativeHookShimPath(path: string): boolean {
  return isQualifiedWindowsFilesystemPath(path) && hasNativeHookShimSuffix(path);
}

function isSupportedDirectNodeExecutablePath(
  executablePath: string,
  platform: HookCommandPlatform,
): boolean {
  const bareExecutable = platform === "win32" ? executablePath.toLowerCase() : executablePath;
  const supportedBareExecutable = platform === "win32"
    ? bareExecutable === "node" || bareExecutable === "node.exe"
    : bareExecutable === "node";
  return supportedBareExecutable ||
    (platform === "win32"
      ? isQualifiedWindowsFilesystemPath(executablePath)
      : isAbsolutePosixFilesystemPath(executablePath)) &&
      (platform === "win32"
        ? commandBasename(executablePath, "win32") === "node" ||
          commandBasename(executablePath, "win32") === "node.exe"
        : commandBasename(executablePath, "linux") === "node");
}

function isSupportedPowerShellExecutablePath(executablePath: string): boolean {
  return executablePath.toLowerCase() === "powershell.exe" ||
    (isQualifiedWindowsFilesystemPath(executablePath) &&
      commandBasename(executablePath, "win32") === "powershell.exe");
}

function isValidDirectNodeCommand(command: string, platform: HookCommandPlatform): boolean {
  const words = platform === "win32"
    ? tokenizeWindowsDirectCommand(command)
    : tokenizePosixCommand(command);
  const executablePath = words?.[0];
  const scriptPath = words?.[1];
  return words?.length === 2 &&
    executablePath !== undefined &&
    scriptPath !== undefined &&
    isSupportedDirectNodeExecutablePath(executablePath, platform) &&
    isNativeHookScriptPath(scriptPath, platform);
}

function hasStaticWindowsShimCommandGrammar(command: string): boolean {
  const parsed = tokenizePowerShellCommand(command);
  if (!parsed) return false;
  const { tokens, hasCallOperator } = parsed;
  const powerShellToken = tokens[0];
  const powerShellPath = powerShellToken?.value;
  const shimPath = tokens[5]?.value;
  return tokens.length === 6 &&
    powerShellToken !== undefined &&
    powerShellPath !== undefined &&
    shimPath !== undefined &&
    (!powerShellToken.quoted || hasCallOperator) &&
    isSupportedPowerShellExecutablePath(powerShellPath) &&
    isValidWindowsFilesystemPath(shimPath) &&
    tokens[1]?.value.toLowerCase() === "-noprofile" &&
    tokens[2]?.value.toLowerCase() === "-executionpolicy" &&
    tokens[3]?.value.toLowerCase() === "bypass" &&
    tokens[4]?.value.toLowerCase() === "-file" &&
    hasNativeHookShimSuffix(shimPath);
}

/**
 * Parse an OMX Windows shim invocation using the managed-command ownership
 * grammar. Returns the validated shim path; returns null for every other
 * command. Supplying current install options additionally recognizes the exact
 * non-Windows host-path spelling used by platform-seam validation.
 */
export function parseManagedCodexNativeHookWindowsShimCommand(
  command: string,
  options?: ManagedCodexHookOptions,
): string | null {
  const parsed = tokenizePowerShellCommand(command);
  const shimPath = parsed?.tokens[5]?.value;
  return shimPath !== undefined &&
      hasStaticWindowsShimCommandGrammar(command) &&
      (isNativeHookShimPath(shimPath) ||
        (options !== undefined &&
          isExactCurrentWindowsShimCommand(command, "win32", options)))
    ? shimPath
    : null;
}

function isValidWindowsShimCommand(command: string): boolean {
  return parseManagedCodexNativeHookWindowsShimCommand(command) !== null;
}

const OMX_COMMAND_PATTERN = /(?:codex-native-hook\.js|omx-native-hook-windows-shim\.ps1)/i;

/**
 * Lex only static POSIX word fragments for ambiguity detection. This is
 * deliberately more permissive than the ownership grammar: backslash-newline
 * continuations and escaped characters must identify OMX-looking commands as
 * ambiguous, never make them owned.
 */
function decodedPosixCommandWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  const flushWord = (): void => {
    if (word) words.push(word);
    word = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const escaped = command[index + 1];
        if (escaped === "\n") {
          index += 1;
        } else if (escaped === "\r" && command[index + 2] === "\n") {
          index += 2;
        } else if (escaped && ["$", "`", '"', "\\"].includes(escaped)) {
          word += escaped;
          index += 1;
        } else {
          word += "\\";
        }
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      const escaped = command[index + 1];
      if (escaped === "\n") {
        index += 1;
      } else if (escaped === "\r" && command[index + 2] === "\n") {
        index += 2;
      } else if (escaped) {
        word += escaped;
        index += 1;
      } else {
        word += character;
      }
      continue;
    }
    if (isShellWhitespace(character) || UNQUOTED_POSIX_SHELL_ACTIVE_CHARACTERS.has(character)) {
      flushWord();
      continue;
    }
    word += character;
  }
  flushWord();
  return words;
}

function commandMentionsDecodedPosixOmx(command: string): boolean {
  return decodedPosixCommandWords(command).some((word) => OMX_COMMAND_PATTERN.test(word));
}

function commandMentionsOmx(command: string): boolean {
  return OMX_COMMAND_PATTERN.test(command) || OMX_COMMAND_PATTERN.test(command.replace(/["']/g, ""));
}

function isValidManagedCommand(command: string, platform: HookCommandPlatform): boolean {
  return isValidDirectNodeCommand(command, platform) ||
    (platform === "win32" && isValidWindowsShimCommand(command));
}

function buildExactCurrentWindowsHostShimCommand(
  options: ManagedCodexHookOptions,
): string | null {
  if (
    process.platform === "win32" ||
    (options.platform ?? process.platform) !== "win32" ||
    options.codexHomeDir === undefined
  ) return null;
  const shimPath = join(options.codexHomeDir, ...WINDOWS_NATIVE_HOOK_SHIM_RELATIVE_PATH);
  const powerShellPath = resolveWindowsPowerShellPath(options.env);
  return `& ${quotePowerShellLiteral(powerShellPath)} -NoProfile -ExecutionPolicy Bypass -File ${quotePowerShellLiteral(shimPath)}`;
}

/**
 * A current Windows command may have a drive-less shim path in non-Windows
 * platform seams. Accept only byte-identical canonical or host-joined command
 * spellings produced from resolved current options; generic historical
 * classification remains provenance-qualified.
 */
function isExactCurrentWindowsShimCommand(
  command: string,
  platform: HookCommandPlatform,
  options: ManagedCodexHookOptions,
): boolean {
  if (
    platform !== "win32" ||
    (options.platform ?? process.platform) !== "win32" ||
    options.codexHomeDir === undefined ||
    !hasStaticWindowsShimCommandGrammar(command)
  ) return false;
  return command === buildManagedCodexNativeHookCommand("", options) ||
    command === buildExactCurrentWindowsHostShimCommand(options);
}

function isValidHistoricalManagedCommand(command: string): boolean {
  return isValidDirectNodeCommand(command, "linux") ||
    isValidDirectNodeCommand(command, "win32") ||
    isValidWindowsShimCommand(command);
}

/**
 * Returns whether a command has the exact approved token grammar of an OMX
 * native hook from this or a historical installation. Ownership requires a
 * shell-static executable and provenance-qualified terminal script path, but
 * never a current package-root path. The union is deliberately narrow and
 * accepts only shell-static POSIX, Windows, or PowerShell command spellings.
 */
export function isManagedCodexHookCommand(command: string): boolean {
  return isValidHistoricalManagedCommand(command);
}

type ManagedCommandClassification = "owned" | "foreign" | "ambiguous";

function classifyManagedCommand(
  handler: JsonObjectNode,
  options: ManagedCodexHookOptions,
): ManagedCommandClassification {
  const command = stringProperty(handler, "command")!;
  const windows = nullableStringProperty(handler, "commandWindows") ??
    nullableStringProperty(handler, "command_windows");
  const platform = options.platform ?? process.platform;
  const commandPlatform = typeof windows === "string" ? "linux" : platform;
  const supplied = [
    { command, platform: commandPlatform },
    ...(typeof windows === "string" ? [{ command: windows, platform: "win32" as const }] : []),
  ];
  let hasOwnedCommand = false;
  let hasForeignAlternative = false;
  for (const suppliedCommand of supplied) {
    // Examine static POSIX word decoding before exact grammar validation. A
    // non-exact invocation can hide an OMX filename with escapes or a line
    // continuation, and must fail closed rather than become a foreign hook.
    const mentionsDecodedPosixOmx = commandMentionsDecodedPosixOmx(suppliedCommand.command);
    if (
      isValidManagedCommand(suppliedCommand.command, suppliedCommand.platform) ||
      isExactCurrentWindowsShimCommand(suppliedCommand.command, suppliedCommand.platform, options)
    ) {
      hasOwnedCommand = true;
      continue;
    }
    if (mentionsDecodedPosixOmx || commandMentionsOmx(suppliedCommand.command)) return "ambiguous";
    hasForeignAlternative = true;
  }
  return hasOwnedCommand
    ? hasForeignAlternative ? "ambiguous" : "owned"
    : "foreign";
}


interface ManagedOwner {
  eventName: ManagedHookEventName;
  groupIndex: number;
  handlerIndex: number;
  groupNode: JsonObjectNode;
  handlerNode: JsonObjectNode;
  opaqueHandler: boolean;
}

interface RawHandlerModel {
  node: JsonObjectNode;
  owner?: ManagedOwner;
  foreign: boolean;
  discoverySkipped?: boolean;
}

interface RawGroupModel {
  eventName: CodexHookEventName;
  groupIndex: number;
  node: JsonObjectNode;
  handlers: RawHandlerModel[];
  opaque: boolean;
  foreign: boolean;
}

interface OwnershipModel {
  owners: ManagedOwner[];
  groups: RawGroupModel[];
}

function hasOpaqueProperties(node: JsonObjectNode, known: ReadonlySet<string>): boolean {
  return node.properties.some((property) => !known.has(property.key));
}

function groupMatcher(node: JsonObjectNode): string | null | undefined {
  return nullableStringProperty(node, "matcher");
}

function matcherOwnershipError(
  eventName: ManagedHookEventName,
  group: RawGroupModel,
): ManagedCodexHooksPlanError | null {
  const matcher = groupMatcher(group.node);
  if (matcherIsAware(eventName) && typeof matcher === "string" && !isValidCodexMatcher(matcher)) {
    return planError("ambiguous_managed_group", "Cannot mutate an OMX group with an invalid matcher.", {
      eventName,
      groupIndex: group.groupIndex,
    });
  }
  const foreignSiblings = group.handlers.some((handler) => !handler.owner);

  if (eventName === "SessionStart") {
    const allowed = foreignSiblings
      ? matcher === "startup|resume|clear"
      : matcher === undefined || matcher === null || matcher === "startup" || matcher === "startup|resume" || matcher === "startup|resume|clear";
    if (!allowed) {
      return planError("ambiguous_managed_group", "SessionStart matcher is not compatible with OMX ownership.", {
        eventName,
        groupIndex: group.groupIndex,
      });
    }
  } else if (matcher !== undefined && matcher !== null) {
    return planError("ambiguous_managed_group", "OMX managed groups must not carry a matcher for this event.", {
      eventName,
      groupIndex: group.groupIndex,
    });
  }
  return null;
}

function inspectOwnership(
  document: StrictDocument,
  options: ManagedCodexHookOptions,
): OwnershipModel | ManagedCodexHooksPlanError {
  const groups: RawGroupModel[] = [];
  const owners: ManagedOwner[] = [];
  for (const eventName of CODEX_HOOK_EVENTS) {
    const event = document.hooksNode ? objectProperty(document.hooksNode, eventName) : undefined;
    if (!event || event.value.kind !== "array") continue;
    for (const [groupIndex, groupNode] of event.value.elements.entries()) {
      if (groupNode.kind !== "object") continue;
      const hooks = objectProperty(groupNode, "hooks");
      const handlerNodes = hooks?.value.kind === "array" ? hooks.value.elements : [];
      const handlers: RawHandlerModel[] = [];
      for (const [handlerIndex, handlerNode] of handlerNodes.entries()) {
        if (handlerNode.kind !== "object") continue;
        const type = stringProperty(handlerNode, "type");
        let classification: ManagedCommandClassification = "foreign";
        if (type === "command") classification = classifyManagedCommand(handlerNode, options);
        if (classification === "ambiguous") {
          return planError("ambiguous_managed_handler", "A command mentions OMX but does not match the managed command grammar.", {
            eventName,
            groupIndex,
            handlerIndex,
          });
        }
        const asyncProperty = type === "command"
          ? objectProperty(handlerNode, "async")
          : undefined;
        const asynchronous = asyncProperty?.value.kind === "boolean" &&
          asyncProperty.value.value === true;
        if (classification !== "owned" || !isManagedHookEventName(eventName)) {
          if (classification === "owned") {
            return planError("ambiguous_managed_handler", "An OMX command is attached to an unmanaged Codex event.", {
              eventName,
              groupIndex,
              handlerIndex,
            });
          }
          const foreignCommandIsSkipped = type === "command" && (
            commandIsSkipped(effectiveCommandForPlatform(handlerNode, options.platform ?? process.platform)) || asynchronous
          );
          handlers.push({ node: handlerNode, foreign: true, discoverySkipped: foreignCommandIsSkipped });
          continue;
        }
        const command = effectiveCommandForPlatform(handlerNode, options.platform ?? process.platform);
        if (asynchronous || commandIsSkipped(command)) {
          return planError("ambiguous_managed_handler", "Cannot mutate skipped OMX command handlers.", {
            eventName,
            groupIndex,
            handlerIndex,
          });
        }
        const owner: ManagedOwner = {
          eventName,
          groupIndex,
          handlerIndex,
          groupNode,
          handlerNode,
          opaqueHandler: hasOpaqueProperties(handlerNode, KNOWN_COMMAND_FIELDS),
        };
        owners.push(owner);
        handlers.push({ node: handlerNode, owner, foreign: false });
      }
      const group: RawGroupModel = {
        eventName,
        groupIndex,
        node: groupNode,
        handlers,
        opaque: hasOpaqueProperties(groupNode, KNOWN_GROUP_FIELDS),
        foreign: false,
      };
      group.foreign = handlers.length === 0 || handlers.some((handler) => handler.foreign);
      groups.push(group);
      const groupOwners = handlers.flatMap((handler) => handler.owner ? [handler.owner] : []);
      if (groupOwners.length > 0) {
        if (handlers.some((handler) => handler.discoverySkipped)) {
          return planError("ambiguous_managed_handler", "Cannot mutate an OMX group that also contains a skipped command handler.", {
            eventName,
            groupIndex,
          });
        }
        const error = matcherOwnershipError(eventName as ManagedHookEventName, group);
        if (error) return error;
      }
    }
  }
  return { owners, groups };
}

interface SourcePatch extends SourceSpan {
  text: string;
}

function applySourcePatches(content: string, patches: SourcePatch[]): string {
  const ordered = [...patches].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.end > ordered[index]!.start) {
      throw new Error("Overlapping source patches are not permitted.");
    }
  }
  let result = content;
  for (const patch of ordered.reverse()) {
    result = result.slice(0, patch.start) + patch.text + result.slice(patch.end);
  }
  return result;
}

function propertyRemovalPatch(object: JsonObjectNode, property: JsonProperty): SourcePatch {
  if (object.properties.length === 1) {
    return { start: object.start + 1, end: object.end - 1, text: "" };
  }
  const index = object.properties.indexOf(property);
  if (index < object.properties.length - 1) {
    return { start: property.keyNode.start, end: object.properties[index + 1]!.keyNode.start, text: "" };
  }
  return { start: object.properties[index - 1]!.value.end, end: property.value.end, text: "" };
}


function appendObjectPropertyPatch(object: JsonObjectNode, key: string, value: string): SourcePatch {
  const prefix = object.properties.length === 0 ? "" : ",";
  return { start: object.end - 1, end: object.end - 1, text: `${prefix}${JSON.stringify(key)}:${value}` };
}

function appendObjectPropertiesPatch(
  object: JsonObjectNode,
  entries: ReadonlyArray<readonly [string, string]>,
): SourcePatch {
  const prefix = object.properties.length === 0 ? "" : ",";
  const text = entries
    .map(([key, value]) => `${JSON.stringify(key)}:${value}`)
    .join(",");
  return { start: object.end - 1, end: object.end - 1, text: `${prefix}${text}` };
}


function appendArrayElementPatch(array: JsonArrayNode, value: string): SourcePatch {
  const prefix = array.elements.length === 0 ? "" : ",";
  return { start: array.end - 1, end: array.end - 1, text: `${prefix}${value}` };
}

function knownFieldPatches(
  content: string,
  node: JsonObjectNode,
  desired: Record<string, unknown>,
  known: ReadonlySet<string>,
): SourcePatch[] {
  const removedProperties = node.properties.filter((property) =>
    known.has(property.key) && !Object.hasOwn(desired, property.key)
  );
  if (removedProperties.length > 1) {
    const members = node.properties.flatMap((property) => {
      if (!known.has(property.key)) return [content.slice(property.keyNode.start, property.value.end)];
      if (!Object.hasOwn(desired, property.key)) return [];
      return [`${JSON.stringify(property.key)}:${JSON.stringify(desired[property.key])}`];
    });
    for (const [key, value] of Object.entries(desired)) {
      if (!objectProperty(node, key)) members.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    }
    return [{ start: node.start, end: node.end, text: `{${members.join(",")}}` }];
  }

  const patches: SourcePatch[] = [];
  for (const property of node.properties) {
    if (!known.has(property.key)) continue;
    if (Object.hasOwn(desired, property.key)) {
      patches.push({
        start: property.value.start,
        end: property.value.end,
        text: JSON.stringify(desired[property.key]),
      });
    } else {
      patches.push(propertyRemovalPatch(node, property));
    }
  }
  for (const [key, value] of Object.entries(desired)) {
    if (!objectProperty(node, key)) patches.push(appendObjectPropertyPatch(node, key, JSON.stringify(value)));
  }
  return patches;
}

function serializeCodexHooksConfig(root: JsonObject): string {
  return JSON.stringify(root, null, 2) + "\n";
}

class CanonicalJsonNumber {
  constructor(readonly raw: string) {}
}

function canonicalJsonString(value: unknown): string {
  if (value instanceof CanonicalJsonNumber) return value.raw;
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonString(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Codex hook trust identity must be JSON-serializable.");
  return serialized;
}

function versionForCodexTomlIdentity(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJsonString(value)).digest("hex")}`;
}

function managedHookStateKey(
  hooksPath: string,
  eventName: ManagedHookEventName,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${hooksPath}:${CODEX_HOOK_EVENT_LABELS[eventName]}:${groupIndex}:${handlerIndex}`;
}

function canonicalHookForEvent(entry: ManagedHookEntry): Record<string, unknown> {
  const hook = entry.hooks[0]!;
  return {
    type: "command",
    command: hook.command,
    ...(typeof hook.timeout === "number" ? { timeout: hook.timeout } : {}),
  };
}

function canonicalGroupForEvent(entry: ManagedHookEntry): Record<string, unknown> {
  return {
    ...(entry.matcher ? { matcher: entry.matcher } : {}),
    hooks: [canonicalHookForEvent(entry)],
  };
}

function canonicalMatcherForEvent(entry: ManagedHookEntry): Record<string, unknown> {
  return entry.matcher ? { matcher: entry.matcher } : {};
}

function removesAllGroupHandlers(
  group: RawGroupModel,
  ownersToRemove: ReadonlySet<ManagedOwner>,
): boolean {
  return group.handlers.length > 0 &&
    group.handlers.every((handler) => handler.owner && ownersToRemove.has(handler.owner));
}

function removalProof(
  model: OwnershipModel,
  ownersToRemove: ReadonlySet<ManagedOwner>,
): ManagedCodexHooksCoordinateProof {
  for (const group of model.groups) {
    if (group.opaque && removesAllGroupHandlers(group, ownersToRemove)) {
      return {
        safe: false,
        shifted: {
          kind: "group",
          eventName: group.eventName,
          oldCoordinate: [group.groupIndex],
        },
      };
    }
  }
  for (const owner of ownersToRemove) {
    if (owner.opaqueHandler) {
      return {
        safe: false,
        shifted: {
          kind: "handler",
          eventName: owner.eventName,
          oldCoordinate: [owner.groupIndex, owner.handlerIndex],
        },
      };
    }
  }

  const byEvent = new Map<CodexHookEventName, RawGroupModel[]>();
  for (const group of model.groups) {
    const eventGroups = byEvent.get(group.eventName) ?? [];
    eventGroups.push(group);
    byEvent.set(group.eventName, eventGroups);
  }
  for (const [eventName, groups] of byEvent) {
    const removedGroups = new Set<RawGroupModel>();
    for (const group of groups) {
      if (!group.opaque && removesAllGroupHandlers(group, ownersToRemove)) {
        removedGroups.add(group);
      }
    }
    const survivors = groups.filter((group) => !removedGroups.has(group));
    for (const group of groups) {
      const newGroupIndex = survivors.indexOf(group);
      if (group.foreign && newGroupIndex !== group.groupIndex) {
        return {
          safe: false,
          shifted: {
            kind: "group",
            eventName,
            oldCoordinate: [group.groupIndex],
            ...(newGroupIndex >= 0 ? { newCoordinate: [newGroupIndex] } : {}),
          },
        };
      }
      if (newGroupIndex < 0) continue;
      const remainingHandlers = group.handlers.filter((handler) => !handler.owner || !ownersToRemove.has(handler.owner));
      for (const [handlerIndex, handler] of group.handlers.entries()) {
        if (!handler.foreign || ownersToRemove.has(handler.owner!)) continue;
        const newHandlerIndex = remainingHandlers.indexOf(handler);
        if (newHandlerIndex !== handlerIndex) {
          return {
            safe: false,
            shifted: {
              kind: "handler",
              eventName,
              oldCoordinate: [group.groupIndex, handlerIndex],
              newCoordinate: [newGroupIndex, newHandlerIndex],
            },
          };
        }
      }
    }
  }
  return { safe: true };
}

function fullRemovalGroupKeys(
  model: OwnershipModel,
  ownersToRemove: ReadonlySet<ManagedOwner>,
): Map<CodexHookEventName, Set<number>> {
  const keys = new Map<CodexHookEventName, Set<number>>();
  for (const group of model.groups) {
    const removable = !group.opaque && removesAllGroupHandlers(group, ownersToRemove);
    if (!removable) continue;
    const eventKeys = keys.get(group.eventName) ?? new Set<number>();
    eventKeys.add(group.groupIndex);
    keys.set(group.eventName, eventKeys);
  }
  return keys;
}

function arrayWithoutElements(
  content: string,
  array: JsonArrayNode,
  removed: ReadonlySet<JsonNode>,
): SourcePatch {
  const values: string[] = [];
  for (const element of array.elements) {
    if (!removed.has(element)) values.push(content.slice(element.start, element.end));
  }
  return { start: array.start, end: array.end, text: `[${values.join(",")}]` };
}

function eventArrayForGroup(document: StrictDocument, eventName: CodexHookEventName): JsonArrayNode | undefined {
  const event = document.hooksNode ? objectProperty(document.hooksNode, eventName) : undefined;
  return event?.value.kind === "array" ? event.value : undefined;
}

function pruneRemovedManagedEventProperties(
  content: string,
  deletedEvents: ReadonlySet<CodexHookEventName>,
  options: ManagedCodexHookOptions,
): string | null | ManagedCodexHooksPlanError {
  let current = content;
  for (;;) {
    const validation = validateCodexHooksDocument(current, options);
    if (!("result" in validation)) return validation.error;
    let emptyEvent: CodexHookEventName | undefined;
    for (const eventName of deletedEvents) {
      const event = validation.hooksNode ? objectProperty(validation.hooksNode, eventName) : undefined;
      if (event?.value.kind === "array" && event.value.elements.length === 0) {
        emptyEvent = eventName;
        break;
      }
    }
    if (emptyEvent === undefined) {
      if (!validation.hooksNode || validation.hooksNode.properties.length > 0) return current;
      const hooks = objectProperty(validation.rootNode, "hooks");
      if (!hooks) return validation.rootNode.properties.length === 0 ? null : current;
      current = applySourcePatches(current, [propertyRemovalPatch(validation.rootNode, hooks)]);
      const afterRoot = validateCodexHooksDocument(current, options);
      if (!("result" in afterRoot)) return afterRoot.error;
      return afterRoot.rootNode.properties.length === 0 ? null : current;
    }
    const property = objectProperty(validation.hooksNode!, emptyEvent)!;
    current = applySourcePatches(current, [propertyRemovalPatch(validation.hooksNode!, property)]);
  }
}

function applyCoordinateSafeRemovals(
  content: string,
  model: OwnershipModel,
  ownersToRemove: ReadonlySet<ManagedOwner>,
  options: ManagedCodexHookOptions,
): string | null | ManagedCodexHooksPlanError {
  const fullGroups = fullRemovalGroupKeys(model, ownersToRemove);
  const partialPatches: SourcePatch[] = [];
  for (const group of model.groups) {
    if (fullGroups.get(group.eventName)?.has(group.groupIndex)) continue;
    const hooks = objectProperty(group.node, "hooks")?.value;
    if (hooks?.kind !== "array") continue;
    const removedHandlers = new Set<JsonNode>(group.handlers
      .filter((handler) => handler.owner && ownersToRemove.has(handler.owner))
      .map((handler) => handler.node));
    if (removedHandlers.size > 0) partialPatches.push(arrayWithoutElements(content, hooks, removedHandlers));
  }
  let current = partialPatches.length > 0 ? applySourcePatches(content, partialPatches) : content;
  if (fullGroups.size === 0) return current;

  const afterPartial = validateCodexHooksDocument(current, options);
  if (!("result" in afterPartial)) return afterPartial.error;
  const afterOwnership = inspectOwnership(afterPartial, options);
  if (afterOwnership instanceof ManagedCodexHooksPlanError) return afterOwnership;
  const groupPatches: SourcePatch[] = [];
  const deletedEvents = new Set<CodexHookEventName>();
  for (const [eventName, groupIndices] of fullGroups) {
    const array = eventArrayForGroup(afterPartial, eventName);
    if (!array) continue;
    const removedGroups = new Set<JsonNode>(afterOwnership.groups
      .filter((group) => group.eventName === eventName && groupIndices.has(group.groupIndex))
      .map((group) => group.node));
    if (removedGroups.size === 0) continue;
    groupPatches.push(arrayWithoutElements(current, array, removedGroups));
    if (removedGroups.size === array.elements.length) deletedEvents.add(eventName);
  }
  current = groupPatches.length > 0 ? applySourcePatches(current, groupPatches) : current;
  return pruneRemovedManagedEventProperties(current, deletedEvents, options);
}

function exactLegacyState(node: JsonNode): Record<string, CodexHooksJsonTrustStateEntry> | null {
  if (node.kind !== "object") return null;
  const entries: Record<string, CodexHooksJsonTrustStateEntry> = {};
  const seenKeys = new Set<string>();
  for (const property of node.properties) {
    if (seenKeys.has(property.key)) return null;
    seenKeys.add(property.key);
    if (property.value.kind !== "object") return null;
    const entry = property.value;
    if (entry.properties.some((member) => member.key !== "trusted_hash" && member.key !== "enabled")) return null;
    if (duplicateKnownProperty(entry, KNOWN_LEGACY_TRUST_STATE_ENTRY_FIELDS)) return null;
    const hash = stringProperty(entry, "trusted_hash");
    const enabled = objectProperty(entry, "enabled");
    if (!hash || (enabled && enabled.value.kind !== "boolean")) return null;
    setOwnRecordValue(entries, property.key, {
      trusted_hash: hash,
      ...(enabled?.value.kind === "boolean" ? { enabled: enabled.value.value } : {}),
    });
  }
  return entries;
}

function identicalLegacyTrustStateEntry(
  left: CodexHooksJsonTrustStateEntry,
  right: CodexHooksJsonTrustStateEntry,
): boolean {
  return left.trusted_hash === right.trusted_hash &&
    Object.hasOwn(left, "enabled") === Object.hasOwn(right, "enabled") &&
    left.enabled === right.enabled;
}

function mergeLegacyTrustState(
  target: Record<string, CodexHooksJsonTrustStateEntry>,
  incoming: Record<string, CodexHooksJsonTrustStateEntry>,
  source: "root" | "hooks.state",
): ManagedCodexHooksPlanError | null {
  const conflictingKeys: string[] = [];
  for (const [key, entry] of Object.entries(incoming)) {
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (existing === undefined) {
      setOwnRecordValue(target, key, entry);
      continue;
    }
    if (!identicalLegacyTrustStateEntry(existing, entry)) conflictingKeys.push(key);
  }
  if (conflictingKeys.length === 0) return null;
  const keys = conflictingKeys.sort((left, right) => left.localeCompare(right));
  return planError(
    "managed_trust_key_conflict",
    `Conflicting legacy hook trust state appears in root state and ${source}.`,
    { keys, source },
  );
}

interface PreparedDocument {
  content: string;
  legacyTrustState: Record<string, CodexHooksJsonTrustStateEntry>;
}

function prepareLegacyState(content: string): PreparedDocument | InvalidCodexHooksConfigStrict {
  const root = parseJsonSource(content);
  if (!root || root.kind !== "object") {
    return { ok: false, error: planError("invalid_document", "hooks.json must contain a JSON object.") };
  }
  const legacyTrustState: Record<string, CodexHooksJsonTrustStateEntry> = {};
  const rootStates = root.properties.filter((property) => property.key === "state");
  if (rootStates.length > 1) {
    return { ok: false, error: planError("invalid_document", "Duplicate top-level state is not supported.") };
  }
  if (rootStates.length === 1) {
    const exact = exactLegacyState(rootStates[0]!.value);
    if (!exact) {
      return { ok: false, error: planError("invalid_document", "Top-level state is not an exact historical OMX trust map.") };
    }
    const conflict = mergeLegacyTrustState(legacyTrustState, exact, "root");
    if (conflict) return { ok: false, error: conflict };
  }

  const hooks = objectProperty(root, "hooks");
  const nestedStates = hooks?.value.kind === "object"
    ? hooks.value.properties.filter((property) => property.key === "state")
    : [];
  const exactNestedStates = nestedStates.map((state) => exactLegacyState(state.value));
  let nestedStatesToRemove = 0;
  if (nestedStates.length > 1 && exactNestedStates.some((state) => state === null)) {
    return {
      ok: false,
      error: planError("invalid_document", "Duplicate hooks.state entries must be exact historical OMX trust maps."),
    };
  }
  if (nestedStates.length === 0 || exactNestedStates[0] !== null) {
    for (const exact of exactNestedStates) {
      if (!exact) continue;
      const conflict = mergeLegacyTrustState(legacyTrustState, exact, "hooks.state");
      if (conflict) return { ok: false, error: conflict };
    }
    nestedStatesToRemove = exactNestedStates.length;
  }

  let preparedContent = content;
  if (rootStates.length === 1) {
    const currentRoot = parseJsonSource(preparedContent)! as JsonObjectNode;
    preparedContent = applySourcePatches(preparedContent, [
      propertyRemovalPatch(currentRoot, objectProperty(currentRoot, "state")!),
    ]);
  }
  for (let index = 0; index < nestedStatesToRemove; index += 1) {
    const currentRoot = parseJsonSource(preparedContent)! as JsonObjectNode;
    const currentHooks = objectProperty(currentRoot, "hooks")?.value;
    if (currentHooks?.kind !== "object") {
      return { ok: false, error: planError("invalid_document", "hooks.json changed while preparing legacy state.") };
    }
    const currentState = objectProperty(currentHooks, "state");
    if (!currentState) {
      return { ok: false, error: planError("invalid_document", "hooks.state changed while preparing legacy state.") };
    }
    preparedContent = applySourcePatches(preparedContent, [propertyRemovalPatch(currentHooks, currentState)]);
  }
  return { content: preparedContent, legacyTrustState };
}

function trustFromDocument(
  document: StrictDocument,
  hooksPath: string,
  options: ManagedCodexHookOptions,
): ManagedCodexHookTrustScanResult {
  const ownership = inspectOwnership(document, options);
  if (ownership instanceof ManagedCodexHooksPlanError) return { ok: false, error: ownership };
  const trustState: Record<string, ManagedCodexHookTrustState> = {};
  for (const owner of ownership.owners) {
    const group = owner.groupNode;
    const handler = owner.handlerNode;
    const command = effectiveCommandForPlatform(handler, options.platform ?? process.platform);
    const timeout = objectProperty(handler, "timeout");
    const timeoutValue = timeout?.value.kind === "number"
      ? timeout.value.raw === "0"
        ? 1
        : new CanonicalJsonNumber(timeout.value.raw)
      : 600;
    const status = nullableStringProperty(handler, "statusMessage");
    const matcher = matcherIsAware(owner.eventName) ? groupMatcher(group) : undefined;
    setOwnRecordValue(
      trustState,
      managedHookStateKey(hooksPath, owner.eventName, owner.groupIndex, owner.handlerIndex),
      {
        trusted_hash: versionForCodexTomlIdentity({
          event_name: CODEX_HOOK_EVENT_LABELS[owner.eventName],
          ...(matcher ? { matcher } : {}),
          hooks: [{
            type: "command",
            command,
            timeout: timeoutValue,
            async: false,
            ...(status !== undefined && status !== null ? { statusMessage: status } : {}),
          }],
        }),
      },
    );
  }
  return {
    ok: true,
    trustState,
    groupOccurrences: document.result.groupOccurrences,
    handlerOccurrences: document.result.handlerOccurrences,
  };
}

export function scanManagedCodexHookTrustStateFromContent(
  content: string,
  hooksPath: string,
  options: ManagedCodexHookOptions = {},
): ManagedCodexHookTrustScanResult {
  const validation = validateCodexHooksDocument(content, options);
  if (!("result" in validation)) return validation;
  return trustFromDocument(validation, hooksPath, options);
}

function hasExecutableForeignHandlerInUnknownEvent(
  event: JsonProperty,
  platform: HookCommandPlatform,
): boolean {
  if (KNOWN_HOOK_EVENT_FIELDS.has(event.key) || event.value.kind !== "array") return false;
  for (const group of event.value.elements) {
    if (group.kind !== "object") continue;
    const hooks = objectProperty(group, "hooks")?.value;
    if (hooks?.kind !== "array") continue;
    for (const handler of hooks.elements) {
      if (handler.kind !== "object") continue;
      const type = stringProperty(handler, "type");
      if (type === "prompt" || type === "agent") return true;
      if (type !== "command") continue;
      const asynchronous = objectProperty(handler, "async");
      if (asynchronous?.value.kind === "boolean" && asynchronous.value.value) continue;
      const command = platform === "win32"
        ? nullableStringProperty(handler, "commandWindows") ??
          nullableStringProperty(handler, "command_windows") ??
          stringProperty(handler, "command")
        : stringProperty(handler, "command");
      if (typeof command === "string" && !commandIsSkipped(command)) return true;
    }
  }
  return false;
}

function foreignHooksInDocument(document: StrictDocument, options: ManagedCodexHookOptions): boolean {
  const ownership = inspectOwnership(document, options);
  return ownership instanceof ManagedCodexHooksPlanError ||
    ownership.groups.some((group) => group.foreign) ||
    document.hooksNode?.properties.some((event) =>
      hasExecutableForeignHandlerInUnknownEvent(event, options.platform ?? process.platform)) === true;
}

function finalizePlan(
  originalContent: string | null | undefined,
  finalContent: string | null,
  removedCount: number,
  coordinateProof: ManagedCodexHooksCoordinateProof,
  legacyTrustState: Record<string, CodexHooksJsonTrustStateEntry>,
  hooksPath: string,
  options: ManagedCodexHookOptions,
  priorTrustState: Record<string, ManagedCodexHookTrustState>,
): ManagedCodexHooksPlanResult {
  if (finalContent === null) {
    return {
      ok: true,
      finalContent: null,
      changed: originalContent !== null && originalContent !== undefined,
      removedCount,
      finalTrustState: {},
      priorTrustState,
      hasForeignHooks: false,
      coordinateProof,
      diagnostics: [],
      legacyTrustState,
    };
  }
  const validation = validateCodexHooksDocument(finalContent, options);
  if (!("result" in validation)) return planFailure(validation.error);
  const scan = trustFromDocument(validation, hooksPath, options);
  if (!scan.ok) return planFailure(scan.error, validation.result.diagnostics);
  return {
    ok: true,
    finalContent,
    changed: finalContent !== originalContent,
    removedCount,
    finalTrustState: scan.trustState,
    priorTrustState,
    hasForeignHooks: foreignHooksInDocument(validation, options),
    coordinateProof,
    diagnostics: validation.result.diagnostics,
    legacyTrustState,
  };
}

export function planManagedCodexHooksMerge(
  existingContent: string | null | undefined,
  pkgRoot: string,
  hooksPath: string,
  options: ManagedCodexHookOptions = {},
): ManagedCodexHooksPlanResult {
  const resolvedOptions = resolveManagedCodexHookOptions(options, hooksPath);
  if (typeof existingContent !== "string") {
    const content = serializeCodexHooksConfig(jsonObjectFromUnknown(buildManagedCodexHooksConfig(pkgRoot, resolvedOptions)));
    return finalizePlan(existingContent, content, 0, { safe: true }, {}, hooksPath, resolvedOptions, {});
  }
  const prepared = prepareLegacyState(existingContent);
  if (!("content" in prepared)) return planFailure(prepared.error);
  const validation = validateCodexHooksDocument(prepared.content, resolvedOptions);
  if (!("result" in validation)) return planFailure(validation.error);
  const priorScan = trustFromDocument(validation, hooksPath, resolvedOptions);
  if (!priorScan.ok) return planFailure(priorScan.error, validation.result.diagnostics);
  const ownership = inspectOwnership(validation, resolvedOptions);
  if (ownership instanceof ManagedCodexHooksPlanError) return planFailure(ownership, validation.result.diagnostics);
  const managed = buildManagedCodexHooksConfig(pkgRoot, resolvedOptions);
  const patches: SourcePatch[] = [];
  const missingEventProperties: Array<readonly [string, string]> = [];

  for (const eventName of MANAGED_HOOK_EVENTS) {
    const eventOwners = ownership.owners.filter((owner) => owner.eventName === eventName)
      .sort((left, right) => left.groupIndex - right.groupIndex || left.handlerIndex - right.handlerIndex);
    const canonicalEntry = managed.hooks[eventName][0]!;
    if (eventOwners.length === 0) {
      const eventArray = eventArrayForGroup(validation, eventName);
      if (eventArray) {
        patches.push(appendArrayElementPatch(eventArray, JSON.stringify(canonicalGroupForEvent(canonicalEntry))));
      } else if (validation.hooksNode) {
        missingEventProperties.push([
          eventName,
          JSON.stringify([canonicalGroupForEvent(canonicalEntry)]),
        ]);
      }
      continue;
    }
    const primary = eventOwners[0]!;
    patches.push(...knownFieldPatches(prepared.content, primary.handlerNode, canonicalHookForEvent(canonicalEntry), KNOWN_COMMAND_FIELDS));
    const primaryGroup = ownership.groups.find((group) => group.node === primary.groupNode);
    if (!primaryGroup?.foreign) {
      patches.push(
        ...knownFieldPatches(
          prepared.content,
          primary.groupNode,
          canonicalMatcherForEvent(canonicalEntry),
          KNOWN_MATCHER_FIELD,
        ),
      );
    }
  }

  if (validation.hooksNode && missingEventProperties.length > 0) {
    patches.push(appendObjectPropertiesPatch(validation.hooksNode, missingEventProperties));
  }
  if (!validation.hooksNode) patches.push(appendObjectPropertyPatch(validation.rootNode, "hooks", JSON.stringify(managed.hooks)));

  let intermediate: string;
  try {
    intermediate = applySourcePatches(prepared.content, patches);
  } catch (error) {
    return planFailure(planError("invalid_document", "Overlapping source edits prevented a safe merge.", { cause: String(error) }), validation.result.diagnostics);
  }
  const afterMerge = validateCodexHooksDocument(intermediate, resolvedOptions);
  if (!("result" in afterMerge)) return planFailure(afterMerge.error);
  const afterOwnership = inspectOwnership(afterMerge, resolvedOptions);
  if (afterOwnership instanceof ManagedCodexHooksPlanError) return planFailure(afterOwnership, afterMerge.result.diagnostics);
  const removeOwners = new Set<ManagedOwner>();
  for (const eventName of MANAGED_HOOK_EVENTS) {
    const eventOwners = afterOwnership.owners.filter((owner) => owner.eventName === eventName)
      .sort((left, right) => left.groupIndex - right.groupIndex || left.handlerIndex - right.handlerIndex);
    for (const duplicate of eventOwners.slice(1)) removeOwners.add(duplicate);
  }
  const proof = removalProof(afterOwnership, removeOwners);
  if (!proof.safe) {
    return {
      ok: false,
      error: planError("unsafe_managed_removal", "Removing duplicate OMX hooks would shift a foreign coordinate or discard opaque metadata.", proof.shifted ? { shifted: proof.shifted } : {}),
      diagnostics: afterMerge.result.diagnostics,
    };
  }
  let finalContent: string | null | ManagedCodexHooksPlanError;
  try {
    finalContent = applyCoordinateSafeRemovals(intermediate, afterOwnership, removeOwners, resolvedOptions);
  } catch (error) {
    return planFailure(planError("invalid_document", "Source edits prevented a safe duplicate cleanup.", { cause: String(error) }), afterMerge.result.diagnostics);
  }
  if (finalContent instanceof ManagedCodexHooksPlanError) return planFailure(finalContent, afterMerge.result.diagnostics);
  return finalizePlan(existingContent, finalContent, removeOwners.size, proof, prepared.legacyTrustState, hooksPath, resolvedOptions, priorScan.trustState);
}

export function planManagedCodexHooksRemoval(
  existingContent: string,
  hooksPath: string,
  options: ManagedCodexHookOptions = {},
): ManagedCodexHooksPlanResult {
  const resolvedOptions = resolveManagedCodexHookOptions(options, hooksPath);
  const prepared = prepareLegacyState(existingContent);
  if (!("content" in prepared)) return planFailure(prepared.error);
  const validation = validateCodexHooksDocument(prepared.content, resolvedOptions);
  if (!("result" in validation)) return planFailure(validation.error);
  const priorScan = trustFromDocument(validation, hooksPath, resolvedOptions);
  if (!priorScan.ok) return planFailure(priorScan.error, validation.result.diagnostics);
  const ownership = inspectOwnership(validation, resolvedOptions);
  if (ownership instanceof ManagedCodexHooksPlanError) return planFailure(ownership, validation.result.diagnostics);
  const removeOwners = new Set(ownership.owners);
  const proof = removalProof(ownership, removeOwners);
  if (!proof.safe) {
    return {
      ok: false,
      error: planError("unsafe_managed_removal", "Removing OMX hooks would shift a foreign coordinate or discard opaque metadata.", proof.shifted ? { shifted: proof.shifted } : {}),
      diagnostics: validation.result.diagnostics,
    };
  }
  let finalContent: string | null | ManagedCodexHooksPlanError;
  try {
    finalContent = applyCoordinateSafeRemovals(prepared.content, ownership, removeOwners, resolvedOptions);
  } catch (error) {
    return planFailure(planError("invalid_document", "Source edits prevented safe removal.", { cause: String(error) }), validation.result.diagnostics);
  }
  if (finalContent instanceof ManagedCodexHooksPlanError) return planFailure(finalContent, validation.result.diagnostics);
  return finalizePlan(existingContent, finalContent, removeOwners.size, proof, prepared.legacyTrustState, hooksPath, resolvedOptions, priorScan.trustState);
}

function codexHookEntries(
  hooks: JsonObject,
  eventName: ManagedHookEventName,
): JsonArray {
  const entries = hooks[eventName];
  return isJsonArray(entries) ? entries : [];
}

export function getMissingManagedCodexHookEvents(content: string): ManagedHookEventName[] | null {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return null;
  return MANAGED_HOOK_EVENTS.filter((eventName) =>
    !codexHookEntries(parsed.hooks, eventName).some((entry) =>
      isPlainObject(entry) && isJsonArray(entry.hooks) && entry.hooks.some((hook) =>
        isPlainObject(hook) && hook.type === "command" && typeof hook.command === "string" &&
        isValidManagedCommand(hook.command, process.platform),
      ),
    ),
  );
}

export function getManagedCodexHookCommandsForEvent(
  content: string,
  eventName: ManagedHookEventName,
): string[] | null {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return null;
  return codexHookEntries(parsed.hooks, eventName).flatMap((entry) =>
    isPlainObject(entry) && isJsonArray(entry.hooks)
      ? entry.hooks.flatMap((hook) =>
        isPlainObject(hook) && hook.type === "command" && typeof hook.command === "string" &&
        isValidManagedCommand(hook.command, process.platform)
          ? [hook.command]
          : [],
      )
      : [],
  );
}

export function buildManagedCodexHookTrustState(
  hooksPath: string,
  pkgRoot: string,
  options: ManagedCodexHookOptions = {},
): Record<string, ManagedCodexHookTrustState> {
  const resolvedOptions = resolveManagedCodexHookOptions(options, hooksPath);
  if (options.hooksContent === null) return {};
  const content = typeof options.hooksContent === "string"
    ? options.hooksContent
    : serializeCodexHooksConfig(jsonObjectFromUnknown(buildManagedCodexHooksConfig(pkgRoot, resolvedOptions)));
  const scan = scanManagedCodexHookTrustStateFromContent(content, hooksPath, resolvedOptions);
  if (!scan.ok) throw scan.error;
  return scan.trustState;
}

export function buildManagedCodexHookTrustToml(
  hooksPath: string | undefined,
  pkgRoot: string,
  options: ManagedCodexHookOptions = {},
): string {
  if (!hooksPath) return "";
  const state = buildManagedCodexHookTrustState(hooksPath, pkgRoot, options);
  return Object.entries(state)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, hookState]) => [
      `[hooks.state."${escapeTomlBasicString(key)}"]`,
      `trusted_hash = "${escapeTomlBasicString(hookState.trusted_hash)}"`,
      "",
    ])
    .join("\n")
    .trimEnd();
}

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean);
}

export function isRuntimeCodexHomeMirrorPath(
  hookConfigPath: string,
  cwd: string = process.cwd(),
): boolean {
  if (basename(hookConfigPath) !== "hooks.json") return false;

  const absolutePath = resolve(cwd, hookConfigPath);
  const relativePath = relative(resolve(cwd), absolutePath);
  const segments = pathSegments(relativePath);
  if (relativePath === "" || segments[0] === "..") {
    return false;
  }

  const omxIndex = segments.indexOf(".omx");
  if (omxIndex < 0) return false;

  return (
    segments[omxIndex + 1] === "runtime" &&
    segments[omxIndex + 2] === "codex-home" &&
    segments.length > omxIndex + 4 &&
    segments[segments.length - 1] === "hooks.json"
  );
}

export async function dedupeCodexHookConfigPaths(
  hookConfigPaths: readonly string[],
  cwd: string = process.cwd(),
): Promise<{
  paths: DedupedCodexHookConfigPath[];
  skipped: SkippedCodexHookConfigPath[];
}> {
  const seenRealpaths = new Set<string>();
  const paths: DedupedCodexHookConfigPath[] = [];
  const skipped: SkippedCodexHookConfigPath[] = [];

  for (const hookConfigPath of hookConfigPaths) {
    if (isRuntimeCodexHomeMirrorPath(hookConfigPath, cwd)) {
      skipped.push({
        path: hookConfigPath,
        reason: "runtime_codex_home_mirror",
      });
      continue;
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(hookConfigPath);
    } catch {
      canonicalPath = resolve(cwd, hookConfigPath);
    }

    if (seenRealpaths.has(canonicalPath)) {
      skipped.push({
        path: hookConfigPath,
        reason: "duplicate_realpath",
        canonicalPath,
      });
      continue;
    }

    seenRealpaths.add(canonicalPath);
    paths.push({ path: hookConfigPath, reason: "unique" });
  }

  return { paths, skipped };
}

const DEFAULT_DISCOVER_HOOK_CONFIG_MAX_FILES = 5_000;
const DISCOVER_HOOK_CONFIG_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
]);

export async function discoverCodexHookConfigPaths(
  cwd: string = process.cwd(),
  options: DiscoverCodexHookConfigPathsOptions = {},
): Promise<{
  paths: DedupedCodexHookConfigPath[];
  skipped: SkippedCodexHookConfigPath[];
}> {
  const root = resolve(cwd);
  const maxFiles = options.maxFiles ?? DEFAULT_DISCOVER_HOOK_CONFIG_MAX_FILES;
  const pending = [root];
  const candidates: string[] = [];
  let visitedFiles = 0;

  while (pending.length > 0 && visitedFiles < maxFiles) {
    const dir = pending.pop()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DISCOVER_HOOK_CONFIG_EXCLUDED_DIRS.has(entry.name)) {
          pending.push(fullPath);
        }
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      visitedFiles += 1;
      if (entry.name === "hooks.json") candidates.push(fullPath);
      if (visitedFiles >= maxFiles) break;
    }
  }

  return dedupeCodexHookConfigPaths(candidates, root);
}

function collectTrustStateEntries(
  value: unknown,
): Record<string, CodexHooksJsonTrustStateEntry> {
  if (!isPlainObject(value)) return {};

  const entries: Record<string, CodexHooksJsonTrustStateEntry> = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    if (!isPlainObject(rawEntry) || typeof rawEntry.trusted_hash !== "string") {
      continue;
    }
    setOwnRecordValue(entries, key, {
      trusted_hash: rawEntry.trusted_hash,
      ...(typeof rawEntry.enabled === "boolean" ? { enabled: rawEntry.enabled } : {}),
    });
  }
  return entries;
}

export function extractCodexHooksJsonTrustState(
  content: string | null | undefined,
): Record<string, CodexHooksJsonTrustStateEntry> {
  if (typeof content !== "string") return {};
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return {};
  return {
    ...collectTrustStateEntries(parsed.hooks.state),
    ...collectTrustStateEntries(parsed.root.state),
  };
}

export function hasCodexHooksJsonTopLevelState(content: string): boolean | null {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return null;
  return Object.hasOwn(parsed.root, "state");
}

export function mergeManagedCodexHooksConfig(
  existingContent: string | null | undefined,
  pkgRoot: string,
  hooksPathOrOptions?: string | ManagedCodexHookOptions,
  options: ManagedCodexHookOptions = {},
): string {
  const hooksPath = typeof hooksPathOrOptions === "string" ? hooksPathOrOptions : "";
  const providedOptions = typeof hooksPathOrOptions === "object" && hooksPathOrOptions !== null
    ? hooksPathOrOptions
    : options;
  const plan = planManagedCodexHooksMerge(existingContent, pkgRoot, hooksPath, providedOptions);
  if (!plan.ok) throw plan.error;
  return plan.finalContent ?? "";
}

export function removeManagedCodexHooks(
  existingContent: string,
): RemoveManagedCodexHooksResult {
  const plan = planManagedCodexHooksRemoval(existingContent, "");
  if (!plan.ok) throw plan.error;
  return { nextContent: plan.finalContent, removedCount: plan.removedCount };
}

export function hasCodexHookEntries(content: string): boolean {
  const parsed = parseCodexHooksConfig(content);
  if (!parsed) return false;
  return Object.entries(parsed.hooks).some(([eventName, rawEntries]) => {
    if (eventName === "state" || !isJsonArray(rawEntries)) return false;
    return rawEntries.some((entry) =>
      isPlainObject(entry) && isJsonArray(entry.hooks) && entry.hooks.length > 0,
    );
  });
}

export function hasUserCodexHooksAfterManagedRemoval(
  existingContent: string,
): boolean {
  const plan = planManagedCodexHooksRemoval(existingContent, "");
  if (!plan.ok) throw plan.error;
  return plan.finalContent !== null && hasCodexHookEntries(plan.finalContent);
}
