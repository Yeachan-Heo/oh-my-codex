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

describe('anti-slop workflow surfaces', () => {
  it('adds anti-slop working agreements to root and template AGENTS', () => {
    for (const file of ['AGENTS.md', 'templates/AGENTS.md']) {
      const content = read(file);
      assert.match(content, /## Working agreements/);
      assert.match(content, /Write a cleanup plan before modifying code/i);
      assert.match(content, /Lock existing behavior with regression tests/i);
      assert.match(content, /Prefer deletion over addition/i);
      assert.match(content, /No new dependencies without explicit request/i);
      assert.match(content, /Run lint, typecheck, tests, and static analysis/i);
      assert.match(content, /\$ai-slop-cleaner/);
      assert.match(content, /writer\/reviewer pass separation/i);
    }
  });

  it('documents reviewer-only separation in review and plan review mode', () => {
    const reviewSkill = read('skills/review/SKILL.md');
    const planSkill = read('skills/plan/SKILL.md');

    assert.match(reviewSkill, /reviewer-only pass/i);
    assert.match(reviewSkill, /Never write and approve in the same context/i);
    assert.match(reviewSkill, /cleanup\/refactor\/anti-slop/i);

    assert.match(planSkill, /### Review Mode \(`--review`\)/);
    assert.match(planSkill, /reviewer-only pass/i);
    assert.match(planSkill, /MUST NOT be the context that approves it/i);
    assert.match(planSkill, /cleanup plan, regression tests/i);
  });

  it('defines the built-in ai-slop-cleaner workflow', () => {
    const skill = read('skills/ai-slop-cleaner/SKILL.md');
    assert.match(skill, /regression tests first/i);
    assert.match(skill, /cleanup plan/i);
    assert.match(skill, /duplication/i);
    assert.match(skill, /dead code/i);
    assert.match(skill, /needless abstraction/i);
    assert.match(skill, /boundary violations/i);
    assert.match(skill, /Pass 1: Dead code deletion/i);
    assert.match(skill, /Pass 2: Duplicate removal/i);
    assert.match(skill, /Pass 3: Naming\/error handling cleanup/i);
    assert.match(skill, /Pass 4: Test reinforcement/i);
    assert.match(skill, /quality gates/i);
    assert.match(skill, /remaining risks/i);
    assert.match(skill, /file list scope/i);
    assert.match(skill, /changed files/i);
    assert.match(skill, /Ralph workflow/i);
  });
});
