type CodexHookPayload = Record<string, unknown>;

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

export function buildNativePreToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const normalized = normalizePreToolUsePayload(payload);
  if (!normalized.isBash) return null;
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

export function buildNativePostToolUseOutput(
  payload: CodexHookPayload,
): Record<string, unknown> | null {
  const mcpTransportFailure = detectMcpTransportFailure(payload);
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

  const normalized = normalizePostToolUsePayload(payload);
  if (!normalized.isBash) return null;
  if (normalized.exitCode === 0) return null;

  const failureContext = [
    normalized.stderrText,
    safeString(normalized.parsedToolResponse?.error),
    safeString(normalized.parsedToolResponse?.message),
    safeString(normalized.parsedToolResponse?.details),
  ]
    .filter(Boolean)
    .join("\n")
    .trim();

  const combined = `${normalized.stderrText}\n${normalized.stdoutText}`.trim();
  if (containsHardFailure(failureContext)) {
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
    && !containsHardFailure(failureContext)
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
