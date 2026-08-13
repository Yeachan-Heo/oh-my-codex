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

function assertSlimUltragoalCard(doc: string): void {
  assert.ok(doc.split(/\r?\n/).length <= 120, 'Ultragoal skill cards must stay concise');
  assert.match(doc, /AGENTS\.md#durable-runtime-invariants-canonical-ssot/);
  assert.match(doc, /Durable artifacts are `\.omx\/ultragoal\/brief\.md`, `\.omx\/ultragoal\/goals\.json`, and `\.omx\/ultragoal\/ledger\.jsonl`/);
  assert.match(doc, /aggregate Codex goal mode by default/i);
  assert.match(doc, /get_goal/);
  assert.match(doc, /create_goal/);
  assert.match(doc, /update_goal/);
  assert.match(doc, /Do not call (?:Codex )?`\/goal clear` from shell or this skill/i);
  assert.match(doc, /checkpoint/);
  assert.match(doc, /--codex-goal-json/);
  assert.match(doc, /For intermediate aggregate stories, keep the Codex goal active and checkpoint/i);
  assert.match(doc, /final story[\s\S]{0,220}fresh complete snapshot/i);
  assert.match(doc, /omx ultragoal steer/);
  for (const kind of [
    'add_subgoal',
    'split_subgoal',
    'reorder_pending',
    'revise_pending_wording',
    'annotate_ledger',
    'mark_blocked_superseded',
  ]) {
    assert.match(doc, new RegExp(kind));
  }
  assert.match(doc, /ordinary prose does not mutate/i);
  assert.match(doc, /Optional Team bridge/);
  assert.match(doc, /separate Team command/);
  assert.match(doc, /leader records the Ultragoal checkpoint with a fresh `get_goal` snapshot/i);
}

describe('ultragoal docs contract', () => {
  it('documents aggregate goal ownership and the Codex state boundary', () => {
    const doc = loadDoc('docs/ultragoal.md');

    assert.match(doc, /default to \*\*aggregate Codex goal mode\*\*/i);
    assert.match(doc, /Codex gets one objective for the whole ultragoal run/i);
    assert.match(doc, /\.omx\/ultragoal\/goals\.json/);
    assert.match(doc, /\.omx\/ultragoal\/ledger\.jsonl/);
    assert.match(doc, /get_goal/);
    assert.match(doc, /create_goal/);
    assert.match(doc, /update_goal/);
    assert.match(doc, /does \*\*not\*\* call Codex `\/goal clear`/i);
    assert.match(doc, /manual(?:ly)? run `\/goal clear`/i);

    const ssot = loadDoc('templates/AGENTS.md');
    assert.match(ssot, /Durable Runtime Invariants \(canonical SSOT\)/);
    assert.match(ssot, /Ultragoal ownership/);
    assert.match(ssot, /leader-owned plan/);
    assert.match(ssot, /fresh `get_goal` snapshot/);
  });

  it('keeps the source and plugin Ultragoal cards concise and semantically aligned', () => {
    const docs = [
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];

    assert.equal(docs[0], docs[1], 'plugin Ultragoal card must mirror the canonical source');
    for (const doc of docs) assertSlimUltragoalCard(doc);
  });

  it('documents the completed legacy Codex-goal blocked checkpoint workaround', () => {
    const doc = loadDoc('docs/ultragoal.md');

    assert.match(doc, /checkpoint --goal-id\s+\S+\s+--status blocked/);
    assert.match(doc, /`goal_blocked`/);
    assert.match(doc, /no Codex goal-tool reset\/new-goal surface/i);
    assert.match(doc, /Codex goal context/i);
    assert.match(doc, /same branch\/worktree/i);
    assert.match(doc, /Active or incomplete wrong Codex goals remain strict mismatch errors/i);
    assert.match(doc, /must not be used to bypass active-goal mismatch protection/i);
    assert.match(doc, /matching native Codex `blocked`|matching native Codex blocked|truthfully `blocked`/i);
  });

  it('keeps the final completion gate operational without copying long prose into the card', () => {
    const docs = [
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];
    for (const doc of docs) {
      assert.match(doc, /Final gate and exit evidence/);
      assert.match(doc, /targeted story verification/);
      assert.match(doc, /ai-slop-cleaner/);
      assert.match(doc, /\$code-review/);
      assert.match(doc, /record-review-blockers/);
      assert.match(doc, /quality-gate-json/);
    }

    const reference = loadDoc('docs/ultragoal.md');
    assert.match(reference, /Mandatory final cleanup and review gate/);
    assert.match(reference, /post-cleaner verification/i);
    assert.match(reference, /codeReview\.independentReview/);
    assert.match(reference, /architectureInvariantGate/);
    assert.match(reference, /APPROVE/);
    assert.match(reference, /CLEAR/);
    assert.doesNotMatch(reference, /not_applicable/);
  });

  it('documents bounded dynamic steering without easier-completion mutations', () => {
    const docs = [
      loadDoc('docs/ultragoal.md'),
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];
    const nativeHooksDoc = loadDoc('docs/codex-native-hooks.md');

    const reference = docs[0];
    assert.match(reference, /Dynamic steering/);
    assert.match(reference, /constraints stay fixed|original brief constraints/i);
    assert.match(reference, /broad natural-language requests[\s\S]{0,80}rejected/i);
    assert.match(reference, /steering_accepted|structured steering audit events/i);
    assert.match(reference, /hard-delete goals/);
    assert.match(reference, /auto-complete work/);
    assert.match(reference, /silently mutate/i);
    assert.match(reference, /UserPromptSubmit/);
    assert.match(reference, /OMX_ULTRAGOAL_STEER/);

    for (const doc of docs.slice(1)) {
      assert.match(doc, /(?:Dynamic|Explicit) steering/);
      assert.match(doc, /omx ultragoal steer/);
      assert.match(doc, /add_subgoal/);
      assert.match(doc, /split_subgoal/);
      assert.match(doc, /reorder_pending/);
      assert.match(doc, /revise_pending_wording/);
      assert.match(doc, /annotate_ledger/);
      assert.match(doc, /mark_blocked_superseded/);
      assert.match(doc, /ordinary prose does not mutate/i);
      assert.match(doc, /structured directives dedupe/i);
    }

    assert.match(nativeHooksDoc, /UserPromptSubmit: bounded ultragoal steering/);
    assert.match(nativeHooksDoc, /Only explicit structured directives/i);
    assert.match(nativeHooksDoc, /does not infer mutations from ordinary prose/i);
    assert.match(nativeHooksDoc, /keyword routing still takes precedence/i);
  });

  it('documents Autopilot as the restored canonical README orchestrator', () => {
    const readme = loadDoc('README.md');

    assert.match(readme, /`\$autopilot` is the first-class canonical orchestrator/);
    assert.match(readme, /`\$deep-interview -> \$ralplan -> \$ultragoal`/);
    assert.match(readme, /defining default/);
    assert.match(readme, /each stage remains independently invocable when earlier input contracts are already satisfied/);
    assert.match(readme, /`\$deep-interview` — iterative Socratic ambiguity clearance/);
    assert.match(readme, /not an alias for `\$plan --interview`/);
    assert.match(readme, /`\$ultragoal` — durable multi-goal execution/);
    assert.match(readme, /Inside an Ultragoal story, use `\$team` only when that story benefits from coordinated parallel execution/);
  });

  it('documents Team as the parallel execution engine while the leader owns checkpoints', () => {
    const docs = [
      loadDoc('docs/ultragoal.md'),
      loadDoc('skills/ultragoal/SKILL.md'),
      loadDoc('plugins/oh-my-codex/skills/ultragoal/SKILL.md'),
    ];

    for (const doc of docs) {
      assert.match(doc, /Team is the parallel execution engine|separate Team command/i);
      assert.match(doc, /leader checkpoints Ultragoal from Team evidence|leader records the Ultragoal checkpoint/i);
      assert.match(doc, /fresh `get_goal` snapshot/i);
      assert.match(doc, /--codex-goal-json/);
    }

    const reference = docs[0];
    assert.match(reference, /\.omx\/ultragoal\/goals\.json/);
    assert.match(reference, /\.omx\/ultragoal\/ledger\.jsonl/);
    assert.match(reference, /workers do not own ultragoal goal state/i);
    assert.match(reference, /no hidden Codex goal mutation/i);
    assert.doesNotMatch(reference, /auto[- ]launches Team/i);
  });
});
