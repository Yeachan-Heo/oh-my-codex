/**
 * omx setup - Automated installation of oh-my-codex
 * Installs skills, prompts, MCP servers config, and AGENTS.md
 */

import {
	mkdir,
	cp,
	copyFile,
	readdir,
	readFile,
	rename,
	writeFile,
	stat,
	lstat,
	rm,
	open,
	chmod,
} from "fs/promises";

import { join, dirname, relative, basename, isAbsolute, sep, win32 } from "path";

import { constants, existsSync } from "fs";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import { homedir } from "os";
import TOML from "@iarna/toml";
import { createHash } from "crypto";
import {
	clearNativeHookClaimJournal,
	persistNativeHookClaimJournal,
	recoverNativeHookClaimJournal,
	syncNativeHookClaimParent,
	restoreNativeHookClaimNoClobber,
} from "./native-hook-claim-journal.js";
import {
	codexHome,
	codexConfigPath,
	codexPromptsDir,
	codexAgentsDir,
	userSkillsDir,
	omxStateDir,
	detectLegacySkillRootOverlap,
	omxPlansDir,
	omxLogsDir,
} from "../utils/paths.js";
import {
	buildMergedConfig,
	getRootModelName,
	getRootTomlArray,
	hasLegacyOmxTeamRunTable,
	isOmxManagedNotifyCommand,
	sanitizePreviousNotifyCommand,
	stripExistingOmxBlocks,
	stripExistingSharedMcpRegistryBlock,
	mergeSharedMcpRegistryBlock,
	stripOmxEnvSettings,
	stripOmxFeatureFlags,
	stripOmxSeededBehavioralDefaults,
	upsertPluginModeRuntimeFeatureFlags,
	upsertManagedCodexHookTrustState,
	stripManagedCodexHookTrustState,
	OMX_DEVELOPER_INSTRUCTIONS,
	OMX_PLUGIN_DEVELOPER_INSTRUCTIONS,
	hasFirstPartyOmxMcpRegistrations,
	extractFirstPartyOmxMcpSections,
	stripFirstPartyOmxMcpSections,
} from "../config/generator.js";
import type { CodexHookFeatureFlag } from "../config/codex-feature-flags.js";
import {
	buildManagedCodexNativeHookWindowsShimContent,
	buildManagedCodexNativeHookWindowsShimPath,
	planManagedCodexHooksMerge,
	planManagedCodexHooksRemoval,
	classifyManagedCodexNativeHookWindowsShimOwnership,
	ManagedCodexHooksPlanError,
	type ManagedCodexHookTrustState,
	validateCodexHooksConfigStrict,
} from "../config/codex-hooks.js";

import {
	getLegacyUnifiedMcpRegistryCandidate,
	getUnifiedMcpRegistryCandidates,
	loadUnifiedMcpRegistry,
	planClaudeCodeMcpSettingsSync,
	type UnifiedMcpRegistryLoadResult,
} from "../config/mcp-registry.js";
import { generateAgentToml } from "../agents/native-config.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import {
	getCatalogAgentStatusByName,
	getInstallableNativeAgentNames,
	isNativeAgentInstallableStatus,
	isSetupPromptAssetName,
} from "../agents/policy.js";
import { getPackageRoot } from "../utils/package.js";
import { readSessionState, isSessionStale } from "../hooks/session.js";
import { getCatalogHeadlineCounts } from "./catalog-contract.js";
import { tryReadCatalogManifest } from "../catalog/reader.js";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import {
	teamModeEnabled,
	type SetupTeamMode,
} from "../config/team-mode.js";
import {
	addGeneratedAgentsMarker,
	hasOmxAgentsContract,
	hasOmxManagedAgentsSections,
	isOmxGeneratedAgentsMd,
	preserveUserOmxPolicyBlocks,
	upsertManagedAgentsBlock,
} from "../utils/agents-md.js";
import { DEFAULT_HUD_CONFIG, type HudPreset } from "../hud/types.js";
import {
	SETUP_INSTALL_MODES,
	SETUP_MCP_MODES,
	SETUP_SCOPES,
	getSetupScopeFilePath,
	readPersistedSetupPreferences,
	resolvePersistedSetupMergeAgents,
	writePersistedSetupPreferences,
	type PersistedSetupScope,
	type SetupInstallMode,
	type SetupMcpMode,
	type SetupScope,
} from "./setup-preferences.js";
import {
	OMX_LOCAL_MARKETPLACE_NAME,
	OMX_PLUGIN_NAME,
	materializePackagedOmxPluginCache,
	resolvePackagedOmxMarketplace,
	upsertLocalOmxMarketplaceRegistration,
	upsertLocalOmxPluginEnablement,
	upsertLocalOmxPluginMcpServerEnablement,
	hasLocalOmxPluginMcpServerRegistrations,
	pluginHookCacheMatchesPackaged,
} from "./plugin-marketplace.js";
import { resolveCodexHookFeatureSupportForCli } from "./codex-feature-probe.js";

async function resolveStatusLinePresetForSetup(
	projectRoot: string,
	options: Pick<SetupOptions, "force">,
): Promise<HudPreset | undefined> {
	if (options.force) {
		return DEFAULT_HUD_CONFIG.statusLine.preset;
	}
	const path = join(projectRoot, ".omx", "hud-config.json");
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(await readFile(path, "utf-8")) as {
			statusLine?: { preset?: unknown };
		};
		const preset = raw?.statusLine?.preset;
		if (preset === "minimal" || preset === "focused" || preset === "full") {
			return preset;
		}
	} catch {
		// Malformed hud-config.json — fall through to default.
	}
	return undefined;
}
import {
	resolveAgentsModelTableContext,
	upsertAgentsModelTable,
} from "../utils/agents-model-table.js";

type PluginDeveloperInstructionsDecisionAction = "add" | "update" | "preserve";

interface PluginDeveloperInstructionsDecision {
	action: PluginDeveloperInstructionsDecisionAction;
	state: "missing" | "current" | "historical" | "custom";
	reason: string;
}

interface SetupOptions {
	codexFeaturesProbe?: () => string | null;
	codexVersionProbe?: () => string | null;
	force?: boolean;
	mergeAgents?: boolean;
	mergeAgentsPolicy?: { kind: "set"; value: boolean } | { kind: "clear" };
	dryRun?: boolean;
	installMode?: SetupInstallMode;
	mcpMode?: SetupMcpMode;
	teamMode?: SetupTeamMode;
	scope?: SetupScope;
	verbose?: boolean;
	agentsOverwritePrompt?: (destinationPath: string) => Promise<boolean>;
	skipNativeAgentRefresh?: boolean;
	setupScopePrompt?: (defaultScope: SetupScope) => Promise<SetupScope>;
	persistedSetupReviewPrompt?: (
		preferences: Partial<PersistedSetupScope>,
	) => Promise<PersistedSetupReviewDecision>;
	installModePrompt?: (
		defaultMode: SetupInstallMode,
	) => Promise<SetupInstallMode>;
	modelUpgradePrompt?: (
		currentModel: string,
		targetModel: string,
	) => Promise<boolean>;
	pluginAgentsMdPrompt?: (destinationPath: string) => Promise<boolean>;
	pluginDeveloperInstructionsPrompt?: (
		configPath: string,
	) => Promise<boolean | "skip" | "preserve-or-add" | "refresh">;
	firstPartyMcpRemovalPrompt?: (
		configPath: string,
		registrationKinds: string[],
	) => Promise<boolean>;
	mcpRegistryCandidates?: string[];
}

export { SETUP_INSTALL_MODES, SETUP_MCP_MODES, SETUP_SCOPES };
export { SETUP_TEAM_MODES, type SetupTeamMode } from "../config/team-mode.js";
export type { SetupInstallMode, SetupMcpMode, SetupScope };

export interface ScopeDirectories {
	codexConfigFile: string;
	codexHomeDir: string;
	codexHooksFile: string;
	nativeAgentsDir: string;
	promptsDir: string;
	skillsDir: string;
}

interface SetupCategorySummary {
	updated: number;
	unchanged: number;
	backedUp: number;
	skipped: number;
	removed: number;
}

interface SetupRunSummary {
	prompts: SetupCategorySummary;
	skills: SetupCategorySummary;
	nativeAgents: SetupCategorySummary;
	agentsMd: SetupCategorySummary;
	config: SetupCategorySummary;
}

interface SetupBackupContext {
	backupRoot: string;
	baseRoot: string;
}

interface LegacySkillOverlapNotice {
	shouldWarn: boolean;
	message: string;
}

export interface SkillFrontmatterMetadata {
	name: string;
	description: string;
}

const PROJECT_GITIGNORE_ENTRIES = [
	".omx/",
	".codex/*",
	"!.codex/agents/",
	"!.codex/agents/**",
	"!.codex/skills/",
	"!.codex/skills/**",
	".codex/skills/.system/**",
	"!.codex/prompts/",
	"!.codex/prompts/**",
] as const;
const LEGACY_PROJECT_GITIGNORE_ENTRIES = [".codex/"] as const;
const SETUP_ONLY_INSTALLABLE_SKILLS = new Set(["wiki"]);
const DEFAULT_SETUP_MCP_MODE: SetupMcpMode = "none";
const SKIP_NATIVE_AGENT_REFRESH_ENV = "OMX_SKIP_NATIVE_AGENT_REFRESH";
const HARD_DEPRECATED_SKILL_NAMES = new Set(["web-clone"]);
const TEAM_MODE_SKILL_NAMES = new Set(["team", "worker"]);
const TEAM_MODE_PROMPT_NAMES = new Set(["team-executor"]);
const TEAM_MODE_NATIVE_AGENT_NAMES = new Set(["team-executor"]);

function isCatalogInstallableStatus(status: string | undefined): boolean {
	return status === "active" || status === "internal";
}

function getSetupInstallableSkillNames(
	manifest = tryReadCatalogManifest(),
): Set<string> {
	return new Set([
		...(manifest?.skills ?? [])
			.filter(
				(skill) =>
					typeof skill.name === "string" &&
					isCatalogInstallableStatus(skill.status),
			)
			.map((skill) => skill.name),
		...SETUP_ONLY_INSTALLABLE_SKILLS,
	]);
}

function applyScopePathRewritesToAgentsTemplate(
	content: string,
	scope: SetupScope,
): string {
	if (scope !== "project") return content;
	return content.replaceAll("~/.codex", "./.codex");
}

function applyPluginModeWordingToAgentsTemplate(
	content: string,
	scope: SetupScope,
): string {
	const scopedContent = applyScopePathRewritesToAgentsTemplate(content, scope);
	const userSkillPath =
		scope === "project"
			? "`./.codex/skills` for project scope, or `~/.codex/skills` for user-installed skills"
			: "`~/.codex/skills`";
	return scopedContent.replace(
		/Role prompts under `prompts\/\*\.md` are narrower execution surfaces\. They must follow this file, not override it\.\nWhen OMX is installed, load the installed prompt\/skill\/agent surfaces from [^\n]+active\)\./,
		`Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources when the plugin is installed. Native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works. They must follow this file, not override it.\nUser-installed skills may still live under ${userSkillPath}.`,
		);
}

function stripNamedXmlSection(content: string, sectionName: string): string {
	return content.replace(
		new RegExp(`\\n?<${sectionName}>[\\s\\S]*?<\\/${sectionName}>\\n?`, "g"),
		"\n",
	);
}

function applyTeamModeToAgentsTemplate(content: string, teamMode: SetupTeamMode): string {
	if (teamModeEnabled(teamMode)) return content;

	let next = content;
	for (const section of ["team_compositions", "team_pipeline", "team_model_resolution"]) {
		next = stripNamedXmlSection(next, section);
	}

	return next
		.replace(/\(\+ \$team if needed\)/g, "")
		.replace(/- `\$team` when[^\n]*\n/g, "")
		.replace(/,?\s*`team`,?/g, "")
		.replace(/\s*\|\s*`\$team ".*?"`\s*\|.*\|\n/g, "\n")
		.replace(/,?\s*`\$team`/g, "")
		.replace(/`\$team`,?\s*/g, "")
		.replace(/\/?\s*`team`\/`swarm`/g, "`swarm`")
		.split("\n")
		.filter((line) => {
			const normalized = line.toLowerCase();
			if (normalized.includes("team mode")) return false;
			if (normalized.includes("team runtime")) return false;
			if (normalized.includes("team orchestration")) return false;
			if (normalized.includes("team/swarm")) return false;
			if (normalized.includes("team pipeline")) return false;
			if (normalized.includes("runtime/team")) return false;
			if (normalized.includes("team overlays")) return false;
			if (normalized.includes("team pane")) return false;
			if (normalized.startsWith("- teams may ")) return false;
			if (normalized.includes("outside active `team`")) return false;
			if (normalized.includes("reserve `worker`")) return false;
			if (normalized.includes("worker` is a team-runtime")) return false;
			if (normalized.includes("team-plan")) return false;
			if (normalized.includes("omx team")) return false;
			return true;
		})
		.join("\n")
		.replace(/\n{3,}/g, "\n\n");
}

function getAgentsModelTableDefinitionsForTeamMode(teamMode: SetupTeamMode) {
	if (teamModeEnabled(teamMode)) return AGENT_DEFINITIONS;
	return Object.fromEntries(
		Object.entries(AGENT_DEFINITIONS).filter(
			([name]) => !TEAM_MODE_NATIVE_AGENT_NAMES.has(name),
		),
	);
}

interface ResolvedSetupScope {
	scope: SetupScope;
	source: "cli" | "persisted" | "prompt" | "default";
}

interface ResolvedSetupInstallMode {
	installMode: SetupInstallMode;
	source: "cli" | "persisted" | "prompt" | "default";
}

interface ResolvedSetupMcpMode {
	mcpMode: SetupMcpMode;
	source: "cli" | "persisted" | "default";
}

type PersistedSetupReviewDecision = "keep" | "review" | "reset";

const REQUIRED_TEAM_CLI_API_MARKERS = [
	"if (subcommand === 'api')",
	"executeTeamApiOperation",
	"TEAM_API_OPERATIONS",
] as const;

const DEFAULT_SETUP_SCOPE: SetupScope = "user";
const DEFAULT_SETUP_INSTALL_MODE: SetupInstallMode = "legacy";
const LEGACY_SETUP_MODELS = new Set(["gpt-5.3-codex", "gpt-5.5"]);
const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;
const OBSOLETE_NATIVE_AGENT_FIELD = ["skill", "ref"].join("_");
const GITHUB_AUTH_STATUS_TIMEOUT_MS = 2_000;

let cachedGitHubCliConfigured: boolean | undefined;

function createEmptyCategorySummary(): SetupCategorySummary {
	return {
		updated: 0,
		unchanged: 0,
		backedUp: 0,
		skipped: 0,
		removed: 0,
	};
}

function createEmptyRunSummary(): SetupRunSummary {
	return {
		prompts: createEmptyCategorySummary(),
		skills: createEmptyCategorySummary(),
		nativeAgents: createEmptyCategorySummary(),
		agentsMd: createEmptyCategorySummary(),
		config: createEmptyCategorySummary(),
	};
}

function getBackupContext(
	scope: SetupScope,
	projectRoot: string,
): SetupBackupContext {
	const timestamp = new Date().toISOString().replace(/[:]/g, "-");
	if (scope === "project") {
		return {
			backupRoot: join(projectRoot, ".omx", "backups", "setup", timestamp),
			baseRoot: projectRoot,
		};
	}
	return {
		backupRoot: join(homedir(), ".omx", "backups", "setup", timestamp),
		baseRoot: homedir(),
	};
}

function logManagedCodexHooksPlanDiagnostics(
	diagnostics: readonly { message: string }[] | undefined,
	options: Pick<SetupOptions, "verbose">,
): void {
	if (!options.verbose || !diagnostics) return;
	for (const diagnostic of diagnostics) {
		console.log(`  hook plan diagnostic: ${diagnostic.message}`);
	}
}

type NativeHookTransactionArtifactKind = "shim" | "hooks" | "config" | "metadata";
type NativeHookTransactionFailureStage =
	| "before_precondition"
	| "before_backup"
	| "before_temp_write"
	| "before_rename"
	| "after_final_rename_validation"
	| "after_rename"
	| "before_remove"
	| "after_final_remove_validation"
	| "after_remove"
	| "before_readback"
	| "before_rollback"
	| "before_rollback_rename"
	| "after_final_restore_validation"
	| "before_rollback_remove"
	| "before_staged_cleanup"
	| "after_staged_cleanup";


type NativeHookTransactionTopology =
	| { kind: "absent" }
	| { kind: "regular_file"; mode: number };

interface NativeHookTransactionArtifactSnapshot {
	bytes: Buffer | null;
	topology: NativeHookTransactionTopology;
	device?: number;
	inode?: number;
	links?: number;
}

interface NativeHookTransactionArtifact {
	kind: NativeHookTransactionArtifactKind;
	path: string;
	label: string;
	before: NativeHookTransactionArtifactSnapshot;
	after: Buffer | null;
	afterTopology: NativeHookTransactionTopology;
	hookPlatform?: NodeJS.Platform;
}

interface NativeHookTransactionPrecondition {
	kind: NativeHookTransactionArtifactKind;
	path: string;
	label: string;
	before: NativeHookTransactionArtifactSnapshot;
}


type NativeHookTransactionAncestorTopology =
	| { kind: "absent" }
	| { kind: "directory"; device: number; inode: number };

interface NativeHookTransactionAncestorSnapshot {
	path: string;
	topology: NativeHookTransactionAncestorTopology;
}

interface NativeHookTransactionAncestorPrecondition {
	controlledRoot: string;
	ancestorPaths: string[];
	snapshots: NativeHookTransactionAncestorSnapshot[];
}

interface AppliedNativeHookTransactionArtifact {
	artifact: NativeHookTransactionArtifact;
	appliedSnapshot: NativeHookTransactionArtifactSnapshot;
	stagedDeletionPath?: string;
	stagedDeletionSnapshot?: NativeHookTransactionArtifactSnapshot;
	stagedDeletionCleaned?: boolean;

}




let nativeHookTransactionFailureInjector:
	| ((
		stage: NativeHookTransactionFailureStage,
		target: NativeHookTransactionArtifact | NativeHookTransactionPrecondition,
	) => void)
	| undefined;
let nativeHookTransactionSequence = 0;
let nativeHookTransactionPlatformOverride: NodeJS.Platform | undefined;
let nativeHookTransactionTemporaryPathOverride:
	| ((path: string, purpose: "write" | "delete") => string)
	| undefined;
let setupLatePhaseFailureInjector: (() => void) | undefined;



/** @internal Test seam for deterministic atomic-write and rollback coverage. */
export function setNativeHookTransactionFailureInjectorForTest(
	injector:
		| ((
			stage: NativeHookTransactionFailureStage,
			target: NativeHookTransactionArtifact | NativeHookTransactionPrecondition,
		) => void)
		| undefined,
): () => void {
	const previous = nativeHookTransactionFailureInjector;
	nativeHookTransactionFailureInjector = injector;
	return () => {
		nativeHookTransactionFailureInjector = previous;
	};
}

/** @internal Test seam proving native artifacts commit only after later setup phases. */
export function setSetupLatePhaseFailureInjectorForTest(
	injector: (() => void) | undefined,
): () => void {
	const previous = setupLatePhaseFailureInjector;
	setupLatePhaseFailureInjector = injector;
	return () => {
		setupLatePhaseFailureInjector = previous;
	};
}

/** @internal Test seam for deterministic Windows transaction coverage. */
export function setNativeHookTransactionPlatformForTest(
	platform: NodeJS.Platform | undefined,
): () => void {
	const previous = nativeHookTransactionPlatformOverride;
	nativeHookTransactionPlatformOverride = platform;
	return () => {
		nativeHookTransactionPlatformOverride = previous;
	};
}

/** @internal Test seam for deterministic native transaction temporary-path coverage. */
export function setNativeHookTransactionTemporaryPathForTest(
	resolver:
		| ((path: string, purpose: "write" | "delete") => string)
		| undefined,


): () => void {
	const previous = nativeHookTransactionTemporaryPathOverride;
	nativeHookTransactionTemporaryPathOverride = resolver;
	return () => {
		nativeHookTransactionTemporaryPathOverride = previous;
	};
}

function nativeHookPlatform(): NodeJS.Platform {
	return nativeHookTransactionPlatformOverride ?? process.platform;
}

function hookTransactionBytesEqual(
	left: Buffer | null,
	right: Buffer | null,
): boolean {
	return left === null || right === null ? left === right : left.equals(right);
}

function nativeHookTransactionTopologyEqual(
	left: NativeHookTransactionTopology,
	right: NativeHookTransactionTopology,
): boolean {
	return left.kind === "absent" || right.kind === "absent"
		? left.kind === right.kind
		: left.mode === right.mode;
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}


function nativeHookTransactionArtifactAncestorPaths(
	controlledRoot: string,
	artifactPaths: readonly string[],
): string[] {
	const paths = new Set([controlledRoot]);
	for (const artifactPath of artifactPaths) {
		const parentPath = dirname(artifactPath);
		const fromControlledRoot = relative(controlledRoot, parentPath);
		if (
			fromControlledRoot === ".." ||
			fromControlledRoot.startsWith(`..${sep}`) ||
			isAbsolute(fromControlledRoot)
		) {
			continue;
		}
		let ancestorPath = controlledRoot;
		if (fromControlledRoot !== "") {
			for (const component of fromControlledRoot.split(sep)) {
				ancestorPath = join(ancestorPath, component);
				paths.add(ancestorPath);
			}
		}
	}
	return [...paths];
}

async function captureNativeHookTransactionAncestorSnapshots(
	ancestorPaths: readonly string[],
): Promise<NativeHookTransactionAncestorSnapshot[]> {
	const snapshots: NativeHookTransactionAncestorSnapshot[] = [];
	for (const path of ancestorPaths) {
		let status;
		try {
			status = await lstat(path);
		} catch (error) {
			if (isMissingPathError(error)) {
				snapshots.push({ path, topology: { kind: "absent" } });
				continue;
			}
			throw error;
		}
		if (status.isSymbolicLink()) {
			throw new Error(
				`Refusing native hook transaction: ancestor ${path} is a symbolic link.`,
			);
		}
		if (!status.isDirectory()) {
			throw new Error(
				`Refusing native hook transaction: ancestor ${path} is not a directory.`,
			);
		}
		snapshots.push({
			path,
			topology: { kind: "directory", device: status.dev, inode: status.ino },
		});
	}
	return snapshots;
}

function nativeHookTransactionAncestorTopologyEqual(
	left: NativeHookTransactionAncestorTopology,
	right: NativeHookTransactionAncestorTopology,
): boolean {
	return left.kind === "absent" || right.kind === "absent"
		? left.kind === right.kind
		: left.device === right.device && left.inode === right.inode;
}

async function captureNativeHookTransactionAncestorPrecondition(
	controlledRoot: string,
	artifactPaths: readonly string[],
): Promise<NativeHookTransactionAncestorPrecondition> {
	const ancestorPaths = nativeHookTransactionArtifactAncestorPaths(
		controlledRoot,
		artifactPaths,
	);
	return {
		controlledRoot,
		ancestorPaths,
		snapshots: await captureNativeHookTransactionAncestorSnapshots(ancestorPaths),
	};
}

async function assertNativeHookTransactionAncestorPrecondition(
	precondition: NativeHookTransactionAncestorPrecondition,
): Promise<void> {
	const actual = await captureNativeHookTransactionAncestorSnapshots(
		precondition.ancestorPaths,
	);
	for (let index = 0; index < precondition.snapshots.length; index += 1) {
		const expected = precondition.snapshots[index]!;
		const current = actual[index]!;
		if (!nativeHookTransactionAncestorTopologyEqual(current.topology, expected.topology)) {
			throw new Error(
				`Native hook transaction precondition changed for ancestor ${expected.path}; refusing to mutate a stale topology.`,
			);
		}
	}
}

