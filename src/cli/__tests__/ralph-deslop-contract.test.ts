import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ralphSkill = readFileSync(join(__dirname, '../../../skills/ralph/SKILL.md'), 'utf-8');

describe('ralph deslop workflow contract', () => {
  it('requires a mandatory deslop pass after architect verification', () => {
    assert.match(ralphSkill, /Step 7\.5/i);
    assert.match(ralphSkill, /Mandatory Deslop Pass/i);
    assert.match(ralphSkill, /oh-my-codex:ai-slop-cleaner/i);
    assert.match(ralphSkill, /changed files only/i);
    assert.match(ralphSkill, /standard mode/i);
    assert.match(ralphSkill, /not `--review`/i);
  });

  it('requires post-deslop regression re-verification', () => {
    assert.match(ralphSkill, /Step 7\.6/i);
    assert.match(ralphSkill, /Regression Re-verification/i);
    assert.match(ralphSkill, /re-run all tests\/build\/lint/i);
    assert.match(ralphSkill, /roll back cleaner changes or fix and retry/i);
  });

  it('extends the final checklist with deslop completion and post-deslop regression proof', () => {
    assert.match(
      ralphSkill,
      /\[ \] ai-slop-cleaner pass completed on changed files \(or --no-deslop specified\)/i,
    );
    assert.match(ralphSkill, /\[ \] Post-deslop regression tests pass/i);
  });
});
