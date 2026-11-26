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

async function launcherCommandFor(
  wd: string,
  execPath: string,
): Promise<string> {
  const previousExecPath = process.execPath;
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const codexHomeDir = join(wd, "home", ".codex");
    await mkdir(codexHomeDir, { recursive: true });
    process.env.HOME = join(wd, "home");
    process.env.CODEX_HOME = codexHomeDir;

    const packaged = await resolvePackagedOmxMarketplace(packageRoot);
    assert.ok(packaged);
    process.execPath = execPath;
    const materialized = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
    process.execPath = previousExecPath;
    assert.equal(materialized.status, "materialized");

    const launcher = JSON.parse(
      await readFile(join(materialized.cacheDir!, "hooks", "omx-command.json"), "utf-8"),
    ) as { command: string };
    return launcher.command;
  } finally {
    process.execPath = previousExecPath;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

async function createCellarNode(brewPrefix: string): Promise<string> {
  const cellarNode = join(brewPrefix, "Cellar", "node", "26.0.0", "bin", "node");
  await mkdir(join(cellarNode, ".."), { recursive: true });
  await writeFile(cellarNode, "", { mode: 0o755 });
  return cellarNode;
}

describe("plugin hook launcher node path", () => {
  it("pins the stable Homebrew node symlink instead of the versioned Cellar path", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launcher-stable-node-"));
    try {
      const brewPrefix = join(wd, "homebrew");
      const cellarNode = await createCellarNode(brewPrefix);
      const stableNode = join(brewPrefix, "bin", "node");
      await mkdir(join(stableNode, ".."), { recursive: true });
      await symlink(join("..", "Cellar", "node", "26.0.0", "bin", "node"), stableNode);

      assert.equal(await launcherCommandFor(wd, cellarNode), stableNode);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps the Cellar path when the stable Homebrew symlink is missing", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launcher-stable-node-"));
    try {
      const cellarNode = await createCellarNode(join(wd, "homebrew"));

      assert.equal(await launcherCommandFor(wd, cellarNode), cellarNode);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
