import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(__dirname, '../../../skills/visual-ralph/SKILL.md'), 'utf-8');

describe('visual-ralph skill contract', () => {
  it('defines the image approval to Ralph workflow', () => {
    assert.match(skill, /^---\nname: visual-ralph/m);
    assert.match(skill, /description:\s*"Visual Ralph orchestration/i);
    assert.match(skill, /description:.*live URL targets/i);
    assert.match(skill, /\$imagegen/);
    assert.match(skill, /explicit user approval|explicit user confirmation/i);
    assert.match(skill, /\$ralph/);
    assert.match(skill, /built-in visual verdict|Visual Ralph verdict/i);
  });

  it('owns the migrated live URL cloning use case', () => {
    assert.match(skill, /live URL/i);
    assert.match(skill, /live URL.*visual implementation or clone/i);
    assert.match(skill, /source URL and permission\/scope note/i);
    assert.match(skill, /Interaction parity notes/i);
    assert.match(skill, /migrated `\$web-clone` use case/i);
    assert.match(skill, /Do not route new URL-driven website cloning work to `\$web-clone`/i);
    assert.doesNotMatch(skill, /The reference is a live URL; use `\$web-clone`/i);
  });

  it('keeps the built-in visual verdict authoritative and pixel diff secondary', () => {
    assert.match(skill, /score\s*>?=\s*90|90\+/i);
    assert.match(skill, /pixel diff|pixelmatch/i);
    assert.match(skill, /does not replace the Visual Ralph verdict|secondary debug evidence/i);
  });

  it('requires reproducibility and repo-native design system artifacts', () => {
    assert.match(skill, /screenshot reproduction command|viewport|output paths/i);
    assert.match(skill, /repo-native reusable artifacts|repo-native and reusable/i);
    for (const token of ['colors', 'spacing', 'typography', 'radii', 'shadows']) {
      assert.match(skill, new RegExp(token, 'i'));
    }
  });

  it('forbids hardcoded stack assumptions and unapproved pivots', () => {
    assert.match(skill, /Do not hardcode React, Vue, Tailwind/i);
    assert.match(skill, /Major design pivots.*explicit user request|Do not make major design pivots unless explicitly requested/i);
  });
});
