import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectPrimaryKeyword } from '../keyword-detector.js';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const designSkill = readFileSync(join(repoRoot, 'skills', 'design', 'SKILL.md'), 'utf-8');
const frontendShim = readFileSync(join(repoRoot, 'skills', 'frontend-ui-ux', 'SKILL.md'), 'utf-8');
const visualRalphSkill = readFileSync(join(repoRoot, 'skills', 'visual-ralph', 'SKILL.md'), 'utf-8');

describe('design skill contract', () => {
  it('defines canonical DESIGN.md source-of-truth workflow', () => {
    assert.match(designSkill, /^---\nname: design/m);
    assert.match(designSkill, /repo-local `DESIGN\.md` source of truth/i);
    assert.match(designSkill, /Discover local design evidence/i);
    assert.match(designSkill, /Interview only for missing context/i);
    assert.match(designSkill, /Create or refresh `DESIGN\.md`/i);
  });

  it('requires the DESIGN.md checklist sections from issue 2277', () => {
    for (const section of [
      'Brand',
      'Product goals',
      'Personas and jobs',
      'Information architecture',
      'Design principles',
      'Visual language',
      'Components',
      'Accessibility',
      'Responsive behavior',
      'Interaction states',
      'Content voice',
      'Implementation constraints',
      'Open questions',
    ]) {
      assert.match(designSkill, new RegExp(`## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    }
  });

  it('separates design governance from Visual Ralph matching', () => {
    assert.match(designSkill, /`\$visual-ralph` owns implementation against an approved generated\/static\/live-URL visual reference/i);
    assert.match(designSkill, /does not replace the `DESIGN\.md` discovery\/interview\/refresh workflow/i);
    assert.doesNotMatch(visualRalphSkill, /use `\$frontend-ui-ux`/i);
    assert.match(visualRalphSkill, /use `\$design`/i);
  });

  it('routes explicit $design while keeping frontend-ui-ux as deprecated compatibility guidance', () => {
    const design = detectPrimaryKeyword('$design refresh our design docs');
    assert.ok(design);
    assert.equal(design.skill, 'design');

    const deprecated = detectPrimaryKeyword('$frontend-ui-ux improve this page');
    assert.ok(deprecated);
    assert.equal(deprecated.skill, 'design');
    assert.match(frontendShim, /Hard-deprecated/i);
    assert.match(frontendShim, /Use `\$design`/i);
    assert.match(frontendShim, /Use `\$visual-ralph`/i);
  });
});
