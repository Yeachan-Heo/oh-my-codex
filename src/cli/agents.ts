import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import TOML from '@iarna/toml';
import { codexAgentsDir, projectCodexAgentsDir } from '../utils/paths.js';

export const RESERVED_NATIVE_AGENT_NAMES = new Set(['default', 'worker', 'explorer']);
const DEFAULT_AGENT_MODEL = 'gpt-5.5';
const AGENTS_USAGE = [
  'Usage:',
  '  omx agents list [--scope user|project]',
  '  omx agents add <name> [--scope user|project] [--force]',
  '  omx agents edit <name> [--scope user|project]',
  '  omx agents remove <name> [--scope user|project] [--force]',
  '',
  'Manage Codex native agent TOML files under ~/.codex/agents/ or ./.codex/agents/.',
  '',
  'Notes:',
  '  - list shows project + user agents by default',
  '  - add defaults to project scope when this repo is set up for project scope; otherwise user',
  '  - remove prompts for confirmation unless --force is passed',
].join('\n');

type AgentScope = 'user' | 'project';

export interface NativeAgentInfo {
  scope: AgentScope;
  path: string;
  file: string;
  name: string;
  description: string;
  model?: string;
}

function isReservedNativeAgentName(name: string): boolean {
  return RESERVED_NATIVE_AGENT_NAMES.has(name.trim());
}

function normalizeAgentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('agent name must not be empty');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error(`invalid agent name: ${name}`);
  }
  if (isReservedNativeAgentName(trimmed)) {
    throw new Error(`"${trimmed}" is reserved by Codex built-in agents`);
  }
  return trimmed;
}

function resolveAgentsDir(scope: AgentScope, cwd = process.cwd()): string {
  return scope === 'project' ? projectCodexAgentsDir(cwd) : codexAgentsDir();
}

function parseScopeArg(args: string[]): AgentScope | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--scope') {
      const value = args[i + 1];
      if (value === 'user' || value === 'project') return value;
      throw new Error('Expected --scope user|project');
    }
    if (arg === '--scope=user') return 'user';
    if (arg === '--scope=project') return 'project';
  }
  return undefined;
}

function inferMutationScope(cwd = process.cwd()): AgentScope {
  const persistedScopePath = join(cwd, '.omx', 'setup-scope.json');
  if (existsSync(persistedScopePath)) {
    try {
      const parsed = JSON.parse(readFileSync(persistedScopePath, 'utf8')) as { scope?: string };
      if (parsed.scope === 'project' || parsed.scope === 'project-local') return 'project';
      if (parsed.scope === 'user') return 'user';
    } catch {
      // fall through
    }
  }
  return existsSync(join(cwd, '.codex')) ? 'project' : 'user';
}

function getAgentFilePath(name: string, scope: AgentScope, cwd = process.cwd()): string {
  return join(resolveAgentsDir(scope, cwd), `${name}.toml`);
}

function scaffoldAgentToml(name: string): string {
  const normalized = normalizeAgentName(name);
  return [
    `# Codex native agent: ${normalized}`,
    `name = "${normalized}"`,
    'description = "TODO: describe this agent\'s purpose"',
    'developer_instructions = """',
    'TODO: add the operating instructions for this agent.',
    '"""',
    '',
    '# Optional fields:',
    `# model = "${DEFAULT_AGENT_MODEL}"`,
    '# model_reasoning_effort = "medium"',
    '# temperature = 0.2',
    '# tools = ["shell", "apply_patch"]',
    '',
  ].join('\n');
}

function parseAgentInfo(
  content: string,
  path: string,
  scope: AgentScope,
): NativeAgentInfo {
  const fallbackName = basename(path, '.toml');
  try {
    const parsed = TOML.parse(content) as Record<string, unknown>;
    return {
      scope,
      path,
      file: basename(path),
      name: typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name : fallbackName,
      description: typeof parsed.description === 'string' ? parsed.description : '',
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
    };
  } catch {
    return {
      scope,
      path,
      file: basename(path),
      name: fallbackName,
      description: '<invalid TOML>',
    };
  }
}

