import {
  buildDocumentRefreshAdvisoryOutput,
  evaluateStagedDocumentRefresh,
} from "../document-refresh/enforcer.js";
import { isLoreCommitGuardEnabled } from "../config/commit-lore-guard.js";
import { resolveCodexExecutionSurface } from "./codex-execution-surface.js";

type CodexHookPayload = Record<string, unknown>;

type GitRepositorySelection = "current-cwd" | "explicit-target";

export interface NormalizedPreToolUsePayload {
  toolName: string;
  toolUseId: string;
  command: string;
  normalizedCommand: string;
  isBash: boolean;
}

export interface NormalizedPostToolUsePayload {
  toolName: string;
  toolUseId: string;
  command: string;
  normalizedCommand: string;
  isBash: boolean;
  rawToolResponse: unknown;
  parsedToolResponse: Record<string, unknown> | null;
  exitCode: number | null;
  stdoutText: string;
  stderrText: string;
}

export interface McpTransportFailureSignal {
  toolName: string;
  summary: string;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
}

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isNativeOutsideTmuxSurface(payload: CodexHookPayload): boolean {
  const cwd = safeString(payload.cwd).trim() || process.cwd();
  const surface = resolveCodexExecutionSurface(cwd, {
    hookEventName: "PreToolUse",
    payload,
    nativeSessionId: safeString(payload.session_id ?? payload.sessionId).trim(),
  });
  return surface.launcher === "native" && surface.transport === "outside-tmux";
}

function tryParseJsonString(value: unknown): Record<string, unknown> | null {
  const text = safeString(value).trim();
  if (!text) return null;
  try {
    return safeObject(JSON.parse(text));
  } catch {
    return null;
  }
}

function readCommand(payload: CodexHookPayload): string {
  const toolInput = safeObject(payload.tool_input);
  return safeString(toolInput?.command).trim();
}

export function normalizePreToolUsePayload(
  payload: CodexHookPayload,
): NormalizedPreToolUsePayload {
  const toolName = safeString(payload.tool_name).trim();
  const command = readCommand(payload);
  return {
    toolName,
    toolUseId: safeString(payload.tool_use_id).trim(),
    command,
    normalizedCommand: command,
    isBash: toolName === "Bash",
  };
}

export function normalizePostToolUsePayload(
  payload: CodexHookPayload,
): NormalizedPostToolUsePayload {
  const toolName = safeString(payload.tool_name).trim();
  const command = readCommand(payload);
  const rawToolResponse = payload.tool_response;
  const parsedToolResponse = tryParseJsonString(rawToolResponse) ?? safeObject(rawToolResponse);
  const exitCode = safeInteger(parsedToolResponse?.exit_code)
    ?? safeInteger(parsedToolResponse?.exitCode)
    ?? null;
  const rawText = safeString(rawToolResponse).trim();
  const stdoutText = safeString(parsedToolResponse?.stdout).trim() || rawText;
  const stderrText = safeString(parsedToolResponse?.stderr).trim();

  return {
    toolName,
    toolUseId: safeString(payload.tool_use_id).trim(),
    command,
    normalizedCommand: command,
    isBash: toolName === "Bash",
    rawToolResponse,
    parsedToolResponse,
    exitCode,
    stdoutText,
    stderrText,
  };
}

function matchesDestructiveFixture(command: string): boolean {
  return /^\s*rm\s+-rf\s+dist(?:\s|$)/.test(command);
}

function isMcpLikeToolName(toolName: string): boolean {
  return /^(mcp__|omx_(?:state|memory|trace|code_intel)\b|state_|project_memory_|notepad_|trace_)/i.test(toolName);
}

const MCP_TRANSPORT_FAILURE_PATTERNS = [
  /transport (?:closed|error|failed)/i,
  /server disconnected/i,
  /connection (?:closed|reset|lost)/i,
  /\beconnreset\b/i,
  /\bepipe\b/i,
  /broken pipe/i,
  /stream ended unexpectedly/i,
  /stdio .*closed/i,
  /pipe closed/i,
  /mcp(?: server)? .*closed/i,
];

type OmxParityCommand =
  | "state"
  | "notepad"
  | "project-memory"
  | "trace"
  | "code-intel";

export function detectMcpTransportFailure(
  payload: CodexHookPayload,
): McpTransportFailureSignal | null {
  const normalized = normalizePostToolUsePayload(payload);
  if (normalized.isBash) return null;
  const combined = [
    normalized.stderrText,
    normalized.stdoutText,
    safeString(normalized.parsedToolResponse?.error),
    safeString(normalized.parsedToolResponse?.message),
    safeString(normalized.parsedToolResponse?.details),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  const mcpContextDetected = isMcpLikeToolName(normalized.toolName)
    || /\bmcp\b/i.test(combined)
    || /\bomx-(?:state|memory|trace|code-intel)-server\b/i.test(combined);
  if (!mcpContextDetected) return null;
  if (!combined) return null;
  if (!MCP_TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(combined))) {
    return null;
  }

  return {
    toolName: normalized.toolName,
    summary: combined,
  };
}

