import { createReadStream, existsSync } from "fs";
import { readdir, readFile, realpath, stat } from "fs/promises";
import { createInterface } from "readline";
import { homedir } from "os";
import { basename, join, relative, resolve } from "path";
import { resolveDefaultCodexHome } from "../auth/paths.js";
import { redactAuthSecrets } from "../auth/redact.js";
import { atomicWriteFile } from "../auth/storage.js";
import { resolveCodexHomeForLaunch } from "../cli/codex-home.js";
import { discoverProjectRuntimeCodexHomes } from "../cli/project-runtime-codex-homes.js";

export type UnifiedSessionSource = "cli" | "app" | "omx" | "api";

export interface UnifiedSessionEntry {
  sessionId: string;
  source: UnifiedSessionSource;
  identitySlot?: string;
  authMode?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  summary?: string;
  openTarget?: string;
  resumeCommand?: string;
  codexHome?: string;
}

export interface UnifiedSessionIdentityMetadata {
  version: 1;
  sessionId: string;
  identitySlot?: string;
  authMode?: string;
  createdAt: string;
}

const unifiedEntryCodexHomePath = Symbol("unifiedEntryCodexHomePath");
const unifiedEntrySearchText = Symbol("unifiedEntrySearchText");

type UnifiedSessionEntryWithCodexHomePath = UnifiedSessionEntry & {
  [unifiedEntryCodexHomePath]?: string;
  [unifiedEntrySearchText]?: string;
};

interface ResolvedUnifiedLedgerCodexHome {
  dir: string;
  publicLabel: string;
}

export interface BuildUnifiedLedgerOptions {
  home?: string;
  codexHomeDir?: string;
  codexHomeDirs?: string[];
  appSupportDir?: string;
  cwd?: string;
  deep?: boolean;
  now?: Date;
}

export function resolveSessionLedgerPath(home = homedir()): string {
  return join(home, ".omx", "state", "session-ledger.jsonl");
}

function safeSessionIdentityFileName(sessionId: string): string {
  const safe = sessionId.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "unknown";
}

export function resolveUnifiedSessionIdentityPath(codexHomeDir: string, sessionId: string): string {
  return join(resolve(codexHomeDir), ".omx", "session-identity", `${safeSessionIdentityFileName(sessionId)}.json`);
}

