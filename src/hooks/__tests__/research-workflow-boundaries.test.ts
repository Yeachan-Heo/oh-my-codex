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

  it('keeps autoresearch-goal limited to goal-mode research missions', () => {
    const skill = read('skills/autoresearch-goal/SKILL.md');
    assert.match(skill, /Codex goal-mode management plus professor\/critic-style validation/i);
    assert.match(skill, /not the default answer for ordinary pre-planning best-practice lookup/i);
  });

  it('requires ralplan to synthesize prior research instead of embedding research automation by default', () => {
    const skill = read('skills/ralplan/SKILL.md');
    assert.match(skill, /treat its approved artifact as evidence for the plan/i);
    assert.match(skill, /Do not include Autoresearch as a final architecture or runtime component/i);
    assert.match(skill, /synthesize the evidence into the `\$ralplan` ADR, risks, and verification steps/i);
  });
});
