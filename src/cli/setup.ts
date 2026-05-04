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
	rm,
} from "fs/promises";
import { join, dirname, relative, basename } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { createInterface } from "readline/promises";
import { homedir } from "os";
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
	hasLegacyOmxTeamRunTable,
	stripExistingOmxBlocks,
	stripExistingSharedMcpRegistryBlock,
	stripOmxEnvSettings,
	stripOmxFeatureFlags,
	stripOmxSeededBehavioralDefaults,
	upsertPluginModeRuntimeFeatureFlags,
	OMX_PLUGIN_DEVELOPER_INSTRUCTIONS,
} from "../config/generator.js";
import { mergeManagedCodexHooksConfig } from "../config/codex-hooks.js";
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
	addGeneratedAgentsMarker,
	hasOmxManagedAgentsSections,
	isOmxGeneratedAgentsMd,
	upsertManagedAgentsBlock,
} from "../utils/agents-md.js";
import { DEFAULT_HUD_CONFIG, type HudPreset } from "../hud/types.js";
import {
	SETUP_INSTALL_MODES,
	SETUP_SCOPES,
	getSetupScopeFilePath,
	readPersistedSetupPreferences,
	type PersistedSetupScope,
	type SetupInstallMode,
	type SetupScope,
} from "./setup-preferences.js";
import {
	OMX_LOCAL_MARKETPLACE_NAME,
	resolvePackagedOmxMarketplace,
	upsertLocalOmxMarketplaceRegistration,
} from "./plugin-marketplace.js";

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

interface SetupOptions {
	codexVersionProbe?: () => string | null;
	force?: boolean;
	mergeAgents?: boolean;
	dryRun?: boolean;
	installMode?: SetupInstallMode;
	scope?: SetupScope;
	verbose?: boolean;
	agentsOverwritePrompt?: (destinationPath: string) => Promise<boolean>;
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
	pluginDeveloperInstructionsPrompt?: (configPath: string) => Promise<boolean>;
	pluginDeveloperInstructionsOverwritePrompt?: (
		configPath: string,
	) => Promise<boolean>;
	mcpRegistryCandidates?: string[];
}

export { SETUP_INSTALL_MODES, SETUP_SCOPES };
export type { SetupInstallMode, SetupScope };

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

