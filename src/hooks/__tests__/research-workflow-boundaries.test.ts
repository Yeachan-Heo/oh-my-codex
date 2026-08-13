import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

describe('research workflow boundary guidance', () => {
  it('keeps best-practice research positioned as pre-planning evidence, not architecture', () => {
    const skill = read('skills/best-practice-research/SKILL.md');
    assert.match(skill, /ordinary first research wrapper/i);
    assert.match(skill, /hand it to `\$ralplan` or the caller as planning input/i);
    assert.match(skill, /Do not present `\$best-practice-research` as a final architecture component/i);
  });

  it('keeps autoresearch scoped to validator-gated deliverables feeding ralplan evidence', () => {
    const skill = read('skills/autoresearch/SKILL.md');
    assert.match(skill, /bounded deliverable that must pass an explicit validator/i);
    assert.match(skill, /Do not recommend it for ordinary pre-planning docs lookup/i);
    assert.match(skill, /approved artifact should feed evidence into `\$ralplan`/i);
    assert.match(skill, /should not become a final architecture\/component unless the user explicitly asks/i);
  });

  it('autoresearch-goal is a sunset stub pointing to autoresearch', () => {
    const skill = read('skills/autoresearch-goal/SKILL.md');
    assert.match(skill, /was removed/i);
    assert.match(skill, /\$autoresearch/i);
  });

  it('requires plan to synthesize prior research instead of embedding research automation by default', () => {
    const planSkill = read('skills/plan/SKILL.md');
    assert.ok(planSkill.length > 0);
    const ralplanSkill = read('skills/ralplan/SKILL.md');
    assert.match(ralplanSkill, /prior `\$autoresearch`.*approved artifact as evidence/is);
    assert.match(ralplanSkill, /Do not include Autoresearch as a final architecture or runtime component/i);
  });
});
