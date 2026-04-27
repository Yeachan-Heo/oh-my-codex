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
	SKILL_ACTIVE_STATE_MODE,
	readSkillActiveState,
	syncCanonicalSkillStateForMode,
	writeSkillActiveStateCopies,
} from "../state/skill-active.js";
import {
	isTrackedWorkflowMode,
} from "../state/workflow-transition.js";
import { reconcileWorkflowTransition } from "../state/workflow-transition-reconcile.js";
import {
	RALPH_PHASES,
	validateAndNormalizeRalphState,
} from "../ralph/contract.js";
import { ensureCanonicalRalphArtifacts } from "../ralph/persistence.js";
import { applyRunOutcomeContract } from "../runtime/run-outcome.js";
import { autoStartStdioMcpServer } from "./bootstrap.js";
import {
	LEGACY_TEAM_MCP_TOOLS,
	buildLegacyTeamDeprecationHint,
} from "../team/api-interop.js";

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

const stateWriteQueues = new Map<string, Promise<void>>();

async function listStateSessionIds(cwd: string): Promise<string[]> {
	const sessionsDir = join(getStateDir(cwd), "sessions");
	if (!existsSync(sessionsDir)) return [];
	const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.filter((entry) => entry.trim().length > 0);
}

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

async function writeClearedSessionScopedModeState(
	path: string,
	mode: string,
	sessionId: string,
): Promise<void> {
	const nowIso = new Date().toISOString();
	const clearedState = withModeRuntimeContext({}, {
		mode,
		active: false,
		current_phase: "cleared",
		updated_at: nowIso,
		completed_at: nowIso,
		session_id: sessionId,
	});
	await writeAtomicFile(path, JSON.stringify(clearedState, null, 2));
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
					let transitionMessage: string | undefined;
					let ensureRalphArtifacts = false;
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
						const explicitRunOutcome = Object.prototype.hasOwnProperty.call(fields, "run_outcome")
							|| (
								customState != null
								&& Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, "run_outcome")
							);
						if (!explicitRunOutcome) {
							delete mergedRaw.run_outcome;
						}
						const explicitLifecycleOutcome = Object.prototype.hasOwnProperty.call(fields, "lifecycle_outcome")
							|| (
								customState != null
								&& Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, "lifecycle_outcome")
							);
						if (!explicitLifecycleOutcome) {
							delete mergedRaw.lifecycle_outcome;
						}
						const explicitTerminalOutcome = Object.prototype.hasOwnProperty.call(fields, "terminal_outcome")
							|| (
								customState != null
								&& Object.prototype.hasOwnProperty.call(customState as Record<string, unknown>, "terminal_outcome")
							);
						if (!explicitTerminalOutcome) {
							delete mergedRaw.terminal_outcome;
						}
						if (
							mode === "ralph" &&
							effectiveSessionId &&
						typeof mergedRaw.owner_omx_session_id !== "string"
					) {
						mergedRaw.owner_omx_session_id = effectiveSessionId;
					}

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
							ensureRalphArtifacts = true;
						}
						if (mode !== SKILL_ACTIVE_STATE_MODE) {
							const runOutcomeValidation = applyRunOutcomeContract(mergedRaw);
							if (!runOutcomeValidation.ok || !runOutcomeValidation.state) {
								validationError =
									runOutcomeValidation.error || "Invalid run outcome state";
								return;
							}
							Object.assign(mergedRaw, runOutcomeValidation.state);
						}
						if (isTrackedWorkflowMode(mode) && mergedRaw.active === true) {
							try {
								if (!effectiveSessionId) {
									for (const sessionId of await listStateSessionIds(cwd)) {
										const sessionTransition = await reconcileWorkflowTransition(cwd, mode, {
											action: "write",
											sessionId,
											source: "state-server",
										});
										transitionMessage ??= sessionTransition.transitionMessage;
									}
								}
								const transition = await reconcileWorkflowTransition(cwd, mode, {
									action: "write",
									sessionId: effectiveSessionId,
									source: "state-server",
								});
								transitionMessage ??= transition.transitionMessage;
							} catch (error) {
								validationError = (error as Error).message;
								return;
							}
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
					if (mode === SKILL_ACTIVE_STATE_MODE) {
						const state = await readSkillActiveState(path);
						if (state) {
							await writeSkillActiveStateCopies(cwd, state, effectiveSessionId);
						}
					} else {
						if (mode === "ralph" && ensureRalphArtifacts) {
							await ensureCanonicalRalphArtifacts(cwd, effectiveSessionId);
						}
						const data = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
						await syncCanonicalSkillStateForMode({
							cwd,
						mode,
						active: data.active === true,
						currentPhase: typeof data.current_phase === "string" ? data.current_phase : undefined,
						sessionId: effectiveSessionId,
					});
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								success: true,
								mode,
								path,
								...(transitionMessage ? { transition: transitionMessage } : {}),
							}),
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
					if (
						mode !== SKILL_ACTIVE_STATE_MODE &&
						effectiveSessionId &&
						existsSync(getStatePath(mode, cwd))
					) {
						await writeClearedSessionScopedModeState(path, mode, effectiveSessionId);
					} else if (existsSync(path)) {
						await unlink(path);
					}
					if (mode !== SKILL_ACTIVE_STATE_MODE) {
						await syncCanonicalSkillStateForMode({
							cwd,
							mode,
							active: false,
							sessionId: effectiveSessionId,
						});
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
				if (mode !== SKILL_ACTIVE_STATE_MODE) {
					await syncCanonicalSkillStateForMode({
						cwd,
						mode,
						active: false,
					});
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
						if (mode === SKILL_ACTIVE_STATE_MODE) continue;
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
