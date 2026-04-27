import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setup } from "../setup.js";

const packageRoot = process.cwd();

async function withTempCwd(wd: string, fn: () => Promise<void>): Promise<void> {
  const previousCwd = process.cwd();
  process.chdir(wd);
  try {
    await fn();
  } finally {
    process.chdir(previousCwd);
  }
}

async function runSetupWithCapturedLogs(
  wd: string,
  options: Parameters<typeof setup>[0],
): Promise<string> {
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const logs: string[] = [];
  process.chdir(wd);
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

async function withIsolatedUserHome<T>(
  wd: string,
  fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const homeDir = join(wd, "home");
  const codexHomeDir = join(homeDir, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codexHomeDir;
  try {
    return await fn(codexHomeDir);
  } finally {
    if (typeof previousHome === "string") process.env.HOME = previousHome;
    else delete process.env.HOME;
    if (typeof previousCodexHome === "string") {
      process.env.CODEX_HOME = previousCodexHome;
    } else {
      delete process.env.CODEX_HOME;
    }
  }
}


async function assertProjectPluginModeArtifacts(wd: string): Promise<void> {
  const hooks = await readFile(join(wd, ".codex", "hooks.json"), "utf-8");
  assert.match(hooks, /codex-native-hook\.js/);
  const config = await readFile(join(wd, ".codex", "config.toml"), "utf-8");
  assert.match(config, /^codex_hooks = true$/m);
  assert.doesNotMatch(
    config,
    /developer_instructions|notify-hook|mcp_servers/,
  );
  assert.equal(
    existsSync(join(wd, ".codex", "skills", "help", "SKILL.md")),
    false,
  );
  assert.equal(
    existsSync(join(wd, ".codex", "agents", "planner.toml")),
    false,
  );
  assert.equal(
    existsSync(join(wd, ".codex", "prompts", "executor.md")),
    false,
  );
  assert.equal(existsSync(join(wd, "AGENTS.md")), false);

  const persisted = JSON.parse(
    await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
  ) as { scope: string; installMode?: string };
  assert.deepEqual(persisted, {
    scope: "project",
    installMode: "plugin",
  });
}

async function captureConsoleOutput(fn: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return lines.join("\n");
}

async function seedPluginCacheFromInstalledSkills(
  codexHomeDir: string,
): Promise<void> {
  const artifactPath = join(
    codexHomeDir,
    "plugins",
    "cache",
    "local-marketplace",
    "oh-my-codex",
    "local",
  );
  await mkdir(join(artifactPath, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(artifactPath, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "oh-my-codex", version: "local" }),
  );
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "src", "catalog", "manifest.json"), "utf-8"),
  ) as { skills: Array<{ name: string; status?: string }> };
  const installableSkillNames = new Set([
    ...manifest.skills
      .filter((skill) => skill.status === "active" || skill.status === "internal")
      .map((skill) => skill.name),
    "wiki",
  ]);
  await mkdir(join(artifactPath, "skills"), { recursive: true });
  await Promise.all(
    [...installableSkillNames].map((skillName) =>
      cp(join(codexHomeDir, "skills", skillName), join(artifactPath, "skills", skillName), {
        recursive: true,
      }),
    ),
  );
}

