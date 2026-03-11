/**
 * Idempotency tests for config.toml generator (issue #384)
 * Verifies that repeated `omx setup` runs do not duplicate OMX sections.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMergedConfig, mergeConfig } from "../generator.js";

/** Count occurrences of a pattern in text */
function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Assert the OMX block appears exactly once */
function assertSingleOmxBlock(toml: string): void {
  assert.equal(
    count(toml, /# oh-my-codex \(OMX\) Configuration/g),
    1,
    "OMX marker should appear once",
  );
  assert.equal(
    count(toml, /# End oh-my-codex/g),
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
  assert.equal(count(toml, /^\[tui\]$/gm), 1, "[tui] should appear once");
  assert.equal(
    count(toml, /^\[features\]$/gm),
    1,
    "[features] should appear once",
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
}

describe("config generator idempotency (#384)", () => {
  it("first run creates config with all OMX sections", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.match(toml, /^multi_agent = true$/m);
      assert.match(toml, /^child_agents_md = true$/m);
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
        'model_reasoning_effort = "high"',
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

      // Verify agents appear only inside the OMX block
      const omxBlockStart = toml.indexOf("# oh-my-codex (OMX) Configuration");
      const agentIdx = toml.indexOf("[agents.executor]");
      assert.ok(
        agentIdx > omxBlockStart,
        "agents.executor should be inside OMX block",
      );
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

  it("preserves user [tui] section (not claimed by orphan-strip)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      // User has their own [tui] settings before OMX was installed
      const userTui = ["[tui]", 'status_line = ["git-branch"]', ""].join("\n");
      await writeFile(configPath, userTui);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      // User's [tui] is preserved (not stripped by orphan-strip).
      // The OMX block also writes [tui], so there will be 2 — this is a
      // known limitation for legacy markerless configs. Full convergence
      // requires either renaming the OMX TUI key or a merge strategy.
      assert.match(
        toml,
        /status_line = \["git-branch"\]/,
        "user tui setting preserved",
      );
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

      assert.match(toml, /^model = "gpt-5.4"$/m);
      assert.match(toml, /^model_context_window = 1000000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("can override gpt-5.3-codex to gpt-5.4 and seed 1M context defaults", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const toml = buildMergedConfig('model = \"gpt-5.3-codex\"\n', wd, {
        modelOverride: "gpt-5.4",
      });

      assert.match(toml, /^model = "gpt-5\.4"$/m);
      assert.doesNotMatch(toml, /^model = "gpt-5\.3-codex"$/m);
      assert.match(toml, /^model_context_window = 1000000$/m);
      assert.match(toml, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
  it("does not seed 1M context defaults for non-gpt-5.4 models", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(configPath, 'model = "o3"\n');

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "o3"$/m, "user model preserved");
      assert.doesNotMatch(toml, /^model_context_window = 1000000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit = 900000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves partial user context config without backfilling the missing partner key", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['model = "gpt-5.4"', "model_context_window = 640000", ""].join("\n"),
      );

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model = "gpt-5\.4"$/m);
      assert.match(toml, /^model_context_window = 640000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit = 900000$/m);
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
        count(toml, /^model = "gpt-5\.4"$/gm),
        1,
        "seeded model should appear once",
      );
      assert.equal(
        count(toml, /^model_context_window = 1000000$/gm),
        1,
        "seeded context window should appear once",
      );
      assert.equal(
        count(toml, /^model_auto_compact_token_limit = 900000$/gm),
        1,
        "seeded auto compact limit should appear once",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("writes only installable catalog agents into the OMX agent block", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^\[agents\.executor\]$/m, "active agent kept");
      assert.match(toml, /^\[agents\."code-simplifier"\]$/m, "internal agent kept");
      assert.doesNotMatch(toml, /^\[agents\."style-reviewer"\]$/m, "merged agent omitted");
      assert.doesNotMatch(toml, /^\[agents\."quality-reviewer"\]$/m, "merged agent omitted");
      assert.doesNotMatch(toml, /^\[agents\."product-manager"\]$/m, "merged product agent omitted");
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
      "[mcp_servers.gitnexus]",
      'command = "custom"',
      'args = ["serve"]',
      "",
    ].join("\n");
    const merged = buildMergedConfig(existing, "/tmp/omx", {
      sharedMcpServers: [
        {
          name: "gitnexus",
          command: "gitnexus",
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

    assert.equal(count(merged, /^\[mcp_servers\.gitnexus\]$/gm), 1);
    assert.match(merged, /command = "custom"/);
    assert.equal(count(merged, /^\[mcp_servers\.eslint\]$/gm), 1);
  });

});
