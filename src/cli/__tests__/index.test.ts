import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir as fsReaddir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import {
  HELP,
  normalizeCodexLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxPaneCommand,
  buildWindowsPromptCommand,
  buildTmuxSessionName,
  resolveCliInvocation,
  commandOwnsLocalHelp,
  resolveCodexLaunchPolicy,
  resolveEffectiveLeaderLaunchPolicyOverride,
  resolveEnvLaunchPolicyOverride,
  resolveLeaderLaunchPolicyOverride,
  classifyCodexExecFailure,
  resolveSignalExitCode,
  parseTmuxPaneSnapshot,
  findHudWatchPaneIds,
  buildHudPaneCleanupTargets,
  readTopLevelTomlString,
  upsertTopLevelTomlString,
  collectInheritableTeamWorkerArgs,
  resolveTeamWorkerLaunchArgsEnv,
  injectModelInstructionsBypassArgs,
  resolveWorkerSparkModel,
  resolveSetupInstallModeArg,
  resolveSetupScopeArg,
  readPersistedSetupPreferences,
  readPersistedSetupScope,
  resolveCodexConfigPathForLaunch,
  resolveCodexHomeForLaunch,
  resolveProjectLocalCodexHomeForLaunch,
  prepareCodexHomeForLaunch,
  runtimeCodexHomePath,
  buildDetachedSessionBootstrapSteps,
  buildDetachedTmuxSessionName,
  buildDetachedSessionFinalizeSteps,
  buildDetachedSessionRollbackSteps,
  detectDetachedSessionWindowIndex,
  resolveNotifyTempContract,
  buildNotifyTempStartupMessages,
  buildNotifyFallbackWatcherEnv,
  shouldEnableNotifyFallbackWatcher,
  reapStaleNotifyFallbackWatcher,
  cleanupLaunchOrphanedMcpProcesses,
  reapPostLaunchOrphanedMcpProcesses,
  cleanupPostLaunchModeStateFiles,
  resolveBackgroundHelperLaunchMode,
  shouldDetachBackgroundHelper,
  resolveNotifyFallbackWatcherScript,
  resolveHookDerivedWatcherScript,
  resolveNotifyHookScript,
  buildDetachedWindowsBootstrapScript,
  acquireTmuxExtendedKeysLease,
  resolveNativeSessionName,
  releaseTmuxExtendedKeysLease,
  withTmuxExtendedKeys,
} from "../index.js";
import { ensureReusableNodeModules } from "../../utils/repo-deps.js";
import { readAllState } from "../../hud/state.js";
import { generateOverlay } from "../../hooks/agents-overlay.js";
import { HUD_TMUX_HEIGHT_LINES } from "../../hud/constants.js";
import { createHudWatchPane as createSharedHudWatchPane, listCurrentWindowHudPaneIds } from "../../hud/tmux.js";
import {
  DEFAULT_FRONTIER_MODEL,
  getTeamLowComplexityModel,
} from "../../config/models.js";
import type { ProcessEntry } from "../cleanup.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..", "..");

function normalizeDarwinTmpPath(value: string): string {
  return process.platform === "darwin" ? value.replaceAll("/private/var/", "/var/") : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectedLowComplexityModel(codexHomeOverride?: string): string {
  return getTeamLowComplexityModel(codexHomeOverride);
}

afterEach(() => {
  mock.restoreAll();
});

describe("normalizeCodexLaunchArgs", () => {
  it("maps --madmax to codex bypass flag", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax"]), [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("does not forward --madmax and preserves other args", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(["--model", "gpt-5", "--madmax", "--yolo"]),
      [
        "--model",
        "gpt-5",
        "--yolo",
        "--dangerously-bypass-approvals-and-sandbox",
      ],
    );
  });

  it("avoids duplicate bypass flags when both are present", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "--dangerously-bypass-approvals-and-sandbox",
        "--madmax",
      ]),
      ["--dangerously-bypass-approvals-and-sandbox"],
    );
  });

  it("deduplicates repeated bypass-related flags", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs([
        "--madmax",
        "--dangerously-bypass-approvals-and-sandbox",
        "--madmax",
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
      ["--dangerously-bypass-approvals-and-sandbox"],
    );
  });

  it("leaves unrelated args unchanged", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--model", "gpt-5", "--yolo"]), [
      "--model",
      "gpt-5",
      "--yolo",
    ]);
  });

  it("maps --high to reasoning override", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--high"]), [
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("maps --xhigh to reasoning override", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--xhigh"]), [
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("uses the last reasoning shorthand when both are present", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--high", "--xhigh"]), [
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("maps --xhigh --madmax to codex-native flags only", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--xhigh", "--madmax"]), [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="xhigh"',
    ]);
  });

  it("--spark is stripped from leader args (model goes to workers only)", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--spark", "--yolo"]), [
      "--yolo",
    ]);
  });

  it("--spark alone produces no leader args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--spark"]), []);
  });

  it("--madmax-spark adds bypass flag to leader args and is otherwise consumed", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax-spark"]), [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("--madmax-spark deduplicates bypass when --madmax also present", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--madmax", "--madmax-spark"]), [
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("--madmax-spark does not inject spark model into leader args", () => {
    const args = normalizeCodexLaunchArgs(["--madmax-spark"]);
    assert.ok(
      !args.includes("--model"),
      "leader args must not contain --model from --madmax-spark",
    );
    assert.ok(
      !args.some((a) => a.includes("spark")),
      "leader args must not reference spark model",
    );
  });

  it("strips detached worktree flag from leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--worktree", "--yolo"]), [
      "--yolo",
    ]);
  });

  it("strips named worktree flag from leader codex args", () => {
    assert.deepEqual(
      normalizeCodexLaunchArgs(["--worktree=feature/demo", "--model", "gpt-5"]),
      ["--model", "gpt-5"],
    );
  });

  it("does not forward notify-temp flags/selectors to leader codex args", () => {
    const parsed = resolveNotifyTempContract(
      [
        "--notify-temp",
        "--discord",
        "--custom",
        "openclaw:ops",
        "--custom=my-hook",
        "--model",
        "gpt-5",
      ],
      {},
    );
    assert.deepEqual(normalizeCodexLaunchArgs(parsed.passthroughArgs), [
      "--model",
      "gpt-5",
    ]);
  });

  it("strips --tmux from leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--tmux", "--yolo"]), [
      "--yolo",
    ]);
  });

  it("strips --direct from leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--direct", "--yolo"]), [
      "--yolo",
    ]);
  });

  it("preserves literal --tmux after -- in leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--", "--tmux", "--yolo"]), [
      "--",
      "--tmux",
      "--yolo",
    ]);
  });

  it("preserves literal --direct after -- in leader codex args", () => {
    assert.deepEqual(normalizeCodexLaunchArgs(["--", "--direct", "--yolo"]), [
      "--",
      "--direct",
      "--yolo",
    ]);
  });
});

describe("resolveLeaderLaunchPolicyOverride", () => {
  it("detects explicit detached tmux launch requests", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--tmux", "--model", "gpt-5"]),
      "detached-tmux",
    );
  });

  it("detects explicit direct launch requests", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--direct", "--model", "gpt-5"]),
      "direct",
    );
  });

  it("uses the last CLI launch policy flag before --", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--direct", "--tmux"]),
      "detached-tmux",
    );
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--tmux", "--direct"]),
      "direct",
    );
  });

  it("returns undefined when no explicit policy override is present", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--model", "gpt-5"]),
      undefined,
    );
  });

  it("stops scanning for --tmux after the end-of-options marker", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--", "--tmux", "--model", "gpt-5"]),
      undefined,
    );
  });

  it("stops scanning for --direct after the end-of-options marker", () => {
    assert.equal(
      resolveLeaderLaunchPolicyOverride(["--", "--direct", "--model", "gpt-5"]),
      undefined,
    );
  });
});

describe("resolveEnvLaunchPolicyOverride", () => {
  it("accepts direct, tmux, detached-tmux, auto, and empty policy values", () => {
    assert.equal(resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "direct" }), "direct");
    assert.equal(
      resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "tmux" }),
      "detached-tmux",
    );
    assert.equal(
      resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "detached-tmux" }),
      "detached-tmux",
    );
    assert.equal(resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "auto" }), undefined);
    assert.equal(resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "" }), undefined);
  });

  it("warns once for invalid OMX_LAUNCH_POLICY and falls back to auto", () => {
    const warn = mock.method(console, "warn", () => {});
    assert.equal(
      resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "banana" }),
      undefined,
    );
    assert.equal(
      resolveEnvLaunchPolicyOverride({ OMX_LAUNCH_POLICY: "banana" }),
      undefined,
    );
    assert.equal(warn.mock.callCount(), 1);
  });
});

describe("resolveEffectiveLeaderLaunchPolicyOverride", () => {
  it("uses env policy when no CLI policy flag is present", () => {
    assert.equal(
      resolveEffectiveLeaderLaunchPolicyOverride(["--yolo"], {
        OMX_LAUNCH_POLICY: "direct",
      }),
      "direct",
    );
  });

  it("lets CLI policy flags override OMX_LAUNCH_POLICY", () => {
    assert.equal(
      resolveEffectiveLeaderLaunchPolicyOverride(["--tmux", "--yolo"], {
        OMX_LAUNCH_POLICY: "direct",
      }),
      "detached-tmux",
    );
    assert.equal(
      resolveEffectiveLeaderLaunchPolicyOverride(["--direct", "--yolo"], {
        OMX_LAUNCH_POLICY: "tmux",
      }),
      "direct",
    );
  });
});

describe("resolveNotifyTempContract", () => {
  it("activates from --notify-temp with no providers", () => {
    const parsed = resolveNotifyTempContract(
      ["--notify-temp", "--model", "gpt-5"],
      {},
    );
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "cli");
    assert.deepEqual(parsed.contract.canonicalSelectors, []);
    assert.deepEqual(parsed.passthroughArgs, ["--model", "gpt-5"]);
  });

  it("auto-activates when provider selectors are present", () => {
    const parsed = resolveNotifyTempContract(["--discord", "--slack"], {});
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "providers");
    assert.deepEqual(parsed.contract.canonicalSelectors, ["discord", "slack"]);
    assert.equal(
      parsed.contract.warnings.some((line) => line.includes("imply temp mode")),
      true,
    );
  });

  it("supports repeated --custom forms and canonicalizes selectors", () => {
    const parsed = resolveNotifyTempContract(
      ["--custom", "OpenClaw:Ops", "--custom=my-hook", "--custom=", "--custom"],
      {},
    );
    assert.deepEqual(parsed.contract.canonicalSelectors, [
      "openclaw:ops",
      "custom:my-hook",
    ]);
    assert.equal(parsed.contract.warnings.length >= 1, true);
  });

  it("activates from OMX_NOTIFY_TEMP=1 env parity", () => {
    const parsed = resolveNotifyTempContract(["--model", "gpt-5"], {
      OMX_NOTIFY_TEMP: "1",
    });
    assert.equal(parsed.contract.active, true);
    assert.equal(parsed.contract.source, "env");
    assert.deepEqual(parsed.passthroughArgs, ["--model", "gpt-5"]);
  });
});