interface ManagedConfigResult {
	finalConfig: string;
	omxManagesTui: boolean;
	repairedLegacyTeamRunTable: boolean;
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
const HARD_DEPRECATED_SKILL_NAMES = new Set(["web-clone"]);

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
		`Registered Codex plugin marketplace surfaces supply OMX workflows, prompts, and native-agent roles when the plugin is installed. They must follow this file, not override it.\nUser-installed skills may still live under ${userSkillPath}. Setup-owned prompt files and native-agent TOML defaults are intentionally omitted in plugin mode unless explicitly installed.`,
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

type PersistedSetupReviewDecision = "keep" | "review" | "reset";

const REQUIRED_TEAM_CLI_API_MARKERS = [
	"if (subcommand === 'api')",
	"executeTeamApiOperation",
	"TEAM_API_OPERATIONS",
] as const;

const DEFAULT_SETUP_SCOPE: SetupScope = "user";
const DEFAULT_SETUP_INSTALL_MODE: SetupInstallMode = "legacy";
const LEGACY_SETUP_MODEL = "gpt-5.3-codex";
const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;
const OBSOLETE_NATIVE_AGENT_FIELD = ["skill", "ref"].join("_");

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

function hasPersistedSetupPreferences(
	preferences: Partial<PersistedSetupScope> | undefined,
): preferences is Partial<PersistedSetupScope> {
	return Boolean(preferences?.scope || preferences?.installMode);
}

function formatPersistedSetupPreferenceSummary(
	preferences: Partial<PersistedSetupScope>,
): string {
	return [
		`scope=${preferences.scope ?? "not recorded"}`,
		`installMode=${preferences.installMode ?? "not recorded"}`,
	].join(", ");
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
		return false;
	}
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		const answer = (
			await rl.question(
				`Plugin mode: install OMX AGENTS.md defaults at "${destinationPath}"? [y/N]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function promptForPluginDeveloperInstructionsDefault(
	configPath: string,
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
				`Plugin mode: add OMX developer_instructions defaults to "${configPath}"? [y/N]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

async function promptForPluginDeveloperInstructionsOverwrite(
	configPath: string,
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
				`Plugin mode: overwrite existing developer_instructions in "${configPath}" with OMX defaults? [y/N]: `,
			)
		)
			.trim()
			.toLowerCase();
		return answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
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

async function discoverOmxPluginCacheDir(
	cacheRoot = join(codexHome(), "plugins", "cache"),
): Promise<string | null> {
	if (!existsSync(cacheRoot)) return null;

	const queue: Array<{ path: string; depth: number }> = [
		{ path: cacheRoot, depth: 0 },
	];
	const maxDepth = 5;

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;

		const manifestPath = join(current.path, ".codex-plugin", "plugin.json");
		if (existsSync(manifestPath)) {
			const name = await readPluginManifestName(manifestPath);
			if (name === "oh-my-codex") {
				return current.path;
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

	return null;
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

	if (scope !== "user") return null;

	const discoveredPluginCacheDir = await discoverOmxPluginCacheDir();
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
	await mkdir(dirname(scopePath), { recursive: true });
	await writeFile(scopePath, JSON.stringify(preferences, null, 2) + "\n");
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

async function cleanupPluginModeLegacyNativeAgents(
	pkgRoot: string,
	agentsDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();
	if (!existsSync(agentsDir)) return summary;

	const manifest = tryReadCatalogManifest();
	const agentStatusByName = manifest
		? getCatalogAgentStatusByName(manifest)
		: null;

	for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
		const status = agentStatusByName?.get(name);
		if (agentStatusByName && !isNativeAgentInstallableStatus(status)) continue;

		const dst = join(agentsDir, `${name}.toml`);
		const promptPath = join(pkgRoot, "prompts", `${name}.md`);
		if (!existsSync(dst) || !existsSync(promptPath)) continue;

		const promptContent = await readFile(promptPath, "utf-8");
		const expectedToml = generateAgentToml(agent, promptContent, {
			codexHomeOverride: join(agentsDir, ".."),
		});
		const installedToml = await readFile(dst, "utf-8");
		if (
			installedToml !== expectedToml &&
			!isGeneratedOmxNativeAgentToml(installedToml, name)
		) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(
					`  skipped legacy native agent cleanup for ${name}.toml: installed content is not an OMX-generated native agent`,
				);
			}
			continue;
		}

		if (await ensureBackup(dst, true, backupContext, options)) {
			summary.backedUp += 1;
		}
		if (!options.dryRun) {
			await rm(dst, { force: true });
		}
		summary.removed += 1;
		if (options.verbose) {
			console.log(
				`  ${options.dryRun ? "would archive and remove" : "archived and removed"} legacy native agent ${name}.toml`,
			);
		}
	}

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

	await removeEmptyDirectoryIfPresent(agentsDir, options);
	return summary;
}

function stripPluginModeLegacyRootDefaults(config: string): string {
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
		if (
			index < boundary &&
			/^\s*developer_instructions\s*=/.test(line) &&
			line.includes("You have oh-my-codex installed.")
		) {
			continue;
		}
		result.push(line);
	}

	return result.join("\n").replace(/\n{3,}/g, "\n\n");
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
	const lines = config.trimEnd().split(/\r?\n/);
	const firstTableIndex = lines.findIndex((entry) => /^\s*\[/.test(entry));
	const boundary = firstTableIndex < 0 ? lines.length : firstTableIndex;
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`^\\s*${escapedKey}\\s*=`);

	for (let i = 0; i < boundary; i++) {
		if (pattern.test(lines[i])) {
			lines[i] = line;
			return lines.join("\n") + "\n";
		}
	}

	return insertRootTomlKey(config, line);
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

async function ensurePluginMarketplaceRegistration(
	configPath: string,
	pkgRoot: string,
	backupContext: SetupBackupContext,
	summary: SetupCategorySummary,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<"updated" | "unchanged" | "unavailable"> {
	const packagedMarketplace = await resolvePackagedOmxMarketplace(pkgRoot);
	if (!packagedMarketplace) {
		summary.skipped += 1;
		return "unavailable";
	}

	const existingConfig = existsSync(configPath)
		? await readFile(configPath, "utf-8")
		: "";
	const nextConfig = upsertLocalOmxMarketplaceRegistration(
		existingConfig,
		pkgRoot,
	);
	const destinationExists = existsSync(configPath);

	if (nextConfig === existingConfig) {
		summary.unchanged += 1;
		return "unchanged";
	}

	if (
		await ensureBackup(configPath, destinationExists, backupContext, options)
	) {
		summary.backedUp += 1;
	}
	if (!options.dryRun) {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, nextConfig);
	}
	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would register" : "registered"} local Codex plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} from ${pkgRoot}`,
		);
	}
	return "updated";
}