function resolveOmxParityTarget(toolName: string): { command: OmxParityCommand; tool: string } | null {
  const match = toolName.match(/^mcp__omx_(state|memory|trace|code_intel)__([a-z0-9_]+)$/i);
  if (!match) return null;

  const [, server, tool] = match;
  if (server === "state") return { command: "state", tool };
  if (server === "trace") return { command: "trace", tool };
  if (server === "code_intel") return { command: "code-intel", tool };
  if (server === "memory" && tool.startsWith("notepad_")) {
    return { command: "notepad", tool };
  }
  if (server === "memory" && tool.startsWith("project_memory_")) {
    return { command: "project-memory", tool };
  }
  return null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildOmxParityFallbackCommand(payload: CodexHookPayload, toolName: string): string | null {
  const target = resolveOmxParityTarget(toolName);
  if (!target) return null;
  const input = safeObject(payload.tool_input) ?? {};
  return `omx ${target.command} ${target.tool} --input ${shellSingleQuote(JSON.stringify(input))} --json`;
}

const LORE_TRAILER_PREFIXES = [
  "Constraint:",
  "Rejected:",
  "Confidence:",
  "Scope-risk:",
  "Reversibility:",
  "Directive:",
  "Tested:",
  "Not-tested:",
  "Related:",
] as const;

const OMX_COAUTHOR_TRAILER = "Co-authored-by: OmX <omx@oh-my-codex.dev>";

function isDoubleQuotedShellEscapeTarget(char: string | undefined): boolean {
  return char === "\"" || char === "\\" || char === "$" || char === "`" || char === "\n";
}

function tokenizeShellCommand(commandText: string): string[] | null {
  const trimmed = commandText.trim();
  if (!trimmed) return null;

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "\\") {
        if (isDoubleQuotedShellEscapeTarget(trimmed[index + 1])) escaping = true;
        else current += char;
      }
      else current += char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    current += char;
  }

  if (escaping || quote) return null;
  if (current) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
}

interface ShellToken {
  value: string;
  startsCommand: boolean;
}

function tokenizeShellCommandWithBoundaries(commandText: string): ShellToken[] | null {
  const trimmed = commandText.trim();
  if (!trimmed) return null;

  const tokens: ShellToken[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  let nextTokenStartsCommand = false;

  const pushCurrent = () => {
    if (!current) return;
    tokens.push({ value: current, startsCommand: tokens.length === 0 || nextTokenStartsCommand });
    current = "";
    nextTokenStartsCommand = false;
  };

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") quote = null;
      else if (char === "\\") {
        if (isDoubleQuotedShellEscapeTarget(trimmed[index + 1])) escaping = true;
        else current += char;
      }
      else current += char;
      continue;
    }

    if (char === "\n" || char === ";" || char === "&" || char === "|") {
      pushCurrent();
      nextTokenStartsCommand = true;
      if ((char === "&" || char === "|") && trimmed[index + 1] === char) index += 1;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrent();
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    current += char;
  }

  if (escaping || quote) return null;
  pushCurrent();
  return tokens.length > 0 ? tokens : null;
}

interface GitCommitCommandParseResult {
  isGitCommit: boolean;
  inlineEnvironment: NodeJS.ProcessEnv;
  environmentStartsClean: boolean;
  unsetEnvironmentNames: string[];
  inlineMessage: string | null;
  repositorySelection: GitRepositorySelection;
  requiresExternalMessageSource: boolean;
}

function isInlineShellEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token);
}

function isGitExecutableToken(token: string): boolean {
  const lowerToken = token.toLowerCase();
  if (lowerToken === "git" || lowerToken === "git.exe") return true;
  const normalized = token.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();
  return basename === "git" || basename === "git.exe";
}

function isEnvExecutableToken(token: string): boolean {
  const lowerToken = token.toLowerCase();
  if (lowerToken === "env") return true;
  const normalized = token.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const basename = (segments[segments.length - 1] ?? "").toLowerCase();
  return basename === "env";
}

function envOptionConsumesNextValue(token: string): boolean {
  return token === "-u"
    || token === "--unset"
    || token === "-C"
    || token === "--chdir"
    || token === "-S"
    || token === "--split-string";
}

function tokenStartsCommand(tokens: ShellToken[], index: number): boolean {
  return index <= 0 || (tokens[index]?.startsCommand ?? false);
}

