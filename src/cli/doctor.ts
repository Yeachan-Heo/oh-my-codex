/**
 * omx doctor - Validate oh-my-codex installation
 */

import { recoverNativeHookClaimJournal } from "./native-hook-claim-journal.js";
import { constants, existsSync, readFileSync, type Stats } from "fs";
import { access, chown, lstat, mkdtemp, readdir, readFile, rmdir, rm } from "fs/promises";
import { spawnSync } from "child_process";
import { basename, dirname, join, relative } from "path";
import { tmpdir } from "os";
import {
	codexHome,
	codexConfigPath,
	codexPromptsDir,
	userSkillsDir,
	projectSkillsDir,
	omxStateDir,
	detectLegacySkillRootOverlap,
	codexAgentsDir,
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
	analyzeLegacyMultiAgentConfig,
	hasExactOmxSeededBehavioralDefaultsPair,
	hasLegacyOmxTeamRunTable,
} from "../config/generator.js";
import {
	MANAGED_HOOK_EVENTS,
	buildManagedCodexNativeHookCommand,
	buildManagedCodexNativeHookWindowsShimContent,
	classifyManagedCodexNativeHookWindowsShimOwnership,
	discoverCodexHookConfigPaths,
	isManagedCodexHookCommand,
	parseManagedCodexNativeHookWindowsShimCommand,
	planManagedCodexHooksRemoval,
	resolveWindowsPowerShellPath,
	type ManagedCodexHooksPlan,
	validateCodexHooksConfigStrict,
} from "../config/codex-hooks.js";
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
	type SetupMcpMode,
} from "./setup-preferences.js";
import {
	OMX_LOCAL_MARKETPLACE_NAME,
	OMX_LOCAL_PLUGIN_CONFIG_KEY,
	discoverOmxPluginCacheDirs,
	expectedPackagedOmxSkillNames,
	packagedOmxPluginVersion,
	pluginHookCacheMatchesPackaged,
	readOmxPluginCacheState,
	resolvePackagedOmxMarketplace,
} from "./plugin-marketplace.js";
import { hasOmxAgentsContract } from "../utils/agents-md.js";
import {
	OMX_DEFAULT_SPARK_MODEL_ENV,
	OMX_SPARK_MODEL_ENV,
	getAgentModelOverride,
	getCodexConfigRootModelProvider,
	getConfiguredTeamLowComplexityModel,
	getEnvConfiguredSparkDefaultModel,
	getMainDefaultModel,
	getSparkDefaultModel,
	getStandardDefaultModel,
} from "../config/models.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { getInstallableNativeAgentNames } from "../agents/policy.js";
import { readCatalogManifest } from "../catalog/reader.js";

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

interface RepoArtifactIssue {
	path: string;
	type: "ownership" | "writability";
	reason: "root-owned" | "owner-mismatch" | "not-writable";
	uid?: number;
	gid?: number;
}

interface RepoArtifactStats {
	uid?: number;
	gid?: number;
	isSymbolicLink(): boolean;
	isDirectory(): boolean;
}

interface RepoArtifactScanOptions {
	currentUid?: number;
	currentGid?: number;
	maxExamples?: number;
	statPath?: (path: string) => Promise<RepoArtifactStats>;
	readDir?: (path: string) => Promise<string[]>;
	accessPath?: (path: string, mode: number) => Promise<void>;
}

interface RepoArtifactRepairOptions extends RepoArtifactScanOptions {
	chownPath?: (path: string, uid: number, gid: number) => Promise<void>;
}

const REPO_ARTIFACT_DIRS = [".omx", ".beads"] as const;


interface NativeHookDistSmokeOptions {
	packageRoot?: string;
	nodePath?: string;
	runner?: typeof spawnSync;
}

type DoctorSetupScope = "user" | "project";

interface DoctorScopeResolution {
	scope: DoctorSetupScope;
	source: "persisted" | "config" | "default";
	installMode?: SetupInstallMode;
	mcpMode?: SetupMcpMode;
}

interface DoctorPaths {
	codexHomeDir: string;
	configPath: string;
	hooksPath: string;
	promptsDir: string;
	skillsDir: string;
	agentsDir: string;
	stateDir: string;
}

async function resolveDoctorScope(cwd: string): Promise<DoctorScopeResolution> {
	const persisted = await readPersistedSetupPreferences(cwd);
	if (persisted?.scope) {
		const inferred = await inferPluginInstallModeFromConfigForScope(cwd, persisted.scope);
		return {
			scope: persisted.scope,
			source: "persisted",
			installMode: persisted.installMode ?? inferred?.installMode,
			mcpMode: persisted.mcpMode ?? inferred?.mcpMode ?? "none",
		};
	}

	const inferredUser = await inferPluginInstallModeFromConfigForScope(cwd, "user");
	if (inferredUser) return inferredUser;

	const inferredProject = await inferPluginInstallModeFromConfigForScope(cwd, "project");
	if (inferredProject) return inferredProject;

	return { scope: "user", source: "default" };
}

async function inferPluginInstallModeFromConfigForScope(
	cwd: string,
	scope: DoctorSetupScope,
): Promise<DoctorScopeResolution | null> {
	const configPath =
		scope === "project" ? join(cwd, ".codex", "config.toml") : codexConfigPath();
	if (!existsSync(configPath)) return null;

	try {
		const configContent = await readFile(configPath, "utf-8");
		if (!configEnablesPluginScopedHooks(configContent)) return null;

		const { marketplace, plugin } = getParsedPluginMarketplaceConfig(configContent);
		if (!marketplace || marketplace.source_type !== "local") return null;
		if (!(await isTrustedOmxPluginMarketplaceSource(marketplace.source))) return null;
		if (plugin?.enabled !== true) return null;

		return {
			scope,
			source: "config",
			installMode: "plugin",
			mcpMode: inferPluginMcpModeFromConfig(configContent),
		};
	} catch {
		return null;
	}
}

async function isTrustedOmxPluginMarketplaceSource(source: unknown): Promise<boolean> {
	if (source === getPackageRoot()) return true;
	if (typeof source !== "string" || source.length === 0) return false;
	try {
		const packageJson = JSON.parse(
			await readFile(join(source, "package.json"), "utf-8"),
		) as { name?: unknown };
		return packageJson.name === "oh-my-codex";
	} catch {
		return false;
	}
}

