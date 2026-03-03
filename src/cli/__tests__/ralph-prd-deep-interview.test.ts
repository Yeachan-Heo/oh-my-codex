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
});
