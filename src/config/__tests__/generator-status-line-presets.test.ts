/**
 * Tests for the [tui].status_line preset feature.
 *
 * The OMX default for [tui].status_line is now derived from a HudPreset
 * (minimal | focused | full). The default preset is "focused", which must
 * remain byte-identical to the legacy hard-coded array so existing installs
 * see no behavior change after this feature lands.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMergedConfig,
  mergeConfig,
  statusLineForPreset,
  STATUS_LINE_PRESETS,
  DEFAULT_STATUS_LINE_PRESET,
} from "../generator.js";

const LEGACY_DEFAULT_STATUS_LINE =
  'status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]';

describe("status_line preset matrix", () => {
  it("default preset is 'focused'", () => {
    assert.equal(DEFAULT_STATUS_LINE_PRESET, "focused");
  });

  it("focused preset is byte-identical to the legacy hard-coded default", () => {
    assert.equal(statusLineForPreset("focused"), LEGACY_DEFAULT_STATUS_LINE);
  });

  it("calling statusLineForPreset() with no argument returns the focused string", () => {
    assert.equal(statusLineForPreset(), LEGACY_DEFAULT_STATUS_LINE);
  });

  it("minimal preset emits exactly model-with-reasoning and git-branch", () => {
    assert.equal(
      statusLineForPreset("minimal"),
      'status_line = ["model-with-reasoning", "git-branch"]',
    );
  });

  it("full preset is currently identical to focused (placeholder for expansion)", () => {
    assert.equal(statusLineForPreset("full"), statusLineForPreset("focused"));
  });

  it("STATUS_LINE_PRESETS exposes every HudPreset key", () => {
    assert.deepEqual(
      Object.keys(STATUS_LINE_PRESETS).sort(),
      ["focused", "full", "minimal"],
    );
  });

  it("minimal preset only contains the two essential fields", () => {
    assert.deepEqual(
      [...STATUS_LINE_PRESETS.minimal],
      ["model-with-reasoning", "git-branch"],
    );
  });
});

describe("buildMergedConfig with statusLinePreset", () => {
  it("emits the focused (legacy default) status_line when no preset is passed", () => {
    const wd = "/tmp/omx-preset-noop";
    const toml = buildMergedConfig("", wd, {});
    assert.match(
      toml,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
    );
  });

  it("emits the minimal status_line when statusLinePreset='minimal' on a fresh config", () => {
    const wd = "/tmp/omx-preset-minimal";
    const toml = buildMergedConfig("", wd, { statusLinePreset: "minimal" });
    assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
    assert.doesNotMatch(toml, /context-remaining/);
    assert.doesNotMatch(toml, /five-hour-limit/);
  });

  it("emits the focused status_line when statusLinePreset='focused' on a fresh config", () => {
    const wd = "/tmp/omx-preset-focused";
    const toml = buildMergedConfig("", wd, { statusLinePreset: "focused" });
    assert.match(
      toml,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
    );
  });

  it("preserves a user-defined status_line even when a preset is requested", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-pres-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['[tui]', 'status_line = ["git-branch"]', ""].join("\n"),
      );

      await mergeConfig(configPath, wd, { statusLinePreset: "minimal" });
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^status_line = \["git-branch"\]$/m);
      assert.doesNotMatch(toml, /^status_line = \["model-with-reasoning"/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("upgrades a previously OMX-managed status_line to the new preset", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-upgrade-"));
    try {
      const configPath = join(wd, "config.toml");
      // First populate with the focused (legacy) default via a no-preset merge.
      await mergeConfig(configPath, wd, {});
      let toml = await readFile(configPath, "utf-8");
      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch", "context-remaining"/m);

      // Now request minimal — the OMX-managed status_line should be replaced
      // because it is detected as a known preset value, not a user override.
      await mergeConfig(configPath, wd, { statusLinePreset: "minimal" });
      toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
      assert.doesNotMatch(toml, /context-remaining/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("user-customized status_line inside the OMX marker block", () => {
  // Regression guard for the codex-flagged scenario: a user manually editing
  // a [tui] block inside the OMX marker to a value that happens to byte-match
  // a preset literal (e.g. ["model-with-reasoning", "git-branch"] equals the
  // `minimal` preset) must still be treated as a user customization and
  // preserved across rebuild.
  it("preserves a user-edited preset-literal status_line that lacks the managed marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-coll-"));
    try {
      const configPath = join(wd, "config.toml");
      const userEditedConfig = [
        "# ============================================================",
        "# oh-my-codex (OMX) Configuration",
        "# Managed by omx setup - manual edits preserved on next setup",
        "# ============================================================",
        "",
        "[mcp_servers.omx_state]",
        'command = "node"',
        `args = ["${join(wd, "dist/mcp/state-server.js").replace(/\\/g, "\\\\")}"]`,
        "enabled = true",
        "",
        "# OMX TUI StatusLine (Codex CLI v0.101.0+)",
        "[tui]",
        // No "# omx:managed-status-line" marker — this is a user edit that
        // happens to byte-match the `minimal` preset literal.
        'status_line = ["model-with-reasoning", "git-branch"]',
        "",
        "# ============================================================",
        "# End oh-my-codex",
        "",
      ].join("\n");
      await writeFile(configPath, userEditedConfig);

      // Default preset is focused. Pre-fix this overwrote the user's value
      // because the value-set detector treated the minimal literal as managed.
      await mergeConfig(configPath, wd, {});
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
      assert.doesNotMatch(toml, /context-remaining/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("recognizes the legacy seven-field default as OMX-managed for back-compat", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-legacy-"));
    try {
      const configPath = join(wd, "config.toml");
      // Pre-marker install: OMX wrote the focused 7-field array without
      // the marker comment. A subsequent merge requesting `minimal` must
      // still recognize this as managed and replace it.
      const legacyConfig = [
        "# ============================================================",
        "# oh-my-codex (OMX) Configuration",
        "# Managed by omx setup - manual edits preserved on next setup",
        "# ============================================================",
        "",
        "[mcp_servers.omx_state]",
        'command = "node"',
        `args = ["${join(wd, "dist/mcp/state-server.js").replace(/\\/g, "\\\\")}"]`,
        "enabled = true",
        "",
        "# OMX TUI StatusLine (Codex CLI v0.101.0+)",
        "[tui]",
        'status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]',
        "",
        "# ============================================================",
        "# End oh-my-codex",
        "",
      ].join("\n");
      await writeFile(configPath, legacyConfig);

      await mergeConfig(configPath, wd, { statusLinePreset: "minimal" });
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
      assert.doesNotMatch(toml, /context-remaining/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("emits the managed-status-line marker comment when OMX writes status_line", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-marker-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd, {});
      const toml = await readFile(configPath, "utf-8");
      assert.match(
        toml,
        /# omx:managed-status-line\nstatus_line = \["model-with-reasoning", "git-branch", "context-remaining"/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("mergeConfig with statusLinePreset (integration via .omx/hud-config.json)", () => {
  it("renders the preset selected in MergeOptions when [tui] does not yet exist", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-preset-int-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "hud-config.json"),
        JSON.stringify({
          preset: "focused",
          statusLine: { preset: "minimal" },
        }),
      );

      const configPath = join(wd, "config.toml");
      // Direct invocation mirrors what setup.ts does after reading hud-config.json.
      await mergeConfig(configPath, wd, { statusLinePreset: "minimal" });

      const toml = await readFile(configPath, "utf-8");
      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
