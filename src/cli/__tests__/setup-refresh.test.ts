import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../setup.js";

const EXPECTED_PROJECT_GITIGNORE = [
  ".omx/",
  ".codex/*",
  "!.codex/agents/",
  "!.codex/agents/**",
  "!.codex/skills/",
  "!.codex/skills/**",
  ".codex/skills/.system/**",
  "!.codex/prompts/",
  "!.codex/prompts/**",
].join("\n") + "\n";

const EXPECTED_PROJECT_GITIGNORE_WITHOUT_OMX = [
  ".codex/*",
  "!.codex/agents/",
  "!.codex/agents/**",
  "!.codex/skills/",
  "!.codex/skills/**",
  ".codex/skills/.system/**",
  "!.codex/prompts/",
  "!.codex/prompts/**",
].join("\n") + "\n";

async function runSetupWithCapturedLogs(
  cwd: string,
  options: Parameters<typeof setup>[0],
): Promise<string> {
  const previousCwd = process.cwd();
  const logs: string[] = [];
  const originalLog = console.log;
  process.chdir(cwd);
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await setup(options);
    return logs.join("\n");
  } finally {
    console.log = originalLog;
    process.chdir(previousCwd);
  }
}

describe("omx setup refresh summary and dry-run behavior", () => {
  async function runSetupInTempDir(
    wd: string,
    options: Parameters<typeof setup>[0],
  ): Promise<void> {
    const previousCwd = process.cwd();
    process.chdir(wd);
    try {
      await setup(options);
    } finally {
      process.chdir(previousCwd);
    }
  }

  it("prints per-category summary and verbose changed-file detail", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const skillPath = join(wd, ".codex", "skills", "help", "SKILL.md");
      await writeFile(skillPath, "# locally modified help\n");

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        verbose: true,
      });
      assert.match(output, /Setup refresh summary:/);
      assert.match(output, /prompts: updated=/);
      assert.match(output, /skills: updated=/);
      assert.match(output, /native_agents: updated=/);
      assert.match(output, /agents_md: updated=/);
      assert.match(output, /config: updated=/);
      assert.match(output, /updated skill help\/SKILL\.md/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not overwrite or create backups during dry-run", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const skillPath = join(wd, ".codex", "skills", "help", "SKILL.md");
      const customized = "# locally modified help\n";
      await writeFile(skillPath, customized);

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        dryRun: true,
      });
      assert.equal(await readFile(skillPath, "utf-8"), customized);
      assert.equal(existsSync(join(wd, ".omx", "backups", "setup")), false);
      assert.match(output, /skills: updated=/);
      assert.match(output, /skills: .*backed_up=1/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("creates .gitignore with OMX project ignore rules during project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await runSetupInTempDir(wd, { scope: "project" });

      assert.equal(existsSync(join(wd, ".omx", "state")), true);
      assert.equal(
        await readFile(join(wd, ".gitignore"), "utf-8"),
        EXPECTED_PROJECT_GITIGNORE,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("appends missing OMX project ignore rules to an existing project .gitignore without duplicating them", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await writeFile(join(wd, ".gitignore"), "node_modules/\n");

      await runSetupInTempDir(wd, { scope: "project" });
      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, `node_modules/\n${EXPECTED_PROJECT_GITIGNORE}`);
      assert.equal(gitignore.match(/^\.omx\/$/gm)?.length ?? 0, 1);
      assert.equal(gitignore.match(/^\.codex\/\*$/gm)?.length ?? 0, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not add .omx/ to project .gitignore when Git already ignores it locally", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-local-ignore-"));
    try {
      const initResult = spawnSync("git", ["init", "-q"], { cwd: wd });
      assert.equal(initResult.status, 0);
      await writeFile(join(wd, ".gitignore"), "node_modules/\n");
      await writeFile(join(wd, ".git", "info", "exclude"), ".omx/\n");

      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, `node_modules/\n${EXPECTED_PROJECT_GITIGNORE_WITHOUT_OMX}`);
      assert.equal(gitignore.match(/^\.omx\/$/gm)?.length ?? 0, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("creates .gitignore without .omx/ when only local Git excludes already ignore it", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-local-ignore-"));
    try {
      const initResult = spawnSync("git", ["init", "-q"], { cwd: wd });
      assert.equal(initResult.status, 0);
      await writeFile(join(wd, ".git", "info", "exclude"), ".omx/\n");

      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, EXPECTED_PROJECT_GITIGNORE_WITHOUT_OMX);
      assert.equal(gitignore.match(/^\.omx\/$/gm)?.length ?? 0, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores project-local config while keeping .codex agents, skills, and prompts trackable", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      const initResult = spawnSync("git", ["init", "-q"], { cwd: wd });
      assert.equal(initResult.status, 0);

      await runSetupInTempDir(wd, { scope: "project" });
      await mkdir(join(wd, ".codex", "skills", ".system"), { recursive: true });
      await writeFile(join(wd, ".codex", "agents", "local.toml"), "# local\n");
      await writeFile(join(wd, ".codex", "prompts", "local.md"), "# local\n");
      await writeFile(
        join(wd, ".codex", "skills", ".system", "cache.json"),
        "{}\n",
      );

      const status = spawnSync(
        "git",
        [
          "status",
          "--short",
          "--ignored",
          ".codex/config.toml",
          ".codex/agents/local.toml",
          ".codex/prompts/local.md",
          ".codex/skills/help/SKILL.md",
          ".codex/skills/.system/cache.json",
        ],
        { cwd: wd, encoding: "utf-8" },
      );
      assert.equal(status.status, 0);
      assert.match(status.stdout, /^!! \.codex\/config\.toml$/m);
      assert.match(status.stdout, /^\?\? \.codex\/agents\/local\.toml$/m);
      assert.match(status.stdout, /^\?\? \.codex\/prompts\/local\.md$/m);
      assert.match(status.stdout, /^\?\? \.codex\/skills\/help\/SKILL\.md$/m);
      assert.match(status.stdout, /^!! \.codex\/skills\/\.system\/cache\.json$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("replaces legacy .codex/ ignores so the project allowlist can take effect", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await writeFile(join(wd, ".gitignore"), ".omx/\n.codex/\n");

      await runSetupInTempDir(wd, { scope: "project" });

      const gitignore = await readFile(join(wd, ".gitignore"), "utf-8");
      assert.equal(gitignore, EXPECTED_PROJECT_GITIGNORE);
      assert.equal(gitignore.match(/^\.codex\/$/gm)?.length ?? 0, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("creates backup files under the scope-specific setup backup root when refreshing modified managed files", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await runSetupInTempDir(wd, { scope: "project" });

      const promptPath = join(wd, ".codex", "prompts", "executor.md");
      const oldPrompt = "# local prompt\n";
      await writeFile(promptPath, oldPrompt);

      await runSetupInTempDir(wd, { scope: "project" });

      const backupsRoot = join(wd, ".omx", "backups", "setup");
      assert.equal(existsSync(backupsRoot), true);
      const timestamps = await readdir(backupsRoot);
      assert.ok(timestamps.length >= 1);
      const latestBackup = join(
        backupsRoot,
        timestamps.sort().at(-1)!,
        ".codex",
        "prompts",
        "executor.md",
      );
      assert.equal(existsSync(latestBackup), true);
      assert.equal(await readFile(latestBackup, "utf-8"), oldPrompt);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("offers an upgrade from gpt-5.3-codex to gpt-5.5 when accepted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      let promptCalls = 0;
      await runSetupInTempDir(wd, {
        scope: "project",
        modelUpgradePrompt: async (currentModel, targetModel) => {
          promptCalls += 1;
          assert.equal(currentModel, "gpt-5.3-codex");
          assert.equal(targetModel, "gpt-5.5");
          return true;
        },
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.equal(promptCalls, 1);
      assert.match(config, /^model = "gpt-5\.5"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.3-codex"$/m);
      assert.match(
        config,
        /^# oh-my-codex seeded behavioral defaults \(uninstall removes unchanged defaults\)$/m,
      );
      assert.match(config, /^model_context_window = 250000$/m);
      assert.match(config, /^model_auto_compact_token_limit = 200000$/m);
      assert.match(config, /^# End oh-my-codex seeded behavioral defaults$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves gpt-5.3-codex when the upgrade prompt is declined", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        modelUpgradePrompt: async () => false,
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(config, /^model = "gpt-5\.3-codex"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.5"$/m);
      assert.doesNotMatch(config, /^model_context_window = 250000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 200000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves gpt-5.3-codex in non-interactive runs without prompting", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        'model = \"gpt-5.3-codex\"\n',
      );

      await runSetupInTempDir(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(config, /^model = "gpt-5\.3-codex"$/m);
      assert.doesNotMatch(config, /^model = "gpt-5\.5"$/m);
      assert.doesNotMatch(config, /^model_context_window = 250000$/m);
      assert.doesNotMatch(config, /^model_auto_compact_token_limit = 200000$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("seeds [tui].status_line for Codex CLI >= 0.107.0 while preserving an existing customization", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        ['model = "gpt-5.5"', "", "[tui]", 'theme = "night"', 'status_line = ["git-branch"]', ""].join("\n"),
      );

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        codexVersionProbe: () => "codex-cli 0.107.0",
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.equal(config.match(/^\[tui\]$/gm)?.length ?? 0, 1);
      assert.match(config, /^theme = "night"$/m);
      assert.match(config, /^status_line = \["git-branch"\]$/m);
      assert.match(
        output,
        /StatusLine configured in config\.toml via \[tui\] section\./,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("seeds default [tui].status_line on fresh setup for Codex CLI >= 0.107.0", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });

      await runSetupInTempDir(wd, {
        scope: "project",
        codexVersionProbe: () => "codex-cli 0.107.0",
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.equal(config.match(/^\[tui\]$/gm)?.length ?? 0, 1);
      assert.match(
        config,
        /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps forced HUD config overwrite and generated status_line preset in sync", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "hud-config.json"),
        JSON.stringify({
          preset: "focused",
          statusLine: { preset: "minimal" },
        }),
      );
      await writeFile(
        join(wd, ".codex", "config.toml"),
        [
          "[tui]",
          "# omx:managed-status-line",
          'status_line = ["model-with-reasoning", "git-branch"]',
          "",
        ].join("\n"),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        force: true,
      });

      const hudConfig = JSON.parse(
        await readFile(join(wd, ".omx", "hud-config.json"), "utf-8"),
      ) as { preset?: unknown };
      assert.equal(hudConfig.preset, "focused");

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(
        config,
        /^status_line = \["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"\]$/m,
      );
      assert.doesNotMatch(
        config,
        /^status_line = \["model-with-reasoning", "git-branch"\]$/m,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves user-owned status_line during forced setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "hud-config.json"),
        JSON.stringify({
          preset: "focused",
          statusLine: { preset: "minimal" },
        }),
      );
      await writeFile(
        join(wd, ".codex", "config.toml"),
        [
          'model = "gpt-5.5"',
          "",
          "[tui]",
          'theme = "night"',
          'status_line = ["git-branch"]',
          "",
        ].join("\n"),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        force: true,
        codexVersionProbe: () => "codex-cli 0.107.0",
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.equal(config.match(/^\[tui\]$/gm)?.length ?? 0, 1);
      assert.match(config, /^theme = "night"$/m);
      assert.match(config, /^status_line = \["git-branch"\]$/m);
      assert.doesNotMatch(
        config,
        /^status_line = \["model-with-reasoning", "git-branch", "context-remaining"/m,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps OMX-managed [tui] writes for older Codex CLI versions", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });

      const output = await runSetupWithCapturedLogs(wd, {
        scope: "project",
        codexVersionProbe: () => "codex-cli 0.106.0",
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(config, /^\[tui\]$/m);
      assert.match(output, /StatusLine configured in config\.toml via \[tui\] section\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP registry entries into config.toml during setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          eslint: { command: "npx", args: ["@eslint/mcp@latest"], timeout: 9 },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        mcpRegistryCandidates: [registryPath],
      });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(config, /oh-my-codex \(OMX\) Shared MCP Registry Sync/);
      assert.match(config, /^\[mcp_servers\.eslint\]$/m);
      assert.match(config, /^command = "npx"$/m);
      assert.match(config, /^startup_timeout_sec = 9$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("backfills launcher-backed MCP startup timeouts during setup refresh", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        [
          '[mcp_servers.filesystem]',
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
          "",
        ].join("\n"),
      );

      await runSetupInTempDir(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(config, /^\[mcp_servers\.filesystem\]$/m);
      assert.match(config, /^startup_timeout_sec = 15$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("repairs retired omx_team_run config during setup refresh", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    try {
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".codex"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "config.toml"),
        [
          '[mcp_servers.omx_team_run]',
          'command = "node"',
          'args = ["./dist/cli/team-mcp.js"]',
          "",
        ].join("\n"),
      );

      const output = await runSetupWithCapturedLogs(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.match(
        output,
        /Removed retired \[mcp_servers\.omx_team_run\] config during refresh\./,
      );
      assert.doesNotMatch(config, /^\[mcp_servers\.omx_team_run\]$/m);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP registry entries into ~/.claude/settings.json for user scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEX_HOME;

      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".claude"), { recursive: true });
      await writeFile(
        join(wd, ".claude", "settings.json"),
        JSON.stringify(
          {
            uiTheme: "dark",
            mcpServers: {
              existing_server: {
                command: "custom-existing-server",
                args: ["serve"],
                enabled: true,
              },
            },
          },
          null,
          2,
        ),
      );
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          existing_server: { command: "existing-server", args: ["mcp"] },
          eslint: {
            command: "npx",
            args: ["@eslint/mcp@latest"],
            enabled: false,
            approval_mode: "never",
          },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "user",
        mcpRegistryCandidates: [registryPath],
      });
      await runSetupInTempDir(wd, {
        scope: "user",
        mcpRegistryCandidates: [registryPath],
      });

      const settings = JSON.parse(
        await readFile(join(wd, ".claude", "settings.json"), "utf-8"),
      ) as {
        uiTheme?: string;
        mcpServers?: Record<
          string,
          {
            command: string;
            args: string[];
            enabled: boolean;
            approval_mode?: string;
          }
        >;
      };
      assert.equal(settings.uiTheme, "dark");
      assert.deepEqual(settings.mcpServers?.existing_server, {
        command: "custom-existing-server",
        args: ["serve"],
        enabled: true,
      });
      assert.deepEqual(settings.mcpServers?.eslint, {
        command: "npx",
        args: ["@eslint/mcp@latest"],
        enabled: false,
        approval_mode: "never",
      });
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not write ~/.claude/settings.json during project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEX_HOME;

      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      const registryPath = join(wd, "mcp-registry.json");
      await writeFile(
        registryPath,
        JSON.stringify({
          eslint: { command: "npx", args: ["@eslint/mcp@latest"] },
        }),
      );

      await runSetupInTempDir(wd, {
        scope: "project",
        mcpRegistryCandidates: [registryPath],
      });

      assert.equal(existsSync(join(wd, ".claude", "settings.json")), false);
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores legacy ~/.omc/mcp-registry.json during setup unless candidates are passed explicitly", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-refresh-"));
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      process.env.HOME = wd;
      delete process.env.CODEX_HOME;

      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await mkdir(join(wd, ".omc"), { recursive: true });
      await writeFile(
        join(wd, ".omc", "mcp-registry.json"),
        JSON.stringify({
          legacy_helper: { command: "legacy-helper", args: ["mcp"] },
        }),
      );

      await runSetupInTempDir(wd, { scope: "project" });

      const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
      assert.doesNotMatch(config, /^\[mcp_servers\.legacy_helper\]$/m);
      assert.doesNotMatch(config, /Shared MCP Server: legacy_helper/);

      const output = await runSetupWithCapturedLogs(wd, { scope: "project" });
      assert.match(output, /legacy shared MCP registry detected at .*\.omc\/mcp-registry\.json but ignored by default/i);
      assert.match(output, /move it to .*\.omx\/mcp-registry\.json/i);
    } finally {
      if (typeof previousHome === "string") process.env.HOME = previousHome;
      else delete process.env.HOME;
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
