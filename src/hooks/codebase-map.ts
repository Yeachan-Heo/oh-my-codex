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

import { readFile } from 'fs/promises';
import { join, extname, basename } from 'path';
import { execSync } from 'child_process';

/** Max chars for the whole map output. */
const MAX_MAP_CHARS = 1000;

/** Max files listed per directory entry. */
const MAX_FILES_PER_DIR = 10;

/** Max exported symbols extracted per file. */
const MAX_EXPORTS_PER_FILE = 8;

/** Max directories to include. */
const MAX_DIRS = 14;

/** Source extensions whose exports are worth scanning. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs']);

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
    });
    return out
      .trim()
      .split('\n')
      .filter((f) => f && SOURCE_EXTS.has(extname(f)));
  } catch {
    return [];
  }
}

/**
 * Extract exported symbol names from a source file using line-by-line regex.
 * No AST — intentionally fast and approximate.
 */
async function extractExports(absPath: string): Promise<string[]> {
  try {
    const content = await readFile(absPath, 'utf-8');
    const found: string[] = [];
    for (const line of content.split('\n')) {
      if (found.length >= MAX_EXPORTS_PER_FILE) break;
      // export [async] function|class|const|type|interface|enum Name
      const m =
        line.match(/^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/) ||
        line.match(/^export\s+default\s+(?:async\s+)?(?:function|class)\s+(\w+)/);
      if (m) found.push(m[1]);
    }
    return found;
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
    map.get(dir)!.push(f);
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
 * Build a single directory line, optionally with key exports.
 * Format: `  src/hooks/: agents-overlay, codebase-map, session`
 */
function buildDirLine(dir: string, files: string[], exports: Map<string, string[]>): string {
  const names = files
    .slice(0, MAX_FILES_PER_DIR)
    .map((f) => basename(f).replace(/\.(ts|tsx|js|mjs)$/, ''))
    .filter((n, i, arr) => n !== 'index' || arr.length === 1); // keep index only if sole file

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
    const files = getTrackedSourceFiles(cwd);
    if (files.length === 0) return '';

    const grouped = groupByTopDir(files);
    const sortedDirs = sortDirs([...grouped.keys()]);

    // For the src/ directory, break down sub-directories for finer granularity
    const lines: string[] = [];
    const exportMap = new Map<string, string[]>();

    for (const dir of sortedDirs.slice(0, MAX_DIRS)) {
      const dirFiles = grouped.get(dir) ?? [];

      if (dir === 'src') {
        // Sub-group src by its immediate subdirectory
        const subGrouped = new Map<string, string[]>();
        for (const f of dirFiles) {
          const parts = f.split('/');
          const subDir = parts.length >= 3 ? `src/${parts[1]}` : 'src';
          if (!subGrouped.has(subDir)) subGrouped.set(subDir, []);
          subGrouped.get(subDir)!.push(f);
        }
        const sortedSubs = [...subGrouped.keys()].sort((a, b) => a.localeCompare(b));
        for (const sub of sortedSubs.slice(0, MAX_DIRS)) {
          const subFiles = subGrouped.get(sub) ?? [];
          const line = buildDirLine(sub, subFiles, exportMap);
          if (line) lines.push(line);
        }
      } else {
        const line = buildDirLine(dir, dirFiles, exportMap);
        if (line) lines.push(line);
      }
    }

    if (lines.length === 0) return '';

    const body = lines.join('\n');
    return body.length > MAX_MAP_CHARS ? body.slice(0, MAX_MAP_CHARS - 3) + '...' : body;
  } catch {
    return '';
  }
}