function inferPluginMcpModeFromConfig(configContent: string): SetupMcpMode {
	const states = OMX_FIRST_PARTY_MCP_SERVER_NAMES.map((serverName) =>
		pluginMcpServerEnabled(configContent, serverName),
	);
	return states.length > 0 && states.every((state) => state === true)
		? "compat"
		: "none";
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
			agentsDir: codexAgentsDir(codexHomeDir),
			stateDir: omxStateDir(cwd),
		};
	}

	return {
		codexHomeDir: codexHome(),
		configPath: codexConfigPath(),
		hooksPath: join(codexHome(), "hooks.json"),
		promptsDir: codexPromptsDir(),
		skillsDir: userSkillsDir(),
		agentsDir: codexAgentsDir(),
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
	await recoverNativeHookClaimJournal(paths.codexHomeDir);
	const scopeSourceMessage =
		scopeResolution.source === "persisted"
			? " (from .omx/setup-scope.json)"
			: scopeResolution.source === "config"
				? " (inferred from Codex plugin config)"
			: "";
	if (options.force) {
		if (options.dryRun) {
			const check = await checkRepoArtifactOwnership(cwd);
			if (check.status !== "pass") {
				console.log(`Dry run: ${check.message}`);
				console.log();
			}
		} else {
			const repair = await repairRepoArtifactOwnership(cwd);
			if (repair.repaired > 0 || repair.skipped.length > 0) {
				console.log(
					`Repo artifact ownership repair: ${repair.repaired} path(s) repaired${
						repair.skipped.length > 0
							? `, ${repair.skipped.length} skipped (${repair.skipped.join("; ")})`
							: ""
					}`,
				);
				console.log();
			}
		}
	}

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
	if (scopeResolution.mcpMode) {
		console.log(
			`Resolved setup MCP mode: ${scopeResolution.mcpMode}${scopeSourceMessage}`,
		);
	}
	console.log();

	const checks: Check[] = [];

	// Check 1: Codex CLI installed
	checks.push(checkCodexCli());

	// Check 2: Node.js version
	checks.push(checkNodeVersion());

	// Check 2.5: Explore harness readiness
	const exploreRoutingState = await resolveExploreRoutingState(paths.configPath);
	checks.push(
		checkExploreHarness(process.platform, process.env, {
			exploreRoutingEnabled: exploreRoutingState.enabled,
		}),
	);

	// Check 3: Codex home directory
	checks.push(checkDirectory("Codex home", paths.codexHomeDir));

	// Check 4: Config file
	const configCheck = await checkConfig(paths.configPath);
	checks.push(configCheck);
	const multiAgentCompatibilityCheck = await checkLegacyMultiAgentCompatibility(
		paths.configPath,
		scopeResolution.scope,
	);
	if (multiAgentCompatibilityCheck) checks.push(multiAgentCompatibilityCheck);

	// Check 4.1: unchanged OMX-seeded context defaults
	if (configCheck.status !== "fail") {
		const seededContextDefaultsCheck = await checkSeededContextDefaults(
			paths.configPath,
		);
		if (seededContextDefaultsCheck) checks.push(seededContextDefaultsCheck);
	}

	// Check 4.25: Native hooks coverage
	const nativeHooksCheck = await checkNativeHooks(paths.hooksPath, paths.configPath, {
		codexHomeDir: paths.codexHomeDir,
		installMode: scopeResolution.installMode,
	});
	checks.push(nativeHooksCheck);
	checks.push(await checkNativeHookDistSmoke());
	if (options.verbose) {
		const postCompactRuntimeCheck = await checkNativePostCompactHookRuntime(
			paths.hooksPath,
			cwd,
			paths.codexHomeDir,
			{ nativeHooksCheck },
		);
		if (postCompactRuntimeCheck) checks.push(postCompactRuntimeCheck);
	}
	const runtimeMirrorCheck = await checkNativeHookRuntimeMirrors(cwd, paths.hooksPath);
	if (runtimeMirrorCheck) checks.push(runtimeMirrorCheck);

	// Check 4.5: Explore routing default
	checks.push(checkExploreRoutingFromState(exploreRoutingState));

	// Check 4.6: Lore commit guard default
	checks.push(await checkLoreCommitGuard(paths.configPath));

	// Check 4.7: External process guards
	const externalProcessGuardCheck = await checkExternalCodexProcessGuards();
	if (externalProcessGuardCheck) checks.push(externalProcessGuardCheck);

	// Check 5: Prompts installed
	checks.push(
		await checkPrompts(paths.promptsDir, scopeResolution.installMode),
	);

	// Check 6: Skills installed
	checks.push(await checkSkills(paths, scopeResolution.installMode));
	if (scopeResolution.installMode === "plugin") {
		checks.push(await checkPluginVersionDiagnostics(paths.codexHomeDir));
	}

	// Check 6.25: Native reviewer roles required by RALPLAN/Autopilot
	const nativeReviewerRolesCheck = checkNativeReviewerRoles(
		paths,
		scopeResolution.installMode,
	);
	if (nativeReviewerRolesCheck) checks.push(nativeReviewerRolesCheck);

	// Check 6.4: Spark/model lane routing (issue #2757)
	checks.push(checkSparkRouting(paths));

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
	checks.push(await checkRepoArtifactOwnership(cwd));

	// Check 9: MCP servers configured
	checks.push(
		await checkMcpServers(
			paths.configPath,
			scopeResolution.installMode,
			scopeResolution.mcpMode,
		),
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
		console.log('\nReview failed checks above. Follow the check-specific recovery guidance; inspect invalid or ambiguous hook documents manually because doctor will not modify them.');

	} else if (warnCount > 0) {
		console.log(
			'\nReview warnings above. Follow the check-specific recovery guidance; for AGENTS.md preservation prefer "omx setup --merge-agents".',
		);
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
	options: { exploreRoutingEnabled?: boolean } = {},
): Check {
	const override = env[EXPLORE_BIN_ENV]?.trim();
	const exploreRoutingEnabled = options.exploreRoutingEnabled ?? isExploreCommandRoutingEnabled(env);
	if (!override && !exploreRoutingEnabled) {
		return {
			name: "Explore Harness",
			status: "pass",
			message:
				"skipped: omx explore is hard-deprecated and explore routing is disabled by default; use omx sparkshell for shell-native read-only evidence",
		};
	}

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

function currentProcessUid(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function currentProcessGid(): number | undefined {
	return typeof process.getgid === "function" ? process.getgid() : undefined;
}

function remediationCommand(repoRoot: string): string {
	return `sudo chown -R $(id -u):$(id -g) ${JSON.stringify(repoRoot)}`;
}

function formatArtifactPath(repoRoot: string, path: string): string {
	const rel = relative(repoRoot, path);
	return rel === "" ? "." : rel;
}

function formatArtifactIssue(repoRoot: string, issue: RepoArtifactIssue): string {
	const owner =
		typeof issue.uid === "number" && typeof issue.gid === "number"
			? ` uid=${issue.uid} gid=${issue.gid}`
			: "";
	return `${formatArtifactPath(repoRoot, issue.path)} (${issue.reason}${owner})`;
}

function shouldReportOwnerMismatch(
	uid: number | undefined,
	currentUid: number | undefined,
): boolean {
	if (currentUid === 0) return false;
	if (typeof uid !== "number") return false;
	if (uid === 0) return true;
	return typeof currentUid === "number" && uid !== currentUid;
}

function isOwnershipIssue(issue: RepoArtifactIssue): boolean {
	return issue.type === "ownership";
}

async function collectRepoArtifactOwnershipIssues(
	repoRoot: string,
	options: RepoArtifactScanOptions = {},
): Promise<RepoArtifactIssue[]> {
	if (process.platform === "win32") return [];
	const currentUid = options.currentUid ?? currentProcessUid();
	const maxExamples = options.maxExamples ?? 20;
	const statPath = options.statPath ?? lstat;
	const readDir = options.readDir ?? readdir;
	const accessPath = options.accessPath ?? access;
	const issues: RepoArtifactIssue[] = [];
	const visited = new Set<string>();

	async function visit(path: string): Promise<void> {
		if (issues.length >= maxExamples) return;
		let info: RepoArtifactStats;
		try {
			info = await statPath(path);
		} catch {
			return;
		}
		if (info.isSymbolicLink()) return;

		const uid = typeof info.uid === "number" ? info.uid : undefined;
		const gid = typeof info.gid === "number" ? info.gid : undefined;
		let reason: RepoArtifactIssue["reason"] | null = null;
		if (uid === 0) {
			if (currentUid !== 0) reason = "root-owned";
		} else if (shouldReportOwnerMismatch(uid, currentUid)) reason = "owner-mismatch";
		else {
			try {
				await accessPath(path, constants.W_OK);
			} catch {
				reason = "not-writable";
			}
		}
		if (reason) {
			issues.push({
				path,
				reason,
				type: reason === "not-writable" ? "writability" : "ownership",
				uid,
				gid,
			});
		}
		if (issues.length >= maxExamples || !info.isDirectory()) return;
		if (visited.has(path)) return;
		visited.add(path);

		let entries: string[];
		try {
			entries = await readDir(path);
		} catch {
			return;
		}
		for (const entry of entries) {
			await visit(join(path, entry));
			if (issues.length >= maxExamples) return;
		}
	}

	for (const dir of REPO_ARTIFACT_DIRS) {
		const root = join(repoRoot, dir);
		if (existsSync(root)) await visit(root);
	}
	return issues;
}

export async function checkRepoArtifactOwnership(
	repoRoot: string,
	options: RepoArtifactScanOptions = {},
): Promise<Check> {
	const issues = await collectRepoArtifactOwnershipIssues(repoRoot, options);
	if (issues.length === 0) {
		return {
			name: "Repo artifact ownership",
			status: "pass",
			message: "repo-local .omx/.beads artifacts are writable by the current user",
		};
	}

	const examples = issues
		.slice(0, options.maxExamples ?? 5)
		.map((issue) => formatArtifactIssue(repoRoot, issue))
		.join("; ");
	const repair = remediationCommand(repoRoot);
	return {
		name: "Repo artifact ownership",
		status: "warn",
		message: `${issues.length} root-owned, owner-mismatched, or non-writable repo artifact(s): ${examples}. Safe remediation: ${repair}. Automatic repair is only run by \"omx doctor --force\" when the repo root is owned by the current user.`,
	};
}

export async function repairRepoArtifactOwnership(
	repoRoot: string,
	options: RepoArtifactRepairOptions = {},
): Promise<{ repaired: number; skipped: string[] }> {
	if (process.platform === "win32") return { repaired: 0, skipped: [] };
	const currentUid = options.currentUid ?? currentProcessUid();
	const currentGid = options.currentGid ?? currentProcessGid();
	if (typeof currentUid !== "number" || typeof currentGid !== "number") {
		return { repaired: 0, skipped: ["current uid/gid unavailable"] };
	}
	const statPath = options.statPath ?? lstat;
	const repoInfo = await statPath(repoRoot);
	if (repoInfo.uid !== currentUid) {
		return { repaired: 0, skipped: ["repo root is not owned by the current user"] };
	}
	const issues = await collectRepoArtifactOwnershipIssues(repoRoot, {
		...options,
		currentUid,
		currentGid,
		maxExamples: Number.MAX_SAFE_INTEGER,
		statPath,
	});
	const ownershipIssues = issues.filter(isOwnershipIssue);
	const writabilityIssues = issues.filter((issue) => !isOwnershipIssue(issue));
	const chownPath = options.chownPath ?? chown;
	let repaired = 0;
	const skipped: string[] = [];
	for (const issue of writabilityIssues) {
		skipped.push(`${formatArtifactPath(repoRoot, issue.path)}: not writable by current user`);
	}
	for (const issue of ownershipIssues) {
		try {
			await chownPath(issue.path, currentUid, currentGid);
			repaired++;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			skipped.push(`${formatArtifactPath(repoRoot, issue.path)}: ${message}`);
		}
	}
	return { repaired, skipped };
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

export async function checkLegacyMultiAgentCompatibility(
	configPath: string,
	scope: DoctorSetupScope,
): Promise<Check | null> {
	if (!existsSync(configPath)) return null;

	try {
		const content = await readFile(configPath, "utf-8");
		if (validateToml(content)) return null;

		const affected = Object.values(analyzeLegacyMultiAgentConfig(content).assessments).filter(
			(assessment) => assessment.state !== "absent",
		);
		if (affected.length === 0) return null;

		const details = affected
			.map(
				({ key, state, reasonCode }) =>
					`${key} (${state}; ${reasonCode})`,
			)
			.join(", ");
		return {
			name: "GPT-5.6 multi-agent compatibility",
			status: "warn",
			message:
				`${scope} scope config at ${configPath}: ${details}. ` +
				"OMX preserves these settings because historical ownership cannot be proven. " +
				`Back up ${configPath}, remove only keys you confirm OMX authored, rerun omx setup --scope ${scope}, then omx doctor. ` +
				"Setup does not auto-delete them.",
		};
	} catch {
		return null;
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

async function checkSeededContextDefaults(
	configPath: string,
): Promise<Check | null> {
	if (!existsSync(configPath)) return null;

	try {
		const content = await readFile(configPath, "utf-8");
		if (!hasExactOmxSeededBehavioralDefaultsPair(content)) return null;

		return {
			name: "Legacy OMX context defaults",
			status: "warn",
			message:
				"config.toml contains unchanged OMX-seeded context defaults; rerun \"omx setup\" to migrate them. Doctor did not rewrite config.",
		};
	} catch {
		return null;
	}
}

type ExploreRoutingState =
	| { source: "env"; enabled: boolean }
	| { source: "config"; enabled: boolean }
	| { source: "default"; enabled: false; reason: "missing-config" | "unset" }
	| { source: "unreadable"; enabled: false };

async function resolveExploreRoutingState(
	configPath: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ExploreRoutingState> {
	const envValue = env[OMX_EXPLORE_CMD_ENV];
	if (typeof envValue === "string") {
		return { source: "env", enabled: isExploreCommandRoutingEnabled(env) };
	}

	if (!existsSync(configPath)) {
		return { source: "default", enabled: false, reason: "missing-config" };
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

		if (typeof configuredValue === "string") {
			return {
				source: "config",
				enabled: isExploreCommandRoutingEnabled({
					USE_OMX_EXPLORE_CMD: configuredValue,
				}),
			};
		}

		return { source: "default", enabled: false, reason: "unset" };
	} catch {
		return { source: "unreadable", enabled: false };
	}
}

function checkExploreRoutingFromState(state: ExploreRoutingState): Check {
	if (state.source === "env") {
		if (state.enabled) {
			return {
				name: "Explore routing",
				status: "warn",
				message:
					"deprecated compatibility routing enabled by environment override; remove USE_OMX_EXPLORE_CMD or set it to 0 and use normal Codex repo inspection or omx sparkshell instead",
			};
		}
		return {
			name: "Explore routing",
			status: "pass",
			message:
				"deprecated compatibility routing disabled by environment override (recommended)",
		};
	}

	if (state.source === "config") {
		if (state.enabled) {
			return {
				name: "Explore routing",
				status: "warn",
				message:
					'deprecated compatibility routing enabled in config.toml; set USE_OMX_EXPLORE_CMD = "0" under [shell_environment_policy.set] and use normal Codex repo inspection or omx sparkshell instead',
			};
		}
		return {
			name: "Explore routing",
			status: "pass",
			message:
				"deprecated compatibility routing disabled in config.toml (recommended)",
		};
	}

	if (state.source === "unreadable") {
		return {
			name: "Explore routing",
			status: "fail",
			message: "cannot read config.toml for explore routing check",
		};
	}

	return {
		name: "Explore routing",
		status: "pass",
		message:
			state.reason === "missing-config"
				? "deprecated by default (config.toml not found yet)"
				: "deprecated by default",
	};
}

const LORE_COMMIT_GUARD_EXPLICIT_OPT_OUT_VALUES = new Set([
	"0",
	"false",
	"no",
	"off",
]);

async function checkLoreCommitGuard(configPath: string): Promise<Check> {
	const envValue = process.env[OMX_LORE_COMMIT_GUARD_ENV];
	if (typeof envValue === "string") {
		if (isLoreCommitGuardEnabled(process.env)) {
			return {
				name: "Lore commit guard",
				status: "pass",
				message: "enabled by environment opt-in",
			};
		}
		if (!isExplicitLoreCommitGuardOptOut(envValue)) {
			return {
				name: "Lore commit guard",
				status: "warn",
				message:
					"invalid environment value; Lore commit enforcement is disabled until OMX_LORE_COMMIT_GUARD is set to 1, true, yes, or on",
			};
		}
		return {
			name: "Lore commit guard",
			status: "pass",
			message: "disabled by environment/default opt-out; enable with OMX_LORE_COMMIT_GUARD=1",
		};
	}

	if (!existsSync(configPath)) {
		return {
			name: "Lore commit guard",
			status: "pass",
			message: "disabled by default (config.toml not found yet)",
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

		if (typeof configuredValue === "string") {
			if (isLoreCommitGuardEnabled({
				[OMX_LORE_COMMIT_GUARD_ENV]: configuredValue,
			})) {
				return {
					name: "Lore commit guard",
					status: "pass",
					message: "enabled by config.toml opt-in",
				};
			}
			if (!isExplicitLoreCommitGuardOptOut(configuredValue)) {
				return {
					name: "Lore commit guard",
					status: "warn",
					message:
						'invalid config.toml value; Lore commit enforcement is disabled until OMX_LORE_COMMIT_GUARD = "1" (or true/yes/on) is set under [shell_environment_policy.set]',
				};
			}
			return {
				name: "Lore commit guard",
				status: "pass",
				message:
					'disabled in config.toml/default opt-out; set OMX_LORE_COMMIT_GUARD = "1" under [shell_environment_policy.set] to enable Lore commit enforcement',
			};
		}

		return {
			name: "Lore commit guard",
			status: "pass",
			message: "disabled by default",
		};
	} catch {
		return {
			name: "Lore commit guard",
			status: "fail",
			message: "cannot read config.toml for Lore commit guard check",
		};
	}
}

function isExplicitLoreCommitGuardOptOut(value: string): boolean {
	return LORE_COMMIT_GUARD_EXPLICIT_OPT_OUT_VALUES.has(
		value.trim().toLowerCase(),
	);
}

interface ExternalCodexProcessGuardOptions {
	platform?: NodeJS.Platform;
	homeDir?: string;
}

function decodeBasicXmlEntities(value: string): string {
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'");
}

function extractPlistStrings(content: string): string[] {
	return [...content.matchAll(/<string>([^<]+)<\/string>/g)].map((match) =>
		decodeBasicXmlEntities(match[1]?.trim() ?? ""),
	);
}

function extractPlistLabel(content: string, fallback: string): string {
	const labelMatch = content.match(
		/<key>Label<\/key>\s*<string>([^<]+)<\/string>/,
	);
	return decodeBasicXmlEntities(labelMatch?.[1]?.trim() || fallback);
}

async function readExistingTextFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch {
		return "";
	}
}

function expandLaunchAgentPath(value: string, homeDir: string): string {
	if (value === "~") return homeDir;
	if (value.startsWith("~/")) return join(homeDir, value.slice(2));
	if (value === "$HOME") return homeDir;
	if (value.startsWith("$HOME/")) return join(homeDir, value.slice(6));
	if (value === "${HOME}") return homeDir;
	if (value.startsWith("${HOME}/")) return join(homeDir, value.slice(8));
	return value;
}

function classifyExternalCodexProcessGuard(
	plistContent: string,
	combinedContent: string,
): string | null {
	const lowerPlist = plistContent.toLowerCase();
	const lower = combinedContent.toLowerCase();
	if (
		lower.includes("codex-mcp-child-guard") ||
		lower.includes("codex_mcp_child_guard") ||
		combinedContent.includes("CODEX_MCP_GUARD_DEDUPE_APP_CHILDREN") ||
		(lower.includes("codex app-server") &&
			lower.includes("pgrep -p") &&
			lower.includes("kill"))
	) {
		return "Codex app-server MCP child dedupe";
	}
	if (
		(lowerPlist.includes("codex-xcode-mcp-guard") ||
			lowerPlist.includes("codex_xcode_mcp_guard")) &&
		lower.includes("xcodebuildmcp") &&
		lower.includes("kill")
	) {
		return "XcodeBuildMCP cleanup";
	}
	return null;
}

export async function checkExternalCodexProcessGuards(
	options: ExternalCodexProcessGuardOptions = {},
): Promise<Check | null> {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin") return null;

	const homeDir = options.homeDir ?? process.env.HOME;
	if (!homeDir) return null;

	const launchAgentsDir = join(homeDir, "Library", "LaunchAgents");
	if (!existsSync(launchAgentsDir)) return null;

	let entries: string[];
	try {
		entries = await readdir(launchAgentsDir);
	} catch {
		return null;
	}

	const findings: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".plist")) continue;
		const plistPath = join(launchAgentsDir, entry);
		const plistContent = await readExistingTextFile(plistPath);
		if (plistContent.trim() === "") continue;

		const loweredPlist = plistContent.toLowerCase();
		if (
			!loweredPlist.includes("codex") &&
			!loweredPlist.includes("mcp") &&
			!loweredPlist.includes("omx")
		) {
			continue;
		}

		let combinedContent = plistContent;
		for (const value of extractPlistStrings(plistContent)) {
			const expandedValue = expandLaunchAgentPath(value, homeDir);
			if (!expandedValue.startsWith("/")) continue;
			if (!existsSync(expandedValue)) continue;
			combinedContent += `\n${await readExistingTextFile(expandedValue)}`;
		}

		const reason = classifyExternalCodexProcessGuard(
			plistContent,
			combinedContent,
		);
		if (!reason) continue;

		const label = extractPlistLabel(plistContent, entry);
		findings.push(`${label} (${reason})`);
	}

	if (findings.length === 0) return null;

	return {
		name: "External process guards",
		status: "warn",
		message: `external LaunchAgent(s) may terminate Codex/MCP helper processes outside OMX setup ownership: ${findings.join(", ")}; unload/remove them before attributing SIGTERM or transport resets to standard OMX MCP configuration`,
	};
}

export interface NativeHookCheckContext {
	codexHomeDir: string;
	installMode?: SetupInstallMode;
	platform?: NodeJS.Platform;
}


function isEnabledTomlValue(value: unknown): boolean {
	return value === true || (typeof value === "string" && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase()));
}

function configHasOmxEntries(configContent: string): boolean {
	return configContent.includes("omx_") || configContent.includes("oh-my-codex");
}

function configEnablesPluginScopedHooks(configContent: string): boolean {
	try {
		const parsed = parseToml(configContent) as {
			plugin_hooks?: unknown;
			features?: Record<string, unknown>;
		};
		return isEnabledTomlValue(parsed.plugin_hooks) || isEnabledTomlValue(parsed.features?.plugin_hooks);
	} catch {
		return /^\s*plugin_hooks\s*=\s*(?:true|1|"true"|"1"|"yes"|"on")\s*$/m.test(configContent);
	}
}

function trimNativeHookDetailTerminalPeriod(detail: string): string {
	return detail.endsWith(".") ? detail.slice(0, -1) : detail;
}

function formatNativeHookDiagnostics(
	diagnostics: readonly {
		eventName: string;
		groupIndex: number;
		handlerIndex?: number;
		message: string;
	}[],
): string {
	return diagnostics
		.map((diagnostic) => {
			const coordinate = `${diagnostic.eventName}[${diagnostic.groupIndex}]${
				diagnostic.handlerIndex === undefined
					? ""
					: `.${diagnostic.handlerIndex}`
			}`;
			return `${coordinate}: ${trimNativeHookDetailTerminalPeriod(diagnostic.message)}`;
		})
		.join("; ");
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const WINDOWS_SHIM_SCAN_EVENTS = [
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

function effectiveWindowsHookCommand(handler: Record<string, unknown>): string | null {
	const commandWindows = handler.commandWindows;
	if (typeof commandWindows === "string") return commandWindows;
	const commandWindowsSnakeCase = handler.command_windows;
	if (typeof commandWindowsSnakeCase === "string") return commandWindowsSnakeCase;
	return typeof handler.command === "string" ? handler.command : null;
}

function referencedWindowsNativeHookShimPaths(
	root: Record<string, unknown>,
	diagnostics: readonly {
		code: string;
		eventName: string;
		groupIndex: number;
		handlerIndex?: number;
	}[],
	codexHomeDir: string,
): string[] {
	if (!isJsonRecord(root.hooks)) return [];

	const skippedGroups = new Set(
		diagnostics
			.filter((diagnostic) => diagnostic.code === "invalid_matcher")
			.map((diagnostic) => `${diagnostic.eventName}:${diagnostic.groupIndex}`),
	);
	const skippedHandlers = new Set(
		diagnostics
			.filter((diagnostic) => diagnostic.code === "async_command" || diagnostic.code === "empty_command")
			.map((diagnostic) => `${diagnostic.eventName}:${diagnostic.groupIndex}:${diagnostic.handlerIndex}`),
	);
	const shimPaths = new Set<string>();
	for (const eventName of WINDOWS_SHIM_SCAN_EVENTS) {
		const eventGroups = root.hooks[eventName];
		if (!Array.isArray(eventGroups)) continue;
		for (const [groupIndex, group] of eventGroups.entries()) {
			if (skippedGroups.has(`${eventName}:${groupIndex}`) || !isJsonRecord(group) || !Array.isArray(group.hooks)) continue;
			for (const [handlerIndex, handler] of group.hooks.entries()) {
				if (
					skippedHandlers.has(`${eventName}:${groupIndex}:${handlerIndex}`) ||
					!isJsonRecord(handler) ||
					handler.type !== "command"
				) continue;
				const command = effectiveWindowsHookCommand(handler);
				if (!command) continue;
				const shimPath = parseManagedCodexNativeHookWindowsShimCommand(command, {
					platform: "win32",
					codexHomeDir,
				});
				if (shimPath) shimPaths.add(shimPath);
			}
		}
	}
	return [...shimPaths];
}

async function checkWindowsNativeHookShimParentTopology(
	shimPath: string,
	codexHomeDir: string,
): Promise<Check | null> {
	let ancestorPath = dirname(shimPath);
	for (;;) {
		try {
			const ancestorStat = await lstat(ancestorPath);
			if (ancestorStat.isSymbolicLink() || !ancestorStat.isDirectory()) {
				return {
					name: "Native hooks",
					status: "fail",
					message: `referenced Windows native hook shim at ${shimPath} has an unsafe parent topology at ${ancestorPath}; doctor will not follow or modify it`,
				};
			}
		} catch {
			return {
				name: "Native hooks",
				status: "fail",
				message: `referenced Windows native hook shim at ${shimPath} has a parent topology that cannot be safely validated; doctor will not follow or modify it`,
			};
		}
		if (ancestorPath === codexHomeDir) return null;
		const parentPath = dirname(ancestorPath);
		if (parentPath === ancestorPath) {
			return {
				name: "Native hooks",
				status: "fail",
				message: `referenced Windows native hook shim at ${shimPath} is outside the controlled Codex home topology; doctor will not follow or modify it`,
			};
		}
		ancestorPath = parentPath;
	}
}

async function checkWindowsNativeHookShims(
	root: Record<string, unknown>,
	diagnostics: Parameters<typeof referencedWindowsNativeHookShimPaths>[1],
	codexHomeDir: string,
	requireCurrent = false,
): Promise<Check | null> {
	const expected = Buffer.from(
		buildManagedCodexNativeHookWindowsShimContent(getPackageRoot()),
		"utf-8",
	);
	for (const shimPath of referencedWindowsNativeHookShimPaths(root, diagnostics, codexHomeDir)) {
		let shimContent: Buffer;
		try {
			const shimStat = await lstat(shimPath);
			if (shimStat.isSymbolicLink() || !shimStat.isFile()) {
				return {
					name: "Native hooks",
					status: "fail",
					message: `referenced Windows native hook shim at ${shimPath} is not a regular file; doctor will not follow or modify it`,
				};
			}
			if (shimStat.nlink !== 1) {
				return {
					name: "Native hooks",
					status: "fail",
					message: `referenced Windows native hook shim at ${shimPath} is hard-linked; doctor will not execute or modify it`,
				};
			}
			shimContent = await readFile(shimPath);
			const topologyCheck = await checkWindowsNativeHookShimParentTopology(
				shimPath,
				codexHomeDir,
			);
			if (topologyCheck) return topologyCheck;
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error
				? String(error.code)
				: undefined;
			return {
				name: "Native hooks",
				status: "fail",
				message: code === "ENOENT"
					? `referenced Windows native hook shim is missing at ${shimPath}; manually reinstall the matching oh-my-codex version because doctor will not create or modify shims`
					: `cannot read referenced Windows native hook shim at ${shimPath}; inspect it and manually reinstall the matching oh-my-codex version because doctor will not modify shims`,
			};
		}
		const ownership = classifyManagedCodexNativeHookWindowsShimOwnership(shimContent, expected);
		if (ownership === "modified") {
			return {
				name: "Native hooks",
				status: "fail",
				message: `referenced Windows native hook shim at ${shimPath} is not an exact current or complete historical generated shim; it may be modified, truncated, have extra content, or use ambiguous encoding. Manually reinstall the matching oh-my-codex version because doctor will not overwrite it`,
			};
		}
		if (requireCurrent && ownership !== "current") {
			return {
				name: "Native hooks",
				status: "warn",
				message: `referenced Windows native hook shim at ${shimPath} is a complete historical generated shim, but verbose execution requires exact current shim bytes; run "omx setup" to migrate it before retrying`,
			};
		}
	}
	return null;
}

const MANAGED_HOOK_TRUST_KEY_LABELS: Record<
	(typeof MANAGED_HOOK_EVENTS)[number],
	string
> = {
	SessionStart: "session_start",
	PreToolUse: "pre_tool_use",
	PostToolUse: "post_tool_use",
	UserPromptSubmit: "user_prompt_submit",
	PreCompact: "pre_compact",
	PostCompact: "post_compact",
	Stop: "stop",
};

function getMissingManagedHookEventsFromPlan(
	plan: Pick<ManagedCodexHooksPlan, "priorTrustState">,
): (typeof MANAGED_HOOK_EVENTS)[number][] {
	return MANAGED_HOOK_EVENTS.filter((eventName) => {
		const label = MANAGED_HOOK_TRUST_KEY_LABELS[eventName];
		const keyPattern = new RegExp(`:${label}:\\d+:\\d+$`);
		return !Object.keys(plan.priorTrustState).some((key) => keyPattern.test(key));
	});
}

function pluginHooksJsonHasNativeCoverage(content: string): boolean | null {
	try {
		const parsed = JSON.parse(content) as { hooks?: Record<string, unknown> };
		if (!parsed || typeof parsed !== "object" || typeof parsed.hooks !== "object" || parsed.hooks === null) {
			return false;
		}
		return MANAGED_HOOK_EVENTS.every((eventName) => {
			const entries = parsed.hooks?.[eventName];
			if (!Array.isArray(entries)) return false;
			return entries.some((entry) => {
				if (!entry || typeof entry !== "object") return false;
				const hooks = (entry as { hooks?: unknown }).hooks;
				if (!Array.isArray(hooks)) return false;
				return hooks.some((hook) => {
					if (!hook || typeof hook !== "object") return false;
					const command = (hook as { command?: unknown }).command;
					return typeof command === "string" && command.includes("codex-native-hook.mjs");
				});
			});
		});
	} catch {
		return null;
	}
}

async function checkPluginScopedNativeHooks(
	codexHomeDir: string,
	setupHooksPath: string,
): Promise<Check> {
	const setupHooksPathDescription = existsSync(setupHooksPath)
		? `existing hooks.json at ${setupHooksPath} is retained read-only and validated separately because plugin-scoped hooks are enabled`
		: `setup-owned hooks.json is intentionally absent at ${setupHooksPath}`;
	const packagedMarketplace = await resolvePackagedOmxMarketplace(getPackageRoot());
	if (!packagedMarketplace) {
		return {
			name: "Native hooks",
			status: "warn",
			message:
				`plugin-scoped hooks are enabled and ${setupHooksPathDescription}, but packaged ${OMX_LOCAL_MARKETPLACE_NAME} metadata was not found`,
		};
	}

	const version = await packagedOmxPluginVersion(packagedMarketplace);
	const expectedCacheDir = version
		? join(codexHomeDir, "plugins", "cache", OMX_LOCAL_MARKETPLACE_NAME, "oh-my-codex", version)
		: join(codexHomeDir, "plugins", "cache", OMX_LOCAL_MARKETPLACE_NAME, "oh-my-codex", "<version>");
	const expectedHooksPath = join(expectedCacheDir, "hooks", "hooks.json");
	const expectedHookLauncherPath = join(expectedCacheDir, "hooks", "codex-native-hook.mjs");
	const expectedPinnedLauncherPath = join(expectedCacheDir, "hooks", "omx-command.json");
	const state = await readOmxPluginCacheState(expectedCacheDir);

	if (!state) {
		return {
			name: "Native hooks",
			status: "warn",
			message:
				`plugin-scoped hooks are enabled, but the expected Codex plugin cache manifest is missing at ${join(expectedCacheDir, ".codex-plugin", "plugin.json")}; ${setupHooksPathDescription}; run "omx setup --plugin" to refresh the plugin cache`,
		};
	}

	if (state.hooksPointer !== "./hooks/hooks.json") {
		return {
			name: "Native hooks",
			status: "warn",
			message:
				`plugin-scoped hooks are enabled, but the Codex plugin cache manifest points hooks to ${String(state.hooksPointer)} instead of ./hooks/hooks.json at ${expectedHooksPath}; run "omx setup --plugin" to refresh the plugin cache`,
		};
	}

	for (const expectedPath of [expectedHooksPath, expectedHookLauncherPath, expectedPinnedLauncherPath]) {
		if (!existsSync(expectedPath)) {
			return {
				name: "Native hooks",
				status: "warn",
				message:
					`plugin-scoped hooks are enabled, but expected plugin hook file is missing at ${expectedPath}; ${setupHooksPathDescription}; run "omx setup --plugin" to refresh the plugin cache`,
			};
		}
	}

	if (!(await pluginHookCacheMatchesPackaged(expectedCacheDir, packagedMarketplace))) {
		return {
			name: "Native hooks",
			status: "warn",
			message:
				`plugin-scoped hooks are enabled, but cached plugin hook files or pinned hook launcher in ${expectedCacheDir} do not match the packaged plugin; ${setupHooksPathDescription}; run "omx setup --plugin" to refresh the plugin cache`,
		};
	}

	let hookContent: string;
	try {
		hookContent = await readFile(expectedHooksPath, "utf-8");
	} catch {
		return {
			name: "Native hooks",
			status: "fail",
			message: `cannot read plugin-scoped hooks.json at ${expectedHooksPath}`,
		};
	}

	const hasCoverage = pluginHooksJsonHasNativeCoverage(hookContent);
	if (hasCoverage === null) {
		return {
			name: "Native hooks",
			status: "fail",
			message: `invalid plugin-scoped hooks.json at ${expectedHooksPath}`,
		};
	}
	if (!hasCoverage) {
		return {
			name: "Native hooks",
			status: "warn",
			message:
				`plugin-scoped hooks.json at ${expectedHooksPath} is missing OMX native coverage for one or more events; run "omx setup --plugin" to refresh the plugin cache`,
		};
	}

	const smokeCwd = await mkdtemp(join(tmpdir(), "omx-doctor-plugin-hook-"));
	try {
		const payload = JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			session_id: "omx-doctor-plugin-hook-smoke",
			transcript_path: join(smokeCwd, "nonexistent-transcript.jsonl"),
			cwd: smokeCwd,
			prompt: "doctor plugin hook smoke test",
		});
		const result = spawnSync(process.execPath, [expectedHookLauncherPath], {
			cwd: smokeCwd,
			encoding: "utf-8",
			env: {
				...process.env,
				OMX_NATIVE_HOOK_DOCTOR_SMOKE: "1",
				OMX_ROOT: join(smokeCwd, ".omx-doctor-root"),
				OMX_SESSION_ID: "omx-doctor-plugin-hook-smoke",
				OMX_SOURCE_CWD: smokeCwd,
				OMX_ENTRY_PATH: join(getPackageRoot(), "dist", "cli", "omx.js"),
				OMX_CODEX_LAUNCH_ID: "omx-doctor-plugin-hook-smoke-launch",
				OMX_STARTUP_CWD: smokeCwd,
			},
			input: payload,
			timeout: 5_000,
		});
		if (result.error) {
			return {
				name: "Native hooks",
				status: "fail",
				message: `plugin-scoped native hook smoke failed to run from ${expectedHookLauncherPath} (${result.error.message})`,
			};
		}
		if (result.status !== 0) {
			const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
			return {
				name: "Native hooks",
				status: "fail",
				message: `plugin-scoped native hook smoke failed from ${expectedHookLauncherPath} (${detail})`,
			};
		}
	} finally {
		await rm(smokeCwd, { recursive: true, force: true });
	}

	return {
		name: "Native hooks",
		status: "pass",
		message:
			`plugin-scoped hooks are enabled; ${setupHooksPathDescription}, and plugin cache native hook coverage smoke passed via ${expectedHooksPath}`,
	};
}

function decodeStrictUtf8(bytes: Buffer): string | null {
	try {
		const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		return Buffer.from(content, "utf-8").equals(bytes) ? content : null;
	} catch {
		return null;
	}
}

function combinePluginAndGlobalNativeHookChecks(plugin: Check, global: Check | null): Check {
	if (!global) return plugin;
	const status = plugin.status === "fail" || global.status === "fail"
		? "fail"
		: plugin.status === "warn" || global.status === "warn"
			? "warn"
			: "pass";
	return {
		name: "Native hooks",
		status,
		message: `${plugin.message}; existing global hooks.json: ${global.message}`,
	};
}

function combineNativeHookIntegrityAndRemovalChecks(
	integrityCheck: Check | null,
	removalCheck: Check,
): Check {
	if (!integrityCheck) return removalCheck;
	return {
		name: "Native hooks",
		status: integrityCheck.status === "fail" || removalCheck.status === "fail"
			? "fail"
			: "warn",
		message: `${integrityCheck.message}; ${removalCheck.message}`,
	};
}

async function checkExistingNativeHooks(
	hooksPath: string,
	context: NativeHookCheckContext,
): Promise<Check> {
	const platform = context.platform ?? process.platform;
	try {
		const hooksStat = await lstat(hooksPath);
		if (hooksStat.isSymbolicLink() || !hooksStat.isFile()) {
			return {
				name: "Native hooks",
				status: "fail",
				message: `hooks.json at ${hooksPath} is not a regular file; doctor will not follow or modify it`,
			};
		}
		const content = decodeStrictUtf8(await readFile(hooksPath));
		if (content === null) {
			return {
				name: "Native hooks",
				status: "fail",
				message: `hooks.json at ${hooksPath} is not valid UTF-8; inspect the file manually because doctor will not modify it`,
			};
		}
		const validation = validateCodexHooksConfigStrict(content, {
			platform,
			codexHomeDir: context.codexHomeDir,
		});
		if (!validation.ok) {
			return {
				name: "Native hooks",
				status: "fail",
				message: `hooks.json failed strict load validation (${validation.error.code}): ${trimNativeHookDetailTerminalPeriod(validation.error.message)}; inspect the file manually because doctor will not modify it`,
			};
		}

		const removalPlan = planManagedCodexHooksRemoval(content, hooksPath, {
			platform,
			codexHomeDir: context.codexHomeDir,
		});
		const windowsShimCheck = platform === "win32"
			? await checkWindowsNativeHookShims(
				validation.root,
				validation.diagnostics,
				context.codexHomeDir,
			)
			: null;
		if (!removalPlan.ok) {
			const removalIsCoordinateOnly = removalPlan.error.code === "unsafe_managed_removal";
			const removalCheck: Check = {
				name: "Native hooks",
				status: removalIsCoordinateOnly ? "warn" : "fail",
				message: removalIsCoordinateOnly
					? `hooks.json has OMX entries that cannot be safely removed (${removalPlan.error.code}): ${trimNativeHookDetailTerminalPeriod(removalPlan.error.message)}; manual cleanup is required because doctor will not overwrite or remove it`
					: `hooks.json has ambiguous or untrusted OMX ownership (${removalPlan.error.code}): ${trimNativeHookDetailTerminalPeriod(removalPlan.error.message)}; inspect the file manually because doctor will not overwrite or remove it`,
			};
			return combineNativeHookIntegrityAndRemovalChecks(windowsShimCheck, removalCheck);
		}
		if (windowsShimCheck) return windowsShimCheck;
		const legacyTrustStateEntries = Object.keys(removalPlan.legacyTrustState).length;
		if (legacyTrustStateEntries > 0) {
			return {
				name: "Native hooks",
				status: "warn",
				message: `hooks.json contains ${legacyTrustStateEntries} exact historical OMX hook trust-state ${legacyTrustStateEntries === 1 ? "entry that requires" : "entries that require"} migration; run "omx setup" to migrate ${legacyTrustStateEntries === 1 ? "it" : "them"} after reviewing the configuration`,
			};
		}

		if (validation.diagnostics.length > 0) {
			return {
				name: "Native hooks",
				status: "warn",
				message: `hooks.json discovery warnings: ${formatNativeHookDiagnostics(validation.diagnostics)}; Codex may ignore the listed entries, and doctor will not modify them`,
			};
		}

		const missingEvents = getMissingManagedHookEventsFromPlan(removalPlan);
		if (
			removalPlan.hasForeignHooks &&
			removalPlan.removedCount === 0 &&
			missingEvents.length === MANAGED_HOOK_EVENTS.length
		) {
			return {
				name: "Native hooks",
				status: "pass",
				message:
					"hooks.json contains valid foreign hook entries and no OMX-managed wrappers; doctor will preserve the user-owned configuration",
			};
		}
		if (missingEvents.length > 0) {
			return {
				name: "Native hooks",
				status: "warn",
				message: `hooks.json is missing OMX-managed coverage for ${missingEvents.join(", ")}; run "omx setup" to restore native hooks${removalPlan.hasForeignHooks ? "; valid foreign hooks will be preserved" : ""}`,
			};
		}

		return {
			name: "Native hooks",
			status: "pass",
			message: `hooks.json includes OMX-managed coverage for all native hook events${removalPlan.hasForeignHooks ? "; valid foreign hooks will be preserved" : ""}`,
		};
	} catch {
		return {
			name: "Native hooks",
			status: "fail",
			message: "cannot read hooks.json",
		};
	}
}

export async function checkNativeHooks(
	hooksPath: string,
	configPath: string,
	context: NativeHookCheckContext,
): Promise<Check> {
	if (existsSync(configPath) && context.installMode === "plugin") {
		try {
			const configContent = await readFile(configPath, "utf-8");
			if (configEnablesPluginScopedHooks(configContent)) {
				const globalCheck = existsSync(hooksPath)
					? await checkExistingNativeHooks(hooksPath, context)
					: null;
				return combinePluginAndGlobalNativeHookChecks(
					await checkPluginScopedNativeHooks(context.codexHomeDir, hooksPath),
					globalCheck,
				);
			}
		} catch {
			// Fall through to the hooks.json checks; the dedicated config check will
			// report read failures separately.
		}
	}

	if (!existsSync(hooksPath)) {
		if (existsSync(configPath)) {
			try {
				const configContent = await readFile(configPath, "utf-8");
				if (context.installMode === "plugin" && configHasOmxEntries(configContent)) {
					return {
						name: "Native hooks",
						status: "warn",
						message:
							`plugin mode is using legacy native hook fallback, but expected setup-owned hooks.json is missing at ${hooksPath}; run "omx setup --plugin" to restore the fallback hook file, or upgrade Codex to plugin_hooks support so setup can use plugin-scoped hooks`,
					};
				}

				if (configHasOmxEntries(configContent)) {
					return {
						name: "Native hooks",
						status: "warn",
						message:
							`expected setup-owned hooks.json is missing at ${hooksPath} even though config.toml has OMX entries; run "omx setup" to restore native hook coverage`,
					};
				}
			} catch {
				// Fall through to the neutral first-setup path when config cannot be read here;
				// the dedicated config check will report read failures separately.
			}
		}

		return {
			name: "Native hooks",
			status: "pass",
			message: "hooks.json not found yet (expected before first setup)",
		};
	}

	return checkExistingNativeHooks(hooksPath, context);
}

export async function checkNativeHookDistSmoke(
	options: NativeHookDistSmokeOptions = {},
): Promise<Check> {
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const nodePath = options.nodePath ?? process.execPath;
	const runner = options.runner ?? spawnSync;
	const scriptPath = join(packageRoot, "dist", "scripts", "codex-native-hook.js");

	if (!existsSync(scriptPath)) {
		return {
			name: "Native hook dist smoke",
			status: "fail",
			message: `installed native hook script is missing at ${scriptPath}; reinstall oh-my-codex and run "omx setup"`,
		};
	}

	const smokeCwd = await mkdtemp(join(tmpdir(), "omx-doctor-native-hook-dist-"));
	try {
		const payload = JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			session_id: "omx-doctor-native-hook-dist-smoke",
			transcript_path: join(smokeCwd, "nonexistent-transcript.jsonl"),
			cwd: smokeCwd,
			prompt: "doctor smoke test",
		});
		const result = runner(nodePath, [scriptPath], {
			cwd: smokeCwd,
			encoding: "utf-8",
			env: {
				...process.env,
				OMX_NATIVE_HOOK_DOCTOR_SMOKE: "1",
				OMX_ROOT: join(smokeCwd, ".omx-doctor-root"),
				OMX_SESSION_ID: "omx-doctor-native-hook-dist-smoke",
				OMX_SOURCE_CWD: smokeCwd,
				OMX_STARTUP_CWD: smokeCwd,
			},
			input: payload,
			timeout: 5_000,
		});

		if (result.error) {
			return {
				name: "Native hook dist smoke",
				status: "fail",
				message: `installed native hook dist smoke failed to run (${result.error.message}); reinstall oh-my-codex and run "omx setup"`,
			};
		}
		if (result.status !== 0) {
			const stderr = (result.stderr || "").trim();
			const stdout = (result.stdout || "").trim();
			const detail = stderr || stdout || `exit ${result.status}`;
			return {
				name: "Native hook dist smoke",
				status: "fail",
				message: `installed native hook dist failed a minimal UserPromptSubmit smoke (${detail}); reinstall the matching oh-my-codex version and then run "omx setup"`,
			};
		}

		return {
			name: "Native hook dist smoke",
			status: "pass",
			message:
				"installed dist/scripts/codex-native-hook.js parsed and accepted a minimal UserPromptSubmit payload",
		};
	} finally {
		await rm(smokeCwd, { recursive: true, force: true });
	}
}

export function classifyPostCompactHookStdout(stdout: string): Check | null {
	const trimmed = stdout.trim();
	if (trimmed === "") return null;

	try {
		JSON.parse(trimmed);
		return {
			name: "Native PostCompact hook",
			status: "fail",
			message:
				"PostCompact hook emitted JSON stdout, but OMX PostCompact must emit no stdout until Codex defines a supported PostCompact output contract; rerun \"omx setup\" after upgrading",
		};
	} catch (error) {
		return {
			name: "Native PostCompact hook",
			status: "fail",
			message: `PostCompact hook emitted invalid JSON stdout (${error instanceof Error ? error.message : String(error)}); rerun "omx setup" after upgrading`,
		};
	}
}

interface PostCompactSmokeSpawnInvocation {
	command: string;
	args: string[];
	shell: boolean;
}

export function buildPostCompactSmokeSpawnInvocation(
	expectedCommand: string,
	options: {
		platform?: NodeJS.Platform;
		env?: NodeJS.ProcessEnv;
	} = {},
): PostCompactSmokeSpawnInvocation {
	const platform = options.platform ?? process.platform;
	if (platform === "win32") {
		return {
			command: resolveWindowsPowerShellPath(options.env),
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				expectedCommand,
			],
			shell: false,
		};
	}

	return {
		command: expectedCommand,
		args: [],
		shell: true,
	};
}