async function applyPluginModeHooksConfig(
	configPath: string,
	hooksPath: string,
	pkgRoot: string,
	backupContext: SetupBackupContext,
	summary: SetupCategorySummary,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
	const existingConfig = existsSync(configPath)
		? await readFile(configPath, "utf-8")
		: "";
	const nextConfig =
		upsertPluginModeRuntimeFeatureFlags(existingConfig).trimEnd() + "\n";
	if (nextConfig !== existingConfig) {
		if (
			await ensureBackup(
				configPath,
				existsSync(configPath),
				backupContext,
				options,
			)
		) {
			summary.backedUp += 1;
		}
		if (!options.dryRun) {
			await mkdir(dirname(configPath), { recursive: true });
			await writeFile(configPath, nextConfig);
		}
		summary.updated += 1;
	} else {
		summary.unchanged += 1;
	}

	const existingHooksContent = existsSync(hooksPath)
		? await readFile(hooksPath, "utf-8")
		: null;
	const hooksConfig = mergeManagedCodexHooksConfig(
		existingHooksContent,
		pkgRoot,
	);
	await syncManagedContent(
		hooksConfig,
		hooksPath,
		summary,
		backupContext,
		options,
		`native hooks ${hooksPath}`,
	);

		if (options.verbose) {
			console.log(
				`  ${options.dryRun ? "would configure" : "configured"} plugin-mode native hooks and runtime feature flags at ${hooksPath}`,
			);
		}
}

async function applyPluginDeveloperInstructionsDefault(
	configPath: string,
	backupContext: SetupBackupContext,
	summary: SetupCategorySummary,
	options: Pick<
		SetupOptions,
		"dryRun" | "verbose" | "pluginDeveloperInstructionsOverwritePrompt"
	>,
): Promise<"updated" | "exists" | "skipped"> {
	const existing = existsSync(configPath)
		? await readFile(configPath, "utf-8")
		: "";
	const line = `developer_instructions = ${JSON.stringify(OMX_PLUGIN_DEVELOPER_INSTRUCTIONS)}`;
	const hasExistingDeveloperInstructions = rootHasTomlKey(
		existing,
		"developer_instructions",
	);
	if (hasExistingDeveloperInstructions) {
		const overwrite = options.pluginDeveloperInstructionsOverwritePrompt
			? await options.pluginDeveloperInstructionsOverwritePrompt(configPath)
			: await promptForPluginDeveloperInstructionsOverwrite(configPath);
		if (!overwrite) {
			summary.skipped += 1;
			if (options.verbose) {
				console.log(
					"  skipped plugin developer_instructions default: root developer_instructions already exists",
				);
			}
			return "exists";
		}
	}

	const nextConfig = hasExistingDeveloperInstructions
		? replaceRootTomlKey(existing, "developer_instructions", line)
		: insertRootTomlKey(existing, line);
	const destinationExists = existsSync(configPath);
	if (
		await ensureBackup(configPath, destinationExists, backupContext, options)
	) {
		summary.backedUp += 1;
	}
	if (!options.dryRun) {
		await mkdir(dirname(configPath), { recursive: true });
		await writeFile(configPath, nextConfig);
	}
	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would add" : "added"} plugin developer_instructions default to ${configPath}`,
		);
	}
	return "updated";
}