describe("omx setup install mode behavior", () => {
  it("summarizes and keeps persisted setup preferences when review chooses keep", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "user", installMode: "legacy" }),
          );

          const output = await captureConsoleOutput(async () => {
            await setup({
              persistedSetupReviewPrompt: async (preferences) => {
                assert.deepEqual(preferences, {
                  scope: "user",
                  installMode: "legacy",
                });
                return "keep";
              },
            });
          });

          assert.match(
            output,
            /Setup preference review: keep \(scope=user, installMode=legacy\)/,
          );
          assert.match(
            output,
            /Using setup scope: user \(from \.omx\/setup-scope\.json\)/,
          );
          assert.match(
            output,
            /Using setup install mode: legacy \(from \.omx\/setup-scope\.json\)/,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses persisted choices as defaults when review changes setup preferences", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "user", installMode: "legacy" }),
          );

          await setup({
            persistedSetupReviewPrompt: async () => "review",
            setupScopePrompt: async (defaultScope) => {
              assert.equal(defaultScope, "user");
              return "user";
            },
            installModePrompt: async (defaultMode) => {
              assert.equal(defaultMode, "legacy");
              return "plugin";
            },
          });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "plugin" });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("clears user-scope install mode when review switches setup to project scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "user", installMode: "plugin" }),
          );

          await setup({
            persistedSetupReviewPrompt: async () => "review",
            setupScopePrompt: async (defaultScope) => {
              assert.equal(defaultScope, "user");
              return "project";
            },
          });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "project" });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reviews persisted scope when only install mode is provided", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "project" }),
          );

          let reviewed = false;
          await setup({
            installMode: "plugin",
            persistedSetupReviewPrompt: async () => {
              reviewed = true;
              return "reset";
            },
            setupScopePrompt: async (defaultScope) => {
              assert.equal(defaultScope, "user");
              return "user";
            },
          });

          assert.equal(reviewed, true);
          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "plugin" });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reviews persisted install mode when only user scope is provided", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "user", installMode: "legacy" }),
          );

          let reviewed = false;
          await setup({
            scope: "user",
            persistedSetupReviewPrompt: async () => {
              reviewed = true;
              return "review";
            },
            installModePrompt: async (defaultMode) => {
              assert.equal(defaultMode, "legacy");
              return "plugin";
            },
          });

          assert.equal(reviewed, true);
          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "plugin" });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores persisted setup preferences when review chooses reset", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(
            join(wd, ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "project", installMode: "plugin" }),
          );

          await setup({
            persistedSetupReviewPrompt: async () => "reset",
            setupScopePrompt: async (defaultScope) => {
              assert.equal(defaultScope, "user");
              return "user";
            },
            installModePrompt: async (defaultMode) => {
              assert.equal(defaultMode, "legacy");
              return "legacy";
            },
          });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "legacy" });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("prints plugin-mode next steps without claiming native agent TOML files were written", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        const output = await runSetupWithCapturedLogs(wd, {
          scope: "user",
          installMode: "plugin",
        });

        assert.match(output, /Next steps:/);
        assert.match(
          output,
          /Codex plugin discovery supplies OMX skills and workflow surfaces/,
        );
        assert.doesNotMatch(output, /TOML files written to \.codex\/agents\//);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps legacy-mode next steps describing native agent TOML output", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        const output = await runSetupWithCapturedLogs(wd, {
          scope: "user",
          installMode: "legacy",
        });

        assert.match(output, /Next steps:/);
        assert.match(
          output,
          /Native agent defaults configured in config\.toml \[agents\] and TOML files written to \.codex\/agents\//,
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("persists user install mode choices alongside setup scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "plugin" });
        });
      });

      const persisted = JSON.parse(
        await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
      ) as { scope: string; installMode?: string };
      assert.deepEqual(persisted, { scope: "user", installMode: "plugin" });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("defaults to plugin mode when an installed oh-my-codex plugin cache is discovered", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const pluginDir = join(
            codexHomeDir,
            "plugins",
            "cache",
            "oh-my-codex-local",
            "oh-my-codex",
          );
          await mkdir(join(pluginDir, ".codex-plugin"), { recursive: true });
          await writeFile(
            join(pluginDir, ".codex-plugin", "plugin.json"),
            JSON.stringify({ name: "oh-my-codex", version: "local" }),
          );

          await setup({ scope: "user" });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "plugin" });
          assert.equal(
            existsSync(join(codexHomeDir, "skills", "help", "SKILL.md")),
            false,
          );
          const hooks = await readFile(
            join(codexHomeDir, "hooks.json"),
            "utf-8",
          );
          assert.match(hooks, /codex-native-hook\.js/);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not prompt for install mode during project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    let promptCalls = 0;
    try {
      await withTempCwd(wd, async () => {
        await setup({
          scope: "project",
          installModePrompt: async () => {
            promptCalls += 1;
            return "plugin";
          },
        });
      });

      assert.equal(promptCalls, 0);
      const persisted = JSON.parse(
        await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
      ) as { scope: string; installMode?: string };
      assert.deepEqual(persisted, { scope: "project" });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not reuse stale user install mode for project-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "plugin" });

          await setup({ scope: "project" });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "project" });
          assert.equal(
            existsSync(join(wd, ".codex", "skills", "help", "SKILL.md")),
            true,
          );

          await setup({ scope: "project" });

          const repeatedPersisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(repeatedPersisted, { scope: "project" });
          assert.equal(
            existsSync(join(wd, ".codex", "agents", "planner.toml")),
            true,
          );
          assert.equal(
            existsSync(join(wd, ".codex", "prompts", "executor.md")),
            true,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not reuse stale project install mode for user-scoped setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "project", installMode: "plugin" });

          await setup({ scope: "user" });

          const persisted = JSON.parse(
            await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
          ) as { scope: string; installMode?: string };
          assert.deepEqual(persisted, { scope: "user", installMode: "legacy" });
          assert.equal(
            existsSync(join(codexHomeDir, "skills", "help", "SKILL.md")),
            true,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "agents", "planner.toml")),
            true,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "prompts", "executor.md")),
            true,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("installs user-scoped native hooks when plugin mode is selected", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "plugin" });

          const hooks = await readFile(
            join(codexHomeDir, "hooks.json"),
            "utf-8",
          );
          assert.match(hooks, /codex-native-hook\.js/);
          const config = await readFile(
            join(codexHomeDir, "config.toml"),
            "utf-8",
          );
          assert.match(config, /^codex_hooks = true$/m);
          assert.doesNotMatch(
            config,
            /developer_instructions|notify-hook|mcp_servers/,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "skills", "help", "SKILL.md")),
            false,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "agents", "planner.toml")),
            false,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "prompts", "executor.md")),
            false,
          );
          assert.equal(existsSync(join(codexHomeDir, "AGENTS.md")), false);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("can opt into plugin AGENTS.md and developer_instructions defaults", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({
            scope: "user",
            installMode: "plugin",
            pluginAgentsMdPrompt: async () => true,
            pluginDeveloperInstructionsPrompt: async () => true,
          });

          const hooks = await readFile(
            join(codexHomeDir, "hooks.json"),
            "utf-8",
          );
          assert.match(hooks, /codex-native-hook\.js/);
          assert.equal(
            existsSync(join(codexHomeDir, "skills", "help", "SKILL.md")),
            false,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "agents", "planner.toml")),
            false,
          );
          assert.equal(
            existsSync(join(codexHomeDir, "prompts", "executor.md")),
            false,
          );

          const config = await readFile(
            join(codexHomeDir, "config.toml"),
            "utf-8",
          );
          assert.match(config, /developer_instructions\s*=/);
          assert.match(config, /^codex_hooks = true$/m);
          assert.doesNotMatch(config, /notify-hook|mcp_servers/);

          const agentsMd = await readFile(
            join(codexHomeDir, "AGENTS.md"),
            "utf-8",
          );
          assert.match(
            agentsMd,
            /oh-my-codex - Intelligent Multi-Agent Orchestration/,
          );
          assert.match(agentsMd, /<!-- omx:generated:agents-md -->/);
          assert.match(agentsMd, /<!-- OMX:MODELS:START -->/);
          assert.match(agentsMd, /<!-- OMX:MODELS:END -->/);
          assert.match(agentsMd, /<guidance_schema_contract>/);
          assert.match(agentsMd, /<execution_protocols>/);
          assert.match(agentsMd, /AGENTS\.md is the top-level operating contract/);
          assert.match(agentsMd, /Treat installed prompts as narrower execution surfaces under AGENTS\.md authority|Role prompts under `prompts\/\*\.md` are narrower execution surfaces/);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves existing developer_instructions when plugin defaults are requested", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const configPath = join(codexHomeDir, "config.toml");
          const existingConfig = 'developer_instructions = "custom"\n';
          await writeFile(configPath, existingConfig);

          await setup({
            scope: "user",
            installMode: "plugin",
            pluginDeveloperInstructionsPrompt: async () => true,
          });

          const config = await readFile(configPath, "utf-8");
          assert.match(config, /^developer_instructions = "custom"$/m);
          assert.match(config, /^codex_hooks = true$/m);
          assert.equal(
            (config.match(/^developer_instructions\s*=/gm) ?? []).length,
            1,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("can overwrite existing developer_instructions after explicit plugin prompt approval", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const configPath = join(codexHomeDir, "config.toml");
          await writeFile(configPath, 'developer_instructions = "custom"\n');

          await setup({
            scope: "user",
            installMode: "plugin",
            pluginDeveloperInstructionsPrompt: async () => true,
            pluginDeveloperInstructionsOverwritePrompt: async () => true,
          });

          const config = await readFile(configPath, "utf-8");
          assert.match(config, /You have oh-my-codex installed/);
          assert.doesNotMatch(config, /^developer_instructions = "custom"$/m);
          assert.equal(
            (config.match(/^developer_instructions\s*=/gm) ?? []).length,
            1,
          );
          assert.match(config, /^codex_hooks = true$/m);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves existing user hooks while installing plugin-mode native hooks", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const hooksPath = join(codexHomeDir, "hooks.json");
          const existingHooks =
            JSON.stringify({ hooks: { UserPromptSubmit: [] } }, null, 2) + "\n";
          await writeFile(hooksPath, existingHooks);

          await setup({ scope: "user", installMode: "plugin" });

          const hooks = await readFile(hooksPath, "utf-8");
          assert.match(hooks, /"UserPromptSubmit"/);
          assert.match(hooks, /codex-native-hook\.js/);
          const config = await readFile(
            join(codexHomeDir, "config.toml"),
            "utf-8",
          );
          assert.match(config, /^codex_hooks = true$/m);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("honors persisted project-scoped plugin mode on repeat setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withTempCwd(wd, async () => {
        await setup({ scope: "project", installMode: "plugin" });

        const persisted = JSON.parse(
          await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
        ) as { scope: string; installMode?: string };
        assert.deepEqual(persisted, {
          scope: "project",
          installMode: "plugin",
        });

        await setup({ scope: "project" });

        assert.equal(
          existsSync(join(wd, ".codex", "skills", "help", "SKILL.md")),
          false,
        );
        assert.equal(
          existsSync(join(wd, ".codex", "agents", "planner.toml")),
          false,
        );
        assert.equal(
          existsSync(join(wd, ".codex", "prompts", "executor.md")),
          false,
        );
        const hooks = await readFile(join(wd, ".codex", "hooks.json"), "utf-8");
        assert.match(hooks, /codex-native-hook\.js/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("installs project-scoped native hooks when plugin mode is explicitly requested", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withTempCwd(wd, async () => {
        await setup({ scope: "project", installMode: "plugin" });

        await assertProjectPluginModeArtifacts(wd);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("honors persisted project plugin mode on repeat setup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withTempCwd(wd, async () => {
        await setup({ scope: "project", installMode: "plugin" });
        await setup();

        await assertProjectPluginModeArtifacts(wd);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("prints plugin-mode next steps without legacy-only claims", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async () => {
        await withTempCwd(wd, async () => {
          const pluginOutput = await captureConsoleOutput(async () => {
            await setup({ scope: "project", installMode: "plugin" });
          });
          assert.match(pluginOutput, /Using setup install mode: plugin/);
          assert.doesNotMatch(pluginOutput, /user-scope skill delivery mode/);
          assert.doesNotMatch(
            pluginOutput,
            /Native agent defaults configured.*TOML files written to \.codex\/agents\//,
          );
          assert.doesNotMatch(
            pluginOutput,
            /Use role\/workflow keywords like \$architect, \$executor, and \$plan/,
          );
          assert.doesNotMatch(
            pluginOutput,
            /AGENTS keyword routing can also activate them implicitly/,
          );
          assert.doesNotMatch(
            pluginOutput,
            /The AGENTS\.md orchestration brain is loaded automatically/,
          );
          assert.match(
            pluginOutput,
            /Codex plugin discovery supplies OMX skills and workflow surfaces/,
          );
          assert.match(pluginOutput, /Browse plugin-provided skills with \/skills/);
          assert.match(
            pluginOutput,
            /Optional AGENTS\.md and developer_instructions defaults are only installed when selected/,
          );

          const legacyWd = join(wd, "legacy");
          await mkdir(legacyWd, { recursive: true });
          await withTempCwd(legacyWd, async () => {
            const legacyOutput = await captureConsoleOutput(async () => {
              await setup({ scope: "user", installMode: "legacy" });
            });
            assert.match(
              legacyOutput,
              /Native agent defaults configured.*TOML files written to \.codex\/agents\//,
            );
            assert.match(
              legacyOutput,
              /Use role\/workflow keywords like \$architect, \$executor, and \$plan/,
            );
            assert.match(
              legacyOutput,
              /AGENTS keyword routing can also activate them implicitly/,
            );
            assert.match(
              legacyOutput,
              /The AGENTS\.md orchestration brain is loaded automatically/,
            );
          });
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("removes legacy user components when plugin mode is selected", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });

          const helpSkillPath = join(
            codexHomeDir,
            "skills",
            "help",
            "SKILL.md",
          );
          const promptPath = join(codexHomeDir, "prompts", "executor.md");
          const agentPath = join(codexHomeDir, "agents", "planner.toml");
          const hooksPath = join(codexHomeDir, "hooks.json");
          const configPath = join(codexHomeDir, "config.toml");
          const agentsMdPath = join(codexHomeDir, "AGENTS.md");
          assert.equal(existsSync(helpSkillPath), true);
          assert.equal(existsSync(promptPath), true);
          assert.equal(existsSync(agentPath), true);
          assert.equal(existsSync(hooksPath), true);
          assert.equal(existsSync(configPath), true);
          assert.equal(existsSync(agentsMdPath), true);

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(existsSync(helpSkillPath), false);
          assert.equal(existsSync(promptPath), false);
          assert.equal(existsSync(agentPath), false);
          assert.equal(existsSync(hooksPath), true);
          assert.equal(existsSync(agentsMdPath), false);
          const hooks = await readFile(hooksPath, "utf-8");
          assert.match(hooks, /codex-native-hook\.js/);
          const config = await readFile(configPath, "utf-8");
          assert.match(config, /^codex_hooks = true$/m);
          assert.doesNotMatch(
            config,
            /oh-my-codex|mcp_servers|notify|developer_instructions/,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("archives stale legacy prompts and generated native agents when plugin mode refreshes", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });

          const promptPath = join(codexHomeDir, "prompts", "executor.md");
          const agentPath = join(codexHomeDir, "agents", "planner.toml");
          await writeFile(
            promptPath,
            "---\ndescription: stale legacy executor prompt\n---\n\nold executor body\n",
          );
          await writeFile(
            agentPath,
            [
              "# oh-my-codex agent: planner",
              'name = "planner"',
              'description = "stale legacy generated planner"',
              'developer_instructions = """old planner body"""',
              "",
            ].join("\n"),
          );

          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });

          assert.equal(existsSync(promptPath), false);
          assert.equal(existsSync(agentPath), false);
          assert.match(output, /Archived and removed .* legacy OMX-managed prompt file/);
          assert.match(output, /Archived and removed .* legacy OMX-managed native agent config/);

          const backupRoot = join(wd, "home", ".omx", "backups", "setup");
          const backupRuns = await readdir(backupRoot);
          assert.ok(backupRuns.length > 0);
          assert.equal(
            backupRuns.some((entry) =>
              existsSync(join(backupRoot, entry, ".codex", "prompts", "executor.md")),
            ),
            true,
          );
          assert.equal(
            backupRuns.some((entry) =>
              existsSync(join(backupRoot, entry, ".codex", "agents", "planner.toml")),
            ),
            true,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("counts plugin cleanup skill directory backups in the setup summary", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromInstalledSkills(codexHomeDir);

          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });

          const skillsSummary = output.match(
            /skills: updated=0, unchanged=0, backed_up=(\d+), skipped=0, removed=(\d+)/,
          );
          assert.notEqual(skillsSummary, null);
          const backedUp = Number(skillsSummary?.[1]);
          const removed = Number(skillsSummary?.[2]);
          assert.ok(backedUp > 0);
          assert.equal(backedUp, removed);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("removes matching legacy user skills even when plugin readiness is proven", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromInstalledSkills(codexHomeDir);

          const helpSkillDir = join(codexHomeDir, "skills", "help");
          const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
          assert.equal(existsSync(helpSkillDir), true);
          assert.equal(existsSync(wikiSkillDir), true);

          const outputLines: string[] = [];
          const previousLog = console.log;
          console.log = (...args: unknown[]) => {
            outputLines.push(args.join(" "));
          };
          try {
            await setup({ scope: "user", installMode: "plugin" });
          } finally {
            console.log = previousLog;
          }

          const setupOutput = outputLines.join("\n");
          assert.equal(existsSync(helpSkillDir), false);
          assert.equal(existsSync(wikiSkillDir), false);
          assert.match(
            setupOutput,
            /skills: updated=0, unchanged=0, backed_up=\d+, skipped=0, removed=\d+/,
          );

          const backupSetupRoot = join(wd, "home", ".omx", "backups", "setup");
          const backupTimestamps = await readdir(backupSetupRoot);
          assert.equal(backupTimestamps.length, 1);
          const backupSkillsDir = join(
            backupSetupRoot,
            backupTimestamps[0],
            ".codex",
            "skills",
          );
          const backedUpSkillNames = await readdir(backupSkillsDir);
          assert.ok(backedUpSkillNames.includes("help"));
          assert.ok(backedUpSkillNames.includes("wiki"));
          assert.match(
            setupOutput,
            new RegExp(
              `skills: updated=0, unchanged=0, backed_up=${backedUpSkillNames.length}, skipped=0, removed=${backedUpSkillNames.length}`,
            ),
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves customized legacy user skills during plugin cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromInstalledSkills(codexHomeDir);

          const helpSkillPath = join(
            codexHomeDir,
            "skills",
            "help",
            "SKILL.md",
          );
          const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
          await writeFile(helpSkillPath, "# customized help\n");

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(
            await readFile(helpSkillPath, "utf-8"),
            "# customized help\n",
          );
          assert.equal(existsSync(wikiSkillDir), false);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