function nextCommandStart(tokens: ShellToken[], startIndex: number): number {
  let index = startIndex + 1;
  while (index < tokens.length && !tokenStartsCommand(tokens, index)) {
    index += 1;
  }
  return index;
}

function findGitCommandTokenIndex(tokens: ShellToken[]): number {
  for (let commandStart = 0; commandStart < tokens.length; commandStart = nextCommandStart(tokens, commandStart)) {
    let index = commandStart;
    const commandEnd = nextCommandStart(tokens, commandStart);

    while (index < commandEnd && isInlineShellEnvAssignment(tokens[index]?.value ?? "")) {
      index += 1;
    }

    while (index < commandEnd && isEnvExecutableToken(tokens[index]?.value ?? "")) {
      index += 1;
      while (index < commandEnd) {
        const token = tokens[index]?.value ?? "";
        if (token === "--") {
          index += 1;
          break;
        }
        if (isInlineShellEnvAssignment(token)) {
          index += 1;
          continue;
        }
        if (token === "-i" || token === "--ignore-environment" || token.startsWith("--unset=")) {
          index += 1;
          continue;
        }
        if (token.startsWith("-")) {
          index += envOptionConsumesNextValue(token) ? 2 : 1;
          continue;
        }
        break;
      }
      while (index < commandEnd && isInlineShellEnvAssignment(tokens[index]?.value ?? "")) {
        index += 1;
      }
    }

    if (index < commandEnd && isGitExecutableToken(tokens[index]?.value ?? "")) return index;
    if (commandEnd <= commandStart) break;
    commandStart = commandEnd - 1;
  }

  return -1;
}

function tokenValues(tokens: ShellToken[]): string[] {
  return tokens.map((token) => token.value);
}

function findCommandStart(tokens: ShellToken[], tokenIndex: number): number {
  let index = tokenIndex;
  while (index > 0 && !tokenStartsCommand(tokens, index)) {
    index -= 1;
  }
  return index;
}


interface InlineEnvironmentRead {
  inlineEnvironment: NodeJS.ProcessEnv;
  environmentStartsClean: boolean;
  unsetEnvironmentNames: string[];
}

function readUnsetEnvNameFromOption(token: string, nextToken: string | undefined): {
  name: string | null;
  consumedNext: boolean;
} {
  if (token === "-u" || token === "--unset") {
    return { name: nextToken ?? null, consumedNext: true };
  }
  if (token.startsWith("--unset=")) {
    return { name: token.slice("--unset=".length), consumedNext: false };
  }
  return { name: null, consumedNext: false };
}

function readInlineEnvironmentAssignments(tokens: ShellToken[], gitTokenIndex: number): InlineEnvironmentRead {
  const inlineEnvironment: NodeJS.ProcessEnv = {};
  const unsetEnvironmentNames = new Set<string>();
  let environmentStartsClean = false;
  const commandStart = findCommandStart(tokens, gitTokenIndex);
  const recordAssignment = (token: string) => {
    const separatorIndex = token.indexOf("=");
    const name = token.slice(0, separatorIndex);
    inlineEnvironment[name] = token.slice(separatorIndex + 1);
    unsetEnvironmentNames.delete(name);
  };
  const recordUnset = (name: string | null) => {
    if (!name) return;
    delete inlineEnvironment[name];
    unsetEnvironmentNames.add(name);
  };

  let index = commandStart;
  while (index < gitTokenIndex && isInlineShellEnvAssignment(tokens[index]?.value ?? "")) {
    recordAssignment(tokens[index]?.value ?? "");
    index += 1;
  }

  while (index < gitTokenIndex && isEnvExecutableToken(tokens[index]?.value ?? "")) {
    index += 1;
    while (index < gitTokenIndex) {
      const token = tokens[index]?.value ?? "";
      if (token === "--") {
        index += 1;
        break;
      }
      if (isInlineShellEnvAssignment(token)) {
        recordAssignment(token);
        index += 1;
        continue;
      }
      if (token === "-i" || token === "--ignore-environment") {
        environmentStartsClean = true;
        unsetEnvironmentNames.clear();
        index += 1;
        continue;
      }
      const unset = readUnsetEnvNameFromOption(token, tokens[index + 1]?.value);
      if (unset.name !== null || unset.consumedNext) {
        recordUnset(unset.name);
        index += unset.consumedNext ? 2 : 1;
        continue;
      }
      if (token.startsWith("-")) {
        index += envOptionConsumesNextValue(token) ? 2 : 1;
        continue;
      }
      break;
    }
    while (index < gitTokenIndex && isInlineShellEnvAssignment(tokens[index]?.value ?? "")) {
      recordAssignment(tokens[index]?.value ?? "");
      index += 1;
    }
  }

  return {
    inlineEnvironment,
    environmentStartsClean,
    unsetEnvironmentNames: [...unsetEnvironmentNames],
  };
}

