/**
 * Config.toml generator/merger for oh-my-codex
 * Merges OMX MCP server entries and feature flags into existing config.toml
 *
 * TOML structure reminder: bare key=value pairs after a [table] header belong
 * to that table.  Top-level (root-table) keys MUST appear before the first
 * [table] header.  This generator therefore splits its output into:
 *   1. Top-level keys  (notify, model_reasoning_effort, developer_instructions)
 *   2. [features] flags
 *   3. [table] sections (env, mcp_servers, tui)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import TOML from "@iarna/toml";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { DEFAULT_FRONTIER_MODEL } from "./models.js";
import type { UnifiedMcpRegistryServer } from "./mcp-registry.js";
import { getOmxFirstPartySetupMcpServers } from "./omx-first-party-mcp.js";

interface MergeOptions {
  includeTui?: boolean;
  modelOverride?: string;
  sharedMcpServers?: UnifiedMcpRegistryServer[];
  sharedMcpRegistrySource?: string;
  verbose?: boolean;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Top-level OMX keys (must live before any [table] header)
// ---------------------------------------------------------------------------

/** Keys we own at the TOML root level. Used for upsert + strip. */
const OMX_TOP_LEVEL_KEYS = [
  "notify",
  "model_reasoning_effort",
  "developer_instructions",
] as const;

const DEFAULT_SETUP_MODEL = DEFAULT_FRONTIER_MODEL;
const DEFAULT_SETUP_MODEL_CONTEXT_WINDOW = 250000;
const DEFAULT_SETUP_MODEL_AUTO_COMPACT_TOKEN_LIMIT = 200000;
const OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER =
  "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
const OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER =
  "# End oh-my-codex seeded behavioral defaults";

export const OMX_DEVELOPER_INSTRUCTIONS =
  "You have oh-my-codex installed. AGENTS.md is your orchestration brain and the main orchestration surface. Use skill/keyword routing like $name plus spawned role-specialized subagents for specialized work. Codex native subagents are available via .codex/agents and may be used for independent parallel subtasks within a single session or team pane. Skills are loaded from installed SKILL.md files under .codex/skills, not from native agent TOMLs. Use workflow skills via $name when explicitly invoked or clearly routed by AGENTS.md. Treat installed prompts as narrower internal execution surfaces under AGENTS.md authority, even when user-facing docs prefer $name keywords.";
const SHARED_MCP_REGISTRY_MARKER = "oh-my-codex (OMX) Shared MCP Registry Sync";
const SHARED_MCP_REGISTRY_END_MARKER =
  "# End oh-my-codex shared MCP registry sync";
const OMX_AGENTS_MAX_THREADS = 6;
const OMX_AGENTS_MAX_DEPTH = 2;
const OMX_EXPLORE_ROUTING_DEFAULT = "1";
const OMX_EXPLORE_CMD_ENV = "USE_OMX_EXPLORE_CMD";
const DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC = 15;
const OMX_TUI_STATUS_LINE =
  'status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]';
const LEGACY_OMX_TEAM_RUN_TABLE_PATTERN =
  /^\s*\[mcp_servers\.(?:"omx_team_run"|omx_team_run)\]\s*$/m;

export function hasLegacyOmxTeamRunTable(config: string): boolean {
  return LEGACY_OMX_TEAM_RUN_TABLE_PATTERN.test(config);
}

function unwrapTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"(.*)"$/)?.[1];
}

export function getRootModelName(config: string): string | undefined {
  return unwrapTomlString(parseRootKeyValues(config).get("model"));
}

const ROOT_TABLE_HEADER_PATTERN = /^\s*\[\[?[^\]]+\]?\]\s*$/;
const ROOT_KEY_ASSIGNMENT_PATTERN = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/;

type RootLevelEntry = {
  key?: string;
  lines: string[];
};

function parseStandaloneToml(snippet: string): boolean {
  try {
    TOML.parse(snippet);
    return true;
  } catch {
    return false;
  }
}

