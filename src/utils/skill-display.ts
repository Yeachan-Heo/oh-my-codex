import type { InstalledSkillDirectory, InstalledSkillOrigin } from "./paths.js";

export interface SkillDisplayDescriptor {
  name: string;
  origin: InstalledSkillOrigin;
}

export function getSkillDisplayLabel(
  skill: Pick<InstalledSkillDirectory, "name" | "origin"> | SkillDisplayDescriptor,
): string {
  return skill.origin === "omx" ? `OMX: ${skill.name}` : skill.name;
}