function gitOptionConsumesNextValue(token: string): boolean {
  return token === "-c"
    || token === "-C"
    || token === "--git-dir"
    || token === "--work-tree"
    || token === "--namespace"
    || token === "--super-prefix"
    || token === "--exec-path"
    || token === "--config-env"
    || token === "--attr-source";
}

function gitOptionSelectsRepository(token: string): boolean {
  return token === "-C"
    || token === "--git-dir"
    || token === "--work-tree"
    || token.startsWith("--git-dir=")
    || token.startsWith("--work-tree=");
}

function gitOptionStopsBeforeSubcommand(token: string): boolean {
  return token === "-h"
    || token === "--help"
    || token === "--version"
    || token === "--html-path"
    || token === "--man-path"
    || token === "--info-path";
}

function findGitSubcommandIndex(tokens: string[], gitTokenIndex: number): number {
  let index = gitTokenIndex + 1;

  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (!token) {
      index += 1;
      continue;
    }
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (gitOptionStopsBeforeSubcommand(token)) return -1;
    if (gitOptionConsumesNextValue(token)) {
      index += 2;
      continue;
    }
    index += 1;
  }

  return index < tokens.length ? index : -1;
}

function readGitRepositorySelection(tokens: string[], gitTokenIndex: number, subcommandIndex: number): GitRepositorySelection {
  for (let index = gitTokenIndex + 1; index < subcommandIndex; index += 1) {
    const token = tokens[index] ?? "";
    if (gitOptionSelectsRepository(token)) return "explicit-target";
    if (gitOptionConsumesNextValue(token)) index += 1;
  }
  return "current-cwd";
}

export function parseGitCommitCommand(commandText: string): GitCommitCommandParseResult {
  const shellTokens = tokenizeShellCommandWithBoundaries(commandText);
  const tokens = shellTokens ? tokenValues(shellTokens) : null;
  if (!tokens) {
    return {
      isGitCommit: false,
      inlineEnvironment: {},
      environmentStartsClean: false,
      unsetEnvironmentNames: [],
      inlineMessage: null,
      repositorySelection: "current-cwd",
      requiresExternalMessageSource: false,
    };
  }

  const gitTokenIndex = findGitCommandTokenIndex(shellTokens ?? []);
  if (gitTokenIndex < 0 || !isGitExecutableToken(tokens[gitTokenIndex] ?? "")) {
    return {
      isGitCommit: false,
      inlineEnvironment: {},
      environmentStartsClean: false,
      unsetEnvironmentNames: [],
      inlineMessage: null,
      repositorySelection: "current-cwd",
      requiresExternalMessageSource: false,
    };
  }

  const subcommandIndex = findGitSubcommandIndex(tokens, gitTokenIndex);
  if (subcommandIndex < 0 || tokens[subcommandIndex]?.toLowerCase() !== "commit") {
    return {
      isGitCommit: false,
      inlineEnvironment: {},
      environmentStartsClean: false,
      unsetEnvironmentNames: [],
      inlineMessage: null,
      repositorySelection: "current-cwd",
      requiresExternalMessageSource: false,
    };
  }

  const repositorySelection = readGitRepositorySelection(tokens, gitTokenIndex, subcommandIndex);
  const { inlineEnvironment, environmentStartsClean, unsetEnvironmentNames } = readInlineEnvironmentAssignments(shellTokens ?? [], gitTokenIndex);
  const messageParts: string[] = [];
  let requiresExternalMessageSource = false;
  const args = tokens.slice(subcommandIndex + 1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "-m" || token === "--message") {
      const nextValue = args[index + 1];
      if (typeof nextValue === "string") {
        messageParts.push(nextValue);
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--message=")) {
      messageParts.push(token.slice("--message=".length));
      continue;
    }
    if (
      token === "-F"
      || token === "--file"
      || token === "-c"
      || token === "-C"
      || token === "--reuse-message"
      || token === "--reedit-message"
      || token === "--fixup"
      || token.startsWith("--fixup=")
      || token === "--squash"
      || token.startsWith("--squash=")
      || token === "--template"
      || token === "-t"
      || token.startsWith("--file=")
      || token.startsWith("--reuse-message=")
      || token.startsWith("--reedit-message=")
      || token.startsWith("--template=")
    ) {
      requiresExternalMessageSource = true;
    }
  }

  return {
    isGitCommit: true,
    inlineEnvironment,
    environmentStartsClean,
    unsetEnvironmentNames,
    inlineMessage: messageParts.length > 0 ? messageParts.join("\n\n").trim() : null,
    repositorySelection,
    requiresExternalMessageSource,
  };
}

