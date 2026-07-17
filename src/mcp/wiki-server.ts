/**
 * OMX Wiki MCP Server
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { autoStartStdioMcpServer } from './bootstrap.js';
import { resolveWorkingDirectoryForState } from './state-paths.js';
import {
  appendLog,
  deletePage,
  ingestKnowledge,
  isLegacyWikiFallbackActive,
  lintWiki,
  listPages,
  normalizeWikiPageName,
  queryWiki,
  readCanonicalPage,
  readIndex,
  readPage,
  titleToSlug,
  updateIndexUnsafe,
  withWikiLock,
} from '../wiki/index.js';
import type { WikiCategory } from '../wiki/types.js';

const server = new Server(
  { name: 'omx-wiki', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const WIKI_CATEGORIES = [
  'architecture',
  'decision',
  'pattern',
  'debugging',
  'environment',
  'session-log',
  'reference',
  'convention',
] as const;

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorText(message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function resolveRoot(args: Record<string, unknown>): string {
  return resolveWorkingDirectoryForState(
    typeof args.workingDirectory === 'string' ? args.workingDirectory : undefined,
  );
}

export function buildWikiServerTools() {
  return [
    {
      name: 'wiki_ingest',
      description: 'Process knowledge into wiki pages. Creates new pages or merges into existing ones.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string', maxLength: 50000 },
          tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 20 },
          category: { type: 'string', enum: [...WIKI_CATEGORIES] },
          sources: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 10 },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          workingDirectory: { type: 'string' },
        },
        required: ['title', 'content', 'tags', 'category'],
      },
    },
    {
      name: 'wiki_query',
      description: 'Search wiki pages by keywords and tags. Returns raw matches for synthesis.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          category: { type: 'string', enum: [...WIKI_CATEGORIES] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
          workingDirectory: { type: 'string' },
        },
        required: ['query'],
      },
    },
    {
      name: 'wiki_lint',
      description: 'Run health checks on the wiki.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'wiki_add',
      description: 'Quick-add a single wiki page. Rejects overwrites; use wiki_ingest to merge.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          content: { type: 'string', maxLength: 50000 },
          tags: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 20 },
          category: { type: 'string', enum: [...WIKI_CATEGORIES] },
          workingDirectory: { type: 'string' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'wiki_list',
      description: 'List wiki pages and return the index when present.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
    {
      name: 'wiki_read',
      description: 'Read a specific wiki page.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          workingDirectory: { type: 'string' },
        },
        required: ['page'],
      },
    },
    {
      name: 'wiki_delete',
      description: 'Delete a wiki page and update the index.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          workingDirectory: { type: 'string' },
        },
        required: ['page'],
      },
    },
    {
      name: 'wiki_refresh',
      description: 'Rebuild the wiki index and refresh derived metadata surfaces.',
      inputSchema: {
        type: 'object',
        properties: {
          workingDirectory: { type: 'string' },
        },
      },
    },
  ];
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildWikiServerTools(),
}));

async function handleWikiToolCallWithOptions(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}, options: { logReadOperations?: boolean } = {}) {
  const { name, arguments: args = {} } = request.params;

  try {
    const root = resolveRoot(args);

    switch (name) {
      case 'wiki_ingest': {
        const result = ingestKnowledge(root, {
          title: String(args.title || ''),
          content: String(args.content || ''),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          category: String(args.category || 'reference') as WikiCategory,
          sources: Array.isArray(args.sources) ? args.sources.map(String) : undefined,
          confidence: typeof args.confidence === 'string'
            ? args.confidence as 'high' | 'medium' | 'low'
            : undefined,
        });
        return text(result);
      }

      case 'wiki_query': {
        const result = queryWiki(root, String(args.query || ''), {
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          category: typeof args.category === 'string' ? args.category as WikiCategory : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          logQuery: options.logReadOperations === true,
        });
        return text(result);
      }

      case 'wiki_lint':
        return text(lintWiki(root, undefined, { logLint: options.logReadOperations === true }));

      case 'wiki_add': {
        const title = String(args.title || '');
        const slug = titleToSlug(title);
        if (readCanonicalPage(root, slug)) {
          return errorText(`Page "${slug}" already exists. Use wiki_ingest to merge into it.`);
        }
        const result = ingestKnowledge(root, {
          title,
          content: String(args.content || ''),
          tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
          category: typeof args.category === 'string' ? args.category as WikiCategory : 'reference',
        });
        appendLog(root, {
          timestamp: new Date().toISOString(),
          operation: 'add',
          pagesAffected: result.created,
          summary: `Created wiki page ${slug}`,
        });
        return text(result);
      }

      case 'wiki_list': {
        return text({
          pages: listPages(root),
          index: readIndex(root),
        });
      }

      case 'wiki_read': {
        const page = readPage(root, normalizeWikiPageName(String(args.page || '')));
        if (!page) return errorText('Wiki page not found');
        return text(page);
      }

      case 'wiki_delete': {
        const filename = normalizeWikiPageName(String(args.page || ''));
        const deleted = deletePage(root, filename);
        if (!deleted) return errorText(`Wiki page not found or reserved: ${filename}`);
        appendLog(root, {
          timestamp: new Date().toISOString(),
          operation: 'delete',
          pagesAffected: [filename],
          summary: `Deleted wiki page ${filename}`,
        });
        return text({ deleted: true, page: filename });
      }

      case 'wiki_refresh': {
        if (isLegacyWikiFallbackActive(root)) {
          return text({
            refreshed: false,
            legacyFallback: true,
            pages: listPages(root),
            index: readIndex(root),
            message: 'Legacy .omx/wiki fallback is read-only; copy selected pages into omx_wiki/ before refreshing canonical metadata.',
          });
        }
        withWikiLock(root, () => {
          updateIndexUnsafe(root);
        });
        appendLog(root, {
          timestamp: new Date().toISOString(),
          operation: 'add',
          pagesAffected: listPages(root),
          summary: 'Refreshed wiki index and derived metadata surfaces',
        });
        return text({ refreshed: true, pages: listPages(root), index: readIndex(root) });
      }

      default:
        return errorText(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return errorText((error as Error).message);
  }
}

export async function handleWikiToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
  return handleWikiToolCallWithOptions(request);
}

export async function handleWikiCliToolCall(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}) {
  return handleWikiToolCallWithOptions(request, { logReadOperations: true });
}

server.setRequestHandler(CallToolRequestSchema, handleWikiToolCall);
autoStartStdioMcpServer('wiki', server);