function splitRootLevelEntries(config: string): {
  entries: RootLevelEntry[];
  remainder: string[];
} {
  const lines = config.split(/\r?\n/);
  const entries: RootLevelEntry[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (ROOT_TABLE_HEADER_PATTERN.test(line)) break;

    const match = line.match(ROOT_KEY_ASSIGNMENT_PATTERN);
    if (!match) {
      entries.push({ lines: [line] });
      index += 1;
      continue;
    }

    const entryLines = [line];
    while (
      !parseStandaloneToml(entryLines.join("\n")) &&
      index + entryLines.length < lines.length
    ) {
      entryLines.push(lines[index + entryLines.length]);
    }

    entries.push({ key: match[1], lines: entryLines });
    index += entryLines.length;
  }

  return { entries, remainder: lines.slice(index) };
}

function parseRootKeyValues(config: string): Map<string, string> {
  const values = new Map<string, string>();
  const { entries } = splitRootLevelEntries(config);

  for (const entry of entries) {
    if (!entry.key) continue;
    const [firstLine, ...rest] = entry.lines;
    const match = firstLine.match(ROOT_KEY_ASSIGNMENT_PATTERN);
    if (!match) continue;
    const value = [match[2], ...rest].join("\n").trim();
    values.set(entry.key, value);
  }

  return values;
}

function getOmxTopLevelLines(
  pkgRoot: string,
  existingConfig = "",
  modelOverride?: string,
): string[] {
  const notifyHookPath = join(pkgRoot, "dist", "scripts", "notify-hook.js");
  const escapedPath = escapeTomlString(notifyHookPath);
  const rootValues = parseRootKeyValues(existingConfig);

  const lines = [
    "# oh-my-codex top-level settings (must be before any [table])",
    `notify = ["node", "${escapedPath}"]`,
    'model_reasoning_effort = "medium"',
    `developer_instructions = "${escapeTomlString(OMX_DEVELOPER_INSTRUCTIONS)}"`,
  ];

  const existingModel = rootValues.get("model");
  const existingContextWindow = rootValues.get("model_context_window");
  const existingAutoCompact = rootValues.get("model_auto_compact_token_limit");
  const selectedModel =
    modelOverride ?? unwrapTomlString(existingModel) ?? DEFAULT_SETUP_MODEL;

  if (modelOverride || !existingModel) {
    lines.push(`model = "${selectedModel}"`);
  }

  if (selectedModel === DEFAULT_SETUP_MODEL) {
    const seededBehavioralDefaults: string[] = [];
    if (!existingContextWindow) {
      seededBehavioralDefaults.push(
        `model_context_window = ${DEFAULT_SETUP_MODEL_CONTEXT_WINDOW}`,
      );
    }
    if (!existingAutoCompact) {
      seededBehavioralDefaults.push(
        `model_auto_compact_token_limit = ${DEFAULT_SETUP_MODEL_AUTO_COMPACT_TOKEN_LIMIT}`,
      );
    }
    if (seededBehavioralDefaults.length > 0) {
      lines.push(OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER);
      lines.push(...seededBehavioralDefaults);
      lines.push(OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER);
    }
  }

  return lines;
}

function isUnchangedOmxSeededBehavioralDefaultsBlock(lines: string[]): boolean {
  const relevant = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#");
  });
  if (relevant.length !== 2) return false;

  const parsed = parseRootKeyValues(relevant.join("\n"));
  return (
    parsed.size === 2 &&
    parsed.get("model_context_window") ===
      String(DEFAULT_SETUP_MODEL_CONTEXT_WINDOW) &&
    parsed.get("model_auto_compact_token_limit") ===
      String(DEFAULT_SETUP_MODEL_AUTO_COMPACT_TOKEN_LIMIT)
  );
}

export function stripOmxSeededBehavioralDefaults(config: string): string {
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const boundary = firstTable >= 0 ? firstTable : lines.length;
  const result: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (
      index < boundary &&
      trimmed === OMX_SEEDED_BEHAVIORAL_DEFAULTS_START_MARKER
    ) {
      const endIndex = lines.findIndex(
        (line, candidateIndex) =>
          candidateIndex > index &&
          candidateIndex < boundary &&
          line.trim() === OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER,
      );

      if (endIndex < 0) {
        continue;
      }

      const blockLines = lines.slice(index + 1, endIndex);
      if (!isUnchangedOmxSeededBehavioralDefaultsBlock(blockLines)) {
        result.push(...blockLines);
      }
      index = endIndex;
      continue;
    }

    if (
      index < boundary &&
      trimmed === OMX_SEEDED_BEHAVIORAL_DEFAULTS_END_MARKER
    ) {
      continue;
    }

    result.push(lines[index]);
  }

  return result.join("\n");
}