function buildInMemoryWindowsShimSmokeInvocation(
	expectedShimContent: Buffer,
	options: { env?: NodeJS.ProcessEnv } = {},
): PostCompactSmokeSpawnInvocation | null {
	const shimSource = decodeStrictUtf8(expectedShimContent);
	if (shimSource === null) return null;

	const encodedShimBytes = expectedShimContent.toString("base64");
	const command = [
		"$ErrorActionPreference = 'Stop'",
		`$omxShimSource = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedShimBytes}'))`,
		"if ($omxShimSource.Length -gt 0 -and [int][char]$omxShimSource[0] -eq 0xFEFF) { $omxShimSource = $omxShimSource.Substring(1) }",
		"& ([ScriptBlock]::Create($omxShimSource))",
		"exit $LASTEXITCODE",
	].join("; ");
	return {
		command: resolveWindowsPowerShellPath(options.env),
		args: [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(command, "utf16le").toString("base64"),
		],
		shell: false,
	};
}

interface SmokeDirectoryIdentity {
	dev: number;
	ino: number;
}

function smokeDirectoryIdentity(stat: Stats): SmokeDirectoryIdentity | null {
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(process.platform !== "win32" && (stat.mode & 0o077) !== 0)
	) return null;
	return { dev: stat.dev, ino: stat.ino };
}