describe("cleanupLaunchOrphanedMcpProcesses", () => {
  it("reaps only detached OMX MCP processes without a live Codex ancestor", async () => {
    const processes: ProcessEntry[] = [
      { pid: 700, ppid: 500, command: "codex" },
      { pid: 701, ppid: 700, command: "node /repo/bin/omx.js" },
      {
        pid: 710,
        ppid: 700,
        command: "node /repo/oh-my-codex/dist/mcp/state-server.js",
      },
      {
        pid: 800,
        ppid: 1,
        command: "node /tmp/oh-my-codex/dist/mcp/memory-server.js",
      },
      {
        pid: 810,
        ppid: 42,
        command: "node /tmp/oh-my-codex/dist/mcp/trace-server.js",
      },
      {
        pid: 820,
        ppid: 50,
        command: "codex --model gpt-5",
      },
      {
        pid: 821,
        ppid: 820,
        command: "node /tmp/other-session/dist/mcp/state-server.js",
      },
      {
        pid: 830,
        ppid: 50,
        command: "node /repo/bin/omx.js autoresearch --topic launch",
      },
      {
        pid: 831,
        ppid: 830,
        command: "node /tmp/parallel-session/dist/mcp/memory-server.js",
      },
    ];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const alive = new Set([800, 810]);

    const result = await cleanupLaunchOrphanedMcpProcesses({
      currentPid: 701,
      listProcesses: () => processes,
      isPidAlive: (pid) => alive.has(pid),
      sendSignal: (pid, signal) => {
        signals.push({ pid, signal });
        alive.delete(pid);
      },
      sleep: async () => {},
      now: () => 0,
    });

    assert.equal(result.terminatedCount, 2);
    assert.equal(result.forceKilledCount, 0);
    assert.deepEqual(result.failedPids, []);
    assert.deepEqual(signals, [
      { pid: 800, signal: "SIGTERM" },
      { pid: 810, signal: "SIGTERM" },
    ]);
    assert.equal(
      signals.some(({ pid }) => pid === 821),
      false,
      "launch-safe cleanup must preserve OMX MCP processes still attached to another live Codex tree",
    );
    assert.equal(
      signals.some(({ pid }) => pid === 831),
      false,
      "launch-safe cleanup must preserve OMX MCP processes still attached to another live OMX launch tree",
    );
  });
});

describe("reapPostLaunchOrphanedMcpProcesses", () => {
  it("logs postLaunch reaped MCP orphans and keeps cleanup non-fatal", async () => {
    const info: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    await reapPostLaunchOrphanedMcpProcesses({
      cleanup: async () => ({
        dryRun: false,
        candidates: [],
        terminatedCount: 2,
        forceKilledCount: 0,
        failedPids: [810],
      }),
      writeInfo: (line) => info.push(line),
      writeWarn: (line) => warnings.push(line),
      writeError: (line) => errors.push(line),
    });

    assert.deepEqual(errors, []);
    assert.match(
      info.join("\n"),
      /postLaunch: reaped 2 orphaned OMX MCP process/,
    );
    assert.match(
      warnings.join("\n"),
      /postLaunch: failed to reap 1 orphaned OMX MCP process/,
    );
  });

  it("writes a non-fatal postLaunch cleanup error when the cleanup step throws", async () => {
    const errors: string[] = [];

    await reapPostLaunchOrphanedMcpProcesses({
      cleanup: async () => {
        throw new Error("boom");
      },
      writeError: (line) => errors.push(line),
    });

    assert.match(errors.join("\n"), /postLaunch MCP cleanup failed: Error: boom/);
  });
});

describe("cleanupPostLaunchModeStateFiles", () => {
  it("repairs empty or truncated mode state files and still cancels valid siblings", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-postlaunch-mode-cleanup-"));
    const sessionId = "sess-postlaunch-cleanup";
    const stateDir = join(wd, ".omx", "state");
    const sessionStateDir = join(stateDir, "sessions", sessionId);
    const partialState = '{\n  "active": true,\n  "mode": "ralph",\n';
    const warnings: string[] = [];

    await mkdir(sessionStateDir, { recursive: true });
    await writeFile(
      join(stateDir, "autopilot-state.json"),
      JSON.stringify({ active: true, mode: "autopilot" }, null, 2),
      "utf-8",
    );
    await writeFile(join(stateDir, "deep-interview-state.json"), "", "utf-8");
    await writeFile(join(sessionStateDir, "ralph-state.json"), partialState, "utf-8");

    await cleanupPostLaunchModeStateFiles(wd, sessionId, {
      writeWarn: (line) => warnings.push(line),
    });

    const autopilot = JSON.parse(
      await readFile(join(stateDir, "autopilot-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    const deepInterview = JSON.parse(
      await readFile(join(stateDir, "deep-interview-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    const ralph = JSON.parse(
      await readFile(join(sessionStateDir, "ralph-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(autopilot.active, false);
    assert.equal(typeof autopilot.completed_at, "string");
    assert.equal(deepInterview.active, false);
    assert.equal(deepInterview.mode, "deep-interview");
    assert.equal(deepInterview.current_phase, "cancelled");
    assert.equal(typeof deepInterview.completed_at, "string");
    assert.equal(typeof deepInterview.last_turn_at, "string");
    assert.equal(ralph.active, false);
    assert.equal(ralph.mode, "ralph");
    assert.equal(ralph.current_phase, "cancelled");
    assert.equal(typeof ralph.completed_at, "string");
    assert.equal(typeof ralph.last_turn_at, "string");
    const rootCanonicalPath = join(stateDir, "skill-active-state.json");
    const sessionCanonicalPath = join(sessionStateDir, "skill-active-state.json");
    if (existsSync(rootCanonicalPath)) {
      const rootCanonical = JSON.parse(
        await readFile(rootCanonicalPath, "utf-8"),
      ) as Record<string, unknown>;
      assert.equal(rootCanonical.active, false);
      assert.deepEqual(rootCanonical.active_skills, []);
    }
    if (existsSync(sessionCanonicalPath)) {
      const sessionCanonical = JSON.parse(
        await readFile(sessionCanonicalPath, "utf-8"),
      ) as Record<string, unknown>;
      assert.equal(sessionCanonical.active, false);
      assert.deepEqual(sessionCanonical.active_skills, []);
    }
    assert.deepEqual(warnings, []);
  });

  it("retries a transient parse failure before cancelling the rewritten mode state", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-postlaunch-mode-retry-"));
    const sessionId = "sess-postlaunch-retry";
    const stateDir = join(wd, ".omx", "state");
    const statePath = join(stateDir, "ralph-state.json");
    const writes: Array<{ path: string; content: string }> = [];
    const validState = JSON.stringify({ active: true, mode: "ralph" }, null, 2);
    let reads = 0;

    await mkdir(stateDir, { recursive: true });

    const mockReaddir = (async (dir: unknown, _options: unknown) => (
      String(dir) === stateDir ? ["ralph-state.json"] : []
    )) as unknown as typeof fsReaddir;
    const mockReadFile = (async (path: unknown, _options: unknown) => {
        assert.equal(String(path), statePath);
        reads += 1;
        return reads === 1
          ? '{\n  "active": true,\n  "mode": "ralph"'
          : validState;
      }) as unknown as typeof readFile;
    const mockWriteFile = (async (path: unknown, content: unknown, _options: unknown) => {
        writes.push({ path: String(path), content: String(content) });
      }) as unknown as typeof writeFile;

    const dependencies: Parameters<typeof cleanupPostLaunchModeStateFiles>[2] = {
      readdir: mockReaddir,
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      sleep: async () => {},
      now: () => new Date("2026-04-07T00:00:00.000Z"),
    };

    await cleanupPostLaunchModeStateFiles(wd, sessionId, dependencies);

    assert.equal(reads, 2);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, statePath);
    const persisted = JSON.parse(writes[0]?.content ?? "{}") as Record<string, unknown>;
    assert.equal(persisted.active, false);
    assert.equal(persisted.completed_at, "2026-04-07T00:00:00.000Z");
  });

  it("warns on structurally complete malformed JSON without aborting sibling cleanup", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-postlaunch-mode-malformed-"));
    const sessionId = "sess-postlaunch-malformed";
    const stateDir = join(wd, ".omx", "state");
    const warnings: string[] = [];
    const malformedState = '{\n  "active": true,\n}\n';

    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "ralph-state.json"), malformedState, "utf-8");
    await writeFile(
      join(stateDir, "ultrawork-state.json"),
      JSON.stringify({ active: true, mode: "ultrawork" }, null, 2),
      "utf-8",
    );

    await cleanupPostLaunchModeStateFiles(wd, sessionId, {
      writeWarn: (line) => warnings.push(line),
    });

    const ultrawork = JSON.parse(
      await readFile(join(stateDir, "ultrawork-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(ultrawork.active, false);
    assert.equal(typeof ultrawork.completed_at, "string");
    const canonicalPath = join(stateDir, "skill-active-state.json");
    if (existsSync(canonicalPath)) {
      const canonical = JSON.parse(
        await readFile(canonicalPath, "utf-8"),
      ) as Record<string, unknown>;
      assert.equal(canonical.active, false);
      assert.deepEqual(canonical.active_skills, []);
    }
    assert.equal(await readFile(join(stateDir, "ralph-state.json"), "utf-8"), malformedState);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /skipped malformed mode state .*ralph-state\.json/);
  });

  it("clears canonical skill-active entries during cleanup and hides them from HUD/overlay readers", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-postlaunch-skill-active-cleanup-"));
    const sessionId = "sess-skill-active-cleanup";
    const stateDir = join(wd, ".omx", "state");
    const sessionStateDir = join(stateDir, "sessions", sessionId);

    await mkdir(sessionStateDir, { recursive: true });
    await writeFile(join(stateDir, "session.json"), JSON.stringify({ session_id: sessionId }), "utf-8");
    await writeFile(
      join(sessionStateDir, "skill-active-state.json"),
      JSON.stringify({
        version: 1,
        active: true,
        skill: "autoresearch",
        phase: "running",
        session_id: sessionId,
        active_skills: [
          { skill: "autoresearch", phase: "running", active: true, session_id: sessionId },
        ],
      }, null, 2),
      "utf-8",
    );

    await cleanupPostLaunchModeStateFiles(wd, sessionId);

    const canonical = JSON.parse(
      await readFile(join(sessionStateDir, "skill-active-state.json"), "utf-8"),
    ) as Record<string, unknown>;
    assert.equal(canonical.active, false);
    assert.equal(canonical.phase, "complete");
    assert.deepEqual(canonical.active_skills, []);

    const hudState = await readAllState(wd);
    assert.equal(hudState.autoresearch, null);

    const overlay = await generateOverlay(wd, sessionId);
    assert.equal(overlay.includes("- autoresearch:"), false);
  });
});

describe("watcher script path resolution", () => {
  it("resolves packaged watcher entrypoints from dist/scripts", () => {
    assert.equal(
      resolveNotifyFallbackWatcherScript("/pkg"),
      "/pkg/dist/scripts/notify-fallback-watcher.js",
    );
    assert.equal(
      resolveHookDerivedWatcherScript("/pkg"),
      "/pkg/dist/scripts/hook-derived-watcher.js",
    );
    assert.equal(
      resolveNotifyHookScript("/pkg"),
      "/pkg/dist/scripts/notify-hook.js",
    );
  });
});

describe("buildNotifyFallbackWatcherEnv", () => {
  it("enables watcher authority and propagates CODEX_HOME override when requested", () => {
    const env = buildNotifyFallbackWatcherEnv(
      { HOME: "/tmp/home", OMX_HUD_AUTHORITY: "0", TMUX: "sock,1,0", TMUX_PANE: "%2" },
      { codexHomeOverride: "/tmp/codex-home", enableAuthority: true },
    );
    assert.equal(env.OMX_HUD_AUTHORITY, "1");
    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });

  it("disables watcher authority explicitly when not requested", () => {
    const env = buildNotifyFallbackWatcherEnv(
      { HOME: "/tmp/home", OMX_HUD_AUTHORITY: "1", TMUX: "sock,1,0", TMUX_PANE: "%3" },
      { enableAuthority: false },
    );
    assert.equal(env.OMX_HUD_AUTHORITY, "0");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });
});

describe("shouldEnableNotifyFallbackWatcher", () => {
  it("keeps notify fallback enabled by default on non-Windows hosts", () => {
    assert.equal(shouldEnableNotifyFallbackWatcher({}, "linux"), true);
  });

  it("disables notify fallback explicitly on non-Windows hosts", () => {
    assert.equal(
      shouldEnableNotifyFallbackWatcher({ OMX_NOTIFY_FALLBACK: "0" }, "linux"),
      false,
    );
  });

  it("disables notify fallback by default on win32", () => {
    assert.equal(shouldEnableNotifyFallbackWatcher({}, "win32"), false);
  });

  it("allows explicit opt-in for notify fallback on win32", () => {
    assert.equal(
      shouldEnableNotifyFallbackWatcher({ OMX_NOTIFY_FALLBACK: "1" }, "win32"),
      true,
    );
  });
});

describe("reapStaleNotifyFallbackWatcher", () => {
  it("stops an existing watcher even when a later startup gate would skip relaunch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-stale-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      await writeFile(
        pidPath,
        JSON.stringify({ pid: 4321, started_at: "2026-04-05T00:00:00.000Z" }),
        "utf-8",
      );
      const killed: Array<{ pid: number; signal?: NodeJS.Signals }> = [];

      await reapStaleNotifyFallbackWatcher(pidPath, {
        isWatcherProcess: () => true,
        tryKillPid(pid, signal) {
          killed.push({ pid, signal });
          return true;
        },
      });

      assert.deepEqual(killed, [{ pid: 4321, signal: "SIGTERM" }]);
      assert.equal(shouldEnableNotifyFallbackWatcher({}, "win32"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores missing pid files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-missing-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      let killCalls = 0;

      await reapStaleNotifyFallbackWatcher(pidPath, {
        tryKillPid() {
          killCalls += 1;
          return true;
        },
      });

      assert.equal(killCalls, 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses ESRCH cleanup errors but warns on unexpected failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-esrch-notify-fallback-"));
    try {
      const pidPath = join(cwd, "notify-fallback.pid");
      await writeFile(pidPath, JSON.stringify({ pid: 99 }), "utf-8");

      const warnings: Array<{ message: unknown; meta: unknown }> = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        readFile: async () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
        warn(message, meta) {
          warnings.push({ message, meta });
        },
      });
      assert.deepEqual(warnings, []);

      const warned: Array<{ message: unknown; meta: unknown }> = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        readFile: async (path, encoding) => readFile(path, encoding),
        isWatcherProcess: () => true,
        tryKillPid() {
          throw new Error("permission denied");
        },
        warn(message, meta) {
          warned.push({ message, meta });
        },
      });
      assert.equal(warned.length, 1);
      assert.equal(warned[0]?.message, "[omx] warning: failed to stop stale notify fallback watcher");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("buildNotifyTempStartupMessages", () => {
  it("always emits summary when temp mode is active", () => {
    const result = buildNotifyTempStartupMessages(
      {
        active: true,
        selectors: ["discord"],
        canonicalSelectors: ["discord"],
        warnings: [],
        source: "cli",
      },
      true,
    );
    assert.deepEqual(result.infoLines, [
      "notify temp: active | providers=discord | persistent-routing=bypassed",
    ]);
    assert.deepEqual(result.warningLines, []);
  });

  it("emits no-valid-provider warning when no provider is configured", () => {
    const result = buildNotifyTempStartupMessages(
      {
        active: true,
        selectors: [],
        canonicalSelectors: [],
        warnings: [
          "notify temp: provider selectors imply temp mode (auto-activated)",
        ],
        source: "providers",
      },
      false,
    );
    assert.equal(
      result.warningLines.includes(
        "notify temp: no valid providers resolved; notifications skipped",
      ),
      true,
    );
  });
});

describe("resolveWorkerSparkModel", () => {
  it("returns spark model string when --spark is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--spark", "--yolo"]),
      expectedLowComplexityModel(),
    );
  });

  it("returns spark model string when --madmax-spark is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--madmax-spark"]),
      expectedLowComplexityModel(),
    );
  });

  it("returns undefined when neither spark flag is present", () => {
    assert.equal(
      resolveWorkerSparkModel(["--madmax", "--yolo", "--model", "gpt-5"]),
      undefined,
    );
  });

  it("returns undefined for empty args", () => {
    assert.equal(resolveWorkerSparkModel([]), undefined);
  });

  it("reads low-complexity team model from config when codexHomeOverride is provided", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "omx-codex-home-"));
    try {
      await writeFile(
        join(codexHome, ".omx-config.json"),
        JSON.stringify({ models: { team_low_complexity: "gpt-4.1-mini" } }),
      );
      assert.equal(
        resolveWorkerSparkModel(["--spark"], codexHome),
        "gpt-4.1-mini",
      );
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("resolveTeamWorkerLaunchArgsEnv (spark)", () => {
  it("injects spark model as worker default when no explicit env model", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        undefined,
        [],
        true,
        expectedLowComplexityModel(),
      ),
      `--model ${expectedLowComplexityModel()}`,
    );
  });

  it("explicit env model overrides spark default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--model gpt-5",
        [],
        true,
        expectedLowComplexityModel(),
      ),
      "--model gpt-5",
    );
  });

  it("inherited leader model overrides spark default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        undefined,
        ["--model", "gpt-4.1"],
        true,
        expectedLowComplexityModel(),
      ),
      "--model gpt-4.1",
    );
  });
});