function stripRootLevelKeys(config: string, keys: readonly string[]): string {
  const { entries, remainder } = splitRootLevelEntries(config);

  const filteredEntries = entries.filter((entry) => {
    if (
      keys.some((key) =>
        OMX_TOP_LEVEL_KEYS.includes(key as (typeof OMX_TOP_LEVEL_KEYS)[number]),
      ) &&
      entry.lines.length === 1 &&
      entry.lines[0].trim() ===
        "# oh-my-codex top-level settings (must be before any [table])"
    ) {
      return false;
    }

    return !entry.key || !keys.includes(entry.key);
  });

  const result = [
    ...filteredEntries.flatMap((entry) => entry.lines),
    ...remainder,
  ];

  if (result.length === 0) {
    return "";
  }

  return result.join("\n");
}

function stripOrphanedManagedNotify(config: string): string {
  return config
    .replace(
      /^\s*notify\s*=\s*\["node",\s*".*notify-hook\.js"\]\s*$(\n)?/gm,
      "",
    )
    .replace(
      /\n?\s*"node",\s*\n\s*".*notify-hook\.js",\s*\n\s*\]\s*(?=\n|$)/g,
      "",
    );
}

/**
 * Remove any existing OMX-owned top-level keys so we can re-insert them
 * cleanly. Also removes the comment line that precedes them.
 */
export function stripOmxTopLevelKeys(config: string): string {
  return stripRootLevelKeys(config, OMX_TOP_LEVEL_KEYS);
}

// ---------------------------------------------------------------------------
// [features] upsert
// ---------------------------------------------------------------------------

function upsertFeatureFlags(config: string): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = [
      "[features]",
      "multi_agent = true",
      "child_agents_md = true",
      "codex_hooks = true",
      "",
    ].join("\n");
    if (base.length === 0) {
      return featureBlock;
    }
    return `${base}\n${featureBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  // Remove deprecated 'collab' key (superseded by multi_agent)
  for (let i = sectionEnd - 1; i > featuresStart; i--) {
    if (/^\s*collab\s*=/.test(lines[i])) {
      lines.splice(i, 1);
      sectionEnd -= 1;
    }
  }

  let multiAgentIdx = -1;
  let childAgentsIdx = -1;
  let codexHooksIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*multi_agent\s*=/.test(lines[i])) {
      multiAgentIdx = i;
    } else if (/^\s*child_agents_md\s*=/.test(lines[i])) {
      childAgentsIdx = i;
    } else if (/^\s*codex_hooks\s*=/.test(lines[i])) {
      codexHooksIdx = i;
    }
  }

  if (multiAgentIdx >= 0) {
    lines[multiAgentIdx] = "multi_agent = true";
  } else {
    lines.splice(sectionEnd, 0, "multi_agent = true");
    sectionEnd += 1;
  }

  if (childAgentsIdx >= 0) {
    lines[childAgentsIdx] = "child_agents_md = true";
  } else {
    lines.splice(sectionEnd, 0, "child_agents_md = true");
    sectionEnd += 1;
  }

  if (codexHooksIdx >= 0) {
    lines[codexHooksIdx] = "codex_hooks = true";
  } else {
    lines.splice(sectionEnd, 0, "codex_hooks = true");
  }

  return lines.join("\n");
}

export function upsertCodexHooksFeatureFlag(config: string): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = ["[features]", "codex_hooks = true", ""].join("\n");
    if (base.length === 0) {
      return featureBlock;
    }
    return `${base}\n${featureBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let codexHooksIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*codex_hooks\s*=/.test(lines[i])) {
      codexHooksIdx = i;
      break;
    }
  }

  if (codexHooksIdx >= 0) {
    lines[codexHooksIdx] = "codex_hooks = true";
  } else {
    lines.splice(sectionEnd, 0, "codex_hooks = true");
  }

  return lines.join("\n");
}

