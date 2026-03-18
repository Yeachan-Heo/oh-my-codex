import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeCodexLaunchArgs,
  buildTmuxShellCommand,
  buildTmuxPaneCommand,
  buildWindowsPromptCommand,
  buildTmuxSessionName,
  resolveCliInvocation,
  commandOwnsLocalHelp,
  resolveCodexLaunchPolicy,
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
  resolveSetupScopeArg,
  readPersistedSetupPreferences,
  readPersistedSetupScope,
  resolveCodexHomeForLaunch,
  buildDetachedSessionBootstrapSteps,
  buildDetachedSessionFinalizeSteps,
  buildDetachedSessionRollbackSteps,
  resolveNotifyTempContract,
  buildNotifyTempStartupMessages,
} from "../index.js";
import { HUD_TMUX_HEIGHT_LINES } from "../../hud/constants.js";
import {
  DEFAULT_FRONTIER_MODEL,
  getTeamLowComplexityModel,
} from "../../config/models.js";

function expectedLowComplexityModel(codexHomeOverride?: string): string {
  return getTeamLowComplexityModel(codexHomeOverride);
}

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
      "agents-init",
      "ask",
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
    for (const command of ["help", "launch", "version"]) {
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

  it("reads persisted setup preferences when skill target is present", async () => {
    const wd = await mkdtemp(join(tmpdir(), "omx-launch-scope-"));
    try {
      await mkdir(join(wd, ".omx"), { recursive: true });
      await writeFile(
        join(wd, ".omx", "setup-scope.json"),
        JSON.stringify({ scope: "user" }),
      );
      assert.deepEqual(readPersistedSetupPreferences(wd), {
        scope: "user",
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
      "detached-tmux",
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

  it("buildDetachedSessionBootstrapSteps kills detached tmux session on exit and interrupt", () => {
    const steps = buildDetachedSessionBootstrapSteps(
      "omx-demo",
      "/tmp/project",
      "'codex' '--model' 'gpt-5'",
      "'node' '/tmp/omx.js' 'hud' '--watch'",
      null,
    );
    const leaderCmd = steps[0]?.args.at(-1);
    assert.equal(typeof leaderCmd, "string");
    assert.match(leaderCmd!, /^\/bin\/sh -lc '/);
    assert.match(leaderCmd!, /trap '/);
    assert.match(leaderCmd!, /0 INT TERM HUP/);
    assert.match(leaderCmd!, /tmux kill-session -t/);
    assert.match(leaderCmd!, /"omx-demo"/);
    assert.match(leaderCmd!, /exit \$status/);
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
      ["set-mouse", "attach-session"],
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
  it("wraps command with zsh profile sourcing for zsh shell", () => {
    const result = buildTmuxPaneCommand(
      "codex",
      ["--model", "gpt-5"],
      "/usr/bin/zsh",
    );
    assert.ok(
      result.startsWith("'/usr/bin/zsh' -lc "),
      "should start with zsh login shell",
    );
    assert.ok(result.includes("source ~/.zshrc"), "should source .zshrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("wraps command with bash profile sourcing for bash shell", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/bash");
    assert.ok(
      result.startsWith("'/bin/bash' -lc "),
      "should start with bash login shell",
    );
    assert.ok(result.includes("source ~/.bashrc"), "should source .bashrc");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("skips rc sourcing for unknown shells but still uses login flag", () => {
    const result = buildTmuxPaneCommand("codex", [], "/bin/fish");
    assert.ok(
      result.startsWith("'/bin/fish' -lc "),
      "should start with fish login shell",
    );
    assert.ok(!result.includes("source"), "should not source any rc file");
    assert.ok(result.includes("exec "), "should exec the command");
  });

  it("falls back to /bin/sh when shell path is empty", () => {
    const result = buildTmuxPaneCommand("codex", [], "");
    assert.ok(
      result.startsWith("'/bin/sh' -lc "),
      "should fall back to /bin/sh",
    );
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
