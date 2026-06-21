import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../../');

function loadDoc(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf-8');
}

describe('ultragoal docs contract', () => {
  it('documents aggregate Codex goal mode as the default contract', () => {
    const doc = loadDoc('docs/ultragoal.md');

    assert.match(doc, /default to \*\*aggregate Codex goal mode\*\*/i);
    assert.match(doc, /Codex gets one objective for the whole ultragoal run/i);
    assert.match(doc, /G001\/G002 story state/i);
    assert.match(doc, /does \*\*not\*\* call Codex `\/goal clear`/i);
    assert.match(doc, /manual(?:ly)? run `\/goal clear`/i);
    assert.match(doc, /multiple sequential ultragoal runs/i);
    assert.match(doc, /Intermediate aggregate story checkpoints require a matching `active` Codex snapshot/i);
    assert.match(doc, /Final aggregate story checkpoints require a matching `complete` Codex snapshot/i);
  });

  it('documents sequential same-thread runs and /goal clear limitations in mirrored skill guidance', () => {
    const docs = [
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];

    for (const doc of docs) {
      assert.match(doc, /does not call Codex `\/goal clear`/i);
      assert.match(doc, /does not invoke `\/goal clear` or hidden `thread\/goal\/clear`/i);
      assert.match(doc, /only provides `get_goal`, `create_goal`, and `update_goal`/i);
      assert.match(doc, /multiple sequential ultragoal runs/i);
      assert.doesNotMatch(doc, /fresh (?:Codex )?(?:thread|session)s?/i);
    }
  });

  it('documents the completed legacy Codex-goal blocked checkpoint workaround', () => {
    const doc = loadDoc('docs/ultragoal.md');

    assert.match(doc, /checkpoint --goal-id G001-example --status blocked/);
    assert.match(doc, /`goal_blocked`/);
    assert.match(doc, /no Codex goal-tool reset\/new-goal surface/i);
    assert.match(doc, /Codex goal context/i);
    assert.doesNotMatch(doc, /fresh (?:Codex )?(?:thread|session)s?/i);
    assert.match(doc, /same branch\/worktree/i);
    assert.match(doc, /Active or incomplete wrong Codex goals remain strict mismatch errors/i);
    assert.match(doc, /must not be used to bypass active-goal mismatch protection/i);
  });

  it('documents the mandatory final cleanup and review gate', () => {
    const docs = [
      loadDoc('docs/ultragoal.md'),
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];

    for (const doc of docs) {
      assert.match(doc, /Mandatory final cleanup and review gate/);
      assert.match(doc, /ai-slop-cleaner/);
      assert.match(doc, /passed\/no-op report/);
      assert.match(doc, /post-cleaner verification/i);
      assert.match(doc, /\$code-review/);
      assert.match(doc, /independent review path/i);
      assert.match(doc, /codeReview\.independentReview/);
      assert.match(doc, /architectureInvariantGate/);
      assert.match(doc, /architecture-invariant audit/i);
      assert.match(doc, /implementation, test, and (?:independent )?review evidence/i);
      assert.match(doc, /code-reviewer/);
      assert.match(doc, /architect/);
      assert.match(doc, /same-lane\/self-review/i);
      assert.match(doc, /record-review-blockers/);
      assert.match(doc, /review_blocked/);
      assert.match(doc, /quality-gate-json/);
      assert.match(doc, /APPROVE/);
      assert.match(doc, /CLEAR/);
      assert.doesNotMatch(doc, /not_applicable/);
      assert.doesNotMatch(doc, /On the final story only, call `update_goal/);
    }
  });

  it('documents bounded dynamic steering without easier-completion mutations', () => {
    const docs = [
      loadDoc('docs/ultragoal.md'),
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];
    const nativeHooksDoc = loadDoc('docs/codex-native-hooks.md');

    for (const doc of docs) {
      assert.match(doc, /Dynamic steering/);
      assert.match(doc, /omx ultragoal steer/);
      assert.match(doc, /add_subgoal/);
      assert.match(doc, /split_subgoal/);
      assert.match(doc, /reorder_pending/);
      assert.match(doc, /revise_pending_wording/);
      assert.match(doc, /annotate_ledger/);
      assert.match(doc, /mark_blocked_superseded/);
      assert.match(doc, /aggregate (Codex )?objective|aggregate objective/i);
      assert.match(doc, /constraints stay fixed|original brief constraints/i);
      assert.match(doc, /broad natural-language requests[\s\S]{0,80}rejected/i);
      assert.match(doc, /steering_accepted|structured steering audit events/i);
      assert.match(doc, /hard-delete goals/);
      assert.match(doc, /auto-complete work/);
      assert.match(doc, /silently mutate/i);
      assert.match(doc, /UserPromptSubmit/);
      assert.match(doc, /OMX_ULTRAGOAL_STEER/);
    }

    assert.match(nativeHooksDoc, /UserPromptSubmit: bounded ultragoal steering/);
    assert.match(nativeHooksDoc, /Only explicit structured directives/i);
    assert.match(nativeHooksDoc, /does not infer mutations from ordinary prose/i);
    assert.match(nativeHooksDoc, /keyword routing still takes precedence/i);
  });

  it('documents deep-interview to ralplan to ultragoal as the README default workflow', () => {
    const readme = loadDoc('README.md');

    assert.match(readme, /canonical default workflow with `\$deep-interview`, `\$ralplan`, and `\$ultragoal`/);
    assert.match(readme, /standard workflow built around `\$deep-interview` -> `\$ralplan` -> `\$ultragoal`/);
    assert.match(readme, /\$deep-interview "clarify the authentication change"[\s\S]*\$ralplan "approve the auth plan and review tradeoffs"[\s\S]*\$ultragoal "turn the approved plan into durable Codex goals"/);
    assert.match(readme, /Use `\$team` inside that execution path only when a specific Ultragoal story needs coordinated parallel work/);
    assert.match(readme, /Use `\$ralph` as an intentional alternate completion loop/);
  });

  it('documents Team as the parallel execution engine while leader owns Ultragoal checkpointing', () => {
    const docs = [
      loadDoc('docs/ultragoal.md'),
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];

    for (const doc of docs) {
      assert.match(doc, /use ultragoal and team together/i);
      assert.match(doc, /Team is the parallel execution engine/i);
      assert.match(doc, /leader checkpoints Ultragoal from Team evidence/i);
      assert.match(doc, /\.omx\/ultragoal\/goals\.json/);
      assert.match(doc, /\.omx\/ultragoal\/ledger\.jsonl/);
      assert.match(doc, /fresh `get_goal` snapshot/i);
      assert.match(doc, /--codex-goal-json/);
      assert.match(doc, /workers do not own ultragoal goal state/i);
      assert.match(doc, /no hidden Codex goal mutation/i);
      assert.doesNotMatch(doc, /auto[- ]launches Team/i);
    }
  });
});