async function readScopeAgents(scope: AgentScope, cwd = process.cwd()): Promise<NativeAgentInfo[]> {
  const dir = resolveAgentsDir(scope, cwd);
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const agents: NativeAgentInfo[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const path = join(dir, entry.name);
    const content = await readFile(path, 'utf8');
    agents.push(parseAgentInfo(content, path, scope));
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

export async function listNativeAgents(
  cwd = process.cwd(),
  scope?: AgentScope,
): Promise<NativeAgentInfo[]> {
  if (scope) return readScopeAgents(scope, cwd);
  const [projectAgents, userAgents] = await Promise.all([
    readScopeAgents('project', cwd),
    readScopeAgents('user', cwd),
  ]);
  return [...projectAgents, ...userAgents].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

async function addNativeAgent(
  name: string,
  options: { cwd?: string; scope?: AgentScope; force?: boolean } = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const scope = options.scope ?? inferMutationScope(cwd);
  const normalized = normalizeAgentName(name);
  const path = getAgentFilePath(normalized, scope, cwd);
  if (existsSync(path) && !options.force) {
    throw new Error(`agent already exists: ${path}`);
  }
  await mkdir(resolveAgentsDir(scope, cwd), { recursive: true });
  await writeFile(path, scaffoldAgentToml(normalized));
  return path;
}

function resolveExistingAgentPath(
  name: string,
  options: { cwd?: string; scope?: AgentScope } = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const normalized = normalizeAgentName(name);
  const candidateScopes: AgentScope[] = options.scope ? [options.scope] : ['project', 'user'];
  for (const scope of candidateScopes) {
    const path = getAgentFilePath(normalized, scope, cwd);
    if (existsSync(path)) return path;
  }
  throw new Error(`agent not found: ${normalized}`);
}

async function confirmRemove(path: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`Delete native agent ${path}? [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function ensureInteractiveRemove(force: boolean): void {
  if (force) return;
  if (process.stdin.isTTY && process.stdout.isTTY) return;
  throw new Error('remove requires an interactive terminal; rerun with --force in non-interactive environments');
}

async function editNativeAgent(
  name: string,
  options: { cwd?: string; scope?: AgentScope; editor?: string } = {},
): Promise<string> {
  const path = resolveExistingAgentPath(name, options);
  const editor = options.editor ?? process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const result = spawnSync(editor, [path], {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`editor exited with status ${result.status ?? 'unknown'}`);
  }
  return path;
}

async function removeNativeAgent(
  name: string,
  options: { cwd?: string; scope?: AgentScope; force?: boolean } = {},
): Promise<string> {
  ensureInteractiveRemove(Boolean(options.force));
  const path = resolveExistingAgentPath(name, options);
  if (!options.force) {
    const confirmed = await confirmRemove(path);
    if (!confirmed) {
      throw new Error('remove aborted by user (pass --force to skip confirmation)');
    }
  }
  await rm(path, { force: true });
  return path;
}

function printAgentsTable(agents: NativeAgentInfo[]): void {
  if (agents.length === 0) {
    console.log('No native agents found.');
    return;
  }

  const rows = [
    ['scope', 'name', 'model', 'description'],
    ...agents.map((agent) => [
      agent.scope,
      agent.name,
      agent.model ?? '-',
      agent.description || '-',
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));

  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column]!)).join('  '));
  }
}

export async function agentsCommand(args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(AGENTS_USAGE);
    return;
  }

  const subcommand = args[0];
  const scope = parseScopeArg(args.slice(1));
  const force = args.includes('--force');

  switch (subcommand) {
    case 'list': {
      const agents = await listNativeAgents(process.cwd(), scope);
      printAgentsTable(agents);
      return;
    }
    case 'add': {
      const name = args[1];
      assert.ok(name, 'Usage: omx agents add <name>');
      const path = await addNativeAgent(name, { cwd: process.cwd(), scope, force });
      console.log(`Created native agent: ${path}`);
      return;
    }
    case 'edit': {
      const name = args[1];
      assert.ok(name, 'Usage: omx agents edit <name>');
      const path = await editNativeAgent(name, { cwd: process.cwd(), scope });
      console.log(`Edited native agent: ${path}`);
      return;
    }
    case 'remove': {
      const name = args[1];
      assert.ok(name, 'Usage: omx agents remove <name>');
      const path = await removeNativeAgent(name, { cwd: process.cwd(), scope, force });
      console.log(`Removed native agent: ${path}`);
      return;
    }
    default:
      throw new Error(`unknown agents subcommand: ${subcommand}`);
  }
}
