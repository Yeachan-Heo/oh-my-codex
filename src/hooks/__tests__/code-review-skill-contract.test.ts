import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const codeReviewSkill = readFileSync(
  join(__dirname, '../../../skills/code-review/SKILL.md'),
  'utf-8',
);
const reviewerPrompt = readFileSync(
  join(__dirname, '../../../prompts/code-reviewer.md'),
  'utf-8',
);
const architectPrompt = readFileSync(
  join(__dirname, '../../../prompts/architect.md'),
  'utf-8',
);

describe('code-review skill contract', () => {
  it('keeps invocation compatibility and read-only lane roles while routing through runtime operations', () => {
    assert.match(codeReviewSkill, /\$code-review/);
    assert.match(codeReviewSkill, /`code-reviewer` lane/i);
    assert.match(codeReviewSkill, /`architect` lane/i);
    assert.match(codeReviewSkill, /review_start/);
    assert.match(codeReviewSkill, /review_get/);
    assert.match(codeReviewSkill, /review_record_lane/);
    assert.match(codeReviewSkill, /review_finalize/);
    assert.match(codeReviewSkill, /leader submits only `START`/i);
    assert.match(codeReviewSkill, /child submits its own strict `RESULT`/i);
    assert.match(codeReviewSkill, /PostToolUse hook attests the actual child/i);
    assert.match(codeReviewSkill, /read-only/i);
  });

  it('requires strict native lane labels and forbids authoring-lane fallback approval', () => {
    assert.match(codeReviewSkill, /task_name.+exactly equal to the planned `lane_id`/is);
    assert.match(codeReviewSkill, /Do not self-review as a fallback/i);
    assert.match(codeReviewSkill, /do \*\*not\*\* substitute the current\/authoring lane/i);
    assert.match(codeReviewSkill, /independent review unavailable/i);
  });

  it('documents schema-valid runtime artifact output without duplicating the verdict truth table', () => {
    assert.match(codeReviewSkill, /schema-valid finalized artifact/i);
    assert.match(codeReviewSkill, /runtime coordinator owns the verdict truth table/i);
    assert.match(codeReviewSkill, /JSON: \.omx\/reviews\/<review_id>\.json/i);
    assert.match(codeReviewSkill, /Markdown: \.omx\/reviews\/<review_id>\.md/i);
    assert.doesNotMatch(codeReviewSkill, /If architect status is \*\*BLOCK\*\*, final recommendation is \*\*REQUEST CHANGES\*\*/i);
  });

  it('makes reviewer prompt consume frozen runtime scope and emit strict RESULT diagnostics', () => {
    assert.match(reviewerPrompt, /frozen manifest/i);
    assert.match(reviewerPrompt, /assigned batch files/i);
    assert.match(reviewerPrompt, /scope_hash/i);
    assert.match(reviewerPrompt, /Do not discover an independent scope/i);
    assert.match(reviewerPrompt, /DiagnosticSubmission/i);
    assert.match(reviewerPrompt, /review_record_lane/i);
    assert.doesNotMatch(reviewerPrompt, /Run `git diff`/i);
  });

  it('makes architect prompt consume only global frozen scope and return no diagnostics', () => {
    assert.match(architectPrompt, /global frozen manifest/i);
    assert.match(architectPrompt, /batch plan/i);
    assert.match(architectPrompt, /scope_hash/i);
    assert.match(architectPrompt, /do not discover an independent scope/i);
    assert.match(architectPrompt, /no diagnostics/i);
    assert.match(architectPrompt, /architectural_status `CLEAR`, `WATCH`, or `BLOCK`/i);
  });
});
