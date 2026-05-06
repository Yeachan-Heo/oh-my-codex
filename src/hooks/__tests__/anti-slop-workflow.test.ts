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

const antiSlopWorkingAgreementPatterns = [
  /^## Working agreements$/m,
  /^- For cleanup\/refactor\/deslop work, write a cleanup plan and lock behavior with regression tests before editing when coverage is missing\.$/m,
  /^- Prefer deletion, existing utilities, and existing patterns before new abstractions; add dependencies only when explicitly requested\.$/m,
  /^- Keep diffs small, reviewable, and reversible\.$/m,
  /^- Verify with lint, typecheck, tests, and static analysis after changes; final reports include changed files, simplifications, and remaining risks\.$/m,
];

const antiSlopWorkflowPatterns = [
  /^Anti-slop workflow:$/m,
  /^- Cleanup\/refactor\/deslop work still follows the same `\$deep-interview` -> `\$ralplan` -> `\$team`\/`\$ralph` path; use `\$ai-slop-cleaner` as a bounded helper inside the chosen execution lane, not as a competing top-level workflow\.$/m,
  /^- Write a cleanup plan before modifying code; lock existing behavior with regression tests first, then make one smell-focused pass at a time\.$/m,
  /^- Prefer deletion over addition, and prefer reuse plus boundary repair over new layers\.$/m,
  /^- No new dependencies without explicit request\.$/m,
  /^- Run lint, typecheck, tests, and static analysis before claiming completion\.$/m,
  /^- Keep writer\/reviewer pass separation for cleanup plans and approvals; preserve writer\/reviewer pass separation explicitly\.$/m,
];

const aiSlopCleanerWorkflowPatterns = [
  /^Reduce AI-generated slop with a regression-tests-first, smell-by-smell cleanup workflow that preserves behavior and raises signal quality\.$/m,
  /^## Scoped File Lists and Ralph Workflow$/m,
  /^- This skill can accept a \*\*file list scope\*\* instead of a whole feature area\.$/m,
  /^- In the \*\*Ralph workflow\*\*, the mandatory deslop pass should run this skill on Ralph's changed files only, in standard mode unless the caller explicitly requests otherwise\.$/m,
  /^1\. \*\*Lock behavior with regression tests first\*\*$/m,
  /^   - For fallback-like code, cover the primary path and any preserved compatibility\/fail-safe fallback before cleanup$/m,
  /^2\. \*\*Create a cleanup plan before code\*\*$/m,
  /^   - Include fallback findings, classifications, and escalation status in the plan$/m,
  /^3\. \*\*Inventory fallback-like code before editing\*\*$/m,
  /^   - Search the requested scope for fallback-like detection signals: quick hacks?, temporary workaround, temporary fallback, just bypass, just skip, fallback if it fails, swallowed errors, silent defaults, broad compatibility shims, and duplicate alternate execution paths$/m,
  /^   - Classify each finding before changing it:$/m,
  /^     - \*\*Masking fallback slop\*\* — hides errors or evidence, bypasses the primary contract, suppresses tests or validation, swallows failures, silently defaults, or adds untested alternate paths$/m,
  /^     - \*\*Grounded compatibility\/fail-safe fallback\*\* — is scoped to an external\/version\/fail-safe boundary, documents the rationale, preserves failure evidence, and has regression tests for both the primary and fallback behavior$/m,
  /^   - Prefer root-cause repair, deletion, boundary repair, or explicit failure behavior before preserving fallback paths$/m,
  /^   - For broad, ambiguous, cross-layer, or architectural fallback-like code, invoke `\$ralplan` for consensus resolution before edits$/m,
  /^   - Recursion guard: when already inside ralplan, ralph, team, or another OMX workflow, do not spawn a nested `\$ralplan`; record the finding and attach it to the active ralplan, leader, or plan handoff instead$/m,
  /^4\. \*\*Categorize issues before editing\*\*$/m,
  /^   - \*\*Fallback-like code\*\* — masking fallbacks, workaround branches, bypasses, swallowed errors, silent defaults, broad shims, alternate execution paths$/m,
  /^   - \*\*Duplication\*\* — repeated logic, copy-paste branches, redundant helpers$/m,
  /^   - \*\*Dead code\*\* — unused code, unreachable branches, stale flags, debug leftovers$/m,
  /^   - \*\*Needless abstraction\*\* — pass-through wrappers, speculative indirection, single-use helper layers$/m,
  /^   - \*\*Boundary violations\*\* — hidden coupling, leaky responsibilities, wrong-layer imports or side effects$/m,
  /^5\. \*\*Execute passes one smell at a time\*\*$/m,
  /^   - \*\*Fallback-like code resolution gate\*\* — remove masking fallback slop, repair root causes, or escalate ambiguous cases before continuing$/m,
  /^   - \*\*Pass 1: Dead code deletion\*\*$/m,
  /^   - \*\*Pass 2: Duplicate removal\*\*$/m,
  /^   - \*\*Pass 3: Naming\/error handling cleanup\*\*$/m,
  /^   - \*\*Pass 4: Test reinforcement\*\*$/m,
  /^6\. \*\*Run quality gates\*\*$/m,
  /^   - Regression tests stay green$/m,
  /^   - Static\/security scan passes when available$/m,
  /^7\. \*\*Finish with an evidence-dense report\*\*$/m,
  /^   - Changed files$/m,
  /^   - Fallback findings, classifications, and escalation status$/m,
  /^   - Remaining risks$/m,
];