async function refreshNativeHookTransactionAncestorPrecondition(
	precondition: NativeHookTransactionAncestorPrecondition,
	artifactPath: string,
): Promise<void> {
	const allowedCreatedPaths = new Set(
		nativeHookTransactionArtifactAncestorPaths(precondition.controlledRoot, [artifactPath]),
	);
	const actual = await captureNativeHookTransactionAncestorSnapshots(
		precondition.ancestorPaths,
	);
	for (let index = 0; index < precondition.snapshots.length; index += 1) {
		const expected = precondition.snapshots[index]!;
		const current = actual[index]!;
		if (nativeHookTransactionAncestorTopologyEqual(current.topology, expected.topology)) {
			continue;
		}
		if (
			expected.topology.kind === "absent" &&
			current.topology.kind === "directory" &&
			allowedCreatedPaths.has(expected.path)
		) {
			continue;
		}
		throw new Error(
			`Native hook transaction precondition changed for ancestor ${expected.path}; refusing to mutate a stale topology.`,
		);
	}
	precondition.snapshots = actual;
}

function decodeNativeHookTransactionUtf8(bytes: Buffer, label: string): string {
	try {
		const content = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
		if (!Buffer.from(content, "utf-8").equals(bytes)) {
			throw new Error("decoded text did not round-trip to the original bytes");
		}
		return content;
	} catch (error) {
		throw new ManagedCodexHooksPlanError(
			"invalid_document",
			`Refusing to read ${label}: invalid UTF-8 (${error instanceof Error ? error.message : String(error)}).`,
			{ label },
		);
	}
}

async function captureNativeHookTransactionArtifact(
	path: string,
	label: string,
): Promise<NativeHookTransactionArtifactSnapshot> {
	let before;
	try {
		before = await lstat(path);
	} catch (error) {
		if (isMissingPathError(error)) {
			return { bytes: null, topology: { kind: "absent" } };
		}
		throw error;
	}
	if (!before.isFile() || before.nlink !== 1) {
		throw new Error(
			`Refusing native hook transaction for ${label}: expected a single-link regular file or absence.`,
		);
	}
	const bytes = await readFile(path);
	const after = await lstat(path);
	const beforeTopology = {
		kind: "regular_file" as const,
		mode: before.mode & 0o7777,
	};
	const afterTopology = {
		kind: "regular_file" as const,
		mode: after.mode & 0o7777,
	};
	if (
		!after.isFile() ||
		after.nlink !== 1 ||
		!nativeHookTransactionTopologyEqual(beforeTopology, afterTopology) ||
		before.dev !== after.dev ||
		before.ino !== after.ino ||
		before.nlink !== after.nlink
	) {
		throw new Error(
			`Refusing native hook transaction for ${label}: path changed while its snapshot was read.`,
		);
	}
	return {
		bytes,
		topology: beforeTopology,
		device: before.dev,
		inode: before.ino,
		links: before.nlink,
	};
}

function nativeHookTransactionSnapshotsEqual(
	left: NativeHookTransactionArtifactSnapshot,
	right: NativeHookTransactionArtifactSnapshot,
): boolean {
	return (
		hookTransactionBytesEqual(left.bytes, right.bytes) &&
		nativeHookTransactionTopologyEqual(left.topology, right.topology) &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.links === right.links
	);
}

function nativeHookTransactionSnapshotMatchesExpected(
	snapshot: NativeHookTransactionArtifactSnapshot,
	expected: Pick<NativeHookTransactionArtifactSnapshot, "bytes" | "topology">,
): boolean {
	return (
		hookTransactionBytesEqual(snapshot.bytes, expected.bytes) &&
		nativeHookTransactionTopologyEqual(snapshot.topology, expected.topology)
	);
}

function nativeHookTransactionOutputTopology(
	before: NativeHookTransactionArtifactSnapshot,
	after: Buffer | null,
): NativeHookTransactionTopology {
	if (after === null) return { kind: "absent" };
	return {
		kind: "regular_file",
		mode: before.topology.kind === "regular_file" ? before.topology.mode : 0o600,
	};
}

function nativeHookTransactionArtifact(
	kind: NativeHookTransactionArtifactKind,
	path: string,
	label: string,
	before: NativeHookTransactionArtifactSnapshot,
	after: Buffer | null,
	hookPlatform?: NodeJS.Platform,
): NativeHookTransactionArtifact | null {
	return hookTransactionBytesEqual(before.bytes, after)
		? null
		: {
			kind,
			path,
			label,
			before,
			after,
			afterTopology: nativeHookTransactionOutputTopology(before, after),
			hookPlatform,
		};
}

function nativeHookTransactionPrecondition(
	kind: NativeHookTransactionArtifactKind,
	path: string,
	label: string,
	before: NativeHookTransactionArtifactSnapshot,
): NativeHookTransactionPrecondition {
	return { kind, path, label, before };
}

function assertWindowsNativeHookShimOwnership(
	shimPath: string,
	before: Buffer | null,
	expected: Buffer,
): void {
	if (before === null) return;
	const ownership = classifyManagedCodexNativeHookWindowsShimOwnership(
		before,
		expected,
	);
	if (ownership === "current" || ownership === "historical") return;
	throw new Error(
		`Refusing to replace modified Windows native hook shim ${shimPath}. Restore the complete OMX-generated shim or remove it after verifying no foreign hook references it.`,
	);
}

type WindowsNativeHookShimReferenceDecision =
	| "not_referenced"
	| "referenced"
	| "ambiguous";

