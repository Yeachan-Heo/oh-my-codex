/**
 * omx doctor - Validate oh-my-codex installation
 */

import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import {
	codexHome,
	codexConfigPath,
	codexPromptsDir,
	userSkillsDir,
	projectSkillsDir,
	omxStateDir,
	detectLegacySkillRootOverlap,
} from "../utils/paths.js";
import {
	classifySpawnError,
	spawnPlatformCommandSync,
} from "../utils/platform-command.js";
import { getCatalogExpectations } from "./catalog-contract.js";
import { parse as parseToml } from "@iarna/toml";
import {
	getBuiltinExploreHarnessUnsupportedReason,
	resolvePackagedExploreHarnessCommand,
	EXPLORE_BIN_ENV,
} from "./explore.js";
import { getPackageRoot } from "../utils/package.js";
import {
	hasLegacyOmxTeamRunTable,
	getModelContextRecommendation,
} from "../config/generator.js";
import { getMissingManagedCodexHookEvents } from "../config/codex-hooks.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";
import { getDefaultBridge, isBridgeEnabled } from "../runtime/bridge.js";
import {
	OMX_EXPLORE_CMD_ENV,
	isExploreCommandRoutingEnabled,
} from "../hooks/explore-routing.js";
import {
	OMX_LORE_COMMIT_GUARD_ENV,
	isLoreCommitGuardEnabled,
} from "../config/commit-lore-guard.js";
import { isLeaderRuntimeStale } from "../team/leader-activity.js";
import { triagePrompt } from "../hooks/triage-heuristic.js";
import { readTriageConfig } from "../hooks/triage-config.js";
import {
	readPersistedSetupPreferences,
	type SetupInstallMode,
} from "./setup-preferences.js";
import {
	OMX_LOCAL_MARKETPLACE_NAME,
	resolvePackagedOmxMarketplace,
} from "./plugin-marketplace.js";

interface DoctorOptions {
	verbose?: boolean;
	force?: boolean;
	dryRun?: boolean;
	team?: boolean;
}

interface Check {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
}

type DoctorSetupScope = "user" | "project";

interface DoctorScopeResolution {
	scope: DoctorSetupScope;
	source: "persisted" | "default";
	installMode?: SetupInstallMode;
}

interface DoctorPaths {
	codexHomeDir: string;
	configPath: string;
	hooksPath: string;
	promptsDir: string;
	skillsDir: string;
	stateDir: string;
}

async function resolveDoctorScope(cwd: string): Promise<DoctorScopeResolution> {
	const persisted = await readPersistedSetupPreferences(cwd);
	if (persisted?.scope) {
		return {
			scope: persisted.scope,
			source: "persisted",
			installMode: persisted.installMode,
		};
	}

	return { scope: "user", source: "default" };
}

function resolveDoctorPaths(cwd: string, scope: DoctorSetupScope): DoctorPaths {
	if (scope === "project") {
		const codexHomeDir = join(cwd, ".codex");
		return {
			codexHomeDir,
			configPath: join(codexHomeDir, "config.toml"),
			hooksPath: join(codexHomeDir, "hooks.json"),
			promptsDir: join(codexHomeDir, "prompts"),
			skillsDir: projectSkillsDir(cwd),
			stateDir: omxStateDir(cwd),
		};
	}

	return {
		codexHomeDir: codexHome(),
		configPath: codexConfigPath(),
		hooksPath: join(codexHome(), "hooks.json"),
		promptsDir: codexPromptsDir(),
		skillsDir: userSkillsDir(),
		stateDir: omxStateDir(cwd),
	};
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
	if (options.team) {
		await doctorTeam();
		return;
	}

	const cwd = process.cwd();
	const scopeResolution = await resolveDoctorScope(cwd);
	const paths = resolveDoctorPaths(cwd, scopeResolution.scope);
	const scopeSourceMessage =
		scopeResolution.source === "persisted"
			? " (from .omx/setup-scope.json)"
			: "";

	console.log("oh-my-codex doctor");
	console.log("==================\n");
	console.log(
		`Resolved setup scope: ${scopeResolution.scope}${scopeSourceMessage}`,
	);
	if (scopeResolution.installMode) {
		console.log(
			`Resolved setup install mode: ${scopeResolution.installMode}${scopeSourceMessage}`,
		);
	}
	console.log();

	const checks: Check[] = [];

	// Check 1: Codex CLI installed
	checks.push(checkCodexCli());

	// Check 2: Node.js version
	checks.push(checkNodeVersion());

	// Check 2.5: Explore harness readiness
	checks.push(checkExploreHarness());

	// Check 3: Codex home directory
	checks.push(checkDirectory("Codex home", paths.codexHomeDir));

	// Check 4: Config file
	checks.push(await checkConfig(paths.configPath));

	// Check 4.1: Model context recommendation
	const contextRecommendationCheck = await checkModelContextRecommendation(
		paths.configPath,
	);
	if (contextRecommendationCheck) checks.push(contextRecommendationCheck);

	// Check 4.25: Native hooks coverage
	checks.push(await checkNativeHooks(paths.hooksPath, paths.configPath));

	// Check 4.5: Explore routing default
	checks.push(await checkExploreRouting(paths.configPath));

	// Check 4.6: Lore commit guard default
	checks.push(await checkLoreCommitGuard(paths.configPath));

	// Check 5: Prompts installed
	checks.push(
		await checkPrompts(paths.promptsDir, scopeResolution.installMode),
	);

	// Check 6: Skills installed
	checks.push(await checkSkills(paths, scopeResolution.installMode));

	// Check 6.5: Legacy/current skill-root overlap
	if (scopeResolution.scope === "user") {
		checks.push(await checkLegacySkillRootOverlap());
	}

	// Check 7: AGENTS.md in project
	checks.push(
		checkAgentsMd(
			scopeResolution.scope,
			paths.codexHomeDir,
			scopeResolution.installMode,
		),
	);

	// Check 8: State directory
	checks.push(checkDirectory("State dir", paths.stateDir));

	// Check 9: MCP servers configured
	checks.push(
		await checkMcpServers(paths.configPath, scopeResolution.installMode),
	);

	// Check 10: Prompt triage
	checks.push(checkPromptTriage());

	// Print results
	let passCount = 0;
	let warnCount = 0;
	let failCount = 0;

	for (const check of checks) {
		const icon =
			check.status === "pass"
				? "[OK]"
				: check.status === "warn"
					? "[!!]"
					: "[XX]";
		console.log(`  ${icon} ${check.name}: ${check.message}`);
		if (check.status === "pass") passCount++;
		else if (check.status === "warn") warnCount++;
		else failCount++;
	}

	console.log(
		`\nResults: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`,
	);

	if (failCount > 0) {
		console.log('\nRun "omx setup" to fix installation issues.');
	} else if (warnCount > 0) {
		console.log('\nRun "omx setup --force" to refresh all components.');
	} else {
		console.log("\nAll checks passed! oh-my-codex is ready.");
	}
}

