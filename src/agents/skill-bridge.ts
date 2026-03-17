import TOML from '@iarna/toml';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  codexAgentsDir,
  listInstalledSkillDirectories,
  projectCodexAgentsDir,
  projectSkillsDir,
  userSkillsDir,
  type InstalledSkillDirectory,
} from '../utils/paths.js';

export interface SkillBridgeAgentConfig {
  name: string;
  description: string;
  skillRef: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

export interface SkillBridgeAgentRecord {
  name: string;
  description: string;
  skillRef: string;
  scope: 'project' | 'user';
  path: string;
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
}

function escapeTomlBasicString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeReasoning(value: unknown): SkillBridgeAgentRecord['reasoningEffort'] | undefined {
  const normalized = normalizeNonEmptyString(value)?.toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') {
    return normalized;
  }
  return undefined;
}

export function generateSkillBridgeAgentToml(config: SkillBridgeAgentConfig): string {
  const lines = [
    `# oh-my-codex skill bridge agent: ${config.name}`,
    `name = "${escapeTomlBasicString(config.name)}"`,
    `description = "${escapeTomlBasicString(config.description)}"`,
  ];

  if (config.model) {
    lines.push(`model = "${escapeTomlBasicString(config.model)}"`);
  }
  if (config.reasoningEffort) {
    lines.push(`model_reasoning_effort = "${config.reasoningEffort}"`);
  }

  lines.push(`skill_ref = "${escapeTomlBasicString(config.skillRef)}"`, '');
  return lines.join('\n');
}

function parseSkillBridgeAgentRecord(
  content: string,
  path: string,
  scope: 'project' | 'user',
): SkillBridgeAgentRecord | null {
  try {
    const parsed = TOML.parse(content) as Record<string, unknown>;
    const skillRef = normalizeNonEmptyString(parsed.skill_ref);
    const name = normalizeNonEmptyString(parsed.name);
    const description = normalizeNonEmptyString(parsed.description);
    if (!skillRef || !name || !description) return null;

    return {
      name,
      description,
      skillRef,
      scope,
      path,
      model: normalizeNonEmptyString(parsed.model),
      reasoningEffort: normalizeReasoning(parsed.model_reasoning_effort),
    };
  } catch {
    return null;
  }
}

async function readSkillBridgeAgentsFromDir(
  dir: string,
  scope: 'project' | 'user',
): Promise<SkillBridgeAgentRecord[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const bridges: SkillBridgeAgentRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const path = join(dir, entry.name);
    const parsed = parseSkillBridgeAgentRecord(await readFile(path, 'utf-8'), path, scope);
    if (parsed) bridges.push(parsed);
  }

  return bridges.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listInstalledSkillBridgeAgents(projectRoot?: string): Promise<SkillBridgeAgentRecord[]> {
  const [projectAgents, userAgents] = await Promise.all([
    readSkillBridgeAgentsFromDir(projectCodexAgentsDir(projectRoot), 'project'),
    readSkillBridgeAgentsFromDir(codexAgentsDir(), 'user'),
  ]);

  const deduped: SkillBridgeAgentRecord[] = [];
  const seenNames = new Set<string>();
  for (const item of [...projectAgents, ...userAgents]) {
    if (seenNames.has(item.name)) continue;
    seenNames.add(item.name);
    deduped.push(item);
  }
  return deduped;
}

function listNames(items: string[], limit = 8): string {
  if (items.length === 0) return '- none';
  const visible = items.slice(0, limit).map((item) => `- \`${item}\``);
  if (items.length > limit) visible.push(`- ...and ${items.length - limit} more`);
  return visible.join('\n');
}

function buildSkillResolutionOrder(
  skillsByName: ReadonlyMap<string, InstalledSkillDirectory>,
  projectRoot?: string,
): string[] {
  const projectScoped = [...skillsByName.values()].filter((item) => item.scope === 'project');
  const userScoped = [...skillsByName.values()].filter((item) => item.scope === 'user');

  const lines = [
    'Resolution order for a referenced skill:',
    `1. \`${userSkillsDir()}/<skill>/SKILL.md\` (primary Codex skills path)`,
    `2. \`${projectSkillsDir(projectRoot)}/<skill>/SKILL.md\` (legacy project fallback)`,
    '3. `~/.agents/skills/<skill>/SKILL.md` (legacy compatibility fallback)',
  ];

  if (userScoped.length > 0 || projectScoped.length > 0) {
    lines.push('');
    if (userScoped.length > 0) {
      lines.push(`Codex-installed skills (primary):\n${listNames(userScoped.map((item) => item.name))}`);
    }
    if (projectScoped.length > 0) {
      lines.push(`Legacy project skills fallback:\n${listNames(projectScoped.map((item) => item.name))}`);
    }
  }

  return lines;
}

export async function buildSkillBridgeResolutionGuidance(projectRoot?: string): Promise<string> {
  const bridges = await listInstalledSkillBridgeAgents(projectRoot);
  if (bridges.length === 0) return '';

  const installedSkills = await listInstalledSkillDirectories(projectRoot);
  const skillsByName = new Map(installedSkills.map((item) => [item.name, item]));
  const bridgeLines = bridges.map((bridge) => {
    const primaryCodexSkillPath = join(userSkillsDir(), bridge.skillRef, 'SKILL.md');
    const legacyProjectSkillPath = join(projectSkillsDir(projectRoot), bridge.skillRef, 'SKILL.md');
    const legacyUserSkillPath = join(process.env.HOME || '~', '.agents', 'skills', bridge.skillRef, 'SKILL.md');
    const suffix = existsSync(primaryCodexSkillPath)
      ? ' -> Codex skills primary'
      : existsSync(legacyProjectSkillPath)
        ? ' -> legacy project fallback'
        : existsSync(legacyUserSkillPath)
          ? ' -> legacy user fallback'
          : skillsByName.get(bridge.skillRef)
            ? ` -> ${skillsByName.get(bridge.skillRef)?.scope} skill`
            : ' -> unresolved skill (keep fallback resolution order)';
    return `- \`${bridge.name}\` => \`${bridge.skillRef}\`${suffix}`;
  });

  return [
    '**Native Skill Bridge:**',
    'Some lightweight native agent TOMLs declare `skill_ref` instead of embedding skill markdown.',
    'When the active native agent includes `skill_ref`, resolve that reference at runtime and follow the installed SKILL.md instructions from disk.',
    'Do not expect long `developer_instructions` blocks inside skill-bridge TOMLs.',
    '',
    'Installed skill bridge agents:',
    ...bridgeLines,
    '',
    ...buildSkillResolutionOrder(skillsByName, projectRoot),
  ].join('\n');
}