async function readSmokeDirectoryIdentity(
	smokeCwd: string,
): Promise<SmokeDirectoryIdentity | null> {
	try {
		return smokeDirectoryIdentity(await lstat(smokeCwd));
	} catch {
		return null;
	}
}

function sameSmokeDirectoryIdentity(
	expected: SmokeDirectoryIdentity,
	actual: SmokeDirectoryIdentity | null,
): boolean {
	return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino;
}

function smokeDirectorySafetyCheck(message: string): Check {
	return {
		name: "Native PostCompact hook",
		status: "warn",
		message,
	};
}

async function cleanupSmokeDirectoryIfUnchanged(
	smokeCwd: string,
	identity: SmokeDirectoryIdentity,
): Promise<Check | null> {
	if (!sameSmokeDirectoryIdentity(identity, await readSmokeDirectoryIdentity(smokeCwd))) {
		return smokeDirectorySafetyCheck(
			"temporary PostCompact smoke directory changed during validation; doctor preserved it for manual recovery and skipped cleanup for safety",
		);
	}
	try {
		// Only remove the empty, identity-checked directory. Never recursively remove
		// a directory that another process could have replaced or populated.
		await rmdir(smokeCwd);
		return null;
	} catch {
		return smokeDirectorySafetyCheck(
			"temporary PostCompact smoke directory could not be removed without recursive deletion; doctor preserved it for manual recovery",
		);
	}
}