describe('anti-slop workflow surfaces', () => {
  it('adds durable anti-slop guidance to AGENTS surfaces', () => {
    const templateContent = read('templates/AGENTS.md');
    assertMatchesAll(templateContent, antiSlopWorkingAgreementPatterns);
    assertMatchesAll(templateContent, antiSlopWorkflowPatterns);

    if (existsSync(join(repoRoot, 'AGENTS.md'))) {
      const content = read('AGENTS.md');
      if (/^## Working agreements$/m.test(content)) {
        assertMatchesAll(content, antiSlopWorkingAgreementPatterns);
      }
    }
  });

  it('documents reviewer-only separation in review and plan review mode', () => {
    assertCanonicalPluginParity('skills/plan/SKILL.md');

    const reviewSkill = read('skills/review/SKILL.md');
    const planSkill = read('skills/plan/SKILL.md');

    assertMatchesAll(reviewSkill, [
      /Hard-deprecated/i,
      /Do not invoke or route this skill/i,
      /Use `\$code-review` directly/i,
    ]);

    assertMatchesAll(planSkill, [
      /### Review Mode \(`--review`\)/,
      /reviewer-only\s+pass/i,
      /MUST\s+NOT\s+be\s+the\s+context\s+that\s+approves\s+it/i,
      /cleanup\s+plan,\s*regression\s+tests/i,
    ]);
  });

  it('defines the built-in ai-slop-cleaner workflow', () => {
    const skill = read('skills/ai-slop-cleaner/SKILL.md');
    const pluginSkill = read('plugins/oh-my-codex/skills/ai-slop-cleaner/SKILL.md');
    assert.equal(pluginSkill, skill);
    assertMatchesAll(skill, aiSlopCleanerWorkflowPatterns);
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
    assert.match(skill, /fallback-like (?:inventory|detection|code)/i);
    assert.match(skill, /quick hack/i);
    assert.match(skill, /temporary workaround/i);
    assert.match(skill, /temporary fallback/i);
    assert.match(skill, /just bypass/i);
    assert.match(skill, /fallback if it fails/i);
    assert.match(skill, /swallowed errors/i);
    assert.match(skill, /silent defaults/i);
    assert.match(skill, /broad compatibility shims/i);
    assert.match(skill, /alternate execution paths/i);
    assert.match(skill, /Masking fallback slop/i);
    assert.match(skill, /Grounded compatibility\/fail-safe fallback/i);
    assert.match(skill, /root-cause repair/i);
    assert.match(skill, /explicit failure behavior/i);
    assert.match(skill, /\$ralplan/);
    assert.match(skill, /consensus resolution/i);
    assert.match(skill, /Recursion guard/i);
    assert.match(skill, /do not spawn a nested `?\$ralplan`?/i);
    assert.match(skill, /active ralplan/i);
    assert.match(skill, /Fallback Findings/i);
    assert.match(skill, /classifications/i);
    assert.match(skill, /escalation status/i);
  });
});
