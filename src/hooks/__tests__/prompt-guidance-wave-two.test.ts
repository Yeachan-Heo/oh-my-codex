import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WAVE_TWO_CONTRACTS } from '../prompt-guidance-contract.js';
import { assertContractSurface, loadSurface } from './prompt-guidance-test-helpers.js';

describe('prompt guidance wave two contract', () => {
  for (const contract of WAVE_TWO_CONTRACTS) {
    it(`${contract.id} satisfies the wave-two contract`, () => {
      assertContractSurface(contract);
    });
  }

  it('wave-two prompts encode role-appropriate grounded-evidence wording', () => {
    assert.match(loadSurface('prompts/architect.md'), /analysis is grounded/i);
    assert.match(loadSurface('prompts/critic.md'), /verdict is grounded/i);
    assert.match(loadSurface('prompts/debugger.md'), /diagnosis is grounded/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /recommendation is grounded/i);
    assert.match(loadSurface('prompts/code-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/quality-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/code-reviewer.md'), /review is grounded/i);
    assert.match(loadSurface('prompts/researcher.md'), /answer is grounded/i);
    assert.match(loadSurface('prompts/explore.md'), /answer is grounded/i);
  });

  it('researcher encodes a docs-first technical research workflow', () => {
    const researcher = loadSurface('prompts/researcher.md');
    assert.match(researcher, /classify the request/i);
    assert.match(researcher, /documentation structure before page-level fetches/i);
    assert.match(researcher, /examples only after the docs baseline is grounded/i);
    assert.match(researcher, /source-reference evidence/i);
  });

  it('research specialists keep explicit output-contract fixtures for source preference and boundary discipline', () => {
    const researcher = loadSurface('prompts/researcher.md');
    const dependencyExpert = loadSurface('prompts/dependency-expert.md');
    const explore = loadSurface('prompts/explore.md');

    assert.match(researcher, /Always include source URLs/i);
    assert.match(researcher, /Prefer official documentation.*over third-party summaries/i);
    assert.match(researcher, /Version compatibility or version uncertainty is noted when relevant|### Version Note/i);
    assert.match(researcher, /already chosen technology/i);
    assert.match(researcher, /not the default dependency-comparison role/i);

    assert.match(dependencyExpert, /Compare at least 2 candidates|multiple candidates/i);
    assert.match(dependencyExpert, /license compatibility/i);
    assert.match(dependencyExpert, /maintenance activity|download stats/i);
    assert.match(dependencyExpert, /Risks/i);
    assert.match(dependencyExpert, /whether \/\s*which package, SDK, or framework to adopt, upgrade, replace, or migrate/i);
    assert.match(dependencyExpert, /boundary crossing upward.*researcher|report that boundary crossing upward for `researcher`/i);

    assert.match(explore, /ALL paths are absolute/i);
    assert.match(explore, /Relationships between files\/patterns explained/i);
    assert.match(explore, /Read-only/i);
    assert.match(explore, /repo-local facts only/i);
    assert.match(explore, /dependency recommendation.*report that handoff upward|report that handoff upward/i);
  });

  it('code-reviewer rejects masking fallback and workaround patches unless narrowly justified', () => {
    const codeReviewer = loadSurface('prompts/code-reviewer.md');

    assert.match(codeReviewer, /Root-cause guard/i);
    assert.match(codeReviewer, /fallback\/workaround code when it masks failures/i);
    assert.match(codeReviewer, /REQUEST CHANGES even if tests pass/i);
    assert.match(codeReviewer, /preserves or reports failure evidence/i);
    assert.match(codeReviewer, /narrow compatibility fallback can be acceptable/i);
    assert.match(codeReviewer, /fixing a controllable primary contract/i);
  });

  it('code-review and verifier-adjacent prompts preserve merge-if-green as downstream context', () => {
    assert.match(loadSurface('prompts/code-reviewer.md'), /merge if CI green/i);
    assert.match(loadSurface('prompts/critic.md'), /later workflow condition|downstream context/i);
    assert.match(loadSurface('prompts/test-engineer.md'), /merge if CI green/i);
  });
});
