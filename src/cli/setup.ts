/**
 * omx setup - Automated installation of oh-my-codex
 * Installs skills, prompts, MCP servers config, and AGENTS.md
 */

import {
  mkdir,
  copyFile,
  readdir,
  readFile,
  writeFile,
  stat,
  rm,
} from "fs/promises";
import { join, dirname, relative } from "path";
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
import { buildMergedConfig, getRootModelName } from "../config/generator.js";
import {
  getUnifiedMcpRegistryCandidates,
  loadUnifiedMcpRegistry,
  planClaudeCodeMcpSettingsSync,
  type UnifiedMcpRegistryLoadResult,
} from "../config/mcp-registry.js";
import { generateAgentToml } from "../agents/native-config.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { getPackageRoot } from "../utils/package.js";
import { readSessionState, isSessionStale } from "../hooks/session.js";
import { getCatalogHeadlineCounts } from "./catalog-contract.js";
import { tryReadCatalogManifest } from "../catalog/reader.js";
import { DEFAULT_FRONTIER_MODEL } from "../config/models.js";
import {
  addGeneratedAgentsMarker,
  isOmxGeneratedAgentsMd,
} from "../utils/agents-md.js";
import {
  resolveAgentsModelTableContext,
  upsertAgentsModelTable,
} from "../utils/agents-model-table.js";
import { spawnPlatformCommandSync } from "../utils/platform-command.js";

interface SetupOptions {
  codexVersionProbe?: () => string | null;
  force?: boolean;
  dryRun?: boolean;
  scope?: SetupScope;
  verbose?: boolean;
  agentsOverwritePrompt?: (destinationPath: string) => Promise<boolean>;
  modelUpgradePrompt?: (
    currentModel: string,
    targetModel: string,
  ) => Promise<boolean>;
  mcpRegistryCandidates?: string[];
}

/**
 * Legacy scope values that may appear in persisted setup-scope.json files.
 * Both 'project-local' (renamed) and old 'project' (minimal, removed) are
 * migrated to the current 'project' scope on read.
 */
const LEGACY_SCOPE_MIGRATION: Record<string, "project"> = {
  "project-local": "project",
};

export const SETUP_SCOPES = ["user", "project"] as const;
export type SetupScope = (typeof SETUP_SCOPES)[number];

export interface ScopeDirectories {
  codexConfigFile: string;
  codexHomeDir: string;
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
}

interface LegacySkillOverlapNotice {
  shouldWarn: boolean;
  message: string;
}

export interface SkillFrontmatterMetadata {
  name: string;
  description: string;
}

const PROJECT_OMX_GITIGNORE_ENTRY = ".omx/";

function applyScopePathRewritesToAgentsTemplate(
  content: string,
  scope: SetupScope,
): string {
  if (scope !== "project") return content;
  return content.replaceAll("~/.codex", "./.codex");
}

interface PersistedSetupScope {
  scope: SetupScope;
}

interface ResolvedSetupScope {
  scope: SetupScope;
  source: "cli" | "persisted" | "prompt" | "default";
}

const REQUIRED_TEAM_CLI_API_MARKERS = [
  "if (subcommand === 'api')",
  "executeTeamApiOperation",
  "TEAM_API_OPERATIONS",
] as const;

const DEFAULT_SETUP_SCOPE: SetupScope = "user";
const LEGACY_SETUP_MODEL = "gpt-5.3-codex";
const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;
const OBSOLETE_NATIVE_AGENT_FIELD = ["skill", "ref"].join("_");
const TUI_OWNED_BY_CODEX_VERSION = [0, 107, 0] as const;

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
      message:
        `Legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills) alongside canonical ${overlap.canonicalDir}. Codex may still discover both roots; archive or remove ~/.agents/skills if Enable/Disable Skills shows duplicates.`,
    };
  }

  const mismatchSuffix = overlap.mismatchedSkillNames.length > 0
    ? ` ${overlap.mismatchedSkillNames.length} overlapping skills have different SKILL.md content.`
    : "";
  return {
    shouldWarn: true,
    message:
      `Detected ${overlap.overlappingSkillNames.length} overlapping skill names between canonical ${overlap.canonicalDir} and legacy ${overlap.legacyDir}.${mismatchSuffix} Remove or archive ~/.agents/skills after confirming ${overlap.canonicalDir} is the version you want Codex to load.`,
  };
}

function logCategorySummary(name: string, summary: SetupCategorySummary): void {
  console.log(
    `  ${name}: updated=${summary.updated}, unchanged=${summary.unchanged}, ` +
      `backed_up=${summary.backedUp}, skipped=${summary.skipped}, removed=${summary.removed}`,
  );
}

