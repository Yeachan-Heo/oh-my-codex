/**
 * OMX State Management MCP Server
 * Provides state read/write/clear/list tools for workflow modes
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
] as const;

const STATE_TOOL_NAMES = new Set([
	"state_read",
	"state_write",
	"state_clear",
	"state_list_active",
	"state_get_status",
]);
const TEAM_COMM_TOOL_NAMES: Set<string> = new Set([...LEGACY_TEAM_MCP_TOOLS]);

const server = new Server(
	{ name: "omx-state", version: "0.1.0" },
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
			name: "state_write",
			description:
				"Write/update state for a specific mode. Creates directories if needed.",
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
			description: "Clear/delete state for a specific mode.",
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

export async function handleStateToolCall(request: {
	params: { name: string; arguments?: Record<string, unknown> };
}) {
	const { name, arguments: args = {} } = request.params;

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

	if (!STATE_TOOL_NAMES.has(name)) {
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
server.setRequestHandler(CallToolRequestSchema, handleStateToolCall);

// Start server
autoStartStdioMcpServer("state", server);
