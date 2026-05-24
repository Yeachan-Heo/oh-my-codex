import { randomBytes } from "crypto";
import { dirname } from "path";
import { readFile, rename, rm, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import {
  AUTH_FILE_MODE,
  assertNoSymlink,
  assertReadableFile,
  ensurePrivateDir,
  resolveAuthMetadataPath,
  resolveOmxAuthDir,
  resolveSlotPath,
  validateSlotName,
} from "./paths.js";

export interface AuthSlotRecord {
  slot: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  lastQuotaAt?: string;
  exhaustedAt?: string;
}

export interface AuthMetadata {
  version: 1;
  currentSlot?: string;
  slots: AuthSlotRecord[];
}

export interface AtomicWriteOptions {
  mode?: number;
  beforeRename?: (tempPath: string) => void | Promise<void>;
}

export async function atomicWriteFile(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = dirname(targetPath);
  await ensurePrivateDir(dir);
  await assertNoSymlink(targetPath, "auth target");
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tempPath, data, { mode: options.mode ?? AUTH_FILE_MODE });
    if (process.platform !== "win32") await chmod(tempPath, options.mode ?? AUTH_FILE_MODE).catch(() => undefined);
    await options.beforeRename?.(tempPath);
    await rename(tempPath, targetPath);
    if (process.platform !== "win32") await chmod(targetPath, options.mode ?? AUTH_FILE_MODE).catch(() => undefined);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function emptyMetadata(): AuthMetadata {
  return { version: 1, slots: [] };
}

export async function readAuthMetadata(home?: string): Promise<AuthMetadata> {
  const path = resolveAuthMetadataPath(home);
  if (!existsSync(path)) return emptyMetadata();
  const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<AuthMetadata>;
  return {
    version: 1,
    currentSlot: typeof parsed.currentSlot === "string" ? parsed.currentSlot : undefined,
    slots: Array.isArray(parsed.slots)
      ? parsed.slots
          .filter((slot): slot is AuthSlotRecord => Boolean(slot && typeof slot.slot === "string"))
          .map((slot) => ({ ...slot, slot: validateSlotName(slot.slot) }))
      : [],
  };
}

export async function writeAuthMetadata(metadata: AuthMetadata, home?: string): Promise<void> {
  const authDir = resolveOmxAuthDir(home);
  await ensurePrivateDir(authDir);
  await atomicWriteFile(resolveAuthMetadataPath(home), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: AUTH_FILE_MODE,
  });
}

function upsertSlotRecord(metadata: AuthMetadata, slot: string, nowIso: string): AuthSlotRecord {
  const safeSlot = validateSlotName(slot);
  const existing = metadata.slots.find((record) => record.slot === safeSlot);
  if (existing) {
    existing.updatedAt = nowIso;
    return existing;
  }
  const record: AuthSlotRecord = { slot: safeSlot, createdAt: nowIso, updatedAt: nowIso };
  metadata.slots.push(record);
  metadata.slots.sort((a, b) => a.slot.localeCompare(b.slot));
  return record;
}

export async function addSlotFromAuthFile(
  slot: string,
  liveAuthPath: string,
  home?: string,
  now = new Date(),
): Promise<AuthSlotRecord> {
  const safeSlot = validateSlotName(slot);
  await assertReadableFile(liveAuthPath, "live Codex auth.json");
  await ensurePrivateDir(resolveOmxAuthDir(home));
  const data = await readFile(liveAuthPath);
  const target = resolveSlotPath(safeSlot, home);
  await atomicWriteFile(target, data, { mode: AUTH_FILE_MODE });
  const metadata = await readAuthMetadata(home);
  const record = upsertSlotRecord(metadata, safeSlot, now.toISOString());
  await writeAuthMetadata(metadata, home);
  return record;
}

export async function listSlots(home?: string): Promise<AuthSlotRecord[]> {
  const metadata = await readAuthMetadata(home);
  return metadata.slots.filter((slot) => existsSync(resolveSlotPath(slot.slot, home)));
}

export async function useSlot(
  slot: string,
  liveAuthPath: string,
  home?: string,
  now = new Date(),
): Promise<AuthSlotRecord> {
  const safeSlot = validateSlotName(slot);
  const slotPath = resolveSlotPath(safeSlot, home);
  await assertReadableFile(slotPath, `auth slot ${safeSlot}`);
  await ensurePrivateDir(dirname(liveAuthPath));
  await assertNoSymlink(liveAuthPath, "live Codex auth.json");
  const data = await readFile(slotPath);
  await atomicWriteFile(liveAuthPath, data, { mode: AUTH_FILE_MODE });
  const metadata = await readAuthMetadata(home);
  const record = upsertSlotRecord(metadata, safeSlot, now.toISOString());
  record.lastUsedAt = now.toISOString();
  delete record.exhaustedAt;
  metadata.currentSlot = safeSlot;
  await writeAuthMetadata(metadata, home);
  return record;
}

export async function markSlotQuota(
  slot: string,
  home?: string,
  now = new Date(),
): Promise<AuthMetadata> {
  const safeSlot = validateSlotName(slot);
  const metadata = await readAuthMetadata(home);
  const record = upsertSlotRecord(metadata, safeSlot, now.toISOString());
  record.lastQuotaAt = now.toISOString();
  record.exhaustedAt = now.toISOString();
  await writeAuthMetadata(metadata, home);
  return metadata;
}

export async function clearSlotExhaustion(slot: string, home?: string): Promise<void> {
  const metadata = await readAuthMetadata(home);
  const record = metadata.slots.find((entry) => entry.slot === validateSlotName(slot));
  if (record) {
    delete record.exhaustedAt;
    await writeAuthMetadata(metadata, home);
  }
}