function isSetupScope(value: string): value is SetupScope {
  return SETUP_SCOPES.includes(value as SetupScope);
}
function getScopeFilePath(projectRoot: string): string {
  return join(projectRoot, ".omx", "setup-scope.json");
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
      nativeAgentsDir: join(codexHomeDir, "agents"),
      promptsDir: join(codexHomeDir, "prompts"),
      skillsDir: join(codexHomeDir, "skills"),
    };
  }
  return {
    codexConfigFile: codexConfigPath(),
    codexHomeDir: codexHome(),
    nativeAgentsDir: codexAgentsDir(),
    promptsDir: codexPromptsDir(),
    skillsDir: userSkillsDir(),
  };
}

async function readPersistedSetupPreferences(
  projectRoot: string,
): Promise<Partial<PersistedSetupScope> | undefined> {
  const scopePath = getScopeFilePath(projectRoot);
  if (!existsSync(scopePath)) return undefined;
  try {
    const raw = await readFile(scopePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedSetupScope>;
    const persisted: Partial<PersistedSetupScope> = {};
    if (parsed && typeof parsed.scope === "string") {
      // Direct match to current scopes
      if (isSetupScope(parsed.scope)) {
        persisted.scope = parsed.scope;
      }
      // Migrate legacy scope values (project-local → project)
      const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
      if (migrated) {
        console.warn(
          `[omx] Migrating persisted setup scope "${parsed.scope}" → "${migrated}" ` +
            `(see issue #243: simplified to user/project).`,
        );
        persisted.scope = migrated;
      }
    }
    return Object.keys(persisted).length > 0 ? persisted : undefined;
  } catch {
    // ignore invalid persisted scope and fall back to prompt/default
  }
  return undefined;
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
    console.log("Select setup scope:");
    console.log(
      `  1) user (default) — installs to ~/.codex (skills default to ~/.codex/skills)`,
    );
    console.log("  2) project — installs to ./.codex (local to project)");
    const answer = (await rl.question("Scope [1-2] (default: 1): "))
      .trim()
      .toLowerCase();
    if (answer === "2" || answer === "project") return "project";
    return defaultScope;
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

function parseSemverTriplet(version: string): [number, number, number] | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function semverGte(
  version: [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  if (version[0] !== minimum[0]) return version[0] > minimum[0];
  if (version[1] !== minimum[1]) return version[1] > minimum[1];
  return version[2] >= minimum[2];
}

function probeInstalledCodexVersion(): string | null {
  const { result } = spawnPlatformCommandSync("codex", ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return null;
  const stdout = (result.stdout || "").trim();
  return stdout === "" ? null : stdout;
}

function shouldOmxManageTuiFromCodexVersion(versionOutput: string | null): boolean {
  if (!versionOutput) return true;
  const parsed = parseSemverTriplet(versionOutput);
  if (!parsed) return true;
  return !semverGte(parsed, TUI_OWNED_BY_CODEX_VERSION);
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

async function resolveSetupScope(
  projectRoot: string,
  requestedScope?: SetupScope,
): Promise<ResolvedSetupScope> {
  if (requestedScope) {
    return { scope: requestedScope, source: "cli" };
  }
  const persisted = await readPersistedSetupPreferences(projectRoot);
  if (persisted?.scope) {
    return { scope: persisted.scope, source: "persisted" };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const scope = await promptForSetupScope(DEFAULT_SETUP_SCOPE);
    return { scope, source: "prompt" };
  }
  return { scope: DEFAULT_SETUP_SCOPE, source: "default" };
}

function hasGitignoreEntry(content: string, entry: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === entry);
}

async function ensureProjectOmxGitignore(
  projectRoot: string,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<"created" | "updated" | "unchanged"> {
  const gitignorePath = join(projectRoot, ".gitignore");
  const destinationExists = existsSync(gitignorePath);
  const existing = destinationExists
    ? await readFile(gitignorePath, "utf-8")
    : "";

  if (hasGitignoreEntry(existing, PROJECT_OMX_GITIGNORE_ENTRY)) {
    return "unchanged";
  }

  const nextContent = destinationExists
    ? `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${PROJECT_OMX_GITIGNORE_ENTRY}\n`
    : `${PROJECT_OMX_GITIGNORE_ENTRY}\n`;

  if (
    await ensureBackup(gitignorePath, destinationExists, backupContext, options)
  ) {
    // backup created when refreshing a pre-existing .gitignore
  }

  if (!options.dryRun) {
    await writeFile(gitignorePath, nextContent);
  }

  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "would update" : destinationExists ? "updated" : "created"} .gitignore (${PROJECT_OMX_GITIGNORE_ENTRY})`,
    );
  }

  return destinationExists ? "updated" : "created";
}

async function persistSetupScope(
  projectRoot: string,
  scope: SetupScope,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  const scopePath = getScopeFilePath(projectRoot);
  if (options.dryRun) {
    if (options.verbose) console.log(`  dry-run: skip persisting ${scopePath}`);
    return;
  }
  await mkdir(dirname(scopePath), { recursive: true });
  const payload: PersistedSetupScope = { scope };
  await writeFile(scopePath, JSON.stringify(payload, null, 2) + "\n");
  if (options.verbose) console.log(`  Wrote ${scopePath}`);
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  const {
    force = false,
    dryRun = false,
    scope: requestedScope,
    verbose = false,
    modelUpgradePrompt,
  } = options;
  const pkgRoot = getPackageRoot();
  const projectRoot = process.cwd();
  const resolvedScope = await resolveSetupScope(projectRoot, requestedScope);
  const scopeDirs = resolveScopeDirectories(resolvedScope.scope, projectRoot);
  const scopeSourceMessage =
    resolvedScope.source === "persisted" ? " (from .omx/setup-scope.json)" : "";
  const backupContext = getBackupContext(resolvedScope.scope, projectRoot);

  console.log("oh-my-codex setup");
  console.log("=================\n");
  console.log(
    `Using setup scope: ${resolvedScope.scope}${scopeSourceMessage}\n`,
  );

  // Step 1: Ensure directories exist
  console.log("[1/8] Creating directories...");
  const dirs = [
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
  await persistSetupScope(projectRoot, resolvedScope.scope, {
    dryRun,
    verbose,
  });
  console.log("  Done.\n");

  if (resolvedScope.scope === "project") {
    const gitignoreResult = await ensureProjectOmxGitignore(
      projectRoot,
      backupContext,
      { dryRun, verbose },
    );
    if (gitignoreResult === "created") {
      console.log(
        "  Created .gitignore with .omx/ so local OMX runtime state stays out of source control.\n",
      );
    } else if (gitignoreResult === "updated") {
      console.log(
        "  Added .omx/ to .gitignore so local OMX runtime state stays out of source control.\n",
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

  // Step 3: Install skills
  console.log("[3/8] Installing skills...");
  {
    const skillsSrc = join(pkgRoot, "skills");
    const skillsDst = scopeDirs.skillsDir;
    summary.skills = await installSkills(skillsSrc, skillsDst, backupContext, {
      force,
      dryRun,
      verbose,
    });
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
  {
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
  const registryCandidates = getUnifiedMcpRegistryCandidates();
  const defaultRegistryCandidates = registryCandidates.slice(0, 1);
  const sharedMcpRegistry = await loadUnifiedMcpRegistry({
    candidates: options.mcpRegistryCandidates ?? defaultRegistryCandidates,
  });
  if (
    !options.mcpRegistryCandidates &&
    !sharedMcpRegistry.sourcePath &&
    registryCandidates.length > 1 &&
    existsSync(registryCandidates[1]) &&
    !existsSync(registryCandidates[0])
  ) {
    console.log(
      `  warning: legacy shared MCP registry detected at ${registryCandidates[1]} but ignored by default; move it to ${registryCandidates[0]} if you still want setup to sync those servers`,
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
  const managedConfig = await updateManagedConfig(
    scopeDirs.codexConfigFile,
    pkgRoot,
    sharedMcpRegistry,
    summary.config,
    backupContext,
    { codexVersionProbe: options.codexVersionProbe, dryRun, verbose, modelUpgradePrompt },
  );
  const resolvedConfig = managedConfig.finalConfig;
  if (resolvedScope.scope === "user") {
    await syncClaudeCodeMcpSettings(
      sharedMcpRegistry,
      summary.config,
      backupContext,
      { dryRun, verbose },
    );
  }
  console.log(`  Config refresh complete (${scopeDirs.codexConfigFile}).\n`);

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
    if (agentsMdExists) {
      const existing = await readFile(agentsMdDst, "utf-8");
      changed = existing !== rewritten;
      if (isOmxGeneratedAgentsMd(existing)) {
        managedRefreshContent = upsertAgentsModelTable(
          existing,
          modelTableContext,
        );
        canApplyManagedModelRefresh = managedRefreshContent !== existing;
      }
    }

    if (
      resolvedScope.scope === "project" &&
      sessionIsActive &&
      agentsMdExists &&
      changed
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

  // Step 7: Set up notify hook
  console.log("[7/8] Configuring notification hook...");
  await setupNotifyHook(pkgRoot, { dryRun, verbose });
  console.log("  Done.\n");

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
  if (managedConfig.omxManagesTui) {
    console.log("  StatusLine configured in config.toml via [tui] section.");
  } else {
    console.log("  Codex CLI >= 0.107.0 manages [tui]; OMX left that section untouched.");
  }
  console.log();

  console.log("Setup refresh summary:");
  logCategorySummary("prompts", summary.prompts);
  logCategorySummary("skills", summary.skills);
  logCategorySummary("native_agents", summary.nativeAgents);
  logCategorySummary("agents_md", summary.agentsMd);
  logCategorySummary("config", summary.config);
  console.log();

  const legacySkillOverlapNotice = await buildLegacySkillOverlapNotice(resolvedScope.scope);
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
  console.log(
    "  2. Use /prompts:architect, /prompts:executor, /prompts:planner as slash commands",
  );
  console.log("  3. Skills are available via /skills or implicit matching");
  console.log("  4. The AGENTS.md orchestration brain is loaded automatically");
  console.log(
    "  5. Native agent defaults configured in config.toml [agents] and TOML files written to .codex/agents/",
  );
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
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
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
    ? new Map(manifest.agents.map((agent) => [agent.name, agent.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";

  const files = await readdir(srcDir);
  const staleCandidatePromptNames = new Set(
    manifest?.agents.map((agent) => agent.name) ?? [],
  );

  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const promptName = file.slice(0, -3);
    staleCandidatePromptNames.add(promptName);

    const status = agentStatusByName?.get(promptName);
    if (agentStatusByName && !isInstallableStatus(status)) {
      summary.skipped += 1;
      if (options.verbose) {
        const label = status ?? "unlisted";
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
      if (isInstallableStatus(status)) continue;
      if (!staleCandidatePromptNames.has(promptName) && status === undefined)
        continue;

      const stalePromptPath = join(dstDir, file);
      if (!existsSync(stalePromptPath)) continue;

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
    ? new Map(manifest.agents.map((agent) => [agent.name, agent.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";
  const staleCandidateNativeAgentNames = new Set(
    manifest?.agents.map((agent) => agent.name) ?? [],
  );

  for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
    staleCandidateNativeAgentNames.add(name);
    const status = agentStatusByName?.get(name);
    if (agentStatusByName && !isInstallableStatus(status)) {
      if (options.verbose) {
        const label = status ?? "unlisted";
        console.log(`  skipped native agent ${name}.toml (status: ${label})`);
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

  if (options.force && manifest && existsSync(agentsDir)) {
    const installedFiles = await readdir(agentsDir);
    for (const file of installedFiles) {
      if (!file.endsWith(".toml")) continue;
      const agentName = file.slice(0, -5);
      const agentStatus = agentStatusByName?.get(agentName);
      if (isInstallableStatus(agentStatus)) continue;
      if (
        !staleCandidateNativeAgentNames.has(agentName) &&
        agentStatus === undefined
      )
        continue;

      const staleAgentPath = join(agentsDir, file);
      if (!existsSync(staleAgentPath)) continue;

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
  const installableSkills: Array<{
    name: string;
    sourceDir: string;
    destinationDir: string;
  }> = [];
  const manifest = tryReadCatalogManifest();
  const skillStatusByName = manifest
    ? new Map(manifest.skills.map((skill) => [skill.name, skill.status]))
    : null;
  const isInstallableStatus = (status: string | undefined): boolean =>
    status === "active" || status === "internal";
  const entries = await readdir(srcDir, { withFileTypes: true });
  const staleCandidateSkillNames = new Set(
    manifest?.skills.map((skill) => skill.name) ?? [],
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    staleCandidateSkillNames.add(entry.name);
    const status = skillStatusByName?.get(entry.name);
    if (skillStatusByName && !isInstallableStatus(status)) {
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

  if (options.force && manifest && existsSync(dstDir)) {
    for (const staleSkill of staleCandidateSkillNames) {
      const status = skillStatusByName?.get(staleSkill);
      if (isInstallableStatus(status)) continue;

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
        console.log(`  ${prefix} ${staleSkill}/ (status: ${label})`);
      }
    }
  }

  return summary;
}

async function updateManagedConfig(
  configPath: string,
  pkgRoot: string,
  sharedMcpRegistry: UnifiedMcpRegistryLoadResult,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<
    SetupOptions,
    "codexVersionProbe" | "dryRun" | "verbose" | "modelUpgradePrompt"
  >,
): Promise<ManagedConfigResult> {
  const existing = existsSync(configPath)
    ? await readFile(configPath, "utf-8")
    : "";
  const currentModel = getRootModelName(existing);
  let modelOverride: string | undefined;
  const codexVersion =
    options.codexVersionProbe?.() ?? probeInstalledCodexVersion();
  const omxManagesTui = shouldOmxManageTuiFromCodexVersion(codexVersion);

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
  });
  const changed = existing !== finalConfig;

  if (!changed) {
    summary.unchanged += 1;
    return { finalConfig, omxManagesTui };
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
  return { finalConfig, omxManagesTui };
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
