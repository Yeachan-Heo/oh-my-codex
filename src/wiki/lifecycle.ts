/**
 * Wiki lifecycle integration.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { codexHome, resolveProjectMemoryPath } from '../utils/paths.js';
import {
  appendLogUnsafe,
  getWikiDir,
  isLegacyWikiFallbackActive,
  listPages,
  readAllPages,
  readIndex,
  readPage,
  updateIndexUnsafe,
  withWikiLock,
  writePageUnsafe,
} from './storage.js';
import { DEFAULT_WIKI_CONFIG, type WikiConfig, WIKI_SCHEMA_VERSION } from './types.js';

function loadWikiConfig(root: string): WikiConfig {
  const candidates = [join(root, '.omx-config.json'), join(codexHome(), '.omx-config.json')];

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue;
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { wiki?: Partial<WikiConfig> };
      if (parsed?.wiki && typeof parsed.wiki === 'object') {
        return { ...DEFAULT_WIKI_CONFIG, ...parsed.wiki };
      }
    } catch {
      // ignore malformed config and continue to defaults
    }
  }

  return DEFAULT_WIKI_CONFIG;
}

export function onSessionStart(data: { cwd?: string }): { additionalContext?: string } {
  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);
    if (!config.enabled) return {};

    const legacyFallbackActive = isLegacyWikiFallbackActive(root);
    const wikiDir = getWikiDir(root);
    if (!existsSync(wikiDir) && !legacyFallbackActive) return {};

    const pages = listPages(root);
    if (pages.length === 0) return {};

    if (legacyFallbackActive) {
      const summary = [
        `[OMX Wiki: ${pages.length} legacy pages at .omx/wiki/; canonical storage is omx_wiki/]`,
        '',
        'Legacy wiki fallback is read-only. Review and copy selected pages into omx_wiki/ before committing.',
      ].join('\n');
      return { additionalContext: summary };
    }

    if (!legacyFallbackActive && !readIndex(root)) {
      withWikiLock(root, () => {
        updateIndexUnsafe(root);
      });
    }

    if (config.feedProjectMemoryOnStart) {
      feedProjectMemory(root);
    }

    const index = readIndex(root);
    if (!index) return {};

    const summary = [
      `[OMX Wiki: ${pages.length} pages at omx_wiki/]`,
      '',
      'Use wiki_query to search, wiki_list to browse, wiki_read to inspect pages.',
      '',
      ...index.split('\n').slice(0, config.maxContextLines),
    ].join('\n');

    return { additionalContext: summary };
  } catch {
    return {};
  }
}

export function onSessionEnd(data: { cwd?: string; session_id?: string }): { continue: boolean } {
  const startedAt = Date.now();
  const timeoutMs = 3_000;

  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);
    if (!config.enabled || !config.autoCapture) {
      return { continue: true };
    }

    const wikiDir = getWikiDir(root);
    if (!existsSync(wikiDir)) {
      return { continue: true };
    }

    const sessionId = data.session_id || `session-${Date.now()}`;
    const now = new Date().toISOString();
    const dateSlug = now.split('T')[0];
    const filename = `session-log-${dateSlug}-${sessionId.slice(-8)}.md`;

    withWikiLock(root, () => {
      if (Date.now() - startedAt > timeoutMs) return;

      writePageUnsafe(root, {
        filename,
        frontmatter: {
          title: `Session Log ${dateSlug}`,
          tags: ['session-log', 'auto-captured'],
          created: now,
          updated: now,
          sources: [sessionId],
          links: [],
          category: 'session-log',
          confidence: 'medium',
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: `\n# Session Log ${dateSlug}\n\nAuto-captured session metadata.\nSession ID: ${sessionId}\n\nReview and promote significant findings to curated wiki pages via \`wiki_ingest\`.\n`,
      });

      appendLogUnsafe(root, {
        timestamp: now,
        operation: 'session-end',
        pagesAffected: [filename],
        summary: `Auto-captured session log for ${sessionId}`,
      });

      updateIndexUnsafe(root);
    });
  } catch {
    // best effort only
  }

  return { continue: true };
}

export function onPreCompact(data: { cwd?: string }): { additionalContext?: string } {
  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);
    if (!config.enabled) return {};

    const pages = listPages(root);
    if (pages.length === 0) return {};

    const allPages = readAllPages(root);
    const categories = [...new Set(allPages.map((page) => page.frontmatter.category))];
    const latestUpdate = allPages
      .map((page) => page.frontmatter.updated)
      .sort()
      .reverse()[0] || 'unknown';

    return {
      additionalContext: `[Wiki: ${pages.length} pages | categories: ${categories.join(', ')} | last updated: ${latestUpdate}]`,
    };
  } catch {
    return {};
  }
}


export function onPostCompact(data: { cwd?: string }): { additionalContext?: string } {
  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);
    if (!config.enabled) return {};

    return {
      additionalContext: [
        '[OMX Wiki PostCompact Nudge]',
        'Review the compaction artifacts and write durable findings to repository `omx_wiki/` when they would help future agents.',
        'Use `omx wiki wiki_ingest --input <json> --json` or `omx wiki wiki_add --input <json> --json` for decisions, architecture notes, debugging findings, environment facts, and session-log summaries worth committing.',
      ].join('\n'),
    };
  } catch {
    return {};
  }
}

function feedProjectMemory(root: string): void {
  try {
    const projectMemoryPath = resolveProjectMemoryPath(root);
    if (!projectMemoryPath || !existsSync(projectMemoryPath)) return;

    const parsed = JSON.parse(readFileSync(projectMemoryPath, 'utf8')) as Record<string, unknown>;
    const existing = readPage(root, 'environment.md');
    const memoryMtime = statSync(projectMemoryPath).mtimeMs;
    const existingUpdated = existing ? new Date(existing.frontmatter.updated).getTime() : 0;
    if (existing && existingUpdated >= memoryMtime) {
      return;
    }

    const sections: string[] = ['\n# Project Environment\n'];
    const stringFields: Array<[string, unknown]> = [
      ['Tech Stack', parsed.techStack],
      ['Build', parsed.build],
      ['Conventions', parsed.conventions],
      ['Structure', parsed.structure],
    ];

    for (const [label, value] of stringFields) {
      if (typeof value === 'string' && value.trim() !== '') {
        sections.push(`## ${label}`);
        sections.push(value.trim());
        sections.push('');
      }
    }

    if (Array.isArray(parsed.notes) && parsed.notes.length > 0) {
      sections.push('## Notes');
      for (const note of parsed.notes.slice(0, 20)) {
        const content = typeof (note as { content?: unknown }).content === 'string'
          ? (note as { content: string }).content.trim()
          : '';
        if (content) sections.push(`- ${content}`);
      }
      sections.push('');
    }

    if (Array.isArray(parsed.directives) && parsed.directives.length > 0) {
      sections.push('## Directives');
      for (const directive of parsed.directives.slice(0, 20)) {
        const content = typeof (directive as { directive?: unknown }).directive === 'string'
          ? (directive as { directive: string }).directive.trim()
          : '';
        if (content) sections.push(`- ${content}`);
      }
      sections.push('');
    }

    const now = new Date().toISOString();
    withWikiLock(root, () => {
      writePageUnsafe(root, {
        filename: 'environment.md',
        frontmatter: {
          title: 'Project Environment',
          tags: ['environment', 'auto-detected'],
          created: existing?.frontmatter.created || now,
          updated: now,
          sources: ['project-memory-auto-detect'],
          links: [],
          category: 'environment',
          confidence: 'high',
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: sections.join('\n'),
      }, { allowReserved: true });
      updateIndexUnsafe(root);
      appendLogUnsafe(root, {
        timestamp: now,
        operation: 'session-start',
        pagesAffected: ['environment.md'],
        summary: 'Synced project memory into managed environment page',
      });
    });
  } catch {
    // best effort only
  }
}
