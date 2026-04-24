import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeUserInstallStamp } from "../../cli/update.js";
import {
  isGlobalInstallLifecycle,
  runPostinstall,
} from "../postinstall.js";

describe("isGlobalInstallLifecycle", () => {
  it("accepts npm_config_global=true", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_global: "true" }), true);
  });

  it("accepts npm_config_location=global", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_location: "global" }), true);
  });

  it("rejects local installs", () => {
    assert.equal(isGlobalInstallLifecycle({ npm_config_global: "false" }), false);
  });
});

describe("runPostinstall", () => {
  it("runs interactive setup only for bumped global installs", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-postinstall-"));
    const stampPath = join(root, ".codex", ".omx", "install-state.json");
    const logs: string[] = [];
    let setupCalls = 0;

    try {
      const result = await runPostinstall({
        env: { npm_config_global: "true" },
        getCurrentVersion: async () => "0.14.1",
        isInteractive: () => true,
        log: (message) => logs.push(message),
        readStamp: async () => ({
          installed_version: "0.14.0",
          setup_completed_version: "0.14.0",
          updated_at: "2026-04-20T00:00:00.000Z",
        }),
        runSetup: async () => {
          setupCalls += 1;
        },
        writeStamp: async (stamp) => writeUserInstallStamp(stamp, stampPath),
      });

      assert.equal(result.status, "setup-ran");
      assert.equal(setupCalls, 1);
      assert.match(logs.join("\n"), /Launching interactive setup/);

      const stamp = JSON.parse(await readFile(stampPath, "utf-8")) as {
        installed_version: string;
        setup_completed_version: string;
      };
      assert.equal(stamp.installed_version, "0.14.1");
      assert.equal(stamp.setup_completed_version, "0.14.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the installed version and prints a hint when no TTY is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "omx-postinstall-"));
    const stampPath = join(root, ".codex", ".omx", "install-state.json");
    const logs: string[] = [];
    let setupCalls = 0;

    try {
      const result = await runPostinstall({
        env: { npm_config_global: "true" },
        getCurrentVersion: async () => "0.14.1",
        isInteractive: () => false,
        log: (message) => logs.push(message),
        readStamp: async () => ({
          installed_version: "0.14.0",
          setup_completed_version: "0.14.0",
          updated_at: "2026-04-20T00:00:00.000Z",
        }),
        runSetup: async () => {
          setupCalls += 1;
        },
        writeStamp: async (stamp) => writeUserInstallStamp(stamp, stampPath),
      });

      assert.equal(result.status, "hinted");
      assert.equal(setupCalls, 0);
      assert.match(logs.join("\n"), /Run `omx setup` \(interactive\) or `omx update`/);

      const stamp = JSON.parse(await readFile(stampPath, "utf-8")) as {
        installed_version: string;
        setup_completed_version: string;
      };
      assert.equal(stamp.installed_version, "0.14.1");
      assert.equal(stamp.setup_completed_version, "0.14.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips local installs", async () => {
    let setupCalls = 0;
    const result = await runPostinstall({
      env: { npm_config_global: "false" },
      getCurrentVersion: async () => "0.14.1",
      isInteractive: () => true,
      runSetup: async () => {
        setupCalls += 1;
      },
    });

    assert.equal(result.status, "noop-local");
    assert.equal(setupCalls, 0);
  });

  it("does not rerun setup when the installed version matches the saved stamp", async () => {
    let setupCalls = 0;
    const result = await runPostinstall({
      env: { npm_config_global: "true" },
      getCurrentVersion: async () => "0.14.1",
      isInteractive: () => true,
      readStamp: async () => ({
        installed_version: "0.14.1",
        setup_completed_version: "0.14.1",
        updated_at: "2026-04-20T00:00:00.000Z",
      }),
      runSetup: async () => {
        setupCalls += 1;
      },
    });

    assert.equal(result.status, "noop-same-version");
    assert.equal(setupCalls, 0);
  });

  it("warns and exits cleanly when setup fails", async () => {
    const warnings: string[] = [];
    const result = await runPostinstall({
      env: { npm_config_global: "true" },
      getCurrentVersion: async () => "0.14.1",
      isInteractive: () => true,
      readStamp: async () => ({
        installed_version: "0.14.0",
        setup_completed_version: "0.14.0",
        updated_at: "2026-04-20T00:00:00.000Z",
      }),
      runSetup: async () => {
        throw new Error("boom");
      },
      warn: (message) => warnings.push(message),
      writeStamp: async () => {},
    });

    assert.equal(result.status, "setup-failed");
    assert.match(warnings.join("\n"), /non-fatal error: boom/);
  });

  it("runs interactive setup from the npm install prefix instead of the package dir or INIT_CWD", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "omx-postinstall-install-root-"));
    const packageRoot = await mkdtemp(join(tmpdir(), "omx-postinstall-package-root-"));
    const initCwd = await mkdtemp(join(tmpdir(), "omx-postinstall-init-cwd-"));
    const originalCwd = process.cwd();
    const scopeFile = join(installRoot, ".omx", "setup-scope.json");
    const packageScopeFile = join(packageRoot, ".omx", "setup-scope.json");
    const initCwdScopeFile = join(initCwd, ".omx", "setup-scope.json");

    try {
      process.chdir(packageRoot);

      const result = await runPostinstall({
        env: {
          npm_config_global: "true",
          npm_config_prefix: installRoot,
          INIT_CWD: initCwd,
        },
        getCurrentVersion: async () => "0.14.1",
        isInteractive: () => true,
        readStamp: async () => ({
          installed_version: "0.14.0",
          setup_completed_version: "0.14.0",
          updated_at: "2026-04-20T00:00:00.000Z",
        }),
        runSetup: async () => {
          await mkdir(join(process.cwd(), ".omx"), { recursive: true });
          await writeFile(
            join(process.cwd(), ".omx", "setup-scope.json"),
            JSON.stringify({ scope: "project" }),
          );
        },
        writeStamp: async () => {},
      });

      assert.equal(result.status, "setup-ran");
      assert.equal(process.cwd(), packageRoot);
      assert.equal(
        JSON.parse(await readFile(scopeFile, "utf-8")).scope,
        "project",
      );
      await assert.rejects(() => readFile(packageScopeFile, "utf-8"));
      await assert.rejects(() => readFile(initCwdScopeFile, "utf-8"));
    } finally {
      process.chdir(originalCwd);
      await rm(installRoot, { recursive: true, force: true });
      await rm(packageRoot, { recursive: true, force: true });
      await rm(initCwd, { recursive: true, force: true });
    }
  });
});
