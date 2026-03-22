/**
 * Config.toml generator/merger for oh-my-codex
 * Merges OMX MCP server entries and feature flags into existing config.toml
 *
 * TOML structure reminder: bare key=value pairs after a [table] header belong
 * to that table.  Top-level (root-table) keys MUST appear before the first
 * [table] header.  This generator therefore splits its output into:
 *   1. Top-level keys  (notify, model_reasoning_effort, developer_instructions)
 *   2. [features] flags
 *   3. [table] sections (mcp_servers, tui)
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { AGENT_DEFINITIONS } from "../agents/definitions.js";
import { DEFAULT_FRONTIER_MODEL } from "./models.js";
import type { UnifiedMcpRegistryServer } from "./mcp-registry.js";

interface MergeOptions {
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
const DEFAULT_SETUP_MODEL_CONTEXT_WINDOW = 1000000;
const DEFAULT_SETUP_MODEL_AUTO_COMPACT_TOKEN_LIMIT = 900000;
const SHARED_MCP_REGISTRY_MARKER = "oh-my-codex (OMX) Shared MCP Registry Sync";
const SHARED_MCP_REGISTRY_END_MARKER =
  "# End oh-my-codex shared MCP registry sync";
const OMX_AGENTS_MAX_THREADS = 6;
const OMX_AGENTS_MAX_DEPTH = 2;
const OMX_TUI_STATUS_LINE =
  'status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]';

function unwrapTomlString(value: string | undefined): string | undefined {
  return value?.match(/^"(.*)"$/)?.[1];
}

export function getRootModelName(config: string): string | undefined {
  return unwrapTomlString(parseRootKeyValues(config).get("model"));
}

function parseRootKeyValues(config: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = config.split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    values.set(match[1], match[2]);
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
    'model_reasoning_effort = "high"',
    `developer_instructions = "You have oh-my-codex installed. AGENTS.md is your orchestration brain and the main orchestration surface. Use /prompts:<role> and spawned role prompts for specialized subagent work. Codex native subagents are available via .codex/agents and may be used for independent parallel subtasks within a single session or team pane. Skills are loaded from installed SKILL.md files under .codex/skills, not from native agent TOMLs. Use workflow skills via $name when explicitly invoked or clearly routed by AGENTS.md. Treat role prompts as narrower execution surfaces under AGENTS.md authority."`,
  ];

  const existingModel = rootValues.get("model");
  const existingContextWindow = rootValues.get("model_context_window");
  const existingAutoCompact = rootValues.get("model_auto_compact_token_limit");
  const selectedModel =
    modelOverride ?? unwrapTomlString(existingModel) ?? DEFAULT_SETUP_MODEL;

  if (modelOverride || !existingModel) {
    lines.push(`model = "${selectedModel}"`);
  }

  if (
    selectedModel === DEFAULT_SETUP_MODEL &&
    !existingContextWindow &&
    !existingAutoCompact
  ) {
    lines.push(`model_context_window = ${DEFAULT_SETUP_MODEL_CONTEXT_WINDOW}`);
    lines.push(
      `model_auto_compact_token_limit = ${DEFAULT_SETUP_MODEL_AUTO_COMPACT_TOKEN_LIMIT}`,
    );
  }

  return lines;
}

function stripRootLevelKeys(config: string, keys: readonly string[]): string {
  let lines = config.split(/\r?\n/);

  if (
    keys.some((key) =>
      OMX_TOP_LEVEL_KEYS.includes(key as (typeof OMX_TOP_LEVEL_KEYS)[number]),
    )
  ) {
    lines = lines.filter(
      (l) =>
        l.trim() !==
        "# oh-my-codex top-level settings (must be before any [table])",
    );
  }

  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const boundary = firstTable >= 0 ? firstTable : lines.length;

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < boundary) {
      const isManagedKey = keys.some((key) =>
        new RegExp(`^\\s*${key}\\s*=`).test(lines[i]),
      );
      if (isManagedKey) continue;
    }
    result.push(lines[i]);
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
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*multi_agent\s*=/.test(lines[i])) {
      multiAgentIdx = i;
    } else if (/^\s*child_agents_md\s*=/.test(lines[i])) {
      childAgentsIdx = i;
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

  const omxFlags = ["multi_agent", "child_agents_md", "collab"];
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
  const stateServerPath = escapeTomlString(
    join(pkgRoot, "dist", "mcp", "state-server.js"),
  );
  const memoryServerPath = escapeTomlString(
    join(pkgRoot, "dist", "mcp", "memory-server.js"),
  );
  const codeIntelServerPath = escapeTomlString(
    join(pkgRoot, "dist", "mcp", "code-intel-server.js"),
  );
  const traceServerPath = escapeTomlString(
    join(pkgRoot, "dist", "mcp", "trace-server.js"),
  );
  const teamServerPath = escapeTomlString(
    join(pkgRoot, "dist", "mcp", "team-server.js"),
  );

  return [
    "",
    "# ============================================================",
    "# oh-my-codex (OMX) Configuration",
    "# Managed by omx setup - manual edits preserved on next setup",
    "# ============================================================",
    "",
    "# OMX State Management MCP Server",
    "[mcp_servers.omx_state]",
    'command = "node"',
    `args = ["${stateServerPath}"]`,
    "enabled = true",
    "startup_timeout_sec = 5",
    "",
    "# OMX Project Memory MCP Server",
    "[mcp_servers.omx_memory]",
    'command = "node"',
    `args = ["${memoryServerPath}"]`,
    "enabled = true",
    "startup_timeout_sec = 5",
    "",
    "# OMX Code Intelligence MCP Server (LSP diagnostics, AST search)",
    "[mcp_servers.omx_code_intel]",
    'command = "node"',
    `args = ["${codeIntelServerPath}"]`,
    "enabled = true",
    "startup_timeout_sec = 10",
    "",
    "# OMX Trace MCP Server (agent flow timeline & statistics)",
    "[mcp_servers.omx_trace]",
    'command = "node"',
    `args = ["${traceServerPath}"]`,
    "enabled = true",
    "startup_timeout_sec = 5",
    "",
    "# OMX Team MCP Server (team job lifecycle: start, status, wait, cleanup)",
    "[mcp_servers.omx_team_run]",
    'command = "node"',
    `args = ["${teamServerPath}"]`,
    "enabled = true",
    "startup_timeout_sec = 5",
    ...(includeTui
      ? [
          "",
          "# OMX TUI StatusLine (Codex CLI v0.101.0+)",
          "[tui]",
          OMX_TUI_STATUS_LINE,
          "",
        ]
      : []),
    "# ============================================================",
    "# End oh-my-codex",
    "",
  ].join("\n");
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
 *   3. … user sections …
 *   4. OMX [table] sections (mcp_servers, tui)
 */
