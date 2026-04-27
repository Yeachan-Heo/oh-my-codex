/**
 * omx uninstall - Remove oh-my-codex configuration and installed artifacts
 */

import { readFile, writeFile, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import {
  stripExistingOmxBlocks,
  stripOmxEnvSettings,
  stripOmxTopLevelKeys,
  stripOmxFeatureFlags,
  stripOmxSeededBehavioralDefaults,
} from "../config/generator.js";
import {
  parseCodexHooksConfig,
  removeManagedCodexHooks,
} from "../config/codex-hooks.js";
import { getPackageRoot } from "../utils/package.js";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { detectLegacySkillRootOverlap } from "../utils/paths.js";
import { resolveScopeDirectories, type SetupScope } from "./setup.js";
import { readPersistedSetupScope } from "./index.js";
import { isOmxGeneratedAgentsMd } from "../utils/agents-md.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../config/omx-first-party-mcp.js";

export interface UninstallOptions {
  dryRun?: boolean;
  keepConfig?: boolean;
  verbose?: boolean;
  purge?: boolean;
  scope?: SetupScope;
}

interface UninstallSummary {
  configCleaned: boolean;
  mcpServersRemoved: string[];
  agentEntriesRemoved: number;
  tuiSectionRemoved: boolean;
  topLevelKeysRemoved: boolean;
  featureFlagsRemoved: boolean;
  hooksFileRemoved: boolean;
  promptsRemoved: number;
  skillsRemoved: number;
  agentConfigsRemoved: number;
  agentsMdRemoved: boolean;
  cacheDirectoryRemoved: boolean;
  legacySkillRootWarning: string | null;
}

function detectOmxConfigArtifacts(config: string): {
  hasMcpServers: string[];
  hasAgentEntries: number;
  hasTuiSection: boolean;
  hasTopLevelKeys: boolean;
  hasFeatureFlags: boolean;
  hasExploreRoutingEnv: boolean;
} {
  const hasMcpServers = OMX_FIRST_PARTY_MCP_SERVER_NAMES.filter((name) =>
    new RegExp(`\\[mcp_servers\\.${name}\\]`).test(config),
  );

  const agentNames = Object.keys(AGENT_DEFINITIONS);
  let hasAgentEntries = 0;
  for (const name of agentNames) {
    const tableKey = name.includes("-") ? `agents."${name}"` : `agents.${name}`;
    if (config.includes(`[${tableKey}]`)) {
      hasAgentEntries++;
    }
  }

  const hasTuiSection =
    /^\[tui\]/m.test(config) &&
    config.includes("oh-my-codex (OMX) Configuration");

  const hasTopLevelKeys =
    /^\s*notify\s*=.*node/m.test(config) ||
    /^\s*model_reasoning_effort\s*=/m.test(config) ||
    /^\s*developer_instructions\s*=.*oh-my-codex/m.test(config);

  const hasFeatureFlags =
    /^\s*multi_agent\s*=\s*true/m.test(config) ||
    /^\s*child_agents_md\s*=\s*true/m.test(config) ||
    /^\s*codex_hooks\s*=\s*true/m.test(config);
  const hasExploreRoutingEnv = /^\s*USE_OMX_EXPLORE_CMD\s*=/m.test(config);

  return {
    hasMcpServers,
    hasAgentEntries,
    hasTuiSection,
    hasTopLevelKeys,
    hasFeatureFlags,
    hasExploreRoutingEnv,
  };
}

async function cleanConfig(
  configPath: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<
  Pick<
    UninstallSummary,
    | "configCleaned"
    | "mcpServersRemoved"
    | "agentEntriesRemoved"
    | "tuiSectionRemoved"
    | "topLevelKeysRemoved"
    | "featureFlagsRemoved"
  >
> {
  const result = {
    configCleaned: false,
    mcpServersRemoved: [] as string[],
    agentEntriesRemoved: 0,
    tuiSectionRemoved: false,
    topLevelKeysRemoved: false,
    featureFlagsRemoved: false,
  };

  if (!existsSync(configPath)) {
    if (options.verbose) console.log("  config.toml not found, skipping.");
    return result;
  }

  const original = await readFile(configPath, "utf-8");
  const detected = detectOmxConfigArtifacts(original);

  result.mcpServersRemoved = detected.hasMcpServers;
  result.agentEntriesRemoved = detected.hasAgentEntries;
  result.tuiSectionRemoved = detected.hasTuiSection;
  result.topLevelKeysRemoved = detected.hasTopLevelKeys;
  result.featureFlagsRemoved = detected.hasFeatureFlags;

  // Strip OMX tables block (MCP servers, agents, tui)
  let config = original;
  const { cleaned } = stripExistingOmxBlocks(config);
  config = cleaned;

  // Strip top-level keys
  config = stripOmxTopLevelKeys(config);

  // Strip OMX-seeded behavioral defaults only when the seeded pair is unchanged.
  config = stripOmxSeededBehavioralDefaults(config);

  // Strip feature flags
  config = stripOmxFeatureFlags(config);

  // Strip OMX-managed env defaults
  config = stripOmxEnvSettings(config);

  // Normalize trailing whitespace
  config = config.trimEnd() + "\n";

  if (config !== original) {
    result.configCleaned = true;
    if (!options.dryRun) {
      await writeFile(configPath, config);
    }
    if (options.verbose) {
      console.log(
        `  ${options.dryRun ? "Would clean" : "Cleaned"} ${configPath}`,
      );
    }
  } else {
    if (options.verbose) console.log("  No OMX config entries found.");
  }

  return result;
}

async function removeInstalledPrompts(
  promptsDir: string,
  pkgRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  const srcPromptsDir = join(pkgRoot, "prompts");
  if (!existsSync(srcPromptsDir) || !existsSync(promptsDir)) return 0;

  let removed = 0;
  const sourceFiles = await readdir(srcPromptsDir);

  for (const file of sourceFiles) {
    if (!file.endsWith(".md")) continue;
    const installed = join(promptsDir, file);
    if (!existsSync(installed)) continue;

    if (!options.dryRun) {
      await rm(installed, { force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} prompt: ${file}`,
      );
    removed++;
  }

  return removed;
}

async function removeInstalledSkills(
  skillsDir: string,
  pkgRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  const srcSkillsDir = join(pkgRoot, "skills");
  if (!existsSync(srcSkillsDir) || !existsSync(skillsDir)) return 0;

  let removed = 0;
  const sourceEntries = await readdir(srcSkillsDir, { withFileTypes: true });

  for (const entry of sourceEntries) {
    if (!entry.isDirectory()) continue;
    const installed = join(skillsDir, entry.name);
    if (!existsSync(installed)) continue;

    if (!options.dryRun) {
      await rm(installed, { recursive: true, force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} skill: ${entry.name}/`,
      );
    removed++;
  }

  return removed;
}

async function removeAgentConfigs(
  agentsDir: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<number> {
  if (!existsSync(agentsDir)) return 0;

  let removed = 0;
  const agentNames = Object.keys(AGENT_DEFINITIONS);

  for (const name of agentNames) {
    const configFile = join(agentsDir, `${name}.toml`);
    if (!existsSync(configFile)) continue;

    if (!options.dryRun) {
      await rm(configFile, { force: true });
    }
    if (options.verbose)
      console.log(
        `  ${options.dryRun ? "Would remove" : "Removed"} agent config: ${name}.toml`,
      );
    removed++;
  }

  // If the agents dir is now empty, remove it too
  if (!options.dryRun && existsSync(agentsDir)) {
    try {
      const remaining = await readdir(agentsDir);
      if (remaining.length === 0) {
        await rm(agentsDir, { recursive: true, force: true });
        if (options.verbose) console.log("  Removed empty agents directory.");
      }
    } catch {
      // Ignore errors when cleaning up empty dir
    }
  }

  return removed;
}

async function removeAgentsMd(
  agentsMdPath: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  if (!existsSync(agentsMdPath)) return false;

  try {
    const content = await readFile(agentsMdPath, "utf-8");
    if (!isOmxGeneratedAgentsMd(content)) {
      if (options.verbose)
        console.log("  AGENTS.md is not OMX-generated, skipping.");
      return false;
    }
  } catch {
    return false;
  }

  if (!options.dryRun) {
    await rm(agentsMdPath, { force: true });
  }
  if (options.verbose)
    console.log(`  ${options.dryRun ? "Would remove" : "Removed"} AGENTS.md`);
  return true;
}

async function removeHooksFile(
  hooksFilePath: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  if (!existsSync(hooksFilePath)) return false;

  const existing = await readFile(hooksFilePath, "utf-8");
  const { nextContent, removedCount } = removeManagedCodexHooks(existing);
  const parsed = parseCodexHooksConfig(existing);
  const emptyManagedArtifact =
    parsed !== null &&
    Object.keys(parsed.hooks).length === 0 &&
    Object.keys(parsed.root).every((key) => key === "hooks");

  if (removedCount === 0 && !emptyManagedArtifact) return false;

  if (!options.dryRun) {
    if (nextContent === null || emptyManagedArtifact) {
      await rm(hooksFilePath, { force: true });
    } else {
      await writeFile(hooksFilePath, nextContent);
    }
  }
  if (options.verbose) {
    console.log(
      `  ${options.dryRun ? "Would clean" : nextContent === null || emptyManagedArtifact ? "Removed" : "Cleaned"} ${basename(hooksFilePath)}`,
    );
  }
  return true;
}

async function removeCacheDirectory(
  projectRoot: string,
  options: Pick<UninstallOptions, "dryRun" | "verbose">,
): Promise<boolean> {
  const omxDir = join(projectRoot, ".omx");
  if (!existsSync(omxDir)) return false;

  if (!options.dryRun) {
    await rm(omxDir, { recursive: true, force: true });
  }
  if (options.verbose)
    console.log(`  ${options.dryRun ? "Would remove" : "Removed"} ${omxDir}`);
  return true;
}

async function detectLegacySkillRootWarning(
  scope: SetupScope,
): Promise<string | null> {
  if (scope !== "user") return null;

  const overlap = await detectLegacySkillRootOverlap();
  if (!overlap.legacyExists || overlap.sameResolvedTarget) {
    return null;
  }

  if (overlap.overlappingSkillNames.length === 0) {
    return (
      `legacy ~/.agents/skills still exists (${overlap.legacySkillCount} skills). ` +
      "omx uninstall does not remove that historical root automatically; " +
      "archive or remove ~/.agents/skills if Codex still shows stale or duplicate skills"
    );
  }

  const mismatchMessage =
    overlap.mismatchedSkillNames.length > 0
      ? `; ${overlap.mismatchedSkillNames.length} differ in SKILL.md content`
      : "";
  return (
    `${overlap.overlappingSkillNames.length} overlapping skill names remain between ` +
    `${overlap.canonicalDir} and ${overlap.legacyDir}${mismatchMessage}. ` +
    "omx uninstall only removes the active canonical skill root; " +
    "archive or remove ~/.agents/skills if Codex still shows duplicates"
  );
}

function printSummary(summary: UninstallSummary, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] Would remove" : "Removed";

  console.log("\nUninstall summary:");

  if (summary.configCleaned) {
    console.log(`  ${prefix} OMX configuration block from config.toml`);
    if (summary.mcpServersRemoved.length > 0) {
      console.log(`    MCP servers: ${summary.mcpServersRemoved.join(", ")}`);
    }
    if (summary.agentEntriesRemoved > 0) {
      console.log(`    Agent entries: ${summary.agentEntriesRemoved}`);
    }
    if (summary.tuiSectionRemoved) {
      console.log("    TUI status line section");
    }
    if (summary.topLevelKeysRemoved) {
      console.log(
        "    Top-level keys (notify, model_reasoning_effort, developer_instructions)",
      );
    }
    if (summary.featureFlagsRemoved) {
      console.log("    Feature flags (multi_agent, child_agents_md, codex_hooks)");
    }
  } else if (!summary.configCleaned && summary.mcpServersRemoved.length === 0) {
    console.log("  config.toml: no OMX entries found (or --keep-config used)");
  }

  if (summary.hooksFileRemoved) {
    console.log(`  ${prefix} OMX-managed entries in .codex/hooks.json`);
  }

  if (summary.promptsRemoved > 0) {
    console.log(`  ${prefix} ${summary.promptsRemoved} agent prompt(s)`);
  }
  if (summary.skillsRemoved > 0) {
    console.log(`  ${prefix} ${summary.skillsRemoved} skill(s)`);
  }
  if (summary.agentConfigsRemoved > 0) {
    console.log(
      `  ${prefix} ${summary.agentConfigsRemoved} native agent config(s)`,
    );
  }
  if (summary.agentsMdRemoved) {
    console.log(`  ${prefix} AGENTS.md`);
  }
  if (summary.cacheDirectoryRemoved) {
    console.log(`  ${prefix} .omx/ cache directory`);
  }
  if (summary.legacySkillRootWarning) {
    console.log(`  Warning: ${summary.legacySkillRootWarning}`);
  }

  const totalActions =
    (summary.configCleaned ? 1 : 0) +
    (summary.hooksFileRemoved ? 1 : 0) +
    summary.promptsRemoved +
    summary.skillsRemoved +
    summary.agentConfigsRemoved +
    (summary.agentsMdRemoved ? 1 : 0) +
    (summary.cacheDirectoryRemoved ? 1 : 0);

  if (totalActions === 0) {
    console.log(
      "  Nothing to remove. oh-my-codex does not appear to be installed.",
    );
  }
}

export async function uninstall(options: UninstallOptions = {}): Promise<void> {
  const {
    dryRun = false,
    keepConfig = false,
    verbose = false,
    purge = false,
  } = options;

  const projectRoot = process.cwd();
  const pkgRoot = getPackageRoot();

  // Resolve scope (explicit --scope overrides persisted scope)
  const scope = options.scope ?? readPersistedSetupScope(projectRoot) ?? "user";
  const scopeDirs = resolveScopeDirectories(scope, projectRoot);

  console.log("oh-my-codex uninstall");
  console.log("=====================\n");
  if (dryRun) {
    console.log("[dry-run mode] No files will be modified.\n");
  }
  console.log(`Resolved scope: ${scope}\n`);

  const summary: UninstallSummary = {
    configCleaned: false,
    mcpServersRemoved: [],
    agentEntriesRemoved: 0,
    tuiSectionRemoved: false,
    topLevelKeysRemoved: false,
    featureFlagsRemoved: false,
    hooksFileRemoved: false,
    promptsRemoved: 0,
    skillsRemoved: 0,
    agentConfigsRemoved: 0,
    agentsMdRemoved: false,
    cacheDirectoryRemoved: false,
    legacySkillRootWarning: null,
  };

  summary.legacySkillRootWarning = await detectLegacySkillRootWarning(scope);

  // Step 1: Clean config.toml
  if (keepConfig) {
    console.log("[1/5] Skipping config.toml cleanup (--keep-config).");
  } else {
    console.log("[1/5] Cleaning config.toml...");
    const configResult = await cleanConfig(scopeDirs.codexConfigFile, {
      dryRun,
      verbose,
    });
    Object.assign(summary, configResult);
  }
  console.log();

  // Step 2: Remove installed prompts
  console.log("[2/6] Removing native hooks artifact...");
  summary.hooksFileRemoved = await removeHooksFile(scopeDirs.codexHooksFile, {
    dryRun,
    verbose,
  });
  console.log(
    `  ${dryRun ? "Would clean" : "Cleaned"} ${summary.hooksFileRemoved ? 1 : 0} hooks artifact(s).`,
  );
  console.log();

  // Step 3: Remove installed prompts
  console.log("[3/6] Removing agent prompts...");
  summary.promptsRemoved = await removeInstalledPrompts(
    scopeDirs.promptsDir,
    pkgRoot,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.promptsRemoved} prompt(s).`,
  );
  console.log();

  // Step 4: Remove native agent configs
  console.log("[4/6] Removing native agent configs...");
  summary.agentConfigsRemoved = await removeAgentConfigs(
    scopeDirs.nativeAgentsDir,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.agentConfigsRemoved} agent config(s).`,
  );
  console.log();

  // Step 5: Remove installed skills
  console.log("[5/6] Removing skills...");
  summary.skillsRemoved = await removeInstalledSkills(
    scopeDirs.skillsDir,
    pkgRoot,
    { dryRun, verbose },
  );
  console.log(
    `  ${dryRun ? "Would remove" : "Removed"} ${summary.skillsRemoved} skill(s).`,
  );
  console.log();

  // Step 6: Remove AGENTS.md and optionally .omx/ cache directory
  console.log("[6/6] Cleaning up...");
  const agentsMdPath =
    scope === "project"
      ? join(projectRoot, "AGENTS.md")
      : join(scopeDirs.codexHomeDir, "AGENTS.md");
  summary.agentsMdRemoved = await removeAgentsMd(agentsMdPath, {
    dryRun,
    verbose,
  });
  if (purge) {
    summary.cacheDirectoryRemoved = await removeCacheDirectory(projectRoot, {
      dryRun,
      verbose,
    });
  } else {
    // Always clean up setup-scope.json and hud-config.json
    const scopeFile = join(projectRoot, ".omx", "setup-scope.json");
    const hudConfig = join(projectRoot, ".omx", "hud-config.json");
    for (const f of [scopeFile, hudConfig]) {
      if (existsSync(f)) {
        if (!dryRun) await rm(f, { force: true });
        if (verbose)
          console.log(
            `  ${dryRun ? "Would remove" : "Removed"} ${basename(f)}`,
          );
      }
    }
  }
  console.log();

  printSummary(summary, dryRun);

  if (!dryRun) {
    console.log(
      '\noh-my-codex has been uninstalled. Run "omx setup" to reinstall.',
    );
  } else {
    console.log("\nRun without --dry-run to apply changes.");
  }
}
