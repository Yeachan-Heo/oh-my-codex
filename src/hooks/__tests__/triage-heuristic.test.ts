import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { triagePrompt } from '../triage-heuristic.js';
import type { TriageDecision } from '../triage-heuristic.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertLane(prompt: string, lane: TriageDecision['lane']): void {
  const result = triagePrompt(prompt);
  assert.equal(
    result.lane,
    lane,
    `prompt="${prompt}" expected lane=${lane} got lane=${result.lane} (reason=${result.reason})`,
  );
}

function assertLightDestination(
  prompt: string,
  destination: NonNullable<TriageDecision['destination']>,
): void {
  const result = triagePrompt(prompt);
  assert.equal(
    result.lane,
    'LIGHT',
    `prompt="${prompt}" expected LIGHT got ${result.lane} (reason=${result.reason})`,
  );
  assert.equal(
    result.destination,
    destination,
    `prompt="${prompt}" expected destination=${destination} got ${result.destination}`,
  );
}

// ---------------------------------------------------------------------------
// Canonical corpus (also used for performance benchmark)
// ---------------------------------------------------------------------------

const CANONICAL_CORPUS: string[] = [
  // PASS — trivial
  'hi',
  'thanks',
  'yes',
  '',
  '   ',
  'fix the thing',
  'make it better',
  // PASS — opt-out
  'add dark mode toggle to the settings page, but just chat about it',
  'make the button blue, no workflow',
  'implement soft delete, don\'t route',
  'refactor auth, plain answer only',
  'explain this but talk through it',
  // LIGHT/explore
  'explain this function',
  'what does this error mean',
  'where is auth implemented',
  // LIGHT/executor
  'fix typo in src/foo.ts',
  'add null check to line 42',
  'rename function processFoo in src/bar.ts',
  // LIGHT/designer
  'make the button blue',
  'style this page',
  'adjust spacing on the settings panel',
  'redesign the settings page layout',
  // HEAVY
  'add dark mode toggle to the settings page',
  'implement soft delete across the ORM layer',
  'refactor the auth flow to use session cookies',
  'redesign the auth flow',
  'redesign the deployment pipeline',
];

// ---------------------------------------------------------------------------
// 1. PASS cases
// ---------------------------------------------------------------------------

describe('triagePrompt — PASS (trivial acknowledgements)', () => {
  const trivialCases = ['hi', 'thanks', 'yes'];
  for (const prompt of trivialCases) {
    it(`routes "${prompt}" to PASS`, () => {
      assertLane(prompt, 'PASS');
    });
  }

  it('routes empty string to PASS', () => {
    assertLane('', 'PASS');
  });

  it('routes whitespace-only string to PASS', () => {
    assertLane('   ', 'PASS');
  });

  it('routes "fix the thing" (too short / vague) to PASS', () => {
    assertLane('fix the thing', 'PASS');
  });

  it('routes "make it better" (too short / vague) to PASS', () => {
    assertLane('make it better', 'PASS');
  });
});

describe('triagePrompt — PASS (explicit opt-out phrases)', () => {
  it('routes HEAVY-shaped prompt with "just chat" to PASS', () => {
    assertLane('add dark mode toggle to the settings page, but just chat about it', 'PASS');
  });

  it('routes "no workflow" opt-out to PASS', () => {
    assertLane('make the button blue, no workflow', 'PASS');
  });

  it('routes "don\'t route" opt-out to PASS', () => {
    assertLane("implement soft delete, don't route", 'PASS');
  });

  it('routes "plain answer only" to PASS', () => {
    assertLane('refactor auth, plain answer only', 'PASS');
  });

  it('routes "talk through it" to PASS', () => {
    assertLane('explain this but talk through it', 'PASS');
  });
});

// ---------------------------------------------------------------------------
// 2. LIGHT / explore
// ---------------------------------------------------------------------------

describe('triagePrompt — LIGHT/explore', () => {
  it('routes "explain this function" to explore', () => {
    assertLightDestination('explain this function', 'explore');
  });

  it('routes "what does this error mean" to explore', () => {
    assertLightDestination('what does this error mean', 'explore');
  });

  it('routes "where is auth implemented" to explore', () => {
    assertLightDestination('where is auth implemented', 'explore');
  });
});

// ---------------------------------------------------------------------------
// 3. LIGHT / executor (anchored edits)
// ---------------------------------------------------------------------------

