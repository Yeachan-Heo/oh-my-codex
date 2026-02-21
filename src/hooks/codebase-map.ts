/**
 * Codebase Map Generator for oh-my-codex
 *
 * Generates a lightweight codebase structure map at session start
 * to reduce agent exploration token waste. Extracts file tree and
 * top-level symbols (exports, classes, functions) for quick orientation.
 *
 * Ref: https://github.com/Yeachan-Heo/oh-my-codex/issues/136
 */

import { readFile, readdir } from 'fs/promises';
import { join, relative, extname } from 'path';
import { existsSync } from 'fs';

export const CODEBASE_MAP_START = '<!-- OMX:CODEBASE_MAP:START -->';
export const CODEBASE_MAP_END = '<!-- OMX:CODEBASE_MAP:END -->';

const DEFAULT_MAX_CHARS = 1500;
const MAX_DEPTH = 3;
const MAX_FILES = 80;
const MAX_SYMBOLS_PER_FILE = 5;

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.omx', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.tox', 'target', '.svelte-kit',
  'coverage', '.nyc_output', '.cache', '.turbo', '.parcel-cache',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.cs', '.rb',
]);

// Top-level symbol patterns (export-level only, not methods/properties)
const TOP_LEVEL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // TypeScript/JavaScript
  { kind: 'fn', re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
  { kind: 'class', re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m },
  { kind: 'iface', re: /^(?:export\s+)?interface\s+(\w+)/m },
  { kind: 'type', re: /^(?:export\s+)?type\s+(\w+)\s*=/m },
  { kind: 'const', re: /^(?:export\s+)?const\s+(\w+)\s*[=:]/m },
  // Python
  { kind: 'def', re: /^(?:async\s+)?def\s+(\w+)/m },
  { kind: 'class', re: /^class\s+(\w+)/m },
  // Go
  { kind: 'func', re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m },
  { kind: 'type', re: /^type\s+(\w+)\s+(?:struct|interface)/m },
  // Rust
  { kind: 'fn', re: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
  { kind: 'struct', re: /^(?:pub\s+)?struct\s+(\w+)/m },
];

interface FileSymbols {
  path: string;
  symbols: string[];
}

/**
 * Extract top-level symbols from source file content.
 */
export function extractTopSymbols(content: string, max: number = MAX_SYMBOLS_PER_FILE): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const line of content.split('\n')) {
    if (symbols.length >= max) break;
    for (const { kind, re } of TOP_LEVEL_PATTERNS) {
      const m = line.match(re);
      if (m?.[1] && !seen.has(m[1])) {
        seen.add(m[1]);
        symbols.push(`${kind} ${m[1]}`);
        break;
      }
    }
  }

  return symbols;
}

/**
 * Detect entry points from package.json or common file patterns.
 */
async function detectEntryPoints(cwd: string): Promise<string[]> {
  const entries: string[] = [];

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      if (pkg.main) entries.push(pkg.main);
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') entries.push(pkg.bin);
        else if (typeof pkg.bin === 'object') {
          entries.push(...(Object.values(pkg.bin) as string[]));
        }
      }
    } catch { /* skip malformed */ }
  }

  const candidates = [
    'src/index.ts', 'src/main.ts', 'index.ts', 'main.py', 'main.go', 'src/lib.rs',
  ];
  for (const c of candidates) {
    if (existsSync(join(cwd, c)) && !entries.includes(c)) {
      entries.push(c);
    }
  }

  return entries.slice(0, 5);
}

/**
 * Recursively walk a directory and extract top-level symbols from source files.
 */
async function walkAndExtract(
  cwd: string,
  dir: string,
  depth: number,
  result: FileSymbols[],
): Promise<void> {
  if (depth > MAX_DEPTH || result.length >= MAX_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const dirs = entries
    .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries
    .filter(e => e.isFile() && CODE_EXTENSIONS.has(extname(e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const file of files) {
    if (result.length >= MAX_FILES) break;
    const fullPath = join(dir, file.name);
    const relPath = relative(cwd, fullPath);
    try {
      const content = await readFile(fullPath, 'utf-8');
      const symbols = extractTopSymbols(content);
      result.push({ path: relPath, symbols });
    } catch { /* skip unreadable */ }
  }

  for (const d of dirs) {
    if (result.length >= MAX_FILES) break;
    await walkAndExtract(cwd, join(dir, d.name), depth + 1, result);
  }
}

/**
 * Format file symbols into a compact directory-grouped map.
 */
function formatMap(files: FileSymbols[], entryPoints: string[], maxChars: number): string {
  const parts: string[] = [];

  if (entryPoints.length > 0) {
    parts.push(`Entry: ${entryPoints.join(', ')}`);
  }

  // Group by directory
  const byDir = new Map<string, FileSymbols[]>();
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(f);
  }

  for (const [dir, dirFiles] of byDir) {
    const lines: string[] = [];
    for (const f of dirFiles) {
      const name = f.path.includes('/') ? f.path.slice(f.path.lastIndexOf('/') + 1) : f.path;
      lines.push(f.symbols.length > 0 ? `  ${name}: ${f.symbols.join(', ')}` : `  ${name}`);
    }
    parts.push(`${dir}/\n${lines.join('\n')}`);
  }

  let result = parts.join('\n');
  if (result.length > maxChars) {
    result = result.slice(0, maxChars - 3) + '...';
  }

  return result;
}

/**
 * Resolve the source root directory for symbol extraction.
 * Prefers common source directories (src/, lib/, app/) over project root.
 */
function resolveSourceRoot(cwd: string): string {
  for (const candidate of ['src', 'lib', 'app', 'pkg', 'cmd']) {
    if (existsSync(join(cwd, candidate))) {
      return join(cwd, candidate);
    }
  }
  return cwd;
}

/**
 * Generate a lightweight codebase structure map.
 *
 * Returns a marker-bounded block ready for injection into session AGENTS.md,
 * or empty string if disabled or no source files found.
 *
 * Opt out: set OMX_CODEBASE_MAP=0
 */
export async function generateCodebaseMap(
  cwd: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): Promise<string> {
  if (process.env.OMX_CODEBASE_MAP === '0') return '';

  const [entryPoints, files] = await Promise.all([
    detectEntryPoints(cwd),
    (async () => {
      const result: FileSymbols[] = [];
      await walkAndExtract(cwd, resolveSourceRoot(cwd), 0, result);
      return result;
    })(),
  ]);

  if (files.length === 0) return '';

  // Reserve space for markers + XML tags
  const markerOverhead = CODEBASE_MAP_START.length + CODEBASE_MAP_END.length + 40;
  const body = formatMap(files, entryPoints, maxChars - markerOverhead);

  return `${CODEBASE_MAP_START}\n<codebase_map>\n${body}\n</codebase_map>\n${CODEBASE_MAP_END}`;
}
