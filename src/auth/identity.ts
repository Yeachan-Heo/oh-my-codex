import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname } from "path";
import { homedir } from "os";
import { resolveLiveAuthPath, resolveSlotPath } from "./paths.js";
import { listSlots, readAuthMetadata, useSlot, type AuthSlotRecord } from "./storage.js";

export type IdentityKind = "chatgpt" | "api" | "unknown" | "missing" | "invalid";

export interface IdentityStatus {
  authPath: string;
  codexHome: string;
  kind: IdentityKind;
  authMode?: string;
  currentSlot?: string;
  matchedSlot?: string;
  slots: AuthSlotRecord[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function detectAuthKindFromJson(parsed: unknown): { kind: IdentityKind; authMode?: string } {
  const record = asRecord(parsed);
  if (!record) return { kind: "invalid" };
  const authMode = typeof record.auth_mode === "string" ? record.auth_mode : undefined;
  if (authMode === "apikey" || typeof record.OPENAI_API_KEY === "string") {
    return { kind: "api", authMode };
  }
  if (
    authMode === "chatgpt" ||
    typeof record.access_token === "string" ||
    typeof record.refresh_token === "string" ||
    asRecord(record.tokens) ||
    asRecord(record.chatgpt)
  ) {
    return { kind: "chatgpt", authMode };
  }
  return { kind: "unknown", authMode };
}

export async function detectAuthFileKind(authPath: string): Promise<{ kind: IdentityKind; authMode?: string }> {
  if (!existsSync(authPath)) return { kind: "missing" };
  try {
    return detectAuthKindFromJson(JSON.parse(await readFile(authPath, "utf-8")));
  } catch {
    return { kind: "invalid" };
  }
}

async function matchLiveAuthSlot(authPath: string, slots: AuthSlotRecord[], home: string): Promise<string | undefined> {
  let live: Buffer;
  try {
    live = await readFile(authPath);
  } catch {
    return undefined;
  }
  for (const slot of slots) {
    try {
      const candidate = await readFile(resolveSlotPath(slot.slot, home));
      if (Buffer.compare(live, candidate) === 0) return slot.slot;
    } catch {
      // Missing or unreadable slots should not break doctor output.
    }
  }
  return undefined;
}

export async function readIdentityStatus(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<IdentityStatus> {
  const authPath = resolveLiveAuthPath(cwd, env, home);
  const codexHome = dirname(authPath);
  const detected = await detectAuthFileKind(authPath);
  const metadata = await readAuthMetadata(home);
  const slots = await listSlots(home);
  const matchedSlot = await matchLiveAuthSlot(authPath, slots, home);
  const warnings: string[] = [];
  if (detected.kind === "api") {
    warnings.push("Current CLI/OMX credentials use an API key; ChatGPT workspace/cloud features may not share this session.");
  }
  if (detected.kind === "missing") {
    warnings.push("No active Codex auth cache was found for this CODEX_HOME.");
  }
  if (slots.some((slot) => slot.kind === "api") && slots.some((slot) => slot.kind === "chatgpt")) {
    warnings.push("Both ChatGPT and API auth slots are configured; unified session commands will preserve source identity.");
  }
  if (metadata.currentSlot && matchedSlot && metadata.currentSlot !== matchedSlot) {
    warnings.push(`Live auth.json matches slot "${matchedSlot}", but slots.json currentSlot is "${metadata.currentSlot}".`);
  }
  if (metadata.currentSlot && !matchedSlot && slots.length > 0 && detected.kind !== "missing") {
    warnings.push("Live auth.json does not match any registered slot; run `omx auth add <slot>` or `omx identity use <slot>` to make routing explicit.");
  }
  const primaryCount = slots.filter((slot) => slot.isPrimary).length;
  if (primaryCount > 1) warnings.push("Multiple auth slots are marked primary; prefer a single ChatGPT main slot.");
  return {
    authPath,
    codexHome,
    kind: detected.kind,
    authMode: detected.authMode,
    currentSlot: metadata.currentSlot,
    matchedSlot,
    slots,
    warnings,
  };
}

export async function switchIdentitySlot(
  slot: string,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AuthSlotRecord> {
  return await switchIdentitySlotToAuthPath(slot, resolveLiveAuthPath(cwd, env, home), home);
}

export async function switchIdentitySlotToAuthPath(
  slot: string,
  liveAuthPath: string,
  home = homedir(),
): Promise<AuthSlotRecord> {
  return await useSlot(slot, liveAuthPath, home);
}
