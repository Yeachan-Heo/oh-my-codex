export type CatalogSkillCategory = 'execution' | 'planning' | 'shortcut' | 'utility';
export type CatalogAgentCategory = 'build' | 'review' | 'domain' | 'product' | 'coordination';
export type CatalogEntryStatus = 'active' | 'alias' | 'merged' | 'deprecated' | 'internal';

export interface CatalogSkillEntry {
  name: string;
  category: CatalogSkillCategory;
  status: CatalogEntryStatus;
  canonical?: string;
  core?: boolean;
  internalRequired?: boolean;
}

export interface CatalogAgentEntry {
  name: string;
  category: CatalogAgentCategory;
  status: CatalogEntryStatus;
  canonical?: string;
}

export interface CatalogManifest {
  schemaVersion: number;
  catalogVersion: string;
  skills: CatalogSkillEntry[];
  agents: CatalogAgentEntry[];
}

const SKILL_CATEGORIES = new Set<CatalogSkillCategory>(['execution', 'planning', 'shortcut', 'utility']);
const AGENT_CATEGORIES = new Set<CatalogAgentCategory>(['build', 'review', 'domain', 'product', 'coordination']);
const ENTRY_STATUSES = new Set<CatalogEntryStatus>(['active', 'alias', 'merged', 'deprecated', 'internal']);
const REQUIRED_CORE_SKILLS = new Set(['ralplan', 'team', 'ralph', 'ultrawork', 'autopilot']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`catalog_manifest_invalid:${field}`);
  }
}

export function validateCatalogManifest(input: unknown): CatalogManifest {
  if (!isObject(input)) throw new Error('catalog_manifest_invalid:root');

  if (typeof input.schemaVersion !== 'number' || !Number.isInteger(input.schemaVersion)) {
    throw new Error('catalog_manifest_invalid:schemaVersion');
  }

  assertNonEmptyString(input.catalogVersion, 'catalogVersion');

  if (!Array.isArray(input.skills)) throw new Error('catalog_manifest_invalid:skills');
  if (!Array.isArray(input.agents)) throw new Error('catalog_manifest_invalid:agents');

  const seenSkills = new Set<string>();
  const skills: CatalogSkillEntry[] = input.skills.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`catalog_manifest_invalid:skills[${index}]`);
    assertNonEmptyString(entry.name, `skills[${index}].name`);
    assertNonEmptyString(entry.category, `skills[${index}].category`);
    assertNonEmptyString(entry.status, `skills[${index}].status`);

    if (!SKILL_CATEGORIES.has(entry.category as CatalogSkillCategory)) {
      throw new Error(`catalog_manifest_invalid:skills[${index}].category`);
    }
    if (!ENTRY_STATUSES.has(entry.status as CatalogEntryStatus)) {
      throw new Error(`catalog_manifest_invalid:skills[${index}].status`);
    }

    const name = entry.name.trim();
    if (seenSkills.has(name)) throw new Error(`catalog_manifest_invalid:duplicate_skill:${name}`);
    seenSkills.add(name);

    const canonical = typeof entry.canonical === 'string' && entry.canonical.trim() !== ''
      ? entry.canonical.trim()
      : undefined;

    if ((entry.status === 'alias' || entry.status === 'merged') && !canonical) {
      throw new Error(`catalog_manifest_invalid:skills[${index}].canonical`);
    }

    return {
      name,
      category: entry.category as CatalogSkillCategory,
      status: entry.status as CatalogEntryStatus,
      canonical,
      core: entry.core === true,
      internalRequired: entry.internalRequired === true,
    };
  });

  const seenAgents = new Set<string>();
  const agents: CatalogAgentEntry[] = input.agents.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`catalog_manifest_invalid:agents[${index}]`);
    assertNonEmptyString(entry.name, `agents[${index}].name`);
    assertNonEmptyString(entry.category, `agents[${index}].category`);
    assertNonEmptyString(entry.status, `agents[${index}].status`);

    if (!AGENT_CATEGORIES.has(entry.category as CatalogAgentCategory)) {
      throw new Error(`catalog_manifest_invalid:agents[${index}].category`);
    }
    if (!ENTRY_STATUSES.has(entry.status as CatalogEntryStatus)) {
      throw new Error(`catalog_manifest_invalid:agents[${index}].status`);
    }

    const name = entry.name.trim();
    if (seenAgents.has(name)) throw new Error(`catalog_manifest_invalid:duplicate_agent:${name}`);
    seenAgents.add(name);

    const canonical = typeof entry.canonical === 'string' && entry.canonical.trim() !== ''
      ? entry.canonical.trim()
      : undefined;

    if ((entry.status === 'alias' || entry.status === 'merged') && !canonical) {
      throw new Error(`catalog_manifest_invalid:agents[${index}].canonical`);
    }

    return {
      name,
      category: entry.category as CatalogAgentCategory,
      status: entry.status as CatalogEntryStatus,
      canonical,
    };
  });

  for (const coreSkill of REQUIRED_CORE_SKILLS) {
    const skill = skills.find((s) => s.name === coreSkill);
    if (!skill || skill.status !== 'active') {
      throw new Error(`catalog_manifest_invalid:missing_core_skill:${coreSkill}`);
    }
  }

  return {
    schemaVersion: input.schemaVersion,
    catalogVersion: input.catalogVersion,
    skills,
    agents,
  };
}

export interface CatalogCounts {
  skillCount: number;
  promptCount: number;
  activeSkillCount: number;
  activeAgentCount: number;
}

export function summarizeCatalogCounts(manifest: CatalogManifest): CatalogCounts {
  return {
    skillCount: manifest.skills.length,
    promptCount: manifest.agents.length,
    activeSkillCount: manifest.skills.filter((s) => s.status === 'active').length,
    activeAgentCount: manifest.agents.filter((a) => a.status === 'active').length,
  };
}
