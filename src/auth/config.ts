import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parse as parseToml } from "@iarna/toml";

export type AuthRotationMode = "round-robin" | "priority" | "manual";

export interface AuthConfig {
  rotation: AuthRotationMode;
  priority: string[];
  quotaPatterns: string[];
  sources: string[];
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  rotation: "round-robin",
  priority: [],
  quotaPatterns: [],
  sources: [],
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractAuthTable(parsed: unknown): Record<string, unknown> | undefined {
  const root = asRecord(parsed);
  const omx = asRecord(root?.omx);
  return asRecord(omx?.auth);
}

function parseRotation(value: unknown): AuthRotationMode | undefined {
  if (value === "round-robin" || value === "priority" || value === "manual") return value;
  return undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

export async function readAuthConfig(
  cwd = process.cwd(),
  home = homedir(),
): Promise<AuthConfig> {
  const candidates = [
    join(cwd, ".omx", "config.toml"),
    join(cwd, "omx.toml"),
    join(home, ".omx", "config.toml"),
  ];
  const merged: AuthConfig = { ...DEFAULT_AUTH_CONFIG, sources: [] };
  const seen = { rotation: false, priority: false, quotaPatterns: false };

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let table: Record<string, unknown> | undefined;
    try {
      table = extractAuthTable(parseToml(await readFile(path, "utf-8")));
    } catch {
      continue;
    }
    if (!table) continue;
    merged.sources.push(path);
    if (!seen.rotation) {
      const rotation = parseRotation(table.rotation);
      if (rotation) {
        merged.rotation = rotation;
        seen.rotation = true;
      }
    }
    if (!seen.priority) {
      const priority = parseStringArray(table.priority);
      if (priority) {
        merged.priority = priority;
        seen.priority = true;
      }
    }
    if (!seen.quotaPatterns) {
      const patterns = parseStringArray(table.quota_patterns ?? table.quotaPatterns);
      if (patterns) {
        merged.quotaPatterns = patterns;
        seen.quotaPatterns = true;
      }
    }
  }

  return merged;
}