describe("commandOwnsLocalHelp", () => {
  it("returns true for nested commands that render their own help output", () => {
    for (const command of [
      "adapt",
      "agents-init",
      "ask",
      "question",
      "autoresearch",
      "deepinit",
      "hooks",
      "hud",
      "ralph",
      "resume",
      "session",
      "sparkshell",
      "team",
      "tmux-hook",
    ]) {
      assert.equal(
        commandOwnsLocalHelp(command),
        true,
        `expected ${command} to own local help`,
      );
    }
  });

  it("returns false for top-level help-only commands", () => {
    for (const command of ["help", "launch", "version", "update"]) {
      assert.equal(
        commandOwnsLocalHelp(command),
        false,
        `expected ${command} to use top-level help`,
      );
    }
  });
});

describe("resolveCliInvocation", () => {
  it("resolves explore to explore command", () => {
    assert.deepEqual(
      resolveCliInvocation(["explore", "--prompt", "find", "auth"]),
      {
        command: "explore",
        launchArgs: [],
      },
    );
  });

  it("resolves ask to ask command", () => {
    assert.deepEqual(resolveCliInvocation(["ask", "claude", "hello"]), {
      command: "ask",
      launchArgs: [],
    });
  });

  it("resolves question to question command", () => {
    assert.deepEqual(resolveCliInvocation(["question", "--input", "{}"]), {
      command: "question",
      launchArgs: [],
    });
  });

  it("resolves autoresearch to autoresearch command", () => {
    assert.deepEqual(resolveCliInvocation(["autoresearch", "missions/demo"]), {
      command: "autoresearch",
      launchArgs: [],
    });
  });

  it("resolves session to session command", () => {
    assert.deepEqual(
      resolveCliInvocation(["session", "search", "startup evidence"]),
      {
        command: "session",
        launchArgs: [],
      },
    );
  });

  it("resolves resume to resume command and forwards trailing args", () => {
    assert.deepEqual(resolveCliInvocation(["resume", "--last"]), {
      command: "resume",
      launchArgs: ["--last"],
    });
  });

  it("resolves resume session id and prompt as forwarded args", () => {
    assert.deepEqual(
      resolveCliInvocation(["resume", "session-123", "continue here"]),
      {
        command: "resume",
        launchArgs: ["session-123", "continue here"],
      },
    );
  });

  it("resolves exec to non-interactive launch passthrough and forwards trailing args", () => {
    assert.deepEqual(
      resolveCliInvocation(["exec", "--model", "gpt-5", "say hi"]),
      {
        command: "exec",
        launchArgs: ["--model", "gpt-5", "say hi"],
      },
    );
  });

  it("resolves update to update command", () => {
    assert.deepEqual(resolveCliInvocation(["update"]), {
      command: "update",
      launchArgs: [],
    });
  });

  it("resolves hooks to hooks command", () => {
    assert.deepEqual(resolveCliInvocation(["hooks"]), {
      command: "hooks",
      launchArgs: [],
    });
  });

  it("resolves agents-init to agents-init command", () => {
    assert.deepEqual(resolveCliInvocation(["agents-init", "."]), {
      command: "agents-init",
      launchArgs: [],
    });
  });

  it("resolves deepinit to deepinit alias command", () => {
    assert.deepEqual(resolveCliInvocation(["deepinit", "src"]), {
      command: "deepinit",
      launchArgs: [],
    });
  });

  it("resolves --help to the help command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["--help"]), {
      command: "help",
      launchArgs: [],
    });
  });

  it("resolves --version to the version command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["--version"]), {
      command: "version",
      launchArgs: [],
    });
  });

  it("resolves -v to the version command instead of launch", () => {
    assert.deepEqual(resolveCliInvocation(["-v"]), {
      command: "version",
      launchArgs: [],
    });
  });

  it("keeps unknown long flags as launch passthrough args", () => {
    assert.deepEqual(resolveCliInvocation(["--model", "gpt-5"]), {
      command: "launch",
      launchArgs: ["--model", "gpt-5"],
    });
  });

  it("advertises the explicit update command in top-level help", () => {
    assert.match(HELP, /omx update\s+Check npm now, update the global install immediately, then refresh setup/);
  });

  it("advertises direct launch policy controls in top-level help", () => {
    assert.match(HELP, /--direct\s+Launch the interactive leader directly/);
    assert.match(HELP, /OMX_LAUNCH_POLICY=direct\|tmux\|detached-tmux\|auto/);
    assert.match(HELP, /unset OMX_LAUNCH_POLICY/);
    assert.match(HELP, /omx --direct --yolo/);
    assert.match(HELP, /OMX_LAUNCH_POLICY=direct omx --tmux --yolo/);
    assert.match(HELP, /Config files are intentionally not used/);
  });
});

describe("resolveSetupInstallModeArg", () => {
  it("maps explicit setup install mode flags", () => {
    assert.equal(resolveSetupInstallModeArg(["--dry-run"]), undefined);
    assert.equal(resolveSetupInstallModeArg(["--plugin"]), "plugin");
    assert.equal(resolveSetupInstallModeArg(["--legacy"]), "legacy");
    assert.equal(
      resolveSetupInstallModeArg(["--install-mode", "legacy"]),
      "legacy",
    );
    assert.equal(
      resolveSetupInstallModeArg(["--install-mode=plugin"]),
      "plugin",
    );
    assert.equal(
      resolveSetupInstallModeArg(["--scope", "project", "--plugin"]),
      "plugin",
    );
  });

  it("rejects invalid setup install mode flags", () => {
    assert.throws(
      () => resolveSetupInstallModeArg(["--install-mode"]),
      /Missing setup install mode value after --install-mode/,
    );
    assert.throws(
      () => resolveSetupInstallModeArg(["--install-mode", "workspace"]),
      /Invalid setup install mode: workspace/,
    );
    assert.throws(
      () => resolveSetupInstallModeArg(["--plugin", "--legacy"]),
      /Conflicting setup install mode flags/,
    );
    assert.throws(
      () => resolveSetupInstallModeArg(["--plugin", "--install-mode", "legacy"]),
      /Conflicting setup install mode flags/,
    );
    assert.throws(
      () => resolveSetupInstallModeArg(["--legacy", "--install-mode=plugin"]),
      /Conflicting setup install mode flags/,
    );
  });
});