export async function writeUnifiedSessionIdentity(
  codexHomeDir: string,
  metadata: UnifiedSessionIdentityMetadata,
): Promise<void> {
  const payload: UnifiedSessionIdentityMetadata = {
    version: 1,
    sessionId: metadata.sessionId,
    ...(metadata.identitySlot ? { identitySlot: metadata.identitySlot } : {}),
    ...(metadata.authMode ? { authMode: metadata.authMode } : {}),
    createdAt: metadata.createdAt,
  };
  await atomicWriteFile(resolveUnifiedSessionIdentityPath(codexHomeDir, metadata.sessionId), `${JSON.stringify(payload, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readUnifiedSessionIdentity(codexHomeDir: string, sessionId: string): Promise<UnifiedSessionIdentityMetadata | null> {
  try {
    const parsed = asRecord(JSON.parse(await readFile(resolveUnifiedSessionIdentityPath(codexHomeDir, sessionId), "utf-8")));
    if (!parsed || parsed.version !== 1) return null;
    const parsedSessionId = asString(parsed.sessionId);
    if (parsedSessionId && parsedSessionId !== sessionId) return null;
    return {
      version: 1,
      sessionId,
      identitySlot: asString(parsed.identitySlot),
      authMode: asString(parsed.authMode),
      createdAt: asString(parsed.createdAt) ?? "",
    };
  } catch {
    return null;
  }
}

export async function copyUnifiedSessionIdentity(
  codexHomeDir: string,
  sourceSessionId: string,
  targetSessionId: string,
): Promise<boolean> {
  const sourceId = sourceSessionId.trim();
  const targetId = targetSessionId.trim();
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const metadata = await readUnifiedSessionIdentity(codexHomeDir, sourceId);
  if (!metadata) return false;
  if (await readUnifiedSessionIdentity(codexHomeDir, targetId)) return false;
  await writeUnifiedSessionIdentity(codexHomeDir, {
    ...metadata,
    sessionId: targetId,
  });
  return true;
}

function redactOptionalText(value: string | undefined): string | undefined {
  return value ? redactAuthSecrets(value) : undefined;
}

function sourceFromRolloutAuthMode(authMode: string | undefined): UnifiedSessionSource {
  const normalized = authMode?.toLowerCase();
  return normalized === "api" || normalized === "apikey" ? "api" : "cli";
}

function attachUnifiedEntryCodexHomePath(entry: UnifiedSessionEntry, codexHomePath: string): UnifiedSessionEntry {
  Object.defineProperty(entry, unifiedEntryCodexHomePath, {
    value: codexHomePath,
    enumerable: false,
    configurable: false,
  });
  return entry;
}

function attachUnifiedEntrySearchText(entry: UnifiedSessionEntry, searchText: string | undefined): UnifiedSessionEntry {
  if (!searchText) return entry;
  Object.defineProperty(entry, unifiedEntrySearchText, {
    value: searchText,
    enumerable: false,
    configurable: false,
  });
  return entry;
}

export function getUnifiedEntryCodexHomePath(entry: UnifiedSessionEntry): string | undefined {
  const codexHomePath = (entry as UnifiedSessionEntryWithCodexHomePath)[unifiedEntryCodexHomePath] ?? entry.codexHome;
  return codexHomePath?.startsWith("madmax:") ? undefined : codexHomePath;
}

function getUnifiedEntrySearchText(entry: UnifiedSessionEntry): string | undefined {
  return (entry as UnifiedSessionEntryWithCodexHomePath)[unifiedEntrySearchText];
}

async function listRolloutFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    if (!dir) continue;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

async function readFirstJsonLine(filePath: string): Promise<Record<string, unknown> | null> {
  const stream = createReadStream(filePath, "utf-8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      try {
        const parsed = JSON.parse(line) as unknown;
        return asRecord(parsed);
      } catch {
        return null;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return null;
}

function extractText(value: unknown, texts: string[]): void {
  if (typeof value === "string") {
    const text = value.trim();
    if (text) texts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractText(item, texts);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const key of ["text", "message", "summary", "content", "output", "item", "items"]) {
    if (key in record) extractText(record[key], texts);
  }
  if ("arguments" in record) {
    const value = record.arguments;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) texts.push(text);
    } else if (value && typeof value === "object") {
      texts.push(JSON.stringify(value));
    }
  }
}

async function readDeepRolloutText(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, "utf-8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const texts: string[] = [];
  try {
    for await (const line of reader) {
      try {
        const parsed = asRecord(JSON.parse(line) as unknown);
        const payload = asRecord(parsed?.payload);
        if (!payload) continue;
        extractText(payload, texts);
      } catch {
        // Deep reads are best-effort only.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const text = redactAuthSecrets(texts.join(" ").replace(/\s+/g, " ").trim());
  return text || undefined;
}

async function collectCliEntries(codexHomeSource: ResolvedUnifiedLedgerCodexHome, deep = false): Promise<UnifiedSessionEntry[]> {
  const codexHomeDir = codexHomeSource.dir;
  const files = await listRolloutFiles(join(codexHomeDir, "sessions"));
  const entries: UnifiedSessionEntry[] = [];
  for (const file of files) {
    const first = await readFirstJsonLine(file);
    const payload = asRecord(first?.payload);
    const fileInfo = await stat(file).catch(() => null);
    const sessionId =
      asString(payload?.id) ??
      basename(file, ".jsonl").replace(/^rollout-/, "");
    const cwd = asString(payload?.cwd);
    const timestamp = asString(payload?.timestamp);
    const sidecarIdentity = await readUnifiedSessionIdentity(codexHomeDir, sessionId);
    const identitySlot =
      asString(payload?.identitySlot) ??
      asString(payload?.identity_slot) ??
      asString(payload?.authSlot) ??
      asString(payload?.auth_slot) ??
      asString(payload?.omxAuthSlot) ??
      asString(payload?.omx_auth_slot) ??
      sidecarIdentity?.identitySlot;
    const authMode =
      asString(payload?.authMode) ??
      asString(payload?.auth_mode) ??
      asString(payload?.omxAuthMode) ??
      asString(payload?.omx_auth_mode) ??
      sidecarIdentity?.authMode;
    const source = sourceFromRolloutAuthMode(authMode);
    const deepText = deep ? await readDeepRolloutText(file) : undefined;
    const entry: UnifiedSessionEntry = {
      sessionId,
      source,
      identitySlot,
      authMode,
      cwd,
      createdAt: timestamp,
      updatedAt: fileInfo?.mtime.toISOString(),
      title: cwd ? basename(cwd) : sessionId,
      summary: deepText ? deepText.slice(0, 600) : `Codex ${source} session${cwd ? ` in ${cwd}` : ""}`,
      openTarget: join(codexHomeSource.publicLabel, relative(codexHomeDir, file)),
      resumeCommand: `codex resume ${sessionId}`,
      codexHome: codexHomeSource.publicLabel,
    };
    attachUnifiedEntrySearchText(entry, deepText);
    entries.push(attachUnifiedEntryCodexHomePath(entry, codexHomeDir));
  }
  return entries;
}

async function readOptionalJsonSummary(dir: string): Promise<{ title?: string; summary?: string }> {
  const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = asRecord(JSON.parse(await readFile(join(dir, entry.name), "utf-8")));
      const title = redactOptionalText(asString(parsed?.title) ?? asString(parsed?.name));
      const summary = redactOptionalText(asString(parsed?.summary) ?? asString(parsed?.description));
      if (title || summary) return { title, summary };
    } catch {
      // App cache files are best-effort only.
    }
  }
  return {};
}

async function collectAppEntries(appSupportDir: string): Promise<UnifiedSessionEntry[]> {
  if (!existsSync(appSupportDir)) return [];
  const entries: UnifiedSessionEntry[] = [];
  const dirs = await readdir(appSupportDir, { withFileTypes: true }).catch(() => []);
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    if (!/^codex-(?:taskItems|taskDetails|environments)-/.test(entry.name)) continue;
    const path = join(appSupportDir, entry.name);
    const info = await stat(path).catch(() => null);
    const summary = await readOptionalJsonSummary(path);
    entries.push({
      sessionId: entry.name,
      source: "app",
      authMode: "chatgpt",
      createdAt: info?.birthtime.toISOString(),
      updatedAt: info?.mtime.toISOString(),
      title: summary.title ?? entry.name,
      summary: summary.summary ?? "Codex App/ChatGPT cached task metadata (read-only)",
      openTarget: path,
    });
  }
  return entries;
}

function dedupeEntries(entries: UnifiedSessionEntry[]): UnifiedSessionEntry[] {
  const byKey = new Map<string, UnifiedSessionEntry>();
  for (const entry of entries) {
    const key = `${entry.source}:${getUnifiedEntryCodexHomePath(entry) ?? ""}:${entry.sessionId}`;
    const current = byKey.get(key);
    if (!current || String(entry.updatedAt ?? "") > String(current.updatedAt ?? "")) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
}

async function normalizeExistingCodexHomeDirs(candidates: Array<string | ResolvedUnifiedLedgerCodexHome>): Promise<ResolvedUnifiedLedgerCodexHome[]> {
  const seen = new Set<string>();
  const dirs: ResolvedUnifiedLedgerCodexHome[] = [];
  for (const candidate of candidates) {
    const rawDir = typeof candidate === "string" ? candidate : candidate.dir;
    const trimmed = rawDir.trim();
    if (!trimmed) continue;
    const absolute = resolve(trimmed);
    if (!existsSync(absolute)) continue;
    const key = await realpath(absolute).catch(() => absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push({
      dir: absolute,
      publicLabel: typeof candidate === "string" ? absolute : candidate.publicLabel,
    });
  }
  return dirs;
}

async function resolveUnifiedLedgerCodexHomeDirs(options: BuildUnifiedLedgerOptions, home: string): Promise<ResolvedUnifiedLedgerCodexHome[]> {
  if (options.codexHomeDirs && options.codexHomeDirs.length > 0) {
    return normalizeExistingCodexHomeDirs(options.codexHomeDirs);
  }
  if (options.codexHomeDir) {
    return normalizeExistingCodexHomeDirs([options.codexHomeDir]);
  }
  const envCodexHome = process.env.CODEX_HOME?.trim();
  const cwd = options.cwd ?? process.cwd();
  const primaryCodexHome = envCodexHome || resolveCodexHomeForLaunch(cwd, process.env) || resolveDefaultCodexHome(home);
  const runtimeHomes = await discoverProjectRuntimeCodexHomes(cwd);
  return normalizeExistingCodexHomeDirs([
    primaryCodexHome,
    ...runtimeHomes.map((runtimeHome) => ({
      dir: runtimeHome.path,
      publicLabel: runtimeHome.source === "madmax-run"
        ? runtimeHome.publicLabel ?? "madmax:runtime-codex-home"
        : runtimeHome.path,
    })),
  ]);
}

export async function buildUnifiedLedger(options: BuildUnifiedLedgerOptions = {}): Promise<UnifiedSessionEntry[]> {
  const home = options.home ?? homedir();
  const codexHomeDirs = await resolveUnifiedLedgerCodexHomeDirs(options, home);
  const appSupportDir = options.appSupportDir ?? join(home, "Library", "Application Support", "com.openai.chat");
  const cliEntries: UnifiedSessionEntry[] = [];
  for (const codexHomeDir of codexHomeDirs) {
    cliEntries.push(...await collectCliEntries(codexHomeDir, options.deep === true));
  }
  return dedupeEntries([
    ...cliEntries,
    ...await collectAppEntries(appSupportDir),
  ]);
}

export async function refreshUnifiedLedger(options: BuildUnifiedLedgerOptions = {}): Promise<UnifiedSessionEntry[]> {
  const home = options.home ?? homedir();
  const shallowEntries = await buildUnifiedLedger({ ...options, deep: false });
  const ledgerPath = resolveSessionLedgerPath(home);
  await atomicWriteFile(ledgerPath, `${shallowEntries.map((entry) => JSON.stringify(entry)).join("\n")}${shallowEntries.length ? "\n" : ""}`);
  if (options.deep === true) return await buildUnifiedLedger({ ...options, deep: true });
  return shallowEntries;
}

export function searchUnifiedEntries(
  entries: UnifiedSessionEntry[],
  query: string,
  options: { caseSensitive?: boolean } = {},
): UnifiedSessionEntry[] {
  const needle = options.caseSensitive ? query.trim() : query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => [
    entry.sessionId,
    entry.source,
    entry.identitySlot,
    entry.authMode,
    entry.cwd,
    entry.title,
    entry.summary,
    getUnifiedEntrySearchText(entry),
    entry.openTarget,
    entry.resumeCommand,
    entry.codexHome,
  ].some((value) => {
    if (typeof value !== "string") return false;
    return options.caseSensitive ? value.includes(needle) : value.toLowerCase().includes(needle);
  }));
}

export function findUnifiedEntry(entries: UnifiedSessionEntry[], id: string): UnifiedSessionEntry | null {
  const needle = id.trim();
  if (!needle) return null;
  return entries.find((entry) => entry.sessionId === needle) ??
    entries.find((entry) => entry.sessionId.includes(needle)) ??
    entries.find((entry) => relative("/", entry.openTarget ?? "").includes(needle)) ??
    null;
}
