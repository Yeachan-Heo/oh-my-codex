import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const skill = readFileSync(join(root, 'skills', 'best-practice-research', 'SKILL.md'), 'utf-8');
const pluginSkill = readFileSync(join(root, 'plugins', 'oh-my-codex', 'skills', 'best-practice-research', 'SKILL.md'), 'utf-8');

describe('best-practice-research skill contract', () => {
  it('defines a bounded wrapper without replacing researcher', () => {
    assert.match(skill, /^---\nname: best-practice-research/m);
    assert.match(skill, /workflow wrapper/i);
    assert.match(skill, /not a new research authority/i);
    assert.match(skill, /does not replace `researcher`/i);
  });

  it('enforces terminal, read-only behavior by default', () => {
    assert.match(skill, /^## Terminal By Default$/m);
    assert.match(skill, /terminal and read-only by default/i);
    assert.match(skill, /Do not write or edit files, create or amend commits, run mutating commands, or otherwise modify repository state/i);
    assert.match(skill, /even when the question has clear implementation implications/i);
    assert.match(skill, /This skill never implements/i);
  });

  it('hands off to named planning and execution workflows instead of implementing', () => {
    assert.match(skill, /name `\$ralplan` for planning and `\$ultragoal`, `\$team`, or `executor` for execution/i);
    assert.match(skill, /resume only after the user explicitly switches to that workflow/i);
    assert.match(skill, /Resume only when the user explicitly switches to a planning or implementation workflow/i);
  });

  it('preserves specialist routing and source quality boundaries', () => {
    assert.match(skill, /use `explore` first/i);
    assert.match(skill, /Use `researcher` for official\/upstream docs/i);
    assert.match(skill, /Use `dependency-expert` only/i);
    assert.match(skill, /Prefer official documentation, upstream source/i);
    assert.match(skill, /State date\/version context/i);
    assert.match(skill, /third-party summaries as supplemental/i);
  });

  it('keeps plugin mirror in sync with canonical skill', () => {
    assert.equal(pluginSkill, skill);
  });
});
