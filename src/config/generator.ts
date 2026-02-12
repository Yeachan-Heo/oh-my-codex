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

/**
 * OMX config entries to merge into config.toml
 */
function getOmxConfigBlock(pkgRoot: string): string {
  const stateServerPath = join(pkgRoot, 'dist', 'mcp', 'state-server.js');
  const memoryServerPath = join(pkgRoot, 'dist', 'mcp', 'memory-server.js');
  const notifyHookPath = join(pkgRoot, 'scripts', 'notify-hook.js');

  return `
# ============================================================
# oh-my-codex (OMX) Configuration
# Managed by omx setup - manual edits preserved on next setup
# ============================================================

# OMX Developer Instructions
# developer_instructions = "You have oh-my-codex installed. Use /architect, /executor, /planner as slash commands for specialized agent roles. Skills are available via /skills."

# Notification hook - fires after each agent turn
# notify = ["node", "${notifyHookPath}"]

# Feature flags for sub-agent orchestration
[features]
collab = true
child_agents_md = true

# OMX State Management MCP Server
[mcp_servers.omx_state]
command = "node"
args = ["${stateServerPath}"]
enabled = true
startup_timeout_sec = 5

# OMX Project Memory MCP Server
[mcp_servers.omx_memory]
command = "node"
args = ["${memoryServerPath}"]
enabled = true
startup_timeout_sec = 5
`;
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
    // Remove existing OMX block and re-add (update)
    const startMarker = '# ============================================================\n# oh-my-codex (OMX) Configuration';
    const startIdx = existing.indexOf(startMarker);
    if (startIdx >= 0) {
      // Find the end of the OMX block (next non-OMX section or EOF)
      const endMarker = '\n# ============================================================\n# End oh-my-codex';
      const endIdx = existing.indexOf(endMarker);
      if (endIdx >= 0) {
        existing = existing.slice(0, startIdx) + existing.slice(endIdx + endMarker.length);
      } else {
        // Remove everything from the marker to EOF
        existing = existing.slice(0, startIdx);
      }
    }
    if (options.verbose) {
      console.log('  Updating existing OMX config block.');
    }
  }

  const omxBlock = getOmxConfigBlock(pkgRoot);
  const finalConfig = existing.trimEnd() + '\n' + omxBlock;

  await writeFile(configPath, finalConfig);
  if (options.verbose) {
    console.log(`  Written to ${configPath}`);
  }
}
