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
  it('requires independent review lanes with explicit scope and unavailable handling', () => {
    assert.match(codeReviewSkill, /Launch the `code-reviewer` and `architect` agents in parallel/i);
    assert.match(codeReviewSkill, /Both lanes run in parallel on a clean context with explicit scope and artifacts/i);
    assert.match(codeReviewSkill, /If either lane cannot be launched or does not return evidence, report `independent review unavailable`/i);
    assert.match(codeReviewSkill, /do \*\*not\*\* substitute the current\/authoring lane/i);
    assert.match(codeReviewSkill, /do \*\*not\*\* approve or mark the review merge-ready/i);
  });

  it('uses native task agent_type examples without overriding user model or effort', () => {
    assert.match(codeReviewSkill, /Respect the user's current model and reasoning\/effort selection/i);
    assert.match(codeReviewSkill, /Do not pass `model` or `reasoning_effort` overrides/i);
    assert.match(codeReviewSkill, /task\(\s*agent_type="code-reviewer",\s*prompt=/s);
    assert.match(codeReviewSkill, /task\(\s*agent_type="architect",\s*prompt=/s);
    assert.doesNotMatch(codeReviewSkill, /task\(\s*agent_type="code-reviewer",\s*(?:model=|reasoning_effort=)/s);
    assert.doesNotMatch(codeReviewSkill, /task\(\s*agent_type="architect",\s*(?:model=|reasoning_effort=)/s);
    assert.doesNotMatch(codeReviewSkill, /delegate\(\s*role=/s);
    assert.doesNotMatch(codeReviewSkill, /tier="/);
  });

  it('frames architect as the devil’s-advocate lane with explicit status values', () => {
    assert.match(codeReviewSkill, /devil['’]s-advocate/i);
    assert.match(codeReviewSkill, /Architectural Status Contract/i);
    assert.match(codeReviewSkill, /Architectural Status: CLEAR \| WATCH \| BLOCK/i);
    assert.match(codeReviewSkill, /If architect status is \*\*BLOCK\*\*, final recommendation is \*\*REQUEST CHANGES\*\*/i);
  });

  it('requires final synthesis across both lanes', () => {
    assert.match(codeReviewSkill, /Final Synthesis/i);
    assert.match(codeReviewSkill, /Combine the `code-reviewer` recommendation and architect status/i);
    assert.match(codeReviewSkill, /Approval requires explicit evidence from both independent lanes/i);
    assert.match(codeReviewSkill, /missing or failed delegation is a blocking unavailable-review state/i);
    assert.match(codeReviewSkill, /final report must make architect blockers impossible to miss/i);
  });

  it('forbids self-review fallback approval when delegation is unavailable', () => {
    assert.match(codeReviewSkill, /Do not self-review as a fallback/i);
    assert.match(codeReviewSkill, /missing, unavailable, skipped, or fails/i);
    assert.match(codeReviewSkill, /block approval until independent lane evidence exists/i);
  });

  it('keeps recommendation mapping deterministic', () => {
    assert.match(codeReviewSkill, /If architect status is \*\*BLOCK\*\*, final recommendation is \*\*REQUEST CHANGES\*\*/i);
    assert.match(codeReviewSkill, /Else if `code-reviewer` recommendation is \*\*REQUEST CHANGES\*\*, final recommendation is \*\*REQUEST CHANGES\*\*/i);
    assert.match(codeReviewSkill, /Else if architect status is \*\*WATCH\*\*, final recommendation is \*\*COMMENT\*\*/i);
    assert.match(codeReviewSkill, /Else final recommendation follows the `code-reviewer` lane/i);
    assert.match(codeReviewSkill, /\*\*APPROVE\*\* only when `code-reviewer` returns APPROVE, architect status is `CLEAR`, both independent lanes returned evidence/i);
    assert.match(codeReviewSkill, /\*\*REQUEST CHANGES\*\* for a blocker, unresolved high\/critical finding, unavailable lane, or non-passing\/unavailable blocking quality gate/i);
  });

  it('bounds auto-fix wording to the supported omx ralph compatibility path only', () => {
    assert.match(codeReviewSkill, /On the supported `omx ralph` CLI compatibility path/i);
    assert.match(codeReviewSkill, /automatic fix follow-up without another permission prompt/i);
    assert.match(codeReviewSkill, /plain `code-review` itself remains read-only and does \*\*not\*\* promise auto-fix/i);
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

  describe('continuation decision table', () => {
    it('defines continuation decision table with five cases', () => {
      assert.match(codeReviewSkill, /Continuation Decision Table/i);
      assert.match(codeReviewSkill, /Fresh Review/i);
      assert.match(codeReviewSkill, /Resuming Missing Lane/i);
      assert.match(codeReviewSkill, /Resuming Missing Validation/i);
      assert.match(codeReviewSkill, /Repair Re-review/i);
      assert.match(codeReviewSkill, /Complete Evidence/i);
    });

    it('distinguishes fresh review from continuation', () => {
      assert.match(codeReviewSkill, /Fresh Review.*no prior receipt.*OR source\/requirements\/gates changed/i);
      assert.match(codeReviewSkill, /Launch both code-reviewer and architect lanes in parallel on clean contexts/i);
    });

    it('covers missing lane resumption with evidence reuse', () => {
      assert.match(codeReviewSkill, /Resuming Missing Lane.*one lane has evidence, other missing/i);
      assert.match(codeReviewSkill, /Re-launch the missing lane only/i);
      assert.match(codeReviewSkill, /Carry prior evidence from the complete lane/i);
    });

    it('covers incomplete validation collection', () => {
      assert.match(codeReviewSkill, /Resuming Missing Validation.*both lanes returned, validation incomplete/i);
      assert.match(codeReviewSkill, /Collect missing validation inputs\/results/i);
      assert.match(codeReviewSkill, /Reuse lane evidence/i);
    });

    it('covers repair re-review with source change', () => {
      assert.match(codeReviewSkill, /Repair Re-review.*implementation changed source.*authorized repair owner/i);
      assert.match(codeReviewSkill, /Re-launch both lanes on the revised scope/i);
      assert.match(codeReviewSkill, /Include prior findings as context/i);
    });

    it('covers complete evidence termination', () => {
      assert.match(codeReviewSkill, /Complete Evidence.*all lanes returned, all validation complete/i);
      assert.match(codeReviewSkill, /Return the existing scoped result and stop/i);
    });

    it('enforces binding rules for evidence reuse', () => {
      assert.match(codeReviewSkill, /Binding Rules/i);
      assert.match(codeReviewSkill, /source-bound receipt tracks scope identity/i);
      assert.match(codeReviewSkill, /Missing or unverifiable bindings.*prevent evidence reuse/i);
    });
  });

  describe('source-bound review receipt', () => {
    it('defines receipt structure with scope, source, gates, lanes, and validation', () => {
      assert.match(codeReviewSkill, /Source-Bound Review Receipt/i);
      assert.match(codeReviewSkill, /REVIEW SCOPE/i);
      assert.match(codeReviewSkill, /SOURCE IDENTITY/i);
      assert.match(codeReviewSkill, /REQUIREMENTS & GATES/i);
      assert.match(codeReviewSkill, /LANE RESULTS/i);
      assert.match(codeReviewSkill, /VALIDATION/i);
      assert.match(codeReviewSkill, /FINDINGS & GAPS/i);
      assert.match(codeReviewSkill, /FINAL RECOMMENDATION/i);
    });

    it('records scope identity including uncommitted changes', () => {
      assert.match(codeReviewSkill, /Files Reviewed/i);
      assert.match(codeReviewSkill, /Changed Lines/i);
      assert.match(codeReviewSkill, /Base Commit/i);
      assert.match(codeReviewSkill, /Uncommitted Changes.*file hashes if present/i);
    });

    it('tracks source binding status and invalidation triggers', () => {
      assert.match(codeReviewSkill, /Source Binding: <valid\|stale\|unbound>/i);
      assert.match(codeReviewSkill, /Invalidation Triggers/i);
      assert.match(codeReviewSkill, /Base commit or uncommitted changes differ/i);
      assert.match(codeReviewSkill, /Requirements or acceptance criteria are updated/i);
      assert.match(codeReviewSkill, /Configured quality gates change/i);
      assert.match(codeReviewSkill, /Validation inputs\/results are unavailable or stale/i);
      assert.match(codeReviewSkill, /Required lanes.*are missing or unavailable/i);
    });

    it('records each lane result with recommendation, findings, and artifact', () => {
      assert.match(codeReviewSkill, /code-reviewer:\s*Recommendation:/i);
      assert.match(codeReviewSkill, /Finding Severity.*CRITICAL.*HIGH.*MEDIUM.*LOW/i);
      assert.match(codeReviewSkill, /Artifact:.*reference or hash/i);
      assert.match(codeReviewSkill, /architect:\s*Status: CLEAR \| WATCH \| BLOCK/i);
    });

    it('records custom gate results with mode and verdict', () => {
      assert.match(codeReviewSkill, /\[custom gates\]:/i);
      assert.match(codeReviewSkill, /Gate Name.*skill name/i);
      assert.match(codeReviewSkill, /Mode: blocking \| advisory/i);
      assert.match(codeReviewSkill, /Verdict: pass \| fail \| unavailable/i);
    });

    it('distinguishes binding status and prevents unverifiable approval', () => {
      assert.match(codeReviewSkill, /Reuse Rules.*Evidence may be reused.*only if all binding conditions match/i);
      assert.match(codeReviewSkill, /Missing or unverifiable bindings never establish approval/i);
    });
  });
});
