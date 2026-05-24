import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

const docsPages = ['docs/index.html', 'docs/getting-started.html', 'docs/agents.html', 'docs/skills.html', 'docs/integrations.html'];

describe('public docs site contract', () => {
  it('keeps every repo-owned docs HTML page linked to an existing stylesheet', () => {
    for (const page of docsPages) {
      const content = read(page);
      const hrefs = [...content.matchAll(/<link\s+[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(hrefs.length > 0, `${page} should link a stylesheet`);
      for (const href of hrefs) {
        assert.ok(!href.startsWith('http'), `${page} should use a repo-owned relative stylesheet, got ${href}`);
        const resolved = join(root, dirname(page), href);
        assert.ok(existsSync(resolved), `${page} stylesheet must exist: ${href}`);
      }
    }
  });

  it('defines CSS for the layout classes used by the static docs pages', () => {
    const css = read('docs/style.css');
    assert.match(css, /(^|\n)\.grid\s*,\s*\n\.card-grid\s*\{/, 'docs/style.css must style .grid cards used by docs pages');
    for (const page of docsPages) {
      const content = read(page);
      if (content.includes('class="grid"')) {
        assert.match(css, /(^|\n)\.grid\s*,/, `${page} uses .grid, so docs/style.css must style it`);
      }
    }
  });

  it('documents research workflow boundaries on the public skills page', () => {
    const content = read('docs/skills.html');
    assert.match(content, /Research and Planning Boundaries/);
    assert.match(content, /\$best-practice-research[\s\S]*ordinary pre-planning wrapper/);
    assert.match(content, /\$autoresearch[\s\S]*bounded validator-gated research deliverable/);
    assert.match(content, /\$autoresearch-goal[\s\S]*Codex goal-mode version/);
    assert.match(content, /Autoresearch findings gathered before planning should feed into <code>\$ralplan<\/code> as evidence/);
  });
});