async function cleanupPluginModeLegacyConfig(
	configPath: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
	if (!existsSync(configPath)) return false;

	const original = await readFile(configPath, "utf-8");
	let config = original;
	config = stripExistingOmxBlocks(config).cleaned;
	config = stripExistingSharedMcpRegistryBlock(config).cleaned;
	config = stripPluginModeLegacyRootDefaults(config);
	config = stripOmxSeededBehavioralDefaults(config);
	config = stripOmxFeatureFlags(config);
	config = stripOmxEnvSettings(config);
	config = config.trim();
	const nextConfig = config.length > 0 ? `${config}\n` : "";

	if (nextConfig === original) return false;

	if (await ensureBackup(configPath, true, backupContext, options)) {
		// backup created for pre-existing config
	}
	if (!options.dryRun) {
		if (nextConfig.length === 0) {
			await rm(configPath, { force: true });
		} else {
			await writeFile(configPath, nextConfig);
		}
	}
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would clean" : nextConfig.length === 0 ? "removed" : "cleaned"} legacy OMX config ${basename(configPath)}`,
		);
	}
	return true;
}

async function cleanupPluginModeLegacyAgentsMd(
	agentsMdPath: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<boolean> {
	if (!existsSync(agentsMdPath)) return false;

	const content = await readFile(agentsMdPath, "utf-8");
	if (!isOmxGeneratedAgentsMd(content)) return false;

	if (await ensureBackup(agentsMdPath, true, backupContext, options)) {
		// backup created for pre-existing AGENTS.md
	}
	if (!options.dryRun) {
		await rm(agentsMdPath, { force: true });
	}
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would remove" : "removed"} legacy OMX-generated AGENTS.md`,
		);
	}
	return true;
}