function isWindowsShimReferenceRecord(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeWindowsShimReferencePath(path: string): string | null {
	const windowsPath = path.replace(/\//g, "\\");
	if (
		windowsPath.length === 0 ||
		/[\0-\x1f\x7f-\x9f`<>"|?*]/.test(windowsPath) ||
		/^\\\\\.(?:\\|$)/.test(windowsPath)
	) {
		return null;
	}
	const isDriveAbsolute = /^[A-Za-z]:\\(?:[^\\:]+(?:\\[^\\:]+)*)?$/.test(windowsPath);
	const isUncAbsolute = /^\\\\[^\\:]+\\[^\\:]+(?:\\[^\\:]+)*$/.test(windowsPath);
	if (!isDriveAbsolute && !isUncAbsolute) return null;
	return win32.normalize(windowsPath).toLowerCase();
}

function windowsShimPathBasename(path: string): string | null {
	const name = win32.basename(path.replace(/\//g, "\\")).replace(/[. ]+$/, "");
	return name.length > 0 ? name.toLowerCase() : null;
}

function decodePowerShellSingleQuotedLiteral(value: string): string {
	return value.replace(/''/g, "'");
}

/**
 * Parses the only foreign command form that proves its -File target is a
 * static literal. All other PowerShell forms remain ambiguous because they can
 * construct an executable target dynamically or through a nested evaluator.
 */
function decodeWindowsShimReferencePath(command: string): string | null {
	if (/["`]/.test(command)) return null;
	const match = command.match(
		/^\s*&\s+'((?:''|[^'\r\n])*)'\s+-noprofile\s+-executionpolicy\s+bypass\s+-file\s+'((?:''|[^'\r\n])*)'\s*$/i,
	);
	if (!match) return null;
	const powerShellPath = decodePowerShellSingleQuotedLiteral(match[1]);
	if (
		windowsShimPathBasename(powerShellPath) !== "powershell.exe" ||
		normalizeWindowsShimReferencePath(powerShellPath) === null ||
		hasPotentialWindowsPathAlias(powerShellPath)
	) {
		return null;
	}
	return decodePowerShellSingleQuotedLiteral(match[2]);
}

function hasPotentialWindowsPathAlias(path: string): boolean {
	const windowsPath = path.replace(/\//g, "\\");
	return windowsPath.split("\\").some(
		(component) =>
			component === "." ||
			component === ".." ||
			/[. ]$/.test(component) ||
			/~\d+(?:\.[^\\]*)?$/i.test(component),
	);
}

function windowsShimCommandReferenceDecision(
	command: string,
	shimPath: string,
): WindowsNativeHookShimReferenceDecision {
	const decodedShimPath = decodeWindowsShimReferencePath(command);
	if (decodedShimPath === null) return "ambiguous";

	const normalizedDecodedPath = normalizeWindowsShimReferencePath(decodedShimPath);
	const normalizedShimPath = normalizeWindowsShimReferencePath(shimPath);
	if (normalizedDecodedPath === null || normalizedShimPath === null) {
		return "ambiguous";
	}
	if (normalizedDecodedPath === normalizedShimPath) return "referenced";

	// A distinct fully qualified spelling is not proof that the foreign target
	// cannot resolve to this shim: reparse points, SUBST, mapped drives, and UNC
	// aliases can all refer to the same file. No race-safe file-identity proof is
	// available here, so preserve the proof-owned shim.
	return "ambiguous";
}

/**
 * Decides whether a proof-owned Windows shim must remain after a hooks.json
 * transition. JSON is strictly validated and decoded before inspection so
 * escaped paths are handled semantically. Unknown future event members are
 * scanned only through the established executable group/command shape; prompt
 * and agent payloads remain inert metadata.
 */
export function decideWindowsNativeHookShimReference(
	finalHooksContent: string | null,
	shimPath: string,
): WindowsNativeHookShimReferenceDecision {
	if (finalHooksContent === null) return "not_referenced";
	const validation = validateCodexHooksConfigStrict(finalHooksContent, {
		platform: "win32",
	});
	if (!validation.ok) return "ambiguous";
	const hooks = validation.root.hooks;
	if (!isWindowsShimReferenceRecord(hooks)) return "not_referenced";

	let ambiguous = false;
	for (const eventGroups of Object.values(hooks)) {
		if (!Array.isArray(eventGroups)) continue;
		for (const group of eventGroups) {

			if (
				!isWindowsShimReferenceRecord(group) ||
				!Array.isArray(group.hooks)
			) {
				continue;
			}

			for (const handler of group.hooks) {
				if (
					!isWindowsShimReferenceRecord(handler) ||
					handler.type !== "command"
				) {
					continue;
				}
				for (const command of [
					handler.commandWindows,
					handler.command_windows,
					handler.command,
				]) {
					if (typeof command !== "string") continue;
					const decision = windowsShimCommandReferenceDecision(command, shimPath);
					if (decision === "referenced") return decision;
					if (decision === "ambiguous") ambiguous = true;
				}
			}
		}
	}
	return ambiguous ? "ambiguous" : "not_referenced";
}

function preflightManagedCodexHookTrustState(
	config: string,
	priorManagedHookTrustState: Record<string, ManagedCodexHookTrustState>,
	managedHookTrustState: Record<string, ManagedCodexHookTrustState>,
): void {
	stripManagedCodexHookTrustState(config, {
		priorManagedHookTrustState,
		managedTrustState: managedHookTrustState,
	});
}

function injectNativeHookTransactionFailure(
	stage: NativeHookTransactionFailureStage,
	target: NativeHookTransactionArtifact | NativeHookTransactionPrecondition,
): void {
	nativeHookTransactionFailureInjector?.(stage, target);
}

function nativeHookTransactionTemporaryPath(
	path: string,
	purpose: "write" | "delete",
): string {
	if (nativeHookTransactionTemporaryPathOverride) {
		return nativeHookTransactionTemporaryPathOverride(path, purpose);
	}
	nativeHookTransactionSequence += 1;
	return join(
		dirname(path),
		`.${basename(path)}.omx-${purpose}-${process.pid}-${nativeHookTransactionSequence}.tmp`,
	);
}

function nativeHookTransactionClaimPath(path: string): string {
	nativeHookTransactionSequence += 1;
	return join(
		dirname(path),
		`.${basename(path)}.omx-claim-${process.pid}-${nativeHookTransactionSequence}.tmp`,
	);
}

async function restoreNativeHookClaim(claimPath: string, destinationPath: string): Promise<void> {
	await restoreNativeHookClaimNoClobber(claimPath, destinationPath);
}


async function atomicWriteNativeHookTransactionArtifact(
	artifact: NativeHookTransactionArtifact,
	content: Buffer,
	stage: "write" | "rollback",
	expectedCurrent: NativeHookTransactionArtifactSnapshot,
	ancestorPrecondition: NativeHookTransactionAncestorPrecondition,
	onWriteApplied?: (snapshot: NativeHookTransactionArtifactSnapshot) => void,
	onWriteStabilized?: (snapshot: NativeHookTransactionArtifactSnapshot) => void,
	assertApplied?: () => Promise<void>,

): Promise<void> {
	const temporaryPath = nativeHookTransactionTemporaryPath(artifact.path, "write");
	let temporaryCreated = false;
	let temporarySnapshot: NativeHookTransactionArtifactSnapshot | undefined;
	let claimPath: string | undefined;
	let claimCreated = false;
	let journaledClaim = false;
	try {
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertApplied?.();
		await mkdir(dirname(artifact.path), { recursive: true });
		await refreshNativeHookTransactionAncestorPrecondition(
			ancestorPrecondition,
			artifact.path,
		);

		if (stage === "write") {
			injectNativeHookTransactionFailure("before_temp_write", artifact);
		} else {
			injectNativeHookTransactionFailure("before_rollback", artifact);
		}
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			expectedCurrent,
			stage === "write" ? "precondition" : "rollback",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertApplied?.();

		const handle = await open(
			temporaryPath,
			"wx",
			artifact.afterTopology.kind === "regular_file"
				? artifact.afterTopology.mode
				: 0o600,
		);
		temporaryCreated = true;
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (artifact.afterTopology.kind === "regular_file") {
			await chmod(temporaryPath, artifact.afterTopology.mode);
		}
		temporarySnapshot = await assertNativeHookTransactionArtifactState(
			temporaryPath,
			`${artifact.label} temporary`,
			{ bytes: content, topology: artifact.afterTopology },
			"read-back",
		);
		if (stage === "write") {
			injectNativeHookTransactionFailure("before_rename", artifact);
		} else {
			injectNativeHookTransactionFailure("before_rollback_rename", artifact);
		}
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			expectedCurrent,
			stage === "write" ? "precondition" : "rollback",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertNativeHookTransactionArtifactSnapshot(
			temporaryPath,
			`${artifact.label} temporary`,
			temporarySnapshot,
			"read-back",
		);
		await assertApplied?.();
		if (!temporarySnapshot) {
			throw new Error("temporary path was not fully captured after writing");
		}
		injectNativeHookTransactionFailure(
			stage === "write"
				? "after_final_rename_validation"
				: "after_final_restore_validation",
			artifact,
		);
		claimPath = nativeHookTransactionClaimPath(artifact.path);
		const claimRelativePath = relative(ancestorPrecondition.controlledRoot, artifact.path);
		const canJournalClaim =
			!isAbsolute(claimRelativePath) &&
			claimRelativePath !== ".." &&
			!claimRelativePath.startsWith(`..${sep}`);
		if (expectedCurrent.bytes !== null) {
			if (canJournalClaim) {
				await persistNativeHookClaimJournal(ancestorPrecondition.controlledRoot, {
					canonicalPath: artifact.path,
					claimPath,
					before: expectedCurrent.bytes,
					after: content,
				});
				await refreshNativeHookTransactionAncestorPrecondition(
					ancestorPrecondition,
					join(ancestorPrecondition.controlledRoot, ".omx", "native-hook-claim-journal.json"),
				);
				journaledClaim = true;
			}
			await rename(artifact.path, claimPath);
			claimCreated = true;
			if (journaledClaim) await syncNativeHookClaimParent(claimPath);
			await assertNativeHookTransactionArtifactSnapshot(
				claimPath,
				`${artifact.label} replacement claim`,
				expectedCurrent,
				stage === "write" ? "precondition" : "rollback",
			);
		}
		await copyFile(temporaryPath, artifact.path, constants.COPYFILE_EXCL);
		if (artifact.afterTopology.kind === "regular_file") {
			await chmod(artifact.path, artifact.afterTopology.mode);
		}
		const installedHandle = await open(artifact.path, "r");
		try {
			await installedHandle.sync();
		} finally {
			await installedHandle.close();
		}
		await syncNativeHookClaimParent(artifact.path);
		const installedSnapshot = await assertNativeHookTransactionArtifactState(
			artifact.path,
			artifact.label,
			{ bytes: content, topology: artifact.afterTopology },
			stage === "write" ? "precondition" : "rollback",
		);
		if (claimCreated && claimPath) {
			await rm(claimPath);
			await syncNativeHookClaimParent(claimPath);
			claimCreated = false;
		}
		if (journaledClaim) {
			await clearNativeHookClaimJournal(ancestorPrecondition.controlledRoot);
			journaledClaim = false;
		}
		await rm(temporaryPath);
		temporaryCreated = false;
		onWriteApplied?.(installedSnapshot);
		onWriteStabilized?.(installedSnapshot);

		if (stage === "write") {
			injectNativeHookTransactionFailure("after_rename", artifact);
		}
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			installedSnapshot,
			stage === "write" ? "precondition" : "rollback",
		);
	} catch (error) {
		if (claimCreated && claimPath) {
			try {
				await restoreNativeHookClaim(claimPath, artifact.path);
				await syncNativeHookClaimParent(artifact.path);
				claimCreated = false;
				if (journaledClaim) {
					await clearNativeHookClaimJournal(ancestorPrecondition.controlledRoot);
					journaledClaim = false;
				}
			} catch (recoveryError) {
				throw new Error(
					`Native hook transaction ${stage} failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		}
		if (temporaryCreated) {
			try {
				if (!temporarySnapshot) {
					throw new Error("temporary path was not fully captured after writing");
				}
				await assertNativeHookTransactionArtifactSnapshot(
					temporaryPath,
					`${artifact.label} temporary`,
					temporarySnapshot,
					"read-back",
				);
				await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
				await rm(temporaryPath);
			} catch (cleanupError) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Native hook transaction ${stage} failed (${message}) and preserved temporary ${temporaryPath} for manual recovery after cleanup verification failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
		throw error;
	}
}


async function assertNativeHookTransactionArtifactState(
	path: string,
	label: string,
	expected: Pick<NativeHookTransactionArtifactSnapshot, "bytes" | "topology">,
	context: "precondition" | "rollback" | "read-back",
): Promise<NativeHookTransactionArtifactSnapshot> {
	const actual = await captureNativeHookTransactionArtifact(path, label);
	if (!nativeHookTransactionSnapshotMatchesExpected(actual, expected)) {
		if (context === "rollback") {
			throw new Error(
				`Native hook transaction rollback preserved ${path} for manual recovery because ${label} no longer matches the transaction-owned version.`,
			);
		}
		throw new Error(
			`Native hook transaction ${context} changed for ${label}; refusing to overwrite concurrent content.`,
		);
	}
	return actual;
}
async function assertNativeHookTransactionArtifactSnapshot(
	path: string,
	label: string,
	expected: NativeHookTransactionArtifactSnapshot,
	context: "precondition" | "rollback" | "read-back",
): Promise<NativeHookTransactionArtifactSnapshot> {
	const actual = await captureNativeHookTransactionArtifact(path, label);
	if (!nativeHookTransactionSnapshotsEqual(actual, expected)) {
		if (context === "rollback") {
			throw new Error(
				`Native hook transaction rollback preserved ${path} for manual recovery because ${label} no longer matches the transaction-owned version.`,
			);
		}
		throw new Error(
			`Native hook transaction ${context} changed for ${label}; refusing to overwrite concurrent content.`,
		);
	}
	return actual;
}

async function assertNativeHookTransactionPrecondition(
	precondition: NativeHookTransactionPrecondition,
): Promise<void> {
	await assertNativeHookTransactionArtifactSnapshot(
		precondition.path,
		precondition.label,
		precondition.before,
		"precondition",
	);
}

async function assertUnmutatedNativeHookTransactionPreconditions(
	preconditions: readonly NativeHookTransactionPrecondition[],
	applied: readonly AppliedNativeHookTransactionArtifact[],
): Promise<void> {
	const mutatedPaths = new Set(applied.map((entry) => entry.artifact.path));
	for (const precondition of preconditions) {
		if (mutatedPaths.has(precondition.path)) continue;
		await assertNativeHookTransactionPrecondition(precondition);
	}
}

async function assertAppliedNativeHookTransactionSnapshots(
	applied: readonly AppliedNativeHookTransactionArtifact[],
): Promise<void> {
	for (const entry of applied) {
		await assertNativeHookTransactionArtifactSnapshot(
			entry.artifact.path,
			entry.artifact.label,
			entry.appliedSnapshot,
			"precondition",
		);
	}
}

async function assertNativeHookTransactionStagedRecoveryCopies(
	applied: readonly AppliedNativeHookTransactionArtifact[],
): Promise<void> {
	for (const entry of applied) {
		if (
			!entry.stagedDeletionPath ||
			!entry.stagedDeletionSnapshot ||
			entry.stagedDeletionCleaned
		) {
			continue;
		}
		await assertNativeHookTransactionArtifactSnapshot(
			entry.stagedDeletionPath,
			`${entry.artifact.label} staged deletion`,
			entry.stagedDeletionSnapshot,
			"rollback",
		);
	}
}

async function assertNativeHookTransactionRollbackState(
	applied: readonly AppliedNativeHookTransactionArtifact[],
): Promise<void> {
	await assertNativeHookTransactionStagedRecoveryCopies(applied);
	await assertAppliedNativeHookTransactionSnapshots(applied);
}


async function applyNativeHookTransactionArtifact(
	artifact: NativeHookTransactionArtifact,
	ancestorPrecondition: NativeHookTransactionAncestorPrecondition,
	applied: AppliedNativeHookTransactionArtifact[],
): Promise<AppliedNativeHookTransactionArtifact> {
	await assertNativeHookTransactionArtifactSnapshot(
		artifact.path,
		artifact.label,
		artifact.before,
		"precondition",
	);
	await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);

	if (artifact.after !== null) {
		let entry: AppliedNativeHookTransactionArtifact | undefined;
		await atomicWriteNativeHookTransactionArtifact(
			artifact,
			artifact.after,
			"write",
			artifact.before,
			ancestorPrecondition,
			(appliedSnapshot) => {
				entry = { artifact, appliedSnapshot };
				applied.push(entry);
			},
			(stabilizedSnapshot) => {
				if (!entry) {
					throw new Error("native hook transaction write was not registered as applied");
				}
				entry.appliedSnapshot = stabilizedSnapshot;
			},
			() => assertAppliedNativeHookTransactionSnapshots(applied),
		);
		if (!entry) {
			throw new Error("native hook transaction write was not registered as applied");
		}
		return entry;
	}

	const stagedDeletionPath = nativeHookTransactionTemporaryPath(artifact.path, "delete");
	let stagedDeletionCreated = false;
	let originalRemoved = false;
	let stagedDeletionSnapshot: NativeHookTransactionArtifactSnapshot | undefined;
	try {
		injectNativeHookTransactionFailure("before_temp_write", artifact);
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			artifact.before,
			"precondition",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertAppliedNativeHookTransactionSnapshots(applied);

		const handle = await open(
			stagedDeletionPath,
			"wx",
			artifact.before.topology.kind === "regular_file"
				? artifact.before.topology.mode
				: 0o600,
		);
		stagedDeletionCreated = true;
		try {
			await handle.writeFile(artifact.before.bytes!);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (artifact.before.topology.kind === "regular_file") {
			await chmod(stagedDeletionPath, artifact.before.topology.mode);
		}
		stagedDeletionSnapshot = await assertNativeHookTransactionArtifactState(
			stagedDeletionPath,
			`${artifact.label} staged deletion`,
			{ bytes: artifact.before.bytes, topology: artifact.before.topology },
			"read-back",
		);
		injectNativeHookTransactionFailure("before_remove", artifact);
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			artifact.before,
			"precondition",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertNativeHookTransactionArtifactSnapshot(
			stagedDeletionPath,
			`${artifact.label} staged deletion`,
			stagedDeletionSnapshot,
			"read-back",
		);
		await assertAppliedNativeHookTransactionSnapshots(applied);
		injectNativeHookTransactionFailure("after_final_remove_validation", artifact);
		await assertNativeHookTransactionArtifactSnapshot(
			stagedDeletionPath,
			`${artifact.label} staged deletion`,
			stagedDeletionSnapshot,
			"read-back",
		);
		const claimPath = nativeHookTransactionClaimPath(artifact.path);


		const claimRelativePath = relative(ancestorPrecondition.controlledRoot, artifact.path);
		const journaledClaim =
			!isAbsolute(claimRelativePath) &&
			claimRelativePath !== ".." &&
			!claimRelativePath.startsWith(`..${sep}`);
		if (journaledClaim) {
			await persistNativeHookClaimJournal(ancestorPrecondition.controlledRoot, {
				canonicalPath: artifact.path,
				claimPath,
				before: artifact.before.bytes!,
				after: null,
			});
		}
		await rename(artifact.path, claimPath);
		if (journaledClaim) await syncNativeHookClaimParent(claimPath);
		const entry: AppliedNativeHookTransactionArtifact = {
			artifact,
			appliedSnapshot: { bytes: null, topology: { kind: "absent" } },
			stagedDeletionPath,
			stagedDeletionSnapshot,
		};
		applied.push(entry);
		try {


			await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);

			await assertNativeHookTransactionArtifactSnapshot(
				claimPath,
				`${artifact.label} removal claim`,
				artifact.before,
				"precondition",
			);
		} catch (error) {

			try {
				const claimed = await captureNativeHookTransactionArtifact(
					claimPath,
					`${artifact.label} removal claim`,
				);
				await restoreNativeHookClaim(claimPath, artifact.path);
				if (journaledClaim) await syncNativeHookClaimParent(artifact.path);
				if (journaledClaim) {
					await clearNativeHookClaimJournal(ancestorPrecondition.controlledRoot);
				}
				await assertNativeHookTransactionArtifactSnapshot(
					artifact.path,
					artifact.label,
					claimed,
					"precondition",
				);
				const entryIndex = applied.indexOf(entry);
				if (entryIndex >= 0) applied.splice(entryIndex, 1);
			} catch (recoveryError) {
				throw new Error(
					`Native hook transaction removal claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
			throw error;

		}
		await rm(claimPath);
		if (journaledClaim) await syncNativeHookClaimParent(claimPath);
		if (journaledClaim) {
			await clearNativeHookClaimJournal(ancestorPrecondition.controlledRoot);
		}
		originalRemoved = true;
		injectNativeHookTransactionFailure("after_remove", artifact);
		return entry;
	} catch (error) {
		if (stagedDeletionCreated && !originalRemoved) {
			try {
				if (!stagedDeletionSnapshot) {
					throw new Error("staged deletion path was not fully captured after writing");
				}
				await assertNativeHookTransactionArtifactSnapshot(
					stagedDeletionPath,
					`${artifact.label} staged deletion`,
					stagedDeletionSnapshot,
					"read-back",
				);
				await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
				const claimPath = nativeHookTransactionClaimPath(artifact.path);

				await rename(stagedDeletionPath, claimPath);
				try {
					await assertNativeHookTransactionArtifactSnapshot(
						claimPath,
						`${artifact.label} staged deletion cleanup claim`,
						stagedDeletionSnapshot,
						"read-back",
					);
				} catch (claimError) {
					try {
						await restoreNativeHookClaim(claimPath, stagedDeletionPath);
					} catch (recoveryError) {
						throw new Error(
							`Native hook transaction staged deletion cleanup claim failed (${claimError instanceof Error ? claimError.message : String(claimError)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
						);
					}
					throw claimError;
				}
				await rm(claimPath);
			} catch (cleanupError) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Native hook transaction failed (${message}) and preserved staged deletion ${stagedDeletionPath} for manual recovery after cleanup verification failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
		throw error;
	}
}

async function verifyNativeHookTransactionArtifact(
	applied: AppliedNativeHookTransactionArtifact,
): Promise<void> {
	const { artifact } = applied;
	injectNativeHookTransactionFailure("before_readback", artifact);
	const actual = await captureNativeHookTransactionArtifact(artifact.path, artifact.label);
	if (!nativeHookTransactionSnapshotsEqual(actual, applied.appliedSnapshot)) {
		throw new Error(
			`Native hook transaction read-back changed for ${artifact.label}; refusing to overwrite concurrent content.`,
		);
	}
	if (artifact.after === null) return;
	const content = decodeNativeHookTransactionUtf8(actual.bytes!, artifact.label);
	if (artifact.kind === "hooks") {
		const validation = validateCodexHooksConfigStrict(content, {
			platform: artifact.hookPlatform,
		});
		if (!validation.ok) {
			throw new Error(
				`Native hook transaction wrote invalid hooks.json: ${validation.error.message}`,
			);
		}
	}
	if (artifact.kind === "config") TOML.parse(content);
}

async function restoreNativeHookTransactionArtifact(
	applied: AppliedNativeHookTransactionArtifact,
	ancestorPrecondition: NativeHookTransactionAncestorPrecondition,
	assertRollbackState: () => Promise<void>,
): Promise<void> {
	const { artifact } = applied;
	const current = await captureNativeHookTransactionArtifact(artifact.path, artifact.label);
	if (!nativeHookTransactionSnapshotsEqual(current, applied.appliedSnapshot)) {
		throw new Error(
			`Native hook transaction rollback preserved ${artifact.path} for manual recovery because ${artifact.label} no longer matches the transaction-owned version.`,
		);
	}
	if (artifact.before.bytes === null) {
		injectNativeHookTransactionFailure("before_rollback", artifact);
		injectNativeHookTransactionFailure("before_rollback_remove", artifact);
		await assertNativeHookTransactionArtifactSnapshot(
			artifact.path,
			artifact.label,
			applied.appliedSnapshot,
			"rollback",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertRollbackState();
		injectNativeHookTransactionFailure("after_final_restore_validation", artifact);
		const claimPath = nativeHookTransactionClaimPath(artifact.path);

		await rename(artifact.path, claimPath);
		applied.appliedSnapshot = { bytes: null, topology: { kind: "absent" } };
		try {


			await assertNativeHookTransactionArtifactSnapshot(
				claimPath,
				`${artifact.label} rollback removal claim`,
				current,
				"rollback",
			);
		} catch (error) {
			try {
				const claimed = await captureNativeHookTransactionArtifact(
					claimPath,
					`${artifact.label} rollback removal claim`,
				);
				await restoreNativeHookClaim(claimPath, artifact.path);
				await assertNativeHookTransactionArtifactSnapshot(
					artifact.path,
					artifact.label,
					claimed,
					"rollback",
				);
			} catch (recoveryError) {
				throw new Error(
					`Native hook transaction rollback removal claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
			throw error;
		}
		await rm(claimPath);
	} else {
		const restoreArtifact: NativeHookTransactionArtifact = {
			...artifact,
			after: artifact.before.bytes,
			afterTopology: artifact.before.topology,
		};
		await atomicWriteNativeHookTransactionArtifact(
			restoreArtifact,
			artifact.before.bytes,
			"rollback",
			applied.appliedSnapshot,
			ancestorPrecondition,
			(restoredSnapshot) => {
				applied.appliedSnapshot = restoredSnapshot;
			},
			(stabilizedSnapshot) => {
				applied.appliedSnapshot = stabilizedSnapshot;
			},
			assertRollbackState,
		);
	}
	const restored = await assertNativeHookTransactionArtifactSnapshot(
		artifact.path,
		artifact.label,
		applied.appliedSnapshot,
		"rollback",
	);
	if (
		!nativeHookTransactionSnapshotMatchesExpected(restored, {
			bytes: artifact.before.bytes,
			topology: artifact.before.topology,
		})
	) {
		throw new Error(
			`Native hook transaction rollback preserved ${artifact.path} for manual recovery because ${artifact.label} no longer matches the expected restored version.`,
		);
	}
}

async function cleanupNativeHookTransactionStagedDeletions(
	applied: readonly AppliedNativeHookTransactionArtifact[],
	ancestorPrecondition: NativeHookTransactionAncestorPrecondition,
	preconditions?: readonly NativeHookTransactionPrecondition[],
	rollbackApplied?: readonly AppliedNativeHookTransactionArtifact[],
): Promise<void> {
	for (const entry of applied) {
		if (
			!entry.stagedDeletionPath ||
			!entry.stagedDeletionSnapshot ||
			entry.stagedDeletionCleaned
		) {
			continue;
		}
		injectNativeHookTransactionFailure("before_staged_cleanup", entry.artifact);
		if (preconditions) {
			await assertUnmutatedNativeHookTransactionPreconditions(
				preconditions,
				applied,
			);
			await assertAppliedNativeHookTransactionSnapshots(applied);
		}

		if (rollbackApplied) {
			await assertNativeHookTransactionRollbackState(rollbackApplied);
		}
		const stagedDeletionPath = entry.stagedDeletionPath;
		const stagedDeletionSnapshot = entry.stagedDeletionSnapshot;
		await assertNativeHookTransactionArtifactSnapshot(
			stagedDeletionPath,
			`${entry.artifact.label} staged deletion`,
			stagedDeletionSnapshot,
			"read-back",
		);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		const claimPath = nativeHookTransactionClaimPath(entry.artifact.path);
		await rename(stagedDeletionPath, claimPath);
		try {
			await assertNativeHookTransactionArtifactSnapshot(
				claimPath,
				`${entry.artifact.label} staged deletion cleanup claim`,
				stagedDeletionSnapshot,
				"read-back",
			);
		} catch (error) {
			try {
				await restoreNativeHookClaim(claimPath, stagedDeletionPath);
			} catch (recoveryError) {
				throw new Error(
					`Native hook transaction staged deletion cleanup claim failed (${error instanceof Error ? error.message : String(error)}) and preserved ${claimPath} for manual recovery: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
			throw error;
		}
		await rm(claimPath);
		entry.stagedDeletionCleaned = true;
		if (rollbackApplied) {
			await assertNativeHookTransactionRollbackState(rollbackApplied);
		}
	}
}

function nativeHookTransactionBackupPath(
	artifactPath: string,
	backupContext: SetupBackupContext,
): string {
	const relativePath = relative(backupContext.baseRoot, artifactPath);
	const safeRelativePath =
		relativePath.startsWith("..") || relativePath === ""
			? artifactPath.replace(/^[/]+/, "")
			: relativePath;
	return join(backupContext.backupRoot, safeRelativePath);
}

async function ensureSnapshotBackup(
	artifact: NativeHookTransactionArtifact,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
	const bytes = artifact.before.bytes;
	if (bytes === null) return false;
	const backupPath = nativeHookTransactionBackupPath(artifact.path, backupContext);
	if (!options.dryRun) {
		const relativeParent = relative(backupContext.baseRoot, dirname(backupPath));
		if (
			isAbsolute(relativeParent) ||
			relativeParent === ".." ||
			relativeParent.startsWith(`..${sep}`)
		) {
			throw new Error(`Refusing to back up ${artifact.path} outside controlled backup root.`);
		}
		let currentPath = backupContext.baseRoot;
		for (const component of relativeParent.split(sep).filter(Boolean)) {
			currentPath = join(currentPath, component);
			try {
				const currentStat = await lstat(currentPath);
				if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
					throw new Error(`Refusing to use unsafe backup ancestor ${currentPath}.`);
				}
			} catch (error) {
				if (!isMissingPathError(error)) throw error;
				await mkdir(currentPath);
				const createdStat = await lstat(currentPath);
				if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
					throw new Error(`Refusing to use unsafe created backup ancestor ${currentPath}.`);
				}
			}
		}
		const handle = await open(backupPath, "wx", 0o600);
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
		const backupStat = await lstat(backupPath);
		if (backupStat.isSymbolicLink() || !backupStat.isFile() || backupStat.nlink !== 1) {
			throw new Error(`Refusing unsafe native hook transaction backup ${backupPath}.`);
		}
		const writtenBytes = await readFile(backupPath);
		if (!writtenBytes.equals(bytes)) {
			throw new Error(`Native hook transaction backup verification failed for ${backupPath}.`);
		}
	}
	if (options.verbose) {
		console.log(`  backup ${artifact.path} -> ${backupPath}`);
	}
	return true;
}

async function commitNativeHookTransaction(
	artifacts: readonly NativeHookTransactionArtifact[],
	preconditions: readonly NativeHookTransactionPrecondition[],
	ancestorPrecondition: NativeHookTransactionAncestorPrecondition,
	backupContext: SetupBackupContext,
	summary: SetupCategorySummary,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	if (options.dryRun) return;

	await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);

	for (const precondition of preconditions) {
		injectNativeHookTransactionFailure("before_precondition", precondition);
		await assertNativeHookTransactionPrecondition(precondition);
	}
	if (artifacts.length === 0) return;
	for (const artifact of artifacts) {
		injectNativeHookTransactionFailure("before_backup", artifact);
		if (await ensureSnapshotBackup(artifact, backupContext, options)) {
			summary.backedUp += 1;
		}
	}

	await assertUnmutatedNativeHookTransactionPreconditions(preconditions, []);
	await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);

	const applied: AppliedNativeHookTransactionArtifact[] = [];
	let stagedCleanupStarted = false;
	try {
		for (const artifact of artifacts) {
			await assertUnmutatedNativeHookTransactionPreconditions(
				preconditions,
				applied,
			);
			await assertAppliedNativeHookTransactionSnapshots(applied);
			const entry = await applyNativeHookTransactionArtifact(
				artifact,
				ancestorPrecondition,
				applied,
			);
			await verifyNativeHookTransactionArtifact(entry);
			await assertUnmutatedNativeHookTransactionPreconditions(
				preconditions,
				applied,
			);
			await assertAppliedNativeHookTransactionSnapshots(applied);
		}
		await assertUnmutatedNativeHookTransactionPreconditions(preconditions, applied);
		await assertAppliedNativeHookTransactionSnapshots(applied);
		stagedCleanupStarted = true;
		await cleanupNativeHookTransactionStagedDeletions(
			applied,
			ancestorPrecondition,
			preconditions,
		);
		injectNativeHookTransactionFailure(
			"after_staged_cleanup",
			artifacts[artifacts.length - 1],
		);
		await assertUnmutatedNativeHookTransactionPreconditions(preconditions, applied);
		await assertNativeHookTransactionAncestorPrecondition(ancestorPrecondition);
		await assertAppliedNativeHookTransactionSnapshots(applied);
	} catch (error) {
		if (
			stagedCleanupStarted &&
			applied.some((entry) => entry.stagedDeletionCleaned)
		) {
			throw new Error(
				`Native hook transaction committed but staged deletion cleanup failed during finalization: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const rollbackFailures: string[] = [];
		const restored: AppliedNativeHookTransactionArtifact[] = [];
		try {
			await assertNativeHookTransactionRollbackState(applied);
		} catch (rollbackError) {
			rollbackFailures.push(
				`recovery preflight: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
			);
		}
		if (rollbackFailures.length === 0) {
			for (const entry of [...applied].reverse()) {
				try {
					await assertNativeHookTransactionRollbackState(applied);
					await restoreNativeHookTransactionArtifact(
						entry,
						ancestorPrecondition,
						() => assertNativeHookTransactionRollbackState(applied),
					);
					restored.push(entry);
					await assertNativeHookTransactionRollbackState(applied);
				} catch (rollbackError) {
					rollbackFailures.push(
						`${entry.artifact.label}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					);
				}
			}
		}
		if (rollbackFailures.length === 0) {
			try {
				await assertNativeHookTransactionRollbackState(applied);
				await cleanupNativeHookTransactionStagedDeletions(
					restored,
					ancestorPrecondition,
					undefined,
					applied,
				);
				await assertNativeHookTransactionRollbackState(applied);
			} catch (cleanupError) {
				rollbackFailures.push(
					`staged deletion cleanup: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		if (rollbackFailures.length > 0) {
			throw new Error(
				`Native hook transaction failed (${message}) and rollback failed; manual recovery is required (${rollbackFailures.join("; ")}).`,
			);
		}
		throw new Error(`Native hook transaction failed and was rolled back: ${message}`);
	}
}


async function ensureBackup(
	destinationPath: string,
	contentChanged: boolean,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
	if (!contentChanged || !existsSync(destinationPath)) return false;

	const relativePath = relative(backupContext.baseRoot, destinationPath);
	const safeRelativePath =
		relativePath.startsWith("..") || relativePath === ""
			? destinationPath.replace(/^[/]+/, "")
			: relativePath;
	const backupPath = join(backupContext.backupRoot, safeRelativePath);

	if (!options.dryRun) {
		await mkdir(dirname(backupPath), { recursive: true });
		await copyFile(destinationPath, backupPath);
	}
	if (options.verbose) {
		console.log(`  backup ${destinationPath} -> ${backupPath}`);
	}
	return true;
}

async function moveExistingAgentsToDeterministicBackup(
	destinationPath: string,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<string | null> {
	if (!existsSync(destinationPath)) return null;

	const backupBaseName = `.${basename(destinationPath)}.bkup`;
	let backupPath = join(dirname(destinationPath), backupBaseName);
	let suffix = 1;

	while (existsSync(backupPath)) {
		backupPath = join(dirname(destinationPath), `${backupBaseName}${suffix}`);
		suffix += 1;
	}

	if (!options.dryRun) {
		await rename(destinationPath, backupPath);
	}

	console.log(`  Backed up existing AGENTS.md to ${backupPath}.`);
	return backupPath;
}

async function filesDiffer(src: string, dst: string): Promise<boolean> {
	if (!existsSync(dst)) return true;
	const [srcContent, dstContent] = await Promise.all([
		readFile(src, "utf-8"),
		readFile(dst, "utf-8"),
	]);
	return srcContent !== dstContent;
}

function containsTomlKey(content: string, key: string): boolean {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*${escapedKey}\\s*=`, "m").test(content);
}

function parseSkillFrontmatterScalar(
	value: string,
	key: string,
	filePath: string,
): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
	}
	if (trimmed === "|" || trimmed === ">") {
		throw new Error(
			`${filePath} frontmatter "${key}" must be a single-line string`,
		);
	}

	const quote = trimmed[0];
	if (quote === '"' || quote === "'") {
		if (trimmed.length < 2 || trimmed.at(-1) !== quote) {
			throw new Error(
				`${filePath} frontmatter "${key}" has an unterminated quoted string`,
			);
		}
		const unquoted = trimmed.slice(1, -1).trim();
		if (!unquoted) {
			throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
		}
		return unquoted;
	}

	const unquoted = trimmed.replace(/\s+#.*$/, "").trim();
	if (!unquoted) {
		throw new Error(`${filePath} frontmatter "${key}" must not be empty`);
	}
	return unquoted;
}

export function parseSkillFrontmatter(
	content: string,
	filePath = "SKILL.md",
): SkillFrontmatterMetadata {
	const frontmatterMatch = content.match(
		/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
	);
	if (!frontmatterMatch) {
		throw new Error(
			`${filePath} must start with YAML frontmatter containing non-empty name and description fields`,
		);
	}

	let name: string | undefined;
	let description: string | undefined;
	const lines = frontmatterMatch[1].split(/\r?\n/);

	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trimEnd();
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (/^\s/.test(rawLine)) continue;

		const match = line.match(/^([A-Za-z0-9_-]+):(.*)$/);
		if (!match) {
			throw new Error(
				`${filePath} has invalid YAML frontmatter on line ${index + 2}: ${trimmed}`,
			);
		}

		const [, key, rawValue] = match;
		if (!rawValue.trim()) continue;

		const parsedValue = parseSkillFrontmatterScalar(rawValue, key, filePath);
		if (key === "name") name = parsedValue;
		if (key === "description") description = parsedValue;
	}

	if (!name) {
		throw new Error(`${filePath} is missing a non-empty frontmatter "name"`);
	}
	if (!description) {
		throw new Error(
			`${filePath} is missing a non-empty frontmatter "description"`,
		);
	}

	return { name, description };
}

export async function validateSkillFile(skillMdPath: string): Promise<void> {
	const content = await readFile(skillMdPath, "utf-8");
	parseSkillFrontmatter(content, skillMdPath);
}

function rewriteInstalledSkillDescriptionBadge(
	content: string,
	filePath = "SKILL.md",
): string {
	const metadata = parseSkillFrontmatter(content, filePath);
	const badgePrefix = "[OMX] ";
	const displayDescription = metadata.description.startsWith(badgePrefix)
		? metadata.description
		: `${badgePrefix}${metadata.description}`;

	return content.replace(
		/^---\r?\n([\s\S]*?)\r?\n---/,
		(frontmatterBlock, body) => {
			const rewrittenBody = body.replace(
				/^([ \t]*)description:(.*)$/m,
				(_line: string, indent: string) =>
					`${indent}description: ${JSON.stringify(displayDescription)}`,
			);
			return frontmatterBlock.replace(body, rewrittenBody);
		},
	);
}

async function buildLegacySkillOverlapNotice(
	scope: SetupScope,
): Promise<LegacySkillOverlapNotice> {
	if (scope !== "user") {
		return { shouldWarn: false, message: "" };
	}

	const overlap = await detectLegacySkillRootOverlap();
	if (!overlap.legacyExists) {
		return { shouldWarn: false, message: "" };
	}

	if (overlap.overlappingSkillNames.length === 0) {
		return {
			shouldWarn: true,
			message: `Legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}. Codex may still discover both roots; archive or remove ~/.agents/skills if Enable/Disable Skills shows duplicates.`,
		};
	}

	const mismatchSuffix =
		overlap.mismatchedSkillNames.length > 0
			? ` ${overlap.mismatchedSkillNames.length} overlapping skills have different SKILL.md content.`
			: "";
	return {
		shouldWarn: true,
		message: `Detected ${overlap.overlappingSkillNames.length} overlapping skill names between canonical ${overlap.canonicalDir} and legacy ${overlap.legacyDir}.${mismatchSuffix} Remove or archive ~/.agents/skills after confirming ${overlap.canonicalDir} is the version you want Codex to load.`,
	};
}

export function resolveScopeDirectories(
	scope: SetupScope,
	projectRoot: string,
): ScopeDirectories {
	if (scope === "project") {
		const codexHomeDir = join(projectRoot, ".codex");
		return {
			codexConfigFile: join(codexHomeDir, "config.toml"),
			codexHomeDir,
			codexHooksFile: join(codexHomeDir, "hooks.json"),
			nativeAgentsDir: join(codexHomeDir, "agents"),
			promptsDir: join(codexHomeDir, "prompts"),
			skillsDir: join(codexHomeDir, "skills"),
		};
	}
	return {
		codexConfigFile: codexConfigPath(),
		codexHomeDir: codexHome(),
		codexHooksFile: join(codexHome(), "hooks.json"),
		nativeAgentsDir: codexAgentsDir(),
		promptsDir: codexPromptsDir(),
		skillsDir: userSkillsDir(),
	};
}

function logCategorySummary(name: string, summary: SetupCategorySummary): void {
	console.log(
		`  ${name}: updated=${summary.updated}, unchanged=${summary.unchanged}, ` +
			`backed_up=${summary.backedUp}, skipped=${summary.skipped}, removed=${summary.removed}`,
	);
}

async function promptForSetupScope(
	defaultScope: SetupScope,
): Promise<SetupScope> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return defaultScope;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const userDefaultMarker = defaultScope === "user" ? " (default)" : "";
		const projectDefaultMarker = defaultScope === "project" ? " (default)" : "";
		const defaultChoice = defaultScope === "project" ? "2" : "1";
		console.log("Select setup scope:");
		console.log(
			`  1) user${userDefaultMarker} — installs to ${codexHome()} (skills default to ${userSkillsDir()})`,
		);
		console.log(
			`  2) project${projectDefaultMarker} — installs to ./.codex (local to project)`,
		);
		const answer = (
			await rl.question(`Scope [1-2] (default: ${defaultChoice}): `)
		)
			.trim()
			.toLowerCase();
		if (answer === "2" || answer === "project") return "project";
		if (answer === "1" || answer === "user") return "user";
		return defaultScope;
	} finally {
		rl.close();
	}
}

async function promptForSetupInstallMode(
	defaultMode: SetupInstallMode,
): Promise<SetupInstallMode> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return defaultMode;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		console.log("Select user-scope skill delivery mode:");
		console.log(
			`  1) legacy${defaultMode === "legacy" ? " (default)" : ""} — install/update OMX skills in the resolved user skill root`,
		);
		console.log(
			`  2) plugin${defaultMode === "plugin" ? " (default)" : ""} — rely on Codex plugin discovery and clean up matching legacy OMX-managed setup artifacts`,
		);
		const defaultChoice = defaultMode === "plugin" ? "2" : "1";
		const answer = (
			await rl.question(`Install mode [1-2] (default: ${defaultChoice}): `)
		)
			.trim()
			.toLowerCase();
		if (answer === "2" || answer === "plugin") return "plugin";
		if (answer === "1" || answer === "legacy") return "legacy";
		return defaultMode;
	} finally {
		rl.close();
	}
}

async function promptForFirstPartyMcpRemoval(
	configPath: string,
	registrationKinds: string[],
): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		console.log("Deprecated first-party OMX MCP registration detected:");
		console.log(`  ${configPath}`);
		console.log(`  ${registrationKinds.join(", ")}`);
		console.log(
			"  OMX is CLI-first by default now; first-party MCP compatibility is legacy/explicit.",
		);
		const answer = (
			await rl.question("Remove first-party OMX MCP registrations now? [y/N]: ")
		)
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

function hasPersistedSetupPreferences(
	preferences: Partial<PersistedSetupScope> | undefined,
): preferences is Partial<PersistedSetupScope> {
	return Boolean(
		preferences?.scope ||
		preferences?.installMode ||
		preferences?.teamMode ||
		typeof preferences?.mergeAgents === "boolean",
	);
}

function formatPersistedSetupPreferenceSummary(
	preferences: Partial<PersistedSetupScope>,
): string {
	const summary = [
		`scope=${preferences.scope ?? "not recorded"}`,
		`installMode=${preferences.installMode ?? "not recorded"}`,
		`mcpMode=${preferences.mcpMode ?? "not recorded"}`,
	];
	if (preferences.teamMode) summary.push(`teamMode=${preferences.teamMode}`);
	if (typeof preferences.mergeAgents === "boolean") {
		summary.push(`mergeAgents=${preferences.mergeAgents}`);
	}
	return summary.join(", ");
}

async function promptForPersistedSetupReview(
	preferences: Partial<PersistedSetupScope>,
): Promise<PersistedSetupReviewDecision> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return "keep";
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		console.log("Existing OMX setup preferences detected:");
		console.log(`  ${formatPersistedSetupPreferenceSummary(preferences)}`);
		console.log("  1) keep   — reuse these choices for this setup run");
		console.log(
			"  2) review — review/change choices, using these values as defaults",
		);
		console.log("  3) reset  — ignore saved choices and run setup as if fresh");
		const answer = (
			await rl.question("Setup preferences [1-3] (default: 1 keep): ")
		)
			.trim()
			.toLowerCase();
		if (answer === "2" || answer === "review" || answer === "change") {
			return "review";
		}
		if (answer === "3" || answer === "reset" || answer === "fresh") {
			return "reset";
		}
		return "keep";
	} finally {
		rl.close();
	}
}

async function promptForModelUpgrade(
	currentModel: string,
	targetModel: string,
): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (
			await rl.question(
				`Detected model "${currentModel}". Update to "${targetModel}"? [Y/n]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function promptForAgentsOverwrite(
	destinationPath: string,
): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (
			await rl.question(
				`Overwrite existing AGENTS.md at "${destinationPath}"? [y/N]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function promptForPluginAgentsMdDefault(
	destinationPath: string,
): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return !existsSync(destinationPath);
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (
			await rl.question(
				`Plugin mode: install/update OMX AGENTS.md defaults at "${destinationPath}"? [Y/n]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

const LEGACY_PLUGIN_DEVELOPER_INSTRUCTIONS =
	"You have oh-my-codex installed through Codex plugin mode. AGENTS.md is the orchestration brain and main control surface. Follow AGENTS.md for skill/keyword routing and $name workflow invocation. When spawning native subagents, set `agent_type` to an installed role and never omit it for OMX work. Registered Codex plugin marketplace surfaces supply OMX workflows and plugin-scoped companion resources when the plugin is installed; native agent roles are installed as setup-owned Codex agent TOML files in plugin mode so agent_type routing works. User-installed skills may still live under ~/.codex/skills. Use outcome-first, concise progress updates: state the target result, constraints, validation evidence, and stop condition before adding process detail.";

function normalizeDeveloperInstructionsText(value: string): string {
	return value.replace(/\r\n/g, "\n").trim();
}

function classifyPluginDeveloperInstructions(
	value: unknown,
): PluginDeveloperInstructionsDecision["state"] {
	if (typeof value !== "string") return "custom";
	const normalized = normalizeDeveloperInstructionsText(value);
	if (
		normalized ===
		normalizeDeveloperInstructionsText(OMX_PLUGIN_DEVELOPER_INSTRUCTIONS)
	) {
		return "current";
	}
	if (
		normalized ===
		normalizeDeveloperInstructionsText(LEGACY_PLUGIN_DEVELOPER_INSTRUCTIONS)
	) {
		return "historical";
	}
	if (
		normalized === normalizeDeveloperInstructionsText(OMX_DEVELOPER_INSTRUCTIONS)
	) {
		return "historical";
	}
	return "custom";
}

function readRootDeveloperInstructions(config: string): unknown | undefined {
	if (!rootHasTomlKey(config, "developer_instructions")) return undefined;
	try {
		const parsed = TOML.parse(config) as Record<string, unknown>;
		return parsed.developer_instructions;
	} catch {
		return Symbol.for("omx.invalid-developer-instructions");
	}
}

async function askYesNoDefaultYes(question: string): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return false;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

function legacyPluginDeveloperInstructionsDecision(
	choice: boolean | "skip" | "preserve-or-add" | "refresh",
	state: PluginDeveloperInstructionsDecision["state"] = "missing",
): PluginDeveloperInstructionsDecision {
	if (choice === "refresh" || (choice === true && state === "historical")) {
		return {
			action: "update",
			state: "historical",
			reason:
				choice === "refresh"
					? "legacy explicit refresh policy"
					: "legacy boolean approval refreshed historical developer_instructions",
		};
	}
	if (choice === true || choice === "preserve-or-add") {
		return {
			action: "add",
			state: "missing",
			reason: "legacy explicit add-if-missing policy",
		};
	}
	return {
		action: "preserve",
		state,
		reason: "legacy explicit skip policy",
	};
}

async function resolvePluginDeveloperInstructionsDecision(
	existingConfig: string,
	configPath: string,
	options: Pick<SetupOptions, "pluginDeveloperInstructionsPrompt">,
): Promise<PluginDeveloperInstructionsDecision> {
	const value = readRootDeveloperInstructions(existingConfig);
	if (value === undefined) {
		if (options.pluginDeveloperInstructionsPrompt) {
			return legacyPluginDeveloperInstructionsDecision(
				await options.pluginDeveloperInstructionsPrompt(configPath),
				"missing",
			);
		}
		const install = await askYesNoDefaultYes(
			`Plugin mode: add OMX developer_instructions bootstrap to "${configPath}"? [Y/n]: `,
		);
		return install
			? {
					action: "add",
					state: "missing",
					reason: "missing developer_instructions",
				}
			: {
					action: "preserve",
					state: "missing",
					reason: "missing developer_instructions skipped",
				};
	}

	const state = classifyPluginDeveloperInstructions(value);
	if (state === "current") {
		return {
			action: "preserve",
			state,
			reason: "current OMX developer_instructions already installed",
		};
	}

	if (state === "historical") {
		const updateDecision = options.pluginDeveloperInstructionsPrompt
			? legacyPluginDeveloperInstructionsDecision(
					await options.pluginDeveloperInstructionsPrompt(configPath),
					state,
				)
			: await askYesNoDefaultYes(
					`Plugin mode: update OMX developer_instructions bootstrap at "${configPath}"? [Y/n]: `,
				)
				? {
						action: "update",
						state,
						reason: "recognized historical OMX developer_instructions",
					} satisfies PluginDeveloperInstructionsDecision
				: {
						action: "preserve",
						state,
						reason: "historical OMX developer_instructions preserved",
					} satisfies PluginDeveloperInstructionsDecision;
		const update = updateDecision.action === "update";
		return update
			? {
					action: "update",
					state,
					reason: "recognized historical OMX developer_instructions",
				}
			: {
					action: "preserve",
					state,
					reason: "historical OMX developer_instructions preserved",
				};
	}

	return {
		action: "preserve",
		state: "custom",
		reason: "custom or unknown developer_instructions preserved",
	};
}

async function resolveSetupScope(
	projectRoot: string,
	requestedScope?: SetupScope,
	persistedReviewDecision: PersistedSetupReviewDecision = "keep",
	persistedPreferences?: Partial<PersistedSetupScope>,
	setupScopePrompt?: (defaultScope: SetupScope) => Promise<SetupScope>,
): Promise<ResolvedSetupScope> {
	if (requestedScope) {
		return { scope: requestedScope, source: "cli" };
	}
	const persisted =
		persistedPreferences ?? (await readPersistedSetupPreferences(projectRoot));
	if (persisted?.scope && persistedReviewDecision === "keep") {
		return { scope: persisted.scope, source: "persisted" };
	}
	if (
		typeof setupScopePrompt === "function" ||
		(process.stdin.isTTY && process.stdout.isTTY)
	) {
		const defaultScope =
			persistedReviewDecision === "review" && persisted?.scope
				? persisted.scope
				: DEFAULT_SETUP_SCOPE;
		const scope = setupScopePrompt
			? await setupScopePrompt(defaultScope)
			: await promptForSetupScope(defaultScope);
		return { scope, source: "prompt" };
	}
	return { scope: DEFAULT_SETUP_SCOPE, source: "default" };
}

async function readPluginManifestName(
	manifestPath: string,
): Promise<string | null> {
	try {
		const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
		return typeof parsed === "object" &&
			parsed !== null &&
			"name" in parsed &&
			typeof (parsed as { name?: unknown }).name === "string"
			? (parsed as { name: string }).name
			: null;
	} catch {
		return null;
	}
}

interface OmxPluginCacheManifest {
	name: string | null;
	version: string | null;
	skills: string | null;
	hooks: string | null;
}

async function readPluginManifestSummary(
	manifestPath: string,
): Promise<OmxPluginCacheManifest | null> {
	try {
		const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const manifest = parsed as {
			name?: unknown;
			version?: unknown;
			skills?: unknown;
			hooks?: unknown;
		};
		return {
			name: typeof manifest.name === "string" ? manifest.name : null,
			version: typeof manifest.version === "string" ? manifest.version : null,
			skills: typeof manifest.skills === "string" ? manifest.skills : null,
			hooks: typeof manifest.hooks === "string" ? manifest.hooks : null,
		};
	} catch {
		return null;
	}
}

async function listChildDirectoryNames(dir: string): Promise<string[] | null> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return null;
	}
}

async function discoverOmxPluginCacheDirs(
	cacheRoot = join(codexHome(), "plugins", "cache"),
): Promise<string[]> {
	if (!existsSync(cacheRoot)) return [];

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;
	const matches: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		const manifestPath = join(current.path, ".codex-plugin", "plugin.json");
		if (existsSync(manifestPath)) {
			const name = await readPluginManifestName(manifestPath);
			if (name === "oh-my-codex") {
				matches.push(current.path);
				continue;
			}
		}

		if (current.depth >= maxDepth) continue;

		let entries;
		try {
			entries = await readdir(current.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git" || entry.name === "node_modules") continue;
			queue.push({
				path: join(current.path, entry.name),
				depth: current.depth + 1,
			});
		}
	}

	return matches.sort();
}

async function discoverOmxPluginCacheDir(
	cacheRoot = join(codexHome(), "plugins", "cache"),
): Promise<string | null> {
	return (await discoverOmxPluginCacheDirs(cacheRoot))[0] ?? null;
}

interface PluginDiscoveryCacheRefreshResult {
	status: "unavailable" | "unchanged" | "refreshed";
	staleDirs: string[];
}

async function refreshOmxPluginDiscoveryCache(
	pkgRoot: string,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
	codexHomeDir = codexHome(),
): Promise<PluginDiscoveryCacheRefreshResult> {
	const packagedMarketplace = await resolvePackagedOmxMarketplace(pkgRoot);
	if (!packagedMarketplace) {
		return { status: "unavailable", staleDirs: [] };
	}

	const [pkg, expectedSkillNames, cachedDirs] = await Promise.all([
		readFile(join(pkgRoot, "package.json"), "utf-8").then((raw) =>
			JSON.parse(raw) as { version?: unknown },
		),
		listChildDirectoryNames(join(packagedMarketplace.pluginRoot, "skills")),
		discoverOmxPluginCacheDirs(join(codexHomeDir, "plugins", "cache")),
	]);
	const expectedVersion = typeof pkg.version === "string" ? pkg.version : null;
	const staleDirs: string[] = [];

	for (const cacheDir of cachedDirs) {
		const manifest = await readPluginManifestSummary(
			join(cacheDir, ".codex-plugin", "plugin.json"),
		);
		if (manifest?.name !== "oh-my-codex") continue;

		const cachedSkillNames = await listChildDirectoryNames(join(cacheDir, "skills"));
		const versionChanged =
			expectedVersion !== null && manifest.version !== expectedVersion;
		const skillsPointerChanged = manifest.skills !== "./skills/";
		const hooksPointerChanged = manifest.hooks !== "./hooks/hooks.json";
		const hookFilesMissing = !existsSync(join(cacheDir, "hooks", "hooks.json"))
			|| !existsSync(join(cacheDir, "hooks", "codex-native-hook.mjs"))
			|| !existsSync(join(cacheDir, "hooks", "omx-command.json"));
		const hookFilesChanged = !hookFilesMissing
			&& !(await pluginHookCacheMatchesPackaged(cacheDir, packagedMarketplace));
		const skillListChanged =
			expectedSkillNames !== null &&
			cachedSkillNames !== null &&
			JSON.stringify(cachedSkillNames) !== JSON.stringify(expectedSkillNames);

		if (
			!versionChanged &&
			!skillsPointerChanged &&
			!hooksPointerChanged &&
			!hookFilesMissing &&
			!hookFilesChanged &&
			!skillListChanged
		) continue;



		staleDirs.push(cacheDir);
		if (!options.dryRun) {
			await rm(cacheDir, { recursive: true, force: true });
		}
		if (options.verbose) {
			const reasons = [
				versionChanged
					? `version ${manifest.version ?? "unknown"} -> ${expectedVersion}`
					: null,
				skillsPointerChanged
					? `skills pointer ${manifest.skills ?? "missing"} -> ./skills/`
					: null,
				hooksPointerChanged
					? `hooks pointer ${manifest.hooks ?? "missing"} -> ./hooks/hooks.json`
					: null,
				hookFilesMissing ? "plugin hook files missing" : null,
				hookFilesChanged ? "plugin hook files changed" : null,
				skillListChanged ? "skill directory list changed" : null,
			].filter(Boolean);
			console.log(
				`  ${options.dryRun ? "would invalidate" : "invalidated"} Codex plugin discovery cache ${cacheDir} (${reasons.join(", ")})`,
			);
		}
	}

	return {
		status: staleDirs.length > 0 ? "refreshed" : "unchanged",
		staleDirs,
	};
}


function resolveSetupMcpMode(
	scope: SetupScope,
	requestedMcpMode: SetupMcpMode | undefined,
	persistedReviewDecision: PersistedSetupReviewDecision,
	persistedPreferences?: Partial<PersistedSetupScope>,
): ResolvedSetupMcpMode {
	if (requestedMcpMode) {
		return { mcpMode: requestedMcpMode, source: "cli" };
	}
	if (
		persistedPreferences?.mcpMode &&
		persistedReviewDecision === "keep" &&
		persistedPreferences.scope === scope
	) {
		return { mcpMode: persistedPreferences.mcpMode, source: "persisted" };
	}
	return { mcpMode: DEFAULT_SETUP_MCP_MODE, source: "default" };
}

async function resolveSetupInstallMode(
	projectRoot: string,
	scope: SetupScope,
	requestedInstallMode?: SetupInstallMode,
	installModePrompt?: (
		defaultMode: SetupInstallMode,
	) => Promise<SetupInstallMode>,
	persistedReviewDecision: PersistedSetupReviewDecision = "keep",
	persistedPreferences?: Partial<PersistedSetupScope>,
): Promise<ResolvedSetupInstallMode | null> {
	if (requestedInstallMode) {
		return { installMode: requestedInstallMode, source: "cli" };
	}

	const persisted =
		persistedPreferences ?? (await readPersistedSetupPreferences(projectRoot));
	if (
		persisted?.installMode &&
		persistedReviewDecision === "keep" &&
		persisted.scope === scope
	) {
		return { installMode: persisted.installMode, source: "persisted" };
	}

	const discoveredPluginCacheDir = await discoverOmxPluginCacheDir();
	if (scope !== "user") {
		return discoveredPluginCacheDir
			? { installMode: "plugin", source: "default" }
			: null;
	}

	const defaultMode =
		persistedReviewDecision === "review" && persisted?.installMode
			? persisted.installMode
			: discoveredPluginCacheDir
				? "plugin"
				: DEFAULT_SETUP_INSTALL_MODE;

	if (
		typeof installModePrompt === "function" ||
		(process.stdin.isTTY && process.stdout.isTTY)
	) {
		if (discoveredPluginCacheDir) {
			console.log(
				`Detected installed oh-my-codex Codex plugin cache at ${discoveredPluginCacheDir}.`,
			);
		}
		const installMode = installModePrompt
			? await installModePrompt(defaultMode)
			: await promptForSetupInstallMode(defaultMode);
		return { installMode, source: "prompt" };
	}

	return { installMode: defaultMode, source: "default" };
}

function hasGitignoreEntry(content: string, entry: string): boolean {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.some((line) => line === entry);
}

function isProjectPathIgnoredByGit(projectRoot: string, path: string): boolean {
	const result = spawnSync("git", ["check-ignore", "--no-index", "-q", path], {
		cwd: projectRoot,
		stdio: "ignore",
		windowsHide: true,
	});
	return result.status === 0;
}

function shouldAddProjectGitignoreEntry(
	projectRoot: string,
	content: string,
	entry: string,
): boolean {
	if (hasGitignoreEntry(content, entry)) return false;

	if (entry === ".omx/" && isProjectPathIgnoredByGit(projectRoot, entry)) {
		return false;
	}

	return true;
}

function stripLegacyGitignoreEntries(
	content: string,
	legacyEntries: readonly string[],
): { content: string; removed: boolean } {
	const legacyEntrySet = new Set(legacyEntries);
	const lines = content.split(/\r?\n/);
	const filteredLines = lines.filter(
		(line) => !legacyEntrySet.has(line.trim()),
	);
	const removed = filteredLines.length !== lines.length;

	return {
		content: filteredLines.join("\n").replace(/\n+$/, "\n"),
		removed,
	};
}

async function ensureProjectGitignore(
	projectRoot: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<"created" | "updated" | "unchanged"> {
	const gitignorePath = join(projectRoot, ".gitignore");
	const destinationExists = existsSync(gitignorePath);
	const existing = destinationExists
		? await readFile(gitignorePath, "utf-8")
		: "";
	const normalized = stripLegacyGitignoreEntries(
		existing,
		LEGACY_PROJECT_GITIGNORE_ENTRIES,
	);

	const missingEntries = PROJECT_GITIGNORE_ENTRIES.filter((entry) =>
		shouldAddProjectGitignoreEntry(projectRoot, normalized.content, entry),
	);

	if (missingEntries.length === 0 && !normalized.removed) {
		return "unchanged";
	}

	const nextContent = destinationExists
		? `${normalized.content}${normalized.content.endsWith("\n") || normalized.content.length === 0 ? "" : "\n"}${missingEntries.join("\n")}${missingEntries.length > 0 ? "\n" : ""}`
		: `${missingEntries.join("\n")}\n`;

	if (
		await ensureBackup(gitignorePath, destinationExists, backupContext, options)
	) {
		// backup created when refreshing a pre-existing .gitignore
	}

	if (!options.dryRun) {
		await writeFile(gitignorePath, nextContent);
	}

	if (options.verbose) {
		const changedDetails = [
			normalized.removed ? "removed legacy .codex/" : "",
			missingEntries.length > 0 ? missingEntries.join(", ") : "",
		]
			.filter(Boolean)
			.join("; ");
		console.log(
			`  ${options.dryRun ? "would update" : destinationExists ? "updated" : "created"} .gitignore${changedDetails ? ` (${changedDetails})` : ""}`,
		);
	}

	return destinationExists ? "updated" : "created";
}

async function persistSetupPreferences(
	projectRoot: string,
	preferences: PersistedSetupScope,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	const scopePath = getSetupScopeFilePath(projectRoot);
	if (options.dryRun) {
		if (options.verbose) console.log(`  dry-run: skip persisting ${scopePath}`);
		return;
	}
	await writePersistedSetupPreferences(projectRoot, preferences);
	if (options.verbose) console.log(`  Wrote ${scopePath}`);
}

async function removeEmptyDirectoryIfPresent(
	dirPath: string,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	if (options.dryRun || !existsSync(dirPath)) return;
	try {
		const remaining = await readdir(dirPath);
		if (remaining.length === 0) {
			await rm(dirPath, { recursive: true, force: true });
			if (options.verbose) console.log(`  removed empty directory ${dirPath}`);
		}
	} catch {
		// Best-effort cleanup only.
	}
}

async function cleanupPluginModeLegacyPrompts(
	srcDir: string,
	dstDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();
	if (!existsSync(srcDir) || !existsSync(dstDir)) return summary;

	const manifest = tryReadCatalogManifest();

	for (const file of await readdir(srcDir)) {
		if (!file.endsWith(".md")) continue;
		const promptName = file.slice(0, -3);
		if (manifest && !isSetupPromptAssetName(promptName, manifest)) continue;

		const dst = join(dstDir, file);
		if (!existsSync(dst)) continue;

		if (await ensureBackup(dst, true, backupContext, options)) {
			summary.backedUp += 1;
		}
		if (!options.dryRun) {
			await rm(dst, { force: true });
		}
		summary.removed += 1;
		if (options.verbose) {
			console.log(
				`  ${options.dryRun ? "would archive and remove" : "archived and removed"} legacy prompt ${file}`,
			);
		}
	}

	await removeEmptyDirectoryIfPresent(dstDir, options);
	return summary;
}

function removeRootTomlKey(config: string, key: string): string {
	const range = findRootTomlKeyRange(config, key);
	if (!range) return config;
	const before = config.slice(0, range.start);
	const after = config.slice(range.end).replace(/^\r?\n?/, "\n");
	return `${before}${after}`;
}

function stripPluginModeLegacyRootDefaults(
	config: string,
	developerInstructionsDecision: PluginDeveloperInstructionsDecision,
): string {
	const lines = config.split(/\r?\n/);
	const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
	const boundary = firstTableIndex >= 0 ? firstTableIndex : lines.length;
	const result: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (
			index < boundary &&
			line.trim() ===
				"# oh-my-codex top-level settings (must be before any [table])"
		) {
			continue;
		}
		if (
			index < boundary &&
			/^\s*notify\s*=\s*\["node",\s*".*notify-hook\.js"\]\s*$/.test(line)
		) {
			continue;
		}
		if (
			index < boundary &&
			/^\s*model_reasoning_effort\s*=\s*"medium"\s*$/.test(line)
		) {
			continue;
		}
		result.push(line);
	}

	let nextConfig = result.join("\n").replace(/\n{3,}/g, "\n\n");
	if (
		developerInstructionsDecision.action === "update" &&
		developerInstructionsDecision.state === "historical" &&
		classifyPluginDeveloperInstructions(
			readRootDeveloperInstructions(nextConfig),
		) === "historical"
	) {
		nextConfig = removeRootTomlKey(nextConfig, "developer_instructions");
	}
	return nextConfig;
}

function rootHasTomlKey(config: string, key: string): boolean {
	const lines = config.split(/\r?\n/);
	const firstTableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
	const boundary = firstTableIndex >= 0 ? firstTableIndex : lines.length;
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^\\s*${escapedKey}\\s*=`);
	return lines.slice(0, boundary).some((line) => pattern.test(line));
}

function replaceRootTomlKey(config: string, key: string, line: string): string {
	const range = findRootTomlKeyRange(config, key);
	if (!range) return insertRootTomlKey(config, line);
	const before = config.slice(0, range.start);
	const after = config.slice(range.end).replace(/^\r?\n?/, "\n");
	return `${before}${line}${after}`.replace(/\n?$/, "\n");
}

function findRootTomlKeyRange(
	config: string,
	key: string,
): { start: number; end: number } | null {
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const keyPattern = new RegExp(`^\\s*${escapedKey}\\s*=`);
	const nextRootKeyPattern = /^\s*[A-Za-z0-9_-]+\s*=/;
	const tablePattern = /^\s*\[/;
	const linePattern = /.*(?:\r?\n|$)/g;
	let match: RegExpExecArray | null;
	let found: { start: number; end: number } | null = null;
	let inMultiline = false;
	let multilineDelimiter: '"""' | "'''" | null = null;

	while ((match = linePattern.exec(config)) && match[0] !== "") {
		const line = match[0];
		const lineStart = match.index;
		const lineEnd = lineStart + line.length;
		const trimmedLine = line.replace(/\r?\n$/, "");

		if (!found) {
			if (tablePattern.test(trimmedLine)) return null;
			if (keyPattern.test(trimmedLine)) {
				found = { start: lineStart, end: lineEnd };
				const valuePart = trimmedLine.slice(trimmedLine.indexOf("=") + 1);
				const delimiter = valuePart.includes('"""')
					? '"""'
					: valuePart.includes("'''")
						? "'''"
						: null;
				if (delimiter && valuePart.split(delimiter).length - 1 === 1) {
					inMultiline = true;
					multilineDelimiter = delimiter;
				} else {
					return found;
				}
			}
			continue;
		}

		found.end = lineEnd;
		if (inMultiline && multilineDelimiter) {
			if (trimmedLine.includes(multilineDelimiter)) {
				return found;
			}
			continue;
		}
		if (tablePattern.test(trimmedLine) || nextRootKeyPattern.test(trimmedLine)) {
			found.end = lineStart;
			return found;
		}
	}

	return found;
}

function insertRootTomlKey(config: string, line: string): string {
	const lines = config.trimEnd().split(/\r?\n/);
	if (lines.length === 1 && lines[0] === "") return `${line}\n`;
	const firstTableIndex = lines.findIndex((entry) => /^\s*\[/.test(entry));
	if (firstTableIndex < 0) return `${lines.join("\n")}\n${line}\n`;
	const before = lines
		.slice(0, firstTableIndex)
		.filter((entry) => entry.trim() !== "");
	const after = lines.slice(firstTableIndex);
	return [...before, line, "", ...after].join("\n") + "\n";
}


interface PluginModeHooksConfigPlan {
	finalConfig: string;
	hooksFinalContent: string | null;
	hooksRemovedCount: number;
	cleanedLegacyConfig: boolean;
	diagnostics: readonly { message: string }[];
}

function buildPluginModeHooksConfigPlan(
	existingConfig: string,
	existingHooksContent: string | null,
	pkgRoot: string,
	hooksPath: string,
	codexHomeDir: string,
	options: {
		codexHookFeatureFlag: CodexHookFeatureFlag;
		pluginScopedHooks: boolean;
		preserveFirstPartyMcp?: boolean;
		developerInstructionsDecision: PluginDeveloperInstructionsDecision;
		platform: NodeJS.Platform;
	},
): PluginModeHooksConfigPlan {
	const managedHookOptions = {
		platform: options.platform,
		codexHomeDir,
	} as const;
	const managedHooksPlan = options.pluginScopedHooks
		? existingHooksContent === null
			? null
			: planManagedCodexHooksRemoval(
				existingHooksContent,
				hooksPath,
				managedHookOptions,
			)
		: planManagedCodexHooksMerge(
			existingHooksContent,
			pkgRoot,
			hooksPath,
			managedHookOptions,
		);
	if (managedHooksPlan && !managedHooksPlan.ok) throw managedHooksPlan.error;

	const managedHookTrustState = managedHooksPlan?.finalTrustState ?? {};
	const priorManagedHookTrustState = managedHooksPlan?.priorTrustState ?? {};
	const legacyHookTrustState = managedHooksPlan?.legacyTrustState ?? {};
	preflightManagedCodexHookTrustState(
		existingConfig,
		priorManagedHookTrustState,
		managedHookTrustState,
	);
	const configAfterLegacyCleanup = buildPluginModeLegacyConfig(
		existingConfig,
		{
			...options,
			managedHookTrustState,
			priorManagedHookTrustState,
		},
	);

	const configWithRuntimeFeatures = upsertPluginModeRuntimeFeatureFlags(
		configAfterLegacyCleanup,
		options.codexHookFeatureFlag,
		{
			pluginScopedHooks: options.pluginScopedHooks,
			preserveNativeHooks:
				options.pluginScopedHooks && managedHooksPlan?.hasForeignHooks === true,
		},
	);
	return {
		finalConfig: upsertManagedCodexHookTrustState(
			configWithRuntimeFeatures,
			pkgRoot,
			hooksPath,
			{
				...managedHookOptions,
				managedTrustState: managedHookTrustState,
				priorManagedHookTrustState,
				legacyHookTrustState,
			},
		),
		hooksFinalContent: managedHooksPlan ? managedHooksPlan.finalContent : existingHooksContent,
	hooksRemovedCount: managedHooksPlan?.removedCount ?? 0,
		cleanedLegacyConfig: configAfterLegacyCleanup !== existingConfig,
		diagnostics: managedHooksPlan?.diagnostics ?? [],
	};
}

interface PluginDeveloperInstructionsConfigPlan {
	finalConfig: string;
	result: "updated" | "exists" | "skipped";
}

function buildPluginDeveloperInstructionsConfigPlan(
	existingConfig: string,
	decision: PluginDeveloperInstructionsDecision,
): PluginDeveloperInstructionsConfigPlan {
	if (decision.action === "preserve") {
		return {
			finalConfig: existingConfig,
			result: decision.state === "missing" ? "skipped" : "exists",
		};
	}

	const line = `developer_instructions = ${JSON.stringify(OMX_PLUGIN_DEVELOPER_INSTRUCTIONS)}`;
	const hasExistingDeveloperInstructions = rootHasTomlKey(
		existingConfig,
		"developer_instructions",
	);
	if (hasExistingDeveloperInstructions && decision.action === "add") {
		return { finalConfig: existingConfig, result: "exists" };
	}
	return {
		finalConfig: hasExistingDeveloperInstructions
			? replaceRootTomlKey(existingConfig, "developer_instructions", line)
			: insertRootTomlKey(existingConfig, line),
		result: "updated",
	};
}

function buildPluginModeLegacyConfig(
	original: string,
	options: {
		preserveFirstPartyMcp?: boolean;
		developerInstructionsDecision: PluginDeveloperInstructionsDecision;
		managedHookTrustState: Record<string, ManagedCodexHookTrustState>;
		priorManagedHookTrustState: Record<string, ManagedCodexHookTrustState>;
	},
): string {
	const preservedFirstPartyMcp = options.preserveFirstPartyMcp
		? extractFirstPartyOmxMcpSections(original)
		: "";
	let config = original;
	config = stripFirstPartyOmxMcpSections(config);
	config = stripExistingOmxBlocks(config, {
		managedTrustState: options.managedHookTrustState,
		priorManagedHookTrustState: options.priorManagedHookTrustState,
	}).cleaned;
	config = stripExistingSharedMcpRegistryBlock(config).cleaned;
	config = stripPluginModeLegacyRootDefaults(
		config,
		options.developerInstructionsDecision,
	);
	config = stripOmxSeededBehavioralDefaults(config);
	config = stripOmxFeatureFlags(config, { preserveMultiAgent: true });
	config = stripManagedCodexHookTrustState(config, {
		managedTrustState: options.managedHookTrustState,
		priorManagedHookTrustState: options.priorManagedHookTrustState,
	});
	config = stripOmxEnvSettings(config);
	if (preservedFirstPartyMcp) {
		config = `${config.trimEnd()}\n\n${preservedFirstPartyMcp}\n`;
	}
	config = config.trim();
	return config.length > 0 ? `${config}\n` : "";
}

interface NativeHookSetupTransactionPlan {
	artifacts: NativeHookTransactionArtifact[];
	preconditions: NativeHookTransactionPrecondition[];
	finalConfig: string;
	hooksRemovedCount: number;
	pluginScopedHooks: boolean;
	cleanedLegacyConfig: boolean;
	pluginMarketplaceResult: "updated" | "unchanged" | "unavailable";
	pluginDeveloperInstructionsResult: "updated" | "exists" | "skipped";
	diagnostics: readonly { message: string }[];
	modelUpgrade?: { currentModel: string; modelOverride: string };
	repairedLegacyTeamRunTable: boolean;
}

interface PlanNativeHookSetupTransactionOptions {
	configPath: string;
	hooksPath: string;
	codexHomeDir: string;
	pkgRoot: string;
	platform: NodeJS.Platform;
	isPluginInstallMode: boolean;
	pluginScopedHooks: boolean;
	codexHookFeatureFlag: CodexHookFeatureFlag;
	preserveFirstPartyMcp: boolean;
	removeFirstPartyMcp: boolean;
	pluginDeveloperInstructionsDecision: PluginDeveloperInstructionsDecision;
	pluginMarketplaceAvailable: boolean;
	sharedMcpRegistry: UnifiedMcpRegistryLoadResult;
	mcpMode: SetupMcpMode;
	resolvedScope: SetupScope;
	modelUpgradePrompt?: SetupOptions["modelUpgradePrompt"];
	statusLinePreset?: HudPreset;
	forceStatusLinePreset: boolean;
	configSnapshot: NativeHookTransactionArtifactSnapshot;
	notifyMetadataSnapshot?: NativeHookTransactionArtifactSnapshot;
}

async function planNativeHookSetupTransaction(
	options: PlanNativeHookSetupTransactionOptions,
): Promise<NativeHookSetupTransactionPlan> {
	const existingConfigSnapshot = options.configSnapshot;
	const existingHooksSnapshot = await captureNativeHookTransactionArtifact(
		options.hooksPath,
		`native hooks ${options.hooksPath}`,
	);
	const existingConfig = existingConfigSnapshot.bytes
		? decodeNativeHookTransactionUtf8(
			existingConfigSnapshot.bytes,
			`config ${options.configPath}`,
		)
		: "";
	const existingHooksContent = existingHooksSnapshot.bytes
		? decodeNativeHookTransactionUtf8(
			existingHooksSnapshot.bytes,
			`native hooks ${options.hooksPath}`,
		)
		: null;
	let finalConfig = existingConfig;
	let finalHooksContent = existingHooksContent;
	let hooksRemovedCount = 0;
	let cleanedLegacyConfig = false;
	let pluginMarketplaceResult: NativeHookSetupTransactionPlan["pluginMarketplaceResult"] = "unchanged";
	let pluginDeveloperInstructionsResult: NativeHookSetupTransactionPlan["pluginDeveloperInstructionsResult"] = "skipped";
	let diagnostics: readonly { message: string }[] = [];
	let notifyMetadataArtifact: NativeHookTransactionArtifact | null = null;
	let notifyMetadataPrecondition: NativeHookTransactionPrecondition | null = null;
	let modelUpgrade: NativeHookSetupTransactionPlan["modelUpgrade"];
	let repairedLegacyTeamRunTable = false;

	if (options.isPluginInstallMode) {
		const pluginPlan = buildPluginModeHooksConfigPlan(
			existingConfig,
			existingHooksContent,
			options.pkgRoot,
			options.hooksPath,
			options.codexHomeDir,
			{
				codexHookFeatureFlag: options.codexHookFeatureFlag,
				pluginScopedHooks: options.pluginScopedHooks,
				preserveFirstPartyMcp: options.preserveFirstPartyMcp,
				developerInstructionsDecision:
					options.pluginDeveloperInstructionsDecision,
				platform: options.platform,
			},
		);
		finalConfig = pluginPlan.finalConfig;
		finalHooksContent = pluginPlan.hooksFinalContent;
		hooksRemovedCount = pluginPlan.hooksRemovedCount;
		cleanedLegacyConfig = pluginPlan.cleanedLegacyConfig;
		diagnostics = pluginPlan.diagnostics;

		if (options.pluginMarketplaceAvailable) {
			const withMarketplace = upsertLocalOmxMarketplaceRegistration(
				upsertLocalOmxPluginMcpServerEnablement(
					upsertLocalOmxPluginEnablement(finalConfig),
					options.mcpMode === "compat",
					{ removeWhenDisabled: options.removeFirstPartyMcp },
				),
				options.pkgRoot,
			);
			pluginMarketplaceResult =
				withMarketplace === finalConfig ? "unchanged" : "updated";
			finalConfig = withMarketplace;
		} else {
			pluginMarketplaceResult = "unavailable";
		}
		const developerInstructionsPlan = buildPluginDeveloperInstructionsConfigPlan(
			finalConfig,
			options.pluginDeveloperInstructionsDecision,
		);
		finalConfig = developerInstructionsPlan.finalConfig;
		pluginDeveloperInstructionsResult = developerInstructionsPlan.result;
	} else {
		const managedHooksPlan = planManagedCodexHooksMerge(
			existingHooksContent,
			options.pkgRoot,
			options.hooksPath,
			{
				platform: options.platform,
				codexHomeDir: options.codexHomeDir,
			},
		);
		if (!managedHooksPlan.ok) throw managedHooksPlan.error;
		if (managedHooksPlan.finalContent === null) {
			throw new Error("Native hook merge unexpectedly produced no hooks.json content.");
		}
		finalHooksContent = managedHooksPlan.finalContent;
		hooksRemovedCount = managedHooksPlan.removedCount;
		diagnostics = managedHooksPlan.diagnostics;
		const managedConfigPlan = await planManagedConfig(
			options.hooksPath,
			options.pkgRoot,
			options.sharedMcpRegistry,
			options.mcpMode,
			options.preserveFirstPartyMcp,
			options.resolvedScope,
			options.codexHomeDir,
			{
				modelUpgradePrompt: options.modelUpgradePrompt,
				existingConfig,
				verbose: false,
				statusLinePreset: options.statusLinePreset,
				forceStatusLinePreset: options.forceStatusLinePreset,
				codexHookFeatureFlag: options.codexHookFeatureFlag,
				managedHookTrustState: managedHooksPlan.finalTrustState,
				priorManagedHookTrustState: managedHooksPlan.priorTrustState,
				legacyHookTrustState: managedHooksPlan.legacyTrustState,
				hookCommandPlatform: options.platform,
				notifyMetadataSnapshot: options.notifyMetadataSnapshot,
			},
		);
		finalConfig = managedConfigPlan.finalConfig;
		if (
			managedConfigPlan.currentModel &&
			managedConfigPlan.modelOverride &&
			managedConfigPlan.currentModel !== managedConfigPlan.modelOverride
		) {
			modelUpgrade = {
				currentModel: managedConfigPlan.currentModel,
				modelOverride: managedConfigPlan.modelOverride,
			};
		}
		repairedLegacyTeamRunTable = managedConfigPlan.repairedLegacyTeamRunTable;
		const notifyPlan = managedConfigPlan.notifyPlan;
		if (notifyPlan.metadataSnapshot && notifyPlan.metadataPath) {
			notifyMetadataPrecondition = nativeHookTransactionPrecondition(
				"metadata",
				notifyPlan.metadataPath,
				`notification metadata ${notifyPlan.metadataPath}`,
				notifyPlan.metadataSnapshot,
			);
		}
		if (notifyPlan.metadataPath && notifyPlan.metadata) {
			const metadataBefore = options.notifyMetadataSnapshot;
			if (!metadataBefore) {
				throw new Error(
					`Missing notification metadata snapshot for ${notifyPlan.metadataPath}; refusing to plan from a newly captured baseline.`,
				);
			}
			notifyMetadataArtifact = nativeHookTransactionArtifact(
				"metadata",
				notifyPlan.metadataPath,
				`notification metadata ${notifyPlan.metadataPath}`,
				metadataBefore,
				Buffer.from(JSON.stringify(notifyPlan.metadata, null, 2) + "\n", "utf-8"),
			);
			if (!notifyMetadataPrecondition) {
				notifyMetadataPrecondition = nativeHookTransactionPrecondition(
					"metadata",
					notifyPlan.metadataPath,
					`notification metadata ${notifyPlan.metadataPath}`,
					metadataBefore,
				);
			}
		}
	}

	if (options.isPluginInstallMode && options.sharedMcpRegistry.servers.length > 0) {
		finalConfig = mergeSharedMcpRegistryBlock(
			finalConfig,
			options.sharedMcpRegistry.servers,
			options.sharedMcpRegistry.sourcePath,
		);
	}
	try {
		TOML.parse(finalConfig);
	} catch (error) {
		throw new Error(
			`Refusing to write invalid planned config.toml: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const hookArtifact = nativeHookTransactionArtifact(
		"hooks",
		options.hooksPath,
		`native hooks ${options.hooksPath}`,
		existingHooksSnapshot,
		finalHooksContent === null ? null : Buffer.from(finalHooksContent, "utf-8"),
		options.platform,
	);
	const configArtifact = nativeHookTransactionArtifact(
		"config",
		options.configPath,
		`config ${options.configPath}`,
		existingConfigSnapshot,
		Buffer.from(finalConfig, "utf-8"),
	);

	let shimArtifact: NativeHookTransactionArtifact | null = null;
	let shimPrecondition: NativeHookTransactionPrecondition | null = null;
	if (options.platform === "win32") {
		const shimPath = buildManagedCodexNativeHookWindowsShimPath(options.codexHomeDir);
		const shimSnapshot = await captureNativeHookTransactionArtifact(
			shimPath,
			`native hook Windows shim ${shimPath}`,
		);
		const shimAfter = Buffer.from(
			buildManagedCodexNativeHookWindowsShimContent(options.pkgRoot),
			"utf-8",
		);
		assertWindowsNativeHookShimOwnership(shimPath, shimSnapshot.bytes, shimAfter);
		const shimReference = decideWindowsNativeHookShimReference(
			finalHooksContent,
			shimPath,
		);
		shimArtifact = nativeHookTransactionArtifact(
			"shim",
			shimPath,
			`native hook Windows shim ${shimPath}`,
			shimSnapshot,
			options.isPluginInstallMode && options.pluginScopedHooks &&
			shimReference === "not_referenced"
				? null
				: shimAfter,
		);
		shimPrecondition = nativeHookTransactionPrecondition(
			"shim",
			shimPath,
			`native hook Windows shim ${shimPath}`,
			shimSnapshot,
		);
	}

	const windowsShimCreateOrUpdateArtifact =
		shimArtifact && shimArtifact.after !== null ? shimArtifact : null;
	const windowsShimDeletionArtifact =
		shimArtifact && shimArtifact.after === null ? shimArtifact : null;
	const artifacts = options.platform === "win32"
		? windowsShimDeletionArtifact
			? [
				hookArtifact,
				windowsShimDeletionArtifact,
				notifyMetadataArtifact,
				configArtifact,
			]
			: [
				windowsShimCreateOrUpdateArtifact,
				hookArtifact,
				notifyMetadataArtifact,
				configArtifact,
			]
		: [hookArtifact, notifyMetadataArtifact, configArtifact];
	const preconditions = [
		shimPrecondition,
		nativeHookTransactionPrecondition(
			"hooks",
			options.hooksPath,
			`native hooks ${options.hooksPath}`,
			existingHooksSnapshot,
		),
		nativeHookTransactionPrecondition(
			"config",
			options.configPath,
			`config ${options.configPath}`,
			existingConfigSnapshot,
		),
		notifyMetadataPrecondition,
	];
	return {
		artifacts: artifacts.filter(
			(artifact): artifact is NativeHookTransactionArtifact => artifact !== null,
		),
		preconditions: preconditions.filter(
			(precondition): precondition is NativeHookTransactionPrecondition => precondition !== null,
		),
		finalConfig,
		hooksRemovedCount,
		pluginScopedHooks: options.pluginScopedHooks,
		cleanedLegacyConfig,
		pluginMarketplaceResult,
		pluginDeveloperInstructionsResult,
		diagnostics,
		modelUpgrade,
		repairedLegacyTeamRunTable,
	};
}

export async function setup(options: SetupOptions = {}): Promise<void> {
	const {
		force = false,
		dryRun = false,
		installMode: requestedInstallMode,
		mcpMode: requestedMcpMode,
		teamMode: requestedTeamMode,
		scope: requestedScope,
		verbose = false,
		skipNativeAgentRefresh: requestedSkipNativeAgentRefresh = false,
		setupScopePrompt,
		persistedSetupReviewPrompt,
		installModePrompt,
		modelUpgradePrompt,
		pluginAgentsMdPrompt,
		pluginDeveloperInstructionsPrompt,
		firstPartyMcpRemovalPrompt,
	} = options;
	const pkgRoot = getPackageRoot();
	const projectRoot = process.cwd();
	const persistedPreferences = await readPersistedSetupPreferences(
		projectRoot,
		{ warnOnLegacyScope: true },
	);
	let persistedReviewDecision: PersistedSetupReviewDecision = "keep";
	const effectiveScopeForInstallMode =
		requestedScope ?? persistedPreferences?.scope ?? DEFAULT_SETUP_SCOPE;
	const wouldUsePersistedScope =
		!requestedScope && Boolean(persistedPreferences?.scope);
	const wouldUsePersistedInstallMode =
		!requestedInstallMode &&
		Boolean(persistedPreferences?.installMode) &&
		(!persistedPreferences?.scope ||
			persistedPreferences.scope === effectiveScopeForInstallMode);
	const wouldUsePersistedMcpMode =
		!requestedMcpMode &&
		Boolean(persistedPreferences?.mcpMode) &&
		(!persistedPreferences?.scope ||
			persistedPreferences.scope === effectiveScopeForInstallMode);
	const wouldUsePersistedTeamMode =
		!requestedTeamMode &&
		Boolean(persistedPreferences?.teamMode) &&
		(!persistedPreferences?.scope ||
			persistedPreferences.scope === effectiveScopeForInstallMode);
	const wouldUsePersistedMergeAgents =
		!options.mergeAgentsPolicy &&
		typeof options.mergeAgents !== "boolean" &&
		resolvePersistedSetupMergeAgents(
			persistedPreferences,
			effectiveScopeForInstallMode,
		) !== undefined;
	const shouldReviewPersistedSetup =
		hasPersistedSetupPreferences(persistedPreferences) &&
		(wouldUsePersistedScope ||
			wouldUsePersistedInstallMode ||
			wouldUsePersistedMcpMode ||
			wouldUsePersistedTeamMode ||
			wouldUsePersistedMergeAgents) &&
		(typeof persistedSetupReviewPrompt === "function" ||
			(process.stdin.isTTY && process.stdout.isTTY));
	if (shouldReviewPersistedSetup) {
		persistedReviewDecision = persistedSetupReviewPrompt
			? await persistedSetupReviewPrompt(persistedPreferences)
			: await promptForPersistedSetupReview(persistedPreferences);
		console.log(
			`Setup preference review: ${persistedReviewDecision} (${formatPersistedSetupPreferenceSummary(persistedPreferences)})\n`,
		);
	}
	const resolvedScope = await resolveSetupScope(
		projectRoot,
		requestedScope,
		persistedReviewDecision,
		persistedPreferences,
		setupScopePrompt,
	);
	const requestedMergeAgentsPolicy =
		options.mergeAgentsPolicy ??
		(typeof options.mergeAgents === "boolean"
			? { kind: "set" as const, value: options.mergeAgents }
			: undefined);
	const inheritedMergeAgents =
		persistedReviewDecision === "reset"
			? undefined
			: resolvePersistedSetupMergeAgents(
				persistedPreferences,
				resolvedScope.scope,
			);
	const effectiveMergeAgents =
		requestedMergeAgentsPolicy?.kind === "set"
			? requestedMergeAgentsPolicy.value
			: requestedMergeAgentsPolicy?.kind === "clear"
				? undefined
				: inheritedMergeAgents;
	const resolvedInstallMode = await resolveSetupInstallMode(
		projectRoot,
		resolvedScope.scope,
		requestedInstallMode,
		installModePrompt,
		persistedReviewDecision,
		persistedPreferences,
	);
	const resolvedMcpMode = resolveSetupMcpMode(
		resolvedScope.scope,
		requestedMcpMode,
		persistedReviewDecision,
		persistedPreferences,
	);
	const resolvedTeamMode: SetupTeamMode =
		requestedTeamMode
		?? (
			persistedReviewDecision !== "reset" &&
			(!persistedPreferences?.scope || persistedPreferences.scope === resolvedScope.scope)
				? persistedPreferences?.teamMode
				: undefined
		)
		?? "enabled";
	const isTeamModeEnabled = teamModeEnabled(resolvedTeamMode);
	const skipNativeAgentRefresh =
		requestedSkipNativeAgentRefresh ||
		process.env[SKIP_NATIVE_AGENT_REFRESH_ENV] === "1";
	const scopeDirs = resolveScopeDirectories(resolvedScope.scope, projectRoot);
	if (!dryRun) {
		await recoverNativeHookClaimJournal(scopeDirs.codexHomeDir);
	}
	const nativeHookTransactionPlatform = nativeHookPlatform();
	let nativeHookTransactionAncestorPrecondition =
		await captureNativeHookTransactionAncestorPrecondition(
			scopeDirs.codexHomeDir,
			[
				scopeDirs.codexConfigFile,
				scopeDirs.codexHooksFile,
				getNotifyMetadataPath(scopeDirs.codexHomeDir),
				...(nativeHookTransactionPlatform === "win32"
					? [
							buildManagedCodexNativeHookWindowsShimPath(
								scopeDirs.codexHomeDir,
							),
						]
					: []),
			],
		);

	const existingConfigForMcpMigrationSnapshot =
		await captureNativeHookTransactionArtifact(
			scopeDirs.codexConfigFile,
			`config ${scopeDirs.codexConfigFile}`,
		);
	const existingConfigForMcpMigration = existingConfigForMcpMigrationSnapshot.bytes
		? decodeNativeHookTransactionUtf8(
			existingConfigForMcpMigrationSnapshot.bytes,
			`config ${scopeDirs.codexConfigFile}`,
		)
		: "";
	const notifyMetadataSnapshot = configRequiresNotificationMetadataSnapshot(
		existingConfigForMcpMigration,
		pkgRoot,
		resolvedScope.scope,
	)
		? await captureNativeHookTransactionArtifact(
			getNotifyMetadataPath(scopeDirs.codexHomeDir),
			`notification metadata ${getNotifyMetadataPath(scopeDirs.codexHomeDir)}`,
		)
		: undefined;
	const firstPartyMcpRegistrationKinds = [
		hasFirstPartyOmxMcpRegistrations(existingConfigForMcpMigration)
			? "config.toml [mcp_servers.omx_*]"
			: null,
		hasLocalOmxPluginMcpServerRegistrations(existingConfigForMcpMigration)
			? "plugin mcp_servers overrides"
			: null,
	].filter((kind): kind is string => typeof kind === "string");
	let removeFirstPartyMcpRegistrations = false;
	const shouldOfferFirstPartyMcpRemoval =
		resolvedMcpMode.mcpMode !== "compat" &&
		firstPartyMcpRegistrationKinds.length > 0;
	if (shouldOfferFirstPartyMcpRemoval) {
		const canPrompt =
			typeof firstPartyMcpRemovalPrompt === "function" ||
			(process.stdin.isTTY && process.stdout.isTTY);
		if (canPrompt) {
			removeFirstPartyMcpRegistrations = firstPartyMcpRemovalPrompt
				? await firstPartyMcpRemovalPrompt(
						scopeDirs.codexConfigFile,
						firstPartyMcpRegistrationKinds,
					)
				: await promptForFirstPartyMcpRemoval(
						scopeDirs.codexConfigFile,
						firstPartyMcpRegistrationKinds,
					);
		}
	}
	const scopeSourceMessage =
		resolvedScope.source === "persisted" ? " (from .omx/setup-scope.json)" : "";
	const backupContext = getBackupContext(resolvedScope.scope, projectRoot);
	const isPluginInstallMode = resolvedInstallMode?.installMode === "plugin";
	const pluginAgentsMdDst =
		resolvedScope.scope === "project"
			? join(projectRoot, "AGENTS.md")
			: join(scopeDirs.codexHomeDir, "AGENTS.md");
	const pluginDeveloperInstructionsDecision: PluginDeveloperInstructionsDecision =
		isPluginInstallMode
			? await resolvePluginDeveloperInstructionsDecision(
				existingConfigForMcpMigration,
				scopeDirs.codexConfigFile,
				{ pluginDeveloperInstructionsPrompt },
			)
			: {
				action: "preserve",
				state: "custom",
				reason: "non-plugin setup mode",
			};
	let pluginAgentsMdPathExists = false;
	let pluginAgentsMdIsSymlink = false;
	try {
		const pluginAgentsMdStat = await lstat(pluginAgentsMdDst);
		pluginAgentsMdPathExists = true;
		pluginAgentsMdIsSymlink = pluginAgentsMdStat.isSymbolicLink();
	} catch {
		pluginAgentsMdPathExists = false;
		pluginAgentsMdIsSymlink = false;
	}
	const usePluginAgentsMdDefault = isPluginInstallMode
		? effectiveMergeAgents || pluginAgentsMdIsSymlink
			? false
			: force
				? true
				: pluginAgentsMdPrompt
					? await pluginAgentsMdPrompt(pluginAgentsMdDst)
					: await promptForPluginAgentsMdDefault(pluginAgentsMdDst)
		: false;
	const codexHookFeatureSupport = resolveCodexHookFeatureSupportForCli({
		codexFeaturesProbe: options.codexFeaturesProbe,
		codexVersionProbe: options.codexVersionProbe,
	});
	const codexHookFeatureFlag = codexHookFeatureSupport.hookFeatureFlag;
	const pluginScopedHooksSupported = codexHookFeatureSupport.pluginScopedHooks;
	const shouldSyncSharedMcpRegistry = resolvedMcpMode.mcpMode === "compat";
	const registryCandidates = getUnifiedMcpRegistryCandidates();
	const defaultRegistryCandidates = registryCandidates.slice(0, 1);
	const sharedMcpRegistry: UnifiedMcpRegistryLoadResult = shouldSyncSharedMcpRegistry
		? await loadUnifiedMcpRegistry({
				candidates: options.mcpRegistryCandidates ?? defaultRegistryCandidates,
			})
		: { servers: [], warnings: [] };
	const legacyRegistryCandidate = getLegacyUnifiedMcpRegistryCandidate();
	const preflightMarketplace = isPluginInstallMode
		? await resolvePackagedOmxMarketplace(pkgRoot)
		: null;
	const statusLinePreset = isPluginInstallMode
		? undefined
		: await resolveStatusLinePresetForSetup(projectRoot, { force });
	const nativeHookSetupTransaction = await planNativeHookSetupTransaction({
		configPath: scopeDirs.codexConfigFile,
		hooksPath: scopeDirs.codexHooksFile,
		codexHomeDir: scopeDirs.codexHomeDir,
		pkgRoot,
		platform: nativeHookTransactionPlatform,

		isPluginInstallMode,
		pluginScopedHooks: pluginScopedHooksSupported,
		codexHookFeatureFlag,
		preserveFirstPartyMcp:
			shouldOfferFirstPartyMcpRemoval && !removeFirstPartyMcpRegistrations,
		removeFirstPartyMcp: removeFirstPartyMcpRegistrations,
		pluginDeveloperInstructionsDecision,
		pluginMarketplaceAvailable: preflightMarketplace !== null,
		sharedMcpRegistry,
		mcpMode: resolvedMcpMode.mcpMode,
		resolvedScope: resolvedScope.scope,
		modelUpgradePrompt,
		statusLinePreset,
		forceStatusLinePreset: force,
		configSnapshot: existingConfigForMcpMigrationSnapshot,
		notifyMetadataSnapshot,
	});
	const summary = createEmptyRunSummary();
	for (const precondition of nativeHookSetupTransaction.preconditions) {
		injectNativeHookTransactionFailure("before_precondition", precondition);
		await assertNativeHookTransactionPrecondition(precondition);
	}
	await assertNativeHookTransactionAncestorPrecondition(
		nativeHookTransactionAncestorPrecondition,
	);

	console.log("oh-my-codex setup");
	console.log("=================\n");
	console.log(
		`Using setup scope: ${resolvedScope.scope}${scopeSourceMessage}\n`,
	);
	if (resolvedInstallMode) {
		const installModeSourceMessage =
			resolvedInstallMode.source === "persisted"
				? " (from .omx/setup-scope.json)"
				: "";
		console.log(
			`Using setup install mode: ${resolvedInstallMode.installMode}${installModeSourceMessage}\n`,
		);
	}
	const mcpModeSourceMessage =
		resolvedMcpMode.source === "persisted"
			? " (from .omx/setup-scope.json)"
			: "";
	console.log(
		`Using setup MCP mode: ${resolvedMcpMode.mcpMode}${mcpModeSourceMessage}\n`,
	);
	console.log(`Using setup Team mode: ${resolvedTeamMode}\n`);
	if (shouldOfferFirstPartyMcpRemoval) {
		if (removeFirstPartyMcpRegistrations) {
			console.log(
				"Deprecated first-party OMX MCP registrations will be removed from config.toml during this setup run.\n",
			);
		} else {
			console.log(
				"warning: deprecated first-party OMX MCP registrations were detected but preserved. OMX supports CLI-first setup by default; rerun interactively and answer yes to remove them, or use --mcp compat only when explicit MCP compatibility is required.\n",
			);
		}
	}

	// Step 1: Ensure directories exist
	console.log("[1/8] Creating directories...");
	const dirs = isPluginInstallMode
		? [
				scopeDirs.codexHomeDir,
				scopeDirs.nativeAgentsDir,
				omxStateDir(projectRoot),
				omxPlansDir(projectRoot),
				omxLogsDir(projectRoot),
			]
		: [
				scopeDirs.codexHomeDir,
				scopeDirs.promptsDir,
				scopeDirs.skillsDir,
				scopeDirs.nativeAgentsDir,
				omxStateDir(projectRoot),
				omxPlansDir(projectRoot),
				omxLogsDir(projectRoot),
			];
	for (const dir of dirs) {
		if (!dryRun) {
			await mkdir(dir, { recursive: true });
		}
		if (verbose) console.log(`  mkdir ${dir}`);
	}
	const setupPreferencesToPersist: PersistedSetupScope = {
		scope: resolvedScope.scope,
		mcpMode: resolvedMcpMode.mcpMode,
		...(requestedTeamMode || persistedPreferences?.teamMode || resolvedTeamMode === "disabled"
			? { teamMode: resolvedTeamMode }
			: {}),
		...(resolvedInstallMode &&
		(resolvedScope.scope === "user" ||
			resolvedInstallMode.installMode === "plugin")
			? { installMode: resolvedInstallMode.installMode }
			: {}),
		...(effectiveMergeAgents !== undefined ? { mergeAgents: effectiveMergeAgents } : {}),
	};
	console.log("  Done.\n");

	if (resolvedScope.scope === "project") {
		const gitignoreResult = await ensureProjectGitignore(
			projectRoot,
			backupContext,
			{ dryRun, verbose },
		);
		if (gitignoreResult === "created") {
			console.log(
				"  Created .gitignore with OMX project ignore rules so local runtime state stays out of source control while .codex agents, skills, and prompts remain trackable.\n",
			);
		} else if (gitignoreResult === "updated") {
			console.log(
				"  Updated .gitignore with OMX project ignore rules so local runtime state stays out of source control while .codex agents, skills, and prompts remain trackable.\n",
			);
		}
	}

	const catalogCounts = getCatalogHeadlineCounts();

	// Step 2: Install agent prompts
	console.log("[2/8] Installing agent prompts...");
	{
		const promptsSrc = join(pkgRoot, "prompts");
		const promptsDst = scopeDirs.promptsDir;
		if (isPluginInstallMode) {
			summary.prompts = await cleanupPluginModeLegacyPrompts(
				promptsSrc,
				promptsDst,
				backupContext,
				{ dryRun, verbose },
			);
			console.log(
				summary.prompts.removed > 0
					? `  ${dryRun ? "Would archive and remove" : "Archived and removed"} ${summary.prompts.removed} legacy OMX-managed prompt file(s).\n`
					: "  Prompt refresh skipped; no legacy OMX-managed prompt files found.\n",
			);
		} else {
			summary.prompts = await installPrompts(
				promptsSrc,
				promptsDst,
				backupContext,
				{ force, dryRun, verbose, teamMode: resolvedTeamMode },
			);
			const cleanedLegacyPromptShims = await cleanupLegacySkillPromptShims(
				promptsSrc,
				promptsDst,
				{
					dryRun,
					verbose,
				},
			);
			summary.prompts.removed += cleanedLegacyPromptShims;
			if (cleanedLegacyPromptShims > 0) {
				if (dryRun) {
					console.log(
						`  Would remove ${cleanedLegacyPromptShims} legacy skill prompt shim file(s).`,
					);
				} else {
					console.log(
						`  Removed ${cleanedLegacyPromptShims} legacy skill prompt shim file(s).`,
					);
				}
			}
			if (catalogCounts) {
				console.log(
					`  Prompt refresh complete (catalog baseline: ${catalogCounts.prompts}).\n`,
				);
			} else {
				console.log("  Prompt refresh complete.\n");
			}
		}
	}

	// Step 3: Install skills
	console.log("[3/8] Installing skills...");
	{
		const skillsSrc = join(pkgRoot, "skills");
		const skillsDst = scopeDirs.skillsDir;
		if (isPluginInstallMode) {
			summary.skills = createEmptyCategorySummary();
			const cleanup = await cleanupLegacyManagedSkills(
				skillsSrc,
				skillsDst,
				backupContext,
				{ dryRun, verbose },
			);
			summary.skills.backedUp += cleanup.backedUp;
			summary.skills.removed += cleanup.removedSkillNames.length;
			summary.skills.skipped += cleanup.skippedSkillNames.length;
			for (const warning of cleanup.warnings) {
				console.log(`  warning: ${warning}`);
			}
			if (cleanup.removedSkillNames.length > 0) {
				console.log(
					`  ${dryRun ? "Would remove" : "Removed"} ${cleanup.removedSkillNames.length} legacy OMX-managed skill director${cleanup.removedSkillNames.length === 1 ? "y" : "ies"}.`,
				);
			} else {
				console.log(
					"  Skill refresh skipped; no removable legacy OMX-managed skill directories found.",
				);
			}
		} else {
			summary.skills = await installSkills(
				skillsSrc,
				skillsDst,
				backupContext,
				{
					force,
					dryRun,
					verbose,
					teamMode: resolvedTeamMode,
				},
			);
		}
		if (catalogCounts) {
			console.log(
				`  Skill refresh complete (catalog baseline: ${catalogCounts.skills}).\n`,
			);
		} else {
			console.log("  Skill refresh complete.\n");
		}
	}

	// Step 4: Install native agent configs
	console.log("[4/8] Installing native agent configs...");
	if (skipNativeAgentRefresh) {
		summary.nativeAgents = createEmptyCategorySummary();
		console.log(
			"  Native agent refresh skipped for background update-check setup refresh.\n",
		);
	} else if (isPluginInstallMode) {
		summary.nativeAgents = await refreshNativeAgentConfigs(
			pkgRoot,
			scopeDirs.nativeAgentsDir,
			backupContext,
			{
				force,
				dryRun,
				verbose,
				preserveUnmanagedObsoleteNativeAgents: true,
				teamMode: resolvedTeamMode,
			},
		);
		console.log(
			`  Native agent role refresh complete (${scopeDirs.nativeAgentsDir}); plugin mode still installs role TOML so agent_type routing works.\n`,
		);
	} else {
		summary.nativeAgents = await refreshNativeAgentConfigs(
			pkgRoot,
			scopeDirs.nativeAgentsDir,
			backupContext,
			{
				force,
				dryRun,
				verbose,
				teamMode: resolvedTeamMode,
			},
		);
		console.log(
			`  Native agent refresh complete (${scopeDirs.nativeAgentsDir}).\n`,
		);
	}

	// Step 5: Update config.toml
	console.log("[5/8] Updating config.toml...");
	const resolvedConfig = nativeHookSetupTransaction.finalConfig;
	const omxManagesTui = !isPluginInstallMode;
	if (verbose) {
		console.log(
			`  Native Codex hook feature flag: [features].${codexHookFeatureFlag}`,
		);
		console.log(
			`  Plugin-scoped Codex hooks: ${pluginScopedHooksSupported ? "supported" : "not reported; using legacy setup fallback"}`,
		);
	}
	if (
		shouldSyncSharedMcpRegistry &&
		!options.mcpRegistryCandidates &&
		!sharedMcpRegistry.sourcePath &&
		existsSync(legacyRegistryCandidate) &&
		!existsSync(defaultRegistryCandidates[0])
	) {
		console.log(
			`  warning: legacy shared MCP registry detected at ${legacyRegistryCandidate} but ignored by default; move or copy it to ${defaultRegistryCandidates[0]} and rerun setup with --mcp compat if you still want setup to sync those servers`,
		);
	}
	if (verbose && sharedMcpRegistry.sourcePath) {
		console.log(
			`  shared MCP registry: ${sharedMcpRegistry.sourcePath} (${sharedMcpRegistry.servers.length} servers)`,
		);
	}
	for (const warning of sharedMcpRegistry.warnings) {
		console.log(`  warning: ${warning}`);
	}
	logManagedCodexHooksPlanDiagnostics(nativeHookSetupTransaction.diagnostics, {
		verbose,
	});
	const changedHookArtifact = nativeHookSetupTransaction.artifacts.some(
		(artifact) => artifact.kind === "hooks",
	);
	const changedShimArtifact = nativeHookSetupTransaction.artifacts.some(
		(artifact) => artifact.kind === "shim",
	);
	const changedConfigArtifact = nativeHookSetupTransaction.artifacts.some(
		(artifact) => artifact.kind === "config",
	);
	if (changedHookArtifact) {
		if (
			isPluginInstallMode &&
			nativeHookSetupTransaction.pluginScopedHooks &&
			nativeHookSetupTransaction.hooksRemovedCount > 0
		) {
			summary.config.removed += nativeHookSetupTransaction.hooksRemovedCount;
		} else {
			summary.config.updated += 1;
		}
	} else if (!isPluginInstallMode || !nativeHookSetupTransaction.pluginScopedHooks) {
		summary.config.unchanged += 1;
	}
	if (changedShimArtifact) summary.config.updated += 1;
	if (changedConfigArtifact) summary.config.updated += 1;
	else summary.config.unchanged += 1;
	if (verbose && nativeHookSetupTransaction.modelUpgrade) {
		console.log(
			`  ${dryRun ? "would update" : "updated"} root model from ${nativeHookSetupTransaction.modelUpgrade.currentModel} to ${nativeHookSetupTransaction.modelUpgrade.modelOverride}`,
		);
	}

	if (isPluginInstallMode) {
		if (nativeHookSetupTransaction.cleanedLegacyConfig) {
			summary.config.removed += 1;
			console.log(
				`  ${dryRun ? "Would clean" : "Cleaned"} legacy OMX config entries for plugin mode.\n`,
			);
		} else {
			console.log("  Config refresh skipped; no legacy OMX config entries found.\n");
		}
		if (nativeHookSetupTransaction.pluginMarketplaceResult === "unavailable") {
			console.log(
				`  warning: packaged ${OMX_LOCAL_MARKETPLACE_NAME} Codex plugin marketplace metadata not found; /skills plugin discovery was not registered.`,
			);
		} else if (nativeHookSetupTransaction.pluginMarketplaceResult === "updated") {
			console.log(
				`  ${dryRun ? "Would register" : "Registered"} local Codex plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} (${pkgRoot}).`,
			);
		} else {
			console.log(
				`  Local Codex plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} already registered (${pkgRoot}).`,
			);
		}
		const pluginCacheRefresh = await refreshOmxPluginDiscoveryCache(
			pkgRoot,
			{
				dryRun,
				verbose,
			},
			scopeDirs.codexHomeDir,
		);
		if (pluginCacheRefresh.status === "refreshed") {
			if (pluginCacheRefresh.staleDirs.length > 0) {
				console.log(
					`  ${dryRun ? "Would invalidate" : "Invalidated"} ${pluginCacheRefresh.staleDirs.length} stale Codex plugin discovery cache entr${pluginCacheRefresh.staleDirs.length === 1 ? "y" : "ies"} so plugin skills refresh from the packaged manifest.`,
				);
			}
		} else if (pluginCacheRefresh.status === "unchanged") {
			console.log("  Codex plugin discovery cache already matches packaged plugin metadata.");
		}
		const pluginCacheMaterialize = await materializePackagedOmxPluginCache(
			scopeDirs.codexHomeDir,
			preflightMarketplace,
			{ dryRun, teamMode: resolvedTeamMode },
		);
		if (pluginCacheMaterialize.status === "materialized") {
			console.log(
				`  ${dryRun ? "Would install" : "Installed"} local Codex plugin cache for ${OMX_LOCAL_MARKETPLACE_NAME}/${OMX_PLUGIN_NAME} at ${pluginCacheMaterialize.cacheDir}.`,
			);
		} else if (pluginCacheMaterialize.status === "unchanged") {
			console.log("  Local Codex plugin cache already exposes packaged OMX skills.");
		}
		if (
			pluginCacheMaterialize.status === "materialized" ||
			pluginCacheMaterialize.status === "unchanged"
		) {
			console.log("  Start a new Codex session if /skills still shows stale OMX plugin skill metadata; the current session may keep its in-memory plugin registry until restart.");
		}
		if (shouldSyncSharedMcpRegistry && resolvedScope.scope === "user") {
			await syncClaudeCodeMcpSettings(
				sharedMcpRegistry,
				summary.config,
				backupContext,
				{ dryRun, verbose },
			);
		}
		console.log(
			pluginScopedHooksSupported
				? "  Plugin-scoped Codex hooks and runtime feature flags refresh complete (plugin_hooks, goals).\n"
				: `  Native Codex hooks fallback and runtime feature flags refresh complete (${scopeDirs.codexHooksFile}; hooks, goals).\n`,
		);
		if (pluginDeveloperInstructionsDecision.action !== "preserve") {
			if (nativeHookSetupTransaction.pluginDeveloperInstructionsResult === "updated") {
				console.log(
					`  ${dryRun ? "Would add" : "Added"} plugin-mode developer_instructions default (${scopeDirs.codexConfigFile}).\n`,
				);
			} else {
				console.log(
					`  Preserved existing developer_instructions in ${scopeDirs.codexConfigFile}.\n`,
				);
			}
		} else {
			console.log(
				`  Plugin-mode developer_instructions default preserved (${pluginDeveloperInstructionsDecision.reason}).\n`,
			);
		}
	} else {
		if (shouldSyncSharedMcpRegistry && resolvedScope.scope === "user") {
			await syncClaudeCodeMcpSettings(
				sharedMcpRegistry,
				summary.config,
				backupContext,
				{ dryRun, verbose },
			);
		}
		if (nativeHookSetupTransaction.repairedLegacyTeamRunTable) {
			console.log(
				"  Removed retired [mcp_servers.omx_team_run] config during refresh.",
			);
		}
		console.log(`  Config refresh complete (${scopeDirs.codexConfigFile}).\n`);
		console.log(
			`  Native Codex hooks refresh complete (${scopeDirs.codexHooksFile}).\n`,
		);
	}

	// Step 5.5: Verify team CLI interop surface is available when Team is enabled.
	console.log("[5.5/8] Verifying Team CLI API interop...");
	if (isTeamModeEnabled) {
		const teamToolsCheck = await verifyTeamCliApiInterop(pkgRoot);
		if (teamToolsCheck.ok) {
			console.log("  omx team api command detected (CLI-first interop ready)");
		} else {
			console.log(`  WARNING: ${teamToolsCheck.message}`);
			console.log("  Run `npm run build` and then re-run `omx setup`.");
		}
	} else {
		console.log("  Skipped because Team mode is disabled for this setup.");
	}
	console.log();

	// Step 6: Generate AGENTS.md
	console.log("[6/8] Generating AGENTS.md...");
	const activeSession =
		resolvedScope.scope === "project"
			? await readSessionState(projectRoot)
			: null;
	const sessionIsActive = activeSession && !isSessionStale(activeSession);
	if (isPluginInstallMode) {
		const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
		const pluginAgentsMdExists = pluginAgentsMdPathExists;
		if (existsSync(agentsMdSrc)) {
			const content = await readFile(agentsMdSrc, "utf-8");
			const modelTableContext = resolveAgentsModelTableContext(
				resolvedConfig,
				{
					codexHomeOverride: scopeDirs.codexHomeDir,
				},
			);
			const modelTableDefinitions =
				getAgentsModelTableDefinitionsForTeamMode(resolvedTeamMode);
			const rewritten = upsertAgentsModelTable(
				addGeneratedAgentsMarker(
					applyTeamModeToAgentsTemplate(
						applyPluginModeWordingToAgentsTemplate(
							content,
							resolvedScope.scope,
						),
						resolvedTeamMode,
					),
				),
				modelTableContext,
				modelTableDefinitions,
				{ codexHomeOverride: scopeDirs.codexHomeDir },
			);
			if (effectiveMergeAgents && pluginAgentsMdExists) {
				if (pluginAgentsMdIsSymlink) {
					summary.agentsMd.skipped += 1;
					console.log(
						`  Skipped plugin-mode AGENTS.md merge for symlinked ${pluginAgentsMdDst}; existing AGENTS.md left untouched.`,
					);
				} else {
					const existing = await readFile(pluginAgentsMdDst, "utf-8");
					const mergedAgentsContent = upsertManagedAgentsBlock(existing, rewritten);
					const canApplyManagedAgentsMerge = mergedAgentsContent !== existing;
					if (
						resolvedScope.scope === "project" &&
						sessionIsActive &&
						canApplyManagedAgentsMerge
					) {
						summary.agentsMd.skipped += 1;
						console.log(
							"  WARNING: Active omx session detected (pid " +
								activeSession?.pid +
								").",
						);
						console.log(
							"  Skipping AGENTS.md overwrite to avoid corrupting runtime overlay.",
						);
						console.log("  Stop the active session first, then re-run setup.");
					} else if (!canApplyManagedAgentsMerge) {
						summary.agentsMd.unchanged += 1;
						console.log(
							resolvedScope.scope === "project"
								? "  Plugin-mode AGENTS.md already up to date in project root."
								: `  Plugin-mode AGENTS.md already up to date in ${scopeDirs.codexHomeDir}.`,
						);
					} else {
						await syncManagedContent(
							mergedAgentsContent,
							pluginAgentsMdDst,
							summary.agentsMd,
							backupContext,
							{ dryRun, verbose },
							`plugin AGENTS merge ${pluginAgentsMdDst}`,
						);
						console.log(
							resolvedScope.scope === "project"
								? "  Merged plugin-mode OMX-managed AGENTS.md sections into project root."
								: `  Merged plugin-mode OMX-managed AGENTS.md sections into ${scopeDirs.codexHomeDir}.`,
						);
					}
				}
			} else if (usePluginAgentsMdDefault) {
				const existingPluginAgentsMd = pluginAgentsMdExists
					? await readFile(pluginAgentsMdDst, "utf-8")
					: "";
				const pluginAgentsMdContent = pluginAgentsMdExists
					? preserveUserOmxPolicyBlocks(existingPluginAgentsMd, rewritten)
					: rewritten;
				const defaultWouldChange = pluginAgentsMdExists
					? existingPluginAgentsMd !== pluginAgentsMdContent
					: true;
				if (
					resolvedScope.scope === "project" &&
					sessionIsActive &&
					defaultWouldChange
				) {
					summary.agentsMd.skipped += 1;
					console.log(
						"  WARNING: Active omx session detected (pid " +
							activeSession?.pid +
							").",
					);
					console.log(
						"  Skipping AGENTS.md overwrite to avoid corrupting runtime overlay.",
					);
					console.log("  Stop the active session first, then re-run setup.");
				} else {
					const result = await syncManagedAgentsContent(
						pluginAgentsMdContent,
						pluginAgentsMdDst,
						summary.agentsMd,
						backupContext,
						{
							agentsOverwritePrompt: options.agentsOverwritePrompt,
							dryRun,
							force,
							verbose,
						},
					);
					if (result === "updated") {
					console.log(
						resolvedScope.scope === "project"
							? "  Generated plugin-mode AGENTS.md defaults in project root."
							: `  Generated plugin-mode AGENTS.md defaults in ${scopeDirs.codexHomeDir}.`,
					);
				} else if (result === "unchanged") {
					console.log(
						resolvedScope.scope === "project"
							? "  Plugin-mode AGENTS.md defaults already up to date in project root."
							: `  Plugin-mode AGENTS.md defaults already up to date in ${scopeDirs.codexHomeDir}.`,
					);
					} else {
						console.log(
							`  Skipped plugin-mode AGENTS.md defaults for ${pluginAgentsMdDst}.`,
						);
					}
				}
			} else {
				summary.agentsMd.skipped += 1;
				console.log(
					pluginAgentsMdExists
						? "  Plugin-mode AGENTS.md defaults not selected; existing AGENTS.md left untouched.\n"
						: "  Plugin-mode AGENTS.md defaults not selected; no AGENTS.md was generated.\n",
				);
			}
		} else {
			summary.agentsMd.skipped += 1;
			console.log("  AGENTS.md template not found, skipping.");
		}
	} else {
		const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
		const agentsMdDst =
			resolvedScope.scope === "project"
				? join(projectRoot, "AGENTS.md")
				: join(scopeDirs.codexHomeDir, "AGENTS.md");
		const agentsMdExists = existsSync(agentsMdDst);

		// Guard: refuse to overwrite project-root AGENTS.md during active session
		if (existsSync(agentsMdSrc)) {
			const content = await readFile(agentsMdSrc, "utf-8");
			const modelTableContext = resolveAgentsModelTableContext(resolvedConfig, {
				codexHomeOverride: scopeDirs.codexHomeDir,
			});
			const modelTableDefinitions =
				getAgentsModelTableDefinitionsForTeamMode(resolvedTeamMode);
			const rewritten = upsertAgentsModelTable(
				addGeneratedAgentsMarker(
					applyTeamModeToAgentsTemplate(
						applyScopePathRewritesToAgentsTemplate(content, resolvedScope.scope),
						resolvedTeamMode,
					),
				),
				modelTableContext,
				modelTableDefinitions,
				{ codexHomeOverride: scopeDirs.codexHomeDir },
			);
			let changed = true;
			let canApplyManagedModelRefresh = false;
			let canApplyManagedRefreshDuringActiveSession = false;
			let managedRefreshContent = "";
			let canApplyManagedAgentsMerge = false;
			let mergedAgentsContent = "";
			if (agentsMdExists) {
				const existing = await readFile(agentsMdDst, "utf-8");
				changed = existing !== rewritten;
				if (!hasOmxAgentsContract(existing)) {
					const scopeFlag =
						resolvedScope.scope === "project" ? "--scope project" : "--scope user";
					console.log(
						`  WARNING: Existing AGENTS.md at ${agentsMdDst} lacks OMX contract markers; it may have been overwritten by another tool.`,
					);
					console.log(
						`  Repair safely with "omx setup ${scopeFlag} --merge-agents" to preserve local guidance, or "omx setup ${scopeFlag} --force" to replace it after backup.`,
					);
				}
				if (effectiveMergeAgents) {
					mergedAgentsContent = upsertManagedAgentsBlock(existing, rewritten);
					canApplyManagedAgentsMerge = mergedAgentsContent !== existing;
				} else {
					if (hasOmxManagedAgentsSections(existing)) {
						const existingIsGeneratedAgentsMd = isOmxGeneratedAgentsMd(existing);
						managedRefreshContent = teamModeEnabled(resolvedTeamMode)
							? upsertAgentsModelTable(
								existing,
								modelTableContext,
								modelTableDefinitions,
								{ codexHomeOverride: scopeDirs.codexHomeDir },
							)
							: existingIsGeneratedAgentsMd
								? rewritten
								: upsertManagedAgentsBlock(existing, rewritten);
						canApplyManagedModelRefresh = managedRefreshContent !== existing;
						canApplyManagedRefreshDuringActiveSession =
							canApplyManagedModelRefresh &&
							!teamModeEnabled(resolvedTeamMode) &&
							existingIsGeneratedAgentsMd;
					}
				}
			}

			if (
				resolvedScope.scope === "project" &&
				sessionIsActive &&
				agentsMdExists &&
				(changed || canApplyManagedAgentsMerge || canApplyManagedModelRefresh) &&
				!canApplyManagedRefreshDuringActiveSession
			) {
				summary.agentsMd.skipped += 1;
				console.log(
					"  WARNING: Active omx session detected (pid " +
						activeSession?.pid +
						").",
				);
				console.log(
					"  Skipping AGENTS.md overwrite to avoid corrupting runtime overlay.",
				);
				console.log("  Stop the active session first, then re-run setup.");
			} else if (
				effectiveMergeAgents &&
				agentsMdExists &&
				!canApplyManagedAgentsMerge
			) {
				summary.agentsMd.unchanged += 1;
				console.log(
					resolvedScope.scope === "project"
						? "  AGENTS.md already up to date in project root."
						: `  AGENTS.md already up to date in ${scopeDirs.codexHomeDir}.`,
				);
			} else if (canApplyManagedAgentsMerge) {
				await syncManagedContent(
					mergedAgentsContent,
					agentsMdDst,
					summary.agentsMd,
					backupContext,
					{ dryRun, verbose },
					`merged AGENTS ${agentsMdDst}`,
				);
				console.log(
					resolvedScope.scope === "project"
						? "  Merged OMX-managed AGENTS.md sections into project root."
						: `  Merged OMX-managed AGENTS.md sections into ${scopeDirs.codexHomeDir}.`,
				);
			} else if (canApplyManagedModelRefresh) {
				await syncManagedContent(
					managedRefreshContent,
					agentsMdDst,
					summary.agentsMd,
					backupContext,
					{ dryRun, verbose },
					`AGENTS model table ${agentsMdDst}`,
				);
				console.log(
					resolvedScope.scope === "project"
						? "  Refreshed AGENTS.md model capability table in project root."
						: `  Refreshed AGENTS.md model capability table in ${scopeDirs.codexHomeDir}.`,
				);
			} else {
				const result = await syncManagedAgentsContent(
					rewritten,
					agentsMdDst,
					summary.agentsMd,
					backupContext,
					{
						agentsOverwritePrompt: options.agentsOverwritePrompt,
						dryRun,
						force,
						verbose,
					},
				);

				if (result === "updated") {
					console.log(
						resolvedScope.scope === "project"
							? "  Generated AGENTS.md in project root."
							: `  Generated AGENTS.md in ${scopeDirs.codexHomeDir}.`,
					);
				} else if (result === "unchanged") {
					console.log(
						resolvedScope.scope === "project"
							? "  AGENTS.md already up to date in project root."
							: `  AGENTS.md already up to date in ${scopeDirs.codexHomeDir}.`,
					);
				} else if (agentsMdExists) {
					console.log(
						`  Skipped AGENTS.md overwrite for ${agentsMdDst}. Re-run interactively to confirm or use --force.`,
					);
				}
			}
			if (resolvedScope.scope === "user") {
				console.log("  User scope leaves project AGENTS.md unchanged.");
			}
		} else {
			summary.agentsMd.skipped += 1;
			console.log("  AGENTS.md template not found, skipping.");
		}
		console.log();
	}


	// Step 7: Set up notify hook
	console.log("[7/8] Configuring notification hook...");
	if (isPluginInstallMode) {
		console.log("  Skipped for plugin skill delivery mode.\n");
	} else {
		await setupNotifyHook(pkgRoot, { dryRun, verbose });
		console.log("  Done.\n");
	}

	// Step 8: Configure HUD
	console.log("[8/8] Configuring HUD...");
	const hudConfigPath = join(projectRoot, ".omx", "hud-config.json");
	if (force || !existsSync(hudConfigPath)) {
		if (!dryRun) {
			const defaultHudConfig = { preset: "focused" };
			await writeFile(hudConfigPath, JSON.stringify(defaultHudConfig, null, 2));
		}
		if (verbose) console.log("  Wrote .omx/hud-config.json");
		console.log("  HUD config created (preset: focused).");
	} else {
		console.log("  HUD config already exists (use --force to overwrite).");
	}
	if (omxManagesTui) {
		console.log("  StatusLine configured in config.toml via [tui] section.");
	}
	console.log();

	console.log("Setup refresh summary:");
	logCategorySummary("prompts", summary.prompts);
	logCategorySummary("skills", summary.skills);
	logCategorySummary("native_agents", summary.nativeAgents);
	logCategorySummary("agents_md", summary.agentsMd);
	logCategorySummary("config", summary.config);
	console.log();

	const legacySkillOverlapNotice = await buildLegacySkillOverlapNotice(
		resolvedScope.scope,
	);
	if (legacySkillOverlapNotice.shouldWarn) {
		console.log(`Migration hint: ${legacySkillOverlapNotice.message}`);
		console.log();
	}

	if (force) {
		console.log(
			"Force mode: enabled additional destructive maintenance (for example stale deprecated skill cleanup).",
		);
		console.log();
	}

	await persistSetupPreferences(projectRoot, setupPreferencesToPersist, {
		dryRun,
		verbose,
	});

	setupLatePhaseFailureInjector?.();
	nativeHookTransactionAncestorPrecondition =
		await captureNativeHookTransactionAncestorPrecondition(
			scopeDirs.codexHomeDir,
			nativeHookSetupTransaction.artifacts.map((artifact) => artifact.path),
		);
	await commitNativeHookTransaction(
		nativeHookSetupTransaction.artifacts,
		nativeHookSetupTransaction.preconditions,
		nativeHookTransactionAncestorPrecondition,
		backupContext,
		summary.config,
		{ dryRun, verbose },
	);

	console.log('Setup complete! Run "omx doctor" to verify installation.');
	console.log("\nNext steps:");
	console.log("  1. Start Codex CLI in your project directory");
	if (isPluginInstallMode) {
		console.log(
			`  2. Registered Codex marketplace ${OMX_LOCAL_MARKETPLACE_NAME} supplies OMX skills and workflow surfaces`,
		);
		console.log("  3. Browse plugin-provided skills with /skills");
		console.log(
			"  4. Plugin-mode AGENTS.md defaults provide persistent orchestration guidance; developer_instructions is an optional bootstrap",
		);
		console.log(
			"  5. Native agent role TOML files written to .codex/agents/ for agent_type routing",
		);
	} else {
		console.log(
			"  2. Use role/workflow keywords like $architect, $executor, and $plan in Codex",
		);
		console.log(
			"  3. Browse skills with /skills; AGENTS keyword routing can also activate them implicitly",
		);
		console.log(
			"  4. The AGENTS.md orchestration brain is loaded automatically",
		);
		console.log(
			"  5. Native agent role TOML files written to .codex/agents/; use explicit agent_type when spawning OMX roles",
		);
	}
	console.log(
		'  6. "omx explore" and "omx sparkshell" can hydrate native release binaries on first use; source installs still allow repo-local fallbacks and OMX_EXPLORE_BIN / OMX_SPARKSHELL_BIN overrides',
	);
	if (isGitHubCliConfigured()) {
		console.log("\nSupport the project: gh repo star Yeachan-Heo/oh-my-codex");
	}
}

function isLegacySkillPromptShim(content: string): boolean {
	const marker =
		/Read and follow the full skill instructions at\s+.*\/skills\/[^/\s]+\/SKILL\.md/i;
	return marker.test(content);
}

async function cleanupLegacySkillPromptShims(
	promptsSrcDir: string,
	promptsDstDir: string,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<number> {
	if (!existsSync(promptsSrcDir) || !existsSync(promptsDstDir)) return 0;

	const sourceFiles = new Set(
		(await readdir(promptsSrcDir)).filter((name) => name.endsWith(".md")),
	);

	const installedFiles = await readdir(promptsDstDir);
	let removed = 0;

	for (const file of installedFiles) {
		if (!file.endsWith(".md")) continue;
		if (sourceFiles.has(file)) continue;

		const fullPath = join(promptsDstDir, file);
		let content = "";
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			continue;
		}

		if (!isLegacySkillPromptShim(content)) continue;

		if (!options.dryRun) {
			await rm(fullPath, { force: true });
		}
		if (options.verbose) console.log(`  removed legacy prompt shim ${file}`);
		removed++;
	}

	return removed;
}

function isGitHubCliConfigured(): boolean {
	if (cachedGitHubCliConfigured !== undefined) {
		return cachedGitHubCliConfigured;
	}
	const result = spawnSync("gh", ["auth", "status"], {
		killSignal: "SIGKILL",
		stdio: "ignore",
		timeout: GITHUB_AUTH_STATUS_TIMEOUT_MS,
		windowsHide: true,
	});
	cachedGitHubCliConfigured = result.status === 0;
	return cachedGitHubCliConfigured;
}

async function syncManagedFileFromDisk(
	srcPath: string,
	dstPath: string,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
	verboseLabel: string,
): Promise<void> {
	const destinationExists = existsSync(dstPath);
	const changed = !destinationExists || (await filesDiffer(srcPath, dstPath));

	if (!changed) {
		summary.unchanged += 1;
		return;
	}

	if (await ensureBackup(dstPath, destinationExists, backupContext, options)) {
		summary.backedUp += 1;
	}

	if (!options.dryRun) {
		await mkdir(dirname(dstPath), { recursive: true });
		await copyFile(srcPath, dstPath);
	}

	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
		);
	}
}

async function syncManagedContent(
	content: string,
	dstPath: string,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
	verboseLabel: string,
): Promise<void> {
	const destinationExists = existsSync(dstPath);
	let changed = true;
	if (destinationExists) {
		const existing = await readFile(dstPath, "utf-8");
		changed = existing !== content;
	}

	if (!changed) {
		summary.unchanged += 1;
		return;
	}

	if (await ensureBackup(dstPath, destinationExists, backupContext, options)) {
		summary.backedUp += 1;
	}

	if (!options.dryRun) {
		await mkdir(dirname(dstPath), { recursive: true });
		await writeFile(dstPath, content);
	}

	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
		);
	}
}

interface NativeAgentInstallManifestEntry {
	sha256: string;
}

interface NativeAgentInstallManifest {
	version: 1;
	files: Record<string, NativeAgentInstallManifestEntry>;
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function nativeAgentInstallManifestPath(agentsDir: string): string {
	return join(agentsDir, "..", ".omx", "native-agents.json");
}

async function readNativeAgentInstallManifest(
	agentsDir: string,
): Promise<NativeAgentInstallManifest> {
	const manifestPath = nativeAgentInstallManifestPath(agentsDir);
	if (!existsSync(manifestPath)) return { version: 1, files: {} };

	try {
		const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as {
			version?: unknown;
			files?: unknown;
		};
		if (
			parsed.version !== 1 ||
			!parsed.files ||
			typeof parsed.files !== "object"
		) {
			return { version: 1, files: {} };
		}

		const files: Record<string, NativeAgentInstallManifestEntry> = {};
		for (const [fileName, entry] of Object.entries(
			parsed.files as Record<string, unknown>,
		)) {
			if (!fileName.endsWith(".toml")) continue;
			if (!entry || typeof entry !== "object") continue;
			const sha256 = (entry as { sha256?: unknown }).sha256;
			if (typeof sha256 === "string" && /^[0-9a-f]{64}$/i.test(sha256)) {
				files[fileName] = { sha256: sha256.toLowerCase() };
			}
		}
		return { version: 1, files };
	} catch {
		return { version: 1, files: {} };
	}
}

async function writeNativeAgentInstallManifest(
	agentsDir: string,
	manifest: NativeAgentInstallManifest,
): Promise<void> {
	const manifestPath = nativeAgentInstallManifestPath(agentsDir);
	await mkdir(dirname(manifestPath), { recursive: true });
	const sortedFiles = Object.fromEntries(
		Object.entries(manifest.files).sort(([left], [right]) =>
			left.localeCompare(right),
		),
	);
	await writeFile(
		manifestPath,
		JSON.stringify({ version: 1, files: sortedFiles }, null, 2) + "\n",
	);
}

async function syncNativeAgentToml(
	content: string,
	dstPath: string,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose" | "force">,
	verboseLabel: string,
	manifest: NativeAgentInstallManifest,
): Promise<void> {
	const fileName = basename(dstPath);
	const nextHash = hashContent(content);
	const destinationExists = existsSync(dstPath);

	if (!destinationExists) {
		if (!options.dryRun) {
			await mkdir(dirname(dstPath), { recursive: true });
			await writeFile(dstPath, content);
			manifest.files[fileName] = { sha256: nextHash };
		}
		summary.updated += 1;
		if (options.verbose) {
			console.log(
				`  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
			);
		}
		return;
	}

	const existing = await readFile(dstPath, "utf-8");
	const existingHash = hashContent(existing);
	if (existing === content) {
		if (!options.dryRun) {
			manifest.files[fileName] = { sha256: nextHash };
		}
		summary.unchanged += 1;
		return;
	}

	const priorHash = manifest.files[fileName]?.sha256;
	const safeToOverwrite = options.force || priorHash === existingHash;
	if (!safeToOverwrite) {
		summary.skipped += 1;
		if (options.verbose) {
			console.log(
				`  skipped ${verboseLabel} (local modifications preserved; use --force to overwrite)`,
			);
		}
		return;
	}

	if (await ensureBackup(dstPath, true, backupContext, options)) {
		summary.backedUp += 1;
	}

	if (!options.dryRun) {
		await mkdir(dirname(dstPath), { recursive: true });
		await writeFile(dstPath, content);
		manifest.files[fileName] = { sha256: nextHash };
	}

	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} ${verboseLabel}`,
		);
	}
}


async function syncManagedAgentsContent(
	content: string,
	dstPath: string,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<
		SetupOptions,
		"agentsOverwritePrompt" | "dryRun" | "force" | "verbose"
	>,
): Promise<"updated" | "unchanged" | "skipped"> {
	const destinationExists = existsSync(dstPath);
	let existing = "";
	let changed = true;
	let acceptedInteractiveOverwrite = false;

	if (destinationExists) {
		existing = await readFile(dstPath, "utf-8");
		changed = existing !== content;
	}

	if (!changed) {
		summary.unchanged += 1;
		return "unchanged";
	}

	if (destinationExists && !options.force) {
		if (options.dryRun) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(`  would prompt before overwriting ${dstPath}`);
			}
			return "skipped";
		}

		const shouldOverwrite = options.agentsOverwritePrompt
			? await options.agentsOverwritePrompt(dstPath)
			: await promptForAgentsOverwrite(dstPath);

		if (!shouldOverwrite) {
			summary.skipped += 1;
			if (options.verbose) {
				const managedLabel = isOmxGeneratedAgentsMd(existing)
					? "managed"
					: "unmanaged";
				console.log(`  skipped ${managedLabel} AGENTS.md at ${dstPath}`);
			}
			return "skipped";
		}

		acceptedInteractiveOverwrite = true;
	}

	if (
		acceptedInteractiveOverwrite &&
		(await moveExistingAgentsToDeterministicBackup(dstPath, options))
	) {
		summary.backedUp += 1;
	} else if (
		await ensureBackup(dstPath, destinationExists, backupContext, options)
	) {
		summary.backedUp += 1;
	}

	if (!options.dryRun) {
		await mkdir(dirname(dstPath), { recursive: true });
		await writeFile(dstPath, content);
	}

	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} AGENTS ${dstPath}`,
		);
	}
	return "updated";
}

async function installPrompts(
	srcDir: string,
	dstDir: string,
	backupContext: SetupBackupContext,
	options: SetupOptions,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();
	if (!existsSync(srcDir)) return summary;

	const manifest = tryReadCatalogManifest();
	const agentStatusByName = manifest
		? getCatalogAgentStatusByName(manifest)
		: null;

	const files = await readdir(srcDir);

	for (const file of files) {
		if (!file.endsWith(".md")) continue;
		const promptName = file.slice(0, -3);
		if (!teamModeEnabled(options.teamMode) && TEAM_MODE_PROMPT_NAMES.has(promptName)) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(`  skipped ${file} (Team mode disabled)`);
			}
			continue;
		}

		const status = agentStatusByName?.get(promptName);
		if (manifest && !isSetupPromptAssetName(promptName, manifest)) {
			summary.skipped += 1;
			if (options.verbose) {
				const label = status ?? "unclassified";
				console.log(`  skipped ${file} (status: ${label})`);
			}
			continue;
		}

		const src = join(srcDir, file);
		const dst = join(dstDir, file);
		const srcStat = await stat(src);
		if (!srcStat.isFile()) continue;
		await syncManagedFileFromDisk(
			src,
			dst,
			summary,
			backupContext,
			options,
			`prompt ${file}`,
		);
	}

	if (manifest && existsSync(dstDir)) {
		const installedFiles = await readdir(dstDir);
		for (const file of installedFiles) {
			if (!file.endsWith(".md")) continue;
			const promptName = file.slice(0, -3);
			const status = agentStatusByName?.get(promptName);
			const disabledTeamPrompt = !teamModeEnabled(options.teamMode) && TEAM_MODE_PROMPT_NAMES.has(promptName);
			if (isSetupPromptAssetName(promptName, manifest) && !disabledTeamPrompt) continue;
			if (!options.force && !disabledTeamPrompt) continue;

			const stalePromptPath = join(dstDir, file);
			if (!existsSync(stalePromptPath)) continue;

			if (await ensureBackup(stalePromptPath, true, backupContext, options)) {
				summary.backedUp += 1;
			}
			if (!options.dryRun) {
				await rm(stalePromptPath, { force: true });
			}
			summary.removed += 1;
			if (options.verbose) {
				const prefix = options.dryRun
					? "would remove stale prompt"
					: "removed stale prompt";
				const label = status ?? "unlisted";
				const reason = disabledTeamPrompt ? ", Team mode disabled" : "";
				console.log(`  ${prefix} ${file} (status: ${label}${reason})`);
			}
		}
	}

	return summary;
}