function inMemoryWindowsShimSmokeCheck(): Check {
	return {
		name: "Native PostCompact hook",
		status: "warn",
		message: "doctor could not build an in-memory Windows native hook smoke command from exact validated shim bytes; doctor skipped execution for safety",
	};
}

interface NativePostCompactHookRuntimeOptions {
	nativeHooksCheck?: Check;
	platform?: NodeJS.Platform;
	expectedCommand?: string;
	runner?: typeof spawnSync;
	beforeWindowsShimSmoke?: (paths: {
		canonicalShimPath: string;
		smokeCwd: string;
	}) => void | Promise<void>;
}

function getManagedPostCompactHookCommands(
	content: string,
	platform: NodeJS.Platform,
	codexHomeDir: string,
): string[] | null {
	const validation = validateCodexHooksConfigStrict(content, {
		platform,
		codexHomeDir,
	});
	if (!validation.ok) return null;
	return validation.discoveredCommands
		.filter((command) => command.eventName === "PostCompact")
		.map((command) => command.command)
		.filter((command) =>
			isManagedCodexHookCommand(command) ||
			(platform === "win32" && parseManagedCodexNativeHookWindowsShimCommand(command, {
				platform,
				codexHomeDir,
			}) !== null),
		);
}

function currentPostCompactCommandCheck(): Check {
	return {
		name: "Native PostCompact hook",
		status: "warn",
		message:
			"effective PostCompact OMX command does not match this installation's managed hook command; doctor skipped execution for safety, and rerunning \"omx setup\" should refresh stale hooks.json entries",
	};
}

