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

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { AGENT_DEFINITIONS } from '../agents/definitions.js';
import { omxAgentsConfigDir } from '../utils/paths.js';

interface MergeOptions {
  agentsConfigDir?: string;
  verbose?: boolean;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Top-level OMX keys (must live before any [table] header)
// ---------------------------------------------------------------------------

/** Keys we own at the TOML root level. Used for upsert + strip. */
const OMX_TOP_LEVEL_KEYS = [
  'notify',
  'model_reasoning_effort',
  'developer_instructions',
] as const;

function getOmxTopLevelLines(pkgRoot: string): string[] {
  const notifyHookPath = join(pkgRoot, 'scripts', 'notify-hook.js');
  const escapedPath = escapeTomlString(notifyHookPath);

  return [
    '# oh-my-codex top-level settings (must be before any [table])',
    `notify = ["node", "${escapedPath}"]`,
    'model_reasoning_effort = "high"',
    `developer_instructions = "You have oh-my-codex installed. Use /prompts:architect, /prompts:executor, /prompts:planner for specialized agent roles. Workflow skills via $name: $ralph, $autopilot, $plan. AGENTS.md is your orchestration brain."`,
  ];
}

/**
 * Remove any existing OMX-owned top-level keys so we can re-insert them
 * cleanly.  Also removes the comment line that precedes them.
 */
function stripOmxTopLevelKeys(config: string): string {
  let lines = config.split(/\r?\n/);

  // Remove the OMX top-level comment line
  lines = lines.filter((l) => l.trim() !== '# oh-my-codex top-level settings (must be before any [table])');

  // Remove lines matching OMX-owned keys (only in root scope, i.e. before
  // the first [table] header).
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  const boundary = firstTable >= 0 ? firstTable : lines.length;

  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i < boundary) {
      const isOmxKey = OMX_TOP_LEVEL_KEYS.some((k) =>
        new RegExp(`^\\s*${k}\\s*=`).test(lines[i])
      );
      if (isOmxKey) continue;
    }
    result.push(lines[i]);
  }

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// [features] upsert
// ---------------------------------------------------------------------------

function upsertFeatureFlags(config: string): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = [
      '[features]',
      'multi_agent = true',
      'child_agents_md = true',
      '',
    ].join('\n');
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
    lines[multiAgentIdx] = 'multi_agent = true';
  } else {
    lines.splice(sectionEnd, 0, 'multi_agent = true');
    sectionEnd += 1;
  }

  if (childAgentsIdx >= 0) {
    lines[childAgentsIdx] = 'child_agents_md = true';
  } else {
    lines.splice(sectionEnd, 0, 'child_agents_md = true');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OMX [table] sections block (appended at end of file)
// ---------------------------------------------------------------------------

function stripExistingOmxBlocks(config: string): { cleaned: string; removed: number } {
  const marker = 'oh-my-codex (OMX) Configuration';
  const endMarker = '# End oh-my-codex';
  let cleaned = config;
  let removed = 0;

  while (true) {
    const markerIdx = cleaned.indexOf(marker);
    if (markerIdx < 0) break;

    let blockStart = cleaned.lastIndexOf('\n', markerIdx);
    blockStart = blockStart >= 0 ? blockStart + 1 : 0;

    const previousLineEnd = blockStart - 1;
    if (previousLineEnd >= 0) {
      const previousLineStart = cleaned.lastIndexOf('\n', previousLineEnd - 1);
      const previousLine = cleaned.slice(previousLineStart + 1, previousLineEnd);
      if (/^# =+$/.test(previousLine.trim())) {
        blockStart = previousLineStart >= 0 ? previousLineStart + 1 : 0;
      }
    }

    let blockEnd = cleaned.length;
    const endIdx = cleaned.indexOf(endMarker, markerIdx);
    if (endIdx >= 0) {
      const endLineBreak = cleaned.indexOf('\n', endIdx);
      blockEnd = endLineBreak >= 0 ? endLineBreak + 1 : cleaned.length;
    }

    const before = cleaned.slice(0, blockStart).trimEnd();
    const after = cleaned.slice(blockEnd).trimStart();
    cleaned = [before, after].filter(Boolean).join('\n\n');
    removed += 1;
  }

  return { cleaned, removed };
}

/**
 * Generate [agents.<name>] entries for Codex native multi-agent support.
 * Each agent gets a description and config_file pointing to ~/.omx/agents/<name>.toml
 */
function getAgentEntries(agentsConfigDir: string): string[] {
  const entries: string[] = [
    '',
    '# OMX Native Agent Roles (Codex multi-agent)',
  ];

  for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
    // TOML table headers with special chars need quoting
    const tableKey = name.includes('-') ? `agents."${name}"` : `agents.${name}`;
    const configFile = escapeTomlString(join(agentsConfigDir, `${name}.toml`));

    entries.push('');
    entries.push(`[${tableKey}]`);
    entries.push(`description = "${agent.description}"`);
    entries.push(`config_file = "${configFile}"`);
  }

  return entries;
}

