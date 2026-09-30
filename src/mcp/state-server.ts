/**
 * OMX State Management MCP Server (read-only projection).
 *
 * As of epic #3491 (issue #3498), this server is a read-only projection of
 * `.omx/state/` session-scoped workflow state. The sole writer is
 * `src/state/operations.ts` (via CLI / programmatic callers). The MCP surface
 * exposes only read/list/status operations.
 *
 * Storage: .omx/state/{mode}-state.json
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { autoStartStdioMcpServer } from "./bootstrap.js";
import {
	LEGACY_TEAM_MCP_TOOLS,
	buildLegacyTeamDeprecationHint,
} from "../team/api-interop.js";
import { executeStateOperation } from "../state/operations.js";

const SUPPORTED_MODES = [
	"autopilot",
	"autoresearch",
	"team",
	"ralph",
	"ultrawork",
	"ultraqa",
	"ralplan",
	"deep-interview",
	"skill-active",
	"ultragoal",
] as const;

/**
 * Read-only tool names. `state_write` and `state_clear` were removed from the
 * MCP surface in #3498; writes are routed through `src/state/operations.ts` via
 * CLI/programmatic callers only.
 */
const READ_ONLY_TOOL_NAMES = new Set([
	"state_read",
	"state_list_active",
	"state_get_status",
]);

/**
 * Tools that existed on the MCP surface but are now writer-only. The MCP server
 * still recognises them so that legacy callers receive a clear deprecation
 * error instead of a generic "unknown tool" message.
 */
const DEPRECATED_WRITER_TOOL_NAMES = new Set([
	"state_write",
	"state_clear",
]);

const TEAM_COMM_TOOL_NAMES: Set<string> = new Set([...LEGACY_TEAM_MCP_TOOLS]);

const server = new Server(
	{ name: "omx-state", version: "0.2.0" },
	{ capabilities: { tools: {} } },
);

export function buildStateServerTools() {
	return [
		{
			name: "state_read",
			description:
				"Read state for a specific mode. Returns JSON state data or indicates no state exists.",
			inputSchema: {
				type: "object",
				properties: {
					mode: {
						type: "string",
						enum: [...SUPPORTED_MODES],
						description: "The mode to read state for",
					},
					workingDirectory: {
						type: "string",
						description: "Working directory override",
					},
					session_id: {
						type: "string",
						description: "Optional session scope ID",
					},
				},
				required: ["mode"],
			},
		},
		{
			name: "state_list_active",
			description: "List all currently active modes.",
			inputSchema: {
				type: "object",
				properties: {
					workingDirectory: { type: "string" },
					session_id: {
						type: "string",
						description: "Optional session scope ID",
					},
				},
			},
		},
		{
			name: "state_get_status",
			description: "Get detailed status for a specific mode or all modes.",
			inputSchema: {
				type: "object",
				properties: {
					mode: { type: "string", enum: [...SUPPORTED_MODES] },
					workingDirectory: { type: "string" },
					session_id: {
						type: "string",
						description: "Optional session scope ID",
					},
				},
			},
		},
	];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: buildStateServerTools(),
}));

export async function handleStateToolCall(
	request: {
		params: { name: string; arguments?: Record<string, unknown> };
	},
	options: { allowWriterTools?: boolean } = {},
) {
	const { name, arguments: args = {} } = request.params;
	const allowWriterTools = options.allowWriterTools === true;

	if (TEAM_COMM_TOOL_NAMES.has(name)) {
		const hint = buildLegacyTeamDeprecationHint(
			name as (typeof LEGACY_TEAM_MCP_TOOLS)[number],
			args,
		);
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: `MCP tool "${name}" is hard-deprecated. Team mutations now require CLI interop.`,
						code: "deprecated_cli_only",
						hint,
					}),
				},
			],
			isError: true,
		};
	}

	if (DEPRECATED_WRITER_TOOL_NAMES.has(name)) {
		if (allowWriterTools) {
			const result = await executeStateOperation(
				name as Parameters<typeof executeStateOperation>[0],
				args,
			);
			return {
				content: [{ type: "text", text: JSON.stringify(result.payload) }],
				...(result.isError ? { isError: true } : {}),
			};
		}
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: `MCP tool "${name}" is no longer available on the state server. Use the CLI (omx state write/clear) or programmatic executeStateOperation instead. The MCP state server is now read-only.`,
						code: "mcp_state_server_read_only",
					}),
				},
			],
			isError: true,
		};
	}

	if (!READ_ONLY_TOOL_NAMES.has(name)) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	const result = await executeStateOperation(
		name as Parameters<typeof executeStateOperation>[0],
		args,
	);
	return {
		content: [{ type: "text", text: JSON.stringify(result.payload) }],
		...(result.isError ? { isError: true } : {}),
	};
}

/**
 * Tool definitions for write/clear operations exposed via the CLI parity
 * surface (`omx state write/clear`). These are intentionally NOT advertised on
 * the MCP server (which is read-only per #3498) but are still available through
 * the CLI/programmatic path via {@link executeStateOperation}.
 */
export function buildStateServerWriterTools() {
	return [
		{
			name: "state_write",
			description:
				"Write/update state for a specific mode. Sole-writer path via executeStateOperation.",
			inputSchema: {
				type: "object",
				properties: {
					mode: { type: "string", enum: [...SUPPORTED_MODES] },
					active: { type: "boolean" },
					iteration: { type: "number" },
					max_iterations: { type: "number" },
					current_phase: { type: "string" },
					task_description: { type: "string" },
					started_at: { type: "string" },
					completed_at: { type: "string" },
					run_outcome: {
						type: "string",
						enum: ["continue", "finish", "blocked_on_user", "failed", "cancelled"],
					},
					lifecycle_outcome: {
						type: "string",
						enum: ["finished", "blocked", "failed", "userinterlude", "askuserQuestion"],
					},
					terminal_outcome: {
						type: "string",
						enum: ["finished", "blocked", "failed", "userinterlude", "askuserQuestion"],
						description: "Legacy alias for lifecycle_outcome; canonical writes should prefer lifecycle_outcome.",
					},
					error: { type: "string" },
					state: { type: "object", description: "Additional custom fields" },
					workingDirectory: { type: "string" },
					session_id: {
						type: "string",
						description: "Optional session scope ID",
					},
				},
				required: ["mode"],
			},
		},
		{
			name: "state_clear",
			description: "Clear/delete state for a specific mode. Sole-writer path via executeStateOperation.",
			inputSchema: {
				type: "object",
				properties: {
					mode: { type: "string", enum: [...SUPPORTED_MODES] },
					workingDirectory: { type: "string" },
					session_id: {
						type: "string",
						description: "Optional session scope ID",
					},
					all_sessions: {
						type: "boolean",
						description: "Clear matching mode in global and all session scopes",
					},
				},
				required: ["mode"],
			},
		},
	];
}
server.setRequestHandler(CallToolRequestSchema, (request) => handleStateToolCall(request));

// Start server
autoStartStdioMcpServer("state", server);