function skippedPostCompactIntegrityCheck(integrityCheck: Check): Check {
	return {
		name: "Native PostCompact hook",
		status: integrityCheck.status === "fail" ? "fail" : "warn",
		message: `${integrityCheck.message}; doctor skipped execution because native hook integrity validation did not pass`,
	};
}

export async function checkNativePostCompactHookRuntime(
	hooksPath: string,
	cwd: string,
	codexHomeDir: string,
	options: NativePostCompactHookRuntimeOptions = {},
): Promise<Check | null> {
	if (!existsSync(hooksPath)) return null;
	if (options.nativeHooksCheck && options.nativeHooksCheck.status !== "pass") return null;

	const platform = options.platform ?? process.platform;
	const expectedCommand = options.expectedCommand ?? buildManagedCodexNativeHookCommand(getPackageRoot(), {
		codexHomeDir,
		platform,
	});
	let content: string | null;
	try {
		content = decodeStrictUtf8(await readFile(hooksPath));
	} catch {
		return null;
	}
	if (content === null) return null;

	const postCompactCommands = getManagedPostCompactHookCommands(content, platform, codexHomeDir);
	if (postCompactCommands === null || postCompactCommands.length === 0) return null;
	const uniqueCommands = [...new Set(postCompactCommands)];
	if (uniqueCommands.length !== 1 || uniqueCommands[0] !== expectedCommand) {
		return currentPostCompactCommandCheck();
	}

	const smokeCwd = await mkdtemp(join(tmpdir(), "omx-doctor-postcompact-"));
	const smokeDirectory = await readSmokeDirectoryIdentity(smokeCwd);
	if (!smokeDirectory) {
		return smokeDirectorySafetyCheck(
			"temporary PostCompact smoke directory could not be validated; doctor preserved it for manual recovery and skipped execution for safety",
		);
	}
	let primaryResult: Check | null = null;
	let primaryError: Error | null = null;
	try {
		primaryResult = await (async (): Promise<Check> => {
		const revalidatedIntegrity = await checkExistingNativeHooks(hooksPath, {
			codexHomeDir,
			platform,
		});
		if (revalidatedIntegrity.status !== "pass") {
			return skippedPostCompactIntegrityCheck(revalidatedIntegrity);
		}

		let revalidatedContent: string | null;
		try {
			revalidatedContent = decodeStrictUtf8(await readFile(hooksPath));
		} catch {
			return {
				name: "Native PostCompact hook",
				status: "warn",
				message: "hooks.json changed during verbose validation; doctor skipped execution for safety",
			};
		}
		if (revalidatedContent === null) {
			return {
				name: "Native PostCompact hook",
				status: "warn",
				message: "hooks.json changed during verbose validation; doctor skipped execution for safety",
			};
		}
		const revalidatedCommands = getManagedPostCompactHookCommands(
			revalidatedContent,
			platform,
			codexHomeDir,
		);
		if (
			revalidatedCommands === null ||
			revalidatedCommands.length === 0 ||
			new Set(revalidatedCommands).size !== 1 ||
			revalidatedCommands[0] !== expectedCommand
		) {
			return currentPostCompactCommandCheck();
		}

		if (platform === "win32") {
			const validation = validateCodexHooksConfigStrict(revalidatedContent, {
				platform,
				codexHomeDir,
			});
			if (!validation.ok) {
				return {
					name: "Native PostCompact hook",
					status: "warn",
					message: "hooks.json changed during verbose validation; doctor skipped execution for safety",
				};
			}
			const currentShimCheck = await checkWindowsNativeHookShims(
				validation.root,
				validation.diagnostics,
				codexHomeDir,
				true,
			);
			if (currentShimCheck) return skippedPostCompactIntegrityCheck(currentShimCheck);
		}

		let smokeInvocation: PostCompactSmokeSpawnInvocation;
		if (platform === "win32") {
			const canonicalShimPath = parseManagedCodexNativeHookWindowsShimCommand(expectedCommand, {
				platform,
				codexHomeDir,
			});
			if (!canonicalShimPath) return currentPostCompactCommandCheck();

			const expectedShimContent = Buffer.from(
				buildManagedCodexNativeHookWindowsShimContent(getPackageRoot()),
				"utf-8",
			);
			const inMemoryInvocation = buildInMemoryWindowsShimSmokeInvocation(expectedShimContent);
			if (!inMemoryInvocation) return inMemoryWindowsShimSmokeCheck();
			smokeInvocation = inMemoryInvocation;
			try {
				await options.beforeWindowsShimSmoke?.({ canonicalShimPath, smokeCwd });
			} catch {
				return smokeDirectorySafetyCheck(
					"Windows native hook changed during validation; doctor skipped execution for safety",
				);
			}
		} else {
			smokeInvocation = buildPostCompactSmokeSpawnInvocation(expectedCommand, { platform });
		}
		if (!sameSmokeDirectoryIdentity(smokeDirectory, await readSmokeDirectoryIdentity(smokeCwd))) {
			return smokeDirectorySafetyCheck(
				"temporary PostCompact smoke directory changed during validation; doctor preserved it for manual recovery and skipped execution for safety",
			);
		}

		const payload = JSON.stringify({
			hook_event_name: "PostCompact",
			cwd: smokeCwd,
			session_id: "omx-doctor-postcompact-smoke",
		});
		const result = (options.runner ?? spawnSync)(smokeInvocation.command, smokeInvocation.args, {
			cwd,
			encoding: "utf-8",
			env: {
				...process.env,
				OMX_NATIVE_HOOK_DOCTOR_SMOKE: "1",
				OMX_ROOT: smokeCwd,
				OMX_SESSION_ID: "omx-doctor-postcompact-smoke",
				OMX_SOURCE_CWD: smokeCwd,
				OMX_STARTUP_CWD: smokeCwd,
			},
			input: payload,
			shell: smokeInvocation.shell,
			timeout: 5_000,
		});
		if (result.error) {
			return {
				name: "Native PostCompact hook",
				status: "fail",
				message: `PostCompact hook smoke validation failed to run (${result.error.message})`,
			};
		}
		if (result.status !== 0) {
			const stderr = (result.stderr || "").trim();
			return {
				name: "Native PostCompact hook",
				status: "fail",
				message: `PostCompact hook smoke validation exited ${result.status}${stderr ? `: ${stderr}` : ""}`,
			};
		}

		const stdoutCheck = classifyPostCompactHookStdout(result.stdout || "");
		if (stdoutCheck) return stdoutCheck;

		return {
			name: "Native PostCompact hook",
			status: "pass",
			message:
				"verbose smoke validation confirmed the effective PostCompact hook exits successfully with no stdout",
		};
		})();
	} catch (error) {
		primaryError = error instanceof Error ? error : new Error(String(error));
		throw primaryError;
	} finally {
		const cleanupCheck = await cleanupSmokeDirectoryIfUnchanged(smokeCwd, smokeDirectory);
		if (cleanupCheck) {
			if (primaryResult) {
				if (primaryResult.status === "pass") primaryResult.status = cleanupCheck.status;
				primaryResult.message = `${primaryResult.message}; ${cleanupCheck.message}`;
			} else if (primaryError) {
				primaryError.message = `${primaryError.message}; ${cleanupCheck.message}`;
			}
		}
	}
	return primaryResult;
}

