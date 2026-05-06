import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const visualVerdictSkill = readFileSync(join(__dirname, '../../../skills/visual-verdict/SKILL.md'), 'utf-8');
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('visual-verdict skill contract', () => {
  it('hard-deprecates the standalone visual-verdict skill', () => {
    assert.match(visualVerdictSkill, /^---\nname: visual-verdict/m);
    assert.match(visualVerdictSkill, /Hard-deprecated/i);
    assert.match(visualVerdictSkill, /Do not invoke or route this skill/i);
    assert.match(visualVerdictSkill, /Use `\$visual-ralph`/i);
  });
});

describe('ralph visual loop integration guidance', () => {
  it('requires the built-in Visual Ralph verdict before next edit', () => {
    assert.match(ralphSkill, /Visual Ralph verdict step/i);
    assert.match(ralphSkill, /before every next edit/i);
  });

  it('documents -i and --images-dir flags', () => {
    assert.match(ralphSkill, /-i <image-path>/);
    assert.match(ralphSkill, /--images-dir <directory>/);
  });

  it('requires persisting visual feedback to ralph-progress ledger', () => {
    assert.match(ralphSkill, /ralph-progress\.json/);
    assert.match(ralphSkill, /numeric \+ qualitative feedback/i);
  });
});
