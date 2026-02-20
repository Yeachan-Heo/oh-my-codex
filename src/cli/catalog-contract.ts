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
  return {
    promptMin: Math.max(1, counts.promptCount - SAFETY_BUFFER),
    skillMin: Math.max(1, counts.skillCount - SAFETY_BUFFER),
  };
}

export function getCatalogHeadlineCounts(): { prompts: number; skills: number } | null {
  const manifest = tryReadCatalogManifest();
  if (!manifest) return null;
  const counts = getCatalogCounts();
  return {
    prompts: counts.promptCount,
    skills: counts.skillCount,
  };
}
