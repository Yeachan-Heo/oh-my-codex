import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getLegacyWikiDir,
  getWikiDir,
  isLegacyWikiFallbackActive,
  listPages,
  serializePage,
} from '../../wiki/storage.js';
import { WIKI_SCHEMA_VERSION } from '../../wiki/types.js';

const REQUIRED_TOOLS = [
  'wiki_ingest',
  'wiki_query',
  'wiki_lint',
  'wiki_add',
  'wiki_list',
  'wiki_read',
  'wiki_delete',
  'wiki_refresh',
] as const;

describe('mcp/wiki-server module contract', () => {
  it('declares the expected wiki MCP tools', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/wiki-server.ts'), 'utf8');
    const toolNames = Array.from(src.matchAll(/name:\s*'([^']+)'/g)).map((match) => match[1]);

    for (const tool of REQUIRED_TOOLS) {
      assert.ok(toolNames.includes(tool), `missing tool declaration: ${tool}`);
    }
  });

  it('delegates wiki stdio lifecycle bootstrapping to the shared helper', async () => {
    const src = await readFile(join(process.cwd(), 'src/mcp/wiki-server.ts'), 'utf8');

    assert.match(src, /autoStartStdioMcpServer\('wiki', server\)/);
    assert.doesNotMatch(src, /new StdioServerTransport\(\)/);
    assert.doesNotMatch(src, /server\.connect\(transport\)\.catch\(console\.error\);/);
  });

  it('keeps allowlisted wiki query and lint MCP calls free of durable log writes', async () => {
    process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = '1';
    const { handleWikiToolCall } = await import('../wiki-server.js');
    const root = await mkdtemp(join(tmpdir(), 'wiki-mcp-read-only-'));
    try {
      for (const [name, args] of [
        ['wiki_query', { query: 'caller supplied text', workingDirectory: root }],
        ['wiki_lint', { workingDirectory: root }],
      ] as const) {
        const response = await handleWikiToolCall({ params: { name, arguments: args } });
        assert.equal('isError' in response ? response.isError : false, false, name);
        assert.equal(existsSync(getWikiDir(root)), false, `${name} created durable wiki state`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wiki_add writes canonical pages even when the same legacy slug exists', async () => {
    process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = '1';
    const { handleWikiToolCall } = await import('../wiki-server.js');
    const root = await mkdtemp(join(tmpdir(), 'wiki-mcp-legacy-add-'));
    try {
      writeLegacyPage(root, 'Same Title', 'private legacy content');

      const response = await handleWikiToolCall({
        params: {
          name: 'wiki_add',
          arguments: {
            title: 'Same Title',
            content: 'canonical public content',
            workingDirectory: root,
          },
        },
      });

      assert.equal('isError' in response ? response.isError : false, false);
      assert.equal(existsSync(join(getWikiDir(root), 'same-title.md')), true);
      assert.match(await readFile(join(getWikiDir(root), 'same-title.md'), 'utf8'), /canonical public content/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wiki_delete does not create canonical storage when deleting from legacy-only fallback', async () => {
    process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = '1';
    const { handleWikiToolCall } = await import('../wiki-server.js');
    const root = await mkdtemp(join(tmpdir(), 'wiki-mcp-legacy-delete-'));
    try {
      writeLegacyPage(root, 'Legacy', 'legacy content');

      const response = await handleWikiToolCall({
        params: {
          name: 'wiki_delete',
          arguments: {
            page: 'legacy.md',
            workingDirectory: root,
          },
        },
      });

      assert.equal('isError' in response ? response.isError : false, true);
      assert.match(JSON.parse(response.content[0].text).error, /Wiki page not found or reserved: legacy\.md/);
      assert.equal(existsSync(getWikiDir(root)), false);
      assert.equal(isLegacyWikiFallbackActive(root), true);
      assert.deepEqual(listPages(root), ['legacy.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('wiki_refresh leaves legacy-only fallback read-only and does not create canonical storage', async () => {
    process.env.OMX_WIKI_SERVER_DISABLE_AUTO_START = '1';
    const { handleWikiToolCall } = await import('../wiki-server.js');
    const root = await mkdtemp(join(tmpdir(), 'wiki-mcp-legacy-refresh-'));
    try {
      writeLegacyPage(root, 'Legacy Only', 'legacy content');

      const response = await handleWikiToolCall({
        params: {
          name: 'wiki_refresh',
          arguments: { workingDirectory: root },
        },
      });
      const payload = JSON.parse(response.content[0].text) as {
        refreshed: boolean;
        legacyFallback: boolean;
        pages: string[];
      };

      assert.equal(payload.refreshed, false);
      assert.equal(payload.legacyFallback, true);
      assert.deepEqual(payload.pages, ['legacy-only.md']);
      assert.equal(existsSync(getWikiDir(root)), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function writeLegacyPage(root: string, title: string, content: string): void {
  const now = new Date().toISOString();
  const filename = `${title.toLowerCase().replace(/\s+/g, '-')}.md`;
  const legacyDir = getLegacyWikiDir(root);
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, filename), serializePage({
    filename,
    frontmatter: {
      title,
      tags: ['legacy'],
      created: now,
      updated: now,
      sources: [],
      links: [],
      category: 'reference',
      confidence: 'medium',
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: `\n# ${title}\n\n${content}\n`,
  }));
}
