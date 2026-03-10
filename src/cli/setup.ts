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
  userSkillsDir,
  omxStateDir,
  omxPlansDir,
  omxLogsDir,
  omxAgentsConfigDir,
} from "../utils/paths.js";
import { buildMergedConfig, getRootModelName } from "../config/generator.js";
import { generateAgentToml } from "../agents/native-config.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { getPackageRoot } from "../utils/package.js";
import { readSessionState, isSessionStale } from "../hooks/session.js";
import { getCatalogHeadlineCounts } from "./catalog-contract.js";
import { tryReadCatalogManifest } from "../catalog/reader.js";

interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  scope?: SetupScope;
  verbose?: boolean;
  agentsOverwritePrompt?: () => Promise<boolean>;
  modelUpgradePrompt?: (
    currentModel: string,
    targetModel: string,
  ) => Promise<boolean>;
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

function applyScopePathRewritesToAgentsTemplate(
  content: string,
  scope: SetupScope,
): string {
  if (scope !== "project") return content;
  return content
    .replaceAll("~/.codex", "./.codex")
    .replaceAll("~/.agents", "./.agents");
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
const DEFAULT_SETUP_MODEL = "gpt-5.4";

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
      nativeAgentsDir: join(projectRoot, ".omx", "agents"),
      promptsDir: join(codexHomeDir, "prompts"),
      skillsDir: join(projectRoot, ".agents", "skills"),
    };
  }
  return {
    codexConfigFile: codexConfigPath(),
    codexHomeDir: codexHome(),
    nativeAgentsDir: omxAgentsConfigDir(),
    promptsDir: codexPromptsDir(),
    skillsDir: userSkillsDir(),
  };
}