function isGeneratedOmxNativeAgentToml(
	content: string,
	agentName: string,
): boolean {
	const firstLine = content.split(/\r?\n/, 1)[0]?.trim();
	return firstLine === `# oh-my-codex agent: ${agentName}`;
}

async function cleanupGeneratedNonInstallableNativeAgents(
	agentsDir: string,
	manifest: NonNullable<ReturnType<typeof tryReadCatalogManifest>>,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();
	if (!existsSync(agentsDir)) return summary;

	const agentStatusByName = getCatalogAgentStatusByName(manifest);
	const installedFiles = await readdir(agentsDir);

	for (const file of installedFiles) {
		if (!file.endsWith(".toml")) continue;
		const agentName = file.slice(0, -5);
		const agentStatus = agentStatusByName.get(agentName);
		if (
			agentStatus === undefined ||
			isNativeAgentInstallableStatus(agentStatus)
		) {
			continue;
		}

		const staleAgentPath = join(agentsDir, file);
		let content = "";
		try {
			content = await readFile(staleAgentPath, "utf-8");
		} catch {
			continue;
		}

		if (!isGeneratedOmxNativeAgentToml(content, agentName)) {
			if (options.verbose) {
				console.log(
					`  skipped stale native agent ${file}: not an OMX-generated native agent`,
				);
			}
			continue;
		}

		if (await ensureBackup(staleAgentPath, true, backupContext, options)) {
			summary.backedUp += 1;
		}
		if (!options.dryRun) {
			await rm(staleAgentPath, { force: true });
		}
		summary.removed += 1;
		if (options.verbose) {
			const prefix = options.dryRun
				? "would remove stale generated native agent"
				: "removed stale generated native agent";
			console.log(`  ${prefix} ${file} (status: ${agentStatus})`);
		}
	}

	return summary;
}

