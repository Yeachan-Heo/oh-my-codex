import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSurface } from "./prompt-guidance-test-helpers.js";

describe("project wiki documentation contract", () => {
  it("documents the OMX-native storage, routing, and tool surface", () => {
    const doc = loadSurface("docs/reference/project-wiki.md");
    assert.match(doc, /`omx_wiki`/);
    assert.match(doc, /`omx_wiki\/`/);
    assert.match(doc, /legacy `\.omx\/wiki\/`/i);
    assert.match(doc, /prefer `\$wiki`/i);
    assert.match(doc, /avoid implicit bare `wiki` noun activation/i);
    assert.match(doc, /wiki_ingest/);
    assert.match(doc, /wiki_query/);
    assert.match(doc, /Do \*\*not\*\* add vector embeddings/i);
    assert.match(doc, /write to `omx_wiki\/`/i);
  });

  it("locks the approved source-fix regression list into docs", () => {
    const doc = loadSurface("docs/reference/project-wiki.md");
    assert.match(doc, /Unicode-safe slugging/i);
    assert.match(doc, /CRLF-safe frontmatter parsing/i);
    assert.match(doc, /single-pass unescape/i);
    assert.match(doc, /punctuation filtering/i);
    assert.match(doc, /CJK \+ accented-Latin tokenization support/i);
    assert.match(doc, /reserved-file guard/i);
  });

  it("keeps native hooks documentation aligned with the wiki lifecycle split", () => {
    const hooksDoc = loadSurface("docs/codex-native-hooks.md");
    assert.match(hooksDoc, /Storage.*`omx_wiki\/`/i);
    assert.match(hooksDoc, /SessionStart.*bounded wiki context/i);
    assert.match(hooksDoc, /SessionEnd.*runtime\/notify-path.*non-blocking/i);
    assert.match(hooksDoc, /PreCompact.*PostCompact.*native.*no-stdout/i);
    assert.match(hooksDoc, /prefer `\$wiki`.*avoid implicit bare `wiki` noun activation/i);
  });
});
