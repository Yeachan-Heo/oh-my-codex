/**
 * omx doctor - Validate oh-my-codex installation
 */

import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { execSync } from 'child_process';
import {
  codexHome, codexConfigPath, codexPromptsDir,
  userSkillsDir, omxStateDir,
} from '../utils/paths.js';

interface DoctorOptions {
  verbose?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  console.log('oh-my-codex doctor');
  console.log('==================\n');

  const checks: Check[] = [];

  // Check 1: Codex CLI installed
  checks.push(checkCodexCli());

  // Check 2: Node.js version
  checks.push(checkNodeVersion());

  // Check 3: Codex home directory
  checks.push(checkDirectory('Codex home', codexHome()));

  // Check 4: Config file
  checks.push(await checkConfig());

  // Check 5: Prompts installed
  checks.push(await checkPrompts());

  // Check 6: Skills installed
  checks.push(await checkSkills());

  // Check 7: AGENTS.md in project
  checks.push(checkAgentsMd());

  // Check 8: State directory
  checks.push(checkDirectory('State dir', omxStateDir()));

  // Check 9: MCP servers configured
  checks.push(await checkMcpServers());

  // Print results
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    const icon = check.status === 'pass' ? '[OK]' : check.status === 'warn' ? '[!!]' : '[XX]';
    console.log(`  ${icon} ${check.name}: ${check.message}`);
    if (check.status === 'pass') passCount++;
    else if (check.status === 'warn') warnCount++;
    else failCount++;
  }

  console.log(`\nResults: ${passCount} passed, ${warnCount} warnings, ${failCount} failed`);

  if (failCount > 0) {
    console.log('\nRun "omx setup" to fix installation issues.');
  } else if (warnCount > 0) {
    console.log('\nRun "omx setup --force" to refresh all components.');
  } else {
    console.log('\nAll checks passed! oh-my-codex is ready.');
  }
}

function checkCodexCli(): Check {
  try {
    const version = execSync('codex --version 2>/dev/null', { encoding: 'utf-8' }).trim();
    return { name: 'Codex CLI', status: 'pass', message: `installed (${version})` };
  } catch {
    return { name: 'Codex CLI', status: 'fail', message: 'not found - install from https://github.com/openai/codex' };
  }
}

function checkNodeVersion(): Check {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20) {
    return { name: 'Node.js', status: 'pass', message: `v${process.versions.node}` };
  }
  return { name: 'Node.js', status: 'fail', message: `v${process.versions.node} (need >= 20)` };
}

function checkDirectory(name: string, path: string): Check {
  if (existsSync(path)) {
    return { name, status: 'pass', message: path };
  }
  return { name, status: 'warn', message: `${path} (not created yet)` };
}

async function checkConfig(): Promise<Check> {
  const configPath = codexConfigPath();
  if (!existsSync(configPath)) {
    return { name: 'Config', status: 'warn', message: 'config.toml not found' };
  }
  try {
    const content = await readFile(configPath, 'utf-8');
    const hasOmx = content.includes('omx_') || content.includes('oh-my-codex');
    if (hasOmx) {
      return { name: 'Config', status: 'pass', message: 'config.toml has OMX entries' };
    }
    return { name: 'Config', status: 'warn', message: 'config.toml exists but no OMX entries' };
  } catch {
    return { name: 'Config', status: 'fail', message: 'cannot read config.toml' };
  }
}

async function checkPrompts(): Promise<Check> {
  const dir = codexPromptsDir();
  if (!existsSync(dir)) {
    return { name: 'Prompts', status: 'warn', message: 'prompts directory not found' };
  }
  try {
    const files = await readdir(dir);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    if (mdFiles.length >= 25) {
      return { name: 'Prompts', status: 'pass', message: `${mdFiles.length} agent prompts installed` };
    }
    return { name: 'Prompts', status: 'warn', message: `${mdFiles.length} prompts (expected 30+)` };
  } catch {
    return { name: 'Prompts', status: 'fail', message: 'cannot read prompts directory' };
  }
}

async function checkSkills(): Promise<Check> {
  const dir = userSkillsDir();
  if (!existsSync(dir)) {
    return { name: 'Skills', status: 'warn', message: 'skills directory not found' };
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory());
    if (skillDirs.length >= 20) {
      return { name: 'Skills', status: 'pass', message: `${skillDirs.length} skills installed` };
    }
    return { name: 'Skills', status: 'warn', message: `${skillDirs.length} skills (expected 30+)` };
  } catch {
    return { name: 'Skills', status: 'fail', message: 'cannot read skills directory' };
  }
}

function checkAgentsMd(): Check {
  const agentsMd = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsMd)) {
    return { name: 'AGENTS.md', status: 'pass', message: 'found in project root' };
  }
  return { name: 'AGENTS.md', status: 'warn', message: 'not found in project root (run omx setup)' };
}

async function checkMcpServers(): Promise<Check> {
  const configPath = codexConfigPath();
  if (!existsSync(configPath)) {
    return { name: 'MCP Servers', status: 'warn', message: 'config.toml not found' };
  }
  try {
    const content = await readFile(configPath, 'utf-8');
    const mcpCount = (content.match(/\[mcp_servers\./g) || []).length;
    if (mcpCount > 0) {
      const hasOmx = content.includes('omx_state') || content.includes('omx_memory');
      if (hasOmx) {
        return { name: 'MCP Servers', status: 'pass', message: `${mcpCount} servers configured (OMX present)` };
      }
      return { name: 'MCP Servers', status: 'warn', message: `${mcpCount} servers but no OMX servers` };
    }
    return { name: 'MCP Servers', status: 'warn', message: 'no MCP servers configured' };
  } catch {
    return { name: 'MCP Servers', status: 'fail', message: 'cannot read config.toml' };
  }
}