/**
 * OMX table-section block (MCP servers, TUI).
 * Contains ONLY [table] sections — no bare keys.
 */
function getOmxTablesBlock(pkgRoot: string, agentsConfigDir: string): string {
  const stateServerPath = escapeTomlString(join(pkgRoot, 'dist', 'mcp', 'state-server.js'));
  const memoryServerPath = escapeTomlString(join(pkgRoot, 'dist', 'mcp', 'memory-server.js'));
  const codeIntelServerPath = escapeTomlString(join(pkgRoot, 'dist', 'mcp', 'code-intel-server.js'));
  const traceServerPath = escapeTomlString(join(pkgRoot, 'dist', 'mcp', 'trace-server.js'));

  return [
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '# OMX State Management MCP Server',
    '[mcp_servers.omx_state]',
    'command = "node"',
    `args = ["${stateServerPath}"]`,
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMX Project Memory MCP Server',
    '[mcp_servers.omx_memory]',
    'command = "node"',
    `args = ["${memoryServerPath}"]`,
    'enabled = true',
    'startup_timeout_sec = 5',
    '',
    '# OMX Code Intelligence MCP Server (LSP diagnostics, AST search)',
    '[mcp_servers.omx_code_intel]',
    'command = "node"',
    `args = ["${codeIntelServerPath}"]`,
    'enabled = true',
    'startup_timeout_sec = 10',
    '',
    '# OMX Trace MCP Server (agent flow timeline & statistics)',
    '[mcp_servers.omx_trace]',
    'command = "node"',
    `args = ["${traceServerPath}"]`,
    'enabled = true',
    'startup_timeout_sec = 5',
    ...getAgentEntries(agentsConfigDir),
    '',
    '# OMX TUI StatusLine (Codex CLI v0.101.0+)',
    '[tui]',
    'status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit"]',
    '',
    '# ============================================================',
    '# End oh-my-codex',
    '',
  ].join('\n');
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
export async function mergeConfig(
  configPath: string,
  pkgRoot: string,
  options: MergeOptions = {}
): Promise<void> {
  let existing = '';

  if (existsSync(configPath)) {
    existing = await readFile(configPath, 'utf-8');
  }

  // Strip old OMX table-section block
  if (existing.includes('oh-my-codex (OMX) Configuration')) {
    const stripped = stripExistingOmxBlocks(existing);
    existing = stripped.cleaned;
    if (options.verbose && stripped.removed > 0) {
      console.log('  Updating existing OMX config block.');
    }
  }

  // Strip any stale OMX top-level keys (from previous runs or wrong positions)
  existing = stripOmxTopLevelKeys(existing);

  // Upsert [features] flags
  existing = upsertFeatureFlags(existing);

  // Build final config:
  //   top-level keys → existing content (with [features]) → OMX tables block
  const topLines = getOmxTopLevelLines(pkgRoot);
  const tablesBlock = getOmxTablesBlock(pkgRoot, options.agentsConfigDir || omxAgentsConfigDir());

  const finalConfig = topLines.join('\n') + '\n\n' + existing.trimEnd() + '\n' + tablesBlock;

  await writeFile(configPath, finalConfig);
  if (options.verbose) {
    console.log(`  Written to ${configPath}`);
  }
}