describe("resolveSetupScopeArg", () => {
  it("returns undefined when scope is omitted", () => {
    assert.equal(resolveSetupScopeArg(["--dry-run"]), undefined);
  });

  it("parses --scope <value> form", () => {
    assert.equal(
      resolveSetupScopeArg(["--dry-run", "--scope", "project"]),
      "project",
    );
  });

  it("parses --scope=<value> form", () => {
    assert.equal(resolveSetupScopeArg(["--scope=project"]), "project");
  });

  it("throws on invalid scope value", () => {
    assert.throws(
      () => resolveSetupScopeArg(["--scope", "workspace"]),
      /Invalid setup scope: workspace/,
    );
  });

  it("throws when --scope value is missing", () => {
    assert.throws(
      () => resolveSetupScopeArg(["--scope"]),
      /Missing setup scope value after --scope/,
    );
  });
});
describe("project launch scope helpers", () => {
  it("reads persisted setup scope when valid", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(readPersistedSetupScope(wd), "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("reads persisted setup preferences when install mode is present", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "user", installMode: "plugin" }),
      );
      assert.deepEqual(readPersistedSetupPreferences(wd), {
        scope: "user",
        installMode: "plugin",
      });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("ignores malformed persisted setup scope", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(join(wd, ".omx", "setup-scope.json"), "{not-json");
      assert.equal(readPersistedSetupScope(wd), undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project CODEX_HOME when persisted scope is project", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}), join(wd, ".codex"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project CODEX_HOME when persisted scope is project even if HOME is unusable", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      const badHome = join(wd, "home-as-file");
      await writeFile(badHome, "not-a-directory");
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, { HOME: badHome }), join(wd, ".codex"));
      assert.equal(
        resolveCodexConfigPathForLaunch(wd, { HOME: badHome }),
        join(wd, ".codex", "config.toml"),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses project config.toml for launch repair when persisted scope is project", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(
        resolveCodexConfigPathForLaunch(wd, {}),
        join(wd, ".codex", "config.toml"),
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("marks only persisted project CODEX_HOME as project-local cleanup target", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(resolveProjectLocalCodexHomeForLaunch(wd, {}), join(wd, ".codex"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("does not mark explicit CODEX_HOME as project-local cleanup target", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(
        resolveProjectLocalCodexHomeForLaunch(wd, {
          CODEX_HOME: "/tmp/user-global-codex-home",
        }),
        undefined,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses a session-scoped CODEX_HOME mirror for project launch config writes", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-runtime-codex-home-"));
    try {
      const projectCodexHome = join(wd, ".codex");
      const configPath = join(projectCodexHome, "config.toml");
      await mkdir(join(wd, ".omx"), { recursive: true });
      await mkdir(join(projectCodexHome, "agents"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      const originalConfig = [
        'model = "gpt-5.5"',
        "",
        "[tui]",
        'status_line = ["model-with-reasoning", "git-branch"]',
        "",
      ].join("\n");
      await writeFile(configPath, originalConfig);
      await writeFile(join(projectCodexHome, "agents", "planner.toml"), 'name = "planner"\n');
      const beforeStat = await stat(configPath);

      const prepared = await prepareCodexHomeForLaunch(wd, "session-2033", {});
      const runtimeCodexHome = runtimeCodexHomePath(wd, "session-2033");

      assert.equal(prepared.codexHomeOverride, runtimeCodexHome);
      assert.equal(prepared.projectLocalCodexHomeForCleanup, projectCodexHome);
      assert.equal(prepared.runtimeCodexHomeForCleanup, runtimeCodexHome);
      assert.equal(await readFile(join(runtimeCodexHome, "config.toml"), "utf-8"), originalConfig);
      assert.equal(
        await readFile(join(runtimeCodexHome, "agents", "planner.toml"), "utf-8"),
        'name = "planner"\n',
      );

      await writeFile(
        join(runtimeCodexHome, "config.toml"),
        `${originalConfig}\n[tui.model_availability_nux]\n"gpt-5.5" = 1\n`,
      );

      assert.equal(await readFile(configPath, "utf-8"), originalConfig);
      assert.doesNotMatch(await readFile(configPath, "utf-8"), /model_availability_nux/);
      assert.equal((await stat(configPath)).mtimeMs, beforeStat.mtimeMs);

      await prepareCodexHomeForLaunch(wd, "session-2033-repeat", {});
      assert.equal(await readFile(configPath, "utf-8"), originalConfig);
      assert.equal((await stat(configPath)).mtimeMs, beforeStat.mtimeMs);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps explicit CODEX_HOME persistent instead of creating a runtime mirror", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-runtime-codex-home-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );

      const prepared = await prepareCodexHomeForLaunch(wd, "session-explicit", {
        CODEX_HOME: "/tmp/explicit-codex-home",
      });

      assert.equal(prepared.codexHomeOverride, "/tmp/explicit-codex-home");
      assert.equal(prepared.projectLocalCodexHomeForCleanup, undefined);
      assert.equal(prepared.runtimeCodexHomeForCleanup, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("keeps explicit CODEX_HOME override from env", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(
        resolveCodexHomeForLaunch(wd, {
          CODEX_HOME: "/tmp/explicit-codex-home",
        }),
        "/tmp/explicit-codex-home",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("uses explicit CODEX_HOME config.toml for launch repair overrides", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project" }),
      );
      assert.equal(
        resolveCodexConfigPathForLaunch(wd, {
          CODEX_HOME: "/tmp/explicit-codex-home",
        }),
        "/tmp/explicit-codex-home/config.toml",
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('migrates legacy "project-local" persisted scope to "project"', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );
      assert.equal(readPersistedSetupScope(wd), "project");
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('resolves CODEX_HOME for legacy "project-local" persisted scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "project-local" }),
      );
      assert.equal(resolveCodexHomeForLaunch(wd, {}), join(wd, ".codex"));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("resolveCodexLaunchPolicy", () => {
  it("uses detached tmux on macOS when outside tmux and tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy({}, "darwin", true, false, true, true),
      "detached-tmux",
    );
  });

  it("uses tmux-aware launch path when already inside tmux", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "/tmp/tmux-1000/default,123,0" },
        "darwin",
        true,
      ),
      "inside-tmux",
    );
  });

  it("uses tmux-aware launch path when already inside tmux on native Windows", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "psmux-session" },
        "win32",
        true,
        true,
      ),
      "inside-tmux",
    );
  });

  it("uses detached tmux on non-macOS hosts when outside tmux and tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy({}, "linux", true, false, true, true),
      "detached-tmux",
    );
  });

  it("launches directly on native Windows even when tmux is available", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "win32", true, true), "direct");
  });

  it("does not force direct launch for MSYS or Git Bash on win32", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { MSYSTEM: "MINGW64" },
        "win32",
        true,
        false,
        true,
        true,
      ),
      "direct",
    );
  });

  it("honors explicit detached tmux launch requests when tmux is available", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        {},
        "linux",
        true,
        false,
        true,
        true,
        "detached-tmux",
      ),
      "detached-tmux",
    );
  });

  it("honors explicit direct launch requests outside tmux", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        {},
        "linux",
        true,
        false,
        true,
        true,
        "direct",
      ),
      "direct",
    );
  });

  it("honors explicit direct launch requests inside tmux", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "/tmp/tmux-1000/default,123,0" },
        "linux",
        true,
        false,
        true,
        true,
        "direct",
      ),
      "direct",
    );
  });

  it("keeps explicit tmux policy tmux-aware inside tmux", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        { TMUX: "/tmp/tmux-1000/default,123,0" },
        "linux",
        true,
        false,
        true,
        true,
        "detached-tmux",
      ),
      "inside-tmux",
    );
  });

  it("falls back directly for explicit tmux requests when tmux is unavailable", () => {
    assert.equal(
      resolveCodexLaunchPolicy(
        {},
        "linux",
        false,
        false,
        true,
        true,
        "detached-tmux",
      ),
      "direct",
    );
  });

  it("launches directly when stdin is not a tty outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", true, false, false, true), "direct");
  });

  it("launches directly when stdout is not a tty outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", true, false, true, false), "direct");
  });

  it("launches directly when tmux is unavailable outside tmux", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "linux", false), "direct");
  });

  it("launches directly on native Windows when tmux is unavailable", () => {
    assert.equal(resolveCodexLaunchPolicy({}, "win32", false, true), "direct");
  });
});

describe("resolveBackgroundHelperLaunchMode", () => {
  it("uses the hidden Windows MSYS bootstrap for win32 Git Bash", () => {
    assert.equal(
      resolveBackgroundHelperLaunchMode({ MSYSTEM: "MINGW64" }, "win32"),
      "windows-msys-bootstrap",
    );
  });

  it("spawns helpers directly on native win32", () => {
    assert.equal(resolveBackgroundHelperLaunchMode({}, "win32"), "direct-detached");
  });

  it("spawns helpers directly on non-Windows platforms", () => {
    assert.equal(
      resolveBackgroundHelperLaunchMode({ MSYSTEM: "MINGW64" }, "linux"),
      "direct-detached",
    );
  });
});

describe("shouldDetachBackgroundHelper", () => {
  it("keeps the long-running helper detached under win32 Git Bash", () => {
    assert.equal(
      shouldDetachBackgroundHelper({ MSYSTEM: "MINGW64" }, "win32"),
      true,
    );
  });

  it("keeps detached helpers on native win32", () => {
    assert.equal(shouldDetachBackgroundHelper({}, "win32"), true);
  });

  it("keeps detached helpers on non-Windows platforms", () => {
    assert.equal(
      shouldDetachBackgroundHelper({ MSYSTEM: "MINGW64" }, "linux"),
      true,
    );
  });
});

describe("classifyCodexExecFailure", () => {
  it("classifies child process exit status as codex exit", () => {
    const err = Object.assign(new Error("codex exited 9"), { status: 9 });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "exit");
    assert.equal(classified.exitCode, 9);
  });

  it("classifies signal termination as codex exit and maps to signal-based exit code", () => {
    const err = Object.assign(new Error("terminated"), {
      status: null,
      signal: "SIGTERM" as NodeJS.Signals,
    });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "exit");
    assert.equal(classified.signal, "SIGTERM");
    assert.equal(classified.exitCode, resolveSignalExitCode("SIGTERM"));
  });

  it("classifies ENOENT as launch error", () => {
    const err = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
    });
    const classified = classifyCodexExecFailure(err);
    assert.equal(classified.kind, "launch-error");
    assert.equal(classified.code, "ENOENT");
  });
});

