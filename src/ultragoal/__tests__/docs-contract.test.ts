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
    assert.match(doc, /Intermediate aggregate story checkpoints require a matching `active` Codex snapshot/i);
    assert.match(doc, /Final aggregate story checkpoints require a matching `complete` Codex snapshot/i);
  });

  it('documents the completed legacy Codex-goal blocked checkpoint workaround', () => {
    const doc = loadDoc('docs/ultragoal.md');

    assert.match(doc, /checkpoint --goal-id G001-example --status blocked/);
    assert.match(doc, /`goal_blocked`/);
    assert.match(doc, /no Codex goal-tool reset\/new-goal surface/i);
    assert.match(doc, /fresh Codex thread/i);
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
      assert.match(doc, /record-review-blockers/);
      assert.match(doc, /review_blocked/);
      assert.match(doc, /quality-gate-json/);
      assert.match(doc, /APPROVE/);
      assert.match(doc, /CLEAR/);
      assert.doesNotMatch(doc, /not_applicable/);
      assert.doesNotMatch(doc, /On the final story only, call `update_goal/);
    }
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
