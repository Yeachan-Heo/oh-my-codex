import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadSurface } from './prompt-guidance-test-helpers.js';

for (const surface of ['AGENTS.md', 'templates/AGENTS.md']) {
  describe(`${surface} strict-memory state-management contract`, () => {
    it('describes notepad as run-local scratch instead of durable memory authority', () => {
      const content = loadSurface(surface);
      assert.match(content, /\.omx\/notepad\.md` — run-local session scratch and hot context/i);
      assert.match(content, /\.omx\/project-memory\.json` — local compatibility cache, not the formal memory authority/i);
      assert.doesNotMatch(content, /\.omx\/project-memory\.json` — cross-session memory/i);
    });
  });
}

describe('strict-memory prompt surfaces', () => {
  it('keeps the note skill aligned with run-local scratch semantics', () => {
    const skill = loadSurface('skills/note/SKILL.md');
    assert.match(skill, /Save run-local context to `.omx\/notepad\.md`/i);
    assert.match(skill, /not the formal long-term memory authority/i);
    assert.match(skill, /external memory pipeline/i);
  });

  it('keeps overlay compaction guidance aligned with scratch-only local memory semantics', () => {
    const overlaySource = loadSurface('src/hooks/agents-overlay.ts');
    assert.match(overlaySource, /Save run-local breadcrumbs to notepad via notepad_write_working/i);
    assert.match(overlaySource, /local project memory as scratch\/compatibility state, not the formal memory authority/i);
  });

  it('describes MCP state management as lifecycle state plus local compatibility tools', () => {
    const docsIndex = loadSurface('docs/index.html');
    assert.match(docsIndex, /run-local notepad scratch, and local project-memory compatibility tools/i);
  });
});
