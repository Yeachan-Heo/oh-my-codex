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
import {
	executeReviewOperation,
	loadActiveReviewIdentity,
	loadPublishedReviewHookJournalSnapshot,
	REVIEW_OPERATION_NAMES,
	type ReviewOperationHostContext,
} from "../code-review/coordinator.js";
import { readSubagentTrackingState } from "../subagents/tracker.js";

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
const REVIEW_TOOL_NAMES: Set<string> = new Set(REVIEW_OPERATION_NAMES);
const TEAM_COMM_TOOL_NAMES: Set<string> = new Set([...LEGACY_TEAM_MCP_TOOLS]);

async function reviewMcpHostContext(
	args: Record<string, unknown>,
): Promise<ReviewOperationHostContext> {
	const workingDirectory = typeof args.workingDirectory === "string" ? args.workingDirectory : process.cwd();
	const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
	const tracking = await readSubagentTrackingState(workingDirectory);
	const session = sessionId === undefined ? undefined : tracking.sessions[sessionId];
	const activeReview = sessionId === undefined
		? null
		: await loadActiveReviewIdentity({ workingDirectory, session_id: sessionId });
	const rootThreadId = session?.leader_thread_id ?? activeReview?.root_thread_id;
	return {
		source: "MCP",
		...(activeReview?.status === "CREATED" ? { seeded_review_id: activeReview.review_id } : {}),
		...(rootThreadId && sessionId ? {
			root_thread_id: rootThreadId,
			loadHookJournalSnapshot: async (input) => await loadPublishedReviewHookJournalSnapshot({
				workingDirectory,
				...input,
			}),
		} : {}),
		loadTracker: async (input) => {
			const current = await readSubagentTrackingState(input.workingDirectory);
			const currentSession = input.session_id === undefined ? undefined : current.sessions[input.session_id];
			const thread = currentSession?.threads[input.thread_id];
			if (thread?.kind !== "subagent" || thread.lane_id !== input.lane_id) return undefined;
			return {
				schema_version: 1,
				session_id: currentSession!.session_id,
				thread_id: thread.thread_id,
				tracker_lane_id: thread.lane_id,
				tracker_path: ".omx/state/subagent-tracking.json",
				first_seen_at: thread.first_seen_at,
				last_seen_at: thread.last_seen_at,
				...(thread.completed_at === undefined ? {} : { completed_at: thread.completed_at }),
			};
		},
	};
}

const server = new Server(
	{ name: "omx-state", version: "0.1.0" },
	{ capabilities: { tools: {} } },
);

export function buildStateServerTools() {
	const stateTools = [
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
	return [...stateTools, ...buildReviewTools()];
}

const reviewCommonProperties = {
	workingDirectory: { type: "string", minLength: 1, maxLength: 4096 },
	session_id: { type: "string", minLength: 1, maxLength: 160 },
} as const;

const reviewFindingSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
		title: { type: "string" }, body: { type: "string" }, file: { type: "string" },
		start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 },
		fix: { type: "string" }, evidence: { type: "string" },
	},
	required: ["severity", "title", "body", "file", "fix"],
} as const;

const diagnosticSubmissionSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		diagnostic_id: { type: "string" },
		capability: { type: "string", enum: ["LSP", "AST", "COMPILER", "LINT", "RG_FALLBACK"] },
		applicability: { type: "string", enum: ["APPLICABLE", "NOT_APPLICABLE"] },
		execution: { type: "string", enum: ["NATIVE", "ACCEPTED_EQUIVALENT", "FALLBACK", "UNAVAILABLE", "SKIPPED"] },
		outcome: { type: "string", enum: ["PASS", "FAIL", "TIMED_OUT", "MALFORMED", "NOT_RUN"] },
		tool_name: { type: "string" }, program: { type: "string" },
		args: { type: "array", items: { type: "string" } }, event_ref: { type: "string" },
		source_ref: { type: "string" }, summary: { type: "string" },
	},
	required: ["diagnostic_id", "capability", "applicability", "execution", "outcome", "event_ref", "summary"],
} as const;

const reviewerResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		role: { const: "code-reviewer" }, review_id: { type: "string" }, attempt: { type: "integer", minimum: 1 },
		lane_id: { type: "string" }, batch_id: { type: "string" }, scope_hash: { type: "string" },
		recommendation: { type: "string", enum: ["APPROVE", "COMMENT", "REQUEST CHANGES"] },
		findings: { type: "array", items: reviewFindingSchema },
		diagnostics: { type: "array", items: diagnosticSubmissionSchema },
	},
	required: ["role", "review_id", "attempt", "lane_id", "batch_id", "scope_hash", "recommendation", "findings", "diagnostics"],
} as const;

const architectResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		role: { const: "architect" }, review_id: { type: "string" }, attempt: { type: "integer", minimum: 1 },
		lane_id: { type: "string" }, batch_id: { const: "global" }, scope_hash: { type: "string" },
		architectural_status: { type: "string", enum: ["CLEAR", "WATCH", "BLOCK"] },
		findings: { type: "array", items: reviewFindingSchema },
	},
	required: ["role", "review_id", "attempt", "lane_id", "batch_id", "scope_hash", "architectural_status", "findings"],
} as const;

function buildReviewTools() {
	const idempotencyKey = { type: "string", format: "uuid" } as const;
	const reviewId = { type: "string", format: "uuid" } as const;
	const startEventSchema = {
		type: "object", additionalProperties: false,
		properties: {
			...reviewCommonProperties, event: { const: "START" }, review_id: reviewId,
			attempt: { type: "integer", minimum: 1 }, lane_id: { type: "string" },
			thread_id: { type: "string" }, idempotency_key: idempotencyKey,
		},
		required: ["workingDirectory", "session_id", "event", "review_id", "attempt", "lane_id", "thread_id", "idempotency_key"],
	} as const;
	const resultEventSchema = {
		type: "object", additionalProperties: false,
		properties: {
			...reviewCommonProperties, event: { const: "RESULT" }, review_id: reviewId,
			attempt: { type: "integer", minimum: 1 }, lane_id: { type: "string" },
			scope_hash: { type: "string" }, result: { oneOf: [reviewerResultSchema, architectResultSchema] },
			idempotency_key: idempotencyKey,
		},
		required: ["workingDirectory", "session_id", "event", "review_id", "attempt", "lane_id", "scope_hash", "result", "idempotency_key"],
	} as const;
	return [
		{
			name: "review_start", description: "Freeze scope and start a durable code review.",
			inputSchema: {
				type: "object", additionalProperties: false,
				properties: {
					...reviewCommonProperties,
					invocation: { type: "array", items: { type: "string" }, maxItems: 256 },
					idempotency_key: idempotencyKey,
					accepted_equivalent_requests: {
						type: "array", maxItems: 128, items: {
							type: "object", additionalProperties: false,
							properties: { capability: { type: "string", enum: ["LSP", "AST"] }, source_ref: { type: "string" } },
							required: ["capability", "source_ref"],
						},
					},
				},
				required: ["workingDirectory", "invocation", "idempotency_key"],
			},
		},
		{
			name: "review_get", description: "Read and reconcile a durable code review.",
			inputSchema: {
				type: "object", additionalProperties: false,
				properties: {
					...reviewCommonProperties,
					review_id: reviewId,
					lane_id: { type: "string", minLength: 1, maxLength: 160 },
					wait: { type: "boolean" },
					maximum_wait_ms: { type: "integer", minimum: 1, maximum: 30_000 },
				},
				required: ["workingDirectory"],
				allOf: [
					{
						if: { properties: { wait: { const: true } }, required: ["wait"] },
						then: { required: ["lane_id"] },
					},
					{
						if: { required: ["maximum_wait_ms"] },
						then: { properties: { wait: { const: true } }, required: ["wait", "lane_id"] },
					},
				],
			},
		},
		{
			name: "review_record_lane", description: "Bind a lane or propose a lane result.",
			inputSchema: { oneOf: [startEventSchema, resultEventSchema] },
		},
		{
			name: "review_resume", description: "Resume the failed lanes of a durable review.",
			inputSchema: {
				type: "object", additionalProperties: false,
				properties: { ...reviewCommonProperties, review_id: reviewId, idempotency_key: idempotencyKey },
				required: ["workingDirectory", "review_id", "idempotency_key"],
			},
		},
		{
			name: "review_finalize", description: "Finalize a durable review and publish bounded artifacts.",
			inputSchema: {
				type: "object", additionalProperties: false,
				properties: {
					...reviewCommonProperties, review_id: reviewId, attempt: { type: "integer", minimum: 1 },
					idempotency_key: idempotencyKey,
				},
				required: ["workingDirectory", "review_id", "attempt", "idempotency_key"],
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

	if (!STATE_TOOL_NAMES.has(name) && !REVIEW_TOOL_NAMES.has(name)) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}
	if (REVIEW_TOOL_NAMES.has(name)) {
		const result = await executeReviewOperation(
			name as (typeof REVIEW_OPERATION_NAMES)[number],
			args,
			await reviewMcpHostContext(args),
		);
		return {
			content: [{ type: "text", text: JSON.stringify(result.payload) }],
			...(result.isError ? { isError: true } : {}),
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
