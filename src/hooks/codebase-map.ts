/**
 * Codebase Map Generator for oh-my-codex
 *
 * Generates a lightweight snapshot of the project's source structure and
 * key exported symbols, injected into agent context at session start.
 *
 * Goal: eliminate blind exploration by giving agents an upfront map of
 * where things live — without reading full file contents.
 *
 * Design constraints:
 * - Fast: uses `git ls-files` (no filesystem walk), regex export scan
 * - Minimal: groups files by directory, no full source read
 * - Safe: all errors return empty string (never blocks session start)
 */

import { statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { findGitLayout } from '../utils/git-layout.js';
import { omxRoot } from '../utils/paths.js';

/** Max chars for the whole map output. */
const MAX_MAP_CHARS = 1000;

/** Max files listed per directory entry. */
const MAX_FILES_PER_DIR = 10;

/** Max directories to include. */
const MAX_DIRS = 14;

/** Source extensions whose exports are worth scanning. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const CACHE_VERSION = 1;

interface CodebaseMapCacheFile {
  version: number;
  worktreeRoot: string;
  gitDir: string;
  indexMtimeMs: number;
  indexSize: number;
  map: string;
  createdAt: string;
}

function cachePathForWorktree(worktreeRoot: string): string {
  return join(omxRoot(worktreeRoot), 'cache', 'codebase-map.json');
}

function readGitIndexSignature(gitDir: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(join(gitDir, 'index'));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

async function readCachedCodebaseMap(
  worktreeRoot: string,
  gitDir: string,
  indexSignature: { mtimeMs: number; size: number },
): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePathForWorktree(worktreeRoot), 'utf-8')) as Partial<CodebaseMapCacheFile>;
    if (parsed.version !== CACHE_VERSION) return null;
    if (parsed.worktreeRoot !== worktreeRoot) return null;
    if (parsed.gitDir !== gitDir) return null;
    if (parsed.indexMtimeMs !== indexSignature.mtimeMs) return null;
    if (parsed.indexSize !== indexSignature.size) return null;
    return typeof parsed.map === 'string' ? parsed.map : null;
  } catch {
    return null;
  }
}

async function writeCachedCodebaseMap(
  worktreeRoot: string,
  gitDir: string,
  indexSignature: { mtimeMs: number; size: number },
  map: string,
): Promise<void> {
  const targetPath = cachePathForWorktree(worktreeRoot);
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(join(omxRoot(worktreeRoot), 'cache'), { recursive: true });
    const payload: CodebaseMapCacheFile = {
      version: CACHE_VERSION,
      worktreeRoot,
      gitDir,
      indexMtimeMs: indexSignature.mtimeMs,
      indexSize: indexSignature.size,
      map,
      createdAt: new Date().toISOString(),
    };
    await writeFile(tempPath, JSON.stringify(payload, null, 2));
    await rename(tempPath, targetPath);
  } catch {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Return git-tracked source files relative to cwd.
 * Falls back to empty array if git is unavailable or times out.
 */
function getTrackedSourceFiles(cwd: string): string[] {
  try {
    const out = execSync('git ls-files --cached', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
      windowsHide: true,
    });
    return out
      .trim()
      .split('\n')
      .filter((f) => f && !f.split('/').includes('.omx') && SOURCE_EXTS.has(extname(f)));
  } catch {
    return [];
  }
}

/**
 * Group relative file paths by their top-level directory segment.
 * Files at the root level map to key '.'.
 */
function groupByTopDir(files: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const f of files) {
    const sep = f.indexOf('/');
    const dir = sep >= 0 ? f.slice(0, sep) : '.';
    if (!map.has(dir)) map.set(dir, []);
    const arr = map.get(dir);
    if (arr) arr.push(f);
  }
  return map;
}

/**
 * Sort directory entries: src/ and scripts/ first, then alphabetical,
 * dotfiles and root last.
 */
function sortDirs(dirs: string[]): string[] {
  const priority = ['src', 'scripts', 'bin', 'prompts', 'agents', 'skills', 'templates'];
  return dirs.slice().sort((a, b) => {
    const ai = priority.indexOf(a);
    const bi = priority.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    // Dotfiles and root sink to the bottom
    const aIsLow = a.startsWith('.') || a === '.';
    const bIsLow = b.startsWith('.') || b === '.';
    if (aIsLow && !bIsLow) return 1;
    if (!aIsLow && bIsLow) return -1;
    return a.localeCompare(b);
  });
}

/**
 * Build a single directory line.
 * Format: `  src/hooks/: agents-overlay, codebase-map, session`
 */
function buildDirLine(dir: string, files: string[]): string {
  const names = files
    .slice(0, MAX_FILES_PER_DIR)
    .map((f) => basename(f).replace(/\.(ts|tsx|js|mjs)$/, ''))
    .filter((n, _index, arr) => n !== 'index' || arr.length === 1); // keep index only if sole file

  if (names.length === 0) return '';

  const label = dir === '.' ? '(root)' : `${dir}/`;
  return `  ${label}: ${names.join(', ')}`;
}

/**
 * Generate a compact codebase map for the project at `cwd`.
 *
 * Returns an empty string if:
 * - No git-tracked source files exist
 * - Any error occurs (always safe to call)
 */
export async function generateCodebaseMap(cwd: string): Promise<string> {
  try {
    const layout = findGitLayout(cwd);
    const indexSignature = layout ? readGitIndexSignature(layout.gitDir) : null;
    if (layout && indexSignature) {
      const cached = await readCachedCodebaseMap(layout.worktreeRoot, layout.gitDir, indexSignature);
      if (cached !== null) return cached;
    }

    const files = getTrackedSourceFiles(cwd);
    if (files.length === 0) {
      if (layout && indexSignature) {
        await writeCachedCodebaseMap(layout.worktreeRoot, layout.gitDir, indexSignature, '');
      }
      return '';
    }

    const grouped = groupByTopDir(files);
    const sortedDirs = sortDirs([...grouped.keys()]);

    // For the src/ directory, break down sub-directories for finer granularity
    const lines: string[] = [];
    for (const dir of sortedDirs.slice(0, MAX_DIRS)) {
      const dirFiles = grouped.get(dir) ?? [];

      if (dir === 'src') {
        // Sub-group src by its immediate subdirectory
        const subGrouped = new Map<string, string[]>();
        for (const f of dirFiles) {
          const parts = f.split('/');
          const subDir = parts.length >= 3 ? `src/${parts[1]}` : 'src';
          if (!subGrouped.has(subDir)) subGrouped.set(subDir, []);
          const arr = subGrouped.get(subDir);
          if (arr) arr.push(f);
        }
        const sortedSubs = [...subGrouped.keys()].sort((a, b) => a.localeCompare(b));
        for (const sub of sortedSubs.slice(0, MAX_DIRS)) {
          const subFiles = subGrouped.get(sub) ?? [];
          const line = buildDirLine(sub, subFiles);
          if (line) lines.push(line);
        }
      } else {
        const line = buildDirLine(dir, dirFiles);
        if (line) lines.push(line);
      }
    }

    if (lines.length === 0) {
      if (layout && indexSignature) {
        await writeCachedCodebaseMap(layout.worktreeRoot, layout.gitDir, indexSignature, '');
      }
      return '';
    }

    const body = lines.join('\n');
    const map = body.length <= MAX_MAP_CHARS
      ? body
      : body.slice(0, MAX_MAP_CHARS - 3) + '...';
    if (layout && indexSignature) {
      await writeCachedCodebaseMap(layout.worktreeRoot, layout.gitDir, indexSignature, map);
    }
    return map;
  } catch {
    return '';
  }
}
