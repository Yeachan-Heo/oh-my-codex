import type { CatalogManifest, CatalogEntryStatus } from './schema.js';

export function isCatalogInstallableStatus(status: CatalogEntryStatus | string | undefined): boolean {
  return status === 'active' || status === 'internal';
}

export function getSetupInstallableSkillNames(
  manifest: CatalogManifest | null | undefined,
): Set<string> {
  return new Set(
    (manifest?.skills ?? [])
      .filter((skill) => isCatalogInstallableStatus(skill.status))
      .map((skill) => skill.name),
  );
}