describe('triagePrompt — LIGHT/executor (anchored edits)', () => {
  it('routes "fix typo in src/foo.ts" to executor', () => {
    assertLightDestination('fix typo in src/foo.ts', 'executor');
  });

  it('routes "add null check to line 42" to executor', () => {
    assertLightDestination('add null check to line 42', 'executor');
  });

  it('routes "rename function processFoo in src/bar.ts" to executor', () => {
    assertLightDestination('rename function processFoo in src/bar.ts', 'executor');
  });
});

// ---------------------------------------------------------------------------
// 4. LIGHT / designer
// ---------------------------------------------------------------------------

describe('triagePrompt — LIGHT/designer', () => {
  it('routes "make the button blue" to designer', () => {
    assertLightDestination('make the button blue', 'designer');
  });

  it('routes "style this page" to designer', () => {
    assertLightDestination('style this page', 'designer');
  });

  it('routes "adjust spacing on the settings panel" to designer', () => {
    assertLightDestination('adjust spacing on the settings panel', 'designer');
  });

  it('routes visual redesign prompts to designer', () => {
    assertLightDestination('redesign the settings page layout', 'designer');
  });
});

// ---------------------------------------------------------------------------
// 5. LIGHT / researcher
// ---------------------------------------------------------------------------

describe('triagePrompt — LIGHT/researcher', () => {
  it('routes official documentation lookup prompts to researcher', () => {
    assertLightDestination('Find the official docs and version compatibility notes for this SDK', 'researcher');
  });

  it('routes Korean official documentation lookup prompts to researcher', () => {
    assertLightDestination('OpenAI Responses API 공식 문서 찾아줘', 'researcher');
  });

  it('routes official-doc question prompts to researcher instead of explore', () => {
    assertLightDestination('where can I find official docs for OpenAI Responses API?', 'researcher');
  });

  it('routes endpoint-shaped official-doc lookups to researcher instead of local explore', () => {
    assertLightDestination('find official docs for api/v1/responses', 'researcher');
  });

  it('routes dotted technology official-doc lookups to researcher instead of local explore', () => {
    assertLightDestination('find official docs for Node.js', 'researcher');
    assertLightDestination('find official docs for Next.js', 'researcher');
  });

  it('routes external URL-shaped official-doc lookups with repo paths to researcher', () => {
    assertLightDestination('find official docs for github.com/org/repo/src/foo.ts', 'researcher');
    assertLightDestination('find official docs for github.com/org/repo/src/server', 'researcher');
  });

  it('does not steal implementation-shaped official-doc prompts from HEAVY', () => {
    const result = triagePrompt('implement auth using official docs for the SDK');
    assert.equal(result.lane, 'HEAVY', `expected HEAVY got ${result.lane} (reason=${result.reason})`);
    assert.equal(result.destination, 'autopilot');
    assert.equal(result.reason, 'implementation_research_goal');
  });

  it('does not steal planning-shaped official-doc prompts from HEAVY', () => {
    const result = triagePrompt('research and plan auth migration using official docs for the SDK');
    assert.equal(result.lane, 'HEAVY', `expected HEAVY got ${result.lane} (reason=${result.reason})`);
    assert.equal(result.destination, 'autopilot');
    assert.equal(result.reason, 'implementation_research_goal');
  });

  it('routes anchored local API usage prompts through executor even with lookup verbs', () => {
    assertLightDestination('find API usage in src/foo.ts', 'executor');
  });

  it('routes project-scoped local API usage prompts through explore instead of researcher', () => {
    assertLightDestination('find API usage in this project', 'explore');
  });

  it('routes current-code lookup prompts through explore instead of researcher', () => {
    assertLightDestination('find API usage in our code', 'explore');
  });

  it('keeps repository changelog lookup prompts local despite generic docs terms', () => {
    assertLightDestination('find changelog in this repository', 'explore');
  });

  it('keeps anchored documentation lookup prompts local despite generic docs terms', () => {
    assertLightDestination('find documentation in src/config.ts', 'executor');
  });

  it('routes anchored read-only questions through explore before executor', () => {
    assertLightDestination('what does src/foo.ts do?', 'explore');
  });
});

// ---------------------------------------------------------------------------
// 6. HEAVY
// ---------------------------------------------------------------------------

