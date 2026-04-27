import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSurface } from "./prompt-guidance-test-helpers.js";

describe("explicit terminal stop model docs contract", () => {
  it("locks the canonical lifecycle vocabulary and legacy boundaries", () => {
    const doc = loadSurface("docs/contracts/explicit-terminal-stop-model.md");
    for (const outcome of ["finished", "blocked", "failed", "userinterlude", "askuserQuestion"]) {
      assert.equal(doc.includes(`| \`${outcome}\``), true);
    }
    assert.match(doc, /blocked_on_user/i);
    assert.match(doc, /cancelled.*internal legacy\/admin/i);
    assert.match(doc, /do \*\*not\*\* present as a canonical user-facing lifecycle outcome/i);
    assert.match(doc, /If you want, I can/i);
    assert.match(doc, /Would you like me to continue\?/i);
  });

  it("documents lifecycle precedence in the state model", () => {
    const doc = loadSurface("docs/STATE_MODEL.md");
    assert.match(doc, /Terminal lifecycle outcome compatibility/i);
    assert.match(doc, /`finished`/i);
    assert.match(doc, /`askuserQuestion`/i);
    assert.match(doc, /Prefer a dedicated canonical lifecycle field over legacy `run_outcome`/i);
    assert.match(doc, /Keep `cancelled` as an internal legacy\/admin phase/i);
  });

  it("keeps native hook docs aligned with lifecycle metadata precedence", () => {
    const doc = loadSurface("docs/codex-native-hooks.md");
    assert.match(doc, /Explicit terminal stop model note/i);
    assert.match(doc, /prefer explicit lifecycle metadata over assistant-text heuristics/i);
    assert.match(doc, /legacy `blocked_on_user` still suppresses continuation/i);
    assert.match(doc, /`cancelled` should be treated as internal legacy\/admin compatibility/i);
    assert.match(doc, /no distinct native Codex `ask-user-question` hook today/i);
  });

  it("extends prompt guidance docs with the explicit terminal handoff rule", () => {
    const doc = loadSurface("docs/prompt-guidance-contract.md");
    assert.match(doc, /Active workflow terminal handoff contract/i);
    assert.match(doc, /name an explicit outcome such as `finished`, `blocked`, `failed`, `userinterlude`, or `askuserQuestion`/i);
    assert.match(doc, /should not end in permission-seeking softeners/i);
    assert.match(doc, /If you want, I can/i);
    assert.match(doc, /If you'd like, I can/i);
    assert.match(doc, /Would you like me to continue\?/i);
    assert.match(doc, /dist\/hooks\/__tests__\/explicit-terminal-stop-docs-contract\.test\.js/i);
  });
});
