/**
 * Idempotency tests for config.toml generator (issue #384)
 * Verifies that repeated `omx setup` runs do not duplicate OMX sections.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { buildMergedConfig, cleanCodexModelAvailabilityNuxIfNeeded, mergeConfig, repairConfigIfNeeded } from "../generator.js";

/** Count occurrences of a pattern in text */
function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Assert the current OMX block appears exactly once */
function assertSingleOmxBlock(toml: string): void {
  assert.equal(
    count(toml, /# oh-my-codex \(OMX\) Configuration/g),
    1,
    "OMX marker should appear once",
  );
  assert.equal(
    count(toml, /^# End oh-my-codex$/gm),
    1,
    "End marker should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_state\]$/gm),
    1,
    "[mcp_servers.omx_state] should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_memory\]$/gm),
    1,
    "[mcp_servers.omx_memory] should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_code_intel\]$/gm),
    1,
    "[mcp_servers.omx_code_intel] should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_trace\]$/gm),
    1,
    "[mcp_servers.omx_trace] should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_wiki\]$/gm),
    1,
    "[mcp_servers.omx_wiki] should appear once",
  );
  assert.equal(
    count(toml, /^\[mcp_servers\.omx_team_run\]$/gm),
    0,
    "[mcp_servers.omx_team_run] should not be emitted",
  );
  assert.doesNotMatch(
    toml,
    /dist\/mcp\/team-server\.js/,
    "team-server path should not be emitted",
  );
  assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
  assert.equal(
    count(toml, /^\[features\]$/gm),
    1,
    "[features] should appear once",
  );
  assert.equal(
    count(toml, /^codex_hooks = true$/gm),
    1,
    "codex_hooks should appear once",
  );
  assert.equal(
    count(toml, /^notify\s*=/gm),
    1,
    "notify key should appear once",
  );
  assert.equal(
    count(toml, /^model_reasoning_effort\s*=/gm),
    1,
    "model_reasoning_effort should appear once",
  );
  assert.equal(
    count(toml, /^developer_instructions\s*=/gm),
    1,
    "developer_instructions should appear once",
  );
  assert.equal(count(toml, /^\[env\]$/gm), 1, "[env] should appear once");
  assert.equal(
    count(toml, /^USE_OMX_EXPLORE_CMD = "1"$/gm),
    1,
    "USE_OMX_EXPLORE_CMD should appear once",
  );
}

describe("Codex transient TUI NUX cleanup", () => {
  it("removes only model availability NUX counters from project-local config", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-codex-nux-cleanup-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(configPath, [
        'model = "gpt-5.5"',
        'status_line = ["model-with-reasoning", "git-branch"]',
        "",
        "[tui]",
        'theme = "dark"',
        "notifications = true",
        "",
        "[tui.model_availability_nux]",
        '"gpt-5.5" = 4',
        '"gpt-5.4" = 1',
        "",
        "[mcp_servers.user]",
        'command = "node"',
        'args = ["server.js"]',
        "",
      ].join("\n"));

      const cleaned = await cleanCodexModelAvailabilityNuxIfNeeded(configPath);
      const toml = await readFile(configPath, "utf-8");

      assert.equal(cleaned, true);
      assert.doesNotMatch(toml, /^\[tui\.model_availability_nux\]$/m);
      assert.doesNotMatch(toml, /gpt-5\.5" = 4/);
      assert.match(toml, /^status_line = \["model-with-reasoning", "git-branch"\]$/m);
      assert.match(toml, /^\[tui\]$/m);
      assert.match(toml, /^theme = "dark"$/m);
      assert.match(toml, /^notifications = true$/m);
      assert.match(toml, /^\[mcp_servers\.user\]$/m);
      assert.match(toml, /^command = "node"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("is a no-op when project config has no Codex NUX counters", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-codex-nux-noop-"));
    try {
      const configPath = join(wd, "config.toml");
      const original = [
        'model = "gpt-5.5"',
        "",
        "[tui]",
        'theme = "dark"',
        "",
      ].join("\n");
      await writeFile(configPath, original);

      const cleaned = await cleanCodexModelAvailabilityNuxIfNeeded(configPath);
      assert.equal(cleaned, false);
      assert.equal(await readFile(configPath, "utf-8"), original);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("config generator idempotency (#384)", () => {
  it("first run creates config with all current OMX sections", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.match(toml, /^multi_agent = true$/m);
      assert.match(toml, /^child_agents_md = true$/m);
      assert.match(toml, /^codex_hooks = true$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("second run updates without duplicating any section", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");

      // First run
      await mergeConfig(configPath, wd);
      const first = await readFile(configPath, "utf-8");
      assertSingleOmxBlock(first);

      // Second run
      await mergeConfig(configPath, wd);
      const second = await readFile(configPath, "utf-8");
      assertSingleOmxBlock(second);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("triple run stays clean", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");

      await mergeConfig(configPath, wd);
      await mergeConfig(configPath, wd);
      await mergeConfig(configPath, wd);

      const toml = await readFile(configPath, "utf-8");
      assertSingleOmxBlock(toml);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("cleans up legacy config without markers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      // Simulate a legacy config written without OMX markers
      // Note: [tui] is intentionally excluded — orphan-strip does not
      // claim [tui] to avoid deleting user-owned TUI settings.
      const legacy = [
        'model = "o3"',
        "",
        'notify = ["node", "/old/path/notify-hook.js"]',
        'model_reasoning_effort = "medium"',
        'developer_instructions = "old instructions"',
        "",
        "[features]",
        "multi_agent = true",
        "",
        "[mcp_servers.omx_state]",
        'command = "node"',
        'args = ["/old/path/state-server.js"]',
        "enabled = true",
        "",
        "[mcp_servers.omx_memory]",
        'command = "node"',
        'args = ["/old/path/memory-server.js"]',
        "enabled = true",
        "",
        "[user.custom]",
        'name = "kept"',
        "",
      ].join("\n");
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);

      // User settings preserved
      assert.match(toml, /^model = "o3"$/m, "user model preserved");
      assert.match(toml, /^\[user\.custom\]$/m, "user section preserved");
      assert.match(toml, /^name = "kept"$/m, "user key preserved");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("cleans up orphaned OMX sections outside marker block", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      // Config with both orphaned sections AND a marker block
      const mixed = [
        'model = "o3"',
        "",
        "# OMX State Management MCP Server",
        "[mcp_servers.omx_state]",
        'command = "node"',
        'args = ["/orphaned/state-server.js"]',
        "enabled = true",
        "",
        "[user.settings]",
        'name = "kept"',
        "",
        "# ============================================================",
        "# oh-my-codex (OMX) Configuration",
        "# Managed by omx setup",
        "# ============================================================",
        "",
        "[mcp_servers.omx_state]",
        'command = "node"',
        'args = ["/marker-block/state-server.js"]',
        "enabled = true",
        "",
        "# ============================================================",
        "# End oh-my-codex",
        "",
      ].join("\n");
      await writeFile(configPath, mixed);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.match(toml, /^model = "o3"$/m, "user model preserved");
      assert.match(toml, /^\[user\.settings\]$/m, "user section preserved");
      assert.match(toml, /^name = "kept"$/m, "user key preserved");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves user content between OMX re-runs", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");

      // First run
      await mergeConfig(configPath, wd);

      // User adds content
      let toml = await readFile(configPath, "utf-8");
      toml += '\n[user.prefs]\ntheme = "dark"\n';
      await writeFile(configPath, toml);

      // Second run
      await mergeConfig(configPath, wd);
      const result = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(result);
      assert.match(
        result,
        /^\[user\.prefs\]$/m,
        "user section preserved after re-run",
      );
      assert.match(
        result,
        /^theme = "dark"$/m,
        "user key preserved after re-run",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("handles config with only orphaned agents sections", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const orphanedAgents = [
        "[features]",
        "multi_agent = true",
        "",
        "# OMX Native Agent Roles (Codex multi-agent)",
        "",
        "[agents.executor]",
        'description = "old executor"',
        'config_file = "/old/path/executor.toml"',
        "",
        "[agents.explore]",
        'description = "old explore"',
        'config_file = "/old/path/explore.toml"',
        "",
        "[user.custom]",
        'name = "kept"',
        "",
      ].join("\n");
      await writeFile(configPath, orphanedAgents);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.match(toml, /^\[user\.custom\]$/m, "user section preserved");
      assert.match(toml, /^name = "kept"$/m, "user key preserved");
      assert.match(toml, /^\[agents\]$/m, "global agents settings added");
      assert.match(toml, /^max_threads = 6$/m, "global agents max_threads seeded");
      assert.match(toml, /^max_depth = 2$/m, "global agents max_depth seeded");
      assert.doesNotMatch(toml, /^\[agents\.executor\]$/m, "legacy OMX agent entry removed");
      assert.doesNotMatch(toml, /^\[agents\.explore\]$/m, "legacy OMX agent entry removed");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves non-OMX agent sections", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const userAgents = [
        '[agents."my-custom-bot"]',
        'description = "My custom agent"',
        'config_file = "/home/user/my-bot.toml"',
        "",
        "[agents.myreviewer]",
        'description = "Company code reviewer"',
        'config_file = "/home/user/reviewer.toml"',
        "",
      ].join("\n");
      await writeFile(configPath, userAgents);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      // User-defined agents must survive
      assert.match(
        toml,
        /^\[agents\."my-custom-bot"\]$/m,
        "user agent my-custom-bot preserved",
      );
      assert.match(
        toml,
        /^description = "My custom agent"$/m,
        "user agent description preserved",
      );
      assert.match(
        toml,
        /^\[agents\.myreviewer\]$/m,
        "user agent myreviewer preserved",
      );
      assert.match(
        toml,
        /^description = "Company code reviewer"$/m,
        "user agent description preserved",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a user-owned status_line in an existing [tui] section", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const userTui = [
        "[tui]",
        "theme = \"night\"",
        'status_line = ["git-branch"]',
        "",
      ].join("\n");
      await writeFile(configPath, userTui);

      await mergeConfig(configPath, wd);
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
      assert.match(toml, /^theme = "night"$/m, "user tui key preserved");
      assert.match(
        toml,
        /^status_line = \["git-branch"\]$/m,
        "user status_line preserved",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("seeds the default status_line into a fresh [tui] section", () => {
    const toml = buildMergedConfig("", "/tmp/omx");

    assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
    assert.match(
      toml,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
    );
  });

  it("seeds the default status_line into an existing [tui] section without one", () => {
    const toml = buildMergedConfig(
      ["[tui]", 'theme = "night"', ""].join("\n"),
      "/tmp/omx",
    );

    assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
    assert.match(toml, /^theme = "night"$/m, "existing tui key preserved");
    assert.match(
      toml,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      "default status_line should be seeded when [tui] lacks one",
    );
  });

  it("preserves a multiline user-owned status_line", () => {
    const toml = buildMergedConfig(
      [
        "[tui]",
        "status_line = [",
        '  "git-branch",',
        '  "context-remaining",',
        "]",
        "",
      ].join("\n"),
      "/tmp/omx",
    );

    assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
    assert.ok(
      toml.includes(
        [
          "status_line = [",
          '"git-branch",',
          '"context-remaining",',
          "]",
        ].join("\n"),
      ),
      "multiline user status_line should be preserved",
    );
    assert.doesNotMatch(
      toml,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      "default status_line should not overwrite multiline customization",
    );
  });

  it("preserves a customized managed-block status_line when refreshing setup", () => {
    const firstRun = buildMergedConfig("", "/tmp/omx");
    const customized = firstRun.replace(
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      'status_line = ["git-branch", "context-remaining"]',
    );

    const refreshed = buildMergedConfig(customized, "/tmp/omx");

    assert.equal(count(refreshed, /^\[tui\]$/gm), 1, "[tui] should appear once");
    assert.match(
      refreshed,
      /^status_line = \["git-branch", "context-remaining"\]$/m,
      "customized status_line should survive managed-block stripping",
    );
    assert.doesNotMatch(
      refreshed,
      /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      "default status_line should not overwrite customization",
    );
  });

  it("skips emitting an OMX [tui] table when includeTui is disabled", () => {
    const toml = buildMergedConfig("", "/tmp/omx", {
      includeTui: false,
    });

    assert.doesNotMatch(toml, /^\[tui\]$/m);
    assert.match(toml, /^\[mcp_servers\.omx_state\]$/m);
    assert.match(toml, /^\[env\]$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "1"$/m);
  });

  it('seeds USE_OMX_EXPLORE_CMD=1 into generated config by default', () => {
    const toml = buildMergedConfig('', '/tmp/omx');

    assert.match(toml, /^\[env\]$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "1"$/m);
  });

  it('preserves existing [env] keys and explicit explore routing opt-outs', () => {
    const toml = buildMergedConfig(
      ['[env]', 'FOO = "bar"', 'USE_OMX_EXPLORE_CMD = "0"', ''].join('\n'),
      '/tmp/omx',
    );

    assert.match(toml, /^\[env\]$/m);
    assert.match(toml, /^FOO = "bar"$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "0"$/m);
  });

  it("replaces an existing OMX notify entry without leaving orphan fragments behind", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const existing = [
        "[shell_environment_policy]",
        'inherit = "all"',
        "",
        'notify = ["node", "/tmp/legacy-notify-hook.js"]',
        "",
        '    "node",',
        '    "/tmp/legacy-notify-hook.js",',
        "]",
        "",
      ].join("\n");
      await writeFile(configPath, existing);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.equal(count(toml, /^notify\s*=/gm), 1, "notify should appear once");
      assert.match(toml, /^notify = \["node", ".*notify-hook\.js"\]$/m);
      assert.doesNotMatch(toml, /^\s*"node",\s*$/m, "orphan fragment removed");
      assert.doesNotMatch(toml, /legacy-notify-hook\.js/, "legacy notify path removed");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it("seeds context keys when root model is missing and both context keys are absent", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(configPath, 'approval_policy = "on-failure"\n');

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "gpt-5.5"$/m);
      assert.match(
        toml,
        /^# oh-my-codex seeded behavioral defaults \(uninstall removes unchanged defaults\)$/m,
      );
      assert.match(toml, /^model_context_window = 250000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 200000$/m);
      assert.match(toml, /^# End oh-my-codex seeded behavioral defaults$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("can override gpt-5.3-codex to gpt-5.5 and seed 250k context defaults", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const toml = buildMergedConfig('model = \"gpt-5.3-codex\"\n', wd, {
        modelOverride: "gpt-5.5",
      });

      assert.match(toml, /^model = "gpt-5\.5"$/m);
      assert.doesNotMatch(toml, /^model = "gpt-5\.3-codex"$/m);
      assert.match(
        toml,
        /^# oh-my-codex seeded behavioral defaults \(uninstall removes unchanged defaults\)$/m,
      );
      assert.match(toml, /^model_context_window = 250000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 200000$/m);
      assert.match(toml, /^# End oh-my-codex seeded behavioral defaults$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it("does not seed 250k context defaults for non-gpt-5.5 models", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(configPath, 'model = "o3"\n');

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "o3"$/m, "user model preserved");
      assert.doesNotMatch(toml, /^model_context_window = 250000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit = 200000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("seeds missing auto compact limit without overwriting an existing context window", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['model = "gpt-5.5"', "model_context_window = 640000", ""].join("\n"),
      );

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "gpt-5\.5"$/m);
      assert.match(toml, /^model_context_window = 640000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 200000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("seeds missing context window without overwriting an existing auto compact limit", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['model = "gpt-5.5"', "model_auto_compact_token_limit = 150000", ""].join("\n"),
      );

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "gpt-5\.5"$/m);
      assert.match(toml, /^model_context_window = 250000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 150000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not duplicate independently seeded defaults across reruns", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['model = "gpt-5.5"', "model_context_window = 640000", ""].join("\n"),
      );

      await mergeConfig(configPath, wd);
      await mergeConfig(configPath, wd);

      const toml = await readFile(configPath, "utf-8");
      assert.equal(count(toml, /^model_context_window = 640000$/gm), 1);
      assert.equal(count(toml, /^model_auto_compact_token_limit = 200000$/gm), 1);
      assert.doesNotMatch(toml, /^model_context_window = 250000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not duplicate seeded model defaults across reruns", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      await mergeConfig(configPath, wd);

      const toml = await readFile(configPath, "utf-8");
      assert.equal(
        count(toml, /^model = "gpt-5\.5"$/gm),
        1,
        "seeded model should appear once",
      );
      assert.equal(
        count(toml, /^model_context_window = 250000$/gm),
        1,
        "seeded context window should appear once",
      );
      assert.equal(
        count(toml, /^model_auto_compact_token_limit = 200000$/gm),
        1,
        "seeded auto compact limit should appear once",
      );
      assert.equal(
        count(
          toml,
          /^# oh-my-codex seeded behavioral defaults \(uninstall removes unchanged defaults\)$/gm,
        ),
        1,
        "seeded defaults start marker should appear once",
      );
      assert.equal(
        count(toml, /^# End oh-my-codex seeded behavioral defaults$/gm),
        1,
        "seeded defaults end marker should appear once",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("writes only the global [agents] defaults into config", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^\[agents\]$/m, "global [agents] section present");
      assert.match(toml, /^max_threads = 6$/m, "max_threads default written");
      assert.match(toml, /^max_depth = 2$/m, "max_depth default written");
      assert.doesNotMatch(toml, /^\[agents\.[^\]]+\]$/m, "legacy per-agent config_file entries omitted");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("repairs config with duplicate [tui] sections from upgrade", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      // Simulate a broken config left by an older omx setup: an orphaned
      // [tui] outside the OMX block AND another [tui] inside the block.
      const broken = [
        '[mcp_servers.figma]',
        'url = "https://mcp.figma.com/mcp"',
        '',
        '# OMX TUI StatusLine (Codex CLI v0.101.0+)',
        '[tui]',
        'status_line = ["git-branch"]',
        '',
        '# ============================================================',
        '# End oh-my-codex',
        '',
        '# ============================================================',
        '# oh-my-codex (OMX) Configuration',
        '# Managed by omx setup - manual edits preserved on next setup',
        '# ============================================================',
        '',
        '[mcp_servers.omx_state]',
        'command = "node"',
        `args = ["${join(wd, "dist/mcp/state-server.js")}"]`,
        'enabled = true',
        '',
        '# OMX TUI StatusLine (Codex CLI v0.101.0+)',
        '[tui]',
        'status_line = ["model-with-reasoning", "git-branch"]',
        '',
        '# ============================================================',
        '# End oh-my-codex',
        '',
      ].join("\n");
      await writeFile(configPath, broken);

      // buildMergedConfig should produce a clean config with only one [tui]
      const toml = buildMergedConfig(broken, wd);
      assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
      assert.equal(
        count(toml, /^# End oh-my-codex$/gm),
        1,
        "End marker should appear once",
      );
      // User MCP server must survive
      assert.match(toml, /^\[mcp_servers\.figma\]$/m, "user MCP preserved");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("mergeConfig removes legacy omx_team_run tables during setup upgrade", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const legacy = [
        '[user.before]',
        'name = "kept-before"',
        "",
        '# ============================================================',
        '# oh-my-codex (OMX) Configuration',
        '# Managed by omx setup - manual edits preserved on next setup',
        '# ============================================================',
        "",
        '[mcp_servers.omx_team_run]',
        'command = "node"',
        'args = ["/tmp/team-server.js"]',
        'enabled = true',
        "",
        '# ============================================================',
        '# End oh-my-codex',
        "",
        '[user.after]',
        'name = "kept-after"',
        "",
      ].join("\n");
      await writeFile(configPath, legacy);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.doesNotMatch(toml, /^\[mcp_servers\.omx_team_run\]$/m);
      assert.doesNotMatch(toml, /team-server\.js/);
      assert.match(toml, /^\[user\.before\]$/m);
      assert.match(toml, /^name = "kept-before"$/m);
      assert.match(toml, /^\[user\.after\]$/m);
      assert.match(toml, /^name = "kept-after"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("repairConfigIfNeeded removes legacy omx_team_run tables during launch repair", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const legacy = [
        '[user.before]',
        'name = "kept-before"',
        "",
        '[mcp_servers.omx_team_run]',
        'command = "node"',
        'args = ["/tmp/team-server.js"]',
        'enabled = true',
        "",
        '[user.after]',
        'name = "kept-after"',
        "",
      ].join("\n");
      await writeFile(configPath, legacy);

      const didRepair = await repairConfigIfNeeded(configPath, wd);
      assert.equal(didRepair, true, "legacy team-run config should be repaired");

      const toml = await readFile(configPath, "utf-8");
      assertSingleOmxBlock(toml);
      assert.doesNotMatch(toml, /^\[mcp_servers\.omx_team_run\]$/m);
      assert.doesNotMatch(toml, /team-server\.js/);
      assert.match(toml, /^\[user\.before\]$/m);
      assert.match(toml, /^name = "kept-before"$/m);
      assert.match(toml, /^\[user\.after\]$/m);
      assert.match(toml, /^name = "kept-after"$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("repairConfigIfNeeded fixes duplicate [tui] and is a no-op when clean", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");

      // First: create a clean config
      await mergeConfig(configPath, wd);
      const clean = await readFile(configPath, "utf-8");
      assert.equal(count(clean, /^\[tui\]$/gm), 1);

      // repairConfigIfNeeded should be a no-op
      const wasRepaired = await repairConfigIfNeeded(configPath, wd);
      assert.equal(wasRepaired, false, "clean config should not need repair");

      // Now break it by appending a second [tui]
      await writeFile(configPath, clean + "\n[tui]\nstatus_line = [\"git-branch\"]\n");
      const broken = await readFile(configPath, "utf-8");
      assert.equal(count(broken, /^\[tui\]$/gm), 2);

      // repairConfigIfNeeded should fix it
      const didRepair = await repairConfigIfNeeded(configPath, wd);
      assert.equal(didRepair, true, "broken config should be repaired");

      const repaired = await readFile(configPath, "utf-8");
      assert.equal(count(repaired, /^\[tui\]$/gm), 1, "[tui] should appear once after repair");
      assertSingleOmxBlock(repaired);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP registry entries in a dedicated managed block", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const first = buildMergedConfig("", wd, {
        sharedMcpServers: [
          {
            name: "eslint",
            command: "npx",
            args: ["@eslint/mcp@latest"],
            enabled: true,
            startupTimeoutSec: 12,
          },
        ],
        sharedMcpRegistrySource: "/tmp/.omx/mcp-registry.json",
      });
      const second = buildMergedConfig(first, wd, {
        sharedMcpServers: [
          {
            name: "eslint",
            command: "npx",
            args: ["@eslint/mcp@latest"],
            enabled: true,
            startupTimeoutSec: 12,
          },
        ],
        sharedMcpRegistrySource: "/tmp/.omx/mcp-registry.json",
      });

      assert.equal(
        count(second, /oh-my-codex \(OMX\) Shared MCP Registry Sync/g),
        1,
        "shared MCP sync block should appear once",
      );
      assert.equal(
        count(second, /^\[mcp_servers\.eslint\]$/gm),
        1,
        "shared eslint MCP table should appear once",
      );
      assert.match(second, /# Source: \/tmp\/\.omx\/mcp-registry\.json/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips shared MCP entries that already exist in user config", () => {
    const existing = [
      "[mcp_servers.existing_server]",
      'command = "custom"',
      'args = ["serve"]',
      "",
    ].join("\n");
    const merged = buildMergedConfig(existing, "/tmp/omx", {
      sharedMcpServers: [
        {
          name: "existing_server",
          command: "existing-server",
          args: ["mcp"],
          enabled: true,
        },
        {
          name: "eslint",
          command: "npx",
          args: ["@eslint/mcp@latest"],
          enabled: true,
        },
      ],
      sharedMcpRegistrySource: "/tmp/.omx/mcp-registry.json",
    });

    assert.equal(count(merged, /^\[mcp_servers\.existing_server\]$/gm), 1);
    assert.match(merged, /command = "custom"/);
    assert.equal(count(merged, /^\[mcp_servers\.eslint\]$/gm), 1);
  });

  it("adds a default startup timeout to launcher-backed non-OMX MCP servers and stays idempotent", () => {
    const existing = [
      '[mcp_servers.filesystem]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
      "",
    ].join("\n");

    const first = buildMergedConfig(existing, "/tmp/omx");
    const second = buildMergedConfig(first, "/tmp/omx");

    assert.match(first, /^\[mcp_servers\.filesystem\]$/m);
    assert.match(first, /^startup_timeout_sec = 15$/m);
    assert.equal(count(second, /^startup_timeout_sec = 15$/gm), 1);
  });

  it("preserves explicit launcher timeouts and leaves non-launcher MCP servers untouched", () => {
    const existing = [
      '[mcp_servers.fetch]',
      'command = "uvx"',
      'args = ["mcp-server-fetch"]',
      "startup_timeout_sec = 22",
      "",
      '[mcp_servers.custom]',
      'command = "custom-mcp"',
      'args = ["serve"]',
      "",
    ].join("\n");

    const merged = buildMergedConfig(existing, "/tmp/omx");

    assert.equal(count(merged, /^startup_timeout_sec = 22$/gm), 1);
    assert.doesNotMatch(
      merged,
      /\[mcp_servers\.custom\][\s\S]*?startup_timeout_sec = 15/,
    );
  });

  it("treats npm exec launchers as timeout-backed MCP commands", () => {
    const existing = [
      '[mcp_servers.seq]',
      'command = "npm"',
      'args = ["exec", "@modelcontextprotocol/server-sequential-thinking"]',
      "",
    ].join("\n");

    const merged = buildMergedConfig(existing, "/tmp/omx");

    assert.match(merged, /^\[mcp_servers\.seq\]$/m);
    assert.match(merged, /^startup_timeout_sec = 15$/m);
  });

  it("removes an existing multiline developer_instructions assignment as one root entry", () => {
    const existing = [
      'model = "gpt-5.5"',
      'developer_instructions = """Custom instructions survive as valid TOML.',
      'This line used to be orphaned by setup.',
      'This closing line used to break parsing."""',
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\n");

    const merged = buildMergedConfig(existing, "/tmp/omx");

    assert.doesNotMatch(merged, /This line used to be orphaned/);
    assert.doesNotMatch(merged, /This closing line used to break parsing/);
    assert.equal(count(merged, /^developer_instructions\s*=/gm), 1);
    assert.doesNotThrow(() => TOML.parse(merged));
  });

  it("preserves root model values when mergeConfig sees multiline root strings", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        [
          'developer_instructions = """Custom instructions.',
          'Multiple lines.',
          'Done."""',
          'model = "o3"',
          "model_context_window = 123456",
          "",
          "[features]",
          "web_search = true",
          "",
        ].join("\n"),
      );

      await mergeConfig(configPath, wd);
      const merged = await readFile(configPath, "utf-8");

      assert.match(merged, /^model = "o3"$/m);
      assert.match(merged, /^model_context_window = 123456$/m);
      assert.doesNotMatch(merged, /^model_auto_compact_token_limit = 200000$/m);
      assert.doesNotThrow(() => TOML.parse(merged));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("repairConfigIfNeeded backfills launcher-backed MCP startup timeouts", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        [
          '[mcp_servers.filesystem]',
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
          "",
        ].join("\n"),
      );

      const repaired = await repairConfigIfNeeded(configPath, wd);
      const config = await readFile(configPath, "utf-8");

      assert.equal(repaired, true);
      assert.match(config, /^startup_timeout_sec = 15$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