describe('triagePrompt — HEAVY', () => {
  it('routes "add dark mode toggle to the settings page" to HEAVY', () => {
    assertLane('add dark mode toggle to the settings page', 'HEAVY');
  });

  it('routes "implement soft delete across the ORM layer" to HEAVY', () => {
    assertLane('implement soft delete across the ORM layer', 'HEAVY');
  });

  it('routes "refactor the auth flow to use session cookies" to HEAVY', () => {
    assertLane('refactor the auth flow to use session cookies', 'HEAVY');
  });

  it('does not route non-visual auth redesign prompts to LIGHT/designer', () => {
    const result = triagePrompt('redesign the auth flow');
    assert.equal(result.lane, 'HEAVY', `expected HEAVY got ${result.lane} (reason=${result.reason})`);
    assert.equal(result.destination, 'autopilot');
  });

  it('routes mixed auth page flow redesign prompts to HEAVY instead of designer', () => {
    const result = triagePrompt('redesign the auth page flow');
    assert.equal(result.lane, 'HEAVY', `expected HEAVY got ${result.lane} (reason=${result.reason})`);
    assert.equal(result.destination, 'autopilot');
  });

  it('does not route non-visual deployment redesign prompts to LIGHT/designer', () => {
    const result = triagePrompt('redesign the deployment pipeline');
    assert.equal(result.lane, 'HEAVY', `expected HEAVY got ${result.lane} (reason=${result.reason})`);
    assert.equal(result.destination, 'autopilot');
  });

  it('sets destination=autopilot for HEAVY decisions', () => {
    const result = triagePrompt('add dark mode toggle to the settings page');
    assert.equal(result.destination, 'autopilot', `expected destination=autopilot got ${result.destination}`);
  });
});

// ---------------------------------------------------------------------------
// 7. Punctuation / casing regression
// ---------------------------------------------------------------------------

describe('triagePrompt — punctuation and casing regression', () => {
  it('"EXPLAIN this function" → LIGHT/explore (all-caps)', () => {
    assertLightDestination('EXPLAIN this function', 'explore');
  });

  it('"Explain This Function." → LIGHT/explore (title case + period)', () => {
    assertLightDestination('Explain This Function.', 'explore');
  });

  it('"FIX TYPO IN src/foo.ts" → LIGHT/executor (all-caps)', () => {
    assertLightDestination('FIX TYPO IN src/foo.ts', 'executor');
  });

  it('"Add Dark Mode Toggle To The Settings Page!" → HEAVY (title case + exclamation)', () => {
    assertLane('Add Dark Mode Toggle To The Settings Page!', 'HEAVY');
  });
});

// ---------------------------------------------------------------------------
// 8. Determinism / purity proof
// ---------------------------------------------------------------------------

describe('triagePrompt — determinism', () => {
  it('returns identical results across 1000 calls for the same input', () => {
    const prompt = 'add dark mode toggle to the settings page';
    const first = triagePrompt(prompt);
    for (let i = 1; i < 1000; i++) {
      const result = triagePrompt(prompt);
      assert.equal(
        result.lane,
        first.lane,
        `non-deterministic: call ${i} returned lane=${result.lane}, first was ${first.lane}`,
      );
      assert.equal(
        result.destination,
        first.destination,
        `non-deterministic: call ${i} returned destination=${result.destination}, first was ${first.destination}`,
      );
      assert.equal(
        result.reason,
        first.reason,
        `non-deterministic: call ${i} returned reason=${result.reason}, first was ${first.reason}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Performance benchmark (soft assertion — avg < 1 ms per call)
// ---------------------------------------------------------------------------

describe('triagePrompt — performance benchmark', () => {
  it('classifies the full canonical corpus 1000x with avg < 1 ms per call', () => {
    const N = 1000;
    const corpusLength = CANONICAL_CORPUS.length;
    const totalCalls = N * corpusLength;

    // Warm-up pass (avoid JIT cold-start skewing results)
    for (const prompt of CANONICAL_CORPUS) {
      triagePrompt(prompt);
    }

    const start = performance.now();
    for (let i = 0; i < N; i++) {
      for (const prompt of CANONICAL_CORPUS) {
        triagePrompt(prompt);
      }
    }
    const elapsed = performance.now() - start;

    const avgPerCall = elapsed / totalCalls;
    console.log(
      `[triage-heuristic benchmark] ${totalCalls} calls in ${elapsed.toFixed(2)} ms` +
      ` — avg ${avgPerCall.toFixed(4)} ms/call (corpus size: ${corpusLength})`,
    );

    assert.ok(
      avgPerCall < 1.0,
      `avg per call ${avgPerCall.toFixed(4)} ms exceeded 1 ms soft bound (total: ${elapsed.toFixed(2)} ms over ${totalCalls} calls)`,
    );
  });
});
