import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRalphAppendInstructions } from '../ralph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('ralph goal mode integration contract', () => {
  it('documents Codex goal-mode audit and completion semantics in the Ralph skill', () => {
    assert.match(ralphSkill, /Goal Mode Integration/i);
    assert.match(ralphSkill, /get_goal/i);
    assert.match(ralphSkill, /create_goal/i);
    assert.match(ralphSkill, /update_goal\(\{status: "complete"\}\)/i);
    assert.match(ralphSkill, /prompt-to-artifact checklist/i);
    assert.match(ralphSkill, /Do not use passing tests, Ralph state, or architect approval as proxy proof/i);
  });

  it('injects goal-mode guidance into launched Ralph sessions', () => {
    const instructions = buildRalphAppendInstructions('ship the integration', {
      changedFilesPath: '.omx/ralph/changed-files.txt',
      noDeslop: false,
    });

    assert.match(instructions, /Goal mode guidance/i);
    assert.match(instructions, /get_goal/i);
    assert.match(instructions, /create_goal/i);
    assert.match(instructions, /update_goal\(\{status: "complete"\}\)/i);
    assert.match(instructions, /top-level completion contract/i);
    assert.match(instructions, /prompt-to-artifact checklist/i);
  });
});