describe("tmux HUD pane helpers", () => {
  it("findHudWatchPaneIds detects stale HUD watch panes and excludes current pane", () => {
    const panes = parseTmuxPaneSnapshot(
      [
        "%1\tzsh\tzsh",
        "%2\tnode\tnode /tmp/bin/omx.js hud --watch",
        "%3\tnode\tnode /tmp/bin/omx.js hud --watch",
        "%4\tcodex\tcodex --model gpt-5",
      ].join("\n"),
    );
    assert.deepEqual(findHudWatchPaneIds(panes, "%2"), ["%3"]);
  });

  it("buildHudPaneCleanupTargets de-dupes pane ids and includes created pane", () => {
    assert.deepEqual(
      buildHudPaneCleanupTargets(["%3", "%3", "invalid"], "%4"),
      ["%3", "%4"],
    );
  });

  it("buildHudPaneCleanupTargets excludes leader pane from existing ids", () => {
    // %5 is the leader pane — it must not be included even if findHudWatchPaneIds let it through.
    assert.deepEqual(buildHudPaneCleanupTargets(["%3", "%5"], "%4", "%5"), [
      "%3",
      "%4",
    ]);
  });

  it("buildHudPaneCleanupTargets excludes leader pane even when it matches the created HUD pane id", () => {
    // Defensive edge case: if createHudWatchPane somehow returned the leader pane id, guard protects it.
    assert.deepEqual(buildHudPaneCleanupTargets(["%3"], "%5", "%5"), ["%3"]);
  });

  it("buildHudPaneCleanupTargets is a no-op guard when leaderPaneId is absent", () => {
    assert.deepEqual(buildHudPaneCleanupTargets(["%3"], "%4"), ["%3", "%4"]);
  });

  it("listCurrentWindowHudPaneIds scopes tmux pane listing to the emitting pane", () => {
    const calls: string[][] = [];
    const panes = listCurrentWindowHudPaneIds("%leader", (args) => {
      calls.push(args);
      return [
        "%leader\tcodex\tcodex",
        "%hud\tnode\tnode /tmp/bin/omx.js hud --watch",
      ].join("\n");
    });

    assert.deepEqual(panes, ["%hud"]);
    assert.deepEqual(calls[0], [
      "list-panes",
      "-t",
      "%leader",
      "-F",
      "#{pane_id}\t#{pane_current_command}\t#{pane_start_command}",
    ]);
  });

  it("createHudWatchPane splits from the emitting pane target when provided", () => {
    const calls: string[][] = [];
    const paneId = createSharedHudWatchPane(
      "/repo",
      "node /repo/dist/cli/omx.js hud --watch",
      { heightLines: 3, targetPaneId: "%leader" },
      (args) => {
        calls.push(args);
        return "%hud\n";
      },
    );

    assert.equal(paneId, "%hud");
    assert.deepEqual(calls[0], [
      "split-window",
      "-v",
      "-l",
      "3",
      "-d",
      "-t",
      "%leader",
      "-c",
      "/repo",
      "-P",
      "-F",
      "#{pane_id}",
      "node /repo/dist/cli/omx.js hud --watch",
    ]);
  });
});