export async function setup(options: SetupOptions = {}): Promise<void> {
	const {
		force = false,
		dryRun = false,
		installMode: requestedInstallMode,
		scope: requestedScope,
		verbose = false,
		setupScopePrompt,
		persistedSetupReviewPrompt,
		installModePrompt,
		modelUpgradePrompt,
		pluginAgentsMdPrompt,
		pluginDeveloperInstructionsPrompt,
		pluginDeveloperInstructionsOverwritePrompt,
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
	const shouldReviewPersistedSetup =
		hasPersistedSetupPreferences(persistedPreferences) &&
		(wouldUsePersistedScope || wouldUsePersistedInstallMode) &&
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
	const resolvedInstallMode = await resolveSetupInstallMode(
		projectRoot,
		resolvedScope.scope,
		requestedInstallMode,
		installModePrompt,
		persistedReviewDecision,
		persistedPreferences,
	);
	const scopeDirs = resolveScopeDirectories(resolvedScope.scope, projectRoot);
	const scopeSourceMessage =
		resolvedScope.source === "persisted" ? " (from .omx/setup-scope.json)" : "";
	const backupContext = getBackupContext(resolvedScope.scope, projectRoot);
	const isPluginInstallMode = resolvedInstallMode?.installMode === "plugin";
	const pluginAgentsMdDst =
		resolvedScope.scope === "project"
			? join(projectRoot, "AGENTS.md")
			: join(scopeDirs.codexHomeDir, "AGENTS.md");
	const usePluginDeveloperInstructionsDefault = isPluginInstallMode
		? pluginDeveloperInstructionsPrompt
			? await pluginDeveloperInstructionsPrompt(scopeDirs.codexConfigFile)
			: await promptForPluginDeveloperInstructionsDefault(
					scopeDirs.codexConfigFile,
				)
		: false;
	const usePluginAgentsMdDefault = isPluginInstallMode
		? pluginAgentsMdPrompt
			? await pluginAgentsMdPrompt(pluginAgentsMdDst)
			: await promptForPluginAgentsMdDefault(pluginAgentsMdDst)
		: false;

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

	// Step 1: Ensure directories exist
	console.log("[1/8] Creating directories...");
	const dirs = isPluginInstallMode
		? [
				scopeDirs.codexHomeDir,
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
	const setupPreferencesToPersist: PersistedSetupScope =
		resolvedInstallMode &&
		(resolvedScope.scope === "user" ||
			resolvedInstallMode.installMode === "plugin")
			? {
					scope: resolvedScope.scope,
					installMode: resolvedInstallMode.installMode,
				}
			: {
					scope: resolvedScope.scope,
				};
	await persistSetupPreferences(projectRoot, setupPreferencesToPersist, {
		dryRun,
		verbose,
	});
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
	const summary = createEmptyRunSummary();

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
				{ force, dryRun, verbose },
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
	if (isPluginInstallMode) {
		summary.nativeAgents = await cleanupPluginModeLegacyNativeAgents(
			pkgRoot,
			scopeDirs.nativeAgentsDir,
			backupContext,
			{ dryRun, verbose },
		);
		console.log(
			summary.nativeAgents.removed > 0
				? `  ${dryRun ? "Would archive and remove" : "Archived and removed"} ${summary.nativeAgents.removed} legacy OMX-managed native agent config(s).\n`
				: "  Native agent refresh skipped; no legacy OMX-managed native agent configs found.\n",
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
			},
		);
		console.log(
			`  Native agent refresh complete (${scopeDirs.nativeAgentsDir}).\n`,
		);
	}

	// Step 5: Update config.toml
	console.log("[5/8] Updating config.toml...");
	let resolvedConfig = "";
	let omxManagesTui = false;
	if (isPluginInstallMode) {
		const configCleaned = await cleanupPluginModeLegacyConfig(
			scopeDirs.codexConfigFile,
			backupContext,
			{ dryRun, verbose },
		);
		if (configCleaned) summary.config.removed += 1;
		console.log(
			configCleaned
				? `  ${dryRun ? "Would clean" : "Cleaned"} legacy OMX config entries for plugin mode.\n`
				: "  Config refresh skipped; no legacy OMX config entries found.\n",
		);

		await applyPluginModeHooksConfig(
			scopeDirs.codexConfigFile,
			scopeDirs.codexHooksFile,
			pkgRoot,
			backupContext,
			summary.config,
			{ dryRun, verbose },
		);
		const pluginMarketplaceResult = await ensurePluginMarketplaceRegistration(
			scopeDirs.codexConfigFile,
			pkgRoot,
			backupContext,
			summary.config,
			{ dryRun, verbose },
		);
		if (pluginMarketplaceResult === "unavailable") {
			console.log(
				`  warning: packaged ${OMX_LOCAL_MARKETPLACE_NAME} Codex plugin marketplace metadata not found; /skills plugin discovery was not registered.`,
			);
		} else if (pluginMarketplaceResult === "updated") {
			console.log(
				`  ${dryRun ? "Would register" : "Registered"} local Codex plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} (${pkgRoot}).`,
			);
		} else {
			console.log(
				`  Local Codex plugin marketplace ${OMX_LOCAL_MARKETPLACE_NAME} already registered (${pkgRoot}).`,
			);
		}
			resolvedConfig = existsSync(scopeDirs.codexConfigFile)
				? await readFile(scopeDirs.codexConfigFile, "utf-8")
				: "";
			console.log(
				`  Native Codex hooks and runtime feature flags refresh complete (${scopeDirs.codexHooksFile}; codex_hooks, goals).\n`,
			);

		if (usePluginDeveloperInstructionsDefault) {
			const developerInstructionsResult =
				await applyPluginDeveloperInstructionsDefault(
					scopeDirs.codexConfigFile,
					backupContext,
					summary.config,
					{
						dryRun,
						verbose,
						pluginDeveloperInstructionsOverwritePrompt,
					},
				);
			if (developerInstructionsResult === "updated") {
				resolvedConfig = existsSync(scopeDirs.codexConfigFile)
					? await readFile(scopeDirs.codexConfigFile, "utf-8")
					: "";
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
				"  Plugin-mode developer_instructions default not selected.\n",
			);
		}
	} else {
		const registryCandidates = getUnifiedMcpRegistryCandidates();
		const defaultRegistryCandidates = registryCandidates.slice(0, 1);
		const legacyRegistryCandidate = getLegacyUnifiedMcpRegistryCandidate();
		const sharedMcpRegistry = await loadUnifiedMcpRegistry({
			candidates: options.mcpRegistryCandidates ?? defaultRegistryCandidates,
		});
		if (
			!options.mcpRegistryCandidates &&
			!sharedMcpRegistry.sourcePath &&
			existsSync(legacyRegistryCandidate) &&
			!existsSync(defaultRegistryCandidates[0])
		) {
			console.log(
				`  warning: legacy shared MCP registry detected at ${legacyRegistryCandidate} but ignored by default; move it to ${defaultRegistryCandidates[0]} if you still want setup to sync those servers`,
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
		const statusLinePreset = await resolveStatusLinePresetForSetup(
			projectRoot,
			{ force },
		);
		const managedConfig = await updateManagedConfig(
			scopeDirs.codexConfigFile,
			pkgRoot,
			sharedMcpRegistry,
			summary.config,
			backupContext,
			{
				dryRun,
				modelUpgradePrompt,
				verbose,
				statusLinePreset,
				forceStatusLinePreset: force,
			},
		);
		resolvedConfig = managedConfig.finalConfig;
		omxManagesTui = managedConfig.omxManagesTui;
		if (managedConfig.repairedLegacyTeamRunTable) {
			console.log(
				"  Removed retired [mcp_servers.omx_team_run] config during refresh.",
			);
		}
		if (resolvedScope.scope === "user") {
			await syncClaudeCodeMcpSettings(
				sharedMcpRegistry,
				summary.config,
				backupContext,
				{ dryRun, verbose },
			);
		}
		console.log(`  Config refresh complete (${scopeDirs.codexConfigFile}).\n`);

		const existingHooksContent = existsSync(scopeDirs.codexHooksFile)
			? await readFile(scopeDirs.codexHooksFile, "utf-8")
			: null;
		const hooksConfig = mergeManagedCodexHooksConfig(
			existingHooksContent,
			pkgRoot,
		);
		await syncManagedContent(
			hooksConfig,
			scopeDirs.codexHooksFile,
			summary.config,
			backupContext,
			{ dryRun, verbose },
			`native hooks ${scopeDirs.codexHooksFile}`,
		);
		console.log(
			`  Native Codex hooks refresh complete (${scopeDirs.codexHooksFile}).\n`,
		);
	}

	// Step 5.5: Verify team CLI interop surface is available.
	console.log("[5.5/8] Verifying Team CLI API interop...");
	const teamToolsCheck = await verifyTeamCliApiInterop(pkgRoot);
	if (teamToolsCheck.ok) {
		console.log("  omx team api command detected (CLI-first interop ready)");
	} else {
		console.log(`  WARNING: ${teamToolsCheck.message}`);
		console.log("  Run `npm run build` and then re-run `omx setup`.");
	}
	console.log();

	// Step 6: Generate AGENTS.md
	console.log("[6/8] Generating AGENTS.md...");
	if (isPluginInstallMode) {
		const agentsMdRemoved = await cleanupPluginModeLegacyAgentsMd(
			pluginAgentsMdDst,
			backupContext,
			{ dryRun, verbose },
		);
		if (agentsMdRemoved) {
			summary.agentsMd.removed += 1;
			console.log(
				`  ${dryRun ? "Would remove" : "Removed"} legacy OMX-generated AGENTS.md for plugin mode.\n`,
			);
		}

		if (usePluginAgentsMdDefault) {
			const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
			if (existsSync(agentsMdSrc)) {
				const content = await readFile(agentsMdSrc, "utf-8");
				const modelTableContext = resolveAgentsModelTableContext(
					resolvedConfig,
					{
						codexHomeOverride: scopeDirs.codexHomeDir,
					},
				);
				const rewritten = upsertAgentsModelTable(
					addGeneratedAgentsMarker(
						applyPluginModeWordingToAgentsTemplate(
							content,
							resolvedScope.scope,
						),
					),
					modelTableContext,
				);
				const result = await syncManagedAgentsContent(
					rewritten,
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
			} else {
				summary.agentsMd.skipped += 1;
				console.log("  AGENTS.md template not found, skipping.");
			}
		} else {
			summary.agentsMd.skipped += 1;
			console.log(
				agentsMdRemoved
					? "  Plugin-mode AGENTS.md defaults not selected.\n"
					: "  AGENTS.md generation skipped; no legacy OMX-generated AGENTS.md found and defaults not selected.\n",
			);
		}
	} else {
		const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
		const agentsMdDst =
			resolvedScope.scope === "project"
				? join(projectRoot, "AGENTS.md")
				: join(scopeDirs.codexHomeDir, "AGENTS.md");
		const agentsMdExists = existsSync(agentsMdDst);

		// Guard: refuse to overwrite project-root AGENTS.md during active session
		const activeSession =
			resolvedScope.scope === "project"
				? await readSessionState(projectRoot)
				: null;
		const sessionIsActive = activeSession && !isSessionStale(activeSession);

		if (existsSync(agentsMdSrc)) {
			const content = await readFile(agentsMdSrc, "utf-8");
			const modelTableContext = resolveAgentsModelTableContext(resolvedConfig, {
				codexHomeOverride: scopeDirs.codexHomeDir,
			});
			const rewritten = upsertAgentsModelTable(
				addGeneratedAgentsMarker(
					applyScopePathRewritesToAgentsTemplate(content, resolvedScope.scope),
				),
				modelTableContext,
			);
			let changed = true;
			let canApplyManagedModelRefresh = false;
			let managedRefreshContent = "";
			let canApplyManagedAgentsMerge = false;
			let mergedAgentsContent = "";
			if (agentsMdExists) {
				const existing = await readFile(agentsMdDst, "utf-8");
				changed = existing !== rewritten;
				if (options.mergeAgents) {
					mergedAgentsContent = upsertManagedAgentsBlock(existing, rewritten);
					canApplyManagedAgentsMerge = mergedAgentsContent !== existing;
				} else {
					if (hasOmxManagedAgentsSections(existing)) {
						managedRefreshContent = upsertAgentsModelTable(
							existing,
							modelTableContext,
						);
						canApplyManagedModelRefresh = managedRefreshContent !== existing;
					}
				}
			}

			if (
				resolvedScope.scope === "project" &&
				sessionIsActive &&
				agentsMdExists &&
				(changed || canApplyManagedAgentsMerge || canApplyManagedModelRefresh)
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
				options.mergeAgents &&
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

	console.log('Setup complete! Run "omx doctor" to verify installation.');
	console.log("\nNext steps:");
	console.log("  1. Start Codex CLI in your project directory");
	if (isPluginInstallMode) {
		console.log(
			`  2. Registered Codex marketplace ${OMX_LOCAL_MARKETPLACE_NAME} supplies OMX skills and workflow surfaces`,
		);
		console.log("  3. Browse plugin-provided skills with /skills");
		console.log(
			"  4. Optional AGENTS.md and developer_instructions defaults are only installed when selected during plugin-mode setup",
		);
		console.log(
			"  5. Legacy native-agent TOML defaults remain uninstalled in plugin mode",
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
			"  5. Native agent defaults configured in config.toml [agents] and TOML files written to .codex/agents/",
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
	const result = spawnSync("gh", ["auth", "status"], {
		stdio: "ignore",
		windowsHide: true,
	});
	return result.status === 0;
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

	if (options.force && manifest && existsSync(dstDir)) {
		const installedFiles = await readdir(dstDir);
		for (const file of installedFiles) {
			if (!file.endsWith(".md")) continue;
			const promptName = file.slice(0, -3);
			const status = agentStatusByName?.get(promptName);
			if (isSetupPromptAssetName(promptName, manifest)) continue;

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
				console.log(`  ${prefix} ${file} (status: ${label})`);
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
	options: Pick<SetupOptions, "dryRun" | "verbose" | "force">,
): Promise<SetupCategorySummary> {
	const summary = createEmptyCategorySummary();

	if (!options.dryRun) {
		await mkdir(agentsDir, { recursive: true });
	}

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
		await syncManagedContent(
			toml,
			dst,
			summary,
			backupContext,
			options,
			`native agent ${name}.toml`,
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

	if (options.force && manifest && existsSync(agentsDir)) {
		const installedFiles = await readdir(agentsDir);
		for (const file of installedFiles) {
			if (!file.endsWith(".toml")) continue;
			const agentName = file.slice(0, -5);
			const agentStatus = agentStatusByName?.get(agentName);
			if (isNativeAgentInstallableStatus(agentStatus)) continue;
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
			}
			summary.removed += 1;
			if (options.verbose) {
				const prefix = options.dryRun
					? "would remove stale native agent"
					: "removed stale native agent";
				const label = agentStatus ?? "unlisted";
				console.log(`  ${prefix} ${file} (status: ${label})`);
			}
		}
	}

	return summary;
}

async function cleanupObsoleteNativeAgents(
	agentsDir: string,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose">,
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
			if (isSetupInstallableSkill(staleSkill, status)) continue;
			const hardDeprecated = HARD_DEPRECATED_SKILL_NAMES.has(staleSkill);
			if (!options.force && !hardDeprecated) continue;

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
				const reason = hardDeprecated ? ", hard-deprecated" : "";
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

async function updateManagedConfig(
	configPath: string,
	pkgRoot: string,
	sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
	summary: SetupCategorySummary,
	backupContext: SetupBackupContext,
	options: Pick<SetupOptions, "dryRun" | "verbose" | "modelUpgradePrompt"> & {
		statusLinePreset?: HudPreset;
		forceStatusLinePreset?: boolean;
	},
): Promise<ManagedConfigResult> {
	const existing = existsSync(configPath)
		? await readFile(configPath, "utf-8")
		: "";
	const hadLegacyTeamRunTable = hasLegacyOmxTeamRunTable(existing);
	const currentModel = getRootModelName(existing);
	let modelOverride: string | undefined;
	const omxManagesTui = true;

	if (currentModel === LEGACY_SETUP_MODEL) {
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

	const finalConfig = buildMergedConfig(existing, pkgRoot, {
		includeTui: omxManagesTui,
		modelOverride,
		sharedMcpServers: sharedMcpRegistry.servers,
		sharedMcpRegistrySource: sharedMcpRegistry.sourcePath,
		verbose: options.verbose,
		statusLinePreset: options.statusLinePreset,
		forceStatusLinePreset: options.forceStatusLinePreset,
	});
	const changed = existing !== finalConfig;

	if (!changed) {
		summary.unchanged += 1;
		return {
			finalConfig,
			omxManagesTui,
			repairedLegacyTeamRunTable: false,
		};
	}

	if (
		await ensureBackup(
			configPath,
			existsSync(configPath),
			backupContext,
			options,
		)
	) {
		summary.backedUp += 1;
	}

	if (!options.dryRun) {
		await writeFile(configPath, finalConfig);
	}

	if (
		options.verbose &&
		modelOverride &&
		currentModel &&
		currentModel !== modelOverride
	) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} root model from ${currentModel} to ${modelOverride}`,
		);
	}

	summary.updated += 1;
	if (options.verbose) {
		console.log(
			`  ${options.dryRun ? "would update" : "updated"} config ${configPath}`,
		);
	}
	return {
		finalConfig,
		omxManagesTui,
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
