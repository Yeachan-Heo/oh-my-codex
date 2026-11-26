import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializePackagedOmxPluginCache,
  resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

describe("plugin hook launcher node path", () => {
  it("pins the stable Homebrew node symlink instead of the versioned Cellar path", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launcher-stable-node-"));
    const previousExecPath = process.execPath;
    const previousHome = process.env.HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      const brewPrefix = join(wd, "homebrew");
      const cellarNode = join(brewPrefix, "Cellar", "node", "26.0.0", "bin", "node");
      const stableNode = join(brewPrefix, "bin", "node");
      await mkdir(join(cellarNode, ".."), { recursive: true });
      await writeFile(cellarNode, "", { mode: 0o755 });
      await mkdir(join(stableNode, ".."), { recursive: true });
      await symlink(join("..", "Cellar", "node", "26.0.0", "bin", "node"), stableNode);

      const codexHomeDir = join(wd, "home", ".codex");
      await mkdir(codexHomeDir, { recursive: true });
      process.env.HOME = join(wd, "home");
      process.env.CODEX_HOME = codexHomeDir;

      const packaged = await resolvePackagedOmxMarketplace(packageRoot);
      assert.ok(packaged);
      process.execPath = cellarNode;
      const materialized = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
      process.execPath = previousExecPath;
      assert.equal(materialized.status, "materialized");

      const launcher = JSON.parse(
        await readFile(join(materialized.cacheDir!, "hooks", "omx-command.json"), "utf-8"),
      ) as { command: string };
      assert.equal(launcher.command, stableNode);
    } finally {
      process.execPath = previousExecPath;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
