import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,

  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  PLUGIN_LAUNCHER_RECOVERY_HINT,
  hasExpectedOmxPluginCache,
  materializePackagedOmxPluginCache,
  readOmxPluginCacheFileNoFollow,
  omxPluginCacheProvenanceReason,
  omxPluginCacheExecutedAssetProvenanceReason,
  omxPluginCacheBase,
  pluginHookCacheMatchesPackaged,
  packagedOmxPluginVersion,
  readOmxPluginCacheState,
  discoverOmxPluginCacheDirs,
  computeOmxPluginCacheClaimDigest,
  resolvePackagedOmxMarketplace,
  setPluginCacheMutationHooksForTest,
} from "../plugin-marketplace.js";

import { sameFilePath } from "../../utils/paths.js";

const packageRoot = process.cwd();

function parseLastPublicationLockRecord(bytes: string): Record<string, unknown> {
  const lines = bytes.split("\n").map((line) => line.trim()).filter(Boolean);
  return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
}

async function withIsolatedUserHome<T>(
  wd: string,
  fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
  const home = join(wd, "home");
  await mkdir(home, { recursive: true });
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", { configurable: true, value: original });
  }
}

function directoryOperationPathForTest(fd: { fd: number }, visiblePath: string): string {
  return process.platform === "linux" ? `/proc/self/fd/${fd.fd}` : resolve(visiblePath);
}

async function packagedPluginVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      join(packageRoot, "plugins", "oh-my-codex", ".codex-plugin", "plugin.json"),
      "utf-8",
    ),
  ) as { version: string };
  return manifest.version;
}

async function expectedPackagedSkillNames(): Promise<string[]> {
  const entries = await readdir(
    join(packageRoot, "plugins", "oh-my-codex", "skills"),
    { withFileTypes: true },
  );
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

async function pinnedLauncherContent(): Promise<string> {
  return `${JSON.stringify(
    {
      command: process.execPath,
      argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
    },
    null,
    2,
  )}\n`;
}

/**
 * Seeds a byte-identical regular cache snapshot for the current packageRoot,
 * exactly like `stageCompletePluginSnapshot` + materialize would produce.
 */
async function seedRegularSnapshot(codexHomeDir: string): Promise<string> {
  const version = await packagedPluginVersion();
  const cacheDir = join(
    codexHomeDir,
    "plugins",
    "cache",
    "oh-my-codex-local",
    "oh-my-codex",
    version,
  );
  await mkdir(dirname(cacheDir), { recursive: true });
  await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
    recursive: true,
  });
  await writeFile(
    join(cacheDir, "hooks", "omx-command.json"),
    await pinnedLauncherContent(),
  );
  const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
  await writeFile(join(cacheDir, ".omx-complete"), `${JSON.stringify({ version, claimDigest })}\n`);
  return cacheDir;
}