function buildEffectiveLoreCommitGuardEnv(parsed: GitCommitCommandParseResult): NodeJS.ProcessEnv {
  const effectiveEnvironment: NodeJS.ProcessEnv = parsed.environmentStartsClean ? {} : { ...process.env };
  for (const name of parsed.unsetEnvironmentNames) {
    delete effectiveEnvironment[name];
  }
  for (const [name, value] of Object.entries(parsed.inlineEnvironment)) {
    if (typeof value === "string") effectiveEnvironment[name] = value;
  }
  return effectiveEnvironment;
}

function isLoreTrailerLine(line: string): boolean {
  return line === OMX_COAUTHOR_TRAILER
    || LORE_TRAILER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function splitBodyAndTrailerLines(text: string): {
  bodyText: string;
  trailerLines: string[];
} {
  const paragraphs = splitParagraphs(text);
  let trailerStart = paragraphs.length;

  while (trailerStart > 0) {
    const paragraph = paragraphs[trailerStart - 1] ?? "";
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0 || !lines.every((line) => isLoreTrailerLine(line))) break;
    trailerStart -= 1;
  }

  return {
    bodyText: paragraphs.slice(0, trailerStart).join("\n\n").trim(),
    trailerLines: paragraphs
      .slice(trailerStart)
      .flatMap((paragraph) => paragraph.split("\n"))
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

function buildGitCommitComplianceErrors(message: string | null): string[] {
  if (!message) {
    return [
      "Provide the commit message inline with `git commit -m ...` so the pre-tool-use hook can validate Lore format before the command runs.",
    ];
  }

  const normalized = message.replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    return [
      "Provide a non-empty Lore-format commit message with an intent-first subject, narrative body, Lore trailers, and the OmX co-author trailer.",
    ];
  }

  const lines = normalized.split("\n");
  const errors: string[] = [];
  if (lines[0]?.trim() === "") {
    errors.push("Start the commit message with a non-empty intent-first subject line.");
  }
  if (lines.length < 2 || lines[1]?.trim() !== "") {
    errors.push("Add a blank line after the subject before the narrative body.");
  }

  const { bodyText, trailerLines } = splitBodyAndTrailerLines(lines.slice(2).join("\n"));
  if (!bodyText) {
    errors.push("Add a narrative body paragraph explaining the decision context.");
  }
  if (!trailerLines.some((line) => LORE_TRAILER_PREFIXES.some((prefix) => line.startsWith(prefix)))) {
    errors.push("Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.");
  }
  if (!trailerLines.includes(OMX_COAUTHOR_TRAILER)) {
    errors.push(`Add the required co-author trailer: \`${OMX_COAUTHOR_TRAILER}\`.`);
  }

  return errors;
}

function buildGitCommitEnforcementOutput(commandText: string): Record<string, unknown> | null {
  const parsed = parseGitCommitCommand(commandText);
  if (!parsed.isGitCommit) return null;

  if (!isLoreCommitGuardEnabled(buildEffectiveLoreCommitGuardEnv(parsed))) return null;

  const errors = parsed.requiresExternalMessageSource
    ? [
      "Use inline `git commit -m ...` paragraphs for Lore-format commits in this path; file/editor/reuse/fixup message sources are not inspectable safely from pre-tool-use enforcement.",
    ]
    : buildGitCommitComplianceErrors(parsed.inlineMessage);

  if (errors.length === 0) return null;

  return {
    decision: "block",
    reason:
      "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
    systemMessage: [
      "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
      ...errors.map((error) => `- ${error}`),
    ].join("\n"),
  };
}


function buildDocumentRefreshPreToolUseOutput(
  commandText: string,
  cwd: string,
): Record<string, unknown> | null {
  const parsed = parseGitCommitCommand(commandText);
  if (!parsed.isGitCommit) return null;

  if (parsed.repositorySelection !== "current-cwd") return null;

  const warning = evaluateStagedDocumentRefresh(cwd, parsed.inlineMessage);
  if (!warning) return null;

  return buildDocumentRefreshAdvisoryOutput(warning, "PreToolUse");
}


export const SLOPPY_FALLBACK_PHRASE_PATTERNS = [
  /\bquick hack\b/i,
  /\bhacky\b/i,
  /\bworkaround for now\b/i,
  /\btemporary workaround\b/i,
  /\btemporary fallback\b/i,
  /\bjust bypass\b/i,
  /\bjust skip\b/i,
  /\bskip (?:the )?(?:failing )?(?:test|validation|checks?)\b/i,
  /\bfallback if (?:it|this|that) fails\b/i,
  /\bfor now,? just\b/i,
  /\bbypass (?:the )?(?:failing )?(?:test|validation|checks?)\b/i,
] as const;

export const SLOPPY_FALLBACK_IMPLEMENTATION_CONTEXT_PATTERNS = [
  /\badd\b/i,
  /\bimplement\b/i,
  /\bpatch\b/i,
  /\bwrite\b/i,
  /\bchange\b/i,
  /\bfix\b/i,
  /\bbypass\b/i,
  /\bfallback\b/i,
  /\bworkaround\b/i,
  /\bskip\b/i,
  /\bdisable\b/i,
] as const;

export const SLOPPY_FALLBACK_GROUNDING_PATTERNS = [
  /\btested\b/i,
  /\btests? pass(?:ed)?\b/i,
  /\bnpm (?:run )?test\b/i,
  /\bnode --test\b/i,
  /\bunit tests?\b/i,
  /\bintegration tests?\b/i,
  /\bregression tests?\b/i,
  /\bcoverage\b/i,
  /\bspec(?:ification)?\b/i,
  /\bADR\b/,
  /\barchitecture\b/i,
  /\barchitect\b/i,
  /\bdesign\b/i,
  /\bbecause\b/i,
  /\bcompatib(?:le|ility)\b/i,
  /\bbackward-compatible\b/i,
  /\bfail-safe\b/i,
  /\bfailsafe\b/i,
  /\benvironment issue\b/i,
  /\benv(?:ironment)? problem\b/i,
  /\buser approved\b/i,
  /\bapproved by (?:the )?user\b/i,
  /(?:^|\s)#\d+\b/,
  /\bPR\s*#?\d+\b/i,
] as const;

const READ_ONLY_COMMAND_TOKENS = new Set([
  "cat",
  "find",
  "grep",
  "head",
  "less",
  "ls",
  "rg",
  "sed",
  "tail",
]);

function commandStartsWithReadOnlyInspection(command: string): boolean {
  if (commandHasWriteLikeIntent(command)) return false;
  const tokens = tokenizeShellCommand(command);
  if (!tokens || tokens.length === 0) return false;
  let commandToken = tokens[0] ?? "";
  if (commandToken === "env") {
    const nextCommand = tokens.find((token, index) => index > 0 && !token.startsWith("-") && !isInlineShellEnvAssignment(token));
    commandToken = nextCommand ?? commandToken;
  }
  const basename = commandToken.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? commandToken.toLowerCase();
  if (!READ_ONLY_COMMAND_TOKENS.has(basename)) return false;
  if (basename === "sed" && tokens.some((token) => token === "-i" || token.startsWith("-i"))) return false;
  if (basename === "cat" && /(?:^|[;&|]\s*)cat\b[\s\S]{0,200}>\s*[^\s&|;]+/.test(command)) return false;
  return !/\|\s*(?:sh|bash|zsh|python3?|node|perl|ruby|apply_patch)\b/i.test(command);
}

function commandHasWriteLikeIntent(command: string): boolean {
  return /\bapply_patch\b/.test(command)
    || /(?:^|[;&|]\s*)(?:cat|printf|echo)\b[\s\S]{0,200}>\s*[^\s&|;]+/.test(command)
    || /\btee\s+(?:-a\s+)?[^\s&|;]+/.test(command)
    || /\bsed\s+(?:[^\n;&|]*\s)?-i(?:\b|['"])/.test(command)
    || /\b(?:python3?|node|perl|ruby)\b[\s\S]{0,240}\b(?:writeFileSync|writeFile|write_text|open\([^)]*["']w|File\.write|Path\()/.test(command)
    || /<<['"]?[A-Za-z0-9_ -]+['"]?[\s\S]*(?:^|\n)(?:\+\+\+\s|---\s|import\s|export\s|function\s|const\s|class\s|interface\s)/m.test(command);
}

export function hasAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function detectSloppyFallbackFraming(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (commandStartsWithReadOnlyInspection(trimmed)) return false;
  if (!commandHasWriteLikeIntent(trimmed)) return false;
  if (!hasAnyPattern(trimmed, SLOPPY_FALLBACK_PHRASE_PATTERNS)) return false;
  if (!hasAnyPattern(trimmed, SLOPPY_FALLBACK_IMPLEMENTATION_CONTEXT_PATTERNS)) return false;
  if (hasAnyPattern(trimmed, SLOPPY_FALLBACK_GROUNDING_PATTERNS)) return false;
  return true;
}

function buildSloppyFallbackPreToolUseOutput(commandText: string): Record<string, unknown> | null {
  if (!detectSloppyFallbackFraming(commandText)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
    systemMessage:
      "Sloppy fallback/workaround framing detected: don't make potential slop. Consult an architect for a concrete architecture, or ask the user if this is an environment issue before adding bypass/fallback code.",
  };
}

function commandInvokesOmxQuestion(command: string): boolean {
  const tokens = tokenizeShellCommand(command)?.map((token) => token.toLowerCase()) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] || '';
    const token = rawToken.replace(/\\/g, '/').split('/').pop() || '';
    if ((token === 'omx' || token === 'omx.js') && tokens[index + 1] === 'question') return true;
    if ((token === 'node' || token === 'node.exe') && /(?:^|\/)omx\.js$/.test(tokens[index + 1] || '') && tokens[index + 2] === 'question') return true;
  }
  return /\bomx\s+question\b/i.test(command) || /\bomx\.js['"]?\s+question\b/i.test(command);
}

function isQuestionReturnPaneAssignment(token: string): boolean {
  const equalsIndex = token.indexOf('=');
  if (equalsIndex <= 0) return false;
  const name = token.slice(0, equalsIndex);
  if (!['OMX_QUESTION_RETURN_PANE', 'OMX_LEADER_PANE_ID', 'TMUX_PANE'].includes(name)) return false;
  const value = token.slice(equalsIndex + 1);
  return /^%\d+$/.test(value) || /^\$\{?TMUX_PANE\}?$/.test(value);
}

function hasInheritedQuestionReturnPaneBridge(): boolean {
  // Intentionally trust only the explicit bridge envs that question renderer
  // already accepts outside tmux; TMUX_PANE alone is not stable across all
  // Bash/background-terminal tool paths that this enforcement protects.
  const explicitPane = safeString(
    process.env.OMX_QUESTION_RETURN_PANE || process.env.OMX_LEADER_PANE_ID,
  ).trim();
  return /^%\d+$/.test(explicitPane);
}

function commandHasPowerShellQuestionReturnPane(command: string): boolean {
  return /\$env:(?:OMX_QUESTION_RETURN_PANE|OMX_LEADER_PANE_ID)\s*=\s*(?:['"]?%\d+['"]?|\$env:TMUX_PANE)\b/i.test(command)
    || /\$env:TMUX_PANE\s*=\s*['"]?%\d+['"]?/i.test(command);
}

function commandHasQuestionReturnPane(command: string): boolean {
  if (hasInheritedQuestionReturnPaneBridge()) return true;
  if (commandHasPowerShellQuestionReturnPane(command)) return true;
  return (tokenizeShellCommand(command) ?? []).some(isQuestionReturnPaneAssignment);
}

function commandInvokesOmxTeam(command: string): boolean {
  const tokens = tokenizeShellCommand(command)?.map((token) => token.toLowerCase()) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] || '';
    const token = rawToken.replace(/\\/g, '/').split('/').pop() || '';
    if ((token === 'omx' || token === 'omx.js') && tokens[index + 1] === 'team') return true;
    if ((token === 'node' || token === 'node.exe') && /(?:^|\/)omx\.js$/.test(tokens[index + 1] || '') && tokens[index + 2] === 'team') return true;
  }
  return /\bomx\s+team\b/i.test(command) || /\bomx\.js['"]?\s+team\b/i.test(command);
}

function commandInvokesOmxHud(command: string): boolean {
  const tokens = tokenizeShellCommand(command)?.map((token) => token.toLowerCase()) ?? [];
  for (let index = 0; index < tokens.length; index += 1) {
    const rawToken = tokens[index] || '';
    const token = rawToken.replace(/\\/g, '/').split('/').pop() || '';
    if ((token === 'omx' || token === 'omx.js') && tokens[index + 1] === 'hud') return true;
    if ((token === 'node' || token === 'node.exe') && /(?:^|\/)omx\.js$/.test(tokens[index + 1] || '') && tokens[index + 2] === 'hud') return true;
  }
  return /\bomx\s+hud\b/i.test(command) || /\bomx\.js['"]?\s+hud\b/i.test(command);
}

function buildNativeOmxHudPreToolUseEnforcementOutput(
  command: string,
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  if (!isNativeOutsideTmuxSurface(payload) || !commandInvokesOmxHud(command)) return null;

  return {
    decision: "block",
    reason: "omx hud cannot be launched directly from Codex App/native outside-tmux Bash sessions.",
    systemMessage: "omx hud is blocked from Bash in Codex App/native outside-tmux sessions; use SessionStart/HUD context instead, or launch OMX CLI from an attached tmux shell first for the tmux HUD runtime.",
  };
}

function buildNativeOmxTeamPreToolUseEnforcementOutput(
  command: string,
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  if (!isNativeOutsideTmuxSurface(payload) || !commandInvokesOmxTeam(command)) return null;

  return {
    decision: "block",
    reason: "omx team cannot be launched directly from Codex App/native outside-tmux Bash sessions.",
    systemMessage: `omx team is blocked from Bash in Codex App/native outside-tmux sessions; launch OMX CLI from an attached tmux shell first. Original command: ${command}`,
  };
}

function buildOmxQuestionPreToolUseEnforcementOutput(
  command: string,
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  if (!commandInvokesOmxQuestion(command)) return null;

  if (isNativeOutsideTmuxSurface(payload)) {
    return {
      decision: "block",
      reason: "omx question cannot be launched directly from Codex App/native outside-tmux Bash sessions.",
      systemMessage: `omx question is blocked from Codex App/native outside-tmux Bash because no attached tmux pane is available. Use the native structured question tool when available, or ask exactly one concise plain-text question. Original command: ${command}`,
    };
  }

  if (commandHasQuestionReturnPane(command)) return null;

  return {
    decision: "block",
    reason: "omx question Bash invocations must preserve the leader pane return target.",
    systemMessage: `omx question is blocked from Bash until the command preserves the leader pane with \`OMX_QUESTION_RETURN_PANE=$TMUX_PANE\` or an explicit \`%pane\` value. Original command: ${command}`,
  };
}

export function buildNativePreToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const normalized = normalizePreToolUsePayload(payload);
  if (!normalized.isBash) return null;
  const gitCommitEnforcement = buildGitCommitEnforcementOutput(normalized.normalizedCommand);
  if (gitCommitEnforcement) return gitCommitEnforcement;
  const hudEnforcement = buildNativeOmxHudPreToolUseEnforcementOutput(normalized.normalizedCommand, payload);
  if (hudEnforcement) return hudEnforcement;
  const teamEnforcement = buildNativeOmxTeamPreToolUseEnforcementOutput(normalized.normalizedCommand, payload);
  if (teamEnforcement) return teamEnforcement;
  const questionEnforcement = buildOmxQuestionPreToolUseEnforcementOutput(normalized.normalizedCommand, payload);
  if (questionEnforcement) return questionEnforcement;
  const documentRefreshWarning = buildDocumentRefreshPreToolUseOutput(
    normalized.normalizedCommand,
    safeString(payload.cwd).trim() || process.cwd(),
  );
  if (documentRefreshWarning) return documentRefreshWarning;
  const sloppyFallbackWarning = buildSloppyFallbackPreToolUseOutput(normalized.normalizedCommand);
  if (sloppyFallbackWarning) return sloppyFallbackWarning;
  if (!matchesDestructiveFixture(normalized.normalizedCommand)) return null;

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
    systemMessage:
      "Destructive Bash command detected (`rm -rf dist`). Confirm the target and expected side effects before running it.",
  };
}

function containsHardFailure(text: string): boolean {
  return /command not found|permission denied|no such file or directory/i.test(text);
}

function hasActionableBashHardFailure(normalized: NormalizedPostToolUsePayload): boolean {
  if (containsHardFailure(normalized.stderrText)) return true;
  if (normalized.exitCode === null || normalized.exitCode === 0) return false;
  return containsHardFailure(`${normalized.stderrText}\n${normalized.stdoutText}`);
}

export function buildNativePostToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const normalized = normalizePostToolUsePayload(payload);
  const mcpTransportFailure = normalized.isBash ? null : detectMcpTransportFailure(payload);
  if (mcpTransportFailure) {
    const fallbackCommand = buildOmxParityFallbackCommand(payload, mcpTransportFailure.toolName);
    const fallbackText = fallbackCommand
      ? `Retry via CLI parity with \`${fallbackCommand}\`.`
      : "Retry via the matching OMX CLI parity surface instead of retrying the MCP transport blindly.";
    return {
      decision: "block",
      reason: "The MCP tool appears to have lost its transport/server connection. Preserve state, debug the transport failure, and use OMX CLI/file-backed fallbacks instead of retrying blindly.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          `Clear MCP transport-death signal detected. Preserve current team/runtime state. ${fallbackText} OMX MCP servers are plain Node stdio processes, so they still shut down when stdin/transport closes. If this happened during team runtime, inspect first with \`omx team status <team>\` or \`omx team api read-stall-state --input '{"team_name":"<team>"}' --json\`, and only force cleanup after capturing needed state. For root-cause debugging, rerun with \`OMX_MCP_TRANSPORT_DEBUG=1\` to log why the stdio transport closed.`,
      },
    };
  }

  if (!normalized.isBash) return null;

  const combined = `${normalized.stderrText}\n${normalized.stdoutText}`.trim();
  if (hasActionableBashHardFailure(normalized)) {
    return {
      decision: "block",
      reason: "The Bash output indicates a command/setup failure that should be fixed before retrying.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "Bash reported `command not found`, `permission denied`, or a missing file/path. Verify the command, dependency installation, PATH, file permissions, and referenced paths before retrying.",
      },
    };
  }

  if (
    normalized.exitCode !== null
    && normalized.exitCode !== 0
    && combined.length > 0
    && !containsHardFailure(combined)
  ) {
    return {
      decision: "block",
      reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
      },
    };
  }

  return null;
}