async function readPersistedSetupScope(
  projectRoot: string,
): Promise<SetupScope | undefined> {
  const scopePath = getScopeFilePath(projectRoot);
  if (!existsSync(scopePath)) return undefined;
  try {
    const raw = await readFile(scopePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PersistedSetupScope>;
    if (parsed && typeof parsed.scope === "string") {
      // Direct match to current scopes
      if (isSetupScope(parsed.scope)) return parsed.scope;
      // Migrate legacy scope values (project-local → project)
      const migrated = LEGACY_SCOPE_MIGRATION[parsed.scope];
      if (migrated) {
        console.warn(
          `[omx] Migrating persisted setup scope "${parsed.scope}" → "${migrated}" ` +
            `(see issue #243: simplified to user/project).`,
        );
        return migrated;
      }
    }
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
    console.log(`  1) user (default) — installs to ~/.codex, ~/.agents`);
    console.log(
      "  2) project — installs to ./.codex, ./.agents (local to project)",
    );
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

async function resolveSetupScope(
  projectRoot: string,
  requestedScope?: SetupScope,
): Promise<ResolvedSetupScope> {
  if (requestedScope) {
    return { scope: requestedScope, source: "cli" };
  }
  const persisted = await readPersistedSetupScope(projectRoot);
  if (persisted) {
    return { scope: persisted, source: "persisted" };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const scope = await promptForSetupScope(DEFAULT_SETUP_SCOPE);
    return { scope, source: "prompt" };
  }
  return { scope: DEFAULT_SETUP_SCOPE, source: "default" };
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

  const catalogCounts = getCatalogHeadlineCounts();
  const summary = createEmptyRunSummary();
  const backupContext = getBackupContext(resolvedScope.scope, projectRoot);

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

  // Step 3: Install native agent configs
  console.log("[3/8] Installing native agent configs...");
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

  // Step 4: Install skills
  console.log("[4/8] Installing skills...");
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

  // Step 5: Update config.toml
  console.log("[5/8] Updating config.toml...");
  await updateManagedConfig(
    scopeDirs.codexConfigFile,
    pkgRoot,
    scopeDirs.nativeAgentsDir,
    summary.config,
    backupContext,
    { dryRun, verbose, modelUpgradePrompt },
  );
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
  if (resolvedScope.scope !== "project") {
    summary.agentsMd.skipped += 1;
    console.log("  User scope leaves project AGENTS.md unchanged.");
  } else {
    const agentsMdSrc = join(pkgRoot, "templates", "AGENTS.md");
    const agentsMdDst = join(projectRoot, "AGENTS.md");
    const agentsMdExists = existsSync(agentsMdDst);

    // Guard: refuse to overwrite AGENTS.md during active session
    const activeSession = await readSessionState(projectRoot);
    const sessionIsActive = activeSession && !isSessionStale(activeSession);

    if (existsSync(agentsMdSrc)) {
      const content = await readFile(agentsMdSrc, "utf-8");
      const rewritten = applyScopePathRewritesToAgentsTemplate(
        content,
        resolvedScope.scope,
      );
      let changed = true;
      if (agentsMdExists) {
        const existing = await readFile(agentsMdDst, "utf-8");
        changed = existing !== rewritten;
      }

      if (sessionIsActive && agentsMdExists && changed) {
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
        await syncManagedContent(
          rewritten,
          agentsMdDst,
          summary.agentsMd,
          backupContext,
          { dryRun, verbose },
          "AGENTS.md",
        );
        if (summary.agentsMd.updated > 0) {
          console.log("  Generated AGENTS.md in project root.");
        } else if (summary.agentsMd.unchanged > 0) {
          console.log("  AGENTS.md already up to date.");
        }
      }
    } else {
      summary.agentsMd.skipped += 1;
      console.log("  AGENTS.md template not found, skipping.");
    }
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
  console.log("  StatusLine configured in config.toml via [tui] section.");
  console.log();

  console.log("Setup refresh summary:");
  logCategorySummary("prompts", summary.prompts);
  logCategorySummary("skills", summary.skills);
  logCategorySummary("native_agents", summary.nativeAgents);
  logCategorySummary("agents_md", summary.agentsMd);
  logCategorySummary("config", summary.config);
  console.log();

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
  console.log("  5. Native agent roles registered in config.toml [agents.*]");
  console.log('  6. "omx explore" prefers a packaged native harness; source installs still need Rust (cargo) unless OMX_EXPLORE_BIN is set');
  if (isGitHubCliConfigured()) {
    console.log("\nSupport the project: gh repo star Yeachan-Heo/oh-my-codex");
  }
}

function isLegacySkillPromptShim(content: string): boolean {
  const marker =
    /Read and follow the full skill instructions at\s+~\/\.agents\/skills\/[^/\s]+\/SKILL\.md/i;
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
    if (!file.endsWith('.md')) continue;
    const promptName = file.slice(0, -3);
    staleCandidatePromptNames.add(promptName);

    const status = agentStatusByName?.get(promptName);
    if (agentStatusByName && !isInstallableStatus(status)) {
      summary.skipped += 1;
      if (options.verbose) {
        const label = status ?? 'unlisted';
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
      if (!file.endsWith('.md')) continue;
      const promptName = file.slice(0, -3);
      const status = agentStatusByName?.get(promptName);
      if (isInstallableStatus(status)) continue;
      if (!staleCandidatePromptNames.has(promptName) && status === undefined) continue;

      const stalePromptPath = join(dstDir, file);
      if (!existsSync(stalePromptPath)) continue;

      if (!options.dryRun) {
        await rm(stalePromptPath, { force: true });
      }
      summary.removed += 1;
      if (options.verbose) {
        const prefix = options.dryRun ? 'would remove stale prompt' : 'removed stale prompt';
        const label = status ?? 'unlisted';
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
    const toml = generateAgentToml(agent, promptContent);
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

  if (options.force && manifest && existsSync(agentsDir)) {
    const installedFiles = await readdir(agentsDir);
    for (const file of installedFiles) {
      if (!file.endsWith('.toml')) continue;
      const agentName = file.slice(0, -5);
      const status = agentStatusByName?.get(agentName);
      if (isInstallableStatus(status)) continue;
      if (!staleCandidateNativeAgentNames.has(agentName) && status === undefined) continue;

      const staleAgentPath = join(agentsDir, file);
      if (!existsSync(staleAgentPath)) continue;

      if (!options.dryRun) {
        await rm(staleAgentPath, { force: true });
      }
      summary.removed += 1;
      if (options.verbose) {
        const prefix = options.dryRun ? 'would remove stale native agent' : 'removed stale native agent';
        const label = status ?? 'unlisted';
        console.log(`  ${prefix} ${file} (status: ${label})`);
      }
    }
  }

  return summary;
}

async function installSkills(
  srcDir: string,
  dstDir: string,
  backupContext: SetupBackupContext,
  options: SetupOptions,
): Promise<SetupCategorySummary> {
  const summary = createEmptyCategorySummary();
  if (!existsSync(srcDir)) return summary;
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
        `skill ${entry.name}/${sf}`,
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
  agentsConfigDir: string,
  summary: SetupCategorySummary,
  backupContext: SetupBackupContext,
  options: Pick<SetupOptions, "dryRun" | "verbose" | "modelUpgradePrompt">,
): Promise<void> {
  const existing = existsSync(configPath)
    ? await readFile(configPath, "utf-8")
    : "";
  const currentModel = getRootModelName(existing);
  let modelOverride: string | undefined;

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
    agentsConfigDir,
    modelOverride,
    verbose: options.verbose,
  });
  const changed = existing !== finalConfig;

  if (!changed) {
    summary.unchanged += 1;
    return;
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
}

async function setupNotifyHook(
  pkgRoot: string,
  options: Pick<SetupOptions, "dryRun" | "verbose">,
): Promise<void> {
  const hookScript = join(pkgRoot, "scripts", "notify-hook.js");
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
