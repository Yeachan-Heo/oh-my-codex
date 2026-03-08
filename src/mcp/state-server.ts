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
import {
	readFile,
	writeFile,
	readdir,
	mkdir,
	unlink,
	rename,
} from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
	getAllScopedStatePaths,
	getReadScopedStateDirs,
	getReadScopedStatePaths,
	resolveStateScope,
	getStateDir,
	getStatePath,
	resolveWorkingDirectoryForState,
	validateSessionId,
} from "./state-paths.js";
import { withModeRuntimeContext } from "../state/mode-state-context.js";
import {
	RALPH_PHASES,
	validateAndNormalizeRalphState,
} from "../ralph/contract.js";
import { ensureCanonicalRalphArtifacts } from "../ralph/persistence.js";
import { autoStartStdioMcpServer } from "./bootstrap.js";
import {
	LEGACY_TEAM_MCP_TOOLS,
	buildLegacyTeamDeprecationHint,
} from "../team/api-interop.js";

const SUPPORTED_MODES = [
	"autopilot",
	"team",
	"ralph",
	"ultrawork",
	"ultraqa",
	"ralplan",
] as const;

const STATE_TOOL_NAMES = new Set([
	"state_read",
	"state_write",
	"state_clear",
	"state_list_active",
	"state_get_status",
]);
const TEAM_COMM_TOOL_NAMES: Set<string> = new Set([...LEGACY_TEAM_MCP_TOOLS]);

const stateWriteQueues = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(
	path: string,
	fn: () => Promise<T>,
): Promise<T> {
	const tail = stateWriteQueues.get(path) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = tail.finally(() => gate);
	stateWriteQueues.set(path, queued);

	await tail.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		if (stateWriteQueues.get(path) === queued) {
			stateWriteQueues.delete(path);
		}
	}
}

