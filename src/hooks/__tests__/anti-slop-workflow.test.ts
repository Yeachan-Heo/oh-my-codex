import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

function assertMatchesAll(content: string, patterns: RegExp[]): void {
  for (const pattern of patterns) {
    assert.match(content, pattern);
  }
}

function assertCanonicalPluginParity(path: string): void {
  const pluginPath = `plugins/oh-my-codex/${path}`;
  assert.ok(existsSync(join(repoRoot, pluginPath)), `${pluginPath} must exist in the plugin mirror`);
  assert.equal(read(pluginPath), read(path), `${path} must match the plugin mirror exactly`);
}

describe('anti-slop workflow surfaces', () => {
  it('keeps the cleaner a bounded helper with file-list and calling-task scope rules', () => {
    const skill = read('skills/ai-slop-cleaner/SKILL.md');
    assertCanonicalPluginParity('skills/ai-slop-cleaner/SKILL.md');
    assert.ok(skill.trimEnd().split(/\r?\n/).length <= 120, 'task card must stay within the prompt size limit');
    assert.match(skill, /bounded helper.*not as a competing top-level\s+workflow/is);
    assert.match(skill, /A file list scope is valid; keep the pass bounded\s+to it/i);
    assert.match(skill, /Limit the pass to the calling task's changed files unless broader cleanup was requested/i);
    assert.match(skill, /requested\s+feature\/files and behavior to preserve/i);
  });

  it('requires behavior locking, fallback classification, and smell-focused passes', () => {
    const skill = read('skills/ai-slop-cleaner/SKILL.md');
    assert.match(skill, /Lock behavior with regression tests first/i);
    assert.match(skill, /Create a cleanup plan before code/i);
    assert.match(skill, /Inventory fallback-like code.*in scope/i);
    assert.match(skill, /Masking fallback slop/i);
    assert.match(skill, /Grounded compatibility\/fail-safe fallback/i);
    assert.match(skill, /primary.*fallback/i);
    assert.match(skill, /root-cause repair, deletion, boundary repair, or explicit failure behavior/i);
    assert.match(skill, /broad\/ambiguous\/cross-layer\/architectural findings.*\$ralplan/i);
    assert.match(skill, /do not spawn a nested `\$ralplan`/i);

    for (const smell of [
      /Fallback-like code/i,
      /Duplication/i,
      /Dead code/i,
      /Needless abstraction/i,
      /Boundary violations/i,
      /Missing tests/i,
      /UI\/design slop/i,
    ]) {
      assert.match(skill, smell);
    }

    for (const pass of [
      /fallback-like code resolution gate/i,
      /Pass 1: Dead code deletion/i,
      /Pass 2: Duplicate removal/i,
      /Pass 3: Naming\/error\s+handling cleanup/i,
      /Pass 4: Test reinforcement/i,
    ]) {
      assert.match(skill, pass);
    }
  });

  it('requires evidence-dense output and an explicit cleanup stop condition', () => {
    const skill = read('skills/ai-slop-cleaner/SKILL.md');
    assert.match(skill, /AI SLOP CLEANUP REPORT/i);
    for (const field of [
      /Scope:/i,
      /Behavior Lock:/i,
      /Cleanup Plan:/i,
      /Fallback Findings:/i,
      /Passes Completed:/i,
      /Quality Gates:/i,
      /Changed Files:/i,
      /Remaining Risks:/i,
    ]) {
      assert.match(skill, field);
    }
    assert.match(skill, /writer\/reviewer separation/i);
    assert.match(skill, /behavior-lock evidence/i);
    assert.match(skill, /each selected smell pass is\s+complete or explicitly deferred/i);
    assert.match(skill, /Never present an unverified cleanup as\s+complete/i);
  });

  it('documents plan review mode and sunset stub for removed review skill', () => {
    assertCanonicalPluginParity('skills/plan/SKILL.md');

    const planSkill = read('skills/plan/SKILL.md');

    assertMatchesAll(planSkill, [
      /### Review \(`--review`\)/,
      /Critic evaluation/i,
      /APPROVED\/REVISE\/REJECT/i,
    ]);

    const sunset = read('src/hooks/sunset-stub.ts');
    assert.match(sunset, /"review":/);
    assert.match(sunset, /removed.*Use \"\$code-review\"/i);
  });
});
