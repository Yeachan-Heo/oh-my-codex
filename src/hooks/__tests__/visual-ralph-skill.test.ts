import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(__dirname, '../../../skills/visual-ralph/SKILL.md'), 'utf-8');

describe('visual-ralph skill contract', () => {
  it('defines the approved-reference handoff to Ultragoal', () => {
    assert.match(skill, /^---\nname: visual-ralph/m);
    assert.match(skill, /description:\s*"Visual Ralph orchestration/i);
    assert.match(skill, /generated references, static references, or live URL targets/i);
    assert.match(skill, /\$imagegen/);
    assert.match(skill, /## 3\. Approval gate/i);
    assert.match(skill, /obtain approval of one reference image\/state/i);
    assert.match(skill, /Before approval, do not implement or invoke `\$ultragoal`/i);
    assert.match(skill, /\$ultragoal/);
    assert.match(skill, /built-in visual verdict|Visual Ralph verdict/i);
  });

  it('owns the migrated live URL cloning use case', () => {
    assert.match(skill, /For URL cloning, this skill owns the migrated `\$web-clone` use case/i);
    assert.match(skill, /preserve URL, viewport, fidelity, and interaction notes/i);
    assert.match(skill, /source URL and permission\/scope/i);
    assert.match(skill, /visible-control parity notes/i);
    assert.match(skill, /Do not invoke standalone `\$web-clone`/i);
  });

  it('keeps the built-in visual verdict authoritative and pixel diff secondary', () => {
    assert.match(skill, /If `score < 90`/i);
    assert.match(skill, /Required verdict keys: `score`, `verdict`, `category_match`, `differences\[\]`, `suggestions\[\]`, `reasoning`/i);
    assert.match(skill, /pixel diff\/pixelmatch overlays only to locate hotspots/i);
    assert.match(skill, /they never replace the verdict/i);
  });

  it('requires reproducibility and repo-native design system artifacts', () => {
    assert.match(skill, /approved reference\/baseline and reproduction command/i);
    assert.match(skill, /final verdict is `>= 90`/i);
    assert.match(skill, /secondary diff evidence is recorded/i);
    assert.match(skill, /reusable tokens\/components exist/i);
    for (const token of ['colors', 'spacing', 'typography', 'radii', 'shadows']) {
      assert.match(skill, new RegExp(token, 'i'));
    }
  });

  it('grounds implementation choices and forbids unapproved pivots', () => {
    assert.match(skill, /Choose stack-specific commands only when repository evidence supports them/i);
    assert.match(skill, /Major design pivots.*explicit user request|Do not make major design pivots unless explicitly requested/i);
  });
});