interface TeamDoctorIssue {
	code:
		| "delayed_status_lag"
		| "slow_shutdown"
		| "orphan_tmux_session"
		| "resume_blocker"
		| "prompt_resume_unavailable"
		| "stale_leader";
	message: string;
	severity: "warn" | "fail";
}

async function doctorTeam(): Promise<void> {
	console.log("oh-my-codex doctor --team");
	console.log("=========================\n");

	const issues = await collectTeamDoctorIssues(process.cwd());
	if (issues.length === 0) {
		console.log("  [OK] team diagnostics: no issues");
		console.log("\nAll team checks passed.");
		return;
	}

	const failureCount = issues.filter(
		(issue) => issue.severity === "fail",
	).length;
	const warningCount = issues.length - failureCount;

	for (const issue of issues) {
		const icon = issue.severity === "warn" ? "[!!]" : "[XX]";
		console.log(`  ${icon} ${issue.code}: ${issue.message}`);
	}

	console.log(`\nResults: ${warningCount} warnings, ${failureCount} failed`);
	// Ensure non-zero exit for `omx doctor --team` failures.
	if (failureCount > 0) process.exitCode = 1;
}

async function collectTeamDoctorIssues(
	cwd: string,
): Promise<TeamDoctorIssue[]> {
	const issues: TeamDoctorIssue[] = [];
	const stateDir = omxStateDir(cwd);
	const teamsRoot = join(stateDir, "team");
	const nowMs = Date.now();
	const lagThresholdMs = 60_000;
	const shutdownThresholdMs = 30_000;
	const leaderStaleThresholdMs = 180_000;

	// Rust-first: if the runtime bridge is enabled, use Rust-authored readiness
	// and authority as the semantic truth source for runtime health.
	if (isBridgeEnabled()) {
		const bridge = getDefaultBridge(stateDir);
		const readiness = bridge.readReadiness();
		const authority = bridge.readAuthority();
		if (readiness && !readiness.ready) {
			for (const reason of readiness.reasons) {
				issues.push({
					code: "resume_blocker",
					message: `runtime not ready: ${reason}`,
					severity: "fail",
				});
			}
		}
		if (authority?.stale) {
			issues.push({
				code: "stale_leader",
				message: `authority stale (owner: ${authority.owner ?? "unknown"}): ${authority.stale_reason ?? "unknown reason"}`,
				severity: "fail",
			});
		}
	}

	const teamDirs: string[] = [];
	if (existsSync(teamsRoot)) {
		const entries = await readdir(teamsRoot, { withFileTypes: true });
		for (const e of entries) {
			if (e.isDirectory()) teamDirs.push(e.name);
		}
	}

	const tmuxSessions = listTeamTmuxSessions();
	const tmuxUnavailable = tmuxSessions === null;
	const knownTeamSessions = new Set<string>();

	for (const teamName of teamDirs) {
		const teamDir = join(teamsRoot, teamName);
		const manifestPath = join(teamDir, "manifest.v2.json");
		const configPath = join(teamDir, "config.json");

		let tmuxSession = `omx-team-${teamName}`;
		let workerLaunchMode: "interactive" | "prompt" = "interactive";
		let promptWorkers: Array<{ name?: string; pid?: number }> = [];
		if (existsSync(manifestPath)) {
			try {
				const raw = await readFile(manifestPath, "utf-8");
				const parsed = JSON.parse(raw) as {
					tmux_session?: string;
					policy?: { worker_launch_mode?: string };
					workers?: Array<{ name?: string; pid?: number }>;
				};
				if (
					typeof parsed.tmux_session === "string" &&
					parsed.tmux_session.trim() !== ""
				) {
					tmuxSession = parsed.tmux_session;
				}
				if (parsed.policy?.worker_launch_mode === "prompt") {
					workerLaunchMode = "prompt";
				}
				if (Array.isArray(parsed.workers)) promptWorkers = parsed.workers;
			} catch {
				// ignore malformed manifest
			}
		} else if (existsSync(configPath)) {
			try {
				const raw = await readFile(configPath, "utf-8");
				const parsed = JSON.parse(raw) as {
					tmux_session?: string;
					worker_launch_mode?: string;
					workers?: Array<{ name?: string; pid?: number }>;
				};
				if (
					typeof parsed.tmux_session === "string" &&
					parsed.tmux_session.trim() !== ""
				) {
					tmuxSession = parsed.tmux_session;
				}
				if (parsed.worker_launch_mode === "prompt") {
					workerLaunchMode = "prompt";
				}
				if (Array.isArray(parsed.workers)) promptWorkers = parsed.workers;
			} catch {
				// ignore malformed config
			}
		}

		knownTeamSessions.add(tmuxSession);

		if (workerLaunchMode === "prompt") {
			for (const worker of promptWorkers) {
				const pid = worker.pid ?? 0;
				if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) {
					issues.push({
						code: "prompt_resume_unavailable",
						message: `${teamName}/${worker.name ?? "unknown"} pid ${pid} appears to be running, but doctor cannot verify that the PID still belongs to the original prompt-mode worker after CLI restart; if this is the original worker, shut it down or start a new team`,
						severity: "warn",
					});
				}
			}
		} else if (!tmuxUnavailable && !tmuxSessions.has(tmuxSession)) {
			// resume_blocker: only meaningful if tmux is available to query for interactive teams.
			issues.push({
				code: "resume_blocker",
				message: `${teamName} references missing tmux session ${tmuxSession}`,
				severity: "fail",
			});
		}

		// delayed_status_lag + slow_shutdown checks
		const workersRoot = join(teamDir, "workers");
		if (!existsSync(workersRoot)) continue;
		const workers = await readdir(workersRoot, { withFileTypes: true });
		for (const worker of workers) {
			if (!worker.isDirectory()) continue;
			const workerDir = join(workersRoot, worker.name);
			const statusPath = join(workerDir, "status.json");
			const heartbeatPath = join(workerDir, "heartbeat.json");
			const shutdownReqPath = join(workerDir, "shutdown-request.json");
			const shutdownAckPath = join(workerDir, "shutdown-ack.json");

			if (existsSync(statusPath) && existsSync(heartbeatPath)) {
				try {
					const [statusRaw, hbRaw] = await Promise.all([
						readFile(statusPath, "utf-8"),
						readFile(heartbeatPath, "utf-8"),
					]);
					const status = JSON.parse(statusRaw) as { state?: string };
					const hb = JSON.parse(hbRaw) as { last_turn_at?: string };
					const lastTurnMs = hb.last_turn_at
						? Date.parse(hb.last_turn_at)
						: NaN;
					if (
						status.state === "working" &&
						Number.isFinite(lastTurnMs) &&
						nowMs - lastTurnMs > lagThresholdMs
					) {
						issues.push({
							code: "delayed_status_lag",
							message: `${teamName}/${worker.name} working with stale heartbeat`,
							severity: "fail",
						});
					}
				} catch {
					// ignore malformed files
				}
			}

			if (existsSync(shutdownReqPath) && !existsSync(shutdownAckPath)) {
				try {
					const reqRaw = await readFile(shutdownReqPath, "utf-8");
					const req = JSON.parse(reqRaw) as { requested_at?: string };
					const reqMs = req.requested_at ? Date.parse(req.requested_at) : NaN;
					if (Number.isFinite(reqMs) && nowMs - reqMs > shutdownThresholdMs) {
						issues.push({
							code: "slow_shutdown",
							message: `${teamName}/${worker.name} has stale shutdown request without ack`,
							severity: "fail",
						});
					}
				} catch {
					// ignore malformed files
				}
			}
		}
	}

	// stale_leader: team has active workers but leader has no recent activity
	const hudStatePath = join(stateDir, "hud-state.json");
	const leaderActivityPath = join(stateDir, "leader-runtime-activity.json");
	if (
		(existsSync(hudStatePath) || existsSync(leaderActivityPath)) &&
		teamDirs.length > 0
	) {
		try {
			const leaderIsStale = await isLeaderRuntimeStale(
				stateDir,
				leaderStaleThresholdMs,
				nowMs,
			);

			if (leaderIsStale && !tmuxUnavailable) {
				// Check if any team tmux session has live worker panes
				for (const teamName of teamDirs) {
					const session = knownTeamSessions.has(`omx-team-${teamName}`)
						? `omx-team-${teamName}`
						: [...knownTeamSessions].find((s) => s.includes(teamName));
					if (!session || !tmuxSessions.has(session)) continue;
					issues.push({
						code: "stale_leader",
						message: `${teamName} has active tmux session but leader has no recent activity`,
						severity: "fail",
					});
				}
			}
		} catch {
			// ignore malformed HUD state
		}
	}

	// orphan_tmux_session: session exists but no matching team state
	if (!tmuxUnavailable) {
		for (const session of tmuxSessions) {
			if (!knownTeamSessions.has(session)) {
				issues.push({
					code: "orphan_tmux_session",
					message: `${session} exists without matching team state (possibly external project)`,
					severity: "warn",
				});
			}
		}
	}

	return dedupeIssues(issues);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return false;
  }
}

