/**
 * Idempotency tests for config.toml generator (issue #384)
 * Verifies that repeated `omx setup` runs do not duplicate OMX sections.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import TOML from "@iarna/toml";
import {
  analyzeLegacyMultiAgentConfig,
  buildMergedConfig,
  cleanCodexModelAvailabilityNuxIfNeeded,
  hasExactOmxSeededBehavioralDefaultsPair,
  mergeConfig,
  repairConfigIfNeeded,
  stripExistingOmxBlocks,
  stripManagedCodexHookTrustState,
  stripOmxFeatureFlags,
  upsertManagedCodexHookTrustState,
  stripOmxSeededBehavioralDefaults,
} from "../generator.js";
import {
  MANAGED_HOOK_EVENTS,
  ManagedCodexHooksPlanError,
  buildManagedCodexHookTrustState,
  planManagedCodexHooksMerge,
} from "../codex-hooks.js";
import { OMX_FIRST_PARTY_MCP_SERVER_NAMES } from "../omx-first-party-mcp.js";

/** Count occurrences of a pattern in text */
function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

async function writeSetupGeneratedHookTrustFixture(wd: string): Promise<{
  configPath: string;
  hooksPath: string;
  config: string;
  trustState: Record<string, { trusted_hash: string }>;
}> {
  const configPath = join(wd, "config.toml");
  const hooksPath = join(wd, "hooks.json");
  const hooksPlan = planManagedCodexHooksMerge(null, wd, hooksPath);
  if (!hooksPlan.ok || hooksPlan.finalContent === null) {
    throw new Error("Expected setup hook plan to produce a hooks artifact.");
  }

  await writeFile(hooksPath, hooksPlan.finalContent);
  const config = buildMergedConfig("", wd, {
    codexHooksFile: hooksPath,
    codexHooksContent: hooksPlan.finalContent,
    managedHookTrustState: hooksPlan.finalTrustState,
    priorManagedHookTrustState: hooksPlan.priorTrustState,
  });
  await writeFile(configPath, config);
  return {
    configPath,
    hooksPath,
    config,
    trustState: hooksPlan.finalTrustState,
  };
}

/** Assert the current OMX block appears exactly once */
function assertSingleOmxBlock(
  toml: string,
  options: { includeFirstPartyMcp?: boolean } = {},
): void {
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
  if (options.includeFirstPartyMcp) {
    assertFirstPartyMcpBlocks(toml);
  } else {
    for (const name of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
      assert.equal(
        count(toml, new RegExp(`^\\[mcp_servers\\.${name}\\]$`, "gm")),
        0,
        `[mcp_servers.${name}] should not be emitted by default`,
      );
    }
  }
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
    count(toml, /^hooks = true$/gm),
    1,
    "hooks should appear once",
  );
  assert.equal(
    count(toml, /^codex_hooks = true$/gm),
    0,
    "legacy codex_hooks should not be emitted",
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
  assert.equal(count(toml, /^\[env\]$/gm), 0, "[env] should not be emitted");
  assert.equal(
    count(toml, /^\[shell_environment_policy\.set\]$/gm),
    1,
    "[shell_environment_policy.set] should appear once",
  );
  assert.equal(
    count(toml, /^USE_OMX_EXPLORE_CMD = "0"$/gm),
    1,
    "USE_OMX_EXPLORE_CMD should appear once",
  );

}

function assertFirstPartyMcpBlocks(toml: string): void {
  const parsed = TOML.parse(toml) as {
    mcp_servers?: Record<string, { command?: unknown }>;
  };
  for (const name of OMX_FIRST_PARTY_MCP_SERVER_NAMES) {
    assert.equal(
      count(toml, new RegExp(`^\\[mcp_servers\\.${name}\\]$`, "gm")),
      1,
      `[mcp_servers.${name}] should appear once when first-party MCP is enabled`,
    );
    const command = parsed.mcp_servers?.[name]?.command;
    assert.equal(
      command,
      process.execPath,
      `[mcp_servers.${name}] should use the Node executable that ran setup`,
    );
    assert.notEqual(
      command,
      "node",
      `[mcp_servers.${name}] should not depend on PATH lookup for node`,
    );
    assert.equal(
      typeof command === "string" && isAbsolute(command),
      true,
      `[mcp_servers.${name}] command should be absolute`,
    );
  }
}

