import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  materializePackagedOmxPluginCache,
  omxPluginCacheBase,
  resolvePackagedOmxMarketplace,
} from "../plugin-marketplace.js";

const packageRoot = process.cwd();

async function withIsolatedCodexHome<T>(fn: (codexHomeDir: string) => Promise<T>): Promise<T> {
  const wd = await mkdtemp(join(tmpdir(), "omx-plugin-team-transition-3699-"));
  const codexHomeDir = join(wd, "home");
  await mkdir(codexHomeDir, { recursive: true });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHomeDir;
  try {
    return await fn(codexHomeDir);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(wd, { recursive: true, force: true });
  }
}

describe("#3699 Team-mode transition on an existing same-version plugin cache", () => {
  it("reports the immutability limitation instead of claiming the disabled skill set is current", async () => {
    await withIsolatedCodexHome(async (codexHomeDir) => {
      const packaged = await resolvePackagedOmxMarketplace(packageRoot);
      assert.ok(packaged);

      const enabled = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
        teamMode: "enabled",
      });
      assert.equal(enabled.status, "materialized");
      assert.ok(enabled.cacheDir);
      const installedSkills = await readdir(join(enabled.cacheDir, "skills"));
      assert.ok(installedSkills.includes("team"));
      assert.ok(installedSkills.includes("worker"));

      const disabled = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
        teamMode: "disabled",
      });
      assert.equal(
        disabled.status,
        "stale-launcher",
        "an existing same-version snapshot cannot publish the disabled skill set in place",
      );
      if (disabled.status === "stale-launcher") {
        const reason = disabled.reason ?? "";
        assert.match(reason, /still exposes team, worker/);
        assert.match(reason, /immutable/);
        assert.match(reason, /codex plugin remove/);
      }

      // The immutable snapshot itself stays intact; nothing is silently rewritten.
      const afterSkills = await readdir(join(enabled.cacheDir, "skills"));
      assert.deepEqual(afterSkills.sort(), installedSkills.sort());
      assert.equal(omxPluginCacheBase(codexHomeDir).length > 0, true);
    });
  });

  it("stays unchanged when the installed skill set already matches the requested mode", async () => {
    await withIsolatedCodexHome(async (codexHomeDir) => {
      const packaged = await resolvePackagedOmxMarketplace(packageRoot);
      assert.ok(packaged);

      const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
        teamMode: "enabled",
      });
      assert.equal(first.status, "materialized");
      const second = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
        teamMode: "enabled",
      });
      assert.equal(second.status, "unchanged");
    });
  });
});
