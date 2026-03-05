import { getCatalogCounts, tryReadCatalogManifest } from '../catalog/reader.js';

export interface CatalogExpectations {
  promptMin: number;
  skillMin: number;
}

const SAFETY_BUFFER = 2;

export function getCatalogExpectations(): CatalogExpectations {
  const manifest = tryReadCatalogManifest();
  if (!manifest) {
    return { promptMin: 25, skillMin: 30 };
  }

  const counts = getCatalogCounts();
  const installableSkillCount = manifest.skills
    .filter((skill) => skill.status === 'active' || skill.status === 'internal')
    .length;
  return {
    promptMin: Math.max(1, counts.promptCount - SAFETY_BUFFER),
    skillMin: Math.max(1, installableSkillCount - SAFETY_BUFFER),
  };
}

export function getCatalogHeadlineCounts(): { prompts: number; skills: number } | null {
  const manifest = tryReadCatalogManifest();
  if (!manifest) return null;
  const counts = getCatalogCounts();
  const installableSkillCount = manifest.skills
    .filter((skill) => skill.status === 'active' || skill.status === 'internal')
    .length;
  return {
    prompts: counts.promptCount,
    skills: installableSkillCount,
  };
}