async function refreshNativeAgentConfigs(
	pkgRoot: string,
	agentsDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose" | "force"> & {
		preserveUnmanagedObsoleteNativeAgents?: boolean;
		teamMode?: SetupTeamMode;
	},
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();

	if (!options.dryRun) {
		await mkdir(agentsDir, { recursive: true });
	}

	const nativeAgentManifest = await readNativeAgentInstallManifest(agentsDir);
	const manifest = tryReadCatalogManifest();
	const agentStatusByName = manifest
		? getCatalogAgentStatusByName(manifest)
		: null;
	const staleCandidateNativeAgentNames = new Set(
		manifest?.agents.map((agent) => agent.name) ?? [],
	);

	const nativeAgentNames = manifest
		? [...getInstallableNativeAgentNames(manifest)].sort()
		: Object.keys(AGENT_DEFINITIONS).sort();

	for (const name of nativeAgentNames) {
		staleCandidateNativeAgentNames.add(name);
		if (!teamModeEnabled(options.teamMode) && TEAM_MODE_NATIVE_AGENT_NAMES.has(name)) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(`  skipped native agent ${name}.toml (Team mode disabled)`);
			}
			continue;
		}
		const agent = AGENT_DEFINITIONS[name];
		if (!agent) {
			if (options.verbose) {
				console.log(`  skipped native agent ${name}.toml (missing definition)`);
			}
			summary.skipped += 1;
			continue;
		}

		const promptPath = join(pkgRoot, "prompts", `${name}.md`);
		if (!existsSync(promptPath)) {
			continue;
		}

		const promptContent = await readFile(promptPath, "utf-8");
		const toml = generateAgentToml(agent, promptContent, {
			codexHomeOverride: join(agentsDir, ".."),
		});
		const dst = join(agentsDir, `${name}.toml`);
		await syncNativeAgentToml(
			toml,
			dst,
			summary,
			backupContext,
			options,
			`native agent ${name}.toml`,
			nativeAgentManifest,
		);
	}

	summary.removed += await cleanupObsoleteNativeAgents(
		agentsDir,
		backupContext,
		options,
	);

	if (manifest) {
		const generatedCleanup = await cleanupGeneratedNonInstallableNativeAgents(
			agentsDir,
			manifest,
			backupContext,
			options,
		);
		summary.backedUp += generatedCleanup.backedUp;
		summary.removed += generatedCleanup.removed;
	}

	if (manifest && existsSync(agentsDir)) {
		const installedFiles = await readdir(agentsDir);
		for (const file of installedFiles) {
			if (!file.endsWith(".toml")) continue;
			const agentName = file.slice(0, -5);
			const agentStatus = agentStatusByName?.get(agentName);
			const disabledTeamAgent = !teamModeEnabled(options.teamMode) && TEAM_MODE_NATIVE_AGENT_NAMES.has(agentName);
			if (isNativeAgentInstallableStatus(agentStatus) && !disabledTeamAgent) continue;
			if (!options.force && !disabledTeamAgent) continue;
			if (
				!staleCandidateNativeAgentNames.has(agentName) &&
				agentStatus === undefined
			)
				continue;

			const staleAgentPath = join(agentsDir, file);
			if (!existsSync(staleAgentPath)) continue;

			if (await ensureBackup(staleAgentPath, true, backupContext, options)) {
				summary.backedUp += 1;
			}
			if (!options.dryRun) {
				await rm(staleAgentPath, { force: true });
				delete nativeAgentManifest.files[file];
			}
			summary.removed += 1;
			if (options.verbose) {
				const prefix = options.dryRun
					? "would remove stale native agent"
					: "removed stale native agent";
				const label = agentStatus ?? "unlisted";
				const reason = disabledTeamAgent ? ", Team mode disabled" : "";
				console.log(`  ${prefix} ${file} (status: ${label}${reason})`);
			}
		}
	}

	if (!options.dryRun) {
		await writeNativeAgentInstallManifest(agentsDir, nativeAgentManifest);
	}

	return summary;
}

