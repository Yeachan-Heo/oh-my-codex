import { createReadStream, existsSync } from "fs";
import { readdir, stat } from "fs/promises";
import { createInterface } from "readline";
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
  const stream = createReadStream(path, "utf-8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        payload?: { id?: unknown } | null;
        id?: unknown;
        session_id?: unknown;
        sessionId?: unknown;
      } | null;
      const id = parsed?.type === "session_meta"
        ? parsed.payload?.id
        : parsed?.id ?? parsed?.session_id ?? parsed?.sessionId;
      if (typeof id === "string" && id.trim()) return id.trim();
      break;
    }
  } catch {
    // fall through to basename fallback
  } finally {
    reader.close();
    stream.destroy();
  }
  const uuid = basename(path).match(/-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  if (uuid) return uuid[1]!;
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
