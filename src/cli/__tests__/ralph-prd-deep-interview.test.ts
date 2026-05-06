import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('ralph PRD mode deep interview gate', () => {
  it('requires deep-interview --quick before PRD artifact creation', () => {
    assert.match(ralphSkill, /Run deep-interview in quick mode before creating PRD artifacts/i);
    assert.match(ralphSkill, /\$deep-interview\s+--quick/i);
    assert.match(ralphSkill, /\.omx\/interviews\/\{slug\}-\{timestamp\}\.md/);
  });

  it('documents --no-deslop as a PRD-mode opt-out for the final deslop pass', () => {
    assert.match(ralphSkill, /--no-deslop/);
    assert.match(ralphSkill, /skip the deslop pass/i);
  });

  it('hard-deprecates the former ralph-init startup compatibility surface', () => {
    const ralphInitSkill = readFileSync(join(__dirname, '../../../skills/ralph-init/SKILL.md'), 'utf-8');
    assert.match(ralphInitSkill, /Hard-deprecated/i);
    assert.match(ralphInitSkill, /Do not invoke or route this skill/i);
    assert.match(ralphInitSkill, /Use `\$ralph` directly/i);
  });
});