async function cleanupObsoleteNativeAgents(
	agentsDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose"> & {
		preserveUnmanagedObsoleteNativeAgents?: boolean;
	},
): Promise<number> {
	if (!existsSync(agentsDir)) return 0;

	const installedFiles = await readdir(agentsDir);
	let removed = 0;

	for (const file of installedFiles) {
		if (!file.endsWith(".toml")) continue;

		const fullPath = join(agentsDir, file);
		let content = "";
		try {
			content = await readFile(fullPath, "utf-8");
		} catch {
			continue;
		}

		if (!containsTomlKey(content, OBSOLETE_NATIVE_AGENT_FIELD)) continue;

		const agentName = file.slice(0, -5);
		if (
			options.preserveUnmanagedObsoleteNativeAgents &&
			!isGeneratedOmxNativeAgentToml(content, agentName)
		) {
			if (options.verbose) {
				console.log(
					`  skipped stale obsolete native agent ${file}: not an OMX-generated native agent`,
				);
			}
			continue;
		}

		if (await ensureBackup(fullPath, true, backupContext, options)) {
			// backup created for pre-existing obsolete native agent config
		}
		if (!options.dryRun) {
			await rm(fullPath, { force: true });
		}
		if (options.verbose) {
			const prefix = options.dryRun
				? "would remove stale obsolete native agent"
				: "removed stale obsolete native agent";
			console.log(`  ${prefix} ${file}`);
		}
		removed += 1;
	}

	return removed;
}

