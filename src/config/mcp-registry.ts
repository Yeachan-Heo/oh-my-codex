import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface UnifiedMcpRegistryServer {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  startupTimeoutSec?: number;
}

export interface UnifiedMcpRegistryLoadResult {
  servers: UnifiedMcpRegistryServer[];
  sourcePath?: string;
  warnings: string[];
}

interface LoadUnifiedMcpRegistryOptions {
  candidates?: string[];
  homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimeout(
  value: unknown,
  name: string,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    warnings.push(`registry entry "${name}" has invalid timeout; ignoring timeout`);
    return undefined;
  }
  return Math.floor(value);
}

function normalizeEntry(
  name: string,
  value: unknown,
  warnings: string[],
): UnifiedMcpRegistryServer | null {
  if (!isRecord(value)) {
    warnings.push(`registry entry "${name}" is not an object; skipping`);
    return null;
  }

  const command = value.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    warnings.push(`registry entry "${name}" is missing command; skipping`);
    return null;
  }

  const argsValue = value.args;
  if (
    argsValue !== undefined &&
    (!Array.isArray(argsValue) || argsValue.some((item) => typeof item !== "string"))
  ) {
    warnings.push(`registry entry "${name}" has non-string args; skipping`);
    return null;
  }

  const enabledValue = value.enabled;
  if (enabledValue !== undefined && typeof enabledValue !== "boolean") {
    warnings.push(`registry entry "${name}" has non-boolean enabled; skipping`);
    return null;
  }

  const timeoutCandidate =
    value.timeout ?? value.startup_timeout_sec ?? value.startupTimeoutSec;

  return {
    name,
    command,
    args: (argsValue as string[] | undefined) ?? [],
    enabled: enabledValue ?? true,
    startupTimeoutSec: normalizeTimeout(timeoutCandidate, name, warnings),
  };
}

export function getUnifiedMcpRegistryCandidates(homeDir = homedir()): string[] {
  return [
    join(homeDir, ".omx", "mcp-registry.json"),
    join(homeDir, ".omc", "mcp-registry.json"),
  ];
}

export async function loadUnifiedMcpRegistry(
  options: LoadUnifiedMcpRegistryOptions = {},
): Promise<UnifiedMcpRegistryLoadResult> {
  const candidates =
    options.candidates ?? getUnifiedMcpRegistryCandidates(options.homeDir);
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    return { servers: [], warnings: [] };
  }

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sourcePath, "utf-8"));
  } catch (error) {
    warnings.push(`failed to parse shared MCP registry at ${sourcePath}: ${String(error)}`);
    return { servers: [], sourcePath, warnings };
  }

  if (!isRecord(parsed)) {
    warnings.push(`shared MCP registry at ${sourcePath} must be a JSON object`);
    return { servers: [], sourcePath, warnings };
  }

  const servers: UnifiedMcpRegistryServer[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const normalized = normalizeEntry(name, value, warnings);
    if (!normalized) continue;
    servers.push(normalized);
  }

  return { servers, sourcePath, warnings };
}