async function writeAtomicFile(path: string, data: string): Promise<void> {
	const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
	await writeFile(tmpPath, data, "utf-8");
	try {
		await rename(tmpPath, path);
	} catch (error) {
		await unlink(tmpPath).catch(() => {});
		throw error;
	}
}

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
	const { name, arguments: args } = request.params;
	const wd = (args as Record<string, unknown>)?.workingDirectory as
		| string
		| undefined;
	let normalizedWd: string;
	try {
		normalizedWd = resolveWorkingDirectoryForState(wd);
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ error: (error as Error).message }),
				},
			],
			isError: true,
		};
	}
	let cwd = normalizedWd;
	let explicitSessionId: string | undefined;
	try {
		explicitSessionId = validateSessionId(
			(args as Record<string, unknown>)?.session_id,
		);
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ error: (error as Error).message }),
				},
			],
			isError: true,
		};
	}

	try {
		const stateScope = STATE_TOOL_NAMES.has(name)
			? await resolveStateScope(cwd, explicitSessionId)
			: undefined;
		const effectiveSessionId = stateScope?.sessionId;

		if (STATE_TOOL_NAMES.has(name)) {
			await mkdir(getStateDir(cwd), { recursive: true });
			if (effectiveSessionId) {
				await mkdir(getStateDir(cwd, effectiveSessionId), { recursive: true });
			}
			const { ensureTmuxHookInitialized } = await import("../cli/tmux-hook.js");
			await ensureTmuxHookInitialized(cwd);
		}

		if (TEAM_COMM_TOOL_NAMES.has(name)) {
			const hint = buildLegacyTeamDeprecationHint(
				name as (typeof LEGACY_TEAM_MCP_TOOLS)[number],
				(args as Record<string, unknown>) ?? {},
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

		switch (name) {
			case "state_read": {
				const mode = (args as Record<string, unknown>).mode as string;
				if (
					!SUPPORTED_MODES.includes(mode as (typeof SUPPORTED_MODES)[number])
				) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: `mode must be one of: ${SUPPORTED_MODES.join(", ")}`,
								}),
							},
						],
						isError: true,
					};
				}
				const paths = await getReadScopedStatePaths(
					mode,
					cwd,
					explicitSessionId,
				);
				const path = paths.find((candidate) => existsSync(candidate));
				if (!path) {
					return {
						content: [
							{ type: "text", text: JSON.stringify({ exists: false, mode }) },
						],
					};
				}
				const data = await readFile(path, "utf-8");
				return { content: [{ type: "text", text: data }] };
			}

			case "state_write": {
				const mode = (args as Record<string, unknown>).mode as string;
				const path = getStatePath(mode, cwd, effectiveSessionId);
				const {
					mode: _m,
					workingDirectory: _w,
					session_id: _sid,
					state: customState,
					...fields
				} = args as Record<string, unknown>;
				let validationError: string | null = null;
				await withStateWriteLock(path, async () => {
					let existing: Record<string, unknown> = {};
					if (existsSync(path)) {
						try {
							existing = JSON.parse(await readFile(path, "utf-8"));
						} catch (e) {
							process.stderr.write(
								"[state-server] Failed to parse state file: " + e + "\n",
							);
						}
					}

					const mergedRaw = {
						...existing,
						...fields,
						...((customState as Record<string, unknown>) || {}),
					} as Record<string, unknown>;

					if (mode === "ralph") {
						const originalPhase = mergedRaw.current_phase;
						const validation = validateAndNormalizeRalphState(mergedRaw);
						if (!validation.ok || !validation.state) {
							validationError =
								validation.error ||
								`ralph.current_phase must be one of: ${RALPH_PHASES.join(", ")}`;
							return;
						}
						if (
							typeof originalPhase === "string" &&
							typeof validation.state.current_phase === "string" &&
							validation.state.current_phase !== originalPhase
						) {
							validation.state.ralph_phase_normalized_from = originalPhase;
						}
						Object.assign(mergedRaw, validation.state);
						await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId);
					}

					const merged = withModeRuntimeContext(existing, mergedRaw);
					await writeAtomicFile(path, JSON.stringify(merged, null, 2));
				});
				if (validationError) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ error: validationError }),
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: true, mode, path }),
						},
					],
				};
			}

			case "state_clear": {
				const mode = (args as Record<string, unknown>).mode as string;
				const allSessions =
					(args as Record<string, unknown>).all_sessions === true;

				if (!allSessions) {
					const path = getStatePath(mode, cwd, effectiveSessionId);
					if (existsSync(path)) {
						await unlink(path);
					}
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ cleared: true, mode, path }),
							},
						],
					};
				}

				const removedPaths: string[] = [];
				const paths = await getAllScopedStatePaths(mode, cwd);
				for (const path of paths) {
					if (!existsSync(path)) continue;
					await unlink(path);
					removedPaths.push(path);
				}

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								cleared: true,
								mode,
								all_sessions: true,
								removed: removedPaths.length,
								paths: removedPaths,
								warning:
									"all_sessions clears global and session-scoped state files",
							}),
						},
					],
				};
			}

			case "state_list_active": {
				const stateDirs = await getReadScopedStateDirs(cwd, explicitSessionId);
				const active: string[] = [];
				const seenModes = new Set<string>();
				for (const stateDir of stateDirs) {
					if (!existsSync(stateDir)) continue;
					const files = await readdir(stateDir);
					for (const f of files) {
						if (!f.endsWith("-state.json")) continue;
						const mode = f.replace("-state.json", "");
						if (seenModes.has(mode)) continue;
						seenModes.add(mode);
						try {
							const data = JSON.parse(
								await readFile(join(stateDir, f), "utf-8"),
							);
							if (data.active) {
								active.push(mode);
							}
						} catch (e) {
							process.stderr.write(
								"[state-server] Failed to parse state file: " + e + "\n",
							);
						}
					}
				}
				return {
					content: [
						{ type: "text", text: JSON.stringify({ active_modes: active }) },
					],
				};
			}

			case "state_get_status": {
				const mode = (args as Record<string, unknown>)?.mode as
					| string
					| undefined;
				const stateDirs = await getReadScopedStateDirs(cwd, explicitSessionId);
				const statuses: Record<string, unknown> = {};
				const seenModes = new Set<string>();

				for (const stateDir of stateDirs) {
					if (!existsSync(stateDir)) continue;
					const files = await readdir(stateDir);
					for (const f of files) {
						if (!f.endsWith("-state.json")) continue;
						const m = f.replace("-state.json", "");
						if (mode && m !== mode) continue;
						if (seenModes.has(m)) continue;
						seenModes.add(m);
						try {
							const data = JSON.parse(
								await readFile(join(stateDir, f), "utf-8"),
							);
							statuses[m] = {
								active: data.active,
								phase: data.current_phase,
								path: join(stateDir, f),
								data,
							};
						} catch {
							statuses[m] = { error: "malformed state file" };
						}
					}
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ statuses }) }],
				};
			}

			default:
				return {
					content: [{ type: "text", text: `Unknown tool: ${name}` }],
					isError: true,
				};
		}
	} catch (error) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ error: (error as Error).message }),
				},
			],
			isError: true,
		};
	}
}
server.setRequestHandler(CallToolRequestSchema, handleStateToolCall);

// Start server
autoStartStdioMcpServer("state", server);
