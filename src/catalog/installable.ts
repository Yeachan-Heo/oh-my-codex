import type { CatalogManifest, CatalogEntryStatus } from './schema.js';

export const SETUP_ONLY_INSTALLABLE_SKILLS = new Set(['wiki']);

export function isCatalogInstallableStatus(status: CatalogEntryStatus | string | undefined): boolean {
  return status === 'active' || status === 'internal';
}

export function getSetupInstallableSkillNames(
  manifest: CatalogManifest | null | undefined,
): Set<string> {
  return new Set([
    ...((manifest?.skills ?? [])
      .filter((skill) => isCatalogInstallableStatus(skill.status))
      .map((skill) => skill.name)),
    ...SETUP_ONLY_INSTALLABLE_SKILLS,
  ]);
}
