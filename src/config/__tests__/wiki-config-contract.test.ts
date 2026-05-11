import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSurface } from "../../hooks/__tests__/prompt-guidance-test-helpers.js";

describe("project wiki config/generator documentation contract", () => {
  it("documents CLI-first wiki access with explicit MCP compatibility", () => {
    const doc = loadSurface("docs/reference/project-wiki.md");
    assert.match(doc, /CLI-first JSON parity surface/i);
    assert.match(doc, /`omx wiki <tool> --input <json> --json`/);
    assert.match(doc, /\[mcp_servers\.omx_wiki\]/);
    assert.match(doc, /dist\/mcp\/wiki-server\.js/);
    assert.match(doc, /explicit compat mode/i);
    assert.match(doc, /must not appear in default CLI-first setup/i);
    assert.match(doc, /bootstrap\/config path should treat `omx_wiki` as a first-party OMX compatibility server/i);
  });

  it("documents the OMX-native storage path instead of legacy OMC storage", () => {
    const doc = loadSurface("docs/reference/project-wiki.md");
    assert.match(doc, /Wiki state is project-local and should live under/i);
    assert.match(doc, /`omx_wiki\/\*\.md`/);
    assert.match(doc, /legacy `\.omx\/wiki\/`/i);
    assert.match(doc, /The docs and code should never regress back to `\.omc\/wiki\/`/);
  });
});
