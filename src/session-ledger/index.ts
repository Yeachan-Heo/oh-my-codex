import { createReadStream, existsSync } from "fs";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { createInterface } from "readline";
import { homedir } from "os";
import { basename, dirname, join, relative } from "path";
import { resolveDefaultCodexHome } from "../auth/paths.js";
import { readAuthMetadata } from "../auth/storage.js";
import { detectAuthFileKind } from "../auth/identity.js";
import { redactAuthSecrets } from "../auth/redact.js";

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

export interface BuildUnifiedLedgerOptions {
  home?: string;
  codexHomeDir?: string;
  appSupportDir?: string;
  deep?: boolean;
  now?: Date;
}

export function resolveSessionLedgerPath(home = homedir()): string {
  return join(home, ".omx", "state", "session-ledger.jsonl");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  if (texts.length >= 8) return;
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
  for (const key of ["text", "message", "summary", "content", "output"]) {
    if (key in record) extractText(record[key], texts);
  }
}

async function readDeepRolloutSummary(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, "utf-8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const texts: string[] = [];
  let lines = 0;
  try {
    for await (const line of reader) {
      lines += 1;
      if (lines > 80 || texts.join(" ").length > 2000) break;
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
  return text ? text.slice(0, 600) : undefined;
}

async function collectCliEntries(home: string, codexHomeDir: string, deep = false): Promise<UnifiedSessionEntry[]> {
  const auth = await detectAuthFileKind(join(codexHomeDir, "auth.json"));
  const metadata = await readAuthMetadata(home);
  const currentSlot = metadata.currentSlot;
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
    const source: UnifiedSessionSource = auth.kind === "api" ? "api" : "cli";
    const deepSummary = deep ? await readDeepRolloutSummary(file) : undefined;
    entries.push({
      sessionId,
      source,
      identitySlot: currentSlot,
      authMode: auth.kind,
      cwd,
      createdAt: timestamp,
      updatedAt: fileInfo?.mtime.toISOString(),
      title: cwd ? basename(cwd) : sessionId,
      summary: deepSummary ?? `Codex ${source} session${cwd ? ` in ${cwd}` : ""}`,
      openTarget: file,
      resumeCommand: `codex resume ${sessionId}`,
      codexHome: codexHomeDir,
    });
  }
  return entries;
}

async function readOptionalJsonSummary(dir: string): Promise<{ title?: string; summary?: string }> {
  const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const parsed = asRecord(JSON.parse(await readFile(join(dir, entry.name), "utf-8")));
      const title = asString(parsed?.title) ?? asString(parsed?.name);
      const summary = asString(parsed?.summary) ?? asString(parsed?.description);
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
    const key = `${entry.source}:${entry.sessionId}`;
    const current = byKey.get(key);
    if (!current || String(entry.updatedAt ?? "") > String(current.updatedAt ?? "")) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
}

export async function buildUnifiedLedger(options: BuildUnifiedLedgerOptions = {}): Promise<UnifiedSessionEntry[]> {
  const home = options.home ?? homedir();
  const envCodexHome = process.env.CODEX_HOME?.trim();
  const codexHomeDir = options.codexHomeDir ?? (envCodexHome || resolveDefaultCodexHome(home));
  const appSupportDir = options.appSupportDir ?? join(home, "Library", "Application Support", "com.openai.chat");
  return dedupeEntries([
    ...await collectCliEntries(home, codexHomeDir, options.deep === true),
    ...await collectAppEntries(appSupportDir),
  ]);
}

export async function refreshUnifiedLedger(options: BuildUnifiedLedgerOptions = {}): Promise<UnifiedSessionEntry[]> {
  const home = options.home ?? homedir();
  const shallowEntries = await buildUnifiedLedger({ ...options, deep: false });
  const ledgerPath = resolveSessionLedgerPath(home);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${shallowEntries.map((entry) => JSON.stringify(entry)).join("\n")}${shallowEntries.length ? "\n" : ""}`);
  if (options.deep === true) return await buildUnifiedLedger({ ...options, deep: true });
  return shallowEntries;
}

export function searchUnifiedEntries(entries: UnifiedSessionEntry[], query: string): UnifiedSessionEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) => [
    entry.sessionId,
    entry.source,
    entry.identitySlot,
    entry.authMode,
    entry.cwd,
    entry.title,
    entry.summary,
    entry.openTarget,
    entry.resumeCommand,
    entry.codexHome,
  ].some((value) => typeof value === "string" && value.toLowerCase().includes(needle)));
}

export function findUnifiedEntry(entries: UnifiedSessionEntry[], id: string): UnifiedSessionEntry | null {
  const needle = id.trim();
  if (!needle) return null;
  return entries.find((entry) => entry.sessionId === needle) ??
    entries.find((entry) => entry.sessionId.includes(needle)) ??
    entries.find((entry) => relative("/", entry.openTarget ?? "").includes(needle)) ??
    null;
}