export function buildMergedConfig(
  existingConfig: string,
  pkgRoot: string,
  options: MergeOptions = {},
): string {
  let existing = existingConfig;

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
  existing = upsertAgentsSettings(existing);
  const tuiUpsert = upsertTuiStatusLine(existing);
  existing = tuiUpsert.cleaned;

  const topLines = getOmxTopLevelLines(
    pkgRoot,
    existing,
    options.modelOverride,
  );
  const tablesBlock = getOmxTablesBlock(pkgRoot, !tuiUpsert.hadExistingTui);
  const sharedRegistryBlock = getSharedMcpRegistryBlock(
    options.sharedMcpServers ?? [],
    options.sharedMcpRegistrySource,
    existing,
  );

  let body = existing.trimEnd();
  if (sharedRegistryBlock) {
    body = body ? `${body}\n\n${sharedRegistryBlock}` : sharedRegistryBlock;
  }

  return topLines.join("\n") + "\n\n" + body + "\n" + tablesBlock;
}

/**
 * Detect and repair duplicate TOML table headers (e.g. [tui]) in config.toml.
 *
 * After an omx version upgrade the OLD setup code (still loaded in memory)
 * may write a config with duplicate [tui] sections.  The Codex CLI TOML
 * parser rejects duplicates, so we must fix them before the CLI is spawned.
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
  if (tuiCount <= 1) return false;

  // Duplicate [tui] detected — run full merge to repair
  const repaired = buildMergedConfig(content, pkgRoot, options);
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
