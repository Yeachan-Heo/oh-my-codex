import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, "..", "..", "..");
  const omxBin = join(repoRoot, "dist", "cli", "omx.js");
  const resolvedHome = envOverrides.HOME ?? process.env.HOME;
  const result = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      ...(resolvedHome && !envOverrides.CODEX_HOME
        ? { CODEX_HOME: join(resolvedHome, ".codex") }
        : {}),
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error?.message || "",
  };
}

function shouldSkipForSpawnPermissions(err: string): boolean {
  return typeof err === "string" && /(EPERM|EACCES)/i.test(err);
}

describe("omx setup scope behavior", () => {
  it("accepts --scope project form", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const bySeparateArg = runOmx(
        wd,
        ["setup", "--dry-run", "--scope", "project"],
        { HOME: home },
      );
      if (shouldSkipForSpawnPermissions(bySeparateArg.error)) return;
      assert.equal(
        bySeparateArg.status,
        0,
        bySeparateArg.stderr || bySeparateArg.stdout,
      );
      assert.match(bySeparateArg.stdout, /Using setup scope: project/);

      const byEqualsArg = runOmx(wd, ["setup", "--dry-run", "--scope=user"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(byEqualsArg.error)) return;
      assert.equal(
        byEqualsArg.status,
        0,
        byEqualsArg.stderr || byEqualsArg.stdout,
      );
      assert.match(byEqualsArg.stdout, /Using setup scope: user/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses persisted setup scope when --scope is omitted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const omxDir = join(wd, ".omx");
      const home = join(wd, "home");
      await mkdir(omxDir, { recursive: true });
      await mkdir(home, { recursive: true });
      await writeFile(
        join(omxDir, "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );

      const res = runOmx(wd, ["setup", "--dry-run"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Using setup scope: project \(from \.omx\/setup-scope\.json\)/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor respects persisted project setup scope paths", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-doctor-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );

      await mkdir(join(wd, ".codex", "prompts"), { recursive: true });
      await mkdir(join(wd, ".codex", "skills", "sample-skill"), {
        recursive: true,
      });
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await writeFile(
        join(wd, ".codex", "prompts", "executor.md"),
        "# executor\n",
      );
      await writeFile(
        join(wd, ".codex", "skills", "sample-skill", "SKILL.md"),
        "# skill\n",
      );
      await writeFile(
        join(wd, ".codex", "config.toml"),
        'omx_enabled = true\n[mcp_servers.omx_state]\ncommand = "node"\n',
      );

      const res = runOmx(wd, ["doctor"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Resolved setup scope: project \(from \.omx\/setup-scope\.json\)/,
      );
      assert.match(
        res.stdout,
        new RegExp(
          `Codex home: (?:/private)?${wd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex`,
        ),
      );
      assert.doesNotMatch(res.stdout, /Codex home: .*\/home\/\.codex/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not persist setup scope on --dry-run", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmx(wd, ["setup", "--scope", "project", "--dry-run"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("project scope writes prompts/skills/config/native-agents under cwd", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      const res = runOmx(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const localPrompts = join(wd, ".codex", "prompts");
      const localSkills = join(wd, ".codex", "skills");
      const localConfig = join(wd, ".codex", "config.toml");
      const localHooks = join(wd, ".codex", "hooks.json");
      const localAgents = join(wd, ".codex", "agents");
      const scopeFile = join(wd, ".omx", "setup-scope.json");
      const agentsMdPath = join(wd, "AGENTS.md");

      assert.equal(existsSync(localPrompts), true);
      assert.equal(existsSync(localSkills), true);
      assert.equal(existsSync(localConfig), true);
      assert.equal(existsSync(localHooks), true);
      assert.equal(existsSync(localAgents), true);
      assert.equal(existsSync(join(localAgents, "executor.toml")), true);
      assert.equal(
        existsSync(join(localSkills, "omx-setup", "SKILL.md")),
        true,
      );
      assert.equal(
        existsSync(join(localSkills, "ask-claude", "SKILL.md")),
        true,
      );
      assert.equal(
        existsSync(join(localSkills, "ask-gemini", "SKILL.md")),
        true,
      );
      assert.ok(
        (await readdir(localPrompts)).length > 0,
        "local prompts should be installed",
      );
      assert.equal(existsSync(agentsMdPath), true);

      const configToml = await readFile(localConfig, "utf-8");
      assert.match(configToml, /^\[agents\]$/m);
      assert.match(configToml, /^max_threads = 6$/m);
      assert.match(configToml, /^max_depth = 2$/m);
      assert.doesNotMatch(configToml, /^\[env\]$/m);
      assert.match(configToml, /^\[shell_environment_policy\.set\]$/m);
      assert.match(configToml, /^USE_OMX_EXPLORE_CMD = "1"$/m);
      assert.match(configToml, /^codex_hooks = true$/m);
      assert.match(configToml, /^goals = true$/m);
      const hooksJson = JSON.parse(await readFile(localHooks, "utf-8")) as {
        hooks?: Record<string, unknown>;
      };
      assert.ok(hooksJson.hooks, "hooks.json should include a hooks object");
      assert.ok(hooksJson.hooks?.SessionStart, "hooks.json should register SessionStart");
      assert.ok(hooksJson.hooks?.UserPromptSubmit, "hooks.json should register UserPromptSubmit");
      assert.ok(hooksJson.hooks?.Stop, "hooks.json should register Stop");
      const agentsMd = await readFile(agentsMdPath, "utf-8");
      assert.match(agentsMd, /prompts\/\*\.md/);
      assert.match(agentsMd, /\.\/\.codex\/skills/);
      const persistedScope = JSON.parse(await readFile(scopeFile, "utf-8")) as {
        scope: string;
      };
      assert.equal(persistedScope.scope, "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("setup preserves user hooks while replacing stale OMX wrappers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      const codexDir = join(wd, ".codex");
      await mkdir(home, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      await writeFile(
        join(codexDir, "hooks.json"),
        JSON.stringify(
          {
            hooks: {
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: 'node "/old/dist/scripts/codex-native-hook.js"',
                    },
                    { type: "command", command: "echo keep-me" },
                  ],
                },
              ],
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: 'node "/old/dist/scripts/codex-native-hook.js"',
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );

      const res = runOmx(wd, ["setup", "--scope", "project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const hooksJson = JSON.parse(
        await readFile(join(codexDir, "hooks.json"), "utf-8"),
      ) as {
        hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const sessionStartHooks = hooksJson.hooks.SessionStart.flatMap((entry) =>
        entry.hooks ?? []
      );
      const stopHooks = hooksJson.hooks.Stop.flatMap((entry) => entry.hooks ?? []);

      assert.equal(
        sessionStartHooks.filter((hook) =>
          String(hook.command ?? "").includes("codex-native-hook.js")
        ).length,
        1,
      );
      assert.equal(
        stopHooks.filter((hook) =>
          String(hook.command ?? "").includes("codex-native-hook.js")
        ).length,
        1,
      );
      assert.match(JSON.stringify(sessionStartHooks), /echo keep-me/);
      assert.doesNotMatch(
        JSON.stringify(hooksJson),
        /\/old\/dist\/scripts\/codex-native-hook\.js/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("defaults to user scope in non-interactive runs when no scope is persisted", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      const existingAgents = "# keep my project agents instructions\n";
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), existingAgents);
      const res = runOmx(wd, ["setup"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /Using setup scope: user/);
      assert.match(
        res.stdout,
        /User scope leaves project AGENTS\.md unchanged\./,
      );

      assert.equal(existsSync(join(home, ".codex", "prompts")), true);
      assert.equal(existsSync(join(home, ".codex", "skills")), true);
      assert.equal(existsSync(join(home, ".codex", "agents")), true);
      assert.equal(existsSync(join(home, ".codex", "hooks.json")), true);
      assert.equal(existsSync(join(home, ".codex", "AGENTS.md")), true);
      assert.equal(existsSync(join(wd, ".omx", "setup-scope.json")), true);
      const persistedScope = JSON.parse(
        await readFile(join(wd, ".omx", "setup-scope.json"), "utf-8"),
      ) as { scope: string };
      assert.equal(persistedScope.scope, "user");
      const agentsMd = await readFile(
        join(home, ".codex", "AGENTS.md"),
        "utf-8",
      );
      assert.match(agentsMd, /~\/\.codex\/skills/);
      assert.equal(
        await readFile(join(wd, "AGENTS.md"), "utf-8"),
        existingAgents,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor does not warn about missing project AGENTS.md for user scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-doctor-user-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(join(home, ".codex", "prompts"), { recursive: true });
      await mkdir(join(home, ".codex", "skills", "sample-skill"), {
        recursive: true,
      });
      await mkdir(join(home, ".codex", "agents"), { recursive: true });
      await mkdir(join(wd, ".omx", "state"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "user" }),
      );
      await writeFile(join(home, ".codex", "AGENTS.md"), "# user agents\n");
      await writeFile(
        join(home, ".codex", "prompts", "executor.md"),
        "# executor\n",
      );
      await writeFile(
        join(home, ".codex", "skills", "sample-skill", "SKILL.md"),
        "# skill\n",
      );
      await writeFile(
        join(home, ".codex", "config.toml"),
        'omx_enabled = true\n[mcp_servers.omx_state]\ncommand = "node"\n',
      );

      const res = runOmx(wd, ["doctor"], {
        HOME: home,
        CODEX_HOME: join(home, ".codex"),
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(
        res.stdout,
        /Resolved setup scope: user \(from \.omx\/setup-scope\.json\)/,
      );
      assert.match(
        res.stdout,
        /\[OK\] AGENTS\.md: found in .*home\/\.codex\/AGENTS\.md/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy "project-local" persisted scope to "project"', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const omxDir = join(wd, ".omx");
      const home = join(wd, "home");
      await mkdir(omxDir, { recursive: true });
      await mkdir(home, { recursive: true });
      // Write the legacy scope value
      await writeFile(
        join(omxDir, "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );

      const res = runOmx(wd, ["setup", "--dry-run"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      // Should migrate and use "project"
      assert.match(res.stdout, /Using setup scope: project/);
      // Should log migration warning to stderr
      assert.match(
        res.stderr,
        /Migrating persisted setup scope "project-local"/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skips overwriting existing AGENTS.md in non-interactive runs without --force", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      const existingAgents = "# custom agents instructions\n\nkeep this file\n";
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), existingAgents);

      const res = runOmx(wd, ["setup", "--scope=project"], { HOME: home });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      const refreshed = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(res.stdout, /Skipped AGENTS\.md overwrite/);
      assert.equal(refreshed, existingAgents);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("still refreshes existing AGENTS.md with --force", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-scope-"));
    try {
      const home = join(wd, "home");
      await mkdir(home, { recursive: true });
      await writeFile(join(wd, "AGENTS.md"), "# old custom file\n");

      const res = runOmx(wd, ["setup", "--scope=project", "--force"], {
        HOME: home,
      });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);

      const overwritten = await readFile(join(wd, "AGENTS.md"), "utf-8");
      assert.match(overwritten, /^<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->/);
      assert.match(
        overwritten,
        /# oh-my-codex - Intelligent Multi-Agent Orchestration/,
      );
      assert.doesNotMatch(overwritten, /# old custom file/);
      assert.match(
        res.stdout,
        /Force mode: enabled additional destructive maintenance/,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