function dedupeIssues(issues: TeamDoctorIssue[]): TeamDoctorIssue[] {
	const seen = new Set<string>();
	const out: TeamDoctorIssue[] = [];
	for (const issue of issues) {
		const key = `${issue.code}:${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(issue);
	}
	return out;
}

function listTeamTmuxSessions(): Set<string> | null {
	const { result: res } = spawnPlatformCommandSync(
		"tmux",
		["list-sessions", "-F", "#{session_name}"],
		{ encoding: "utf-8" },
	);
	if (res.error) {
		// tmux binary unavailable or not executable.
		return null;
	}

	if (res.status !== 0) {
		const stderr = (res.stderr || "").toLowerCase();
		// tmux installed but no server/session is running.
		if (
			stderr.includes("no server running") ||
			stderr.includes("failed to connect to server")
		) {
			return new Set();
		}
		return null;
	}

	const sessions = (res.stdout || "")
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s.startsWith("omx-team-"));
	return new Set(sessions);
}

function checkCodexCli(): Check {
	const { result } = spawnPlatformCommandSync("codex", ["--version"], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
		if (kind === "missing") {
			return {
				name: "Codex CLI",
				status: "fail",
				message: "not found - install from https://github.com/openai/codex",
			};
		}
		if (kind === "blocked") {
			return {
				name: "Codex CLI",
				status: "fail",
				message: `found but could not be executed in this environment (${code || "blocked"})`,
			};
		}
		return {
			name: "Codex CLI",
			status: "fail",
			message: `probe failed - ${result.error.message}`,
		};
	}
	if (result.status === 0) {
		const version = (result.stdout || "").trim();
		return {
			name: "Codex CLI",
			status: "pass",
			message: `installed (${version})`,
		};
	}
	const stderr = (result.stderr || "").trim();
	return {
		name: "Codex CLI",
		status: "fail",
		message:
			stderr !== ""
				? `probe failed - ${stderr}`
				: `probe failed with exit ${result.status}`,
	};
}

function checkNodeVersion(): Check {
	const major = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
	if (isNaN(major)) {
		return {
			name: "Node.js",
			status: "fail",
			message: `v${process.versions.node} (unable to parse major version)`,
		};
	}
	if (major >= 20) {
		return {
			name: "Node.js",
			status: "pass",
			message: `v${process.versions.node}`,
		};
	}
	return {
		name: "Node.js",
		status: "fail",
		message: `v${process.versions.node} (need >= 20)`,
	};
}

export function checkExploreHarness(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Check {
	const packageRoot = getPackageRoot();
	const manifestPath = join(packageRoot, "crates", "omx-explore", "Cargo.toml");
	if (!existsSync(manifestPath)) {
		return {
			name: "Explore Harness",
			status: "warn",
			message:
				"Rust harness sources not found in this install (omx explore unavailable until packaged or OMX_EXPLORE_BIN is set)",
		};
	}

	const override = env[EXPLORE_BIN_ENV]?.trim();
	if (override) {
		const resolved = join(packageRoot, override);
		if (existsSync(override) || existsSync(resolved)) {
			return {
				name: "Explore Harness",
				status: "pass",
				message: `${EXPLORE_BIN_ENV} configured (${override})`,
			};
		}
		return {
			name: "Explore Harness",
			status: "warn",
			message: `OMX_EXPLORE_BIN is set but path was not found (${override})`,
		};
	}

	const unsupportedReason = getBuiltinExploreHarnessUnsupportedReason(
		platform,
		env,
	);
	if (unsupportedReason) {
		return {
			name: "Explore Harness",
			status: "warn",
			message: unsupportedReason,
		};
	}

	const packaged = resolvePackagedExploreHarnessCommand(packageRoot);
	if (packaged) {
		return {
			name: "Explore Harness",
			status: "pass",
			message: `ready (packaged native binary: ${packaged.command})`,
		};
	}

	const { result } = spawnPlatformCommandSync("cargo", ["--version"], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (result.error) {
		const kind = classifySpawnError(result.error as NodeJS.ErrnoException);
		if (kind === "missing") {
			return {
				name: "Explore Harness",
				status: "warn",
				message: `Rust harness sources are packaged, but no compatible packaged prebuilt or cargo was found (install Rust or set ${EXPLORE_BIN_ENV} for omx explore)`,
			};
		}
		return {
			name: "Explore Harness",
			status: "warn",
			message: `Rust harness sources are packaged, but cargo probe failed (${result.error.message})`,
		};
	}

	if (result.status === 0) {
		const version = (result.stdout || "").trim();
		return {
			name: "Explore Harness",
			status: "pass",
			message: `ready (${version || "cargo available"})`,
		};
	}

	return {
		name: "Explore Harness",
		status: "warn",
		message: `Rust harness sources are packaged, but cargo probe failed with exit ${result.status} (install Rust or set ${EXPLORE_BIN_ENV})`,
	};
}

function checkDirectory(name: string, path: string): Check {
	if (existsSync(path)) {
		return { name, status: "pass", message: path };
	}
	return { name, status: "warn", message: `${path} (not created yet)` };
}

function validateToml(content: string): string | null {
	try {
		parseToml(content);
		return null;
	} catch (error) {
		if (error instanceof Error) {
			return error.message;
		}
		return "unknown TOML parse error";
	}
}

async function checkConfig(configPath: string): Promise<Check> {
	if (!existsSync(configPath)) {
		return { name: "Config", status: "warn", message: "config.toml not found" };
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const tomlError = validateToml(content);

		if (tomlError) {
			const hint =
				tomlError.includes("Can't redefine existing key") ||
				tomlError.includes("duplicate") ||
				tomlError.includes("[tui]")
					? "possible duplicate TOML table such as [tui]"
					: "invalid TOML syntax";

			return {
				name: "Config",
				status: "fail",
				message: `invalid config.toml (${hint})`,
			};
		}

		if (hasLegacyOmxTeamRunTable(content)) {
			return {
				name: "Config",
				status: "warn",
				message:
					'retired [mcp_servers.omx_team_run] table still present; run "omx setup --force" to repair the config',
			};
		}

		const hasOmx = content.includes("omx_") || content.includes("oh-my-codex");
		if (hasOmx) {
			return {
				name: "Config",
				status: "pass",
				message: "config.toml has OMX entries",
			};
		}

		return {
			name: "Config",
			status: "warn",
			message:
				'config.toml exists but no OMX entries yet (expected before first setup; run "omx setup --force" once)',
		};
	} catch {
		return {
			name: "Config",
			status: "fail",
			message: "cannot read config.toml",
		};
	}
}

function formatContextRecommendationWarning(
	configuredValues: string[],
	recommendedContextWindow: number,
	recommendedAutoCompactLimit: number,
): string {
	return `${configuredValues.join(
		", ",
	)} exceeds the OMX setup recommendation for gpt-5.5 (${recommendedContextWindow} / ${recommendedAutoCompactLimit}); doctor does not rewrite user config, so lower these values or verify your active Codex runtime/provider behavior if this customization is intentional`;
}

async function checkModelContextRecommendation(
	configPath: string,
): Promise<Check | null> {
	if (!existsSync(configPath)) return null;

	try {
		const content = await readFile(configPath, "utf-8");
		const parsed = parseToml(content) as Record<string, unknown>;
		const model = parsed.model;
		if (typeof model !== "string") return null;

		const recommendation = getModelContextRecommendation(model);
		if (!recommendation) return null;

		const configuredValues: string[] = [];
		const contextWindow = parsed.model_context_window;
		if (
			typeof contextWindow === "number" &&
			contextWindow > recommendation.modelContextWindow
		) {
			configuredValues.push(`model_context_window=${contextWindow}`);
		}

		const autoCompactLimit = parsed.model_auto_compact_token_limit;
		if (
			typeof autoCompactLimit === "number" &&
			autoCompactLimit > recommendation.modelAutoCompactTokenLimit
		) {
			configuredValues.push(
				`model_auto_compact_token_limit=${autoCompactLimit}`,
			);
		}

		if (configuredValues.length === 0) return null;

		return {
			name: "Model context recommendation",
			status: "warn",
			message: formatContextRecommendationWarning(
				configuredValues,
				recommendation.modelContextWindow,
				recommendation.modelAutoCompactTokenLimit,
			),
		};
	} catch {
		return null;
	}
}

async function checkExploreRouting(configPath: string): Promise<Check> {
	const envValue = process.env[OMX_EXPLORE_CMD_ENV];
	if (
		typeof envValue === "string" &&
		!isExploreCommandRoutingEnabled(process.env)
	) {
		return {
			name: "Explore routing",
			status: "warn",
			message:
				"disabled by environment override; enable with USE_OMX_EXPLORE_CMD=1 (or remove the explicit opt-out)",
		};
	}

	if (!existsSync(configPath)) {
		return {
			name: "Explore routing",
			status: "pass",
			message: "enabled by default (config.toml not found yet)",
		};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const parsed = parseToml(content) as {
			env?: Record<string, unknown>;
			shell_environment_policy?: { set?: Record<string, unknown> };
		};
		const configuredValue =
			parsed?.shell_environment_policy?.set?.USE_OMX_EXPLORE_CMD ??
			parsed?.env?.USE_OMX_EXPLORE_CMD;

		if (
			typeof configuredValue === "string" &&
			!isExploreCommandRoutingEnabled({
				USE_OMX_EXPLORE_CMD: configuredValue,
			})
		) {
			return {
				name: "Explore routing",
				status: "warn",
				message:
					'disabled in config.toml; set USE_OMX_EXPLORE_CMD = "1" under [shell_environment_policy.set] to restore default explore-first routing',
			};
		}

		return {
			name: "Explore routing",
			status: "pass",
			message: "enabled by default",
		};
	} catch {
		return {
			name: "Explore routing",
			status: "fail",
			message: "cannot read config.toml for explore routing check",
		};
	}
}

async function checkLoreCommitGuard(configPath: string): Promise<Check> {
	const envValue = process.env[OMX_LORE_COMMIT_GUARD_ENV];
	if (
		typeof envValue === "string" &&
		!isLoreCommitGuardEnabled(process.env)
	) {
		return {
			name: "Lore commit guard",
			status: "warn",
			message:
				"disabled by environment override; enable with OMX_LORE_COMMIT_GUARD=1 (or remove the explicit opt-out)",
		};
	}

	if (!existsSync(configPath)) {
		return {
			name: "Lore commit guard",
			status: "pass",
			message: "enabled by default (config.toml not found yet)",
		};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const parsed = parseToml(content) as {
			env?: Record<string, unknown>;
			shell_environment_policy?: { set?: Record<string, unknown> };
		};
		const configuredValue =
			parsed?.shell_environment_policy?.set?.[OMX_LORE_COMMIT_GUARD_ENV] ??
			parsed?.env?.[OMX_LORE_COMMIT_GUARD_ENV];

		if (
			typeof configuredValue === "string" &&
			!isLoreCommitGuardEnabled({
				[OMX_LORE_COMMIT_GUARD_ENV]: configuredValue,
			})
		) {
			return {
				name: "Lore commit guard",
				status: "warn",
				message:
					'disabled in config.toml; set OMX_LORE_COMMIT_GUARD = "1" under [shell_environment_policy.set] to restore default Lore commit enforcement',
			};
		}

		return {
			name: "Lore commit guard",
			status: "pass",
			message: "enabled by default",
		};
	} catch {
		return {
			name: "Lore commit guard",
			status: "fail",
			message: "cannot read config.toml for Lore commit guard check",
		};
	}
}

async function checkNativeHooks(
	hooksPath: string,
	configPath: string,
): Promise<Check> {
	if (!existsSync(hooksPath)) {
		if (existsSync(configPath)) {
			try {
				const configContent = await readFile(configPath, "utf-8");
				const hasOmx =
					configContent.includes("omx_") ||
					configContent.includes("oh-my-codex");
				if (hasOmx) {
					return {
						name: "Native hooks",
						status: "warn",
						message:
							'hooks.json not found even though config.toml has OMX entries; run "omx setup --force" to restore native hook coverage',
					};
				}
			} catch {
				// fall through to the neutral first-setup path when config cannot be read here;
				// the dedicated config check will report read failures separately.
			}
		}

		return {
			name: "Native hooks",
			status: "pass",
			message: "hooks.json not found yet (expected before first setup)",
		};
	}

	try {
		const content = await readFile(hooksPath, "utf-8");
		const missingEvents = getMissingManagedCodexHookEvents(content);
		if (missingEvents === null) {
			return {
				name: "Native hooks",
				status: "fail",
				message:
					'invalid hooks.json; Codex may skip OMX hook coverage until "omx setup --force" repairs it',
			};
		}

		if (missingEvents.length > 0) {
			return {
				name: "Native hooks",
				status: "warn",
				message: `hooks.json is missing OMX-managed coverage for ${missingEvents.join(", ")}; run "omx setup --force" to restore native hooks`,
			};
		}

		return {
			name: "Native hooks",
			status: "pass",
			message:
				"hooks.json includes OMX-managed coverage for all native hook events",
		};
	} catch {
		return {
			name: "Native hooks",
			status: "fail",
			message: "cannot read hooks.json",
		};
	}
}

async function checkPrompts(
	dir: string,
	installMode?: SetupInstallMode,
): Promise<Check> {
	if (installMode === "plugin") {
		return {
			name: "Prompts",
			status: "pass",
			message:
				"plugin mode intentionally omits setup-owned prompts; Codex plugin discovery supplies workflow surfaces",
		};
	}

	const expectations = getCatalogExpectations();
	if (!existsSync(dir)) {
		return {
			name: "Prompts",
			status: "warn",
			message: "prompts directory not found",
		};
	}
	try {
		const files = await readdir(dir);
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		if (mdFiles.length >= expectations.promptMin) {
			return {
				name: "Prompts",
				status: "pass",
				message: `${mdFiles.length} agent prompts installed`,
			};
		}
		return {
			name: "Prompts",
			status: "warn",
			message: `${mdFiles.length} prompts (expected >= ${expectations.promptMin})`,
		};
	} catch {
		return {
			name: "Prompts",
			status: "fail",
			message: "cannot read prompts directory",
		};
	}
}

async function checkLegacySkillRootOverlap(): Promise<Check> {
	const overlap = await detectLegacySkillRootOverlap();
	if (!overlap.legacyExists) {
		return {
			name: "Legacy skill roots",
			status: "pass",
			message: "no ~/.agents/skills overlap detected",
		};
	}

	if (overlap.sameResolvedTarget) {
		return {
			name: "Legacy skill roots",
			status: "pass",
			message: `~/.agents/skills links to canonical ${overlap.canonicalDir}; treating both paths as one shared skill root`,
		};
	}

	if (overlap.overlappingSkillNames.length === 0) {
		return {
			name: "Legacy skill roots",
			status: "warn",
			message: `legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}; remove or archive it if Codex shows duplicate entries`,
		};
	}

	const mismatchMessage =
		overlap.mismatchedSkillNames.length > 0
			? `; ${overlap.mismatchedSkillNames.length} differ in SKILL.md content`
			: "";
	return {
		name: "Legacy skill roots",
		status: "warn",
		message: `${overlap.overlappingSkillNames.length} overlapping skill names between ${overlap.canonicalDir} and ${overlap.legacyDir}${mismatchMessage}; Codex Enable/Disable Skills may show duplicates until ~/.agents/skills is cleaned up`,
	};
}

function getParsedMarketplaceRegistration(
	content: string,
): { source_type?: unknown; source?: unknown } | null {
	const parsed = parseToml(content) as {
		marketplaces?: Record<string, { source_type?: unknown; source?: unknown }>;
	};
	return parsed.marketplaces?.[OMX_LOCAL_MARKETPLACE_NAME] ?? null;
}

async function checkPluginMarketplaceRegistration(
	configPath: string,
): Promise<Check> {
	const packagedMarketplace = await resolvePackagedOmxMarketplace(
		getPackageRoot(),
	);
	if (!packagedMarketplace) {
		return {
			name: "Skills",
			status: "warn",
			message: `plugin mode selected, but packaged ${OMX_LOCAL_MARKETPLACE_NAME} metadata was not found; reinstall oh-my-codex or run from a package that includes plugins/`,
		};
	}

	if (!existsSync(configPath)) {
		return {
			name: "Skills",
			status: "warn",
			message: `plugin mode selected, but ${OMX_LOCAL_MARKETPLACE_NAME} is not registered because config.toml is missing; run "omx setup --plugin --force"`,
		};
	}

	try {
		const content = await readFile(configPath, "utf-8");
		const registration = getParsedMarketplaceRegistration(content);
		if (!registration) {
			return {
				name: "Skills",
				status: "warn",
				message: `plugin mode selected, but Codex marketplace ${OMX_LOCAL_MARKETPLACE_NAME} is not registered; run "omx setup --plugin --force"`,
			};
		}
		if (registration.source_type !== "local") {
			return {
				name: "Skills",
				status: "warn",
				message: `Codex marketplace ${OMX_LOCAL_MARKETPLACE_NAME} has source_type=${String(registration.source_type)} (expected local); run "omx setup --plugin --force"`,
			};
		}
		if (registration.source !== getPackageRoot()) {
			return {
				name: "Skills",
				status: "warn",
				message: `Codex marketplace ${OMX_LOCAL_MARKETPLACE_NAME} points to ${String(registration.source)} (expected ${getPackageRoot()}); run "omx setup --plugin --force"`,
			};
		}
		return {
			name: "Skills",
			status: "pass",
			message: `plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} registered; OMX skills are supplied by ${packagedMarketplace.pluginRoot}`,
		};
	} catch {
		return {
			name: "Skills",
			status: "fail",
			message:
				"cannot read or parse config.toml for plugin marketplace registration",
		};
	}
}

async function checkSkills(
	paths: DoctorPaths,
	installMode?: SetupInstallMode,
): Promise<Check> {
	if (installMode === "plugin") {
		return checkPluginMarketplaceRegistration(paths.configPath);
	}

	const expectations = getCatalogExpectations();
	if (!existsSync(paths.skillsDir)) {
		return {
			name: "Skills",
			status: "warn",
			message: "skills directory not found",
		};
	}
	try {
		const entries = await readdir(paths.skillsDir, { withFileTypes: true });
		const skillDirs = entries.filter((e) => e.isDirectory());
		if (skillDirs.length >= expectations.skillMin) {
			return {
				name: "Skills",
				status: "pass",
				message: `${skillDirs.length} skills installed`,
			};
		}
		return {
			name: "Skills",
			status: "warn",
			message: `${skillDirs.length} skills (expected >= ${expectations.skillMin})`,
		};
	} catch {
		return {
			name: "Skills",
			status: "fail",
			message: "cannot read skills directory",
		};
	}
}

function checkAgentsMd(
	scope: DoctorSetupScope,
	codexHomeDir: string,
	installMode?: SetupInstallMode,
): Check {
	if (scope === "user") {
		const userAgentsMd = join(codexHomeDir, "AGENTS.md");
		if (existsSync(userAgentsMd)) {
			return {
				name: "AGENTS.md",
				status: "pass",
				message: `found in ${userAgentsMd}`,
			};
		}
		if (installMode === "plugin") {
			return {
				name: "AGENTS.md",
				status: "pass",
				message: `optional plugin-mode AGENTS.md defaults not installed in ${userAgentsMd}`,
			};
		}
		return {
			name: "AGENTS.md",
			status: "warn",
			message: `not found in ${userAgentsMd} (run omx setup --scope user)`,
		};
	}

	const projectAgentsMd = join(process.cwd(), "AGENTS.md");
	if (existsSync(projectAgentsMd)) {
		return {
			name: "AGENTS.md",
			status: "pass",
			message: "found in project root",
		};
	}
	if (installMode === "plugin") {
		return {
			name: "AGENTS.md",
			status: "pass",
			message:
				"optional plugin-mode AGENTS.md defaults not installed in project root",
		};
	}
	return {
		name: "AGENTS.md",
		status: "warn",
		message:
			"not found in project root (run omx agents-init . or omx setup --scope project)",
	};
}

function checkPromptTriage(): Check {
	try {
		const config = readTriageConfig();

		if (config.status === "disabled") {
			return {
				name: "Prompt triage",
				status: "warn",
				message: `disabled via ${config.path}`,
			};
		}

		if (config.status === "invalid") {
			return {
				name: "Prompt triage",
				status: "warn",
				message: `config file malformed at ${config.path} — fails closed to disabled`,
			};
		}

		// Smoke test: verify the classifier is callable and returns the expected shape.
		const decision = triagePrompt("hello");
		const validLanes = new Set(["HEAVY", "LIGHT", "PASS"]);
		if (
			!decision ||
			typeof decision !== "object" ||
			!validLanes.has(decision.lane)
		) {
			return {
				name: "Prompt triage",
				status: "fail",
				message: `classifier returned unexpected shape (lane: ${String(decision?.lane)})`,
			};
		}

		const sourceLabel =
			config.status === "defaulted" ? "enabled (default)" : "enabled";
		return {
			name: "Prompt triage",
			status: "pass",
			message: `config: ${sourceLabel}`,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			name: "Prompt triage",
			status: "fail",
			message: `module load error — ${msg}`,
		};
	}
}

async function checkMcpServers(
	configPath: string,
	installMode?: SetupInstallMode,
): Promise<Check> {
	if (!existsSync(configPath)) {
		if (installMode === "plugin") {
			return {
				name: "MCP Servers",
				status: "warn",
				message:
					'plugin mode selected, but config.toml is missing; run "omx setup --plugin --force" to register plugin discovery',
			};
		}
		return {
			name: "MCP Servers",
			status: "warn",
			message: "config.toml not found",
		};
	}
	try {
		const content = await readFile(configPath, "utf-8");
		const mcpCount = (content.match(/\[mcp_servers\./g) || []).length;
		if (hasLegacyOmxTeamRunTable(content)) {
			return {
				name: "MCP Servers",
				status: "warn",
				message: `${mcpCount} servers configured, but retired [mcp_servers.omx_team_run] is not supported; run "omx setup --force" to repair the config`,
			};
		}
		if (installMode === "plugin") {
			return {
				name: "MCP Servers",
				status: "pass",
				message:
					"plugin mode uses plugin-scoped MCP metadata; setup-owned OMX MCP tables are intentionally omitted",
			};
		}
		if (mcpCount > 0) {
			const hasOmx = OMX_FIRST_PARTY_MCP_SERVER_NAMES.some((name) =>
				content.includes(name),
			);
			if (hasOmx) {
				return {
					name: "MCP Servers",
					status: "pass",
					message: `${mcpCount} servers configured (OMX present)`,
				};
			}
			return {
				name: "MCP Servers",
				status: "warn",
				message: `${mcpCount} servers but no OMX servers yet (expected before first setup; run "omx setup --force" once)`,
			};
		}
		return {
			name: "MCP Servers",
			status: "warn",
			message: "no MCP servers configured",
		};
	} catch {
		return {
			name: "MCP Servers",
			status: "fail",
			message: "cannot read config.toml",
		};
	}
}