function assertSingleManagedHookTrustState(toml: string): void {
  const parsed = TOML.parse(toml) as {
    hooks?: { state?: Record<string, { trusted_hash?: unknown }> };
  };
  const managedKeys = Object.keys(parsed.hooks?.state ?? {}).filter((key) =>
    key.startsWith("/tmp/codex/hooks.json:"),
  );

  assert.deepEqual(
    managedKeys.sort(),
    [
      "/tmp/codex/hooks.json:post_compact:0:0",
      "/tmp/codex/hooks.json:post_tool_use:0:0",
      "/tmp/codex/hooks.json:pre_compact:0:0",
      "/tmp/codex/hooks.json:pre_tool_use:0:0",
      "/tmp/codex/hooks.json:session_start:0:0",
      "/tmp/codex/hooks.json:stop:0:0",
      "/tmp/codex/hooks.json:user_prompt_submit:0:0",
    ],
  );
  assert.equal(
    count(toml, /^# OMX-owned Codex hook trust state$/gm),
    1,
    "managed hook trust fence should appear once",
  );
  assert.equal(
    count(toml, /^# End OMX-owned Codex hook trust state$/gm),
    1,
    "managed hook trust end fence should appear once",
  );
  assert.equal(
    count(toml, /^\[hooks\.state\."\/tmp\/codex\/hooks\.json:/gm),
    managedKeys.length,
    "managed hook trust tables should not duplicate",
  );
}

describe("Codex transient TUI NUX cleanup", () => {
  it("removes only model availability NUX counters from project-local config", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-codex-nux-cleanup-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(configPath, [
        'model = "gpt-5.6-sol"',
        'status_line = ["model-with-reasoning", "git-branch"]',
        "",
        "[tui]",
        'theme = "dark"',
        "notifications = true",
        "",
        "[tui.model_availability_nux]",
        '"gpt-5.6-sol" = 4',
        '"gpt-5.5" = 1',
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
      assert.doesNotMatch(toml, /gpt-5\.6-sol" = 4/);
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
        'model = "gpt-5.6-sol"',
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
      assert.doesNotMatch(toml, /^multi_agent\s*=/m);
      assert.match(toml, /^child_agents_md = true$/m);
      assert.match(toml, /^hooks = true$/m);
      assert.match(toml, /^goals = true$/m);
      assert.doesNotMatch(toml, /^\[agents\]$/m);
      assert.doesNotMatch(toml, /^max_threads\s*=/m);
      assert.doesNotMatch(toml, /^max_depth\s*=/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("classifies legacy multi-agent keys without mutating config", () => {
    const absent = analyzeLegacyMultiAgentConfig("");
    assert.equal(absent.assessments["features.multi_agent"].state, "absent");

    const legacy = analyzeLegacyMultiAgentConfig(
      [
        "[features]",
        "multi_agent = true",
        "",
        "[agents]",
        "max_threads = 6",
        "max_depth = 2",
      ].join("\n"),
    );
    assert.equal(
      legacy.assessments["features.multi_agent"].state,
      "retained-legacy",
    );
    assert.equal(legacy.assessments["agents.max_threads"].state, "retained-legacy");
    assert.equal(legacy.assessments["agents.max_depth"].state, "retained-legacy");

    const custom = analyzeLegacyMultiAgentConfig(
      "[features]\nmulti_agent = false\n\n[agents]\nmax_threads = 8\nmax_depth = 3\n",
    );
    assert.equal(custom.assessments["features.multi_agent"].state, "custom");
    assert.equal(custom.assessments["agents.max_threads"].state, "custom");
    assert.equal(custom.assessments["agents.max_depth"].state, "custom");

    const invalid = analyzeLegacyMultiAgentConfig("[features\nmulti_agent = true");
    assert.equal(invalid.assessments["features.multi_agent"].state, "invalid/duplicate");

    const duplicate = analyzeLegacyMultiAgentConfig(
      "[features]\nmulti_agent = true\nmulti_agent = false\n",
    );
    assert.equal(duplicate.assessments["features.multi_agent"].state, "invalid/duplicate");
    assert.equal(
      duplicate.assessments["features.multi_agent"].reasonCode,
      "toml-duplicate-key",
    );
  });

  it("preserves legacy multi-agent values and all role tables across fixed-point merges", () => {
    const existing = [
      "[features]",
      "multi_agent = false",
      "",
      "[agents]",
      "max_threads = 8",
      "max_depth = 3",
      "",
      "[agents.executor]",
      'config_file = "/custom/executor.toml"',
      "",
      '[agents."review bot"]',
      'config_file = "/custom/review.toml"',
      "",
    ].join("\n");

    const merged = buildMergedConfig(existing, "/tmp/omx");
    assert.match(merged, /^multi_agent = false$/m);
    assert.match(merged, /^max_threads = 8$/m);
    assert.match(merged, /^max_depth = 3$/m);
    assert.match(merged, /^\[agents\.executor\]$/m);
    assert.match(merged, /^\[agents\."review bot"\]$/m);
    assert.match(merged, /^config_file = "\/custom\/executor\.toml"$/m);
    assert.match(merged, /^config_file = "\/custom\/review\.toml"$/m);
    const parsed = TOML.parse(merged) as {
      agents?: Record<string, unknown>;
    };
    assert.equal(
      (parsed.agents?.executor as { config_file?: string } | undefined)?.config_file,
      "/custom/executor.toml",
    );
    assert.equal(
      (parsed.agents?.["review bot"] as { config_file?: string } | undefined)?.config_file,
      "/custom/review.toml",
    );
    assert.equal(buildMergedConfig(merged, "/tmp/omx"), merged);
  });

  it("can preserve multi_agent while stripping other OMX feature flags", () => {
    const stripped = stripOmxFeatureFlags(
      "[features]\nmulti_agent = false\nchild_agents_md = true\nhooks = true\ngoals = true\n",
      { preserveMultiAgent: true },
    );

    assert.equal(stripped, "[features]\nmulti_agent = false\n");
  });

  it("emits first-party MCP blocks only when explicitly enabled", () => {
    const toml = buildMergedConfig("", "/tmp/omx", {
      includeFirstPartyMcp: true,
    });

    assertSingleOmxBlock(toml, { includeFirstPartyMcp: true });
  });

  it("omits first-party MCP blocks in no-MCP mode while preserving user MCP servers", () => {
    const compatConfig = buildMergedConfig(
      [
        "[mcp_servers.user_tool]",
        'command = "user-tool"',
        'args = ["serve"]',
        "enabled = true",
        "",
      ].join("\n"),
      "/tmp/omx",
      { includeFirstPartyMcp: true },
    );
    const noMcpConfig = buildMergedConfig(compatConfig, "/tmp/omx", {
      includeFirstPartyMcp: false,
    });

    assertSingleOmxBlock(noMcpConfig);
    assert.match(
      noMcpConfig,
      /^\[mcp_servers\.user_tool\]$/m,
      "user-authored MCP servers should not be removed by no-MCP mode",
    );
    assert.doesNotMatch(
      noMcpConfig,
      /dist\/mcp\/state-server\.js/,
      "first-party MCP entrypoints should be removed when no-MCP mode is selected",
    );
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
        "goals = false",
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

  it("preserves user-owned omx-prefixed MCP servers that are not first-party", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      const userMcp = [
        "[mcp_servers.omx_custom]",
        'command = "node"',
        'args = ["/user/custom-server.js"]',
        "enabled = true",
        "",
      ].join("\n");
      await writeFile(configPath, userMcp);

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assertSingleOmxBlock(toml);
      assert.match(
        toml,
        /^\[mcp_servers\.omx_custom\]$/m,
        "user-owned omx-prefixed MCP server preserved",
      );
      assert.match(toml, /^args = \["\/user\/custom-server\.js"\]$/m);
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
        "goals = false",
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
      assert.match(toml, /^\[agents\.executor\]$/m, "known agent table preserved");
      assert.match(toml, /^\[agents\.explore\]$/m, "known agent table preserved");
      assert.match(toml, /^config_file = "\/old\/path\/executor\.toml"$/m);
      assert.match(toml, /^config_file = "\/old\/path\/explore\.toml"$/m);
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
    assert.doesNotMatch(toml, /^\[mcp_servers\.omx_state\]$/m);
    assert.match(toml, /^\[shell_environment_policy\.set\]$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "0"$/m);
  });

  it('seeds USE_OMX_EXPLORE_CMD=0 into generated config by default', () => {
    const toml = buildMergedConfig('', '/tmp/omx');

    assert.doesNotMatch(toml, /^\[env\]$/m);
    assert.match(toml, /^\[shell_environment_policy\.set\]$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "0"$/m);
  });

  it('migrates existing [env] keys and explicit explore routing opt-outs', () => {
    const toml = buildMergedConfig(
      ['[env]', 'FOO = "bar"', 'USE_OMX_EXPLORE_CMD = "0"', ''].join('\n'),
      '/tmp/omx',
    );

    assert.doesNotMatch(toml, /^\[env\]$/m);
    assert.match(toml, /^\[shell_environment_policy\.set\]$/m);
    assert.match(toml, /^FOO = "bar"$/m);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "0"$/m);
  });

  it("migrates multiline [env] values without truncating TOML entries", () => {
    const toml = buildMergedConfig(
      [
        "[env]",
        'FOO = """first line',
        "  second line",
        'third line"""',
        "BAR = [",
        '  "one",',
        '  "two",',
        "]",
        "",
      ].join("\n"),
      "/tmp/omx",
    );

    assert.doesNotMatch(toml, /^\[env\]$/m);
    assert.match(toml, /^\[shell_environment_policy\.set\]$/m);
    assert.match(
      toml,
      /FOO = """first line\n  second line\nthird line"""/,
    );
    assert.match(toml, /BAR = \[\n  "one",\n  "two",\n\]/);
    assert.match(toml, /^USE_OMX_EXPLORE_CMD = "0"$/m);
    assert.doesNotThrow(() => TOML.parse(toml));
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
  it("does not seed context defaults and preserves explicit context settings", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await writeFile(
        configPath,
        ['model = "gpt-5.6-sol"', "model_context_window = 640000", ""].join("\n"),
      );

      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.match(toml, /^model_context_window = 640000$/m);
      assert.doesNotMatch(toml, /^model_auto_compact_token_limit\s*=/m);
      assert.doesNotMatch(toml, /seeded behavioral defaults/);

      await mergeConfig(configPath, wd);
      const repeated = await readFile(configPath, "utf-8");
      assert.equal(repeated, toml);
      assert.doesNotMatch(repeated, /^model_auto_compact_token_limit\s*=/m);
      assert.doesNotMatch(repeated, /seeded behavioral defaults/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("removes exact legacy source spans with LF, CRLF, and EOF variants", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const fixtures = [
      {
        input: `before\n${start}\nmodel_context_window = 250000\nmodel_auto_compact_token_limit = 200000\n${end}\nafter`,
        expected: "before\nafter",
      },
      {
        input: `model_auto_compact_token_limit=123\r\n${start}\r\nmodel_context_window = 250000\r\n${end}\r\n[features]\r\nweb_search = true`,
        expected: "model_auto_compact_token_limit=123\r\n[features]\r\nweb_search = true",
      },
      {
        input: `model_context_window = [\n  1,\n]\n${start}\nmodel_auto_compact_token_limit = 200000\n${end}`,
        expected: "model_context_window = [\n  1,\n]\n",
      },
    ];

    for (const { input, expected } of fixtures) {
      const stripped = stripOmxSeededBehavioralDefaults(input);
      assert.equal(stripped, expected);
      assert.equal(stripOmxSeededBehavioralDefaults(stripped), stripped);
    }
  });

  it("strips bounded customized or siblingless singleton markers and preserves ambiguity", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const customized = `before\r\n${start}\r\nmodel_context_window = 123\r\n${end}\r\nafter`;
    assert.equal(
      stripOmxSeededBehavioralDefaults(customized),
      "before\r\nmodel_context_window = 123\r\nafter",
    );
    const siblingless = `${start}\nmodel_context_window = 250000\n${end}\n[features]\nmodel_auto_compact_token_limit = 999`;
    assert.equal(
      stripOmxSeededBehavioralDefaults(siblingless),
      "model_context_window = 250000\n[features]\nmodel_auto_compact_token_limit = 999",
    );
    const ambiguous = `${start}\nmodel_context_window = 250000\n${end}\nmodel_auto_compact_token_limit = 1\nmodel_auto_compact_token_limit = 2`;
    assert.equal(stripOmxSeededBehavioralDefaults(ambiguous), ambiguous);
    const sameKeyOutside = `model_context_window = 1\n${start}\nmodel_context_window = 250000\n${end}\nmodel_auto_compact_token_limit = 2`;
    assert.equal(stripOmxSeededBehavioralDefaults(sameKeyOutside), sameKeyOutside);
    const malformed = `${start}\nmodel_context_window = 250000`;
    assert.equal(stripOmxSeededBehavioralDefaults(malformed), malformed);
  });

  it("preserves every byte inside noncanonical bounded blocks", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const bodies = [
      ["model_context_window = 250000", "# user comment", "model_auto_compact_token_limit = 200000"],
      ["model_context_window = 250000", "", "model_auto_compact_token_limit = 200000"],
      [" model_context_window = 250000", "model_auto_compact_token_limit = 200000"],
      ["model_context_window = 250000", "model_auto_compact_token_limit = 200000 "],
      ["model_auto_compact_token_limit = 200000", "model_context_window = 250000"],
      ["model_context_window = 250000", "model_context_window = 250000", "model_auto_compact_token_limit = 200000"],
      ["model_context_window = 250000", "unexpected = true", "model_auto_compact_token_limit = 200000"],
      ["model_context_window = 250_000", "model_auto_compact_token_limit = 200000"],
      ["", "model_context_window = 250000", "model_auto_compact_token_limit = 200000", ""],
    ];

    for (const body of bodies) {
      const input = ["before", start, ...body, end, "after"].join("\n");
      const expected = ["before", ...body, "after"].join("\n");
      const stripped = stripOmxSeededBehavioralDefaults(input);
      assert.equal(stripped, expected);
      assert.equal(stripOmxSeededBehavioralDefaults(stripped), stripped);
    }
  });

  it("fails closed for duplicate assignments and malformed marker topologies", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const pair = [start, "model_context_window = 250000", "model_auto_compact_token_limit = 200000", end];
    const unchanged = [
      ["model_context_window = 999", ...pair, "after"].join("\n"),
      [...pair, "model_auto_compact_token_limit = 999", "after"].join("\n"),
      [start, start, "model_context_window = 250000", "model_auto_compact_token_limit = 200000", end, end].join("\n"),
      [...pair, ...pair].join("\n"),
    ];

    for (const input of unchanged) {
      assert.equal(stripOmxSeededBehavioralDefaults(input), input);
      assert.equal(hasExactOmxSeededBehavioralDefaultsPair(input), false);
    }

    const invalidSuffix = ["before", ...pair, "invalid = [", ""].join("\n");
    const expected = "before\ninvalid = [\n";
    assert.equal(stripOmxSeededBehavioralDefaults(invalidSuffix), expected);
    assert.equal(stripOmxSeededBehavioralDefaults(expected), expected);
  });

  it("ignores marker-shaped text inside TOML values and fails closed on stray markers", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const stringContent = [
      'developer_instructions = """',
      start,
      "model_context_window = 250000",
      "model_auto_compact_token_limit = 200000",
      end,
      '"""',
      "",
    ].join("\n");
    assert.equal(stripOmxSeededBehavioralDefaults(stringContent), stringContent);
    assert.equal(hasExactOmxSeededBehavioralDefaultsPair(stringContent), false);

    const duplicateAfterTable = [
      start,
      "model_context_window = 250000",
      "model_auto_compact_token_limit = 200000",
      end,
      "[tui]",
      start,
      "",
    ].join("\n");
    assert.equal(stripOmxSeededBehavioralDefaults(duplicateAfterTable), duplicateAfterTable);
    assert.equal(hasExactOmxSeededBehavioralDefaultsPair(duplicateAfterTable), false);
  });

  it("migrates before reconstruction without incremental normalization", () => {
    const start = "# oh-my-codex seeded behavioral defaults (uninstall removes unchanged defaults)";
    const end = "# End oh-my-codex seeded behavioral defaults";
    const fixtures = [
      {
        baseline: 'approval_policy = "on-failure"\n[features]\nweb_search = true\n',
        migrated: `approval_policy = "on-failure"\n${start}\nmodel_context_window = 250000\nmodel_auto_compact_token_limit = 200000\n${end}\n[features]\nweb_search = true\n`,
      },
      {
        baseline: "model_auto_compact_token_limit = [\n  999,\n]\n[features]\nweb_search = true\n",
        migrated: `model_auto_compact_token_limit = [\n  999,\n]\n${start}\nmodel_context_window = 250000\n${end}\n[features]\nweb_search = true\n`,
      },
      {
        baseline: "# explicit sibling\nmodel_context_window   =   640000\n[features]\nweb_search = true\n",
        migrated: `# explicit sibling\nmodel_context_window   =   640000\n${start}\nmodel_auto_compact_token_limit = 200000\n${end}\n[features]\nweb_search = true\n`,
      },
    ];

    for (const fixture of fixtures) {
      const baseline = buildMergedConfig(fixture.baseline, "/tmp/omx");
      const migrated = buildMergedConfig(fixture.migrated, "/tmp/omx");
      assert.equal(migrated, baseline);
      assert.equal(buildMergedConfig(migrated, "/tmp/omx"), migrated);
      assert.doesNotMatch(migrated, /seeded behavioral defaults/);
      assert.doesNotThrow(() => TOML.parse(migrated));
    }
  });

  it("does not write retired global [agents] defaults", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const configPath = join(wd, "config.toml");
      await mergeConfig(configPath, wd);
      const toml = await readFile(configPath, "utf-8");

      assert.doesNotMatch(toml, /^\[agents\]$/m);
      assert.doesNotMatch(toml, /^max_threads\s*=/m);
      assert.doesNotMatch(toml, /^max_depth\s*=/m);
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

  it("strips only complete exact OMX marker blocks outside TOML values", () => {
    const start = "# oh-my-codex (OMX) Configuration";
    const end = "# End oh-my-codex";
    const decoys = [
      `basic = "${start}"`,
      `literal = '${end}'`,
      'multiline_basic = """',
      start,
      end,
      '"""',
      "multiline_literal = '''",
      start,
      end,
      "'''",
      `# Marker-shaped text: ${start}`,
      `# Marker-shaped text: ${end}`,
    ];
    const decoyOnly = [...decoys, ""].join("\n");
    assert.deepEqual(stripExistingOmxBlocks(decoyOnly), {
      cleaned: decoyOnly,
      removed: 0,
    });

    const incomplete = [...decoys, "", start, "[user.incomplete]", "enabled = true", ""].join("\n");
    assert.deepEqual(stripExistingOmxBlocks(incomplete), {
      cleaned: incomplete,
      removed: 0,
    });

    const managed = [
      ...decoys,
      "",
      "# ============================================================",
      start,
      "[mcp_servers.omx_state]",
      'command = "node"',
      end,
      "",
      "[user.after]",
      'name = "kept"',
      "",
    ].join("\n");
    const expected = [...decoys, "", "[user.after]", 'name = "kept"', ""].join("\n");

    assert.deepEqual(stripExistingOmxBlocks(managed), {
      cleaned: expected,
      removed: 1,
    });
    assert.doesNotThrow(() => TOML.parse(expected));
  });

  it("keeps OMX delimiter comments inert inside complete TOML assignments", () => {
    const start = "# oh-my-codex (OMX) Configuration";
    const end = "# End oh-my-codex";
    const fixtures = [
      ["root multiline array", ["root = [", start, end, "]"].join("\n")],
      ["dotted multiline array", ["outer.value = [", start, end, "]"].join("\n")],
      ["quoted multiline array", ['"quoted" = [', start, end, "]"].join("\n")],
      ["empty-quoted multiline array", ['"" = [', start, end, "]"].join("\n")],
      ["root multiline basic value", ['root_value = """', start, end, '"""'].join("\n")],
      ["dotted multiline literal value", ["outer.literal = '''", start, end, "'''"].join("\n")],
    ] as const;

    for (const [name, assignment] of fixtures) {
      const config = `${assignment}\n`;
      assert.doesNotThrow(() => TOML.parse(config), `${name} fixture must be valid TOML`);
      assert.deepEqual(stripExistingOmxBlocks(config), { cleaned: config, removed: 0 }, name);

      const merged = buildMergedConfig(config, "/tmp/omx");
      assert.ok(merged.includes(assignment), `${name} bytes must survive merging`);
      assert.doesNotThrow(() => TOML.parse(merged), `${name} merged config must be valid TOML`);
    }
  });

  it("rejects marker-contained hook trust state without ownership proof", () => {
    const start = "# oh-my-codex (OMX) Configuration";
    const end = "# End oh-my-codex";
    const fixtures = [
      ["table", ['[hooks.state."foreign"]', 'trusted_hash = "sha256:foreign"'].join("\n")],
      ["dotted", 'hooks.state."foreign" = { trusted_hash = "sha256:foreign" }'],
      ["inline", 'hooks = { state = { foreign = { trusted_hash = "sha256:foreign" } } }'],
      ["scalar", 'hooks.state = "foreign"'],
    ] as const;
    const isManagedTrustConflict = (error: unknown): boolean =>
      error instanceof ManagedCodexHooksPlanError &&
      error.code === "managed_trust_key_conflict";

    for (const [name, content] of fixtures) {
      const config = [start, content, end, ""].join("\n");
      assert.doesNotThrow(() => TOML.parse(config), `${name} fixture must be valid TOML`);
      assert.throws(() => stripExistingOmxBlocks(config), isManagedTrustConflict, name);
      assert.throws(() => buildMergedConfig(config, "/tmp/omx"), isManagedTrustConflict, name);
    }
  });

  it("matches managed hooks.state keys case-sensitively", () => {
    const start = "# oh-my-codex (OMX) Configuration";
    const end = "# End oh-my-codex";
    const variants = [
      'Hooks.state = { foreign = { trusted_hash = "sha256:foreign" } }',
      'hooks.State = { foreign = { trusted_hash = "sha256:foreign" } }',
      '"Hooks"."State" = { foreign = { trusted_hash = "sha256:foreign" } }',
    ];

    for (const variant of variants) {
      const config = [start, variant, end, ""].join("\n");
      assert.doesNotThrow(() => TOML.parse(config));
      assert.equal(
        stripManagedCodexHookTrustState(config, { managedTrustState: {} }),
        config,
        `${variant} must remain foreign`,
      );
      assert.doesNotThrow(() => buildMergedConfig(config, "/tmp/omx"));
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

  it("repairs duplicate TUI config with setup-generated hook trust from the current hooks artifact", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const { configPath, config: setupConfig } = await writeSetupGeneratedHookTrustFixture(wd);
      const trustBlock = setupConfig.match(
        /# OMX-owned Codex hook trust state\n[\s\S]*?# End OMX-owned Codex hook trust state/,
      )?.[0];
      assert.ok(trustBlock, "setup fixture must contain fenced managed hook trust");
      const setupTrustState = (TOML.parse(setupConfig) as {
        hooks?: { state?: Record<string, unknown> };
      }).hooks?.state;

      await writeFile(
        configPath,
        `${setupConfig}\n[tui]\nstatus_line = ["git-branch"]\n`,
      );

      assert.equal(await repairConfigIfNeeded(configPath, wd), true);
      const repaired = await readFile(configPath, "utf-8");
      const repairedTrustState = (TOML.parse(repaired) as {
        hooks?: { state?: Record<string, unknown> };
      }).hooks?.state;

      assert.equal(count(repaired, /^\[tui\]$/gm), 1);
      assert.ok(repaired.includes(trustBlock), "repair must preserve setup-generated trust bytes");
      assert.deepEqual(repairedTrustState, setupTrustState);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed without rewriting managed hook trust when launch repair cannot prove it", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-idem-"));
    try {
      const { configPath, hooksPath, config: setupConfig, trustState } =
        await writeSetupGeneratedHookTrustFixture(wd);
      const [firstTrustState] = Object.values(trustState);
      assert.ok(firstTrustState);
      const repairTarget = `${setupConfig}\n[tui]\nstatus_line = ["git-branch"]\n`;
      const conflicting = repairTarget.replace(
        firstTrustState.trusted_hash,
        "sha256:conflicting-user-trust",
      );
      await writeFile(configPath, conflicting);

      await assert.rejects(
        repairConfigIfNeeded(configPath, wd),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
      );
      assert.equal(await readFile(configPath, "utf-8"), conflicting);

      const unprovenHooks = [
        ["invalid", "{ not valid JSON"],
        [
          "ambiguous",
          JSON.stringify({
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: `NODE ${join(wd, "dist", "scripts", "codex-native-hook.js")}`,
                    },
                  ],
                },
              ],
            },
          }),
        ],
        ["missing", null],
      ] as const;
      for (const [name, hooksContent] of unprovenHooks) {
        await writeFile(configPath, repairTarget);
        if (hooksContent === null) {
          await rm(hooksPath);
        } else {
          await writeFile(hooksPath, hooksContent);
        }

        await assert.rejects(
          repairConfigIfNeeded(configPath, wd),
          (error: unknown) => error instanceof ManagedCodexHooksPlanError,
          name,
        );
        assert.equal(await readFile(configPath, "utf-8"), repairTarget, name);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves trailing user config after an unmatched managed hook trust-state start marker", () => {
    const malformed = [
      'model = "gpt-5.6-sol"',
      "",
      "# OMX-owned Codex hook trust state",
      "# Missing the end fence must not cause trailing user config deletion.",
      "",
      '[hooks.state."custom:/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:user"',
      "enabled = false",
      "",
      "[hooks.state.user_prompt_submit]",
      'trusted_hash = "sha256:prompt"',
      "enabled = true",
      "",
    ].join("\n");

    const stripped = stripManagedCodexHookTrustState(malformed);

    assert.match(stripped, /^# OMX-owned Codex hook trust state$/m);
    assert.match(stripped, /^\[hooks\.state\."custom:\/hooks\.json:stop:0:0"\]$/m);
    assert.match(stripped, /^enabled = false$/m);
    assert.match(stripped, /^\[hooks\.state\.user_prompt_submit\]$/m);
    assert.match(stripped, /^trusted_hash = "sha256:prompt"$/m);
    assert.doesNotThrow(() => TOML.parse(stripped));
  });

  it("removes orphaned managed hook trust-state tables only when hashes prove ownership", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const managedPostCompactHash =
      managedTrustState[`${hooksPath}:post_compact:0:0`]?.trusted_hash;
    const managedStopHash = managedTrustState[`${hooksPath}:stop:0:0`]?.trusted_hash;
    assert.ok(managedPostCompactHash);
    assert.ok(managedStopHash);
    const orphaned = [
      'model = "gpt-5.6-sol"',
      "",
      "[hooks.state]",
      "",
      '[plugins."oh-my-codex@oh-my-codex-local"]',
      "enabled = true",
      "",
      '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
      `trusted_hash = "${managedPostCompactHash}"`,
      "",
      '[hooks.state."/tmp/codex/hooks.json:stop:0:0"]',
      `trusted_hash = "${managedStopHash}"`,
      "",
      '[hooks.state."custom:/hooks.json:stop:0:0"]',
      'trusted_hash = "sha256:user"',
      "",
      "# End OMX-owned Codex hook trust state",
      "",
      "[desktop]",
      "git-create-pull-request-as-draft = true",
      "",
    ].join("\n");

    const stripped = stripManagedCodexHookTrustState(orphaned, {
      managedTrustState,
    });

    assert.doesNotMatch(stripped, /\/tmp\/codex\/hooks\.json:post_compact:0:0/);
    assert.doesNotMatch(stripped, /\/tmp\/codex\/hooks\.json:stop:0:0/);
    assert.match(stripped, /^# End OMX-owned Codex hook trust state$/m);
    assert.match(stripped, /^\[hooks\.state\."custom:\/hooks\.json:stop:0:0"\]$/m);
    assert.match(stripped, /^trusted_hash = "sha256:user"$/m);
    assert.match(stripped, /^\[desktop\]$/m);
    assert.doesNotThrow(() => TOML.parse(stripped));
  });

  it("fails closed on conflicting same-key hook trust state", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const config = [
      'model = "gpt-5.6-sol"',
      "",
      '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
      'trusted_hash = "sha256:user"',
      "enabled = false",
      "",
    ].join("\n");

    assert.throws(
      () => upsertManagedCodexHookTrustState(config, "/tmp/omx", hooksPath),
      (error: unknown) =>
        error instanceof ManagedCodexHooksPlanError &&
        error.code === "managed_trust_key_conflict",
    );
  });

  it("fails closed on unproven same-key hook trust-state tables", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const fixtures = [
      [
        "missing hash",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
          "enabled = false",
        ],
      ],
      [
        "malformed hash",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
          "trusted_hash = true",
        ],
      ],
      [
        "extra assignment",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
          'trusted_hash = "sha256:user"',
          "enabled = false",
        ],
      ],
      [
        "body comment",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
          "# user comment",
          'trusted_hash = "sha256:user"',
        ],
      ],
      [
        "inline body comment",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
          'trusted_hash = "sha256:user" # user comment',
        ],
      ],
      [
        "inline header comment",
        [
          '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"] # user comment',
          'trusted_hash = "sha256:user"',
        ],
      ],
    ] as const;

    for (const [name, table] of fixtures) {
      assert.throws(
        () =>
          stripManagedCodexHookTrustState(table.join("\n"), {
            managedTrustState,
          }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
        name,
      );
    }
  });

  it("handles semantically equivalent TOML trust-key variants before writing a replacement", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const matchingHeaders = [
      `[hooks.state.'${key}']`,
      `[hooks.state."${key.replace(/\//g, "\\u002f")}"]`,
    ];

    for (const header of matchingHeaders) {
      const matching = [header, `trusted_hash = "${hash}"`, ""].join("\n");
      const refreshed = upsertManagedCodexHookTrustState(
        matching,
        "/tmp/omx",
        hooksPath,
        { managedTrustState },
      );
      assert.equal(count(refreshed, /^\[hooks\.state\./gm), Object.keys(managedTrustState).length);
      assert.equal(
        (TOML.parse(refreshed) as { hooks?: { state?: Record<string, unknown> } })
          .hooks?.state?.[key] !== undefined,
        true,
      );
    }

    const conflicting = [
      matchingHeaders[0],
      'trusted_hash = "sha256:foreign"',
      "",
    ].join("\n");
    assert.throws(
      () => upsertManagedCodexHookTrustState(conflicting, "/tmp/omx", hooksPath, { managedTrustState }),
      (error: unknown) =>
        error instanceof ManagedCodexHooksPlanError &&
        error.code === "managed_trust_key_conflict",
    );
  });

  it("removes only a single exact proven managed dotted hook trust assignment", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const exactAssignments = [
      `hooks.state."${key}".trusted_hash = "${hash}"`,
      `hooks . state . '${key}' . trusted_hash = "${hash}"`,
    ];
    for (const exact of exactAssignments) {
      assert.equal(
        stripManagedCodexHookTrustState(exact, { managedTrustState }),
        "",
      );
    }
    const exact = exactAssignments[1]!;
    const refreshed = upsertManagedCodexHookTrustState(
      exact,
      "/tmp/omx",
      hooksPath,
      { managedTrustState },
    );
    assert.doesNotMatch(refreshed, /^hooks\s*\.\s*state\s*\./m);
    assert.equal(count(refreshed, /^\[hooks\.state\./gm), Object.keys(managedTrustState).length);
  });

  it("fails closed for conflicting, commented, or multi-field managed dotted hook trust assignments", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const assignment = `hooks.state.'${key}'.trusted_hash = "${hash}"`;
    const fixtures = [
      assignment.replace(hash!, "sha256:foreign"),
      `${assignment}\nhooks.state.'${key}'.enabled = true`,
      `${assignment} # user comment`,
    ];

    for (const fixture of fixtures) {
      assert.throws(
        () => stripManagedCodexHookTrustState(fixture, { managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
      );
    }
  });

  it("removes exact inline hook trust state without changing adjacent TOML", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const exactWholeStatement = `hooks = { state = { "${key}" = { trusted_hash = "${hash}" } } }`;
    assert.equal(
      stripManagedCodexHookTrustState(exactWholeStatement, { managedTrustState }),
      "",
      "an exact single-field inline hooks state remains removable",
    );
    const inline = [
      'model = "gpt-5.6-sol"',
      `hooks.state.'${key}' = { trusted_hash = '${hash}' }`,
      "",
      "[desktop]",
      "git-create-pull-request-as-draft = true",
      "",
    ].join("\n");

    const stripped = stripManagedCodexHookTrustState(inline, { managedTrustState });
    assert.doesNotMatch(stripped, /hooks\.state/);
    assert.match(stripped, /^model = "gpt-5\.6-sol"$/m);
    assert.match(stripped, /^\[desktop\]$/m);
    assert.match(stripped, /^git-create-pull-request-as-draft = true$/m);
    assert.doesNotThrow(() => TOML.parse(stripped));

    const refreshed = upsertManagedCodexHookTrustState(
      inline,
      "/tmp/omx",
      hooksPath,
      { managedTrustState },
    );
    assert.equal(
      Object.keys(
        (TOML.parse(refreshed) as { hooks?: { state?: Record<string, unknown> } })
          .hooks?.state ?? {},
      ).filter((stateKey) => stateKey === key).length,
      1,
    );
  });

  it("fails closed for inline, dotted, and table hook trust representations with foreign siblings", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const fixtures = [
      [
        "inline",
        `hooks = { state = { "${key}" = { trusted_hash = "${hash}" } }, foreign = "keep" }`,
      ],
      [
        "dotted",
        `hooks.state = { "${key}" = { trusted_hash = "${hash}" }, foreign = "keep" }`,
      ],
      [
        "table",
        [
          "[hooks]",
          `state = { "${key}" = { trusted_hash = "${hash}" } }`,
          'foreign = "keep"',
        ].join("\n"),
      ],
    ] as const;

    for (const [name, fixture] of fixtures) {
      assert.doesNotThrow(() => TOML.parse(fixture), `${name} fixture must be valid TOML`);
      assert.throws(
        () => stripManagedCodexHookTrustState(fixture, { managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
        `${name} cleanup must preserve the entire foreign-containing representation`,
      );
      assert.throws(
        () => upsertManagedCodexHookTrustState(fixture, "/tmp/omx", hooksPath, { managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
        `${name} refresh must preserve the original bytes`,
      );
    }
  });

  it("fails closed for commented trust assignments inside a managed config marker", () => {
    const fixture = [
      "# oh-my-codex (OMX) Configuration",
      'hooks.state."foreign-key".trusted_hash = "sha256:foreign" # preserve me',
      "# End oh-my-codex",
      "",
    ].join("\n");

    assert.throws(
      () => stripManagedCodexHookTrustState(fixture, { managedTrustState: {} }),
      (error: unknown) =>
        error instanceof ManagedCodexHooksPlanError &&
        error.code === "managed_trust_key_conflict",
    );
  });

  it("fails closed on every non-record hooks.state form inside managed markers", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const fixtures = [
      ["scalar", 'hooks.state = "foreign"'],
      ["array", "hooks.state = []"],
      ["quoted state key", 'hooks."state" = "foreign"'],
      ["inline non-record", 'hooks = { state = "foreign" }'],
      [
        "array of tables",
        ["[[hooks.state]]", 'trusted_hash = "sha256:foreign"'].join("\n"),
      ],
    ] as const;

    for (const [name, value] of fixtures) {
      const fixture = [
        "# oh-my-codex (OMX) Configuration",
        value,
        "# End oh-my-codex",
        "",
      ].join("\n");
      assert.doesNotThrow(() => TOML.parse(fixture), `${name} fixture must be valid TOML`);
      assert.throws(
        () => stripManagedCodexHookTrustState(fixture, { managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
        name,
      );
    }
  });

  it("fails closed before stripping malformed hooks.state spellings", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const spellings = [
      ["quoted state key", 'hooks."state" ='],
      ["quoted hooks key", '"hooks".state ='],
      ["fully quoted dotted key", '"hooks"."state" ='],
      ["whitespace-delimited malformed array", 'hooks \t. "state" \t= ['],
      ["malformed inline table", 'hooks = { "state" = {'],
      ["incomplete table header", '[ "hooks" . "state"'],
      ["incomplete array table header", '[[ "hooks" . "state" ]'],
      ["incomplete hooks table header prefix", "[hooks"],
      ["incomplete hooks array table header prefix", "[[hooks"],
      ["partial hooks array-table closer", "[[hooks] # continuation"],
      ["whitespace-split hooks array-table closer", "[[hooks] ]"],
      [
        "split hooks array-table closer",
        ["[[hooks]", "]"].join("\n"),
      ],
      [
        "comment-separated hooks assignment continuation",
        [
          "hooks # continuation",
          '= { "state" = { trusted_hash = "sha256:foreign" } }',
        ].join("\n"),
      ],
      [
        "bare hooks assignment continuation",
        [
          "hooks",
          '= { "state" = { trusted_hash = "sha256:foreign" } }',
        ].join("\n"),
      ],
      [
        "comment-separated hooks dotted-key continuation",
        [
          "hooks # continuation",
          '. "state" = { trusted_hash = "sha256:foreign" }',
        ].join("\n"),
      ],
      [
        "comment-separated hooks table-header continuation",
        ["hooks # continuation", '[ "state" ]'].join("\n"),
      ],
      [
        "comment-separated hooks array-table-header continuation",
        ["hooks # continuation", '[[ "state" ]]'].join("\n"),
      ],
      [
        "split dotted key",
        ["hooks .", '"state" = { trusted_hash = "sha256:foreign" }'].join("\n"),
      ],
      [
        "unclosed multiline inline table",
        ["hooks = {", '"state" = { trusted_hash = "sha256:foreign" }'].join("\n"),
      ],
      [
        "comment-ended inline table continuation",
        [
          "hooks = { # continuation",
          '"state" = { trusted_hash = "sha256:foreign" }',
        ].join("\n"),
      ],
      [
        "bare hooks assignment with inline-table continuation",
        [
          "hooks =",
          '{ "state" = { trusted_hash = "sha256:foreign" } }',
        ].join("\n"),
      ],
    ] as const;

    const isManagedTrustConflict = (error: unknown): boolean =>
      error instanceof ManagedCodexHooksPlanError &&
      error.code === "managed_trust_key_conflict";

    for (const [name, spelling] of spellings) {
      const fixture = [
        "# oh-my-codex (OMX) Configuration",
        spelling,
        "# End oh-my-codex",
        "",
        "[user.after]",
        'value = "preserved"',
        "",
      ].join("\n");
      const original = fixture;

      assert.throws(
        () => buildMergedConfig(fixture, "/tmp/omx", { managedHookTrustState: managedTrustState }),
        isManagedTrustConflict,
        `${name} must fail before OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} planning must not mutate input`);
      assert.throws(
        () => stripExistingOmxBlocks(fixture),
        isManagedTrustConflict,
        `${name} must not be erased by direct OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} stripping must not mutate input`);
    }

    const exactQuoted = [
      "# oh-my-codex (OMX) Configuration",
      `["hooks"."state"."${key}"]`,
      `trusted_hash = "${hash}"`,
      "# End oh-my-codex",
      "",
    ].join("\n");
    assert.throws(
      () => stripExistingOmxBlocks(exactQuoted),
      isManagedTrustConflict,
      "direct stripping must not infer ownership without trust expectations",
    );
    assert.deepEqual(stripExistingOmxBlocks(exactQuoted, { managedTrustState }), {
      cleaned: "",
      removed: 1,
    });
    assert.doesNotThrow(() =>
      buildMergedConfig(exactQuoted, "/tmp/omx", { managedHookTrustState: managedTrustState }),
    );
  });

  it("fails closed when hooks scope crosses parsed assignments or malformed headers", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const validNestedArrayAssignment = [
      "values = [",
      '  ["unrelated"]',
      "]",
    ];
    assert.doesNotThrow(() =>
      TOML.parse(["[hooks]", ...validNestedArrayAssignment].join("\n")),
    );
    const fixtures = [
      [
        "parsed nested assignment",
        ["[hooks]", ...validNestedArrayAssignment, "state ="].join("\n"),
      ],
      [
        "malformed bracket-prefixed line",
        ["[hooks]", "[broken", "state ="].join("\n"),
      ],
    ] as const;
    const isManagedTrustConflict = (error: unknown): boolean =>
      error instanceof ManagedCodexHooksPlanError &&
      error.code === "managed_trust_key_conflict";

    for (const [name, content] of fixtures) {
      const fixture = [
        "# oh-my-codex (OMX) Configuration",
        content,
        "# End oh-my-codex",
        "",
        "[user.after]",
        'value = "preserved"',
        "",
      ].join("\n");
      const original = fixture;

      assert.throws(
        () => stripExistingOmxBlocks(fixture),
        isManagedTrustConflict,
        `${name} must not be erased by direct OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} stripping must not mutate input`);
      assert.throws(
        () => buildMergedConfig(fixture, "/tmp/omx", { managedHookTrustState: managedTrustState }),
        isManagedTrustConflict,
        `${name} must fail before OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} planning must not mutate input`);
    }

    const validNonHooksHeaderExit = [
      "# oh-my-codex (OMX) Configuration",
      "[hooks]",
      "[unrelated]",
      "state =",
      "# End oh-my-codex",
      "",
      "[user.after]",
      'value = "preserved"',
      "",
    ].join("\n");
    const expectedExit = ["[user.after]", 'value = "preserved"', ""].join("\n");
    assert.deepEqual(stripExistingOmxBlocks(validNonHooksHeaderExit), {
      cleaned: expectedExit,
      removed: 1,
    });
    assert.doesNotThrow(() =>
      buildMergedConfig(validNonHooksHeaderExit, "/tmp/omx", {
        managedHookTrustState: managedTrustState,
      }),
    );
  });

  it("fails closed for hooks array-table openers and preserves unrelated arrays", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const arrayTableOpeners = [
      ["adjacent", "[[hooks]]"],
      ["space-split", "[ [hooks]]"],
      ["tab-split", "[\t[hooks]]"],
      ["newline-split", ["[[", "hooks]]"].join("\n")],
      [
        "two standalone opening brackets followed by independently parsed state",
        [
          "[",
          "[",
          "hooks]]",
          'state = { trusted_hash = "sha256:foreign" }',
        ].join("\n"),
      ],
      [
        "three standalone opening brackets followed by independently parsed state",
        [
          "[",
          "[",
          "[",
          "hooks]]]",
          'state = { trusted_hash = "sha256:foreign" }',
        ].join("\n"),
      ],
      [
        "comment- and blank-separated standalone opening brackets",
        [
          "[",
          "# opening bracket continuation",
          "",
          "[",
          "",
          "# another opening bracket continuation",
          "[",
          "hooks]]]",
          'state = { trusted_hash = "sha256:foreign" }',
        ].join("\n"),
      ],
      ["triple", "[[[hooks]]]"],
      ["extra", "[[[[hooks]]]]"],
      ["space-newline-split", ["[ [", "hooks]]"].join("\n")],
      ["tab-newline-split", ["[\t[", "hooks]]"].join("\n")],
      ["triple-newline-split", ["[[[", "hooks]]]"].join("\n")],
      ["comment-ended", ["[[ # continuation", "hooks]]"].join("\n")],
    ] as const;
    const isManagedTrustConflict = (error: unknown): boolean =>
      error instanceof ManagedCodexHooksPlanError &&
      error.code === "managed_trust_key_conflict";

    for (const [name, opener] of arrayTableOpeners) {
      const fixture = [
        "# oh-my-codex (OMX) Configuration",
        opener,
        "# End oh-my-codex",
        "",
        "[user.after]",
        'value = "preserved"',
        "",
      ].join("\n");
      const original = fixture;

      assert.throws(
        () =>
          buildMergedConfig(fixture, "/tmp/omx", {
            managedHookTrustState: managedTrustState,
          }),
        isManagedTrustConflict,
        `${name} opener must fail before OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} planning must not mutate input`);
      assert.throws(
        () => stripExistingOmxBlocks(fixture),
        isManagedTrustConflict,
        `${name} opener must not be erased by direct OMX block stripping`,
      );
      assert.equal(fixture, original, `${name} stripping must not mutate input`);
    }

    const unrelatedArrays = [
      "[[user.before]]",
      'name = "before"',
      "",
      "# oh-my-codex (OMX) Configuration",
      "[[unrelated]]",
      'name = "inside managed marker"',
      "# End oh-my-codex",
      "",
      "[[user.after]]",
      'name = "after"',
      "",
    ].join("\n");
    const preservedArrays = [
      "[[user.before]]",
      'name = "before"',
      "",
      "[[user.after]]",
      'name = "after"',
      "",
    ].join("\n");

    assert.deepEqual(stripExistingOmxBlocks(unrelatedArrays), {
      cleaned: preservedArrays,
      removed: 1,
    });
    const merged = buildMergedConfig(unrelatedArrays, "/tmp/omx");
    assert.match(merged, /^\[\[user\.before\]\]$/m);
    assert.match(merged, /^\[\[user\.after\]\]$/m);
    assert.doesNotMatch(merged, /^\[\[unrelated\]\]$/m);
    assert.doesNotThrow(() => TOML.parse(merged));
  });

  it("removes valid nested hooks arrays inside exact managed marker ranges", () => {
    const fixture = [
      "# oh-my-codex (OMX) Configuration",
      "values = [",
      "  [",
      "",
      "    # a value named hooks is not a table prefix",
      '    "hooks",',
      "  ],",
      "  # nor is this independently nested array",
      "  [",
      '    "unrelated",',
      "  ],",
      "  [",
      '    [["hooks"]]',
      "  ],",
      "  [",
      '    [ [ "hooks" ] ]',
      "  ],",
      "]",
      "outer.values = [",
      '  [["hooks"]]',
      "]",
      '"" = [',
      '  [ [ "hooks" ] ]',
      "]",
      "# End oh-my-codex",
      "",
      "[user.after]",
      'value = "preserved"',
      "",
    ].join("\n");
    const expected = ["[user.after]", 'value = "preserved"', ""].join("\n");

    assert.doesNotThrow(() => TOML.parse(fixture));
    assert.deepEqual(stripExistingOmxBlocks(fixture), { cleaned: expected, removed: 1 });

    const merged = buildMergedConfig(fixture, "/tmp/omx");
    assert.doesNotMatch(merged, /^values = \[/m);
    assert.match(merged, /^\[user\.after\]$/m);
    assert.doesNotThrow(() => TOML.parse(merged));
  });

  it("ignores inert hooks.state text inside exact managed marker ranges", () => {
    const fixture = [
      "# oh-my-codex (OMX) Configuration",
      '# hooks."state" =',
      'basic = "hooks.\'state\' ="',
      "literal = 'hooks = { state = {'",
      'multiline = """',
      '[[ "hooks" . "state" ]',
      'hooks = { "state" = {',
      '"""',
      "# End oh-my-codex",
      "",
      "[user.after]",
      'value = "preserved"',
      "",
    ].join("\n");
    const expected = ["[user.after]", 'value = "preserved"', ""].join("\n");

    assert.deepEqual(stripExistingOmxBlocks(fixture), { cleaned: expected, removed: 1 });
    assert.doesNotThrow(() => buildMergedConfig(fixture, "/tmp/omx"));
  });

  it("removes an exact inline state entry within a hooks.state table", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const inline = [
      "[hooks.state]",
      `"${key}" = { trusted_hash = "${hash}" }`,
      "",
      "[desktop]",
      "git-create-pull-request-as-draft = true",
      "",
    ].join("\n");

    const stripped = stripManagedCodexHookTrustState(inline, { managedTrustState });
    assert.doesNotMatch(stripped, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(stripped, /^\[hooks\.state\]$/m);
    assert.match(stripped, /^\[desktop\]$/m);
    assert.doesNotThrow(() => TOML.parse(stripped));
  });

  it("fails closed on multi-field, array-like, and mixed managed trust representations", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const key = `${hooksPath}:post_compact:0:0`;
    const hash = managedTrustState[key]?.trusted_hash;
    assert.ok(hash);
    const fixtures = [
      [
        `hooks.state."${key}" = { trusted_hash = "${hash}", enabled = false }`,
        "",
      ].join("\n"),
      [
        `hooks.state."${key}" = [{ trusted_hash = "${hash}" }]`,
        "",
      ].join("\n"),
      [
        `hooks.state."${key}" = { trusted_hash = "${hash}" }`,
        `[hooks.state."${key}"]`,
        `trusted_hash = "${hash}"`,
        "",
      ].join("\n"),
    ];

    for (const fixture of fixtures) {
      assert.throws(
        () => stripManagedCodexHookTrustState(fixture, { managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
      );
      assert.throws(
        () => buildMergedConfig(fixture, "/tmp/omx", { managedHookTrustState: managedTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
      );
    }
  });

  it("does not remove unfenced hook trust-state tables without a proof map", () => {
    const config = [
      '[hooks.state."/tmp/codex/hooks.json:post_compact:0:0"]',
      'trusted_hash = "sha256:managed-looking"',
      "",
    ].join("\n");

    const stripped = stripManagedCodexHookTrustState(config);

    assert.match(stripped, /managed-looking/);
  });

  it("dedupes prior fenced managed hook trust-state blocks before writing a replacement", () => {
    const first = upsertManagedCodexHookTrustState(
      [
        'model = "gpt-5.6-sol"',
        "",
        '[hooks.state."custom:/hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:user"',
        "enabled = false",
        "",
      ].join("\n"),
      "/tmp/omx",
      "/tmp/codex/hooks.json",
    );
    const brokenWithDuplicatePriorBlock = `${first}\n${first.slice(
      first.indexOf("# OMX-owned Codex hook trust state"),
    )}`;
    assert.equal(
      count(
        brokenWithDuplicatePriorBlock,
        /^\[hooks\.state\."\/tmp\/codex\/hooks\.json:stop:0:0"\]$/gm,
      ),
      2,
      "regression fixture should contain duplicate managed trust tables",
    );

    const repaired = upsertManagedCodexHookTrustState(
      brokenWithDuplicatePriorBlock,
      "/tmp/omx",
      "/tmp/codex/hooks.json",
    );
    const repeated = upsertManagedCodexHookTrustState(
      repaired,
      "/tmp/omx",
      "/tmp/codex/hooks.json",
    );

    assert.equal(repeated, repaired);
    assert.match(
      repaired,
      /^\[hooks\.state\."custom:\/hooks\.json:stop:0:0"\]$/m,
      "unrelated user hook state should be preserved",
    );
    assert.match(repaired, /^enabled = false$/m);
    assertSingleManagedHookTrustState(repaired);
  });

  it("preserves managed-looking trust blocks inside multiline TOML values", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const managedTrustState = buildManagedCodexHookTrustState(hooksPath, "/tmp/omx");
    const embeddedTrustBlock = [
      "# OMX-owned Codex hook trust state",
      "# Trusts only setup-managed native hook wrappers.",
      ...Object.entries(managedTrustState)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, state]) => [
          `[hooks.state."${key}"]`,
          `trusted_hash = "${state.trusted_hash}"`,
          "",
        ]),
      "# End OMX-owned Codex hook trust state",
    ].join("\n");
    const multilineBasicValue = `basic = """\n${embeddedTrustBlock}\n"""`;
    const multilineLiteralValue = `literal = '''\n${embeddedTrustBlock}\n'''`;
    const config = [multilineBasicValue, "", multilineLiteralValue, ""].join("\n");

    const first = upsertManagedCodexHookTrustState(config, "/tmp/omx", hooksPath, {
      managedTrustState,
    });
    const refreshed = upsertManagedCodexHookTrustState(first, "/tmp/omx", hooksPath, {
      managedTrustState,
    });
    const stripped = stripManagedCodexHookTrustState(refreshed, { managedTrustState });

    assert.equal(refreshed, first, "the real managed block should still be replaced idempotently");
    for (const preserved of [first, stripped]) {
      assert.ok(preserved.includes(multilineBasicValue));
      assert.ok(preserved.includes(multilineLiteralValue));
    }
    const parsed = TOML.parse(stripped) as {
      basic?: unknown;
      literal?: unknown;
      hooks?: unknown;
    };
    assert.equal(parsed.basic, `${embeddedTrustBlock}\n`);
    assert.equal(parsed.literal, `${embeddedTrustBlock}\n`);
    assert.equal(parsed.hooks, undefined, "only the real managed trust tables should be stripped");

    const unterminatedMultilineValue = multilineBasicValue.slice(0, -3);
    assert.equal(
      stripManagedCodexHookTrustState(unterminatedMultilineValue, { managedTrustState }),
      unterminatedMultilineValue,
      "an ambiguous unterminated multiline value must not lose managed-looking content",
    );
  });

  it("uses strict final hook coordinates for precomputed managed trust", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const foreignGroup = {
      hooks: [
        {
          type: "command",
          command: "/usr/bin/python3 /tmp/user-hook.py",
          timeout: 5,
        },
      ],
    };
    const existingHooks = JSON.stringify({
      hooks: Object.fromEntries(
        MANAGED_HOOK_EVENTS.map((eventName) => [eventName, [foreignGroup]]),
      ),
    });
    const plan = planManagedCodexHooksMerge(
      existingHooks,
      "/tmp/omx",
      hooksPath,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    const refreshed = buildMergedConfig("", "/tmp/omx", {
      codexHooksFile: hooksPath,
      managedHookTrustState: plan.finalTrustState,
      priorManagedHookTrustState: plan.priorTrustState,
      legacyHookTrustState: plan.legacyTrustState,
    });
    const parsed = TOML.parse(refreshed) as {
      hooks?: { state?: Record<string, { trusted_hash?: unknown }> };
    };
    const trustKeys = Object.keys(parsed.hooks?.state ?? {}).sort();

    assert.deepEqual(trustKeys, Object.keys(plan.finalTrustState).sort());
    for (const eventName of MANAGED_HOOK_EVENTS) {
      const eventLabel = eventName
        .replace(/([A-Z])/g, "_$1")
        .toLowerCase()
        .replace(/^_/, "");
      assert.ok(
        trustKeys.some((key) => key.includes(`:${eventLabel}:1:0`)),
        `${eventName} should retain the actual final group index after foreign hooks`,
      );
    }
  });

  it("migrates exact legacy hooks.json state in the same precomputed config plan", () => {
    const hooksPath = "/tmp/codex/hooks.json";
    const plan = planManagedCodexHooksMerge(
      JSON.stringify({
        state: {
          "legacy:/hooks.json:stop:0:0": {
            trusted_hash: "sha256:legacy",
            enabled: false,
          },
        },
        hooks: {},
      }),
      "/tmp/omx",
      hooksPath,
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;

    const refreshed = buildMergedConfig("", "/tmp/omx", {
      codexHooksFile: hooksPath,
      managedHookTrustState: plan.finalTrustState,
      priorManagedHookTrustState: plan.priorTrustState,
      legacyHookTrustState: plan.legacyTrustState,
    });

    assert.doesNotMatch(plan.finalContent ?? "", /"state"/);
    assert.match(
      refreshed,
      /^\[hooks\.state\."legacy:\/hooks\.json:stop:0:0"\]$/m,
    );
    assert.match(refreshed, /^trusted_hash = "sha256:legacy"$/m);
    assert.match(refreshed, /^enabled = false$/m);
  });

  it("migrates a legacy __proto__ trust key into config.toml", () => {
    const plan = planManagedCodexHooksMerge(
      '{"state":{"__proto__":{"trusted_hash":"sha256:legacy","enabled":true}}}',
      "/tmp/omx",
      "/tmp/codex/hooks.json",
    );
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    const config = buildMergedConfig("", "/tmp/omx", {
      legacyHookTrustState: plan.legacyTrustState,
    });
    assert.match(config, /^\[hooks\.state\."__proto__"\]$/m);
    assert.match(config, /^trusted_hash = "sha256:legacy"$/m);
    assert.match(config, /^enabled = true$/m);
  });

  it("coalesces matching legacy hook trust config tables and rejects hash or enabled collisions", () => {
    const key = "legacy:/hooks.json:stop:0:0";
    const legacyHookTrustState = {
      [key]: { trusted_hash: "sha256:legacy", enabled: false },
    };
    const matchingConfig = [
      `[hooks.state."${key}"]`,
      'trusted_hash = "sha256:legacy"',
      "enabled = false",
      "",
    ].join("\n");
    const matching = buildMergedConfig(matchingConfig, "/tmp/omx", {
      legacyHookTrustState,
    });
    assert.equal(
      count(matching, /^\[hooks\.state\."legacy:\/hooks\.json:stop:0:0"\]$/gm),
      1,
    );

    for (const conflictingConfig of [
      matchingConfig.replace("sha256:legacy", "sha256:other"),
      matchingConfig.replace("enabled = false", "enabled = true"),
      matchingConfig.replace("\nenabled = false", ""),
    ]) {
      assert.throws(
        () => buildMergedConfig(conflictingConfig, "/tmp/omx", { legacyHookTrustState }),
        (error: unknown) =>
          error instanceof ManagedCodexHooksPlanError &&
          error.code === "managed_trust_key_conflict",
      );
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
      'model = "gpt-5.6-sol"',
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
