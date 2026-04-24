import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "../setup.js";

const packageRoot = process.cwd();

async function withTempCwd(
  wd: string,
  fn: () => Promise<void>,
): Promise<void> {
  const previousCwd = process.cwd();
  process.chdir(wd);
  try {
    await fn();
  } finally {
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

async function seedPluginCacheFromCanonicalSkills(
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
  await mkdir(artifactPath, { recursive: true });
  await cp(join(packageRoot, "plugins", "oh-my-codex", "skills"), join(artifactPath, "skills"), {
    recursive: true,
  });
}

describe("omx setup install mode behavior", () => {
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
      assert.equal(
        existsSync(join(wd, "home", ".codex", "skills", "help", "SKILL.md")),
        true,
      );
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

  it("keeps legacy user skills when plugin mode is selected before plugin readiness exists", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });

          const helpSkillPath = join(codexHomeDir, "skills", "help", "SKILL.md");
          assert.equal(existsSync(helpSkillPath), true);

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(existsSync(helpSkillPath), true);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("removes matching legacy user skills once plugin readiness is proven", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromCanonicalSkills(codexHomeDir);

          const helpSkillDir = join(codexHomeDir, "skills", "help");
          const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
          assert.equal(existsSync(helpSkillDir), true);
          assert.equal(existsSync(wikiSkillDir), true);

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(existsSync(helpSkillDir), false);
          assert.equal(existsSync(wikiSkillDir), false);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps legacy user skills when plugin cache has stale skill contents", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromCanonicalSkills(codexHomeDir);

          const cachedHelpPath = join(
            codexHomeDir,
            "plugins",
            "cache",
            "local-marketplace",
            "oh-my-codex",
            "local",
            "skills",
            "help",
            "SKILL.md",
          );
          await writeFile(cachedHelpPath, "# stale plugin help\n");

          const helpSkillDir = join(codexHomeDir, "skills", "help");
          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(existsSync(helpSkillDir), true);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps legacy user skills when plugin cache has extra stale skill directories", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromCanonicalSkills(codexHomeDir);

          await mkdir(
            join(
              codexHomeDir,
              "plugins",
              "cache",
              "local-marketplace",
              "oh-my-codex",
              "local",
              "skills",
              "stale-extra-skill",
            ),
            { recursive: true },
          );

          const helpSkillDir = join(codexHomeDir, "skills", "help");
          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(existsSync(helpSkillDir), true);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves legacy user skills with local non-SKILL files during plugin cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-setup-install-mode-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          await setup({ scope: "user", installMode: "legacy" });
          await seedPluginCacheFromCanonicalSkills(codexHomeDir);

          const helpSkillDir = join(codexHomeDir, "skills", "help");
          const localNotesPath = join(helpSkillDir, "LOCAL_NOTES.md");
          const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
          await writeFile(localNotesPath, "local customization\n");

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(await readFile(localNotesPath, "utf-8"), "local customization\n");
          assert.equal(existsSync(wikiSkillDir), false);
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
          await seedPluginCacheFromCanonicalSkills(codexHomeDir);

          const helpSkillPath = join(codexHomeDir, "skills", "help", "SKILL.md");
          const wikiSkillDir = join(codexHomeDir, "skills", "wiki");
          await writeFile(helpSkillPath, "# customized help\n");

          await setup({ scope: "user", installMode: "plugin" });

          assert.equal(await readFile(helpSkillPath, "utf-8"), "# customized help\n");
          assert.equal(existsSync(wikiSkillDir), false);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
