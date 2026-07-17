import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

const guidanceSurfaces = ['AGENTS.md', 'templates/AGENTS.md'];

describe('proportional harness guidance', () => {
  for (const path of guidanceSurfaces) {
    it(`${path} keeps artifact work direct and assurance separate from execution shape`, () => {
      const content = read(path);
      assert.match(content, /direct artifact|artifact-only/i);
      assert.match(content, /article|wiki|mockup/i);
      assert.match(content, /rendered|previewed/i);
      assert.match(content, /assurance.*execution shape|execution shape.*assurance/i);
      assert.match(content, /file count.*not.*router|not.*file count/i);
    });

    it(`${path} limits brainstorming to materially unresolved intent`, () => {
      const content = read(path);
      assert.match(content, /brainstorming.*materially unresolved|materially unresolved.*brainstorming/i);
      assert.match(content, /does not apply.*bounded direct artifact|bounded direct artifact.*does not apply/i);
      assert.match(content, /target.*adjustment.*constraints.*acceptance surface/i);
    });

    it(`${path} makes visual and engineering gates applicability-aware`, () => {
      const content = read(path);
      assert.match(content, /generated screenshot.*reference image|reference image.*generated screenshot/i);
      assert.match(content, /visual fidelity/i);
      assert.match(content, /text-only.*source.*DOM|source.*DOM.*text-only/i);
      assert.match(content, /show the changed surface.*does not.*rendered output|rendered output.*does not.*show the changed surface/i);
      assert.match(content, /one bounded fallback/i);
      assert.match(content, /do not cascade.*Playwright.*Computer Use|Playwright.*Computer Use.*do not cascade/i);
      assert.match(content, /relevant.*changed surface|changed surface.*relevant/i);
      assert.match(content, /tests pass.*where tests apply|where tests apply.*tests pass/i);
    });

    it(`${path} routes cleanup proportionally`, () => {
      const content = read(path);
      assert.match(content, /cleanup.*proportional|proportional.*cleanup/i);
      assert.doesNotMatch(content, /Cleanup\/refactor\/deslop work still follows the same `\$deep-interview` -> `\$ralplan` -> `\$team`\/`\$ralph` path/i);
    });

    it(`${path} no longer advertises ordinary desire phrasing as autopilot`, () => {
      const content = read(path);
      assert.doesNotMatch(content, /"I want a".*\| `\$autopilot`/i);
    });

    it(`${path} makes upstream workflow imports explicit per owned overlay`, () => {
      const content = read(path);
      assert.match(content, /writing-plans.*dispatching-parallel-agents.*load their matching namespaced Superpowers skills/is);
      assert.match(
        content,
        /test-driven-development.*subagent-driven-development.*executing-plans.*verification-before-completion.*standalone owned policy/is,
      );
      assert.doesNotMatch(content, /each overlay must load its matching namespaced Superpowers skill/i);
    });
  }

  it('keeps visual-verdict scoped to reference comparison', () => {
    const content = read('skills/visual-verdict/SKILL.md');
    assert.match(content, /generated screenshot/i);
    assert.match(content, /at least one reference image/i);
  });

  it('requires unmistakable hands-off intent for autopilot', () => {
    const content = read('skills/autopilot/SKILL.md');
    assert.doesNotMatch(content, /I want a\/an/i);
    assert.match(content, /end-to-end autonomous|hands-off/i);
  });
});
