import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const surfaces = ['templates/AGENTS.md', 'AGENTS.md'];

describe('lean global harness guidance', () => {
  for (const path of surfaces) {
    it(`${path} preserves the lean route and independent authority`, async () => {
      const text = await readFile(path, 'utf8');
      assert.match(text, /one capable owner|solo execute/i);
      assert.match(text, /compact task packet/i);
      assert.match(text, /do not.*all-turn|never.*full.*mature.*conversation/i);
      assert.match(text, /premise.*gate|caller-visible behaviour.*assumptions/i);
      assert.match(text, /same failure.*twice|re-localise/i);
      assert.match(text, /RED author.*fresh context/i);
      assert.match(text, /implementer.*(must not|no authority).*weaken/i);
      assert.match(text, /verifier.*fresh context/i);
      assert.match(text, /local\s*\|\s*cross-file\s*\|\s*repository/i);
      assert.match(text, /risk.*confidence/i);
      assert.match(text, /at most one cheap probe/i);
      assert.match(text, /smallest reliable path/i);
      assert.match(text, /expand one boundary at a time/i);
      assert.match(text, /focused verification fails.*confidence drops/i);
      assert.match(text, /reus(?:e|ing).*evidence/i);
    });
  }
});