describe("detached tmux new-session sequencing", () => {
  it("buildDetachedSessionBootstrapSteps uses shared HUD height and split-capture ordering", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      "--model gpt-5",
      "/tmp/codex-home",
      '{"active":true}',
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["new-session", "split-and-capture-hud-pane"],
    );
    assert.equal(steps[1]?.args[3], String(HUD_TMUX_HEIGHT_LINES));
    assert.equal(steps[1]?.args[6], "omx-demo");
    assert.equal(steps[1]?.args.includes("-P"), true);
    assert.equal(steps[1]?.args.includes("#{pane_id}"), true);
    assert.equal(steps[0]?.args.includes("-e"), true);
    assert.equal(
      steps[0]?.args.includes('OMX_NOTIFY_TEMP_CONTRACT={\"active\":true}'),
      true,
    );
  });

  it("buildDetachedSessionBootstrapSteps forwards temp contract env to detached tmux session", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
      undefined,
      '{"active":true,"canonicalSelectors":["discord"]}',
    );
    const newSession = steps.find((step) => step.name === "new-session");
    assert.ok(newSession);
    assert.equal(
      newSession!.args.includes("-e") &&
        newSession!.args.some((arg) =>
          arg.startsWith("OMX_NOTIFY_TEMP_CONTRACT="),
        ),
      true,
    );
  });

  it("buildDetachedSessionBootstrapSteps forwards OMX_SESSION_ID to detached tmux session", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'env' 'OMX_SESSION_ID=sess-detached-managed' 'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
      undefined,
      null,
      false,
      "sess-detached-managed",
    );
    const newSession = steps.find((step) => step.name === "new-session");
    const tagSession = steps.find((step) => step.name === "tag-session");
    assert.ok(newSession);
    assert.ok(tagSession);
    assert.equal(
      newSession!.args.includes("-e") &&
        newSession!.args.some((arg) => arg === "OMX_SESSION_ID=sess-detached-managed"),
      true,
    );
    assert.deepEqual(tagSession!.args, [
      "set-option",
      "-t",
      "omx-demo",
      "@omx_instance_id",
      "sess-detached-managed",
    ]);
  });

  it("buildDetachedSessionBootstrapSteps forwards CODEX_HOME override to detached tmux session", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
      "/tmp/project/.codex",
      null,
      false,
      "sess-detached-managed",
    );
    const newSession = steps.find((step) => step.name === "new-session");
    assert.ok(newSession);
    assert.equal(
      newSession!.args.includes("-e") &&
        newSession!.args.some((arg) => arg === "CODEX_HOME=/tmp/project/.codex"),
      true,
    );
  });

  it("runCodex builds inside-tmux HUD command with OMX_SESSION_ID", async () => {
    const source = await readFile(join(repoRoot, 'src', 'cli', 'index.ts'), 'utf-8');
    assert.match(
      source,
      /buildTmuxPaneCommand\("env",\s*\[\s*`OMX_SESSION_ID=\$\{sessionId\}`,\s*"node",\s*omxBin,\s*"hud",\s*"--watch",?\s*\]\)/,
    );
  });

  it("buildDetachedSessionBootstrapSteps starts native Windows detached sessions with powershell", () => {
    const hudCmd = buildWindowsPromptCommand("node", [
      "omx.js",
      "hud",
      "--watch",
    ]);
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "C:/project",
      "'codex' '--dangerously-bypass-approvals-and-sandbox'",
      hudCmd,
      "--model gpt-5",
      "C:/codex-home",
      null,
      true,
    );
    assert.equal(steps[0]?.name, "new-session");
    assert.equal(steps[0]?.args.at(-1), "powershell.exe");
    assert.equal(steps[1]?.name, "split-and-capture-hud-pane");
    assert.equal(steps[1]?.args.at(-1), hudCmd);
  });

  it("buildDetachedWindowsBootstrapScript targets the resolved tmux-compatible command", () => {
    const script = buildDetachedWindowsBootstrapScript(
      "omx-demo",
      "powershell.exe -NoLogo -NoExit -EncodedCommand abc",
      2500,
      "C:\\Program Files\\psmux\\psmux.exe",
    );
    assert.match(script, /const tmuxCommand = "C:\\\\Program Files\\\\psmux\\\\psmux\.exe";/);
    assert.match(script, /execFileSync\(tmuxCommand, \['send-keys'/);
    assert.doesNotMatch(script, /execFileSync\('tmux'/);
  });

  it("buildDetachedSessionBootstrapSteps kills detached tmux session on normal shell exit", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
    );
    const leaderCmd = steps[0]?.args.at(-1);
    assert.equal(typeof leaderCmd, "string");
    assert.match(leaderCmd!, /^\/bin\/sh -c '/);
    assert.doesNotMatch(leaderCmd!, /^\/bin\/sh -lc '/);
    assert.match(leaderCmd!, /acquireTmuxExtendedKeysLease/);
    assert.match(leaderCmd!, /omx_detached_session_cleanup\(\)/);
    assert.match(leaderCmd!, /trap omx_detached_session_cleanup 0 INT TERM HUP;/);
    assert.match(leaderCmd!, /exec 3<&0;/);
    assert.match(leaderCmd!, /omx_codex_pid=\$!;/);
    assert.match(leaderCmd!, /<\&3 &/);
    assert.match(leaderCmd!, /wait "\$omx_codex_pid";/);
    assert.match(leaderCmd!, /kill -TERM "\$omx_codex_pid"/);
    assert.match(leaderCmd!, /releaseTmuxExtendedKeysLease/);
    assert.match(leaderCmd!, /if \[ "\$status" -lt 128 \]; then/);
    assert.match(leaderCmd!, /tmux kill-session -t/);
    assert.match(leaderCmd!, /"omx-demo"/);
    assert.match(leaderCmd!, /exit \$status/);
  });

  it("buildDetachedSessionBootstrapSteps finalizes postLaunch inside the detached leader when a session id is available", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
      "/tmp/codex-home",
      null,
      false,
      "omx-session-123",
      "/tmp/project/.codex-project",
      "/tmp/project/.omx/runtime/codex-home/omx-session-123",
    );
    const leaderCmd = steps[0]?.args.at(-1);
    assert.equal(typeof leaderCmd, "string");
    assert.match(leaderCmd!, /runDetachedSessionPostLaunch/);
    assert.match(leaderCmd!, /omx-session-123/);
    assert.match(leaderCmd!, /\/tmp\/codex-home/);
    assert.match(leaderCmd!, /\/tmp\/project\/\.codex-project/);
    assert.match(leaderCmd!, /\/tmp\/project\/\.omx\/runtime\/codex-home\/omx-session-123/);
    const helperIndex = leaderCmd!.indexOf("runDetachedSessionPostLaunch");
    const signalGateIndex = leaderCmd!.indexOf('if [ "$status" -lt 128 ]');
    assert.ok(helperIndex >= 0);
    assert.ok(signalGateIndex >= 0);
    assert.ok(
      helperIndex < signalGateIndex,
      "detached postLaunch helper must run before the signal-derived tmux kill-session gate",
    );
  });

  it("detached leader command keeps stdin open for the Codex child", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-detached-leader-stdin-"));
    const fakeBin = join(cwd, "bin");
    const stdinLogPath = join(cwd, "stdin.log");

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
if IFS= read -r line; then
  printf 'stdin:%s\n' "$line" > "${stdinLogPath}"
else
  printf 'stdin:EOF\n' > "${stdinLogPath}"
fi
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\n'
    else
      printf '0\n'
    fi
    ;;
  show-options)
    printf 'off\n'
    ;;
  set-option|kill-session)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omx-demo",
        cwd,
        buildTmuxPaneCommand("codex", [], "/bin/sh"),
        "'node' '/tmp/omx.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      const result = (await import("node:child_process")).spawnSync("/bin/sh", ["-c", leaderCmd!], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        input: "hello from leader\n",
        encoding: "utf-8",
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const stdinLog = await readFile(stdinLogPath, "utf-8");
      assert.match(stdinLog, /stdin:hello from leader/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detached leader command preserves cwd and cleanup without shell-quote breakage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-detached-leader-"));
    const fakeBin = join(cwd, "bin");
    const logPath = join(cwd, "leader.log");

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${logPath}"
printf 'codex-pwd:%s\\n' "$(pwd)" >> "${logPath}"
exit 0
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(join(cwd, ".profile"), "cd ..\n");
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf 'tmux:%s\\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    ;;
  show-options)
    printf 'off\\n'
    ;;
  set-option|kill-session)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omx-demo",
        cwd,
        buildTmuxPaneCommand(
          "codex",
          ["--dangerously-bypass-approvals-and-sandbox"],
          "/bin/sh",
        ),
        "'node' '/tmp/omx.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      (await import("node:child_process")).execFileSync("/bin/sh", ["-c", leaderCmd!], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        stdio: "ignore",
      });

      const log = await readFile(logPath, "utf-8");
      assert.match(log, /codex:--dangerously-bypass-approvals-and-sandbox/);
      assert.match(
        normalizeDarwinTmpPath(log),
        new RegExp(`codex-pwd:${escapeRegExp(normalizeDarwinTmpPath(cwd))}`),
      );
      assert.match(log, /tmux:display-message -p #\{socket_path\}/);
      assert.match(log, /tmux:show-options -sv extended-keys/);
      assert.match(log, /tmux:set-option -sq extended-keys always/);
      assert.match(log, /tmux:set-option -sq extended-keys off/);
      assert.match(log, /tmux:kill-session -t omx-demo/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detached leader command preserves the detached tmux session on signal-derived exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-detached-leader-signal-"));
    const fakeBin = join(cwd, "bin");
    const logPath = join(cwd, "leader.log");

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
printf 'codex:%s\\n' "$*" >> "${logPath}"
exit 143
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
printf 'tmux:%s\\n' "$*" >> "${logPath}"
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    ;;
  show-options)
    printf 'off\\n'
    ;;
  set-option|kill-session)
    ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omx-demo",
        cwd,
        buildTmuxPaneCommand(
          "codex",
          ["--dangerously-bypass-approvals-and-sandbox"],
          "/bin/sh",
        ),
        "'node' '/tmp/omx.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      const result = (await import("node:child_process")).spawnSync("/bin/sh", ["-c", leaderCmd!], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        encoding: "utf-8",
      });

      assert.equal(result.status, 143);
      const log = await readFile(logPath, "utf-8");
      assert.match(log, /codex:--dangerously-bypass-approvals-and-sandbox/);
      assert.match(log, /tmux:display-message -p #\{socket_path\}/);
      assert.match(log, /tmux:show-options -sv extended-keys/);
      assert.match(log, /tmux:set-option -sq extended-keys always/);
      assert.match(log, /tmux:set-option -sq extended-keys off/);
      assert.doesNotMatch(log, /tmux:kill-session -t omx-demo/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("detached leader command terminates codex child on external SIGHUP", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-detached-leader-hup-"));
    const fakeBin = join(cwd, "bin");
    const pidFile = join(cwd, "codex.pid");
    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "codex"),
        `#!/bin/sh
echo $$ > "${pidFile}"
trap '' HUP
while true; do sleep 1; done
`,
      );
      await chmod(join(fakeBin, "codex"), 0o755);
      await writeFile(
        join(fakeBin, "tmux"),
        `#!/bin/sh
case "$1" in
  display-message)
    if [ "$3" = '#{socket_path}' ] || [ "$4" = '#{socket_path}' ]; then
      printf '/tmp/tmux-test.sock\\n'
    else
      printf '0\\n'
    fi
    ;;
  show-options) printf 'off\\n' ;;
  set-option|kill-session) ;;
esac
exit 0
`,
      );
      await chmod(join(fakeBin, "tmux"), 0o755);

      const steps = buildDetachedSessionBootstrapSteps(
        "omx-demo",
        cwd,
        buildTmuxPaneCommand("codex", [], "/bin/sh"),
        "'node' '/tmp/omx.js' 'hud' '--watch'",
        null,
      );
      const leaderCmd = steps[0]?.args.at(-1);
      assert.equal(typeof leaderCmd, "string");

      const { spawn } = await import("node:child_process");
      const child = spawn("/bin/sh", ["-c", `exec ${leaderCmd!}`], {
        cwd,
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          HOME: cwd,
        },
        stdio: "ignore",
        detached: true,
      });

      try {
        for (let i = 0; i < 50; i += 1) {
          if (existsSync(pidFile)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(existsSync(pidFile), "codex pid file not written");
        const codexPid = Number.parseInt((await readFile(pidFile, "utf-8")).trim(), 10);
        assert.ok(codexPid > 0, "codex pid must be positive");
        assert.doesNotThrow(() => process.kill(codexPid, 0), "codex must be alive before signal");

        const leaderExit = once(child, "exit");
        process.kill(child.pid!, "SIGHUP");
        await Promise.race([
          leaderExit,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("leader did not exit after SIGHUP")), 3000),
          ),
        ]);
        assert.throws(
          () => process.kill(codexPid, 0),
          (err: unknown) =>
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ESRCH",
          "codex child must be terminated after leader SIGHUP",
        );
      } finally {
        try {
          process.kill(child.pid!, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("withTmuxExtendedKeys enables tmux extended keys during codex launch and restores them afterwards", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-lease-wrapper-"));
    const calls: string[][] = [];
    const result = withTmuxExtendedKeys(
      cwd,
      () => {
        calls.push(["run"]);
        return "ok";
      },
      (_file, args) => {
        calls.push([...args]);
        if (args[0] === "show-options") return "off\n";
        return "";
      },
    );
    await rm(cwd, { recursive: true, force: true });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["set-option", "-sq", "extended-keys", "always"],
      ["run"],
      ["set-option", "-sq", "extended-keys", "off"],
    ]);
  });

  it("acquireTmuxExtendedKeysLease can bind lease liveness to a long-lived owner pid", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-lease-owner-pid-"));
    try {
      const execStub = (_file: string, args: readonly string[]) => {
        if (args[0] === "display-message") return "/tmp/tmux-owner-pid.sock\n";
        if (args[0] === "show-options") return "off\n";
        return "";
      };

      const lease = acquireTmuxExtendedKeysLease(cwd, execStub, 12345);

      assert.match(lease ?? "", /^\/tmp\/tmux-owner-pid\.sock\t12345-/);
      if (lease) releaseTmuxExtendedKeysLease(cwd, lease, execStub);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("overlapping tmux extended-keys leases restore only after the last holder exits", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-lease-overlap-"));
    const calls: string[][] = [];
    const execStub = (_file: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "display-message") return "/tmp/tmux-test.sock\n";
      if (args[0] === "show-options") return "off\n";
      return "";
    };

    const leaseA = acquireTmuxExtendedKeysLease(cwd, execStub);
    const leaseB = acquireTmuxExtendedKeysLease(cwd, execStub);

    assert.equal(typeof leaseA, "string");
    assert.equal(typeof leaseB, "string");

    releaseTmuxExtendedKeysLease(cwd, leaseA!, execStub);

    const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
    const leaseFilesAfterFirstRelease = await readFile(
      join(leaseDir, "tmp-tmux-test-sock.json"),
      "utf-8",
    );
    assert.match(leaseFilesAfterFirstRelease, /holders/);

    releaseTmuxExtendedKeysLease(cwd, leaseB!, execStub);

    await assert.rejects(
      readFile(join(leaseDir, "tmp-tmux-test-sock.json"), "utf-8"),
      /ENOENT/,
    );
    await rm(cwd, { recursive: true, force: true });

    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["set-option", "-sq", "extended-keys", "always"],
      ["display-message", "-p", "#{socket_path}"],
      ["set-option", "-sq", "extended-keys", "off"],
    ]);
  });

  it("withTmuxExtendedKeys degrades cleanly when tmux option probing fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-lease-fail-"));
    const calls: string[][] = [];
    const result = withTmuxExtendedKeys(
      cwd,
      () => {
        calls.push(["run"]);
        return "ok";
      },
      (_file, args) => {
        calls.push([...args]);
        if (args[0] === "show-options") throw new Error("tmux unavailable");
        return "";
      },
    );
    await rm(cwd, { recursive: true, force: true });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [
      ["display-message", "-p", "#{socket_path}"],
      ["show-options", "-sv", "extended-keys"],
      ["run"],
    ]);
  });

  it("reapStaleNotifyFallbackWatcher skips kill when process identity does not match a watcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-reap-pid-identity-"));
    const pidPath = join(cwd, "watcher.pid");
    await writeFile(pidPath, JSON.stringify({ pid: 99999, started_at: new Date().toISOString() }));

    const killed: number[] = [];
    await reapStaleNotifyFallbackWatcher(pidPath, {
      isWatcherProcess: () => false,
      tryKillPid: (pid) => { killed.push(pid); return true; },
    });

    assert.equal(killed.length, 0, "should not kill a process that is not a watcher");
    await rm(cwd, { recursive: true, force: true });
  });

  it("reapStaleNotifyFallbackWatcher sends SIGTERM only after confirming watcher identity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-reap-pid-confirmed-"));
    const pidPath = join(cwd, "watcher.pid");
    await writeFile(pidPath, JSON.stringify({ pid: 12345, started_at: new Date().toISOString() }));

    const killed: number[] = [];
    await reapStaleNotifyFallbackWatcher(pidPath, {
      isWatcherProcess: () => true,
      tryKillPid: (pid) => { killed.push(pid); return true; },
    });

    assert.deepEqual(killed, [12345], "should SIGTERM the verified watcher process");
    await rm(cwd, { recursive: true, force: true });
  });

  it("reuses legacy plain-text PID parsing without widening stale reap semantics across PID reuse", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-reap-legacy-pid-"));
    try {
      const pidPath = join(cwd, "watcher.pid");
      await writeFile(pidPath, "12345\n", "utf-8");

      const observed: number[] = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        isWatcherProcess(pid) {
          observed.push(pid);
          return false;
        },
        tryKillPid: (pid) => {
          observed.push(pid);
          return true;
        },
      });

      assert.deepEqual(
        observed,
        [12345],
        "legacy plain-text PID files should still identity-check reused PIDs before any kill",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reaps watcher-record PIDs only after the record path confirms watcher identity across PID reuse", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-reap-record-pid-"));
    try {
      const pidPath = join(cwd, "watcher.pid");
      await writeFile(
        pidPath,
        JSON.stringify({ pid: 54321, started_at: "2026-04-05T00:00:00.000Z" }),
        "utf-8",
      );

      const observed: Array<{ step: "identity" | "kill"; pid: number }> = [];
      await reapStaleNotifyFallbackWatcher(pidPath, {
        isWatcherProcess(pid) {
          observed.push({ step: "identity", pid });
          return true;
        },
        tryKillPid(pid) {
          observed.push({ step: "kill", pid });
          return true;
        },
      });

      assert.deepEqual(observed, [
        { step: "identity", pid: 54321 },
        { step: "kill", pid: 54321 },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("acquireTmuxExtendedKeysLease recovers from a stale lock left by a crashed process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-stale-lock-"));
    const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
    const lockDir = join(leaseDir, "tmp-stale-sock.lock");

    mkdirSync(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockDir, staleTime, staleTime);

    const calls: string[][] = [];
    const execStub = (_file: string, args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "display-message") return "/tmp/stale-sock";
      return "";
    };

    const lease = acquireTmuxExtendedKeysLease(cwd, execStub);

    assert.equal(typeof lease, "string", "lease should succeed after stale lock recovery");
    assert.ok(!existsSync(lockDir), "stale lock directory should be removed");

    if (lease) releaseTmuxExtendedKeysLease(cwd, lease, execStub);
    await rm(cwd, { recursive: true, force: true });
  });

  it("acquireTmuxExtendedKeysLease reaps dead holders and restores before taking a new lease", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-dead-holder-acquire-"));
    try {
      const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
      const leasePath = join(leaseDir, "tmp-stale-holder-sock.json");
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        leasePath,
        JSON.stringify({
          originalMode: "off",
          holders: ["2147483647-stale-holder"],
        }),
        "utf-8",
      );

      const calls: string[][] = [];
      const execStub = (_file: string, args: readonly string[]): string => {
        calls.push([...args]);
        if (args[0] === "display-message") return "/tmp/stale-holder.sock\n";
        if (args[0] === "show-options") return "off\n";
        return "";
      };

      const lease = acquireTmuxExtendedKeysLease(cwd, execStub);

      assert.equal(typeof lease, "string");
      const persisted = JSON.parse(await readFile(leasePath, "utf-8")) as {
        holders: Array<string | { id?: string; pid?: number; linuxStartTicks?: number }>;
      };
      assert.equal(persisted.holders.length, 1);
      const holder = persisted.holders[0];
      const holderId = typeof holder === "string" ? holder : holder?.id ?? "";
      assert.match(holderId, new RegExp(`^${process.pid}-`));
      assert.equal(typeof holder === "object" ? holder.pid : process.pid, process.pid);
      assert.doesNotMatch(JSON.stringify(persisted), /2147483647-stale-holder/);

      if (lease) releaseTmuxExtendedKeysLease(cwd, lease, execStub);

      assert.deepEqual(calls, [
        ["display-message", "-p", "#{socket_path}"],
        ["set-option", "-sq", "extended-keys", "off"],
        ["show-options", "-sv", "extended-keys"],
        ["set-option", "-sq", "extended-keys", "always"],
        ["set-option", "-sq", "extended-keys", "off"],
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("releaseTmuxExtendedKeysLease preserves live legacy string holders", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-live-legacy-holder-"));
    try {
      const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
      const leasePath = join(leaseDir, "tmp-live-legacy-sock.json");
      const legacyHolder = `${process.pid}-legacy-holder`;
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        leasePath,
        JSON.stringify({
          originalMode: "off",
          holders: [legacyHolder],
        }),
        "utf-8",
      );

      const calls: string[][] = [];
      const execStub = (_file: string, args: readonly string[]): string => {
        calls.push([...args]);
        return "";
      };

      releaseTmuxExtendedKeysLease(
        cwd,
        "/tmp/live-legacy.sock\tmissing-holder",
        execStub,
      );

      const persisted = JSON.parse(await readFile(leasePath, "utf-8")) as {
        holders: string[];
      };
      assert.deepEqual(persisted.holders, [legacyHolder]);
      assert.deepEqual(
        calls,
        [],
        "live legacy string holders should not be restored away",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("acquireTmuxExtendedKeysLease reaps Linux PID-reuse identity mismatches", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-pid-reuse-holder-"));
    try {
      const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
      const leasePath = join(leaseDir, "tmp-pid-reuse-sock.json");
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        leasePath,
        JSON.stringify({
          originalMode: "off",
          holders: [{
            id: `${process.pid}-reused-holder`,
            pid: process.pid,
            platform: "linux",
            linuxStartTicks: -1,
          }],
        }),
        "utf-8",
      );

      const calls: string[][] = [];
      const execStub = (_file: string, args: readonly string[]): string => {
        calls.push([...args]);
        if (args[0] === "display-message") return "/tmp/pid-reuse.sock\n";
        if (args[0] === "show-options") return "off\n";
        return "";
      };

      const lease = acquireTmuxExtendedKeysLease(cwd, execStub);

      assert.equal(typeof lease, "string");
      const persisted = JSON.parse(await readFile(leasePath, "utf-8")) as {
        holders: Array<string | { id?: string; pid?: number }>;
      };
      const holderIds = persisted.holders.map((holder) =>
        typeof holder === "string" ? holder : holder.id ?? "",
      );
      if (process.platform === "linux") {
        assert.equal(persisted.holders.length, 1);
        assert.match(holderIds[0] ?? "", new RegExp(`^${process.pid}-`));
        assert.doesNotMatch(JSON.stringify(persisted), /reused-holder/);
        assert.deepEqual(calls, [
          ["display-message", "-p", "#{socket_path}"],
          ["set-option", "-sq", "extended-keys", "off"],
          ["show-options", "-sv", "extended-keys"],
          ["set-option", "-sq", "extended-keys", "always"],
        ]);
      } else {
        assert.ok(holderIds.includes(`${process.pid}-reused-holder`));
      }

      if (lease) releaseTmuxExtendedKeysLease(cwd, lease, execStub);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("releaseTmuxExtendedKeysLease restores when all remaining holders are dead", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-tmux-dead-holder-release-"));
    try {
      const leaseDir = join(cwd, ".omx", "state", "tmux-extended-keys");
      const leasePath = join(leaseDir, "tmp-dead-release-sock.json");
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        leasePath,
        JSON.stringify({
          originalMode: "off",
          holders: ["2147483647-stale-holder"],
        }),
        "utf-8",
      );

      const calls: string[][] = [];
      const execStub = (_file: string, args: readonly string[]): string => {
        calls.push([...args]);
        return "";
      };

      releaseTmuxExtendedKeysLease(cwd, "/tmp/dead-release.sock\tmissing-holder", execStub);

      assert.ok(!existsSync(leasePath), "stale-only lease file should be removed");
      assert.deepEqual(calls, [["set-option", "-sq", "extended-keys", "off"]]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
    it("buildDetachedSessionFinalizeSteps keeps schedule after split-capture and before attach", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omx-demo",
      "%12",
      "3",
      true,
    );
    const names = steps.map((step) => step.name);
    const attachedIndex = names.indexOf("register-client-attached-reconcile");
    const scheduleIndex = names.indexOf("schedule-delayed-resize");
    const attachIndex = names.indexOf("attach-session");
    assert.equal(attachedIndex >= 0, true);
    assert.equal(scheduleIndex > attachedIndex, true);
    assert.equal(scheduleIndex >= 0, true);
    assert.equal(attachIndex > scheduleIndex, true);
    assert.equal(names.includes("register-resize-hook"), true);
    assert.equal(names.includes("reconcile-hud-resize"), true);
  });

  it("buildDetachedSessionFinalizeSteps uses quiet best-effort tmux resize commands", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omx-demo",
      "%12",
      "3",
      false,
    );
    const registerHook = steps.find(
      (step) => step.name === "register-resize-hook",
    );
    const schedule = steps.find(
      (step) => step.name === "schedule-delayed-resize",
    );
    const reconcile = steps.find(
      (step) => step.name === "reconcile-hud-resize",
    );

    assert.match(registerHook?.args[4] ?? "", />\/dev\/null 2>&1 \|\| true/);
    assert.match(
      registerHook?.args[4] ?? "",
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
    assert.match(schedule?.args[2] ?? "", />\/dev\/null 2>&1 \|\| true/);
    assert.match(
      schedule?.args[2] ?? "",
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
    assert.match(
      (reconcile?.args ?? []).join(" "),
      />\/dev\/null 2>&1 \|\| true/,
    );
    assert.match(
      (reconcile?.args ?? []).join(" "),
      new RegExp(`-y ${HUD_TMUX_HEIGHT_LINES}\\b`),
    );
  });

  it("buildDetachedSessionFinalizeSteps skips detached resize hooks on native Windows", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omx-demo",
      "%12",
      "3",
      true,
      true,
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["set-mouse", "sanitize-copy-mode-style", "attach-session"],
    );
  });

  it("buildDetachedSessionFinalizeSteps sanitizes copy-mode styling before attach when mouse mode is enabled", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omx-demo",
      "%12",
      "3",
      true,
    );
    assert.equal(
      steps.findIndex((step) => step.name === "sanitize-copy-mode-style")
      > steps.findIndex((step) => step.name === "set-mouse"),
      true,
    );
    assert.equal(
      steps.findIndex((step) => step.name === "attach-session")
      > steps.findIndex((step) => step.name === "sanitize-copy-mode-style"),
      true,
    );
  });

  it("buildDetachedSessionFinalizeSteps never appends server-global terminal-overrides", () => {
    const steps = buildDetachedSessionFinalizeSteps(
      "omx-demo",
      "%12",
      "3",
      true,
    );
    assert.equal(
      steps.some((step) => step.name === "set-wsl-xt"),
      false,
    );
    assert.equal(
      steps.some((step) => step.args.includes("terminal-overrides")),
      false,
    );
  });

  it("buildDetachedSessionRollbackSteps unregisters hooks before killing session", () => {
    const steps = buildDetachedSessionRollbackSteps(
      "omx-demo",
      "omx-demo:0",
      "omx_resize_launch_demo_0_12",
      "omx_attached_launch_demo_0_12",
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      [
        "unregister-client-attached-reconcile",
        "unregister-resize-hook",
        "kill-session",
      ],
    );
    assert.equal(steps[0]?.args[0], "set-hook");
    assert.equal(steps[0]?.args[1], "-u");
    assert.equal(steps[0]?.args[2], "-t");
    assert.equal(steps[0]?.args[3], "omx-demo:0");
    assert.match(steps[0]?.args[4] ?? "", /^client-attached\[\d+\]$/);
    assert.match(steps[1]?.args[4] ?? "", /^client-resized\[\d+\]$/);
    assert.deepEqual(steps[2]?.args, ["kill-session", "-t", "omx-demo"]);
  });

  it("buildDetachedSessionRollbackSteps only kills session when no hook metadata exists", () => {
    const steps = buildDetachedSessionRollbackSteps(
      "omx-demo",
      null,
      null,
      null,
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ["kill-session"],
    );
  });
});

