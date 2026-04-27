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

describe('code-review skill contract', () => {
  it('requires parallel code-reviewer and architect lanes', () => {
    assert.match(codeReviewSkill, /`code-reviewer` and `architect` agents in parallel/i);
    assert.match(codeReviewSkill, /Both lanes run in parallel/i);
    assert.match(codeReviewSkill, /`code-reviewer` lane/i);
    assert.match(codeReviewSkill, /`architect` lane/i);
  });

  it('frames architect as the devil’s-advocate lane with deterministic blocker status', () => {
    assert.match(codeReviewSkill, /devil['’]s-advocate/i);
    assert.match(codeReviewSkill, /Architectural Status Contract/i);
    assert.match(codeReviewSkill, /CLEAR/i);
    assert.match(codeReviewSkill, /WATCH/i);
    assert.match(codeReviewSkill, /BLOCK/i);
    assert.match(codeReviewSkill, /If architect status is \*\*BLOCK\*\*, final recommendation is \*\*REQUEST CHANGES\*\*/i);
  });

  it('requires final synthesis across both lanes', () => {
    assert.match(codeReviewSkill, /Final Synthesis/i);
    assert.match(codeReviewSkill, /Combine the `code-reviewer` recommendation and the architect status/i);
    assert.match(codeReviewSkill, /final report must make architect blockers impossible to miss/i);
  });

  it('keeps approval criteria aligned with the deterministic synthesis contract', () => {
    assert.match(codeReviewSkill, /\*\*APPROVE\*\* - `code-reviewer` returns APPROVE and architect status is `CLEAR`/i);
    assert.match(codeReviewSkill, /\*\*REQUEST CHANGES\*\* - `code-reviewer` returns REQUEST CHANGES or architect status is `BLOCK`/i);
    assert.match(codeReviewSkill, /\*\*COMMENT\*\* - `code-reviewer` returns COMMENT with architect status `CLEAR`, architect status is `WATCH`, or only LOW\/MEDIUM improvements remain/i);
  });

  it('bounds auto-fix wording to the explicit ralph path only', () => {
    assert.match(codeReviewSkill, /On the explicit Ralph path/i);
    assert.match(codeReviewSkill, /automatic fix follow-up without another permission prompt/i);
    assert.match(codeReviewSkill, /Plain `code-review` itself remains read-only and does \*\*not\*\* promise auto-fix/i);
  });

  it('keeps the sample output consistent with a WATCH and COMMENT outcome', () => {
    const totalIssues = codeReviewSkill.match(/Total Issues: (\d+)/i);
    const criticalCount = codeReviewSkill.match(/CRITICAL \((\d+)\)/i);
    assert.match(codeReviewSkill, /HIGH \(0\)/i);
    const highCount = codeReviewSkill.match(/HIGH \((\d+)\)/i);
    const mediumCount = codeReviewSkill.match(/MEDIUM \((\d+)\)/i);
    const lowCount = codeReviewSkill.match(/LOW \((\d+)\)/i);
    assert.match(codeReviewSkill, /- code-reviewer recommendation: COMMENT/i);
    assert.match(codeReviewSkill, /RECOMMENDATION: COMMENT/i);
    assert.doesNotMatch(codeReviewSkill, /Risk: SQL injection vulnerability/i);
    assert.doesNotMatch(codeReviewSkill, /Risk: Credential exposure/i);
    assert.ok(totalIssues && criticalCount && highCount && mediumCount && lowCount);
    assert.equal(
      Number(totalIssues[1]),
      Number(criticalCount[1]) +
        Number(highCount[1]) +
        Number(mediumCount[1]) +
        Number(lowCount[1]),
    );
  });
});