function upsertEnvSettings(config: string): string {
  const lines = config.split(/\r?\n/);
  const envStart = lines.findIndex((line) => /^\s*\[env\]\s*$/.test(line));

  if (envStart < 0) {
    const base = config.trimEnd();
    const envBlock = [
      "[env]",
      `${OMX_EXPLORE_CMD_ENV} = "${OMX_EXPLORE_ROUTING_DEFAULT}"`,
      "",
    ].join("\n");
    if (base.length === 0) return envBlock;
    return `${base}\n\n${envBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = envStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let exploreRoutingIdx = -1;
  for (let i = envStart + 1; i < sectionEnd; i++) {
    if (new RegExp(`^\\s*${OMX_EXPLORE_CMD_ENV}\\s*=`).test(lines[i])) {
      exploreRoutingIdx = i;
      break;
    }
  }

  if (exploreRoutingIdx < 0) {
    lines.splice(
      sectionEnd,
      0,
      `${OMX_EXPLORE_CMD_ENV} = "${OMX_EXPLORE_ROUTING_DEFAULT}"`,
    );
  }

  return lines.join("\n");
}

function upsertAgentsSettings(config: string): string {
  const lines = config.split(/\r?\n/);
  const agentsStart = lines.findIndex((line) =>
    /^\s*\[agents\]\s*$/.test(line),
  );

  if (agentsStart < 0) {
    const base = config.trimEnd();
    const agentsBlock = [
      "[agents]",
      `max_threads = ${OMX_AGENTS_MAX_THREADS}`,
      `max_depth = ${OMX_AGENTS_MAX_DEPTH}`,
      "",
    ].join("\n");
    if (base.length === 0) return agentsBlock;
    return `${base}\n\n${agentsBlock}`;
  }

  let sectionEnd = lines.length;
  for (let i = agentsStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let maxThreadsIdx = -1;
  let maxDepthIdx = -1;
  for (let i = agentsStart + 1; i < sectionEnd; i++) {
    if (/^\s*max_threads\s*=/.test(lines[i])) {
      maxThreadsIdx = i;
    } else if (/^\s*max_depth\s*=/.test(lines[i])) {
      maxDepthIdx = i;
    }
  }

  if (maxThreadsIdx < 0) {
    lines.splice(sectionEnd, 0, `max_threads = ${OMX_AGENTS_MAX_THREADS}`);
    sectionEnd += 1;
  }
  if (maxDepthIdx < 0) {
    lines.splice(sectionEnd, 0, `max_depth = ${OMX_AGENTS_MAX_DEPTH}`);
  }

  return lines.join("\n");
}

/**
 * Remove OMX-owned feature flags from the [features] section.
 * If the section becomes empty after removal, remove the section header too.
 */
export function stripOmxFeatureFlags(config: string): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) =>
    /^\s*\[features\]\s*$/.test(line),
  );

  if (featuresStart < 0) return config;

  let sectionEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const omxFlags = ["multi_agent", "child_agents_md", "codex_hooks", "collab"];
  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > featuresStart && i < sectionEnd) {
      const isOmxFlag = omxFlags.some((f) =>
        new RegExp(`^\\s*${f}\\s*=`).test(lines[i]),
      );
      if (isOmxFlag) continue;
    }
    filtered.push(lines[i]);
  }

  // If [features] section is now empty, remove the header too
  const newFeaturesStart = filtered.findIndex((l) =>
    /^\s*\[features\]\s*$/.test(l),
  );
  if (newFeaturesStart >= 0) {
    let newSectionEnd = filtered.length;
    for (let i = newFeaturesStart + 1; i < filtered.length; i++) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(filtered[i])) {
        newSectionEnd = i;
        break;
      }
    }
    const sectionContent = filtered.slice(newFeaturesStart + 1, newSectionEnd);
    if (sectionContent.every((l) => l.trim() === "")) {
      filtered.splice(newFeaturesStart, newSectionEnd - newFeaturesStart);
    }
  }

  return filtered.join("\n");
}

export function stripOmxEnvSettings(config: string): string {
  const lines = config.split(/\r?\n/);
  const envStart = lines.findIndex((line) => /^\s*\[env\]\s*$/.test(line));

  if (envStart < 0) return config;

  let sectionEnd = lines.length;
  for (let i = envStart + 1; i < lines.length; i++) {
    if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > envStart && i < sectionEnd) {
      const isOmxEnvKey = new RegExp(`^\\s*${OMX_EXPLORE_CMD_ENV}\\s*=`).test(
        lines[i],
      );
      if (isOmxEnvKey) continue;
    }
    filtered.push(lines[i]);
  }

  const newEnvStart = filtered.findIndex((line) =>
    /^\s*\[env\]\s*$/.test(line),
  );
  if (newEnvStart >= 0) {
    let newSectionEnd = filtered.length;
    for (let i = newEnvStart + 1; i < filtered.length; i++) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(filtered[i])) {
        newSectionEnd = i;
        break;
      }
    }
    const envContent = filtered.slice(newEnvStart + 1, newSectionEnd);
    if (envContent.every((line) => line.trim() === "")) {
      filtered.splice(newEnvStart, newSectionEnd - newEnvStart);
    }
  }

  return filtered.join("\n");
}

// ---------------------------------------------------------------------------
// Orphaned OMX table sections (no marker block)
// ---------------------------------------------------------------------------

/**
 * Check whether a TOML table name belongs to a legacy OMX-managed agent entry.
 * Handles both `agents.name` and `agents."name"` forms.
 */
function isLegacyOmxAgentSection(tableName: string): boolean {
  const m = tableName.match(/^agents\.(?:"([^"]+)"|(\w[\w-]*))$/);
  if (!m) return false;
  const name = m[1] || m[2] || "";
  return Object.prototype.hasOwnProperty.call(AGENT_DEFINITIONS, name);
}

/**
 * Strip OMX-owned table sections that exist outside the marker block.
 * This covers legacy configs that were written before markers were added,
 * or configs where the marker was accidentally removed.
 *
 * Targets: [mcp_servers.omx_*], legacy [agents.<name>] entries, [tui]
 */
function stripOrphanedOmxSections(config: string): string {
  const lines = config.split(/\r?\n/);
  const result: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);

    if (tableMatch) {
      const tableName = tableMatch[1];
      // Note: [tui] is NOT stripped here because it could be user-owned.
      // The marker-based stripExistingOmxBlocks already handles [tui]
      // when it lives inside the OMX marker block.
      const isOmxSection =
        /^mcp_servers\.omx_/.test(tableName) ||
        isLegacyOmxAgentSection(tableName);

      if (isOmxSection) {
        // Remove preceding OMX comment lines and blank lines
        while (result.length > 0) {
          const last = result[result.length - 1];
          if (last.trim() === "" || /^#\s*(OMX|oh-my-codex)/i.test(last)) {
            result.pop();
          } else {
            break;
          }
        }

        // Skip table header + all key=value / comment / blank lines until next section
        i++;
        while (i < lines.length && !/^\s*\[/.test(lines[i])) {
          i++;
        }
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return result.join("\n");
}

function upsertTuiStatusLine(config: string): {
  cleaned: string;
  hadExistingTui: boolean;
} {
  const lines = config.split(/\r?\n/);
  const sections: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[tui\]\s*$/.test(lines[i])) continue;

    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    sections.push({ start: i, end });
    i = end - 1;
  }

  if (sections.length === 0) {
    return { cleaned: config, hadExistingTui: false };
  }

  const preservedKeyLines: string[] = [];
  const seenKeys = new Set<string>();

  for (const section of sections) {
    for (let i = section.start + 1; i < section.end; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (!keyMatch) continue;

      const key = keyMatch[1];
      if (key === "status_line" || seenKeys.has(key)) continue;
      seenKeys.add(key);
      preservedKeyLines.push(trimmed);
    }
  }

  const mergedSection = ["[tui]", ...preservedKeyLines, OMX_TUI_STATUS_LINE];
  const firstStart = sections[0].start;
  const rebuilt: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const section = sections.find((candidate) => candidate.start === i);
    if (section) {
      if (i === firstStart) {
        if (rebuilt.length > 0 && rebuilt[rebuilt.length - 1].trim() !== "") {
          rebuilt.push("");
        }
        rebuilt.push(...mergedSection, "");
      }

      i = section.end - 1;
      continue;
    }

    rebuilt.push(lines[i]);
  }

  return {
    cleaned: rebuilt.join("\n").replace(/\n{3,}/g, "\n\n"),
    hadExistingTui: true,
  };
}

// ---------------------------------------------------------------------------
// OMX [table] sections block (appended at end of file)
// ---------------------------------------------------------------------------

export function stripExistingOmxBlocks(config: string): {
  cleaned: string;
  removed: number;
} {
  const marker = "oh-my-codex (OMX) Configuration";
  const endMarker = "# End oh-my-codex";
  let cleaned = config;
  let removed = 0;

  while (true) {
    const markerIdx = cleaned.indexOf(marker);
    if (markerIdx < 0) break;

    let blockStart = cleaned.lastIndexOf("\n", markerIdx);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = blockStart - 1;
    if (previousLineEnd >= 0) {
      const previousLineStart = cleaned.lastIndexOf("\n", previousLineEnd - 1);
      const previousLine = cleaned.slice(
        previousLineStart + 1,
        previousLineEnd,
      );
      if (/^# =+$/.test(previousLine.trim())) {
        blockStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      }
    }

    let blockEnd = cleaned.length;
    const endIdx = cleaned.indexOf(endMarker, markerIdx);
    if (endIdx >= 0) {
      const endLineBreak = cleaned.indexOf("\n", endIdx);
      blockEnd = endLineBreak >= 0 ? endLineBreak + 1 : cleaned.length;
    }

    const before = cleaned.slice(0, blockStart).trimEnd();
    const after = cleaned.slice(blockEnd).trimStart();
    cleaned = [before, after].filter(Boolean).join("\n\n");
    removed += 1;
  }

  return { cleaned, removed };
}

export function stripExistingSharedMcpRegistryBlock(config: string): {
  cleaned: string;
  removed: number;
} {
  let cleaned = config;
  let removed = 0;

  while (true) {
    const markerIdx = cleaned.indexOf(SHARED_MCP_REGISTRY_MARKER);
    if (markerIdx < 0) break;

    let blockStart = cleaned.lastIndexOf("\n", markerIdx);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = blockStart - 1;
    if (previousLineEnd >= 0) {
      const previousLineStart = cleaned.lastIndexOf("\n", previousLineEnd - 1);
      const previousLine = cleaned.slice(
        previousLineStart + 1,
        previousLineEnd,
      );
      if (/^# =+$/.test(previousLine.trim())) {
        blockStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      }
    }

    let blockEnd = cleaned.length;
    const endIdx = cleaned.indexOf(SHARED_MCP_REGISTRY_END_MARKER, markerIdx);
    if (endIdx >= 0) {
      const endLineBreak = cleaned.indexOf("\n", endIdx);
      blockEnd = endLineBreak >= 0 ? endLineBreak + 1 : cleaned.length;
    }

    const before = cleaned.slice(0, blockStart).trimEnd();
    const after = cleaned.slice(blockEnd).trimStart();
    cleaned = [before, after].filter(Boolean).join("\n\n");
    removed += 1;
  }

  return { cleaned, removed };
}

function toMcpServerTableKey(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) {
    return `mcp_servers.${name}`;
  }
  return `mcp_servers."${escapeTomlString(name)}"`;
}

function configHasMcpServer(config: string, name: string): boolean {
  const tableName = toMcpServerTableKey(name).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(`^\\s*\\[${tableName}\\]\\s*$`, "m").test(config);
}

function launcherCommandBasename(command: string): string {
  return (
    command.replace(/\\/g, "/").trim().split("/").pop()?.toLowerCase() ?? ""
  );
}

function isLauncherBackedMcpCommand(
  command: string,
  args: readonly string[],
): boolean {
  const base = launcherCommandBasename(command);
  if (base === "npx" || base === "uvx") {
    return true;
  }

  return base === "npm" && args[0]?.toLowerCase() === "exec";
}

interface LauncherTimeoutRepairTarget {
  insertAt: number;
}

function findLauncherTimeoutRepairTargets(
  config: string,
): LauncherTimeoutRepairTarget[] {
  const lines = config.split(/\r?\n/);
  const targets: LauncherTimeoutRepairTarget[] = [];

  for (let start = 0; start < lines.length; start += 1) {
    const isMcpSection = /^\s*\[mcp_servers\./.test(lines[start] ?? "");
    if (!isMcpSection) continue;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[\[?[^\]]+\]?\]\s*$/.test(lines[i] ?? "")) {
        end = i;
        break;
      }
    }

    let parsed: unknown;
    try {
      parsed = TOML.parse(lines.slice(start, end).join("\n"));
    } catch {
      start = end - 1;
      continue;
    }

    const mcpServers = (parsed as { mcp_servers?: Record<string, unknown> })
      .mcp_servers;
    const [name, value] = Object.entries(mcpServers ?? {})[0] ?? [];
    if (
      !name ||
      name.startsWith("omx_") ||
      typeof value !== "object" ||
      !value
    ) {
      start = end - 1;
      continue;
    }

    const section = value as Record<string, unknown>;
    const command =
      typeof section.command === "string" ? section.command : undefined;
    const args =
      Array.isArray(section.args) &&
      section.args.every((item) => typeof item === "string")
        ? (section.args as string[])
        : [];
    const hasStartupTimeout =
      (typeof section.startup_timeout_sec === "number" &&
        Number.isFinite(section.startup_timeout_sec)) ||
      (typeof section.startupTimeoutSec === "number" &&
        Number.isFinite(section.startupTimeoutSec));

    if (
      !command ||
      hasStartupTimeout ||
      !isLauncherBackedMcpCommand(command, args)
    ) {
      start = end - 1;
      continue;
    }

    let insertAt = end;
    while (insertAt > start + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
      insertAt -= 1;
    }

    targets.push({ insertAt });
    start = end - 1;
  }

  return targets;
}

function addDefaultLauncherMcpStartupTimeouts(config: string): string {
  const targets = findLauncherTimeoutRepairTargets(config);
  if (targets.length === 0) return config;

  const lines = config.split(/\r?\n/);
  for (const target of [...targets].reverse()) {
    lines.splice(
      target.insertAt,
      0,
      `startup_timeout_sec = ${DEFAULT_LAUNCHER_MCP_STARTUP_TIMEOUT_SEC}`,
    );
  }

  return lines.join("\n");
}

function getSharedMcpRegistryBlock(
  servers: UnifiedMcpRegistryServer[],
  sourcePath: string | undefined,
  existingConfig: string,
): string {
  if (servers.length === 0) return "";
  const deduped = servers.filter(
    (server) => !configHasMcpServer(existingConfig, server.name),
  );
  if (deduped.length === 0) return "";

  const lines = [
    "# ============================================================",
    `# ${SHARED_MCP_REGISTRY_MARKER}`,
    "# Managed by omx setup - edit the registry file instead",
  ];
  if (sourcePath) {
    lines.push(`# Source: ${sourcePath}`);
  }
  lines.push(
    "# ============================================================",
    "",
  );

  for (const server of deduped) {
    lines.push(`# Shared MCP Server: ${server.name}`);
    lines.push(`[${toMcpServerTableKey(server.name)}]`);
    lines.push(`command = "${escapeTomlString(server.command)}"`);
    lines.push(
      `args = [${server.args
        .map((arg) => `"${escapeTomlString(arg)}"`)
        .join(", ")}]`,
    );
    lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
    if (typeof server.startupTimeoutSec === "number") {
      lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    }
    lines.push("");
  }

  lines.push("# ============================================================");
  lines.push(SHARED_MCP_REGISTRY_END_MARKER);
  return lines.join("\n");
}

