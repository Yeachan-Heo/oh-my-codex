import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCatalogManifest, toPublicCatalogContract, type PublicCatalogContract } from '../catalog/reader.js';
import { getPackageRoot } from '../utils/package.js';

export interface OmxCatalogClientOptions {
  packageRoot?: string;
}

export interface OmxSkillPromptOptions {
  args?: string | string[];
}

export interface OmxAgentPromptOptions {
  prompt?: string;
}

export class OmxCatalogClient {
  readonly packageRoot: string;
  private cachedCatalog?: PublicCatalogContract;

  constructor(options: OmxCatalogClientOptions = {}) {
    this.packageRoot = options.packageRoot ?? getPackageRoot();
  }

  catalog(): PublicCatalogContract {
    this.cachedCatalog ??= toPublicCatalogContract(readCatalogManifest(this.packageRoot));
    return this.cachedCatalog;
  }

  listSkills(): PublicCatalogContract['skills'] {
    return this.catalog().skills;
  }

  listAgents(): PublicCatalogContract['agents'] {
    return this.catalog().agents;
  }

  getSkill(name: string): PublicCatalogContract['skills'][number] | undefined {
    return this.listSkills().find((skill) => skill.name === name);
  }

  getAgent(name: string): PublicCatalogContract['agents'][number] | undefined {
    return this.listAgents().find((agent) => agent.name === name);
  }

  skillPath(name: string): string {
    assertSafeCatalogName(name, 'skill');
    return join(this.packageRoot, 'skills', name, 'SKILL.md');
  }

  agentPath(name: string): string {
    assertSafeCatalogName(name, 'agent');
    return join(this.packageRoot, 'prompts', `${name}.md`);
  }

  async readSkill(name: string): Promise<string> {
    return await readFile(this.skillPath(name), 'utf-8');
  }

  async readAgent(name: string): Promise<string> {
    return await readFile(this.agentPath(name), 'utf-8');
  }

  skillPrompt(name: string, options: OmxSkillPromptOptions = {}): string {
    assertSafeCatalogName(name, 'skill');
    const args = Array.isArray(options.args) ? options.args.join(' ') : options.args;
    return args && args.trim() ? `$${name} ${args.trim()}` : `$${name}`;
  }

  agentPrompt(name: string, options: OmxAgentPromptOptions = {}): string {
    assertSafeCatalogName(name, 'agent');
    const prompt = options.prompt?.trim();
    return prompt ? `Use the ${name} role: ${prompt}` : `Use the ${name} role.`;
  }
}

function assertSafeCatalogName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid OMX ${label} name: ${value}`);
  }
}
