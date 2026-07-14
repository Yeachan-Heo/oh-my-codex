import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthHotswap, type HotswapLifecycle } from "../hotswap.js";

function sessionPointerAbort(cwd: string): Error {
  return Object.assign(new Error("selected pointer root is unavailable"), {
    name: "SessionPointerLaunchAbort",
    committed: false,
    cwd,
    code: "session_pointer_context_failure",
    operation: "pointer-context-resolve",
    attemptedRootSource: "cwd-default",
    reason: "selected pointer root is unavailable",
  });
}

function lifecycle(overrides: Partial<HotswapLifecycle> = {}): HotswapLifecycle {
  return {
    prepareCodexHomeForLaunch: async () => ({}),
    preLaunch: async () => {},
    postLaunch: async () => {},
    cleanupRuntimeCodexHome: async () => {},
    normalizeCodexLaunchArgs: (args) => args,
    injectModelInstructionsBypassArgs: (_cwd, args) => args,
    sessionModelInstructionsPath: (cwd, sessionId) => join(cwd, `${sessionId}.md`),
    resolveOmxRootForLaunch: () => undefined,
    resolveNotifyTempContract: (args) => ({
      contract: { active: false },
      passthroughArgs: args,
    }),
    ...overrides,
  };
}

async function writeAuthSlot(home: string, slot = "first"): Promise<string> {
  const authDir = join(home, ".omx", "auth");
  const slotPath = join(authDir, `${slot}.json`);
  await mkdir(authDir, { recursive: true });
  await writeFile(slotPath, '{"access_token":"slot-secret"}\n');
  await writeFile(
    join(authDir, "slots.json"),
    JSON.stringify({
      version: 1,
      currentSlot: slot,
      slots: [{ slot, createdAt: "now", updatedAt: "now" }],
    }),
  );
  return slotPath;
}

describe("auth hotswap pointer abort lifecycle", () => {
  it("skips the initial slot mutation and postLaunch for a typed pointer abort", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hotswap-pointer-abort-"));
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const liveAuthPath = join(runtimeHome, "auth.json");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      await writeAuthSlot(home);
      await mkdir(runtimeHome, { recursive: true });
      await writeFile(liveAuthPath, '{"access_token":"live-sentinel"}\n');

      const status = await runAuthHotswap({
        cwd,
        home,
        env: { CODEX_HOME: runtimeHome },
        argv: [],
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            throw sessionPointerAbort(cwd);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(postLaunchCalls, 0);
      assert.equal(cleanupCalls, 1);
      assert.equal(
        await readFile(liveAuthPath, "utf-8"),
        '{"access_token":"live-sentinel"}\n',
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs postLaunch and runtime cleanup after a successful preLaunch then initial useSlot failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hotswap-use-slot-failure-"));
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      const slotPath = await writeAuthSlot(home);

      const status = await runAuthHotswap({
        cwd,
        home,
        env: { CODEX_HOME: runtimeHome },
        argv: [],
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            await rm(slotPath);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(postLaunchCalls, 1);
      assert.equal(cleanupCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs postLaunch and runtime cleanup after a later rotation useSlot failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-hotswap-rotation-use-slot-failure-"));
    const home = join(cwd, "home");
    const runtimeHome = join(cwd, "runtime-codex-home");
    const binDir = join(cwd, "bin");
    const codexLog = join(cwd, "codex.log");
    const secondSlotPath = join(home, ".omx", "auth", "second.json");
    let postLaunchCalls = 0;
    let cleanupCalls = 0;
    try {
      await writeAuthSlot(home);
      await writeFile(secondSlotPath, '{"access_token":"second-secret"}\n');
      await writeFile(
        join(home, ".omx", "auth", "slots.json"),
        JSON.stringify({
          version: 1,
          currentSlot: "first",
          slots: [
            { slot: "first", createdAt: "now", updatedAt: "now" },
            { slot: "second", createdAt: "now", updatedAt: "now" },
          ],
        }),
      );
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(binDir, "codex"),
        `#!/bin/sh\nprintf 'spawned\\n' >> ${JSON.stringify(codexLog)}\necho token_invalidated >&2\nexit 1\n`,
      );
      await chmod(join(binDir, "codex"), 0o755);

      const status = await runAuthHotswap({
        cwd,
        home,
        env: {
          CODEX_HOME: runtimeHome,
          PATH: `${binDir}:/usr/bin:/bin`,
        },
        argv: [],
        lifecycle: lifecycle({
          prepareCodexHomeForLaunch: async () => ({
            codexHomeOverride: runtimeHome,
            runtimeCodexHomeForCleanup: runtimeHome,
          }),
          preLaunch: async () => {
            await rm(secondSlotPath);
          },
          postLaunch: async () => {
            postLaunchCalls += 1;
          },
          cleanupRuntimeCodexHome: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      assert.equal(status, 1);
      assert.equal(await readFile(codexLog, "utf-8"), "spawned\n");
      assert.equal(postLaunchCalls, 1);
      assert.equal(cleanupCalls, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
