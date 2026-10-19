import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setup } from "../setup.js";
import {
  materializePackagedOmxPluginCache,
  resolvePackagedOmxMarketplace,
  getPinnedLauncherIncompatibilityReason,
  readPinnedLauncherRaw,
  PLUGIN_LAUNCHER_RECOVERY_HINT,
  omxPluginCacheBase,
  upsertLocalOmxMarketplaceRegistration,
  upsertLocalOmxPluginEnablement,
  computeOmxPluginCacheClaimDigest,
} from "../plugin-marketplace.js";
import { doctor } from "../doctor.js";

const packageRoot = process.cwd();
let fakeCodexBinDir: string | null = null;
let previousPath: string | undefined;

before(async () => {
  previousPath = process.env.PATH;
  fakeCodexBinDir = await mkdtemp(join(tmpdir(), "omx-fake-codex-3558-"));
  const fakeCodexPath = join(fakeCodexBinDir, "codex");
  await writeFile(
    fakeCodexPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'features' && process.argv[3] === 'list') {",
      "  console.log('hooks                                   stable             true');",
      "  console.log('plugin_hooks                            experimental       true');",
      "  console.log('goals                                   experimental       true');",
      "  process.exit(0);",
      "}",
      "if (process.argv.includes('--version') || process.argv[2] === '--version') {",
      "  console.log('codex-cli 0.999.0');",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await import("node:fs/promises").then((m) => m.chmod(fakeCodexPath, 0o755));
  process.env.PATH = `${fakeCodexBinDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
});

after(async () => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (fakeCodexBinDir)
    await rm(fakeCodexBinDir, { recursive: true, force: true });
});

async function withIsolatedUserHome<T>(
  wd: string,
  fn: (codexHomeDir: string) => Promise<T>,
): Promise<T> {
  const prevHome = process.env.HOME;
  const prevCodex = process.env.CODEX_HOME;
  const homeDir = join(wd, "home");
  const codexHomeDir = join(homeDir, ".codex");
  await mkdir(codexHomeDir, { recursive: true });
  process.env.HOME = homeDir;
  process.env.CODEX_HOME = codexHomeDir;
  try {
    return await fn(codexHomeDir);
  } finally {
    if (typeof prevHome === "string") process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (typeof prevCodex === "string") process.env.CODEX_HOME = prevCodex;
    else delete process.env.CODEX_HOME;
  }
}

async function withTempCwd(wd: string, fn: () => Promise<void>): Promise<void> {
  const prev = process.cwd();
  process.chdir(wd);
  try {
    await fn();
  } finally {
    process.chdir(prev);
  }
}

async function captureConsoleOutput(fn: () => Promise<void>): Promise<string> {
  const origLog = console.log;
  const origWarn = console.warn;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return lines.join("\n");
}

async function packagedPluginCacheDir(codexHomeDir: string): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      join(
        packageRoot,
        "plugins",
        "oh-my-codex",
        ".codex-plugin",
        "plugin.json",
      ),
      "utf-8",
    ),
  ) as {
    version: string;
  };
  return join(
    codexHomeDir,
    "plugins",
    "cache",
    "oh-my-codex-local",
    "oh-my-codex",
    manifest.version,
  );
}

async function seedCurrentLauncher(codexHomeDir: string): Promise<string> {
  const cacheDir = await packagedPluginCacheDir(codexHomeDir);
  await mkdir(dirname(cacheDir), { recursive: true });
  await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
    recursive: true,
  });
  await writeFile(
    join(cacheDir, "hooks", "omx-command.json"),
    JSON.stringify(
      {
        command: process.execPath,
        argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
      },
      null,
      2,
    ) + "\n",
  );
  const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
  await writeFile(join(cacheDir, ".omx-complete"), `${JSON.stringify({ claimDigest })}\n`);
  return cacheDir;
}

async function writeBoundCompletionMarker(cacheDir: string): Promise<void> {
	const claimDigest = await computeOmxPluginCacheClaimDigest(cacheDir);
	await writeFile(join(cacheDir, ".omx-complete"), `${JSON.stringify({ claimDigest })}\n`);
}

async function makeFakePackageRoot(
  base: string,
  label: string,
): Promise<string> {
  const fakeRoot = join(base, label);
  await mkdir(fakeRoot, { recursive: true });
  await cp(join(packageRoot, "plugins"), join(fakeRoot, "plugins"), {
    recursive: true,
  });
  await mkdir(join(fakeRoot, ".agents", "plugins"), { recursive: true });
  await cp(
    join(packageRoot, ".agents", "plugins", "marketplace.json"),
    join(fakeRoot, ".agents", "plugins", "marketplace.json"),
  );
  await mkdir(join(fakeRoot, "dist", "cli"), { recursive: true });
  await writeFile(
    join(fakeRoot, "dist", "cli", "omx.js"),
    `// fake omx ${label}\n`,
    "utf-8",
  );
  return fakeRoot;
}

describe("issue 3558 launcher provenance", () => {
  it("reproduces exact dead-launcher case: same version different root removed -> stale-launcher, immutable preserved, recovery hint", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-repro-"));
    const pkgBase = await mkdtemp(join(tmpdir(), "omx-3558-pkgbase-"));
    try {
      const oldRoot = await makeFakePackageRoot(pkgBase, "old-tmp-src");
      const oldMarketplace = await resolvePackagedOmxMarketplace(oldRoot);
      assert.ok(oldMarketplace);
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          // materialize from old temp root (simulates v0.21.0 from /private/tmp)
          const r1 = await materializePackagedOmxPluginCache(
            codexHomeDir,
            oldMarketplace,
          );
          assert.equal(r1.status, "materialized");
          const launcherPath = join(r1.cacheDir!, "hooks", "omx-command.json");
          const launcher1 = JSON.parse(
            await readFile(launcherPath, "utf-8"),
          ) as { command: string; argsPrefix: string[] };
          assert.ok(launcher1.argsPrefix[0]!.includes("old-tmp-src"));
          // Simulate removal of temp build after global install: delete target
          await rm(join(oldRoot, "dist", "cli", "omx.js"), { force: true });
          assert.equal(existsSync(launcher1.argsPrefix[0]!), false);
          // Now materialize from current (global) packageRoot — same version 0.21.0 but different root
          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });
          const launcher2 = JSON.parse(
            await readFile(launcherPath, "utf-8"),
          ) as { command: string; argsPrefix: string[] };
          // Immutable: file not overwritten
          assert.equal(launcher2.argsPrefix[0]!, launcher1.argsPrefix[0]!);
          assert.equal(
            launcher2.command,
            launcher1.command as unknown as string,
          );
          // Must NOT claim current
          assert.doesNotMatch(
            output,
            /Local Codex plugin cache already exposes packaged OMX skills/,
          );
          assert.match(output, /not safe to use as current/);
          assert.match(output, /does not exist/);
          assert.match(
            output,
            /omx setup --plugin --repair-plugin-cache/,
          );
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const r2 = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(r2.status, "stale-launcher");
          assert.ok(r2.reason);
          assert.match(r2.reason!, /does not exist/);
          assert.equal(
            r2.cacheDir,
            launcherPath.replace("/hooks/omx-command.json", ""),
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(pkgBase, { recursive: true, force: true });
    }
  });

  it("same-root idempotence remains unchanged and live", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-idempotent-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const cacheDir = await seedCurrentLauncher(codexHomeDir);
          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });
          assert.match(
            output,
            /Local Codex plugin cache already exposes packaged OMX skills/,
          );
          assert.doesNotMatch(output, /incompatible launcher/);
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const r = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(r.status, "unchanged");
          const launcher = JSON.parse(
            await readFile(
              join(cacheDir, "hooks", "omx-command.json"),
              "utf-8",
            ),
          ) as {
            argsPrefix: string[];
          };
          assert.equal(
            launcher.argsPrefix[0],
            join(packageRoot, "dist", "cli", "omx.js"),
          );
          assert.equal(existsSync(launcher.argsPrefix[0]!), true);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("provenance mismatch with live target (different root, not deleted) is stale-launcher, not unchanged", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-provenance-live-"));
    const pkgBase = await mkdtemp(join(tmpdir(), "omx-3558-pkgbase-live-"));
    try {
      const fakeRoot = await makeFakePackageRoot(pkgBase, "other-live-root");
      const fakeMarketplace = await resolvePackagedOmxMarketplace(fakeRoot);
      assert.ok(fakeMarketplace);
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          // seed with fake live root
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);
          await mkdir(dirname(cacheDir), { recursive: true });
          await cp(join(fakeRoot, "plugins", "oh-my-codex"), cacheDir, {
            recursive: true,
          });
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify(
              {
                command: process.execPath,
                argsPrefix: [join(fakeRoot, "dist", "cli", "omx.js")],
              },
              null,
              2,
            ) + "\n",
          );
          await writeBoundCompletionMarker(cacheDir);
          assert.equal(
            existsSync(join(fakeRoot, "dist", "cli", "omx.js")),
            true,
          );
          // Now setup with current packageRoot (different but same version) — target still exists at old location
          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });
          assert.doesNotMatch(output, /already exposes/);
          assert.match(output, /incompatible launcher provenance/);
          assert.match(output, /provenance mismatch/);
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const r = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /provenance mismatch/);
          // still preserved
          const launcher = JSON.parse(
            await readFile(
              join(cacheDir, "hooks", "omx-command.json"),
              "utf-8",
            ),
          ) as {
            argsPrefix: string[];
          };
          assert.equal(
            launcher.argsPrefix[0],
            join(fakeRoot, "dist", "cli", "omx.js"),
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(pkgBase, { recursive: true, force: true });
    }
  });
  it("valid target plus extra argsPrefix entries or extra JSON keys is stale-launcher and immutable", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-extra-args-"));
    const pkgBase = await mkdtemp(join(tmpdir(), "omx-3558-pkgbase-extra-"));
    try {
      const fakeRoot = await makeFakePackageRoot(pkgBase, "extra-args-root");
      const packaged = await resolvePackagedOmxMarketplace(fakeRoot);
      assert.ok(packaged);
      const expectedTarget = join(fakeRoot, "dist", "cli", "omx.js");
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);
          await mkdir(dirname(cacheDir), { recursive: true });
          await cp(join(fakeRoot, "plugins", "oh-my-codex"), cacheDir, {
            recursive: true,
          });
          const extraArgsLauncher = {
            command: process.execPath,
            argsPrefix: [expectedTarget, "--eval", "process.exit(0)"],
          };
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify(extraArgsLauncher, null, 2) + "\n",
          );
          const extraArgsReason = await getPinnedLauncherIncompatibilityReason(
            cacheDir,
            packaged,
          );
          assert.ok(extraArgsReason);
          assert.match(extraArgsReason.reason, /exactly one packaged omx\.js target/);
          const extraArgsResult = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(extraArgsResult.status, "stale-launcher");
          assert.deepEqual(
            JSON.parse(
              await readFile(join(cacheDir, "hooks", "omx-command.json"), "utf-8"),
            ),
            extraArgsLauncher,
          );

          const extraKeysLauncher = {
            command: process.execPath,
            argsPrefix: [expectedTarget],
            env: { OMX_INJECT: "1" },
          };
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify(extraKeysLauncher, null, 2) + "\n",
          );
          const extraKeysReason = await getPinnedLauncherIncompatibilityReason(
            cacheDir,
            packaged,
          );
          assert.ok(extraKeysReason);
          assert.match(extraKeysReason.reason, /extra keys \(env\)/);
          const extraKeysResult = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(extraKeysResult.status, "stale-launcher");
          assert.deepEqual(
            JSON.parse(
              await readFile(join(cacheDir, "hooks", "omx-command.json"), "utf-8"),
            ),
            extraKeysLauncher,
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(pkgBase, { recursive: true, force: true });
    }
  });

  it("live-pin does not auto-repair; stale-launcher persists and directory untouched", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-livepin-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);
          await mkdir(dirname(cacheDir), { recursive: true });
          await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
            recursive: true,
          });
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify(
              { command: "/stale/node", argsPrefix: ["/stale/omx.js"] },
              null,
              2,
            ) + "\n",
          );
          await writeFile(join(cacheDir, ".omx-live-pin"), "pinned\n");
          await writeBoundCompletionMarker(cacheDir);
          const before = await readFile(
            join(cacheDir, "hooks", "omx-command.json"),
            "utf-8",
          );
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const r = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /does not exist/);
          const after = await readFile(
            join(cacheDir, "hooks", "omx-command.json"),
            "utf-8",
          );
          assert.equal(after, before);
          assert.equal(existsSync(join(cacheDir, ".omx-live-pin")), true);
          const output = await captureConsoleOutput(async () => {
            await setup({ scope: "user", installMode: "plugin" });
          });
          assert.doesNotMatch(output, /already exposes/);
          assert.match(output, /not safe to use as current/);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("malformed, missing, non-absolute and symlink cases handled", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-edge-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);

          // malformed JSON
          await mkdir(join(cacheDir, "hooks"), { recursive: true });
          await mkdir(join(cacheDir, ".codex-plugin"), { recursive: true });
          await writeFile(
            join(cacheDir, ".codex-plugin", "plugin.json"),
            await readFile(
              join(
                packageRoot,
                "plugins",
                "oh-my-codex",
                ".codex-plugin",
                "plugin.json",
              ),
              "utf-8",
            ),
          );
          await mkdir(join(cacheDir, "skills"), { recursive: true });
          await cp(
            join(packageRoot, "plugins", "oh-my-codex", "hooks", "hooks.json"),
            join(cacheDir, "hooks", "hooks.json"),
          );
          await cp(
            join(
              packageRoot,
              "plugins",
              "oh-my-codex",
              "hooks",
              "codex-native-hook.mjs",
            ),
            join(cacheDir, "hooks", "codex-native-hook.mjs"),
          );
          // need skills for state
          await cp(
            join(packageRoot, "plugins", "oh-my-codex", "skills"),
            join(cacheDir, "skills"),
            { recursive: true },
          );
          await cp(
            join(packageRoot, "plugins", "oh-my-codex", "templates"),
            join(cacheDir, "templates"),
            { recursive: true },
          );
          await cp(
            join(packageRoot, "plugins", "oh-my-codex", ".mcp.json"),
            join(cacheDir, ".mcp.json"),
          );
          await cp(
            join(packageRoot, "plugins", "oh-my-codex", ".app.json"),
            join(cacheDir, ".app.json"),
          );
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            "{ malformed",
            "utf-8",
          );
          await writeBoundCompletionMarker(cacheDir);
          let raw = await readPinnedLauncherRaw(cacheDir);
          assert.match(raw.error!, /malformed/);
          let r = await materializePackagedOmxPluginCache(
            codexHomeDir,
            packaged,
          );
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /malformed/);
          assert.match(
            r.reason!,
            new RegExp(
              PLUGIN_LAUNCHER_RECOVERY_HINT.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              ),
            ),
          );

          // missing launcher
          await rm(join(cacheDir, "hooks", "omx-command.json"), {
            force: true,
          });
          raw = await readPinnedLauncherRaw(cacheDir);
          assert.equal(raw.raw, null);
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /pinned launcher missing/);

          // JSON null
          await writeFile(join(cacheDir, "hooks", "omx-command.json"), "null\n", "utf-8");
          raw = await readPinnedLauncherRaw(cacheDir);
          assert.match(raw.error!, /malformed/);
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /malformed/);
          // must not throw at parsed.command access
          const nullReason = await getPinnedLauncherIncompatibilityReason(cacheDir, packaged);
          assert.ok(nullReason);

          // JSON array
          await writeFile(join(cacheDir, "hooks", "omx-command.json"), "[]\n", "utf-8");
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /malformed/);

          // dead command + live argsPrefix conflict (command validation must still fail-closed)
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify({
              command: "/stale/node",
              argsPrefix: [join(packageRoot, "dist", "cli", "omx.js")],
            }) + "\n",
          );
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /command.*does not exist|command provenance mismatch/);

          // non-absolute target
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify({
              command: process.execPath,
              argsPrefix: ["relative/path/omx.js"],
            }) + "\n",
          );
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          assert.match(r.reason!, /not absolute/);

          // symlink alias: packageRoot canonical alias should be considered live (unchanged)
          const aliasRoot = join(wd, "alias-root");
          await symlink(packageRoot, aliasRoot);
          const aliasLauncherPath = join(aliasRoot, "dist", "cli", "omx.js");
          // aliasLauncherPath canonical should equal packageRoot/dist/cli/omx.js
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify({
              command: process.execPath,
              argsPrefix: [aliasLauncherPath],
            }) + "\n",
          );
          await writeBoundCompletionMarker(cacheDir);
          // ensure file exists via alias
          assert.equal(existsSync(aliasLauncherPath), true);
          const incompat = await getPinnedLauncherIncompatibilityReason(
            cacheDir,
            packaged,
          );
          assert.equal(incompat, null, "symlink alias should be compatible");
          r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(
            r.status,
            "unchanged",
            "symlink alias must remain unchanged (provenance-compatible)",
          );
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor surfaces stale launcher as warn with recovery hint", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-doctor-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);
          await mkdir(dirname(cacheDir), { recursive: true });
          await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, {
            recursive: true,
          });
          await writeFile(
            join(cacheDir, "hooks", "omx-command.json"),
            JSON.stringify(
              { command: "/stale/node", argsPrefix: ["/stale/omx.js"] },
              null,
              2,
            ) + "\n",
          );
          await writeBoundCompletionMarker(cacheDir);
          // Also ensure doctor's expected plugin-scoped check triggers: need config that enables plugin-scoped hooks
          // Minimal config: ensure checkPluginScopedNativeHooks path via doctor() invocation (not just helpers).
          // Instead of full doctor (which checks many things), directly invoke the exported doctor helper via spawning logic:
          // Call doctor() and inspect output; fallback to direct check if doctor output doesn't contain Native hooks detail in minimal fixture.
          // First prove helper still stale
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          const incompat = await getPinnedLauncherIncompatibilityReason(cacheDir, packaged);
          assert.ok(incompat);
          assert.match(incompat!.reason, /omx setup --plugin --repair-plugin-cache/);
          // Persist plugin install mode so doctor resolves plugin-scoped check deterministically
          await mkdir(join(wd, ".omx"), { recursive: true });
          await writeFile(join(wd, ".omx", "setup-scope.json"), JSON.stringify({ scope: "user", installMode: "plugin", mcpMode: "none" }) + "\n", "utf-8");
          // Now invoke actual doctor to prove it surfaces the same warn (not generic hook mismatch)
          // MinimalDoctor invocation: we need to ensure doctor writes its Native hooks check; create a temp cwd with .codex link
          // Easiest: invoke doctor via spawned checkNativeHooks by calling doctor() and capturing console.
          const originalLog = console.log;
          const logs: string[] = [];
          console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
          try {
            // Ensure config signals plugin-scoped hooks: create config.toml with plugin marketplace registration so doctor resolves scope correctly
            const configPath = join(codexHomeDir, "config.toml");
            const { getPackageRoot } = await import("../../utils/package.js");
            const { buildLocalOmxMarketplaceRegistration } = await import("../plugin-marketplace.js");
            let cfg = "plugin_hooks = true\ngoals = true\n";
            cfg = upsertLocalOmxMarketplaceRegistration(cfg, getPackageRoot());
            cfg = upsertLocalOmxPluginEnablement(cfg);
            await writeFile(configPath, cfg, "utf-8");
            // Need hooksPath parent
            await mkdir(join(codexHomeDir, "agents"), { recursive: true });
            await doctor({});
          } catch {
            // doctor may throw? ignore, we inspect logs below
          } finally {
            console.log = originalLog;
          }
          const output = logs.join("\n");
          assert.match(output, /Native hooks/);
          assert.match(output, /incompatible/);
          assert.match(output, /omx setup --plugin --repair-plugin-cache/);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("doctor missing omx-command.json surfaces same actionable stale-launcher warning", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-3558-doctor-missing-"));
    try {
      await withIsolatedUserHome(wd, async (codexHomeDir) => {
        await withTempCwd(wd, async () => {
          const cacheDir = await packagedPluginCacheDir(codexHomeDir);
          await mkdir(dirname(cacheDir), { recursive: true });
          await cp(join(packageRoot, "plugins", "oh-my-codex"), cacheDir, { recursive: true });
          await rm(join(cacheDir, "hooks", "omx-command.json"), { force: true });
          await writeBoundCompletionMarker(cacheDir);
          const packaged = await resolvePackagedOmxMarketplace(packageRoot);
          assert.ok(packaged);
          const incompat = await getPinnedLauncherIncompatibilityReason(cacheDir, packaged);
          assert.ok(incompat);
          assert.match(incompat!.reason, /pinned launcher missing/);
          assert.match(incompat!.reason, /omx setup --plugin --repair-plugin-cache/);
          const r = await materializePackagedOmxPluginCache(codexHomeDir, packaged);
          assert.equal(r.status, "stale-launcher");
          // Invoke doctor and ensure missing launcher goes through stale-launcher warn, not generic "expected plugin hook file is missing" for launcher
          const { getPackageRoot } = await import("../../utils/package.js");
          const { buildLocalOmxMarketplaceRegistration } = await import("../plugin-marketplace.js");
          let cfg2 = "";
            cfg2 = upsertLocalOmxMarketplaceRegistration(cfg2, getPackageRoot());
            cfg2 = upsertLocalOmxPluginEnablement(cfg2);
            cfg2 = "[features]\nplugin_hooks = true\n\n" + cfg2;
            await writeFile(join(codexHomeDir, "config.toml"), cfg2, "utf-8");
          await mkdir(join(codexHomeDir, "agents"), { recursive: true });
          const logs: string[] = [];
          const origLog = console.log;
          console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
          try {
            await doctor({});
          } finally {
            console.log = origLog;
          }
          const output = logs.join("\n");
          assert.match(output, /Native hooks/);
          assert.match(output, /incompatible|cached launcher/);
          assert.match(output, /omx setup --plugin --repair-plugin-cache/);
          assert.match(output, /omx-command\.json|incompatible/);
        });
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