export async function installSkills(
	srcDir: string,
	dstDir: string,
	backupContext: SetupBackupContext,
	options: SetupOptions,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();
	if (!existsSync(srcDir)) return summary;
	const installableSkillNames = getSetupInstallableSkillNames();
	const installableSkills: Array<{
		name: string;
		sourceDir: string;
		destinationDir: string;
	}> = [];
	const manifest = tryReadCatalogManifest();
	const skillStatusByName = manifest
		? new Map(manifest.skills.map((skill) => [skill.name, skill.status]))
		: null;
	const isSetupInstallableSkill = (
		skillName: string,
		status: string | undefined,
	): boolean =>
		isCatalogInstallableStatus(status) || installableSkillNames.has(skillName);
	const entries = await readdir(srcDir, { withFileTypes: true });
	const staleCandidateSkillNames = new Set(
		manifest?.skills.map((skill) => skill.name) ?? [],
	);
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		staleCandidateSkillNames.add(entry.name);
		if (!teamModeEnabled(options.teamMode) && TEAM_MODE_SKILL_NAMES.has(entry.name)) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(`  skipped ${entry.name}/ (Team mode disabled)`);
			}
			continue;
		}
		const status = skillStatusByName?.get(entry.name);
		if (skillStatusByName && !isSetupInstallableSkill(entry.name, status)) {
			summary.skipped += 1;
			if (options.verbose) {
				const label = status ?? "unlisted";
				console.log(`  skipped ${entry.name}/ (status: ${label})`);
			}
			continue;
		}

		const skillSrc = join(srcDir, entry.name);
		const skillDst = join(dstDir, entry.name);
		const skillMd = join(skillSrc, "SKILL.md");
		if (!existsSync(skillMd)) continue;

		installableSkills.push({
			name: entry.name,
			sourceDir: skillSrc,
			destinationDir: skillDst,
		});
	}

	for (const skill of installableSkills) {
		await validateSkillFile(join(skill.sourceDir, "SKILL.md"));
	}

	for (const skill of installableSkills) {
		const skillName = skill.name;
		const skillSrc = skill.sourceDir;
		const skillDst = skill.destinationDir;

		if (!options.dryRun) {
			await mkdir(skillDst, { recursive: true });
		}

		const skillFiles = await readdir(skillSrc);
		for (const sf of skillFiles) {
			const sfPath = join(skillSrc, sf);
			const sfStat = await stat(sfPath);
			if (!sfStat.isFile()) continue;
			const dstPath = join(skillDst, sf);
			if (sf === "SKILL.md") {
				await syncManagedContent(
					rewriteInstalledSkillDescriptionBadge(
						await readFile(sfPath, "utf-8"),
						sfPath,
					),
					dstPath,
					summary,
					backupContext,
					options,
					`skill ${skillName}/${sf}`,
				);
				continue;
			}
			await syncManagedFileFromDisk(
				sfPath,
				dstPath,
				summary,
				backupContext,
				options,
				`skill ${skillName}/${sf}`,
			);
		}
	}

	if (manifest && existsSync(dstDir)) {
		for (const staleSkill of staleCandidateSkillNames) {
			const status = skillStatusByName?.get(staleSkill);
			const disabledTeamSkill = !teamModeEnabled(options.teamMode) && TEAM_MODE_SKILL_NAMES.has(staleSkill);
			if (isSetupInstallableSkill(staleSkill, status) && !disabledTeamSkill) continue;
			const hardDeprecated = HARD_DEPRECATED_SKILL_NAMES.has(staleSkill);
			if (!options.force && !hardDeprecated && !disabledTeamSkill) continue;

			const staleSkillDir = join(dstDir, staleSkill);
			if (!existsSync(staleSkillDir)) continue;

			if (!options.dryRun) {
				await rm(staleSkillDir, { recursive: true, force: true });
			}
			summary.removed += 1;
			if (options.verbose) {
				const prefix = options.dryRun
					? "would remove stale skill"
					: "removed stale skill";
				const label = status ?? "unlisted";
				const reason = disabledTeamSkill
					? ", Team mode disabled"
					: hardDeprecated ? ", hard-deprecated" : "";
				console.log(`  ${prefix} ${staleSkill}/ (status: ${label}${reason})`);
			}
		}
	}

	return summary;
}

