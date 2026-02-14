/**
 * Config.toml generator/merger for oh-my-codex
 * Merges OMX MCP server entries and feature flags into existing config.toml
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

interface MergeOptions {
  verbose?: boolean;
}

function upsertFeatureFlags(config: string): string {
  const lines = config.split(/\r?\n/);
  const featuresStart = lines.findIndex((line) => /^\s*\[features\]\s*$/.test(line));

  if (featuresStart < 0) {
    const base = config.trimEnd();
    const featureBlock = [
      '[features]',
      'collab = true',
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

  let collabIdx = -1;
  let childAgentsIdx = -1;
  for (let i = featuresStart + 1; i < sectionEnd; i++) {
    if (/^\s*collab\s*=/.test(lines[i])) {
      collabIdx = i;
    } else if (/^\s*child_agents_md\s*=/.test(lines[i])) {
      childAgentsIdx = i;
    }
  }

  if (collabIdx >= 0) {
    lines[collabIdx] = 'collab = true';
  } else {
    lines.splice(sectionEnd, 0, 'collab = true');
    sectionEnd += 1;
  }

  if (childAgentsIdx >= 0) {
    lines[childAgentsIdx] = 'child_agents_md = true';
  } else {
    lines.splice(sectionEnd, 0, 'child_agents_md = true');
  }

  return lines.join('\n');
}

function getNotifyConfigLine(notifyHookPath: string): string {
  const notifyCommand = `node "${notifyHookPath}"`
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `notify = "${notifyCommand}"`;
}

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
 * OMX config entries to merge into config.toml
 */
function getOmxConfigBlock(pkgRoot: string): string {
  const stateServerPath = join(pkgRoot, 'dist', 'mcp', 'state-server.js');
  const memoryServerPath = join(pkgRoot, 'dist', 'mcp', 'memory-server.js');
  const codeIntelServerPath = join(pkgRoot, 'dist', 'mcp', 'code-intel-server.js');
  const traceServerPath = join(pkgRoot, 'dist', 'mcp', 'trace-server.js');
  const notifyHookPath = join(pkgRoot, 'scripts', 'notify-hook.js');

  return [
    '',
    '# ============================================================',
    '# oh-my-codex (OMX) Configuration',
    '# Managed by omx setup - manual edits preserved on next setup',
    '# ============================================================',
    '',
    '# OMX Developer Instructions',
    `developer_instructions = "You have oh-my-codex installed. Use /prompts:architect, /prompts:executor, /prompts:planner for specialized agent roles. Workflow skills via $name: $ralph, $autopilot, $plan. AGENTS.md is your orchestration brain."`,
    'model_reasoning_effort = "high"',
    '',
    '# Notification hook - fires after each agent turn',
    getNotifyConfigLine(notifyHookPath),
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

/**
 * Merge OMX config into existing config.toml
 * Preserves existing user settings, appends OMX block if not present
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

  // Check if OMX config is already present
  if (existing.includes('oh-my-codex (OMX) Configuration')) {
    const stripped = stripExistingOmxBlocks(existing);
    existing = stripped.cleaned;
    if (options.verbose && stripped.removed > 0) {
      console.log('  Updating existing OMX config block.');
    }
  }

  existing = upsertFeatureFlags(existing);

  const omxBlock = getOmxConfigBlock(pkgRoot);
  const finalConfig = existing.trimEnd() + '\n' + omxBlock;

  await writeFile(configPath, finalConfig);
  if (options.verbose) {
    console.log(`  Written to ${configPath}`);
  }
}
