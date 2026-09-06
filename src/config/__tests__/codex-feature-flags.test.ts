import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCodexFeatureNames,
  resolveCodexHookFeatureFlag,
  supportsCodexPluginScopedHooks,
} from "../codex-feature-flags.js";

describe("Codex feature flag resolution", () => {
  it("prefers the current hooks feature when Codex reports it", () => {
    const output = [
      "goals                                   experimental       true",
      "hooks                                   stable             true",
      "multi_agent                             stable             true",
      "",
    ].join("\n");

    assert.equal(resolveCodexHookFeatureFlag({ featuresListOutput: output }), "hooks");
  });

  it("falls back to legacy codex_hooks when it is the only reported hook flag", () => {
    const output = [
      "codex_hooks                             experimental       true",
      "multi_agent                             stable             true",
      "",
    ].join("\n");

    assert.equal(
      resolveCodexHookFeatureFlag({ featuresListOutput: output }),
      "codex_hooks",
    );
  });

  it("detects official plugin-scoped hook support separately from legacy hooks", () => {
    const output = [
      "hooks                                   stable             true",
      "plugin_hooks                            experimental       true",
      "goals                                   experimental       true",
      "",
    ].join("\n");

    assert.equal(supportsCodexPluginScopedHooks({ featuresListOutput: output }), true);
    assert.equal(supportsCodexPluginScopedHooks({ featuresListOutput: "hooks stable true" }), false);
  });

  it("does not treat a removed plugin_hooks row as plugin-scoped hook support", () => {
    const output = [
      "goals                                   stable             true",
      "hooks                                   stable             true",
      "plugin_hooks                            removed            false",
      "",
    ].join("\n");

    assert.equal(supportsCodexPluginScopedHooks({ featuresListOutput: output }), false);
    assert.equal(
      supportsCodexPluginScopedHooks({
        featuresListOutput: "plugin_hooks removed true",
      }),
      false,
      "even a removed=true row no longer names a supported feature",
    );
    assert.equal(
      supportsCodexPluginScopedHooks({
        featuresListOutput: "plugin_hooks experimental true",
      }),
      true,
      "non-removed lifecycle rows still report plugin-scoped hook support",
    );
    assert.equal(supportsCodexPluginScopedHooks({ featuresListOutput: null }), false);
  });

  it("uses version fallback for current Codex releases when feature listing is unavailable", () => {
    assert.equal(
      resolveCodexHookFeatureFlag({ versionOutput: "codex-cli 0.130.0" }),
      "hooks",
    );
  });

  it("parses feature names without treating table headings as features", () => {
    const names = parseCodexFeatureNames(
      [
        "hooks                                   stable             true",
        "Under-development features enabled: hooks",
        "",
      ].join("\n"),
    );

    assert.equal(names.has("hooks"), true);
    assert.equal(names.has("Under-development"), false);
  });
});