describe("buildTmuxShellCommand", () => {
  it("preserves quoted config values for tmux shell-command execution", () => {
    assert.equal(
      buildTmuxShellCommand("codex", [
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="xhigh"',
      ]),
      `'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model_reasoning_effort="xhigh"'`,
    );
  });
});

describe("buildTmuxPaneCommand", () => {
  it("wraps command with zsh profile sourcing while preserving tmux cwd", () => {
    const result = buildTmuxPaneCommand(
      "codex",
      ["--model", "gpt-5"],
      "/usr/bin/zsh",
    );
    assert.ok(
      result.startsWith("'/usr/bin/zsh' -c "),
      "should start with zsh non-login shell to preserve tmux cwd",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(result.includes("source ~/.zshrc"), "should source .zshrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("keeps Homebrew zsh instead of downgrading to /bin/sh", () => {
    const result = buildTmuxPaneCommand(
      "codex",
      ["--model", "gpt-5"],
      "/opt/homebrew/bin/zsh",
    );
    assert.ok(
      result.startsWith("'/opt/homebrew/bin/zsh' -c "),
      "should preserve Homebrew zsh when SHELL points to it",
    );
    assert.ok(
      !result.startsWith("'/bin/sh' -c "),
      "should not fall back to /bin/sh for supported Homebrew zsh",
    );
    assert.ok(result.includes("source ~/.zshrc"), "should source .zshrc");
  });

  it("keeps MacPorts zsh instead of downgrading to /bin/sh", () => {
    const result = buildTmuxPaneCommand(
      "codex",
      ["--model", "gpt-5"],
      "/opt/local/bin/zsh",
    );
    assert.ok(
      result.startsWith("'/opt/local/bin/zsh' -c "),
      "should preserve MacPorts zsh when SHELL points to it",
    );
    assert.ok(
      !result.startsWith("'/bin/sh' -c "),
      "should not fall back to /bin/sh for supported MacPorts zsh",
    );
    assert.ok(result.includes("source ~/.zshrc"), "should source .zshrc");
  });

  it("wraps command with bash profile sourcing while preserving tmux cwd", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/bash");
    assert.ok(
      result.startsWith("'/bin/bash' -c "),
      "should start with bash non-login shell to preserve tmux cwd",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(result.includes("source ~/.bashrc"), "should source .bashrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("skips rc sourcing for unknown shells without using a login shell", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/fish");
    assert.ok(
      result.startsWith("'/bin/fish' -c "),
      "should start with fish non-login shell",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
    assert.ok(!result.includes("source"), "should not source any rc file");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("falls back to /bin/sh without using a login shell when shell path is empty", () => {
    const result = buildTmuxPaneCommand("codex", [], "");
    assert.ok(
      result.startsWith("'/bin/sh' -c "),
      "should fall back to /bin/sh",
    );
    assert.ok(!result.includes(" -lc "), "should not use a login shell");
  });
});

describe("buildWindowsPromptCommand", () => {
  it("encodes detached Windows commands for safe PowerShell prompt injection", () => {
    const result = buildWindowsPromptCommand("codex", [
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      'model_reasoning_effort="high"',
      "it's",
    ]);
    const prefix = "powershell.exe -NoLogo -NoExit -EncodedCommand ";
    assert.ok(result.startsWith(prefix));
    const payload = result.slice(prefix.length);
    const decoded = Buffer.from(payload, "base64").toString("utf16le");
    assert.equal(
      decoded,
      "$ErrorActionPreference = 'Stop'; & { & 'codex' '--dangerously-bypass-approvals-and-sandbox' '-c' 'model_reasoning_effort=\"high\"' 'it''s' }",
    );
  });
});

describe("buildTmuxSessionName", () => {
  it("uses detached fallback quietly outside git repos", () => {
    const name = buildTmuxSessionName(
      "/tmp/My Repo",
      "omx-1770992424158-abc123",
    );
    assert.equal(name, "omx-my-repo-detached-1770992424158-abc123");
  });

  it("sanitizes invalid characters", () => {
    const name = buildTmuxSessionName("/tmp/@#$", "omx-+++");
    assert.match(
      name,
      /^omx-(unknown|[a-z0-9-]+)-[a-z0-9-]+-(unknown|[a-z0-9-]+)$/,
    );
    assert.equal(name.includes("_"), false);
    assert.equal(name.includes(" "), false);
  });

  it("includes repo name when cwd is inside .omx-worktrees", () => {
    const name = buildTmuxSessionName(
      "/home/user/my-repo.omx-worktrees/launch-feature-x",
      "omx-123-abc",
    );
    assert.match(name, /^omx-my-repo-launch-feature-x-/);
  });

  it("includes repo name for detached worktree paths", () => {
    const name = buildTmuxSessionName(
      "/projects/cool-project.omx-worktrees/launch-detached",
      "omx-456-def",
    );
    assert.match(name, /^omx-cool-project-launch-detached-/);
  });

  it("includes repo name when cwd is inside .omx/worktrees", () => {
    const name = buildTmuxSessionName(
      "/home/user/my-repo/.omx/worktrees/autoresearch-demo",
      "omx-789-ghi",
    );
    assert.match(name, /^omx-my-repo-autoresearch-demo-/);
  });
});

describe("buildDetachedTmuxSessionName", () => {
  it("reuses the OMX session id for the detached tmux session name", () => {
    const sessionName = buildDetachedTmuxSessionName(
      "/tmp/My Repo",
      "omx-1770992424158-abc123",
    );
    assert.equal(sessionName, "omx-my-repo-detached-1770992424158-abc123");
  });
});

describe("native Windows psmux-compatible tmux resolution", () => {
  it("resolveNativeSessionName uses the shared tmux-aware resolver for current session lookup", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    const wd = await mkdtemp(join(tmpdir(), "omx-psmux-native-session-"));
    const fakeBin = join(wd, "bin");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "psmux.exe"),
        `#!/bin/sh
if [ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "%7" ] && [ "$5" = "#S" ]; then
  printf 'psmux-session\\n'
  exit 0
fi
printf 'unexpected:%s\\n' "$*" >&2
exit 1
`,
      );
      await chmod(join(fakeBin, "psmux.exe"), 0o755);
      process.env.PATH = fakeBin;
      process.env.PATHEXT = ".EXE";
      const sessionName = resolveNativeSessionName("/tmp/repo", "omx-abc123", {
        ...process.env,
        TMUX: "1",
        TMUX_PANE: "%7",
      });
      assert.equal(sessionName, "psmux-session");
    } finally {
      process.env.PATH = originalPath;
      process.env.PATHEXT = originalPathext;
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it("detectDetachedSessionWindowIndex uses the shared tmux-aware resolver on native Windows", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalPath = process.env.PATH;
    const originalPathext = process.env.PATHEXT;
    const wd = await mkdtemp(join(tmpdir(), "omx-psmux-window-index-"));
    const fakeBin = join(wd, "bin");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(fakeBin, "psmux.exe"),
        `#!/bin/sh
if [ "$1" = "display-message" ] && [ "$2" = "-p" ] && [ "$3" = "-t" ] && [ "$4" = "omx-demo" ] && [ "$5" = "#{window_index}" ]; then
  printf '3\\n'
  exit 0
fi
printf 'unexpected:%s\\n' "$*" >&2
exit 1
`,
      );
      await chmod(join(fakeBin, "psmux.exe"), 0o755);
      process.env.PATH = fakeBin;
      process.env.PATHEXT = ".EXE";
      assert.equal(detectDetachedSessionWindowIndex("omx-demo"), "3");
    } finally {
      process.env.PATH = originalPath;
      process.env.PATHEXT = originalPathext;
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe("worktree dependency bootstrap helpers", () => {
  it("returns an explicit warning when reusable worktree dependencies are unavailable", () => {
    const result = ensureReusableNodeModules("/tmp/non-worktree", {
      gitRunner: () => ({ status: 1, stdout: "", stderr: "not a worktree" }) as any,
    });
    assert.equal(result.strategy, "missing");
    assert.match(String(result.warning || ""), /No reusable parent-repo node_modules was found/);
  });
});

describe("team worker launch arg inheritance helpers", () => {
  it("collectInheritableTeamWorkerArgs extracts bypass, reasoning, and model overrides", () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--model",
        "gpt-5",
      ]),
      [
        "--dangerously-bypass-approvals-and-sandbox",
        "-c",
        'model_reasoning_effort="xhigh"',
        "--model",
        "gpt-5",
      ],
    );
  });

  it("collectInheritableTeamWorkerArgs supports --model=<value> syntax", () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs(["--model=gpt-5.3-codex"]),
      ["--model", "gpt-5.3-codex"],
    );
  });


  it("collectInheritableTeamWorkerArgs preserves only safe model_provider config overrides", () => {
    assert.deepEqual(
      collectInheritableTeamWorkerArgs([
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'model_provider="cheapRouter"',
        "--model",
        "gpt-5.5",
      ]),
      ["-c", 'model_provider="cheapRouter"', "--model", "gpt-5.5"],
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv merges and normalizes with de-dupe + last reasoning/model wins", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        '--dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="high" --model old-a --no-alt-screen --model=old-b',
        [
          "-c",
          'model_reasoning_effort="xhigh"',
          "--dangerously-bypass-approvals-and-sandbox",
          "--model",
          "gpt-5",
        ],
        true,
      ),
      '--no-alt-screen --dangerously-bypass-approvals-and-sandbox -c model_reasoning_effort="xhigh" --model old-b',
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv can opt out of leader inheritance", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        [
          "--dangerously-bypass-approvals-and-sandbox",
          "-c",
          'model_reasoning_effort="xhigh"',
        ],
        false,
      ),
      "--no-alt-screen",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv uses inherited model when env model is absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--model=gpt-5.3-codex"],
        true,
      ),
      "--no-alt-screen --model gpt-5.3-codex",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv uses frontier default model when env and inherited models are absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--dangerously-bypass-approvals-and-sandbox"],
        true,
        DEFAULT_FRONTIER_MODEL,
      ),
      `--no-alt-screen --dangerously-bypass-approvals-and-sandbox --model ${DEFAULT_FRONTIER_MODEL}`,
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv keeps exactly one final model with precedence env > inherited > default", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--model env-model --model=env-model-final",
        ["--model", "inherited-model"],
        true,
        "fallback-model",
      ),
      "--model env-model-final",
    );
  });

  it("resolveTeamWorkerLaunchArgsEnv prefers inherited model over default when env model is absent", () => {
    assert.equal(
      resolveTeamWorkerLaunchArgsEnv(
        "--no-alt-screen",
        ["--model", "inherited-model"],
        true,
        "fallback-model",
      ),
      "--no-alt-screen --model inherited-model",
    );
  });
});

