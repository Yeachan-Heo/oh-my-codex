/**
 * Native agent config generator for Codex CLI multi-agent roles
 * Generates per-agent .toml files at ~/.omx/agents/<name>.toml
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { AGENT_DEFINITIONS, AgentDefinition } from './definitions.js';
import { omxAgentsConfigDir } from '../utils/paths.js';

// Map OMX model tiers to Codex reasoning effort levels
const REASONING_EFFORT_MAP: Record<AgentDefinition['model'], string> = {
  haiku: 'low',
  sonnet: 'medium',
  opus: 'high',
};

// Agents to skip (deprecated aliases)
const SKIP_AGENTS = new Set(['deep-executor']);

/**
 * Strip YAML frontmatter (between --- markers) from markdown content
 */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}

/**
 * Escape content for TOML triple-quoted strings.
 * TOML """ strings only need to escape sequences of 3+ consecutive quotes.
 */
function escapeTomlMultiline(s: string): string {
  // Replace sequences of 3+ double quotes with escaped versions
  return s.replace(/"{3,}/g, (match) => match.split('').join('\\'));
}

/**
 * Generate TOML content for a single agent config file
 */
export function generateAgentToml(agent: AgentDefinition, promptContent: string): string {
  const instructions = stripFrontmatter(promptContent);
  const effort = REASONING_EFFORT_MAP[agent.model];
  const escaped = escapeTomlMultiline(instructions);

  return [
    `# oh-my-codex agent: ${agent.name}`,
    `model_reasoning_effort = "${effort}"`,
    `developer_instructions = """`,
    escaped,
    `"""`,
    '',
  ].join('\n');
}

/**
 * Install native agent config .toml files to ~/.omx/agents/
 * Returns the number of agents installed
 */
export async function installNativeAgentConfigs(
  pkgRoot: string,
  options: { force?: boolean; dryRun?: boolean; verbose?: boolean } = {}
): Promise<number> {
  const { force = false, dryRun = false, verbose = false } = options;
  const agentsDir = omxAgentsConfigDir();

  if (!dryRun) {
    await mkdir(agentsDir, { recursive: true });
  }

  let count = 0;

  for (const [name, agent] of Object.entries(AGENT_DEFINITIONS)) {
    if (SKIP_AGENTS.has(name)) continue;

    const promptPath = join(pkgRoot, 'prompts', `${name}.md`);
    if (!existsSync(promptPath)) {
      if (verbose) console.log(`  skip ${name} (no prompt file)`);
      continue;
    }

    const dst = join(agentsDir, `${name}.toml`);
    if (!force && existsSync(dst)) {
      if (verbose) console.log(`  skip ${name} (already exists)`);
      continue;
    }

    const promptContent = await readFile(promptPath, 'utf-8');
    const toml = generateAgentToml(agent, promptContent);

    if (!dryRun) {
      await writeFile(dst, toml);
    }
    if (verbose) console.log(`  ${name}.toml`);
    count++;
  }

  return count;
}