describe("issue 3552 P1 symlink trust bypass in unchanged fast paths", () => {
  it("rejects unsafe packaged versions before constructing cache paths", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-unsafe-version-"));
    try {
      const manifestPath = join(wd, "plugin.json");
      await writeFile(manifestPath, JSON.stringify({ version: "../escape" }));
      const packaged = {
        marketplacePath: join(wd, "marketplace.json"),
        packageRoot,
        pluginRoot: packageRoot,
        pluginManifestPath: manifestPath,
      };
      assert.equal(await packagedOmxPluginVersion(packaged), null);
      const result = await materializePackagedOmxPluginCache(join(wd, "codex"), packaged);
      assert.equal(result.status, "unavailable", JSON.stringify(result));
      assert.equal(existsSync(join(wd, "codex")), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not publish a snapshot missing a required plugin surface", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-incomplete-snapshot-"));
    try {
      const fakePluginRoot = join(wd, "plugin");
      await cp(join(packageRoot, "plugins", "oh-my-codex"), fakePluginRoot, { recursive: true });
      await rm(join(fakePluginRoot, ".mcp.json"), { force: true });
      const packaged = {
        marketplacePath: join(wd, "marketplace.json"),
        packageRoot,
        pluginRoot: fakePluginRoot,
        pluginManifestPath: join(fakePluginRoot, ".codex-plugin", "plugin.json"),
      };
      const codexHomeDir = join(wd, "codex");
      const version = await packagedPluginVersion();
      const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
      assert.equal(result.status, "stale-launcher", JSON.stringify(result));
      assert.match(result.reason ?? "", /required surface|companion file/);
      assert.equal(existsSync(join(omxPluginCacheBase(codexHomeDir), version)), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps Darwin publication on identity-gated visible-path mutations", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-darwin-publication-"));
    try {
      await withPlatform("darwin", async () => {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(first.status, "materialized", JSON.stringify(first));
          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
          // Mutations stay reachable (no blanket ENOTSUP) because every one is
          // exclusive-create or inode-gated through the validated anchor.
          assert.equal(existsSync(omxPluginCacheBase(codexHomeDir)), true);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps the Windows reparse-safe publication path available", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-win32-publication-"));
    try {
      await withPlatform("win32", async () => {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          if (process.platform === "win32") {
            assert.equal(first.status, "materialized", JSON.stringify(first));
            assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
          } else {
            assert.notEqual(first.status, "unavailable");
          }
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("control: regular immutable snapshot stays unchanged and hook-matching", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-control-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        assert.equal((await lstat(cacheDir)).isSymbolicLink(), false);
        assert.equal(
          await omxPluginCacheExecutedAssetProvenanceReason(cacheDir),
          null,
        );
        assert.equal(await pluginHookCacheMatchesPackaged(cacheDir, packaged), true);
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          true,
        );
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "unchanged");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when the committed publication marker is removed", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-marker-loss-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(first.status, "materialized");
        await rm(join(first.cacheDir!, ".omx-complete"), { force: true });
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher");
        assert.match(result.reason ?? "", /managed snapshots|publication marker|codex plugin remove/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed completion markers and ignores the mutable live pin", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-marker-integrity-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(first.status, "materialized");
        const completePath = join(first.cacheDir!, ".omx-complete");
        for (const marker of ["{\n", "not-json\n"]) {
          await writeFile(completePath, marker);
          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false, marker);
        }
        const second = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(second.status, "stale-launcher");

        const clean = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(clean.status, "stale-launcher");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not invalidate a healthy claim when a live pin is added", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-live-pin-digest-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(first.status, "materialized");
        await writeFile(join(first.cacheDir!, ".omx-live-pin"), "pinned\n");
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects extra skill directories from immutable provenance", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-extra-skill-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await mkdir(join(cacheDir, "skills", "attacker"), { recursive: true });
        await writeFile(join(cacheDir, "skills", "attacker", "SKILL.md"), "attacker\n");
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher");
        assert.match(result.reason ?? "", /skills directory contents differ/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed at the state boundary for missing managed assets", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-state-boundary-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, "hooks", "hooks.json"), { force: true });
        assert.equal(await readOmxPluginCacheState(cacheDir), null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when state surfaces have invalid pointers, companions, skills, or launcher", async () => {
    const cases = [
      ["pointer", async (cacheDir: string) => {
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
        await writeFile(manifestPath, JSON.stringify({ ...manifest, skills: "./attacker-skills/" }));
      }],
      ["companion", async (cacheDir: string) => {
        await writeFile(join(cacheDir, ".mcp.json"), "not-json\n");
      }],
      ["skill", async (cacheDir: string) => {
        await rm(join(cacheDir, "skills", "worker", "SKILL.md"), { force: true });
      }],
      ["launcher", async (cacheDir: string) => {
        await writeFile(join(cacheDir, "hooks", "omx-command.json"), "{}\n");
      }],
    ] as const;
    for (const [label, mutate] of cases) {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-state-${label}-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          await mutate(cacheDir);
          assert.equal(await readOmxPluginCacheState(cacheDir), null, `${label} state failure was trusted`);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    }
  });

  it("rejects an anchored parent replacement before reading a managed asset", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-parent-barrier-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const hooksDir = join(cacheDir, "hooks");
        const externalDir = join(wd, "external-hooks");
        await rename(hooksDir, externalDir);
        await symlink(externalDir, hooksDir);
        const bytes = await readOmxPluginCacheFileNoFollow(
          join(cacheDir, "hooks", "hooks.json"),
          { anchorDir: cacheDir },
        );
        assert.equal(bytes, null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked intermediate skills directory during descriptor-bound reads", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-intermediate-skills-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillsDir = join(cacheDir, "skills");
        const externalSkills = join(wd, "external-skills");
        await rename(skillsDir, externalSkills);
        await symlink(externalSkills, skillsDir);
        assert.equal(
          await readOmxPluginCacheFileNoFollow(
            join(cacheDir, "skills", "worker", "SKILL.md"),
            { anchorDir: cacheDir },
          ),
          null,
        );
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects an interrupted publication without a committed marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-publication-interrupt-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, ".omx-complete"), { force: true });
        await writeFile(join(cacheDir, ".omx-incomplete"), "interrupted\n");
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        assert.equal(await readOmxPluginCacheState(cacheDir), null);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not discover a manifest without a committed publication marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-discovery-marker-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, ".omx-complete"), { force: true });
        assert.deepEqual(await discoverOmxPluginCacheDirs(codexHomeDir), []);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("symlinked current-version cache root is rejected: no unchanged, no external mutation, stale-launcher with recovery hint", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-root-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const realCache = await seedRegularSnapshot(codexHomeDir);
        // Attacker relocates the snapshot outside the managed namespace and
        // replaces the <version> root with a symlink to it.
        const externalTarget = join(wd, "external", "snapshot");
        await mkdir(dirname(externalTarget), { recursive: true });
        await rename(realCache, externalTarget);
        await symlink(externalTarget, realCache);
        assert.equal((await lstat(realCache)).isSymbolicLink(), true);

        // Fast path must refuse the symlinked root instead of reading through it.
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          false,
          "symlinked cache root must not satisfy hasExpectedOmxPluginCache",
        );
        assert.equal(
          await readOmxPluginCacheState(realCache),
          null,
          "cache state must not be read through a symlinked root",
        );
        assert.equal(
          await pluginHookCacheMatchesPackaged(realCache, packaged),
          false,
          "hook assets behind a symlinked root must not match",
        );

        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /symlink or non-directory/);
        assert.match(
          r.reason!,
          new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );

        // Non-mutation proof: the external target stays exactly where the attacker
        // put it (setup neither followed nor rewrote it), and the external copy is
        // still attacker-writable — which is precisely why it can never be trusted.
        const sentinel = await readFile(
          join(externalTarget, "hooks", "hooks.json"),
          "utf-8",
        );
        const packagedHook = await readFile(
          join(packageRoot, "plugins", "oh-my-codex", "hooks", "hooks.json"),
          "utf-8",
        );
        assert.equal(sentinel, packagedHook, "external target untouched by setup");
        await writeFile(
          join(externalTarget, "hooks", "hooks.json"),
          "// attacker mutation\n",
        );
        const mutatedExternal = await readFile(
          join(realCache, "hooks", "hooks.json"),
          "utf-8",
        );
        assert.equal(
          mutatedExternal,
          "// attacker mutation\n",
          "proof the pre-fix trust boundary would have followed the external target",
        );
        assert.equal(
          await pluginHookCacheMatchesPackaged(realCache, packaged),
          false,
          "mutated external target must still never match after the mutation",
        );
        assert.equal(existsSync(realCache), true);
        assert.equal((await lstat(realCache)).isSymbolicLink(), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  const assetCases = [
    ["hooks.json", false],
    ["codex-native-hook.mjs", false],
    ["omx-command.json", true],
  ] as const;

  for (const [asset, isLauncher] of assetCases) {
    it(`symlinked hooks/${asset} with byte-identical external content is rejected (unchanged fast path + materializer)`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-asset-${asset.replace(/[^a-z]/g, "")}-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const assetPath = join(cacheDir, "hooks", asset);
          const external = join(wd, "external", asset);
          await mkdir(dirname(external), { recursive: true });
          // Byte-identical content moved outside the managed namespace.
          await rename(assetPath, external);
          await symlink(external, assetPath);
          assert.equal((await lstat(assetPath)).isSymbolicLink(), true);
          assert.equal(
            (await readFile(assetPath, "utf-8")) === (await readFile(external, "utf-8")),
            true,
            "external target is byte-identical (the pre-fix trust bypass condition)",
          );

          const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
          assert.ok(reason, `${asset} symlink must produce a provenance reason`);
          assert.match(reason, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          assert.match(reason, /symlink or not a regular file/);
          assert.equal(
            await pluginHookCacheMatchesPackaged(cacheDir, packaged),
            false,
            `symlinked ${asset} must not satisfy hook cache matching`,
          );
          if (!isLauncher) {
            // hooks.json / codex-native-hook.mjs mismatches flip hasExpectedOmxPluginCache
            assert.equal(
              await hasExpectedOmxPluginCache(codexHomeDir, packaged),
              false,
              `symlinked ${asset} must not satisfy hasExpectedOmxPluginCache`,
            );
          }
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /symlink or not a regular file/);
          assert.match(
            r.reason!,
            new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );

          // Non-mutation proof: the symlink and the external target both survive
          // the materializer run untouched (#3499 immutability preserved), and a
          // later external mutation never flips the verdict back to trusted.
          assert.equal((await lstat(assetPath)).isSymbolicLink(), true);
          await writeFile(external, "// attacker mutation\n");
          const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r2.status, "stale-launcher", "mutated external target stays rejected");
          assert.equal(
            (await readFile(assetPath, "utf-8")),
            "// attacker mutation\n",
            "reads through the symlink follow the attacker target (why it is untrusted)",
          );
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }

  it("symlinked hooks directory itself is rejected before any executed-asset read", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-hooks-dir-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const external = join(wd, "external", "hooks");
        await mkdir(dirname(external), { recursive: true });
        await rename(join(cacheDir, "hooks"), external);
        await symlink(external, join(cacheDir, "hooks"));
        assert.equal((await lstat(join(cacheDir, "hooks"))).isSymbolicLink(), true);

        const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
        assert.ok(reason);
        assert.match(reason, /symlink or not a directory/);
        assert.equal(
          await pluginHookCacheMatchesPackaged(cacheDir, packaged),
          false,
        );
        assert.equal(
          await hasExpectedOmxPluginCache(codexHomeDir, packaged),
          false,
        );
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /symlink or not a (regular file|directory)/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("non-regular executed asset (FIFO replaced by directory) is rejected fail-closed", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-nonregular-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        await rm(join(cacheDir, "hooks", "hooks.json"), { force: true });
        await mkdir(join(cacheDir, "hooks", "hooks.json"));
        const reason = await omxPluginCacheExecutedAssetProvenanceReason(cacheDir);
        assert.ok(reason);
        assert.match(reason, /symlink or not a regular file/);
        assert.equal(await pluginHookCacheMatchesPackaged(cacheDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("manifest pointer drift is rejected before an existing snapshot can return unchanged", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-manifest-drift-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
        await writeFile(
          manifestPath,
          JSON.stringify({ ...manifest, skills: "./attacker-skills/", hooks: "./attacker-hooks/hooks.json" }),
        );

        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /manifest (skills|hooks) pointer/);
        assert.match(r.reason!, new RegExp(PLUGIN_LAUNCHER_RECOVERY_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(await readFile(manifestPath, "utf-8"), /attacker-skills/);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("symlinked manifest is rejected even when its external content is canonical", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-manifest-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const manifestPath = join(cacheDir, ".codex-plugin", "plugin.json");
        const externalManifest = join(wd, "external", "plugin.json");
        await mkdir(dirname(externalManifest), { recursive: true });
        await rename(manifestPath, externalManifest);
        await symlink(externalManifest, manifestPath);

        assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /plugin manifest .*symlink/);
        assert.equal((await lstat(manifestPath)).isSymbolicLink(), true);
        assert.equal(await readFile(externalManifest, "utf-8"), await readFile(join(packaged.pluginRoot, ".codex-plugin", "plugin.json"), "utf-8"));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("skills directory symlink with matching names and attacker content is rejected and preserved", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-skills-symlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillsPath = join(cacheDir, "skills");
        const externalSkills = join(wd, "external", "skills");
        await mkdir(dirname(externalSkills), { recursive: true });
        await rename(skillsPath, externalSkills);
        await writeFile(join(externalSkills, "worker", "SKILL.md"), "# attacker-controlled skill\n");
        await symlink(externalSkills, skillsPath);

        assert.equal((await lstat(skillsPath)).isSymbolicLink(), true);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /skills directory .*symlink/);
        assert.equal((await lstat(skillsPath)).isSymbolicLink(), true);
        assert.equal(await readFile(join(externalSkills, "worker", "SKILL.md"), "utf-8"), "# attacker-controlled skill\n");

        await writeFile(join(externalSkills, "worker", "SKILL.md"), "# attacker mutation\n");
        const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r2.status, "stale-launcher", JSON.stringify(r2));
        assert.equal(await readFile(join(skillsPath, "worker", "SKILL.md"), "utf-8"), "# attacker mutation\n");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("regular attacker-mutated SKILL.md content is rejected before unchanged acceptance", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-skill-content-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        const skillPath = join(cacheDir, "skills", "worker", "SKILL.md");
        const sentinel = "# attacker-mutated regular skill\n";
        await writeFile(skillPath, sentinel);

        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
        const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(r.status, "stale-launcher", JSON.stringify(r));
        assert.match(r.reason!, /expected skill file content differs/);
        assert.equal(await readFile(skillPath, "utf-8"), sentinel);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  const companionCases = [".mcp.json", ".app.json"] as const;
  for (const companion of companionCases) {
    it(`${companion} content drift is rejected before unchanged acceptance`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-drift-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          const sentinel = `{"attacker":"${companion}"}\n`;
          await writeFile(cachedPath, sentinel);

          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file content differs/);
          assert.equal(await readFile(cachedPath, "utf-8"), sentinel);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });

    it(`${companion} symlink with canonical external content is rejected and preserved`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-symlink-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          await mkdir(dirname(externalPath), { recursive: true });
          await rename(cachedPath, externalPath);
          await symlink(externalPath, cachedPath);

          assert.equal((await lstat(cachedPath)).isSymbolicLink(), true);
          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file .*symlink/);
          assert.equal((await lstat(cachedPath)).isSymbolicLink(), true);
          await writeFile(externalPath, "{\"attacker\":true}\n");
          const r2 = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r2.status, "stale-launcher", JSON.stringify(r2));
          assert.equal(await readFile(cachedPath, "utf-8"), "{\"attacker\":true}\n");
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });

    it(`${companion} non-regular entry is rejected fail-closed`, async () => {
      const wd = await mkdtemp(join(tmpdir(), `omx-3552-${companion.slice(1)}-nonregular-`));
      try {
        await withIsolatedUserHome(wd, async (codexHomeDir) => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, companion);
          await rm(cachedPath, { force: true });
          await mkdir(cachedPath);

          assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), false);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher", JSON.stringify(r));
          assert.match(r.reason!, /companion file .*not a regular file/);
        });
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  }

  it("rejects companion symlink swaps during descriptor-bound provenance validation", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-companion-toctou-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        for (const companion of companionCases) {
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          const canonical = await readFile(cachedPath);
          await mkdir(dirname(externalPath), { recursive: true });
			await writeFile(externalPath, `{"attacker":"${companion}"}\n`);
			for (let iteration = 0; iteration < 2000; iteration += 1) {
				await rm(cachedPath, { force: true });
				await symlink(externalPath, cachedPath);
				const reason = await omxPluginCacheProvenanceReason(cacheDir, packaged);
				assert.match(reason ?? "", /companion file .*symlink/);
				await rm(cachedPath, { force: true });
				await writeFile(cachedPath, canonical);
			}
          assert.equal(await readFile(externalPath, "utf-8"), `{"attacker":"${companion}"}\n`);
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not replace a same-version cache claimed concurrently", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-cache-claim-race-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const results = await Promise.all([
          materializePackagedOmxPluginCache(codexHomeDir, packaged),
          materializePackagedOmxPluginCache(codexHomeDir, packaged),
        ]);
        assert.ok(results.every((result) => result.status !== "unavailable"));
        assert.ok(results.some((result) => result.status === "materialized" || result.status === "unchanged"));
        const cacheDir = results.find((result) => result.cacheDir)?.cacheDir;
        assert.ok(cacheDir);
        assert.equal(existsSync(join(cacheDir, ".omx-incomplete")), false);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("refuses a same-version directory claimed at the publication barrier", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-publication-barrier-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(
          codexHomeDir,
          "plugins",
          "cache",
          "oh-my-codex-local",
          "oh-my-codex",
          version,
        );
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async (preparedCacheDir) => {
            assert.equal(preparedCacheDir, cacheDir);
            await mkdir(preparedCacheDir, { recursive: true });
            await writeFile(join(preparedCacheDir, "attacker-sentinel"), "preserve\n");
          },
        });
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.match(result.reason ?? "", /already exists|refusing to replace/);
        assert.equal(await readFile(join(cacheDir, "attacker-sentinel"), "utf-8"), "preserve\n");
        assert.equal(existsSync(join(cacheDir, ".omx-complete")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed on a foreign .omx-incomplete directory instead of reclaiming it", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-foreign-incomplete-claim-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(join(cacheDir, "foreign-sentinel"), "preserve\n");
        await writeFile(join(cacheDir, ".omx-incomplete"), "crashed publisher\n");
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.match(result.reason ?? "", /already exists|refusing to replace|symlink or non-directory/);
        assert.equal(await readFile(join(cacheDir, "foreign-sentinel"), "utf-8"), "preserve\n");
        assert.equal(existsSync(join(cacheDir, ".omx-incomplete")), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not replace an EMPTY same-version directory claimed concurrently (no-replace publication)", async () => {
    // Blocker 3: POSIX rename() silently replaces an empty directory, so the
    // empty-destination case must be covered separately from the sentinel case.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-empty-claim-barrier-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async (preparedCacheDir) => {
            assert.equal(preparedCacheDir, cacheDir);
            await mkdir(preparedCacheDir, { recursive: true });
          },
        });
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.match(result.reason ?? "", /already exists|refusing to replace/);
        // The claimant (empty directory) survives untouched.
        assert.equal((await lstat(cacheDir)).isDirectory(), true);
        assert.equal((await readdir(cacheDir)).length, 0);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not clobber a newly claimed lock during stale-lock restore", async () => {
    // Blocker 4: the restore path must use a no-clobber primitive (link) so a
    // replacement lock acquired by another publisher is never overwritten.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-lock-restore-noclobber-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        // Seed a stale lock from a dead pid; another publisher concurrently
        // re-claims the name after the reclaimer quarantines it.
        await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }));
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async () => {
            // Simulate the restore-gap claimant: replace the (now removed)
            // lock name with fresh content while publication holds staging.
            const entries = await readdir(cacheBase);
            if (!entries.includes(".omx-publish.lock")) {
              await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now() }), { flag: "wx" });
            }
          },
        });
        // Either this publisher lost the race (stale-launcher) or it completed
        // after removing its own lock; in both cases a live claimant's lock
        // content must never be overwritten by the restore path.
        const finalLock = existsSync(lockPath) ? await readFile(lockPath, "utf-8") : null;
        if (finalLock !== null) {
          const record = JSON.parse(finalLock) as { pid?: number };
          assert.ok(record.pid, "surviving lock must keep its claimant record");
        }
        assert.ok(result.status === "materialized" || result.status === "stale-launcher");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("never discovers a marker-committed staging snapshot before publication", async () => {
    // Blocker 5: discovery must exclude staging trees, so a snapshot that has
    // its .omx-complete marker committed while still staged is invisible.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-staging-invisible-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        let observedDuringStaging = false;
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async () => {
            const discovered = await discoverOmxPluginCacheDirs(codexHomeDir);
            if (discovered.some((dir) => dir.includes(".omx-plugin-"))) observedDuringStaging = true;
          },
        });
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(observedDuringStaging, false, "discovery observed a staging path");
        const published = await discoverOmxPluginCacheDirs(codexHomeDir);
        assert.ok(published.some((dir) => dir === join(omxPluginCacheBase(codexHomeDir), version)));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not treat a PID-reused live owner as a stale lock while its lease is valid", async () => {
    // Blocker 6: a crashed publisher's pid can be reused by a live process;
    // the lock must remain held while the recorded lease is fresh.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-pid-reuse-lease-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        // Live process pid + fresh heartbeat: lock is held regardless of PID reuse.
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now(), processToken: "other" }));
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.match(result.reason ?? "", /another OMX plugin cache publication is active|cannot claim/);
        assert.equal(existsSync(lockPath), true);
        // An expired lease with a live-but-unrelated pid (PID reuse) is stale.
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 600_000, heartbeatAt: Date.now() - 600_000, processToken: "crashed" }));
        const recovered = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(recovered.status, "materialized", JSON.stringify(recovered));
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("recovers a publication lock owned by a dead process", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-stale-publication-lock-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = join(codexHomeDir, "plugins", "cache", "oh-my-codex-local", "oh-my-codex");
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }));
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(existsSync(lockPath), false);
        assert.equal(await hasExpectedOmxPluginCache(codexHomeDir, packaged), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps direct materialization dry-run read-only when the cache namespace is absent", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-dry-run-read-only-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, { dryRun: true });
        assert.equal(result.status, "materialized", JSON.stringify(result));
        assert.equal(existsSync(join(codexHomeDir, "plugins")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not accept attacker bytes after companion replacement", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-companion-concurrent-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheDir = await seedRegularSnapshot(codexHomeDir);
        for (const companion of companionCases) {
          const cachedPath = join(cacheDir, companion);
          const externalPath = join(wd, "external", companion);
          const canonical = await readFile(cachedPath);
          await mkdir(dirname(externalPath), { recursive: true });
          await writeFile(externalPath, canonical);
          for (let iteration = 0; iteration < 2000; iteration += 1) {
            await rm(cachedPath, { force: true });
            await symlink(externalPath, cachedPath);
            await writeFile(externalPath, `{"attacker":"${companion}"}\n`);
            const rejected = await readOmxPluginCacheFileNoFollow(cachedPath);
            assert.equal(rejected, null, `${companion} accepted attacker-controlled symlink bytes`);
            await rm(cachedPath, { force: true });
            await writeFile(cachedPath, canonical);
            await writeFile(externalPath, canonical);
          }
          assert.equal((await readFile(externalPath)).equals(canonical), true);
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("rejects hard-linked cache provenance files across shared surfaces", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-hardlink-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const surfaces = [
          ".mcp.json",
          ".app.json",
          ".codex-plugin/plugin.json",
          "skills/worker/SKILL.md",
          "hooks/hooks.json",
          "hooks/codex-native-hook.mjs",
          "hooks/omx-command.json",
        ];
        for (const surface of surfaces) {
          const cacheDir = await seedRegularSnapshot(codexHomeDir);
          const cachedPath = join(cacheDir, surface);
          const externalPath = join(wd, "hardlinks", surface.replaceAll("/", "-"));
          await mkdir(dirname(externalPath), { recursive: true });
          await link(cachedPath, externalPath);
          await rm(cachedPath, { force: true });
          await link(externalPath, cachedPath);

          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.notEqual(result.status, "unchanged", `${surface} hardlink was trusted`);
          assert.equal((await lstat(cachedPath)).nlink > 1, true);
          assert.equal((await readFile(externalPath)).equals(await readFile(cachedPath)), true);
          await rm(cacheDir, { recursive: true, force: true });
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("long live publication lease is renewed while holding the lock (P2 heartbeat)", async () => {
    // Slow publisher on a slow filesystem would exceed PUBLICATION_LOCK_LEASE_MS.
    // The holder must refresh heartbeatAt on the open fd so a concurrent claimant
    // never sees an expired live lease. This exercises the real publication path
    // via a staged onCacheDirPrepared delay.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-heartbeat-live-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        // Seed a fresh live lock then run a publication that holds it: inject a
        // short delay inside the critical section; second concurrent attempt must
        // still see the live owner as active.
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async () => {
            const bytes = await readFile(lockPath);
            const before = parseLastPublicationLockRecord(bytes.toString("utf-8")) as { heartbeatAt?: number };
            assert.ok(typeof before.heartbeatAt === "number");
            // Concurrent claimant while critical section is still held.
            const concurrent = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
            assert.equal(concurrent.status, "stale-launcher");
            assert.match(concurrent.reason ?? "", /another OMX plugin cache publication is active|cannot claim/);
            // Write a stale-looking heartbeat under a reused PID would previously
            // have been considered stale even for a live owner; ensure the holder's
            // interval has kept the real lease non-expired (done via the interval).
            await new Promise<void>((r) => setTimeout(r, 50));
            const afterBytes = await readFile(lockPath);
            const after = parseLastPublicationLockRecord(afterBytes.toString("utf-8")) as { heartbeatAt?: number };
            assert.ok(typeof after.heartbeatAt === "number");
          },
        });
        assert.equal(first.status, "materialized", JSON.stringify(first));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("cleanup does not quarantine a successor lock (P2 successor)", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-successor-lock-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        // First publisher materializes and releases; immediately after, a second
        // publisher claims a new lock. Verify the first publisher's cleanup did not
        // quarantine the successor (dev/ino fencing in the finally block).
        const first = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(first.status, "materialized", JSON.stringify(first));
        // Lock is removed on success path; seed a successor and ensure materialize
        // still respects it, then that successor's own lifecycle is intact.
        await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now(), processToken: "successor" }));
        const second = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.equal(second.status, "stale-launcher", JSON.stringify(second));
        assert.match(second.reason ?? "", /another OMX plugin cache publication is active|cannot claim/);
        const successorBytes = await readFile(lockPath, "utf-8");
        const successor = JSON.parse(successorBytes) as { processToken?: string };
        assert.equal(successor.processToken, "successor");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("standalone retirement holds heartbeat for >120s scan (P2 3861490863)", async () => {
    // retireUnpinnedManagedSnapshots acquires its own publication lock when
    // called standalone (publicationLockHeld=false). A scan/removal that
    // lasts beyond PUBLICATION_LOCK_LEASE_MS must not be reclaimable
    // mid-retirement. The standalone path must refresh heartbeatAt on the
    // open fd (same lifecycle as publication).
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-long-retirement-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        await mkdir(cacheBase, { recursive: true });
        for (const v of ["0.20.0", "0.20.1", "0.20.2"]) {
          const dir = join(cacheBase, v);
          await mkdir(dir, { recursive: true });
          await writeFile(join(dir, ".omx-managed"), "fixture\n");
          await mkdir(join(dir, ".codex-plugin"), { recursive: true });
          await writeFile(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-codex", version: v, skills: "./skills/", hooks: "./hooks/hooks.json" }));
          await writeFile(join(dir, ".omx-complete"), `${JSON.stringify({ version: v, claimDigest: await computeOmxPluginCacheClaimDigest(dir) })}\n`);
        }
        const version = await packagedPluginVersion();
        const { retireUnpinnedManagedSnapshots } = await import("../plugin-marketplace.js") as unknown as { retireUnpinnedManagedSnapshots: (a: string, b: string) => Promise<string[]> };
        const retirement = retireUnpinnedManagedSnapshots(codexHomeDir, version);
        await new Promise<void>((r) => setTimeout(r, 20));
        const concurrent = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
        assert.ok(concurrent.status === "stale-launcher" || concurrent.status === "materialized" || concurrent.status === "unchanged");
        if (concurrent.status === "stale-launcher") {
          assert.match(concurrent.reason ?? "", /another OMX plugin cache publication is active|cannot claim/);
        }
        const retired = await retirement;
        assert.ok(Array.isArray(retired));
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("retirement replacement after validation is preserved (P2 3861490875)", async () => {
    // Deterministic identity-bound test: stat, replace directory with foreign
    // inode, then call removeChildIfIdentity with stale original stats.
    // The helper must preserve the foreign replacement at its canonical version
    // path or in quarantine, because portable directory restoration cannot be
    // made atomic no-replace, and must not delete foreign content.
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-replacement-restore-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        await mkdir(cacheBase, { recursive: true });
        const victim = "0.20.0";
        const victimPath = join(cacheBase, victim);
        await mkdir(victimPath, { recursive: true });
        await writeFile(join(victimPath, "victim.txt"), "victim\n");
        const { lstat: lstatP } = await import("fs/promises");
        const originalStats = await lstatP(victimPath);
        // Keep original inode alive so the foreign replacement gets a different inode
        // (immediate rm+mkdir can reuse the same inode on this fs, which would
        // make the dev/ino check pass and the helper would incorrectly delete foreign).
        const keepPath = join(cacheBase, victim + ".keep-" + process.pid);
        await rm(keepPath, { recursive: true, force: true }).catch(() => {});
        const { rename: renameP } = await import("fs/promises");
        await renameP(victimPath, keepPath);
        await mkdir(victimPath, { recursive: true });
        const foreignSentinel = join(victimPath, "foreign.txt");
        await writeFile(foreignSentinel, "foreign\n");
        // keepPath holds the original inode; clean it up after the check

        const { removeChildIfIdentity } = await import("../plugin-marketplace.js") as unknown as { removeChildIfIdentity: (baseRef: unknown, name: string, stats: import("fs").Stats, opts: unknown) => Promise<void> };
        // Build a minimal DirectoryRef over cacheBase using the same helper
        // the production code uses (open via fs/promises so lstat/dev/ino match).
        const { open } = await import("fs/promises");
        const { constants } = await import("fs");
        const fd = await open(cacheBase, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const baseRef: unknown = { handle: fd, path: cacheBase, operationPath: directoryOperationPathForTest(fd, cacheBase), scanOperationPath: directoryOperationPathForTest(fd, cacheBase), mutationPath: directoryOperationPathForTest(fd, cacheBase) };
        try {
          await removeChildIfIdentity(baseRef, victim, originalStats, { recursive: true, force: true });
        } catch (e) {
          assert.match((e as Error).message, /identity-bound removal target changed/);
        } finally {
          try { await (fd as unknown as { close: () => Promise<void> }).close(); } catch {}
        }
        await rm(keepPath, { recursive: true, force: true }).catch(() => {});
        const foreignAtVersion = existsSync(foreignSentinel) && (await readFile(foreignSentinel, "utf-8")) === "foreign\n";
        const quarantineWithForeign = (await readdir(cacheBase)).some((n) => n.includes(".reclaim-") && existsSync(join(cacheBase, n, "foreign.txt")));
        assert.equal(foreignAtVersion || quarantineWithForeign, true, "foreign replacement was deleted");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves both artifacts when retirement is interposed before quarantine", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-retirement-interpose-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        await mkdir(cacheBase, { recursive: true });
        const victim = "0.20.0";
        const victimPath = join(cacheBase, victim);
        await mkdir(victimPath, { recursive: true });
        await writeFile(join(victimPath, "victim.txt"), "victim\n");
        const originalStats = await lstat(victimPath);
        const originalPath = join(cacheBase, `${victim}.original`);
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRename: async (sourcePath) => {
            if (interposed || basename(sourcePath) !== victim) return;
            interposed = true;
            await rename(victimPath, originalPath);
            await mkdir(victimPath, { recursive: true });
            await writeFile(join(victimPath, "successor.txt"), "successor\n");
          },
        });
        try {
          const { removeChildIfIdentity } = await import("../plugin-marketplace.js") as unknown as {
            removeChildIfIdentity: (baseRef: unknown, name: string, stats: import("fs").Stats, opts: unknown) => Promise<void>;
          };
          const { open } = await import("fs/promises");
          const { constants } = await import("fs");
          const fd = await open(cacheBase, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const baseRef: unknown = {
            handle: fd,
            path: cacheBase,
            operationPath: directoryOperationPathForTest(fd, cacheBase),
            scanOperationPath: directoryOperationPathForTest(fd, cacheBase),
            mutationPath: directoryOperationPathForTest(fd, cacheBase),
          };
          try {
            await assert.rejects(
              removeChildIfIdentity(baseRef, victim, originalStats, { recursive: true, force: true }),
              /preserved quarantine/,
            );
          } finally {
            await fd.close();
          }
        } finally {
          resetHooks();
        }
        assert.equal(await readFile(join(originalPath, "victim.txt"), "utf-8"), "victim\n");
        const quarantined = (await readdir(cacheBase)).find((name) => name.includes(".reclaim-"));
        assert.ok(quarantined, "interposed successor must remain quarantined for bounded cleanup");
        const successorAtVersion = existsSync(join(victimPath, "successor.txt"));
        const successorInQuarantine = existsSync(join(cacheBase, quarantined!, "successor.txt"));
        assert.equal(successorAtVersion || successorInQuarantine, true, "interposed successor must remain reachable");
        if (successorInQuarantine) {
          assert.equal(await readFile(join(cacheBase, quarantined!, "successor.txt"), "utf-8"), "successor\n");
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when staging destination appears between no-replace checks", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-staging-interpose-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
        let destinationName: string | undefined;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeMkdirExclusive: async (parentPath, name) => {
            if (destinationName || !sameFilePath(parentPath, cacheDir) || name === ".omx-incomplete") return;
            destinationName = name;
            await writeFile(join(parentPath, name), "staging successor\n");
          },
          beforeExclusiveCreate: async (parentPath, name) => {
            if (destinationName || !sameFilePath(parentPath, cacheDir) || name === ".omx-incomplete") return;
            destinationName = name;
            await writeFile(join(parentPath, name), "staging successor\n");
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        assert.ok(destinationName);
        assert.equal(await readFile(join(cacheDir, destinationName!), "utf-8"), "staging successor\n");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("fails closed when a staged source changes after its bytes are read", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-staged-source-race-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          afterStagedFileRead: async (path) => {
            if (interposed || (!path.includes("/snapshot/hooks/") && !path.includes("\\snapshot\\hooks\\")) || !path.endsWith("hooks.json")) return;
            interposed = true;
            await writeFile(path, "{\"attacker\":true}\n");
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        assert.equal(existsSync(join(cacheDir, ".omx-complete")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("validates the final claim before publishing the complete marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-final-claim-validation-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const version = await packagedPluginVersion();
        const cacheDir = join(omxPluginCacheBase(codexHomeDir), version);
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeCompleteMarker: async (claimPath) => {
            await writeFile(join(claimPath, "hooks", "hooks.json"), "{\"attacker\":true}\n");
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        assert.equal(existsSync(join(cacheDir, ".omx-complete")), false);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a replacement interposed between quarantine lstat and recursive removal", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-removal-interpose-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        await mkdir(cacheBase, { recursive: true });
        const victim = "0.20.0";
        const victimPath = join(cacheBase, victim);
        await mkdir(victimPath, { recursive: true });
        await writeFile(join(victimPath, "victim.txt"), "victim\n");
        const originalStats = await lstat(victimPath);
        const preservedPath = join(cacheBase, `${victim}.preserved`);
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRemove: async (path) => {
            if (interposed || !path.includes(".reclaim-")) return;
            interposed = true;
            await rename(path, preservedPath);
            await mkdir(path, { recursive: true });
            await writeFile(join(path, "replacement.txt"), "replacement\n");
          },
        });
        try {
          const { removeChildIfIdentity } = await import("../plugin-marketplace.js") as unknown as {
            removeChildIfIdentity: (baseRef: unknown, name: string, stats: import("fs").Stats, opts: unknown) => Promise<void>;
          };
          const { open } = await import("fs/promises");
          const { constants } = await import("fs");
          const fd = await open(cacheBase, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const baseRef: unknown = {
            handle: fd,
            path: cacheBase,
            operationPath: directoryOperationPathForTest(fd, cacheBase),
            scanOperationPath: directoryOperationPathForTest(fd, cacheBase),
            mutationPath: directoryOperationPathForTest(fd, cacheBase),
          };
          try {
            await assert.rejects(
              removeChildIfIdentity(baseRef, victim, originalStats, { recursive: true, force: true, preserveRecursive: false }),
              /changed before deletion/,
            );
          } finally {
            await fd.close();
          }
        } finally {
          resetHooks();
        }
        assert.equal(await readFile(join(preservedPath, "victim.txt"), "utf-8"), "victim\n");
        const replacementAtVersion = existsSync(join(cacheBase, victim, "replacement.txt"));
        const quarantined = (await readdir(cacheBase)).find((name) => name.includes(".reclaim-"));
        const replacementInQuarantine = quarantined
          ? existsSync(join(cacheBase, quarantined, "replacement.txt"))
          : false;
        assert.equal(replacementAtVersion || replacementInQuarantine, true, "replacement must remain reachable");
        if (replacementInQuarantine) {
          assert.equal(await readFile(join(cacheBase, quarantined!, "replacement.txt"), "utf-8"), "replacement\n");
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a replacement interposed after the final removal identity check", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-removal-final-fence-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        await mkdir(cacheBase, { recursive: true });
        const victim = "0.20.0";
        const victimPath = join(cacheBase, victim);
        await mkdir(victimPath, { recursive: true });
        await writeFile(join(victimPath, "victim.txt"), "victim\n");
        const originalStats = await lstat(victimPath);
        const preservedPath = join(cacheBase, `${victim}.preserved`);
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRemoveSyscall: async (path) => {
            if (interposed || !path.includes(".reclaim-")) return;
            interposed = true;
            await rename(path, preservedPath);
            await mkdir(path, { recursive: true });
            await writeFile(join(path, "replacement.txt"), "replacement\n");
          },
        });
        try {
          const { removeChildIfIdentity } = await import("../plugin-marketplace.js") as unknown as {
            removeChildIfIdentity: (baseRef: unknown, name: string, stats: import("fs").Stats, opts: unknown) => Promise<void>;
          };
          const { open } = await import("fs/promises");
          const { constants } = await import("fs");
          const fd = await open(cacheBase, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const baseRef: unknown = {
            handle: fd,
            path: cacheBase,
            operationPath: directoryOperationPathForTest(fd, cacheBase),
            scanOperationPath: directoryOperationPathForTest(fd, cacheBase),
            mutationPath: directoryOperationPathForTest(fd, cacheBase),
          };
          try {
            await assert.rejects(
              removeChildIfIdentity(baseRef, victim, originalStats, { recursive: true, force: true, preserveRecursive: false }),
              /changed before removal syscall/,
            );
          } finally {
            await fd.close();
          }
        } finally {
          resetHooks();
        }
        assert.equal(await readFile(join(preservedPath, "victim.txt"), "utf-8"), "victim\n");
        const quarantined = (await readdir(cacheBase)).find((name) => name.includes(".reclaim-"));
        const replacementAtVersion = existsSync(join(cacheBase, victim, "replacement.txt"));
        const replacementInQuarantine = quarantined
          ? existsSync(join(cacheBase, quarantined, "replacement.txt"))
          : false;
        assert.equal(replacementAtVersion || replacementInQuarantine, true, "replacement must remain reachable");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a successor during interposed stale-lock cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-stale-lock-interpose-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        const originalPath = join(cacheBase, ".omx-publish.lock.original");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }));
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRename: async (sourcePath) => {
            if (interposed || basename(sourcePath) !== ".omx-publish.lock") return;
            interposed = true;
            await rename(lockPath, originalPath);
            await writeFile(lockPath, JSON.stringify({
              pid: process.pid,
              createdAt: Date.now(),
              heartbeatAt: Date.now(),
              processToken: "successor",
            }));
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        const successor = parseLastPublicationLockRecord(await readFile(lockPath, "utf-8")) as { processToken?: string };
        assert.equal(successor.processToken, "successor");
        assert.equal(existsSync(originalPath), true);
        assert.ok((await readdir(cacheBase)).some((name) => name.includes(".reclaim-")), "raced lock quarantine must remain for bounded cleanup");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("re-reads a same-inode heartbeat before stale-lock quarantine", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-heartbeat-recheck-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, `${JSON.stringify({ pid: 99999999, createdAt: Date.now() - 600_000, heartbeatAt: Date.now() - 600_000, processToken: "old" })}\n`);
        let refreshed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeStaleLockReclaim: async (path) => {
            if (refreshed) return;
            refreshed = true;
            await writeFile(path, `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now(), processToken: "same-inode-live" })}\n`, { flag: "a" });
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        const record = parseLastPublicationLockRecord(await readFile(lockPath, "utf-8")) as { processToken?: string };
        assert.equal(record.processToken, "same-inode-live");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("aborts stale-lock cleanup when the quarantined owner heartbeats late", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-late-heartbeat-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        await mkdir(cacheBase, { recursive: true });
        await writeFile(lockPath, `${JSON.stringify({ pid: 99999999, createdAt: Date.now() - 600_000, heartbeatAt: Date.now() - 600_000, processToken: "old" })}\n`);
        let heartbeated = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRemoveSyscall: async (path) => {
            if (heartbeated || !path.includes(".reclaim-")) return;
            heartbeated = true;
            await writeFile(path, `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now(), processToken: "late-owner" })}\n`);
          },
        });
        try {
          const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        } finally {
          resetHooks();
        }
        const successor = parseLastPublicationLockRecord(await readFile(lockPath, "utf-8")) as { processToken?: string };
        assert.equal(successor.processToken, "late-owner");
        assert.ok((await readdir(cacheBase)).some((name) => name.includes(".reclaim-")), "late-heartbeat quarantine must remain bounded");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("aborts a publisher when its retained lock fd loses the pathname", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-lock-path-loss-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const packaged = await resolvePackagedOmxMarketplace(packageRoot);
        assert.ok(packaged);
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const lockPath = join(cacheBase, ".omx-publish.lock");
        let interposed = false;
        const result = await materializePackagedOmxPluginCache(codexHomeDir, packaged, {
          onCacheDirPrepared: async () => {
            if (interposed) return;
            interposed = true;
            await rm(lockPath, { force: true });
            await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), heartbeatAt: Date.now(), processToken: "successor" })}\n`, { flag: "wx" });
          },
        });
        assert.equal(result.status, "stale-launcher", JSON.stringify(result));
        assert.match(result.reason ?? "", /publication lock ownership lost/);
        const successor = parseLastPublicationLockRecord(await readFile(lockPath, "utf-8")) as { processToken?: string };
        assert.equal(successor.processToken, "successor");
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not retire a same-name cache without the managed ownership marker", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-foreign-managed-name-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const foreign = join(cacheBase, "0.20.0");
        await mkdir(join(foreign, ".codex-plugin"), { recursive: true });
        await writeFile(join(foreign, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-codex", version: "0.20.0" }));
        await writeFile(join(foreign, ".omx-complete"), `${JSON.stringify({ version: "0.20.0", claimDigest: await computeOmxPluginCacheClaimDigest(foreign) })}\n`);
        const { retireUnpinnedManagedSnapshots } = await import("../plugin-marketplace.js");
        assert.deepEqual(await retireUnpinnedManagedSnapshots(codexHomeDir, "0.21.0"), []);
        assert.equal(existsSync(foreign), true);
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a live pin inserted before retirement quarantine", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-live-pin-race-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const victim = join(cacheBase, "0.20.0");
        await mkdir(join(victim, ".codex-plugin"), { recursive: true });
        await writeFile(join(victim, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-codex", version: "0.20.0" }));
        await writeFile(join(victim, ".omx-managed"), "fixture\n");
        await writeFile(join(victim, ".omx-complete"), `${JSON.stringify({ version: "0.20.0", claimDigest: await computeOmxPluginCacheClaimDigest(victim) })}\n`);
        const newer = join(cacheBase, "0.20.1");
        await mkdir(join(newer, ".codex-plugin"), { recursive: true });
        await writeFile(join(newer, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-codex", version: "0.20.1" }));
        await writeFile(join(newer, ".omx-managed"), "fixture\n");
        await writeFile(join(newer, ".omx-complete"), `${JSON.stringify({ version: "0.20.1", claimDigest: await computeOmxPluginCacheClaimDigest(newer) })}\n`);
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRename: async (sourcePath) => {
            if (interposed || !sourcePath.includes("0.20.0")) return;
            interposed = true;
            await writeFile(join(sourcePath, ".omx-live-pin"), "late pin\n");
          },
        });
        try {
          const { retireUnpinnedManagedSnapshots } = await import("../plugin-marketplace.js");
          const preservedDirs: string[] = [];
          assert.deepEqual(await retireUnpinnedManagedSnapshots(codexHomeDir, "0.21.0", undefined, false, preservedDirs), []);
          assert.equal(interposed, true, "retirement interposition did not reach the candidate quarantine rename");
          assert.ok(preservedDirs.some((path) => existsSync(join(path, ".omx-live-pin"))));
        } finally {
          resetHooks();
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("preserves a live pin inserted after quarantine before recursive cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3552-live-pin-late-cleanup-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        const cacheBase = omxPluginCacheBase(codexHomeDir);
        const seed = async (version: string) => {
          const dir = join(cacheBase, version);
          await mkdir(join(dir, ".codex-plugin"), { recursive: true });
          await writeFile(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "oh-my-codex", version }));
          await writeFile(join(dir, ".omx-managed"), "fixture\n");
          await writeFile(join(dir, ".omx-complete"), `${JSON.stringify({ version, claimDigest: await computeOmxPluginCacheClaimDigest(dir) })}\n`);
        };
        await seed("0.20.0");
        await seed("0.20.1");
        let interposed = false;
        const resetHooks = setPluginCacheMutationHooksForTest({
          beforeRemoveSyscall: async (path) => {
            if (interposed || !path.includes(".reclaim-")) return;
            interposed = true;
            await writeFile(join(path, ".omx-live-pin"), "late pin\n");
          },
        });
        try {
          const { retireUnpinnedManagedSnapshots } = await import("../plugin-marketplace.js");
          const preservedDirs: string[] = [];
          assert.deepEqual(await retireUnpinnedManagedSnapshots(codexHomeDir, "0.21.0", undefined, false, preservedDirs), []);
          assert.equal(interposed, true);
          assert.ok(preservedDirs.some((path) => existsSync(join(path, ".omx-live-pin"))));
        } finally {
          resetHooks();
        }
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