/**
 * OMX table-section block (MCP servers, TUI).
 * Contains ONLY [table] sections — no bare keys.
 */
function getOmxTablesBlock(pkgRoot: string, includeTui = true): string {
  const lines = [
    "",
    "# ============================================================",
    "# oh-my-codex (OMX) Configuration",
    "# Managed by omx setup - manual edits preserved on next setup",
    "# ============================================================",
  ];

  for (const server of getOmxFirstPartySetupMcpServers(pkgRoot)) {
    lines.push("");
    lines.push(server.title);
    lines.push(`[mcp_servers.${server.name}]`);
    lines.push('command = "node"');
    lines.push(
      `args = [${server.args
        .map((arg) => `"${escapeTomlString(arg)}"`)
        .join(", ")}]`,
    );
    lines.push(`enabled = ${server.enabled ? "true" : "false"}`);
    if (typeof server.startupTimeoutSec === "number") {
      lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
    }
  }

  lines.push(
    ...(includeTui
      ? [
          "",
          "# OMX TUI StatusLine (Codex CLI v0.101.0+)",
          "[tui]",
          OMX_TUI_STATUS_LINE,
          "",
        ]
      : [""]),
  );
  lines.push("# ============================================================");
  lines.push("# End oh-my-codex");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge OMX config into existing config.toml
 * Preserves existing user settings, appends OMX block if not present.
 *
 * Layout:
 *   1. OMX top-level keys (notify, model_reasoning_effort, developer_instructions)
 *   2. [features] with multi_agent + child_agents_md
 *   3. [env] with defaulted explore-routing opt-in
 *   4. … user sections …
 *   5. OMX [table] sections (mcp_servers, tui)
 */
export function buildMergedConfig(
  existingConfig: string,
  pkgRoot: string,
  options: MergeOptions = {},
): string {
  let existing = existingConfig;
  const includeTui = options.includeTui !== false;

  if (existing.includes("oh-my-codex (OMX) Configuration")) {
    const stripped = stripExistingOmxBlocks(existing);
    existing = stripped.cleaned;
  }
  if (existing.includes(SHARED_MCP_REGISTRY_MARKER)) {
    const stripped = stripExistingSharedMcpRegistryBlock(existing);
    existing = stripped.cleaned;
  }

  existing = stripOmxTopLevelKeys(existing);
  existing = stripOrphanedManagedNotify(existing);
  if (options.modelOverride) {
    existing = stripRootLevelKeys(existing, ["model"]);
  }
  existing = stripOrphanedOmxSections(existing);
  existing = upsertFeatureFlags(existing);
  existing = upsertEnvSettings(existing);
  existing = upsertAgentsSettings(existing);
  const tuiUpsert = includeTui
    ? upsertTuiStatusLine(existing)
    : { cleaned: existing, hadExistingTui: false };
  existing = tuiUpsert.cleaned;

  const topLines = getOmxTopLevelLines(
    pkgRoot,
    existing,
    options.modelOverride,
  );
  const tablesBlock = getOmxTablesBlock(
    pkgRoot,
    includeTui && !tuiUpsert.hadExistingTui,
  );
  const sharedRegistryBlock = getSharedMcpRegistryBlock(
    options.sharedMcpServers ?? [],
    options.sharedMcpRegistrySource,
    existing,
  );

  let body = existing.trimEnd();
  if (sharedRegistryBlock) {
    body = body ? `${body}\n\n${sharedRegistryBlock}` : sharedRegistryBlock;
  }

  return addDefaultLauncherMcpStartupTimeouts(
    topLines.join("\n") + "\n\n" + body + "\n" + tablesBlock,
  );
}

/**
 * Detect and repair upgrade-era managed config incompatibilities in config.toml.
 *
 * After an omx version upgrade the OLD setup code (still loaded in memory)
 * may leave a config with duplicate [tui] sections or the retired
 * [mcp_servers.omx_team_run] table. Codex rejects duplicate tables and newer
 * OMX builds no longer ship the team MCP entrypoint, so we repair both before
 * the CLI is spawned.
 *
 * Returns `true` if a repair was performed.
 */
export async function repairConfigIfNeeded(
  configPath: string,
  pkgRoot: string,
  options: MergeOptions = {},
): Promise<boolean> {
  if (!existsSync(configPath)) return false;

  const content = await readFile(configPath, "utf-8");
  const tuiCount = (content.match(/^\s*\[tui\]\s*$/gm) || []).length;
  const hasLegacyTeamRunTable = hasLegacyOmxTeamRunTable(content);
  const hasLauncherTimeoutGap =
    findLauncherTimeoutRepairTargets(content).length > 0;
  if (tuiCount <= 1 && !hasLegacyTeamRunTable && !hasLauncherTimeoutGap)
    return false;

  // Managed config compatibility issue detected — run full merge to repair
  const repaired = buildMergedConfig(content, pkgRoot, options);
  if (repaired === content) return false;
  await writeFile(configPath, repaired);
  return true;
}

export async function mergeConfig(
  configPath: string,
  pkgRoot: string,
  options: MergeOptions = {},
): Promise<void> {
  let existing = "";

  if (existsSync(configPath)) {
    existing = await readFile(configPath, "utf-8");
  }

  if (existing.includes("oh-my-codex (OMX) Configuration")) {
    const stripped = stripExistingOmxBlocks(existing);
    if (options.verbose && stripped.removed > 0) {
      console.log("  Updating existing OMX config block.");
    }
  }

  const finalConfig = buildMergedConfig(existing, pkgRoot, options);

  await writeFile(configPath, finalConfig);
  if (options.verbose) {
    console.log(`  Written to ${configPath}`);
  }
}
