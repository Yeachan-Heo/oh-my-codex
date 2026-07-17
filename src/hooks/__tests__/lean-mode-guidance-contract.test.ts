import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('lean mode guidance', () => {
  it('keeps Ralph persistent without mandatory fan-out or cleanup', async () => {
    const text = await readFile('skills/ralph/SKILL.md', 'utf8');
    assert.match(text, /start with one owner/i);
    assert.match(text, /ultrawork.*only.*independent/i);
    assert.match(text, /architect.*(security|shared public|weak oracle|risk)/i);
    assert.match(text, /ai-slop-cleaner.*conditional/i);
    assert.match(text, /same failure.*twice|re-localise/i);
  });

  it('does not reject low-risk Ralph completion solely for no architect verification', async () => {
    const text = await readFile('skills/ralph/SKILL.md', 'utf8');
    assert.doesNotMatch(text, /no architect verification/i);
  });

  it('makes Autopilot phase compute adaptive', async () => {
    const text = await readFile('skills/autopilot/SKILL.md', 'utf8');
    assert.match(text, /reuse.*approved spec/i);
    assert.match(text, /one planning owner/i);
    assert.match(text, /execute solo.*one owned lane/i);
    assert.match(text, /reviewer.*risk|risk-matched reviewer/i);
  });

  it('does not make parallel implementation or an architect pipeline inherent to Autopilot', async () => {
    const text = await readFile('skills/autopilot/SKILL.md', 'utf8');
    const legacyClaims = [
      /implementing in parallel/i,
      /RALPLAN.*team-exec.*ralph-verify.*architect verification/i,
    ];
    const contradictions = legacyClaims.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
    assert.deepEqual(contradictions, []);
  });

  it('makes Ecomode reduce context and stage count, not just model price', async () => {
    const text = await readFile('skills/ecomode/SKILL.md', 'utf8');
    assert.match(text, /compact context/i);
    assert.match(text, /minimal fan-out/i);
    assert.match(text, /interaction count|rework/i);
  });

  it('keeps delegation conditional in Ecomode', async () => {
    const text = await readFile('skills/ecomode/SKILL.md', 'utf8');
    assert.doesNotMatch(text, /Delegation Enforcement[^A-Za-z0-9]*Always active via core orchestration/i);
  });

  it('grounds Help usage advice in real ledger fields and outcome evidence', async () => {
    const text = await readFile('skills/help/SKILL.md', 'utf8');
    assert.match(text, /~\/\.omx\/state\/token-tracking\.jsonl/);

    const requiredGuidance = [
      {
        contract: 'separate input, cached, uncached, output, and reasoning reporting',
        pattern: /input_tokens[\s\S]*cached_input_tokens[\s\S]*uncached_input_tokens[\s\S]*output_tokens[\s\S]*reasoning_output_tokens/i,
      },
      {
        contract: 'Team requires repeated tasks with two or more independent owned lanes',
        pattern: /Recommend Team only when repeated tasks show two or more independent owned lanes\./i,
      },
      {
        contract: 'reviewers require risk-matched findings that changed outcomes',
        pattern: /Recommend a reviewer when risk-matched findings changed outcomes, not merely when reviewer usage is zero\./i,
      },
      {
        contract: 'model choice uses accepted outcomes per billable-equivalent token',
        pattern: /Prefer the model with the best accepted outcome per billable-equivalent token; cheap per-call price is not sufficient\./i,
      },
    ];
    const missing = requiredGuidance
      .filter(({ pattern }) => !pattern.test(text))
      .map(({ contract }) => contract);

    assert.deepEqual(missing, []);
  });
});
