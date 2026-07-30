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
    assert.match(codeReviewSkill, /clean context/i);
    assert.match(codeReviewSkill, /explicit scope and artifacts/i);
    assert.match(codeReviewSkill, /`code-reviewer` lane/i);
    assert.match(codeReviewSkill, /`architect` lane/i);
    assert.match(codeReviewSkill, /If either lane cannot be launched or does not return evidence/i);
    assert.match(codeReviewSkill, /do \*\*not\*\* substitute the current\/authoring lane/i);
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
    assert.match(codeReviewSkill, /Approval requires explicit evidence from both independent lanes/i);
    assert.match(codeReviewSkill, /missing or failed delegation is a blocking unavailable-review state/i);
    assert.match(codeReviewSkill, /final report must make architect blockers impossible to miss/i);
  });

  it('forbids self-review fallback approval when delegation is unavailable', () => {
    assert.match(codeReviewSkill, /Do not self-review as a fallback/i);
    assert.match(codeReviewSkill, /missing, unavailable, skipped, or fails/i);
    assert.match(codeReviewSkill, /block approval until the independent lane evidence exists/i);
  });

  it('keeps approval criteria aligned with the deterministic synthesis contract', () => {
    assert.match(codeReviewSkill, /\*\*APPROVE\*\* - `code-reviewer` returns APPROVE, architect status is `CLEAR`, and both independent lanes returned evidence/i);
    assert.match(codeReviewSkill, /\*\*REQUEST CHANGES\*\* - `code-reviewer` returns REQUEST CHANGES, architect status is `BLOCK`, or required independent review delegation is unavailable\/skipped\/failed/i);
    assert.match(codeReviewSkill, /\*\*COMMENT\*\* - `code-reviewer` returns COMMENT with architect status `CLEAR`, architect status is `WATCH`, or only LOW\/MEDIUM improvements remain/i);
  });

  it('bounds auto-fix wording to the explicit ralph path only', () => {
    assert.match(codeReviewSkill, /On the explicit Ralph path/i);
    assert.match(codeReviewSkill, /automatic fix follow-up without another permission prompt/i);
    assert.match(codeReviewSkill, /Plain `code-review` itself remains read-only and does \*\*not\*\* promise auto-fix/i);
  });

  it('keeps publication explicit, fail-closed, and outside Autopilot/pipeline review', () => {
    assert.match(codeReviewSkill, /Plain `\$code-review` is local and read-only/i);
    assert.match(codeReviewSkill, /Autopilot and pipeline review phases also remain read-only/i);
    assert.match(codeReviewSkill, /omx code-review --github-pr <number> --findings <artifact\.json>/i);
    assert.match(codeReviewSkill, /--publish/i);
    assert.match(codeReviewSkill, /exact current head SHA/i);
    assert.match(codeReviewSkill, /rejects the entire set/i);
    assert.match(codeReviewSkill, /exactly one REST create-review request/i);
    assert.match(codeReviewSkill, /never falls back to timeline comments/i);
    assert.match(codeReviewSkill, /never retries an ambiguous write failure/i);
    assert.match(codeReviewSkill, /never resolves threads/i);
		assert.match(codeReviewSkill, /re-reads the PR immediately before any receipt or review write/i);
		assert.match(codeReviewSkill, /reads the stored review and its paginated review-comments endpoint/i);
		assert.match(codeReviewSkill, /Every `gh api` read and write includes `--hostname github\.com`/i);
		assert.match(codeReviewSkill, /Immediately after validating that ID, the command re-reads the current PR head/i);
		assert.match(codeReviewSkill, /original_commit_id/i);
		assert.match(codeReviewSkill, /original_line/i);
		assert.match(codeReviewSkill, /canonical guard is durably finalized as ambiguous/i);
		assert.match(codeReviewSkill, /atomic rename, directory fsync/i);
		assert.match(codeReviewSkill, /publish_unsupported_platform/i);
		assert.match(codeReviewSkill, /crash durability is not claimed on Windows/i);
		assert.match(codeReviewSkill, /canonical guard under `<cwd>\/\.omx\/reviews\/guards\/`/i);
		assert.match(codeReviewSkill, /guard-<64 lowercase hex>\.json/i);
		assert.match(codeReviewSkill, /complete canonical identity/i);
		assert.match(codeReviewSkill, /separate guard and receipt domains/i);
		assert.match(codeReviewSkill, /retains the full readable identity and artifact hash/i);
		assert.match(codeReviewSkill, /ENAMETOOLONG.*publish_guard_reservation_failed/i);
		assert.match(codeReviewSkill, /custom receipt changes only the separate destination receipt/i);
		assert.match(codeReviewSkill, /Any existing pending, ambiguous, final, or stale guard blocks publication/i);
		assert.match(codeReviewSkill, /canonical guard already contains final, stale, or conservative ambiguous evidence/i);
		assert.match(codeReviewSkill, /publish_ambiguous_response/i);
		assert.match(codeReviewSkill, /mode: "publish-stale"/i);
		assert.match(codeReviewSkill, /post_submit_stale_head/i);
		assert.match(codeReviewSkill, /observed stored count/i);
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
