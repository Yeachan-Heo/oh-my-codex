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
});