async function checkNativeHookRuntimeMirrors(
	cwd: string,
	hooksPath: string,
): Promise<Check | null> {
	if (!existsSync(hooksPath)) return null;

	const discovery = await discoverCodexHookConfigPaths(cwd);
	const runtimeMirrorCount = discovery.skipped.filter(
		(entry) => entry.reason === "runtime_codex_home_mirror",
	).length;
	if (runtimeMirrorCount === 0) return null;

	return {
		name: "Native hook runtime mirrors",
		status: "warn",
		message:
			`.omx/runtime/codex-home contains ${runtimeMirrorCount} hooks.json runtime mirror${runtimeMirrorCount === 1 ? "" : "s"} skipped by hook discovery; cleanup or relaunch so external hook review tools do not see duplicate native hook surfaces`,
	};
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
			status: "pass",
			message: `shared ~/.agents/skills exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}; no duplicate skill names detected`,
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

function getParsedPluginMarketplaceConfig(content: string): {
	marketplace: { source_type?: unknown; source?: unknown } | null;
	plugin: { enabled?: unknown } | null;
} {
	const parsed = parseToml(content) as {
		marketplaces?: Record<string, { source_type?: unknown; source?: unknown }>;
		plugins?: Record<string, { enabled?: unknown }>;
	};
	return {
		marketplace: parsed.marketplaces?.[OMX_LOCAL_MARKETPLACE_NAME] ?? null,
		plugin: parsed.plugins?.[OMX_LOCAL_PLUGIN_CONFIG_KEY] ?? null,
	};
}

async function checkPluginMarketplaceRegistration(
	configPath: string,
	codexHomeDir: string,
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
		const { marketplace: registration, plugin } =
			getParsedPluginMarketplaceConfig(content);
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
		if (plugin?.enabled !== true) {
			return {
				name: "Skills",
				status: "warn",
				message: `Codex plugin ${OMX_LOCAL_PLUGIN_CONFIG_KEY} is not enabled; run "omx setup --plugin --force"`,
			};
		}

		const [packagedManifestVersion, expectedSkillNames, cacheDirs] =
			await Promise.all([
				packagedOmxPluginVersion(packagedMarketplace),
				expectedPackagedOmxSkillNames(packagedMarketplace),
				discoverOmxPluginCacheDirs(codexHomeDir),
			]);
		if (!packagedManifestVersion) {
			return {
				name: "Skills",
				status: "warn",
				message: `packaged ${OMX_LOCAL_MARKETPLACE_NAME} plugin has no manifest version; reinstall oh-my-codex`,
			};
		}
		if (!expectedSkillNames || expectedSkillNames.length === 0) {
			return {
				name: "Skills",
				status: "warn",
				message: `packaged ${OMX_LOCAL_MARKETPLACE_NAME} plugin has no skills mirror; reinstall oh-my-codex`,
			};
		}
		const cacheStates = (
			await Promise.all(cacheDirs.map((dir) => readOmxPluginCacheState(dir)))
		).filter((state) => state !== null);
		const packagedManifestSummary = {
			manifestVersion: packagedManifestVersion,
			skillNames: expectedSkillNames,
		};
		const readyCache = cacheStates.find(
			(state) =>
				state.manifestVersion === packagedManifestSummary.manifestVersion &&
				state.skillsPointer === "./skills/" &&
				JSON.stringify(state.skillNames) ===
					JSON.stringify(packagedManifestSummary.skillNames),
		);
		if (!readyCache) {
			const staleManifestCache = cacheStates.find(
				(state) =>
					state.skillsPointer === "./skills/" &&
					JSON.stringify(state.skillNames) ===
						JSON.stringify(packagedManifestSummary.skillNames) &&
					state.manifestVersion !== packagedManifestSummary.manifestVersion,
			);
			const detail = staleManifestCache
				? `installed Codex plugin cache manifest version ${String(staleManifestCache.manifestVersion)} does not match packaged version ${packagedManifestSummary.manifestVersion}`
				: cacheStates.length === 0
					? "no installed Codex plugin cache was found"
					: "installed Codex plugin cache is missing the packaged skills mirror";
			return {
				name: "Skills",
				status: "warn",
				message: `plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} is registered, but ${detail}; run "omx setup --plugin --force" so /skills can discover OMX plugin skills`,
			};
		}

		return {
			name: "Skills",
			status: "pass",
			message: `plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} registered; OMX skills are supplied by ${readyCache.cacheDir}`,
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

async function readDoctorInstallStamp(codexHomeDir: string): Promise<{
	install_channel?: string;
	dev_base_version?: string;
	install_revision?: string;
} | null> {
	try {
		const parsed = JSON.parse(
			await readFile(join(codexHomeDir, ".omx", "install-state.json"), "utf-8"),
		) as {
			install_channel?: unknown;
			dev_base_version?: unknown;
			install_revision?: unknown;
		};
		return {
			...(typeof parsed.install_channel === "string" ? { install_channel: parsed.install_channel } : {}),
			...(typeof parsed.dev_base_version === "string" ? { dev_base_version: parsed.dev_base_version } : {}),
			...(typeof parsed.install_revision === "string" ? { install_revision: parsed.install_revision } : {}),
		};
	} catch {
		return null;
	}
}

async function checkPluginVersionDiagnostics(
	codexHomeDir: string,
): Promise<Check> {
	const packagedMarketplace = await resolvePackagedOmxMarketplace(getPackageRoot());
	if (!packagedMarketplace) {
		return {
			name: "Plugin versions",
			status: "warn",
			message: `packaged ${OMX_LOCAL_MARKETPLACE_NAME} metadata was not found; reinstall oh-my-codex`,
		};
	}

	const [manifestVersion, stamp] = await Promise.all([
		packagedOmxPluginVersion(packagedMarketplace),
		readDoctorInstallStamp(codexHomeDir),
	]);
	if (!manifestVersion) {
		return {
			name: "Plugin versions",
			status: "warn",
			message: "packaged plugin manifest has no version; reinstall oh-my-codex",
		};
	}

	const cacheDir = join(
		codexHomeDir,
		"plugins",
		"cache",
		OMX_LOCAL_MARKETPLACE_NAME,
		"oh-my-codex",
		manifestVersion,
	);
	const cacheState = await readOmxPluginCacheState(cacheDir);
	if (cacheState?.manifestVersion !== manifestVersion) {
		return {
			name: "Plugin versions",
			status: "warn",
			message: `expected cache directory ${cacheDir} is not materialized with packaged plugin manifest version ${manifestVersion}; run "omx setup --plugin --force" to refresh the plugin cache`,
		};
	}

	if (stamp?.install_channel === "dev") {
		const devDisplay = stamp.dev_base_version && stamp.install_revision
			? `v${stamp.dev_base_version}-dev-${stamp.install_revision}`
			: null;
		const stampDetail = [
			`package/plugin manifest version ${manifestVersion}`,
			devDisplay ? `dev display version ${devDisplay}` : null,
			stamp.dev_base_version ? `dev_base_version ${stamp.dev_base_version}` : null,
			stamp.install_revision ? `install_revision ${stamp.install_revision}` : null,
		].filter(Boolean).join("; ");
		return {
			name: "Plugin versions",
			status: "pass",
			message: `${stampDetail}; Codex may keep current-session plugin skill metadata until a new Codex session starts`,
		};
	}

	return {
		name: "Plugin versions",
		status: "pass",
		message: `cache directory version matches packaged plugin manifest version ${manifestVersion}`,
	};
}

const REQUIRED_NATIVE_REVIEWER_ROLES = ["architect", "critic"] as const;
const ADVISORY_NATIVE_REVIEWER_ROLES = ["scholastic"] as const;

type NativeReviewerRole =
	| typeof REQUIRED_NATIVE_REVIEWER_ROLES[number]
	| typeof ADVISORY_NATIVE_REVIEWER_ROLES[number];

function getParsedAgentTables(
	configPath: string,
): Record<string, unknown> | null {
	if (!existsSync(configPath)) return null;
	try {
		const parsed = parseToml(readFileSync(configPath, "utf-8")) as {
			agents?: unknown;
		};
		return parsed.agents &&
			typeof parsed.agents === "object" &&
			!Array.isArray(parsed.agents)
			? (parsed.agents as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function configHasNativeReviewerRole(
	configPath: string,
	role: NativeReviewerRole,
): boolean {
	const agents = getParsedAgentTables(configPath);
	if (!agents) return false;
	const value = agents[role];
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function agentTomlDefinesRole(path: string, role: NativeReviewerRole): boolean {
	if (!existsSync(path)) return false;
	try {
		const parsed = parseToml(readFileSync(path, "utf-8")) as { name?: unknown };
		if (typeof parsed.name === "string" && parsed.name.trim() !== "") {
			return parsed.name.trim() === role;
		}
		return basename(path, ".toml") === role;
	} catch {
		return false;
	}
}

function nativeReviewerRoleAvailable(
	paths: DoctorPaths,
	role: NativeReviewerRole,
): boolean {
	return agentTomlDefinesRole(join(paths.agentsDir, `${role}.toml`), role)
		|| configHasNativeReviewerRole(paths.configPath, role);
}

function formatNativeRoleFileList(roles: readonly NativeReviewerRole[]): string {
	const files = roles.map((role) => `${role}.toml`);
	if (files.length <= 1) return files[0] ?? "";
	return `${files.slice(0, -1).join(", ")} and ${files.at(-1)}`;
}

function checkNativeReviewerRoles(
	paths: DoctorPaths,
	installMode?: SetupInstallMode,
): Check | null {
	if (installMode !== "plugin") return null;

	const missingRequired = REQUIRED_NATIVE_REVIEWER_ROLES.filter(
		(role) => !nativeReviewerRoleAvailable(paths, role),
	);
	const missingAdvisory = ADVISORY_NATIVE_REVIEWER_ROLES.filter(
		(role) => !nativeReviewerRoleAvailable(paths, role),
	);

	if (missingRequired.length > 0) {
		const advisorySuffix = missingAdvisory.length > 0
			? `; advisory role missing: ${missingAdvisory.join(", ")}`
			: "";
		return {
			name: "Native reviewer roles",
			status: "fail",
			message:
				`plugin mode supplies skills/hooks, but required RALPLAN/Autopilot native reviewer role(s) are unavailable: ${missingRequired.join(", ")}. ` +
				`Install ${formatNativeRoleFileList(missingRequired)} under ${paths.agentsDir} or define equivalent [agents.<role>] entries in ${paths.configPath}; ` +
				`otherwise role-specific subagent calls may degrade to prompt-only/default subagents${advisorySuffix}`,
		};
	}

	if (missingAdvisory.length > 0) {
		return {
			name: "Native reviewer roles",
			status: "warn",
			message:
				`required RALPLAN/Autopilot native reviewer roles are available (${REQUIRED_NATIVE_REVIEWER_ROLES.join(", ")}); ` +
				`advisory ontology reviewer role(s) missing: ${missingAdvisory.join(", ")} (optional unless explicitly used)`,
		};
	}

	return {
		name: "Native reviewer roles",
		status: "pass",
		message:
			`required RALPLAN/Autopilot native reviewer roles are available (${REQUIRED_NATIVE_REVIEWER_ROLES.join(", ")}); advisory ${ADVISORY_NATIVE_REVIEWER_ROLES.join(", ")} role is also available`,
	};
}

interface InstalledAgentModelInfo {
	exists: boolean;
	model?: string;
	modelProvider?: string;
}

function readInstalledAgentModelInfo(tomlPath: string): InstalledAgentModelInfo {
	if (!existsSync(tomlPath)) return { exists: false };
	try {
		const parsed = parseToml(readFileSync(tomlPath, "utf-8")) as {
			model?: unknown;
			model_provider?: unknown;
		};
		return {
			exists: true,
			model:
				typeof parsed.model === "string" && parsed.model.trim() !== ""
					? parsed.model.trim()
					: undefined,
			modelProvider:
				typeof parsed.model_provider === "string" &&
				parsed.model_provider.trim() !== ""
					? parsed.model_provider.trim()
					: undefined,
		};
	} catch {
		return { exists: true };
	}
}

function resolveSparkModelSource(codexHomeOverride?: string): string {
	const envDefault = process.env[OMX_DEFAULT_SPARK_MODEL_ENV];
	if (typeof envDefault === "string" && envDefault.trim() !== "") {
		return `${OMX_DEFAULT_SPARK_MODEL_ENV} env`;
	}
	const envLegacy = process.env[OMX_SPARK_MODEL_ENV];
	if (typeof envLegacy === "string" && envLegacy.trim() !== "") {
		return `${OMX_SPARK_MODEL_ENV} env`;
	}
	if (getEnvConfiguredSparkDefaultModel(process.env, codexHomeOverride)) {
		return ".omx-config.json env";
	}
	if (getConfiguredTeamLowComplexityModel(codexHomeOverride)) {
		return ".omx-config.json models.team_low_complexity";
	}
	return "built-in default";
}

function getInstallableSparkLaneAgentNames(): string[] {
	try {
		const installable = getInstallableNativeAgentNames(
			readCatalogManifest(getPackageRoot()),
		);
		return Object.values(AGENT_DEFINITIONS)
			.filter(
				(agent) => agent.modelClass === "fast" && installable.has(agent.name),
			)
			.map((agent) => agent.name)
			.sort();
	} catch {
		return Object.values(AGENT_DEFINITIONS)
			.filter((agent) => agent.modelClass === "fast")
			.map((agent) => agent.name)
			.sort();
	}
}

/**
 * Surface effective Spark/model lane routing and flag the common reasons the
 * `gpt-5.6-luna` quota stays unused even though resolution is wired
 * (issue #2757): a missing/stale installed Spark-lane agent toml, a model that
 * diverges from the resolved Spark default, or a non-default provider that does
 * not draw from native Spark quota.
 */
export function checkSparkRouting(paths: DoctorPaths): Check {
	const name = "Spark routing";
	const codexHomeOverride = paths.codexHomeDir;
	const sparkModel = getSparkDefaultModel(codexHomeOverride);
	const frontierModel = getMainDefaultModel(codexHomeOverride);
	const standardModel = getStandardDefaultModel(codexHomeOverride);
	const sparkSource = resolveSparkModelSource(codexHomeOverride);
	const rootProvider = getCodexConfigRootModelProvider(codexHomeOverride);
	const explicitSparkAgentOverrides = new Map(
		getInstallableSparkLaneAgentNames()
			.map((agentName) => [agentName, getAgentModelOverride(agentName, codexHomeOverride)] as const)
			.filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
	);

	const laneSummary =
		`lanes: frontier=\`${frontierModel}\`, standard=\`${standardModel}\`, ` +
		`spark=\`${sparkModel}\` (source: ${sparkSource})`;

	const sparkAgents = getInstallableSparkLaneAgentNames();
	if (sparkAgents.length === 0) {
		return {
			name,
			status: "warn",
			message:
				`${laneSummary}; no installable Spark-eligible (fast) native agent is defined, ` +
				`so native subagents will not consume Spark quota`,
		};
	}

	const problems: string[] = [];
	const wired: string[] = [];
	for (const agentName of sparkAgents) {
		const info = readInstalledAgentModelInfo(
			join(paths.agentsDir, `${agentName}.toml`),
		);
		if (!info.exists) {
			problems.push(
				`${agentName}.toml is missing under ${paths.agentsDir} (run \`omx setup --force\`)`,
			);
			continue;
		}
		if (!info.model) {
			problems.push(
				`${agentName}.toml has no model field (stale install; run \`omx setup --force\`)`,
			);
			continue;
		}
		const explicitOverride = explicitSparkAgentOverrides.get(agentName);
		if (explicitOverride) {
			if (info.model !== explicitOverride) {
				problems.push(
					`${agentName}.toml model is \`${info.model}\` but agentModels.${agentName} explicitly resolves to \`${explicitOverride}\` (stale install; run \`omx setup --force\`)`,
				);
				continue;
			}
			wired.push(
				`${agentName} -> \`${info.model}\` (agentModels override)${
					info.modelProvider ? ` (provider: ${info.modelProvider})` : ""
				}`,
			);
			continue;
		}
		if (info.model !== sparkModel) {
			problems.push(
				`${agentName}.toml model is \`${info.model}\` but the resolved Spark model is \`${sparkModel}\` (stale install; run \`omx setup --force\`)`,
			);
			continue;
		}
		if (info.modelProvider && rootProvider && info.modelProvider !== rootProvider) {
			problems.push(
				`${agentName}.toml model_provider \`${info.modelProvider}\` differs from the config root provider \`${rootProvider}\` (stale install; run \`omx setup --force\`)`,
			);
			continue;
		}
		if (info.modelProvider && info.modelProvider !== "openai") {
			problems.push(
				`${agentName}.toml routes Spark via non-default model_provider \`${info.modelProvider}\`; native Codex Spark quota only moves when Spark is served by the default provider`,
			);
			continue;
		}
		wired.push(
			`${agentName} -> \`${info.model}\`${
				info.modelProvider ? ` (provider: ${info.modelProvider})` : ""
			}`,
		);
	}

	if (problems.length > 0) {
		return {
			name,
			status: "warn",
			message: `${laneSummary}; Spark lane issue(s): ${problems.join("; ")}`,
		};
	}

	return {
		name,
		status: "pass",
		message:
			`${laneSummary}; Spark-lane native agent(s) wired: ${wired.join(", ")}. ` +
			`If Spark quota is still unused, the leader may not be delegating read-only lookups to the Spark lane, or the Codex usage view may lag.`,
	};
}

async function checkSkills(
	paths: DoctorPaths,
	installMode?: SetupInstallMode,
): Promise<Check> {
	if (installMode === "plugin") {
		return checkPluginMarketplaceRegistration(
			paths.configPath,
			paths.codexHomeDir,
		);
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
	const scopeFlag = scope === "project" ? "--scope project" : "--scope user";
	const repairMessage =
		`OMX AGENTS contract markers missing; file may have been overwritten by another tool. ` +
		`Run "omx setup ${scopeFlag} --merge-agents" to preserve local guidance while restoring OMX-managed sections, ` +
		`or "omx setup ${scopeFlag} --force" to replace it after backup.`;
	const pluginMissingAgentsRepairMessage =
		`persistent AGENTS.md is missing in plugin mode; session-scoped AGENTS.md can carry runtime overlay only, ` +
		`so durable orchestration guidance is degraded. Run "omx setup ${scopeFlag} --force" and accept AGENTS.md defaults`;

	if (scope === "user") {
		const userAgentsMd = join(codexHomeDir, "AGENTS.md");
		if (existsSync(userAgentsMd)) {
			const content = readFileSync(userAgentsMd, "utf-8");
			if (installMode === "plugin") {
				if (!hasOmxAgentsContract(content)) {
					return {
						name: "AGENTS.md",
						status: "warn",
						message: `${repairMessage} Path: ${userAgentsMd}`,
					};
				}
				return {
					name: "AGENTS.md",
					status: "pass",
					message: `persistent plugin-mode AGENTS.md found in ${userAgentsMd}`,
				};
			}
			if (!hasOmxAgentsContract(content)) {
				return {
					name: "AGENTS.md",
					status: "warn",
					message: `${repairMessage} Path: ${userAgentsMd}`,
				};
			}
			return {
				name: "AGENTS.md",
				status: "pass",
				message: `found OMX contract in ${userAgentsMd}`,
			};
		}
		if (installMode === "plugin") {
			return {
				name: "AGENTS.md",
				status: "fail",
				message: `${pluginMissingAgentsRepairMessage}. Path: ${userAgentsMd}`,
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
		const content = readFileSync(projectAgentsMd, "utf-8");
		if (installMode === "plugin") {
			if (!hasOmxAgentsContract(content)) {
				return {
					name: "AGENTS.md",
					status: "warn",
					message: `${repairMessage} Path: ${projectAgentsMd}`,
				};
			}
			return {
				name: "AGENTS.md",
				status: "pass",
				message: "persistent plugin-mode AGENTS.md found in project root",
			};
		}
		if (!hasOmxAgentsContract(content)) {
			return {
				name: "AGENTS.md",
				status: "warn",
				message: `${repairMessage} Path: ${projectAgentsMd}`,
			};
		}
		return {
			name: "AGENTS.md",
			status: "pass",
			message: "found OMX contract in project root",
		};
	}
	if (installMode === "plugin") {
		return {
			name: "AGENTS.md",
			status: "fail",
			message: `${pluginMissingAgentsRepairMessage}. Path: ${projectAgentsMd}`,
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

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pluginMcpServerEnabled(content: string, serverName: string): boolean | null {
	const headerPattern = new RegExp(
		`^\\s*\\[plugins\\.${escapeRegExp(JSON.stringify(OMX_LOCAL_PLUGIN_CONFIG_KEY))}\\.mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`,
	);
	const lines = content.split(/\r?\n/);
	const start = lines.findIndex((line) => headerPattern.test(line));
	if (start < 0) return null;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^\s*\[/.test(line)) break;
		const enabledMatch = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/);
		if (enabledMatch) return enabledMatch[1] === "true";
	}
	return null;
}

function describePluginMcpState(content: string, mcpMode?: SetupMcpMode): Check {
	const states = OMX_FIRST_PARTY_MCP_SERVER_NAMES.map((serverName) =>
		pluginMcpServerEnabled(content, serverName),
	);
	const enabledCount = states.filter((state) => state === true).length;
	const disabledCount = states.filter((state) => state === false).length;
	const missingCount = states.filter((state) => state === null).length;
	const expectedEnabled = mcpMode === "compat";

	if (expectedEnabled && missingCount === 0 && enabledCount === states.length) {
		return {
			name: "MCP Servers",
			status: "pass",
			message: `plugin MCP compatibility enabled by setup MCP mode compat (${enabledCount}/${states.length} first-party servers enabled)`,
		};
	}

	if (!expectedEnabled && enabledCount === 0) {
		return {
			name: "MCP Servers",
			status: "pass",
			message: `CLI-first plugin mode: first-party MCP compatibility explicitly disabled (${enabledCount}/${states.length} first-party servers enabled; ${disabledCount} disabled, ${missingCount} omitted)`,
		};
	}

	return {
		name: "MCP Servers",
		status: "warn",
		message: `plugin MCP compatibility overrides are incomplete or mixed (enabled=${enabledCount}, disabled=${disabledCount}, missing=${missingCount}); run "omx setup --plugin --force --mcp ${mcpMode ?? "none"}" to repair`,
	};
}

async function checkMcpServers(
	configPath: string,
	installMode?: SetupInstallMode,
	mcpMode?: SetupMcpMode,
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
			return describePluginMcpState(content, mcpMode);
		}
		if (mcpCount > 0) {
			const hasOmx = OMX_FIRST_PARTY_MCP_SERVER_NAMES.some((name) =>
				content.includes(`[mcp_servers.${name}]`),
			);
			if (hasOmx) {
				return {
					name: "MCP Servers",
					status: "pass",
					message: `${mcpCount} servers configured; first-party OMX MCP compatibility is explicitly present`,
				};
			}
			return {
				name: "MCP Servers",
				status: "pass",
				message: `${mcpCount} user-managed MCP server(s) preserved; first-party OMX MCP omitted by default`,
			};
		}
		return {
			name: "MCP Servers",
			status: "pass",
			message: "CLI-first default: no first-party OMX MCP servers configured",
		};
	} catch {
		return {
			name: "MCP Servers",
			status: "fail",
			message: "cannot read config.toml",
		};
	}
}