async function removeDirectoryCopyAware(
	sourceDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
	const destinationExists = existsSync(sourceDir);
	if (!destinationExists) return false;

	const relativePath = relative(backupContext.baseRoot, sourceDir);
	const safeRelativePath =
		relativePath.startsWith("..") || relativePath === ""
			? sourceDir.replace(/^[/]+/, "")
			: relativePath;
	const backupPath = join(backupContext.backupRoot, safeRelativePath);

	if (!options.dryRun) {
		await mkdir(dirname(backupPath), { recursive: true });
		await cp(sourceDir, backupPath, { recursive: true });
	}
	if (options.verbose) {
		console.log(`  backup ${sourceDir} -> ${backupPath}`);
	}

	if (!options.dryRun) {
		await rm(sourceDir, { recursive: true, force: true });
	}
	return true;
}

interface LegacySkillCleanupResult {
	backedUp: number;
	removedSkillNames: string[];
	skippedSkillNames: string[];
	warnings: string[];
}

async function cleanupLegacyManagedSkills(
	srcDir: string,
	dstDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<LegacySkillCleanupResult> {
	const result: LegacySkillCleanupResult = {
		backedUp: 0,
		removedSkillNames: [],
		skippedSkillNames: [],
		warnings: [],
	};
	if (!existsSync(dstDir) || !existsSync(srcDir)) {
		return result;
	}

	const manifest = tryReadCatalogManifest();
	const installableSkillNames = getSetupInstallableSkillNames(manifest);

	for (const skillName of installableSkillNames) {
		const shippedSkillDir = join(srcDir, skillName);
		const installedSkillDir = join(dstDir, skillName);
		const shippedSkillMd = join(shippedSkillDir, "SKILL.md");
		const installedSkillMd = join(installedSkillDir, "SKILL.md");
		if (!existsSync(shippedSkillMd) || !existsSync(installedSkillMd)) continue;

		const [shippedSkillContent, installedSkillContent] = await Promise.all([
			readFile(shippedSkillMd, "utf-8"),
			readFile(installedSkillMd, "utf-8"),
		]);
		const expectedInstalledContent = rewriteInstalledSkillDescriptionBadge(
			shippedSkillContent,
			shippedSkillMd,
		);

		if (installedSkillContent !== expectedInstalledContent) {
			const warning = `Skipping legacy skill cleanup for ${skillName}: installed SKILL.md differs from OMX-managed content.`;
			result.skippedSkillNames.push(skillName);
			result.warnings.push(warning);
			continue;
		}

		const removed = await removeDirectoryCopyAware(
			installedSkillDir,
			backupContext,
			options,
		);
		if (removed) {
			result.backedUp += 1;
			result.removedSkillNames.push(skillName);
		}
	}

	return result;
}

interface NotifyMergePlan {
	notifyCommand: string[] | false;
	metadataPath?: string;
	metadata?: Record<string, unknown>;
	metadataSnapshot?: NativeHookTransactionArtifactSnapshot;
}

function getNotifyMetadataPath(codexHomeDir: string): string {
	return join(codexHomeDir, ".omx", "notify-dispatch.json");
}

function isOmxDispatcherNotifyCommand(
	notifyCommand: readonly string[] | null | undefined,
	pkgRoot: string,
): boolean {
	return Boolean(
		isOmxManagedNotifyCommand(notifyCommand, pkgRoot) &&
			notifyCommand?.some((part) =>
				/(?:^|[\\/])notify-dispatcher\.js$/.test(part),
			),
	);
}

function configRequiresNotificationMetadataSnapshot(
	existingConfig: string,
	pkgRoot: string,
	scope: SetupScope,
): boolean {
	if (scope === "project") return false;
	const existingNotify = getRootTomlArray(existingConfig, "notify");
	return Boolean(
		existingNotify &&
			(!isOmxManagedNotifyCommand(existingNotify, pkgRoot) ||
				isOmxDispatcherNotifyCommand(existingNotify, pkgRoot)),
	);
}

function parseNotifyMetadataSnapshot(
	snapshot: NativeHookTransactionArtifactSnapshot,
	label: string,
): Record<string, unknown> | null {
	if (snapshot.bytes === null) return null;
	const content = decodeNativeHookTransactionUtf8(snapshot.bytes, label);
	try {
		const parsed = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("expected a JSON object");
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new ManagedCodexHooksPlanError(
			"invalid_document",
			`Refusing to read ${label}: invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
			{ label },
		);
	}
}

async function buildNotifyMergePlan(
	existingConfig: string,
	pkgRoot: string,
	codexHomeDir: string,
	scope: SetupScope,
	metadataSnapshot?: NativeHookTransactionArtifactSnapshot,
): Promise<NotifyMergePlan> {
	if (scope === "project") {
		return { notifyCommand: false };
	}

	const omxNotify = ["node", join(pkgRoot, "dist", "scripts", "notify-hook.js")];
	const metadataPath = getNotifyMetadataPath(codexHomeDir);
	const dispatcherNotify = [
		"node",
		join(pkgRoot, "dist", "scripts", "notify-dispatcher.js"),
		"--metadata",
		metadataPath,
	];
	const existingNotify = getRootTomlArray(existingConfig, "notify");

	if (!existingNotify) {
		return { notifyCommand: omxNotify };
	}

	if (isOmxManagedNotifyCommand(existingNotify, pkgRoot)) {
		if (!isOmxDispatcherNotifyCommand(existingNotify, pkgRoot)) {
			return { notifyCommand: omxNotify };
		}
		if (!metadataSnapshot) {
			throw new Error(
				`Missing notification metadata snapshot for ${metadataPath}; refusing to plan from a newly captured baseline.`,
			);
		}
		const metadata = parseNotifyMetadataSnapshot(
			metadataSnapshot,
			`notification metadata ${metadataPath}`,
		);
		const previousNotify = metadata?.previousNotify;
		if (
			Array.isArray(previousNotify) &&
			previousNotify.every((item) => typeof item === "string")
		) {
			const sanitizedPreviousNotify = sanitizePreviousNotifyCommand(
				previousNotify,
				pkgRoot,
			);
			if (!sanitizedPreviousNotify) {
				return { notifyCommand: omxNotify, metadataPath, metadataSnapshot };
			}
			return {
				notifyCommand: dispatcherNotify,
				metadataPath,
				metadataSnapshot,
				metadata: {
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: sanitizedPreviousNotify,
					omxNotify,
					dispatcherNotify,
				},
			};
		}
		return { notifyCommand: omxNotify, metadataPath, metadataSnapshot };
	}

	return {
		notifyCommand: dispatcherNotify,
		metadataPath,
		metadata: {
			managedBy: "oh-my-codex",
			version: 1,
			previousNotify: sanitizePreviousNotifyCommand(existingNotify, pkgRoot),
			omxNotify,
			dispatcherNotify,
		},
	};
}

interface ManagedConfigWritePlan {
	finalConfig: string;
	currentModel: string | undefined;
	modelOverride: string | undefined;
	notifyPlan: NotifyMergePlan;
	repairedLegacyTeamRunTable: boolean;
}

async function planManagedConfig(
	hooksPath: string,
	pkgRoot: string,
	sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
	mcpMode: SetupMcpMode,
	preserveExistingFirstPartyMcp: boolean,
	scope: SetupScope,
	codexHomeDir: string,
	options: Pick<SetupOptions, "verbose" | "modelUpgradePrompt"> & {
		statusLinePreset?: HudPreset;
		forceStatusLinePreset?: boolean;
		codexHookFeatureFlag: CodexHookFeatureFlag;
		hookCommandPlatform: NodeJS.Platform;
		existingConfig?: string;
		notifyMetadataSnapshot?: NativeHookTransactionArtifactSnapshot;
		managedHookTrustState: Record<string, { trusted_hash: string }>;
		priorManagedHookTrustState: Record<string, { trusted_hash: string }>;
		legacyHookTrustState: Record<
			string,
			{ trusted_hash: string; enabled?: boolean }
		>;
	},
): Promise<ManagedConfigWritePlan> {
	const existingConfig = options.existingConfig ?? "";
	const hadLegacyTeamRunTable = hasLegacyOmxTeamRunTable(existingConfig);
	const currentModel = getRootModelName(existingConfig);
	let modelOverride: string | undefined;

	if (currentModel && LEGACY_SETUP_MODELS.has(currentModel)) {
		const shouldPrompt =
			typeof options.modelUpgradePrompt === "function" ||
			(process.stdin.isTTY && process.stdout.isTTY);
		if (shouldPrompt) {
			const shouldUpgrade = options.modelUpgradePrompt
				? await options.modelUpgradePrompt(currentModel, DEFAULT_SETUP_MODEL)
				: await promptForModelUpgrade(currentModel, DEFAULT_SETUP_MODEL);
			if (shouldUpgrade) {
				modelOverride = DEFAULT_SETUP_MODEL;
			}
		}
	}

	const notifyPlan = await buildNotifyMergePlan(
		existingConfig,
		pkgRoot,
		codexHomeDir,
		scope,
		options.notifyMetadataSnapshot,
	);
	const finalConfig = buildMergedConfig(existingConfig, pkgRoot, {
		includeTui: true,
		codexHooksFile: hooksPath,
		codexHomeDir,
		hookCommandPlatform: options.hookCommandPlatform,
		managedHookTrustState: options.managedHookTrustState,
		priorManagedHookTrustState: options.priorManagedHookTrustState,
		legacyHookTrustState: options.legacyHookTrustState,
		codexHookFeatureFlag: options.codexHookFeatureFlag,
		modelOverride,
		sharedMcpServers: sharedMcpRegistry.servers,
		sharedMcpRegistrySource: sharedMcpRegistry.sourcePath,
		verbose: options.verbose,
		statusLinePreset: options.statusLinePreset,
		forceStatusLinePreset: options.forceStatusLinePreset,
		notifyCommand: notifyPlan.notifyCommand,
		includeFirstPartyMcp: mcpMode === "compat",
		preserveExistingFirstPartyMcp,
	});
	return {
		finalConfig,
		currentModel,
		modelOverride,
		notifyPlan,
		repairedLegacyTeamRunTable:
			hadLegacyTeamRunTable && !hasLegacyOmxTeamRunTable(finalConfig),
	};
}



function getClaudeCodeSettingsPath(homeDir = homedir()): string {
	return join(homeDir, ".claude", "settings.json");
}

async function syncClaudeCodeMcpSettings(
	sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	if (sharedMcpRegistry.servers.length === 0) return;

	const settingsPath = getClaudeCodeSettingsPath();
	const existing = existsSync(settingsPath)
		? await readFile(settingsPath, "utf-8")
		: "";
	const syncPlan = planClaudeCodeMcpSettingsSync(
		existing,
		sharedMcpRegistry.servers,
	);

	for (const warning of syncPlan.warnings) {
		console.log(`  warning: ${warning}`);
	}
	if (syncPlan.warnings.length > 0) {
		summary.skipped += 1;
		return;
	}
	if (!syncPlan.content) {
		summary.unchanged += 1;
		if (options.verbose && syncPlan.unchanged.length > 0) {
			console.log(
				`  shared MCP servers already present in Claude Code settings (${settingsPath})`,
			);
		}
		return;
	}

	await syncManagedContent(
		syncPlan.content,
		settingsPath,
		summary,
		backupContext,
		options,
		`Claude Code MCP settings ${settingsPath} (+${syncPlan.added.join(", ")})`,
	);
}

async function setupNotifyHook(
	pkgRoot: string,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	const hookScript = join(pkgRoot, "dist", "scripts", "notify-hook.js");
	if (!existsSync(hookScript)) {
		if (options.verbose)
			console.log("  Notify hook script not found, skipping.");
		return;
	}
	// The notify hook is configured in config.toml via mergeConfig
	if (options.verbose) console.log(`  Notify hook: ${hookScript}`);
}

async function verifyTeamCliApiInterop(
	pkgRoot: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
	const teamCliPath = join(pkgRoot, "dist", "cli", "team.js");
	if (!existsSync(teamCliPath)) {
		return { ok: false, message: `missing ${teamCliPath}` };
	}

	try {
		const content = await readFile(teamCliPath, "utf-8");
		const missing = REQUIRED_TEAM_CLI_API_MARKERS.filter(
			(marker) => !content.includes(marker),
		);
		if (missing.length > 0) {
			return {
				ok: false,
				message: `team CLI interop markers missing: ${missing.join(", ")}`,
			};
		}
		return { ok: true };
	} catch {
		return { ok: false, message: `cannot read ${teamCliPath}` };
	}
}
