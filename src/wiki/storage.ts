/**
 * Wiki Storage
 *
 * File I/O layer for the OMX wiki knowledge base.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { omxWikiDir } from '../utils/paths.js';
import {
  type WikiLogEntry,
  type WikiPage,
  type WikiPageFrontmatter,
  WIKI_SCHEMA_VERSION,
} from './types.js';

const INDEX_FILE = 'index.md';
const LOG_FILE = 'log.md';
const ENVIRONMENT_FILE = 'environment.md';
const RESERVED_FILES = new Set([INDEX_FILE, LOG_FILE, ENVIRONMENT_FILE]);

function atomicWriteFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, path);
}

function lockPathFor(path: string): string {
  return `${path}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLockSync<T>(
  lockPath: string,
  fn: () => T,
  options: { timeoutMs?: number; retryDelayMs?: number } = {},
): T {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring wiki lock at ${lockPath}`);
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export function getWikiDir(root: string): string {
  return omxWikiDir(root);
}

export function ensureWikiDir(root: string): string {
  const wikiDir = getWikiDir(root);
  mkdirSync(wikiDir, { recursive: true });
  const omxRoot = join(root, '.omx');
  mkdirSync(omxRoot, { recursive: true });
  const gitignorePath = join(omxRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf8');
    if (!content.includes('wiki/')) {
      atomicWriteFileSync(gitignorePath, `${content.trimEnd()}\nwiki/\n`);
    }
  } else {
    atomicWriteFileSync(gitignorePath, 'wiki/\n');
  }
  return wikiDir;
}

export function withWikiLock<T>(root: string, fn: () => T): T {
  const wikiDir = ensureWikiDir(root);
  return withFileLockSync(lockPathFor(join(wikiDir, '.wiki-lock')), fn, {
    timeoutMs: 5_000,
    retryDelayMs: 50,
  });
}

export function parseFrontmatter(raw: string): { frontmatter: WikiPageFrontmatter; content: string } | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const content = match[2];

  try {
    const fm = parseSimpleYaml(yamlBlock);
    return {
      frontmatter: {
        title: String(fm.title || ''),
        tags: parseYamlArray(fm.tags),
        created: String(fm.created || new Date().toISOString()),
        updated: String(fm.updated || new Date().toISOString()),
        sources: parseYamlArray(fm.sources),
        links: parseYamlArray(fm.links),
        category: (fm.category || 'reference') as WikiPageFrontmatter['category'],
        confidence: (fm.confidence || 'medium') as WikiPageFrontmatter['confidence'],
        schemaVersion: Number(fm.schemaVersion) || WIKI_SCHEMA_VERSION,
      },
      content,
    };
  } catch {
    return null;
  }
}

function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value
        .slice(1, -1)
        .replace(/\\(\\|"|n|r)/g, (_, ch) => {
          if (ch === 'n') return '\n';
          if (ch === 'r') return '\r';
          return ch;
        });
    }
    if (key) result[key] = value;
  }
  return result;
}

function parseYamlArray(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) =>
        entry
          .trim()
          .replace(/^["']|["']$/g, '')
          .replace(/\\(\\|"|n|r)/g, (_, ch) => {
            if (ch === 'n') return '\n';
            if (ch === 'r') return '\r';
            return ch;
          }),
      )
      .filter(Boolean);
  }
  return trimmed ? [trimmed] : [];
}

function escapeYaml(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export function serializePage(page: WikiPage): string {
  const fm = page.frontmatter;
  const yaml = [
    `title: "${escapeYaml(fm.title)}"`,
    `tags: [${fm.tags.map((tag) => `"${escapeYaml(tag)}"`).join(', ')}]`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    `sources: [${fm.sources.map((source) => `"${escapeYaml(source)}"`).join(', ')}]`,
    `links: [${fm.links.map((link) => `"${escapeYaml(link)}"`).join(', ')}]`,
    `category: ${fm.category}`,
    `confidence: ${fm.confidence}`,
    `schemaVersion: ${fm.schemaVersion}`,
  ].join('\n');

  return `---\n${yaml}\n---\n${page.content}`;
}

function safeWikiPath(wikiDir: string, filename: string): string | null {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return null;
  }
  const filePath = join(wikiDir, filename);
  const resolved = resolve(filePath);
  const resolvedWikiDir = resolve(wikiDir);
  if (resolved !== resolvedWikiDir && !resolved.startsWith(`${resolvedWikiDir}${sep}`)) {
    return null;
  }
  return filePath;
}

export function readPage(root: string, filename: string): WikiPage | null {
  const wikiDir = getWikiDir(root);
  const filePath = safeWikiPath(wikiDir, filename);
  if (!filePath || !existsSync(filePath)) return null;

  try {
    const parsed = parseFrontmatter(readFileSync(filePath, 'utf8'));
    if (!parsed) return null;
    return {
      filename,
      frontmatter: parsed.frontmatter,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

export function listPages(root: string): string[] {
  const wikiDir = getWikiDir(root);
  if (!existsSync(wikiDir)) return [];
  return readdirSync(wikiDir)
    .filter((entry) => entry.endsWith('.md') && !RESERVED_FILES.has(entry))
    .sort();
}

export function readAllPages(root: string): WikiPage[] {
  return listPages(root)
    .map((filename) => readPage(root, filename))
    .filter((page): page is WikiPage => page !== null);
}

export function readIndex(root: string): string | null {
  const indexPath = join(getWikiDir(root), INDEX_FILE);
  return existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
}

export function readLog(root: string): string | null {
  const logPath = join(getWikiDir(root), LOG_FILE);
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : null;
}

export function writePageUnsafe(root: string, page: WikiPage, options: { allowReserved?: boolean } = {}): void {
  if (!options.allowReserved && RESERVED_FILES.has(page.filename)) {
    throw new Error(`Cannot write to reserved wiki file: ${page.filename}`);
  }
  const wikiDir = ensureWikiDir(root);
  const filePath = safeWikiPath(wikiDir, page.filename);
  if (!filePath) throw new Error(`Invalid wiki page filename: ${page.filename}`);
  atomicWriteFileSync(filePath, serializePage(page));
}

export function deletePageUnsafe(root: string, filename: string): boolean {
  if (RESERVED_FILES.has(filename)) {
    return false;
  }
  const wikiDir = getWikiDir(root);
  const filePath = safeWikiPath(wikiDir, filename);
  if (!filePath || !existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function updateIndexUnsafe(root: string): void {
  const pages = readAllPages(root);
  const byCategory = new Map<string, WikiPage[]>();

  for (const page of pages) {
    const category = page.frontmatter.category;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category)?.push(page);
  }

  const lines: string[] = [
    '# Wiki Index',
    '',
    `> ${pages.length} pages | Last updated: ${new Date().toISOString()}`,
    '',
  ];

  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`## ${category}`);
    lines.push('');
    for (const page of byCategory.get(category) ?? []) {
      const summaryLine = page.content.split('\n').find((line) => line.trim().length > 0)?.trim() || '';
      const summary = summaryLine.length > 80 ? `${summaryLine.slice(0, 77)}...` : summaryLine;
      lines.push(`- [${page.frontmatter.title}](${page.filename}) — ${summary}`);
    }
    lines.push('');
  }

  atomicWriteFileSync(join(ensureWikiDir(root), INDEX_FILE), lines.join('\n'));
}

export function appendLogUnsafe(root: string, entry: WikiLogEntry): void {
  const wikiDir = ensureWikiDir(root);
  const logPath = join(wikiDir, LOG_FILE);
  const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '# Wiki Log\n\n';
  const logLine = `## [${entry.timestamp}] ${entry.operation}\n`
    + `- **Pages:** ${entry.pagesAffected.join(', ') || 'none'}\n`
    + `- **Summary:** ${entry.summary}\n\n`;
  atomicWriteFileSync(logPath, `${existing}${logLine}`);
}

export function writePage(root: string, page: WikiPage, options: { allowReserved?: boolean } = {}): void {
  withWikiLock(root, () => {
    writePageUnsafe(root, page, options);
    updateIndexUnsafe(root);
  });
}

export function deletePage(root: string, filename: string): boolean {
  return withWikiLock(root, () => {
    const deleted = deletePageUnsafe(root, filename);
    if (deleted) updateIndexUnsafe(root);
    return deleted;
  });
}

export function appendLog(root: string, entry: WikiLogEntry): void {
  withWikiLock(root, () => {
    appendLogUnsafe(root, entry);
  });
}

export function titleToSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  if (!base) {
    let hash = 0;
    for (let index = 0; index < title.length; index += 1) {
      hash = ((hash << 5) - hash + title.charCodeAt(index)) | 0;
    }
    return `page-${Math.abs(hash).toString(16).padStart(8, '0')}.md`;
  }

  return `${base}.md`;
}

export function normalizeWikiPageName(page: string): string {
  return page.endsWith('.md') ? page : `${page}.md`;
}
