/**
 * Path utilities for oh-my-codex
 * Resolves provider CLI config, skills, prompts, and state directories.
 *
 * All provider-specific paths now delegate to the provider abstraction
 * (src/providers/index.ts).  The original function names are kept for
 * backward compatibility so that existing call-sites continue to work
 * without modification.
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import {
  providerHome,
  providerConfigPath,
  providerPromptsDir,
  providerSkillsDir,
  providerAgentsDir,
  projectProviderDir,
} from "../providers/index.js";

/** Provider CLI home directory (provider-aware; defaults to ~/.codex/) */
export function codexHome(): string {
  return process.env.CODEX_HOME || providerHome();
}

/** Provider config file path (provider-aware) */
export function codexConfigPath(): string {
  if (process.env.CODEX_HOME) {
    return join(process.env.CODEX_HOME, "config.toml");
  }
  return providerConfigPath();
}

/** Provider prompts directory (provider-aware) */
export function codexPromptsDir(): string {
  if (process.env.CODEX_HOME) {
    return join(process.env.CODEX_HOME, "prompts");
  }
  return providerPromptsDir();
}

/** Provider native agents directory (provider-aware) */
export function codexAgentsDir(codexHomeDir?: string): string {
  if (codexHomeDir) return join(codexHomeDir, "agents");
  if (process.env.CODEX_HOME) {
    return join(process.env.CODEX_HOME, "agents");
  }
  return providerAgentsDir();
}

/** Project-level native agents directory (provider-aware) */
export function projectCodexAgentsDir(projectRoot?: string): string {
  return join(projectProviderDir(undefined, projectRoot), "agents");
}

/** User-level skills directory (provider-aware) */
export function userSkillsDir(): string {
  if (process.env.CODEX_HOME) {
    return join(process.env.CODEX_HOME, "skills");
  }
  return providerSkillsDir();
}

/** Project-level skills directory (provider-aware) */
export function projectSkillsDir(projectRoot?: string): string {
  return join(projectProviderDir(undefined, projectRoot), "skills");
}

/** Historical legacy user-level skills directory (~/.agents/skills/) */
export function legacyUserSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

export type InstalledSkillScope = "project" | "user";

export interface InstalledSkillDirectory {
  name: string;
  path: string;
  scope: InstalledSkillScope;
}

export interface SkillRootOverlapReport {
  canonicalDir: string;
  legacyDir: string;
  canonicalExists: boolean;
  legacyExists: boolean;
  canonicalSkillCount: number;
  legacySkillCount: number;
  overlappingSkillNames: string[];
  mismatchedSkillNames: string[];
}

async function readInstalledSkillsFromDir(
  dir: string,
  scope: InstalledSkillScope,
): Promise<InstalledSkillDirectory[]> {
  if (!existsSync(dir)) return [];

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      scope,
    }))
    .filter((entry) => existsSync(join(entry.path, "SKILL.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Installed skill directories in scope-precedence order.
 * Project skills win over user-level skills with the same directory basename.
 */
export async function listInstalledSkillDirectories(
  projectRoot?: string,
): Promise<InstalledSkillDirectory[]> {
  const orderedDirs: Array<{ dir: string; scope: InstalledSkillScope }> = [
    { dir: projectSkillsDir(projectRoot), scope: "project" },
    { dir: userSkillsDir(), scope: "user" },
  ];

  const deduped: InstalledSkillDirectory[] = [];
  const seenNames = new Set<string>();

  for (const { dir, scope } of orderedDirs) {
    const skills = await readInstalledSkillsFromDir(dir, scope);
    for (const skill of skills) {
      if (seenNames.has(skill.name)) continue;
      seenNames.add(skill.name);
      deduped.push(skill);
    }
  }

  return deduped;
}

export async function detectLegacySkillRootOverlap(
  canonicalDir = userSkillsDir(),
  legacyDir = legacyUserSkillsDir(),
): Promise<SkillRootOverlapReport> {
  const [canonicalSkills, legacySkills] = await Promise.all([
    readInstalledSkillsFromDir(canonicalDir, "user"),
    readInstalledSkillsFromDir(legacyDir, "user"),
  ]);

  const canonicalHashes = await hashSkillDirectory(canonicalSkills);
  const legacyHashes = await hashSkillDirectory(legacySkills);
  const canonicalNames = new Set(canonicalSkills.map((skill) => skill.name));
  const legacyNames = new Set(legacySkills.map((skill) => skill.name));
  const overlappingSkillNames = [...canonicalNames]
    .filter((name) => legacyNames.has(name))
    .sort((a, b) => a.localeCompare(b));
  const mismatchedSkillNames = overlappingSkillNames.filter(
    (name) => canonicalHashes.get(name) !== legacyHashes.get(name),
  );

  return {
    canonicalDir,
    legacyDir,
    canonicalExists: existsSync(canonicalDir),
    legacyExists: existsSync(legacyDir),
    canonicalSkillCount: canonicalSkills.length,
    legacySkillCount: legacySkills.length,
    overlappingSkillNames,
    mismatchedSkillNames,
  };
}

async function hashSkillDirectory(
  skills: InstalledSkillDirectory[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const skill of skills) {
    try {
      const content = await readFile(join(skill.path, "SKILL.md"), "utf-8");
      hashes.set(skill.name, createHash("sha256").update(content).digest("hex"));
    } catch {
      // Ignore unreadable SKILL.md files; existence is enough for overlap detection.
    }
  }

  return hashes;
}

/** oh-my-codex state directory (.omx/state/) */
export function omxStateDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "state");
}

/** oh-my-codex project memory file (.omx/project-memory.json) */
export function omxProjectMemoryPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "project-memory.json");
}

/** oh-my-codex notepad file (.omx/notepad.md) */
export function omxNotepadPath(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "notepad.md");
}

/** oh-my-codex plans directory (.omx/plans/) */
export function omxPlansDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "plans");
}

/** oh-my-codex logs directory (.omx/logs/) */
export function omxLogsDir(projectRoot?: string): string {
  return join(projectRoot || process.cwd(), ".omx", "logs");
}

/** Get the package root directory (where agents/, skills/, prompts/ live) */
export function packageRoot(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const candidate = join(__dirname, "..", "..");
    if (existsSync(join(candidate, "package.json"))) {
      return candidate;
    }
    const candidate2 = join(__dirname, "..");
    if (existsSync(join(candidate2, "package.json"))) {
      return candidate2;
    }
  } catch {
    // fall through to cwd fallback
  }
  return process.cwd();
}
