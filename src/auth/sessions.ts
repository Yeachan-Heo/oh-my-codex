import { existsSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";
import { basename, join } from "path";
import { resolveDefaultCodexHome } from "./paths.js";

export interface LatestRolloutSession {
  id: string;
  path: string;
  mtimeMs: number;
}

async function collectRollouts(dir: string, out: string[]): Promise<void> {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRollouts(path, out);
    } else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) {
      out.push(path);
    }
  }
}

export async function extractRolloutSessionId(path: string): Promise<string> {
  const fileMatch = basename(path).match(/^rollout-(.+)\.jsonl$/);
  if (fileMatch?.[1]) return fileMatch[1];
  const firstLine = (await readFile(path, "utf-8")).split(/\r?\n/, 1)[0] ?? "";
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    const id = parsed.id ?? parsed.session_id ?? parsed.sessionId;
    if (typeof id === "string" && id.trim()) return id.trim();
  } catch {
    // fall through to basename fallback
  }
  return basename(path, ".jsonl").replace(/^rollout-/, "");
}

/**
 * Codex stores resumable conversations as rollout JSONL files under
 * <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl. Hotswap uses the newest
 * rollout by mtime as the best available continuity heuristic after a quota
 * exit, because upstream Codex does not currently expose the active resume id
 * as a stable structured wrapper signal.
 */
export async function findLatestRolloutSession(
  codexHome: string,
  fallbackHome?: string,
): Promise<LatestRolloutSession | null> {
  const roots = [join(codexHome, "sessions")];
  const fallback = fallbackHome ? join(resolveDefaultCodexHome(fallbackHome), "sessions") : undefined;
  if (fallback && fallback !== roots[0]) roots.push(fallback);
  const files: string[] = [];
  for (const root of roots) await collectRollouts(root, files);
  let latest: { path: string; mtimeMs: number } | null = null;
  for (const path of files) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    if (!latest || info.mtimeMs > latest.mtimeMs) latest = { path, mtimeMs: info.mtimeMs };
  }
  if (!latest) return null;
  return { id: await extractRolloutSessionId(latest.path), path: latest.path, mtimeMs: latest.mtimeMs };
}
