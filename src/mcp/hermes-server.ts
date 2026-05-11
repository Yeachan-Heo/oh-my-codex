/**
 * OMX Hermes Coordination MCP Server
 * Small product-facing bridge for dispatch/status/artifact coordination.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { autoStartStdioMcpServer } from "./bootstrap.js";
import {
  hermesListArtifacts,
  hermesListSessions,
  hermesReadArtifact,
  hermesReadStatus,
  hermesReadTail,
  hermesReportStatus,
  hermesSendPrompt,
  hermesStartSession,
} from "./hermes-bridge.js";

const server = new Server(
  { name: "omx-hermes", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

export function buildHermesServerTools() {
  const workingDirectory = { type: "string", description: "Bounded OMX project/worktree directory" };
  const sessionId = { type: "string", description: "OMX session_id (A-Z, a-z, 0-9, _, -)" };
  const allowMutation = {
    type: "boolean",
    description: "Must be true for mutating operations; read tools ignore it.",
  };
  return [
    {
      name: "hermes_list_sessions",
      description: "List known OMX session state for a bounded worktree without reading terminal UI.",
      inputSchema: { type: "object", properties: { workingDirectory } },
    },
    {
      name: "hermes_start_session",
      description: "Start a new isolated OMX tmux session in disposable worktree mode for one bounded prompt.",
      inputSchema: {
        type: "object",
        properties: {
          workingDirectory,
          prompt: { type: "string" },
          worktreeName: { type: "string" },
          allow_mutation: allowMutation,
        },
        required: ["workingDirectory", "prompt", "allow_mutation"],
      },
    },
    {
      name: "hermes_send_prompt",
      description: "Queue one explicit prompt for a selected OMX exec session via the audited follow-up queue.",
      inputSchema: {
        type: "object",
        properties: {
          workingDirectory,
          session_id: sessionId,
          prompt: { type: "string" },
          actor: { type: "string" },
          allow_mutation: allowMutation,
        },
        required: ["session_id", "prompt", "allow_mutation"],
      },
    },
    {
      name: "hermes_read_status",
      description: "Read selected session/mode status JSON from OMX state files.",
      inputSchema: { type: "object", properties: { workingDirectory, session_id: sessionId } },
    },
    {
      name: "hermes_read_tail",
      description: "Read the bounded OMX session history log tail, not tmux scrollback.",
      inputSchema: { type: "object", properties: { workingDirectory, lines: { type: "number" } } },
    },
    {
      name: "hermes_list_artifacts",
      description: "List known safe result artifact files under .omx plans/specs/goals/context/reports.",
      inputSchema: { type: "object", properties: { workingDirectory, limit: { type: "number" } } },
    },
    {
      name: "hermes_read_artifact",
      description: "Read one safe .omx result artifact by relative path with byte truncation.",
      inputSchema: {
        type: "object",
        properties: { workingDirectory, path: { type: "string" }, max_bytes: { type: "number" } },
        required: ["path"],
      },
    },
    {
      name: "hermes_report_status",
      description: "Write a small final/blocker status report for Hermes without owning merge policy.",
      inputSchema: {
        type: "object",
        properties: {
          workingDirectory,
          session_id: sessionId,
          status: { type: "string", enum: ["running", "blocked", "failed", "complete"] },
          summary: { type: "string" },
          pr_url: { type: "string" },
          blocker: { type: "string" },
          allow_mutation: allowMutation,
        },
        required: ["status", "allow_mutation"],
      },
    },
  ];
}

const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  hermes_list_sessions: hermesListSessions,
  hermes_start_session: hermesStartSession,
  hermes_send_prompt: hermesSendPrompt,
  hermes_read_status: hermesReadStatus,
  hermes_read_tail: hermesReadTail,
  hermes_list_artifacts: hermesListArtifacts,
  hermes_read_artifact: hermesReadArtifact,
  hermes_report_status: hermesReportStatus,
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: buildHermesServerTools() }));

export async function handleHermesToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
  const { name, arguments: args = {} } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  const result = await handler(args);
  const isError = typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    ...(isError ? { isError: true } : {}),
  };
}

server.setRequestHandler(CallToolRequestSchema, handleHermesToolCall);
autoStartStdioMcpServer("hermes", server);