describe("readTopLevelTomlString", () => {
  it("reads a top-level string value", () => {
    const value = readTopLevelTomlString(
      'model_reasoning_effort = "high"\n[mcp_servers.test]\nmodel_reasoning_effort = "low"\n',
      "model_reasoning_effort",
    );
    assert.equal(value, "high");
  });

  it("ignores table-local values", () => {
    const value = readTopLevelTomlString(
      '[mcp_servers.test]\nmodel_reasoning_effort = "xhigh"\n',
      "model_reasoning_effort",
    );
    assert.equal(value, null);
  });
});

describe("injectModelInstructionsBypassArgs", () => {
  it("appends model_instructions_file override by default", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      {},
    );
    assert.deepEqual(args, [
      "--model",
      "gpt-5",
      "-c",
      'model_instructions_file="/tmp/my-project/AGENTS.md"',
    ]);
  });

  it("does not append when bypass is disabled via env", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      { OMX_BYPASS_DEFAULT_SYSTEM_PROMPT: "0" },
    );
    assert.deepEqual(args, ["--model", "gpt-5"]);
  });

  it("does not append when model_instructions_file is already set", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["-c", 'model_instructions_file="/tmp/custom.md"'],
      {},
    );
    assert.deepEqual(args, ["-c", 'model_instructions_file="/tmp/custom.md"']);
  });

  it("respects OMX_MODEL_INSTRUCTIONS_FILE env override", () => {
    const args = injectModelInstructionsBypassArgs("/tmp/my-project", [], {
      OMX_MODEL_INSTRUCTIONS_FILE: "/tmp/alt instructions.md",
    });
    assert.deepEqual(args, [
      "-c",
      'model_instructions_file="/tmp/alt instructions.md"',
    ]);
  });

  it("uses session-scoped default model_instructions_file when provided", () => {
    const args = injectModelInstructionsBypassArgs(
      "/tmp/my-project",
      ["--model", "gpt-5"],
      {},
      "/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md",
    );
    assert.deepEqual(args, [
      "--model",
      "gpt-5",
      "-c",
      'model_instructions_file="/tmp/my-project/.omx/state/sessions/session-1/AGENTS.md"',
    ]);
  });
});

describe("upsertTopLevelTomlString", () => {
  it("replaces an existing top-level key", () => {
    const updated = upsertTopLevelTomlString(
      'model_reasoning_effort = "low"\n[tui]\nstatus_line = []\n',
      "model_reasoning_effort",
      "high",
    );
    assert.match(updated, /^model_reasoning_effort = "high"$/m);
    assert.doesNotMatch(updated, /^model_reasoning_effort = "low"$/m);
  });

  it("inserts before the first table when key is missing", () => {
    const updated = upsertTopLevelTomlString(
      "[tui]\nstatus_line = []\n",
      "model_reasoning_effort",
      "xhigh",
    );
    assert.equal(
      updated,
      'model_reasoning_effort = "xhigh"\n[tui]\nstatus_line = []\n',
    );
  });
});
