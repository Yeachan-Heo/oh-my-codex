import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildManagedCodexHooksConfig } from "../../config/codex-hooks.js";
import { DOCUMENT_REFRESH_EXEMPTION_PREFIX } from "../../document-refresh/enforcer.js";
import {
  initTeamState,
  readTeamLeaderAttention,
  readTeamPhase,
  writeTeamLeaderAttention,
} from "../../team/state.js";
import {
  dispatchCodexNativeHook,
  isCodexNativeHookMainModule,
  mapCodexHookEventToOmxEvent,
  resolveSessionOwnerPidFromAncestry,
} from "../codex-native-hook.js";
import { writeSessionStart } from "../../hooks/session.js";
import { resetTriageConfigCache } from "../../hooks/triage-config.js";

function nativeHookScriptPath(): string {
  return join(process.cwd(), "dist", "scripts", "codex-native-hook.js");
}

function parseSingleJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  assert.notEqual(trimmed, "");
  assert.equal(trimmed.split("\n").length, 1);
  return JSON.parse(trimmed) as Record<string, unknown>;
}

function runNativeHookCli(
  payload: Record<string, unknown> | string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(
    process.execPath,
    [nativeHookScriptPath()],
    {
      cwd: options.cwd ?? process.cwd(),
      input: typeof payload === "string" ? payload : JSON.stringify(payload),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    },
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeActiveAutopilotSession(cwd: string, sessionId: string): Promise<void> {
  await writeJson(join(cwd, ".omx", "state", "session.json"), {
    session_id: sessionId,
  });
  await writeJson(join(cwd, ".omx", "state", "sessions", sessionId, "autopilot-state.json"), {
    active: true,
    current_phase: "execution",
  });
}

async function writeHookCounterPlugin(cwd: string): Promise<string> {
  const markerPath = join(cwd, ".omx", "stop-hook-counter.json");
  await mkdir(join(cwd, ".omx", "hooks"), { recursive: true });
  await writeFile(
    join(cwd, ".omx", "hooks", "count-stop-hook.mjs"),
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function onHookEvent(event) {
  if (event.event !== "stop") return;
  const outPath = join(process.cwd(), ".omx", "stop-hook-counter.json");
  await mkdir(dirname(outPath), { recursive: true });
  let count = 0;
  try {
    count = JSON.parse(await readFile(outPath, "utf-8")).count || 0;
  } catch {}
  await writeFile(outPath, JSON.stringify({ count: count + 1 }, null, 2));
}
`,
    "utf-8",
  );
  return markerPath;
}

async function writeReleaseReadinessLeaderAttention(
  teamName: string,
  sessionId: string,
  cwd: string,
  options: { workRemaining: boolean },
): Promise<void> {
  await writeTeamLeaderAttention(teamName, {
    team_name: teamName,
    updated_at: "2026-04-12T17:20:00.000Z",
    source: "notify_hook",
    leader_decision_state: "done_waiting_on_leader",
    leader_attention_pending: true,
    leader_attention_reason: "leader_session_stopped",
    attention_reasons: ["leader_session_stopped"],
    leader_stale: true,
    leader_session_active: false,
    leader_session_id: sessionId,
    leader_session_stopped_at: "2026-04-12T17:20:00.000Z",
    unread_leader_message_count: 0,
    work_remaining: options.workRemaining,
    stalled_for_ms: null,
  }, cwd);
}

async function writeReleaseReadinessStateMarker(
  sessionId: string,
  teamName: string,
  cwd: string,
): Promise<void> {
  await writeJson(
    join(cwd, ".omx", "state", "sessions", sessionId, "release-readiness-state.json"),
    {
      active: true,
      session_id: sessionId,
      team_name: teamName,
      stable_final_recommendation_emitted: true,
    },
  );
}

const TEAM_STOP_COMMIT_GUIDANCE =
  " If system-generated worker auto-checkpoint commits exist, rewrite them into Lore-format final commits before merge/finalization.";
const DEFAULT_AUTO_NUDGE_RESPONSE =
  "continue with the current task only if it is already authorized";

const TEAM_ENV_KEYS = [
  "OMX_TEAM_WORKER",
  "OMX_TEAM_STATE_ROOT",
  "OMX_TEAM_LEADER_CWD",
  "OMX_SESSION_ID",
  "OMX_QUESTION_RETURN_PANE",
  "OMX_LEADER_PANE_ID",
  "TMUX",
  "TMUX_PANE",
] as const;

const priorTeamEnv = new Map<(typeof TEAM_ENV_KEYS)[number], string | undefined>();

beforeEach(() => {
  priorTeamEnv.clear();
  for (const key of TEAM_ENV_KEYS) {
    priorTeamEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TEAM_ENV_KEYS) {
    const value = priorTeamEnv.get(key);
    if (typeof value === "string") process.env[key] = value;
    else delete process.env[key];
  }
  priorTeamEnv.clear();
});

describe("codex native hook config", () => {
  it("builds the expected managed hooks.json shape", () => {
    const config = buildManagedCodexHooksConfig("/tmp/omx");
    assert.deepEqual(Object.keys(config.hooks), [
      "SessionStart",
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
    ]);

    const sessionStart = config.hooks.SessionStart[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(sessionStart.matcher, "startup|resume");
    assert.equal(sessionStart.hooks?.[0]?.statusMessage, undefined);

    const preToolUse = config.hooks.PreToolUse[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(preToolUse.matcher, "Bash");
    assert.match(
      String(preToolUse.hooks?.[0]?.command || ""),
      /codex-native-hook\.js"?$/,
    );
    assert.equal(preToolUse.hooks?.[0]?.statusMessage, undefined);

    const postToolUse = config.hooks.PostToolUse[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(postToolUse.matcher, undefined);
    assert.match(
      String(postToolUse.hooks?.[0]?.command || ""),
      /codex-native-hook\.js"?$/,
    );
    assert.equal(postToolUse.hooks?.[0]?.statusMessage, undefined);

    const userPromptSubmit = config.hooks.UserPromptSubmit[0] as {
      matcher?: string;
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(userPromptSubmit.matcher, undefined);
    assert.match(
      String(userPromptSubmit.hooks?.[0]?.command || ""),
      /codex-native-hook\.js"?$/,
    );
    assert.equal(userPromptSubmit.hooks?.[0]?.statusMessage, undefined);

    const stop = config.hooks.Stop[0] as {
      hooks?: Array<Record<string, unknown>>;
    };
    assert.equal(stop.hooks?.[0]?.timeout, 30);
  });
});

describe("codex native hook dispatch", () => {
  it("treats space-containing argv entry paths as the main module", () => {
    const entryPath = "/tmp/omx native/codex-native-hook.js";

    assert.equal(
      isCodexNativeHookMainModule(pathToFileURL(entryPath).href, entryPath),
      true,
    );
  });

  it("does not treat a different module url as the main module", () => {
    assert.equal(
      isCodexNativeHookMainModule(
        pathToFileURL("/tmp/omx native/other-script.js").href,
        "/tmp/omx native/codex-native-hook.js",
      ),
      false,
    );
  });

  it("emits deterministic JSON stdout when CLI stdin is malformed", () => {
    const stdout = runNativeHookCli("{");

    const output = parseSingleJsonStdout(stdout) as {
      decision?: string;
      reason?: string;
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };

    assert.equal(output.decision, "block");
    assert.equal(
      output.reason,
      "OMX native hook received malformed JSON input. Preserve runtime state, inspect the emitting hook payload yourself, and retry with valid JSON.",
    );
    assert.equal(output.hookSpecificOutput?.hookEventName, "Unknown");
    assert.match(
      String(output.hookSpecificOutput?.additionalContext ?? ""),
      /stdin JSON parsing failed inside codex-native-hook:/,
    );
  });

  it("emits exactly one parseable JSON object for active Stop CLI continuation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-cli-stop-json-"));
    try {
      await writeActiveAutopilotSession(cwd, "sess-cli-stop-json");

      const stdout = runNativeHookCli({
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-cli-stop-json",
        thread_id: "thread-cli-stop-json",
        turn_id: "turn-cli-stop-json",
      }, { cwd });
      const output = parseSingleJsonStdout(stdout);

      assert.equal(output.decision, "block");
      assert.equal(output.stopReason, "autopilot_execution");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps noisy Stop hook plugin stdout out of native Stop CLI stdout", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-cli-stop-noisy-plugin-"));
    try {
      await writeActiveAutopilotSession(cwd, "sess-cli-stop-noisy-plugin");
      await mkdir(join(cwd, ".omx", "hooks"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "hooks", "noisy.mjs"),
        `export async function onHookEvent(event) {
  if (event.event === "stop") console.log("PLUGIN_NOISE");
}
`,
        "utf-8",
      );

      const stdout = runNativeHookCli({
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-cli-stop-noisy-plugin",
        thread_id: "thread-cli-stop-noisy-plugin",
        turn_id: "turn-cli-stop-noisy-plugin",
      }, { cwd });
      assert.doesNotMatch(stdout, /PLUGIN_NOISE/);
      const output = parseSingleJsonStdout(stdout);

      assert.equal(output.decision, "block");
      assert.equal(output.stopReason, "autopilot_execution");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits deterministic Stop JSON stdout when Stop dispatch fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-cli-stop-dispatch-failure-"));
    try {
      const stdout = runNativeHookCli({
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-cli-stop-dispatch-failure",
        thread_id: "thread-cli-stop-dispatch-failure",
        turn_id: "turn-cli-stop-dispatch-failure",
      }, {
        cwd,
        env: {
          ...process.env,
          NODE_ENV: "test",
          OMX_NATIVE_HOOK_TEST_THROW_STOP_DISPATCH: "1",
        },
      });
      const output = parseSingleJsonStdout(stdout);

      assert.equal(output.decision, "block");
      assert.equal(output.stopReason, "native_stop_dispatch_failure");
      assert.match(String(output.reason), /failed before normal continuation handling/);
      assert.match(String(output.systemMessage), /test-induced Stop dispatch failure/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("maps Codex events onto OMX logical surfaces", () => {
    assert.equal(mapCodexHookEventToOmxEvent("SessionStart"), "session-start");
    assert.equal(mapCodexHookEventToOmxEvent("UserPromptSubmit"), "keyword-detector");
    assert.equal(mapCodexHookEventToOmxEvent("PreToolUse"), "pre-tool-use");
    assert.equal(mapCodexHookEventToOmxEvent("PostToolUse"), "post-tool-use");
    assert.equal(mapCodexHookEventToOmxEvent("Stop"), "stop");
  });

  it("writes SessionStart state against the long-lived session owner pid and injects environment context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-start-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-start-1",
        },
        {
          cwd,
          sessionOwnerPid: 43210,
        },
      );

      assert.equal(result.omxEventName, "session-start");
      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /\[Execution environment\]/);
      assert.match(additionalContext, /native-hook \/ Codex App outside tmux/);
      assert.match(additionalContext, /omx team, omx hud, and omx quest(?:ion) need an attached tmux OMX CLI shell|omx team and omx hud need an attached tmux OMX CLI shell/);
      assert.match(additionalContext, /not available from this outside-tmux surface/);
      const sessionState = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "session.json"), "utf-8"),
      ) as { session_id?: string; native_session_id?: string; pid?: number };
      assert.equal(sessionState.session_id, "sess-start-1");
      assert.equal(sessionState.native_session_id, "sess-start-1");
      assert.equal(sessionState.pid, 43210);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves canonical OMX session scope when native SessionStart arrives with a different id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-reconcile-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const canonicalSessionId = "omx-launch-1";
      const nativeSessionId = "codex-native-1";
      await mkdir(join(stateDir, "sessions", canonicalSessionId), { recursive: true });
      await writeSessionStart(cwd, canonicalSessionId);
      await writeJson(join(stateDir, "sessions", canonicalSessionId, "hud-state.json"), {
        last_turn_at: "2026-04-10T00:00:00.000Z",
        turn_count: 1,
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: nativeSessionId,
        },
        {
          cwd,
          sessionOwnerPid: process.pid,
        },
      );

      const sessionState = JSON.parse(
        await readFile(join(stateDir, "session.json"), "utf-8"),
      ) as { session_id?: string; native_session_id?: string; pid?: number };
      assert.equal(sessionState.session_id, canonicalSessionId);
      assert.equal(sessionState.native_session_id, nativeSessionId);
      assert.equal(sessionState.pid, process.pid);

      const promptResult = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: nativeSessionId,
          thread_id: "thread-1",
          turn_id: "turn-1",
          prompt: "$ralplan fix hud scope drift",
        },
        { cwd },
      );

      assert.equal(promptResult.omxEventName, "keyword-detector");
      assert.equal(existsSync(join(stateDir, "sessions", canonicalSessionId, "skill-active-state.json")), true);
      assert.equal(existsSync(join(stateDir, "sessions", canonicalSessionId, "ralplan-state.json")), true);
      assert.equal(existsSync(join(stateDir, "sessions", nativeSessionId, "skill-active-state.json")), false);
      assert.equal(existsSync(join(stateDir, "sessions", nativeSessionId, "ralplan-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("describes attached tmux runtime in SessionStart context when TMUX is present", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-start-tmux-"));
    process.env.TMUX = "/tmp/tmux-attached";
    process.env.TMUX_PANE = "%11";
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-start-tmux-1",
        },
        {
          cwd,
          sessionOwnerPid: process.pid,
        },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /\[Execution environment\]/);
      assert.match(additionalContext, /attached tmux runtime/);
      assert.match(additionalContext, /omx team, omx hud, and omx quest(?:ion) are directly usable in this session/);
      assert.match(additionalContext, /visible renderer available from the current pane/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("describes direct CLI outside tmux in SessionStart context when the launch source is cli", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-start-cli-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-start-cli-1",
          source: "cli",
        },
        {
          cwd,
          sessionOwnerPid: process.pid,
        },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /\[Execution environment\]/);
      assert.match(additionalContext, /direct CLI outside tmux/);
      assert.doesNotMatch(additionalContext, /native-hook \/ Codex App outside tmux/);
      assert.match(additionalContext, /omx team, omx hud, and omx quest(?:ion) need an attached tmux OMX CLI shell|omx team and omx hud need an attached tmux OMX CLI shell/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("passes the canonical OMX session id when UserPromptSubmit revives HUD", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-session-revive-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const canonicalSessionId = "omx-launch-hud";
      const nativeSessionId = "codex-native-hud";
      await mkdir(join(stateDir, "sessions", canonicalSessionId), { recursive: true });
      await writeSessionStart(cwd, canonicalSessionId);

      let reconcileCall: { cwd: string; sessionId?: string } | null = null;
      const promptResult = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: nativeSessionId,
          thread_id: "thread-hud",
          turn_id: "turn-hud",
          prompt: "$ralplan fix orphaned hud session handoff",
        },
        {
          cwd,
          reconcileHudForPromptSubmitFn: async (hookCwd, deps = {}) => {
            reconcileCall = { cwd: hookCwd, sessionId: deps.sessionId };
            return { status: 'recreated', paneId: '%9', desiredHeight: 3, duplicateCount: 0 };
          },
        },
      );

      assert.equal(promptResult.omxEventName, "keyword-detector");
      assert.deepEqual(reconcileCall, { cwd, sessionId: canonicalSessionId });
      assert.equal(existsSync(join(stateDir, "sessions", canonicalSessionId, "skill-active-state.json")), true);
      assert.equal(existsSync(join(stateDir, "sessions", canonicalSessionId, "ralplan-state.json")), true);
      assert.equal(existsSync(join(stateDir, "sessions", nativeSessionId, "skill-active-state.json")), false);
      assert.equal(existsSync(join(stateDir, "sessions", nativeSessionId, "ralplan-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adds .omx/ to git info/exclude during SessionStart instead of mutating repo .gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-gitignore-"));
    try {
      await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
      execFileSync("git", ["init"], { cwd, stdio: "pipe" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-gitignore-1",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      assert.equal(result.omxEventName, "session-start");
      const gitignore = await readFile(join(cwd, ".gitignore"), "utf-8");
      assert.equal(gitignore, "node_modules/\n");
      const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf-8");
      assert.match(exclude, /(?:^|\n)\.omx\/\n/);
      assert.match(
        JSON.stringify(result.outputJson),
        /Added \.omx\/ to .*\.git[\/]info[\/]exclude/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps SessionStart quiet when .omx/ is already ignored by repo-level gitignore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-existing-ignore-"));
    try {
      await writeFile(join(cwd, ".gitignore"), "node_modules/\n.omx/\n");
      execFileSync("git", ["init"], { cwd, stdio: "pipe" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-gitignore-existing",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      assert.equal(result.omxEventName, "session-start");
      const gitignore = await readFile(join(cwd, ".gitignore"), "utf-8");
      assert.equal(gitignore, "node_modules/\n.omx/\n");
      const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf-8");
      assert.doesNotMatch(exclude, /(?:^|\n)\.omx\/\n/);
      assert.doesNotMatch(JSON.stringify(result.outputJson), /Added \.omx\//);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("respects existing Git ignore resolution before writing local excludes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-global-ignore-"));
    const excludesFile = join(cwd, "global-ignore");
    try {
      await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
      await writeFile(excludesFile, ".omx/\n");
      execFileSync("git", ["init"], { cwd, stdio: "pipe" });
      execFileSync("git", ["config", "core.excludesfile", excludesFile], { cwd, stdio: "pipe" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-gitignore-global",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      assert.equal(result.omxEventName, "session-start");
      const gitignore = await readFile(join(cwd, ".gitignore"), "utf-8");
      assert.equal(gitignore, "node_modules/\n");
      const exclude = await readFile(join(cwd, ".git", "info", "exclude"), "utf-8");
      assert.doesNotMatch(exclude, /(?:^|\n)\.omx\/\n/);
      assert.doesNotMatch(JSON.stringify(result.outputJson), /Added \.omx\//);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("includes persisted project-memory summary in SessionStart context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-memory-"));
    try {
      await writeJson(join(cwd, ".omx", "project-memory.json"), {
        techStack: "TypeScript + Node.js",
        build: "npm test",
        conventions: "small diffs, verify before claim",
        directives: [
          { directive: "Keep native Stop bounded to real continuation decisions.", priority: "high" },
        ],
        notes: [
          { category: "env", content: "Requires LOCAL_API_BASE for smoke tests", timestamp: new Date().toISOString() },
        ],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "sess-memory-1",
        },
        { cwd, sessionOwnerPid: 43210 },
      );

      const serialized = JSON.stringify(result.outputJson);
      assert.match(serialized, /\[Project memory\]/);
      assert.match(serialized, /TypeScript \+ Node\.js/);
      assert.match(serialized, /small diffs, verify before claim/);
      assert.match(serialized, /Keep native Stop bounded to real continuation decisions\./);
      assert.match(serialized, /Requires LOCAL_API_BASE for smoke tests/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("starts a fresh native session without inheriting stale task-scoped context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-session-isolation-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const priorSessionId = "omx-old-session";
      await mkdir(join(stateDir, "sessions", priorSessionId), { recursive: true });
      await writeSessionStart(cwd, priorSessionId, {
        nativeSessionId: "codex-native-old",
      });
      await writeJson(join(stateDir, "sessions", priorSessionId, "ralph-state.json"), {
        active: true,
        current_phase: "executing",
      });
      await writeJson(join(stateDir, "subagent-tracking.json"), {
        schemaVersion: 1,
        sessions: {
          [priorSessionId]: {
            session_id: priorSessionId,
            leader_thread_id: "leader-1",
            updated_at: new Date().toISOString(),
            threads: {
              "leader-1": {
                thread_id: "leader-1",
                kind: "leader",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
              "sub-1": {
                thread_id: "sub-1",
                kind: "subagent",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
            },
          },
        },
      });
      await writeFile(
        join(cwd, ".omx", "notepad.md"),
        [
          "# OMX Notepad",
          "",
          "## PRIORITY",
          "Preserve durable project guidance.",
          "",
          "## WORKING MEMORY",
          "[2026-04-06T00:33:44Z] stale UI rework context snapshot .omx/context/ui-rework-plan-01-20260406T003344Z.md",
        ].join("\n"),
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "codex-native-new",
        },
        {
          cwd,
          sessionOwnerPid: process.pid,
        },
      );

      const sessionState = JSON.parse(
        await readFile(join(stateDir, "session.json"), "utf-8"),
      ) as { session_id?: string; native_session_id?: string };
      assert.equal(sessionState.session_id, "codex-native-new");
      assert.equal(sessionState.native_session_id, "codex-native-new");

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /\[Execution environment\]/);
      assert.match(additionalContext, /native-hook \/ Codex App outside tmux/);
      assert.match(additionalContext, /\[Priority notes\]/);
      assert.match(additionalContext, /Preserve durable project guidance/);
      assert.doesNotMatch(additionalContext, /stale UI rework context snapshot/);
      assert.doesNotMatch(additionalContext, /\[Subagents\]/);
      assert.doesNotMatch(additionalContext, /ralph phase: executing/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves the Codex owner from ancestry without mistaking codex-native-hook wrappers for Codex", () => {
    const commands = new Map<number, string>([
      [2100, 'sh -c node "/repo/dist/scripts/codex-native-hook.js"'],
      [1100, 'node /usr/local/bin/codex.js'],
      [900, 'bash'],
    ]);
    const parents = new Map<number, number | null>([
      [2100, 1100],
      [1100, 900],
      [900, 1],
    ]);

    const resolved = resolveSessionOwnerPidFromAncestry(2100, {
      readParentPid: (pid) => parents.get(pid) ?? null,
      readProcessCommand: (pid) => commands.get(pid) ?? "",
    });

    assert.equal(resolved, 1100);
  });

  it("records keyword activation from UserPromptSubmit payloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
          prompt: "$ralplan implement issue #1307",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralplan");
      assert.ok(result.outputJson, "UserPromptSubmit should emit developer context");
      assert.match(JSON.stringify(result.outputJson), /skill: ralplan activated and initial state initialized at \.omx\/state\/sessions\/sess-1\/ralplan-state\.json; write subsequent updates via omx_state MCP\./);

      const statePath = join(cwd, ".omx", "state", "skill-active-state.json");
      assert.equal(existsSync(statePath), true);
      const state = JSON.parse(await readFile(statePath, "utf-8")) as {
        skill?: string;
        active?: boolean;
        initialized_mode?: string;
      };
      assert.equal(state.skill, "ralplan");
      assert.equal(state.active, true);
      assert.equal(state.initialized_mode, "ralplan");
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-1", "ralplan-state.json")), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records plugin-prefixed keyword activation from UserPromptSubmit payloads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-plugin-prefixed-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-plugin-1",
          thread_id: "thread-plugin-1",
          turn_id: "turn-plugin-1",
          prompt: "$oh-my-codex:ralplan implement issue #1307",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralplan");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /\$oh-my-codex:ralplan" -> ralplan/);
      assert.match(message, /skill: ralplan activated and initial state initialized at \.omx\/state\/sessions\/sess-plugin-1\/ralplan-state\.json; write subsequent updates via omx_state MCP\./);
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-plugin-1", "ralplan-state.json")), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("normalizes the Korean keyboard typo for ulw during UserPromptSubmit activation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-ulw-ko-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-ulw-ko",
          thread_id: "thread-ulw-ko",
          turn_id: "turn-ulw-ko",
          prompt: "ㅕㅣㅈ로 병렬 처리해줘",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ultrawork");
      assert.equal(result.skillState?.keyword, "ulw");
      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(additionalContext, /workflow keyword \"ulw\" -> ultrawork/);
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-ulw-ko", "ultrawork-state.json")), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adds ultrawork-specific activation guidance only for true ultrawork workflow activation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-ultrawork-routing-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-ultrawork-msg",
          thread_id: "thread-ultrawork-msg",
          turn_id: "turn-ultrawork-msg",
          prompt: "$ultrawork fan out the regression checks",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ultrawork");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /\$ultrawork" -> ultrawork/);
      assert.match(message, /ground the task before editing/i);
      assert.match(message, /define pass\/fail acceptance criteria/i);
      assert.match(message, /direct-tool plus background evidence lanes/i);
      assert.match(message, /Ralph owns persistence and the full verified-completion promise/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not activate Ralph workflow state from a plain conversational mention", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-ralph-plain-text-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-ralph-plain-text",
          thread_id: "thread-ralph-plain-text",
          turn_id: "turn-ralph-plain-text",
          prompt: "why does ralph keep blocking stop?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState, null);
      // Triage may inject advisory LIGHT/explore context for the question-shaped
      // prompt, but the invariant this test guards is that no Ralph workflow state
      // is seeded and no Ralph-activation message is emitted.
      const advisoryContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.doesNotMatch(advisoryContext, /skill:\s*ralph/i);
      assert.doesNotMatch(advisoryContext, /ralph-state\.json/i);
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-ralph-plain-text", "skill-active-state.json")), false);
      assert.equal(existsSync(join(cwd, ".omx", "state", "sessions", "sess-ralph-plain-text", "ralph-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adds execution handoff context for non-keyword prompts that authorize implementation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-execution-handoff-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const prompts = [
        "按照这个plan开始执行优化",
        "开始执行",
        "继续优化",
        "直接修复",
      ];

      for (const [index, prompt] of prompts.entries()) {
        const result = await dispatchCodexNativeHook(
          {
            hook_event_name: "UserPromptSubmit",
            cwd,
            session_id: `sess-exec-handoff-${index}`,
            thread_id: `thread-exec-handoff-${index}`,
            turn_id: `turn-exec-handoff-${index}`,
            prompt,
          },
          { cwd },
        );

        const message = String(
          (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
        );
        assert.match(message, /execution handoff/i, prompt);
        assert.match(message, /Do not restate the prior plan/i, prompt);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("adds latest-followup priority context for short same-thread follow-up prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-followup-priority-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-followup-priority",
          thread_id: "thread-followup-priority",
          turn_id: "turn-followup-priority",
          prompt: "这些优化都做了么",
        },
        { cwd },
      );

      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /same-thread follow-up/i);
      assert.match(message, /prefer it over older unresolved prompts/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("clarifies that prompt-side $ralph activation does not invoke the PRD-gated CLI path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-ralph-routing-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-ralph-msg",
          thread_id: "thread-ralph-msg",
          turn_id: "turn-ralph-msg",
          prompt: "$ralph continue verification",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralph");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /\$ralph" -> ralph/);
      assert.match(message, /skill: ralph activated and initial state initialized at \.omx\/state\/sessions\/sess-ralph-msg\/ralph-state\.json; write subsequent updates via omx_state MCP\./);
      assert.match(message, /Prompt-side `\$ralph` activation seeds Ralph workflow state only; it does not invoke `omx ralph`\./);
      assert.match(message, /Use `omx ralph --prd \.\.\.` only when you explicitly want the PRD-gated CLI startup path\./);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("clarifies that plugin-prefixed prompt-side $ralph activation does not invoke the PRD-gated CLI path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-plugin-ralph-routing-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-plugin-ralph-msg",
          thread_id: "thread-plugin-ralph-msg",
          turn_id: "turn-plugin-ralph-msg",
          prompt: "$oh-my-codex:ralph continue verification",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralph");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /\$oh-my-codex:ralph" -> ralph/);
      assert.match(message, /skill: ralph activated and initial state initialized at \.omx\/state\/sessions\/sess-plugin-ralph-msg\/ralph-state\.json; write subsequent updates via omx_state MCP\./);
      assert.match(message, /Prompt-side `\$ralph` activation seeds Ralph workflow state only; it does not invoke `omx ralph`\./);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps bare keep-going continuation on the active autopilot skill instead of denying with generic ralph overlap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-autopilot-bare-continuation-"));
    try {
      const sessionId = "sess-autopilot-cont";
      const sessionDir = join(cwd, ".omx", "state", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "autopilot",
        keyword: "$autopilot",
        phase: "planning",
        session_id: sessionId,
        active_skills: [
          { skill: "autopilot", phase: "planning", active: true, session_id: sessionId },
        ],
      });
      await writeJson(join(sessionDir, "autopilot-state.json"), {
        active: true,
        mode: "autopilot",
        current_phase: "execution",
        started_at: "2026-04-19T00:00:00.000Z",
        updated_at: "2026-04-19T00:10:00.000Z",
        session_id: sessionId,
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-autopilot-cont",
          turn_id: "turn-autopilot-cont",
          prompt: "\ keep going now",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "autopilot");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /"keep going" -> ralph/);
      assert.doesNotMatch(message, /denied workflow keyword/i);
      assert.doesNotMatch(message, /Unsupported workflow overlap: autopilot \+ ralph\./);
      assert.doesNotMatch(message, /Prompt-side `\$ralph` activation/);
      assert.equal(existsSync(join(sessionDir, "ralph-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("clarifies outside-tmux prompt-side deep-interview activation without pretending omx question is directly available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-deep-interview-routing-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-deep-interview-msg",
          thread_id: "thread-deep-interview-msg",
          turn_id: "turn-deep-interview-msg",
          prompt: "$deep-interview gather requirements",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "deep-interview");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /\$deep-interview" -> deep-interview/);
      assert.match(message, /skill: deep-interview activated and initial state initialized at \.omx\/state\/sessions\/sess-deep-interview-msg\/deep-interview-state\.json; write subsequent updates via omx_state MCP\./);
      assert.match(message, /Deep-interview is active, but this session is not attached to tmux/);
      assert.match(message, /Do not invoke `omx question`, `omx hud`, or `omx team`/);
      assert.match(message, /native structured question tool when available/);
      assert.match(message, /ask exactly one concise plain-text question/);
      assert.match(message, /no tmux question obligation should be created outside tmux/);
      assert.doesNotMatch(message, /OMX_QUESTION_RETURN_PANE=/);
      assert.doesNotMatch(message, /preserve the leader pane/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses native fallback deep-interview guidance on Windows outside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-deep-interview-routing-win32-"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-deep-interview-msg-win32",
          thread_id: "thread-deep-interview-msg-win32",
          turn_id: "turn-deep-interview-msg-win32",
          prompt: "$deep-interview gather requirements",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "deep-interview");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /Deep-interview is active, but this session is not attached to tmux/);
      assert.match(message, /native structured question tool when available/);
      assert.doesNotMatch(message, /OMX_QUESTION_RETURN_PANE=/);
      assert.doesNotMatch(message, /current-session CLI bridge command/);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("includes leader-pane preservation guidance when a pane hint is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-deep-interview-pane-hint-"));
    try {
      const sessionId = "sess-deep-interview-pane-hint";
      const sessionDir = join(cwd, ".omx", "state", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeJson(join(sessionDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        started_at: "2026-04-21T10:00:00.000Z",
        updated_at: "2026-04-21T10:00:00.000Z",
        tmux_pane_id: "%77",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-deep-interview-pane-hint",
          turn_id: "turn-deep-interview-pane-hint",
          prompt: "$deep-interview gather requirements",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "deep-interview");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /not attached to tmux/);
      assert.match(message, /native structured question tool when available/);
      assert.match(message, /tmux return bridge \(%77\) is recorded/);
      assert.doesNotMatch(message, /current-session CLI bridge command/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("uses native fallback guidance on Windows when a pane hint is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-deep-interview-pane-hint-win32-"));
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const sessionId = "sess-deep-interview-pane-hint-win32";
      const sessionDir = join(cwd, ".omx", "state", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeJson(join(sessionDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        started_at: "2026-04-21T10:00:00.000Z",
        updated_at: "2026-04-21T10:00:00.000Z",
        tmux_pane_id: "%77",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-deep-interview-pane-hint-win32",
          turn_id: "turn-deep-interview-pane-hint-win32",
          prompt: "$deep-interview gather requirements",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "deep-interview");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /not attached to tmux/);
      assert.match(message, /native structured question tool when available/);
      assert.match(message, /tmux return bridge \(%77\) is recorded/);
      assert.doesNotMatch(message, /OMX_QUESTION_RETURN_PANE=/);
      assert.doesNotMatch(message, /PowerShell\/background-terminal/);
    } finally {
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps bare keep-going continuation on the active ralph skill without resetting through generic keep-going routing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-ralph-bare-continuation-"));
    try {
      const sessionId = "sess-ralph-cont";
      const sessionDir = join(cwd, ".omx", "state", "sessions", sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "ralph",
        keyword: "$ralph",
        phase: "executing",
        session_id: sessionId,
        active_skills: [
          { skill: "ralph", phase: "executing", active: true, session_id: sessionId },
        ],
      });
      await writeJson(join(sessionDir, "ralph-state.json"), {
        active: true,
        mode: "ralph",
        current_phase: "verifying",
        started_at: "2026-04-19T00:00:00.000Z",
        updated_at: "2026-04-19T00:10:00.000Z",
        iteration: 4,
        max_iterations: 50,
        session_id: sessionId,
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-ralph-cont",
          turn_id: "turn-ralph-cont",
          prompt: "keep going now",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "ralph");
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /"keep going" -> ralph/);
      assert.doesNotMatch(message, /denied workflow keyword/i);
      assert.doesNotMatch(message, /mode transiting:/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("ignores generic wrapper fields so metadata cannot trigger workflow routing or Stop blocking", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-wrapper-metadata-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const promptResult = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-wrapper-meta-1",
          thread_id: "thread-wrapper-meta-1",
          turn_id: "turn-wrapper-meta-1",
          input: "$ralplan hidden wrapper text should stay non-routing",
          text: JSON.stringify({
            hook_run_id: "native-stop-wrapper-1",
            note: "cancel stop wrapper metadata must not be treated like user intent",
          }),
        },
        { cwd },
      );

      assert.equal(promptResult.omxEventName, "keyword-detector");
      assert.equal(promptResult.skillState, null);
      assert.equal(promptResult.outputJson, null);
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);

      const stopResult = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-wrapper-meta-1",
          thread_id: "thread-wrapper-meta-1",
          turn_id: "turn-wrapper-meta-2",
        },
        { cwd },
      );

      assert.equal(stopResult.omxEventName, "stop");
      assert.equal(stopResult.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not expose submitted prompt text to keyword-detector hook plugins", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-prompt-sanitized-"));
    try {
      await mkdir(join(cwd, ".omx", "hooks"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "hooks", "capture-keyword-context.mjs"),
        `import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function onHookEvent(event) {
  if (event.event !== "keyword-detector") return;
  const outPath = join(process.cwd(), ".omx", "captured-keyword-context.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(event.context, null, 2));
}
`,
        "utf-8",
      );

      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-sanitized-1",
          thread_id: "thread-sanitized-1",
          turn_id: "turn-sanitized-1",
          prompt: "$ralplan approve this blocker-sensitive request",
        },
        { cwd },
      );

      const captured = JSON.parse(
        await readFile(join(cwd, ".omx", "captured-keyword-context.json"), "utf-8"),
      ) as { prompt?: string; payload?: Record<string, unknown> };

      assert.equal(captured.prompt, undefined);
      assert.equal(captured.payload?.prompt, undefined);
      assert.equal(captured.payload?.input, undefined);
      assert.equal(captured.payload?.user_prompt, undefined);
      assert.equal(captured.payload?.userPrompt, undefined);
      assert.equal(captured.payload?.text, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not emit UserPromptSubmit routing context for unknown $tokens", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-unknown-token-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-unknown-1",
          thread_id: "thread-unknown-1",
          turn_id: "turn-unknown-1",
          prompt: "$maer-thinking 다시 설명해봐",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState, null);
      assert.equal(result.outputJson, null);
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not emit UserPromptSubmit routing context for unknown plugin-prefixed $tokens", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-unknown-plugin-token-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-unknown-plugin-1",
          thread_id: "thread-unknown-plugin-1",
          turn_id: "turn-unknown-plugin-1",
          prompt: "$oh-my-codex:maer-thinking 다시 설명해봐",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState, null);
      assert.equal(result.outputJson, null);
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("denies direct $team prompt activation from Codex App/native outside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-native-block-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          source: "codex-app",
          session_id: "sess-team-1",
          thread_id: "thread-team-1",
          turn_id: "turn-team-1",
          prompt: "$team ship this fix with verification",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "team");
      assert.equal(result.skillState?.active, false);
      assert.match(String(result.skillState?.transition_error || ""), /cannot activate the tmux-only `team` workflow directly/);
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(message, /denied workflow keyword "\$team" -> team/);
      assert.match(message, /attached tmux shell first/);
      assert.equal(existsSync(join(cwd, ".omx", "state", "team-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still denies direct $team prompt activation from Codex App/native outside tmux when a tmux return bridge exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-native-bridge-block-"));
    try {
      await mkdir(join(cwd, ".omx", "state", "sessions", "sess-team-bridge"), { recursive: true });
      await writeJson(join(cwd, ".omx", "state", "sessions", "sess-team-bridge", "ralph-state.json"), {
        mode: "ralph",
        active: true,
        tmux_pane_id: "%42",
      });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          source: "codex-app",
          session_id: "sess-team-bridge",
          thread_id: "thread-team-bridge",
          turn_id: "turn-team-bridge",
          prompt: "$team ship this fix with verification",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.skill, "team");
      assert.equal(result.skillState?.active, false);
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(message, /attached tmux shell first/);
      assert.equal(existsSync(join(cwd, ".omx", "state", "team-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps direct CLI outside-tmux $team prompt guidance compatible with manual shell launch", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-cli-guidance-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          source: "cli",
          session_id: "sess-team-cli-guidance",
          thread_id: "thread-team-cli-guidance",
          turn_id: "turn-team-cli-guidance",
          prompt: "$team ship this fix with verification",
        },
        { cwd },
      );

      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(message, /run `omx team \.\.\.` yourself from shell/);
      assert.doesNotMatch(message, /not directly available here/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps $team prompt-submit routing directly tmux-capable when already inside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-tmux-"));
    process.env.TMUX = "/tmp/tmux-live";
    process.env.TMUX_PANE = "%5";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-team-tmux-1",
          thread_id: "thread-team-tmux-1",
          turn_id: "turn-team-tmux-1",
          prompt: "$team ship this fix with verification",
        },
        { cwd },
      );

      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(message, /Use the durable OMX team runtime via `omx team \.\.\.`/);
      assert.match(message, /run `omx team --help` yourself/);
      assert.doesNotMatch(message, /not directly available here/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns actionable denial guidance for unsupported workflow overlaps on prompt submit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-transition-deny-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-deny-1",
          thread_id: "thread-deny-1",
          turn_id: "turn-deny-1",
          prompt: "$team ship this fix",
        },
        { cwd },
      );

      const denied = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-deny-1",
          thread_id: "thread-deny-1",
          turn_id: "turn-deny-2",
          prompt: "$autopilot also run this",
        },
        { cwd },
      );

      assert.match(JSON.stringify(denied.outputJson), /denied workflow keyword/i);
      assert.match(JSON.stringify(denied.outputJson), /Unsupported workflow overlap: team \+ autopilot\./);
      assert.match(JSON.stringify(denied.outputJson), /`omx state clear --mode <mode>`/);
      assert.match(JSON.stringify(denied.outputJson), /`omx_state\.\*` MCP tools/);
      assert.equal(
        existsSync(join(cwd, ".omx", "state", "sessions", "sess-deny-1", "autopilot-state.json")),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("surfaces transition success output for allowlisted prompt-submit handoffs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-transition-success-"));
    try {
      const sessionDir = join(cwd, ".omx", "state", "sessions", "sess-handoff-1");
      await mkdir(sessionDir, { recursive: true });
      await writeJson(join(sessionDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-handoff-1",
        active_skills: [{ skill: "deep-interview", phase: "planning", active: true, session_id: "sess-handoff-1" }],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-handoff-1",
          thread_id: "thread-handoff-1",
          turn_id: "turn-handoff-1",
          prompt: "$ralplan implement the approved contract",
        },
        { cwd },
      );

      assert.match(JSON.stringify(result.outputJson), /mode transiting: deep-interview -> ralplan/);
      const completed = JSON.parse(await readFile(join(sessionDir, "deep-interview-state.json"), "utf-8")) as {
        active?: boolean;
        current_phase?: string;
      };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, "completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the planning skill active when planning and execution workflows are invoked together", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-planning-precedence-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-multi-1",
          thread_id: "thread-multi-1",
          turn_id: "turn-multi-1",
          prompt: "$ralplan $team $ralph ship this fix",
        },
        { cwd },
      );

      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || '',
      );
      assert.match(message, /\$ralplan" -> ralplan/);
      assert.match(message, /\$team" -> team/);
      assert.match(message, /\$ralph" -> ralph/);
      assert.doesNotMatch(message, /mode transiting:/);
      assert.match(message, /planning preserved over simultaneous execution follow-up; deferred skills: team, ralph\./);
      assert.match(message, /skill: ralplan activated and initial state initialized at \.omx\/state\/sessions\/sess-multi-1\/ralplan-state\.json; write subsequent updates via omx_state MCP\./);
      assert.doesNotMatch(message, /Use the durable OMX team runtime via `omx team \.\.\.`/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps the planning skill active for mixed plugin-prefixed and bare workflow invocations together", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-plugin-planning-precedence-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-plugin-multi-1",
          thread_id: "thread-plugin-multi-1",
          turn_id: "turn-plugin-multi-1",
          prompt: "$oh-my-codex:ralplan $team $oh-my-codex:ralph ship this fix",
        },
        { cwd },
      );

      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext || '',
      );
      assert.match(message, /\$oh-my-codex:ralplan" -> ralplan/);
      assert.match(message, /\$team" -> team/);
      assert.match(message, /\$oh-my-codex:ralph" -> ralph/);
      assert.doesNotMatch(message, /mode transiting:/);
      assert.match(message, /planning preserved over simultaneous execution follow-up; deferred skills: team, ralph\./);
      assert.match(message, /skill: ralplan activated and initial state initialized at \.omx\/state\/sessions\/sess-plugin-multi-1\/ralplan-state\.json; write subsequent updates via omx_state MCP\./);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs prompt-submit HUD reconciliation as a best-effort tmux-only side effect", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-reconcile-"));
    const originalTmux = process.env.TMUX;
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalPath = process.env.PATH;
    const originalArgv = process.argv;
    try {
      process.env.TMUX = "1";
      process.env.TMUX_PANE = "%1";
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "hud-config.json"),
        JSON.stringify({ preset: "focused", git: { display: "branch" } }, null, 2),
      );

      const binDir = await mkdtemp(join(tmpdir(), "omx-native-hook-hud-reconcile-bin-"));
      const tmuxLog = join(cwd, "tmux.log");
      await writeFile(
        join(binDir, "tmux"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(tmuxLog)}
case "$1" in
  list-panes)
    printf '%%1\\tcodex\\tcodex\\n'
    ;;
  display-message)
    printf '80\\t24\\n'
    ;;
  split-window)
    printf '%%9\\n'
    ;;
  resize-pane)
    ;;
esac
`,
      );
      await chmod(join(binDir, "tmux"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;
      process.argv = [originalArgv[0] || 'node', '/tmp/codex-host-binary'];

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-hud-1",
          prompt: "$ralplan prepare plan",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      const tmuxCalls = await readFile(tmuxLog, "utf-8");
      assert.match(tmuxCalls, /list-panes -t %1 -F/);
      assert.match(tmuxCalls, /split-window -v -l 3 -d -t %1 -c/);
      assert.match(tmuxCalls, /resize-pane -t %9 -y 3/);
      assert.match(tmuxCalls, /dist\/cli\/omx\.js' hud --watch --preset=focused/);
      assert.doesNotMatch(tmuxCalls, /\/tmp\/codex-host-binary' hud --watch/);
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      if (originalTmuxPane === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = originalTmuxPane;
      }
      process.env.PATH = originalPath;
      process.argv = originalArgv;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Bash omx question when no leader-pane return hint is preserved", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-enforce-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-block",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /OMX_QUESTION_RETURN_PANE=\$TMUX_PANE/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows Bash omx question when the command preserves the leader-pane return hint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-allow-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-allow",
          tool_input: { command: `OMX_QUESTION_RETURN_PANE=$TMUX_PANE omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows the quoted pane env assignment emitted by the deep-interview bridge command", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-quoted-allow-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-quoted-allow",
          tool_input: { command: `OMX_QUESTION_RETURN_PANE='%42' node ./dist/cli/omx.js question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows PowerShell env bridge forms for omx question return panes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-powershell-allow-"));
    try {
      const commands = [
        `$env:OMX_QUESTION_RETURN_PANE=$env:TMUX_PANE; omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'`,
        `$env:OMX_QUESTION_RETURN_PANE='%42'; node ./dist/cli/omx.js question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'`,
        `$env:OMX_LEADER_PANE_ID="%43"; omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'`,
      ];

      for (const [index, command] of commands.entries()) {
        const result = await dispatchCodexNativeHook(
          {
            hook_event_name: "PreToolUse",
            cwd,
            tool_name: "Bash",
            tool_use_id: `tool-question-powershell-allow-${index}`,
            tool_input: { command },
          },
          { cwd },
        );

        assert.equal(result.omxEventName, "pre-tool-use");
        assert.equal(result.outputJson, null);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows Bash omx question when a valid inherited OMX_QUESTION_RETURN_PANE bridge is already exported", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-env-allow-"));
    const originalReturnPane = process.env.OMX_QUESTION_RETURN_PANE;
    try {
      process.env.OMX_QUESTION_RETURN_PANE = "%42";
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-env-allow",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      if (originalReturnPane === undefined) delete process.env.OMX_QUESTION_RETURN_PANE;
      else process.env.OMX_QUESTION_RETURN_PANE = originalReturnPane;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows Bash omx question when a valid inherited OMX_LEADER_PANE_ID bridge is already exported", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-leader-env-allow-"));
    const originalLeaderPane = process.env.OMX_LEADER_PANE_ID;
    try {
      process.env.OMX_LEADER_PANE_ID = "%43";
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-leader-env-allow",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      if (originalLeaderPane === undefined) delete process.env.OMX_LEADER_PANE_ID;
      else process.env.OMX_LEADER_PANE_ID = originalLeaderPane;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("still blocks Bash omx question when an inherited OMX_QUESTION_RETURN_PANE value is malformed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-env-malformed-"));
    const originalReturnPane = process.env.OMX_QUESTION_RETURN_PANE;
    try {
      process.env.OMX_QUESTION_RETURN_PANE = "not-a-pane";
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-env-malformed",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
    } finally {
      if (originalReturnPane === undefined) delete process.env.OMX_QUESTION_RETURN_PANE;
      else process.env.OMX_QUESTION_RETURN_PANE = originalReturnPane;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Bash node omx.js question when the command does not preserve the leader-pane return hint", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-node-block-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-question-node-block",
          tool_input: { command: `node ./dist/cli/omx.js question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks native/App Bash omx question with bridge-specific outside-tmux guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-native-block-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-question-native-block",
          tool_name: "Bash",
          tool_use_id: "tool-question-native-block",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.equal((result.outputJson as { hookSpecificOutput?: unknown } | null)?.hookSpecificOutput, undefined);
      assert.match(String((result.outputJson as { reason?: string } | null)?.reason || ""), /Codex App\/native outside-tmux Bash sessions/);
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /native structured question tool/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks native/App Bash omx question even when the command preserves a tmux return bridge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-native-allow-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-question-native-bridge-block",
          tool_name: "Bash",
          tool_use_id: "tool-question-native-bridge-block",
          tool_input: { command: `OMX_QUESTION_RETURN_PANE=$TMUX_PANE omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /native structured question tool/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks native/App Bash omx question when a valid inherited OMX_QUESTION_RETURN_PANE bridge is already exported", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-question-native-env-allow-"));
    const originalReturnPane = process.env.OMX_QUESTION_RETURN_PANE;
    try {
      process.env.OMX_QUESTION_RETURN_PANE = "%42";
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-question-native-env-allow",
          tool_name: "Bash",
          tool_use_id: "tool-question-native-env-allow",
          tool_input: { command: `omx question --json --input '{"question":"Q?","options":["A"],"allow_other":true}'` },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
    } finally {
      if (originalReturnPane === undefined) delete process.env.OMX_QUESTION_RETURN_PANE;
      else process.env.OMX_QUESTION_RETURN_PANE = originalReturnPane;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Bash omx hud from Codex App/native outside tmux without PreToolUse additionalContext", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-hud-native-block-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-hud-native-block",
          tool_name: "Bash",
          tool_use_id: "tool-hud-native-block",
          tool_input: { command: "omx hud --tmux" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.equal((result.outputJson as { hookSpecificOutput?: unknown } | null)?.hookSpecificOutput, undefined);
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /attached tmux shell first/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Bash omx team from Codex App/native outside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-team-native-block-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-team-native-block",
          tool_name: "Bash",
          tool_use_id: "tool-team-native-block",
          tool_input: { command: "omx team status my-team" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.equal((result.outputJson as { hookSpecificOutput?: unknown } | null)?.hookSpecificOutput, undefined);
      assert.match(String((result.outputJson as { reason?: string } | null)?.reason || ""), /cannot be launched directly from Codex App\/native outside-tmux Bash sessions/);
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /launch OMX CLI from an attached tmux shell first/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Bash node omx.js team from Codex App/native outside tmux", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-team-node-native-block-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "codex-app",
          session_id: "sess-team-node-native-block",
          tool_name: "Bash",
          tool_use_id: "tool-team-node-native-block",
          tool_input: { command: "node ./dist/cli/omx.js team status my-team" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, "block");
      assert.match(String((result.outputJson as { systemMessage?: string } | null)?.systemMessage || ""), /Codex App\/native outside-tmux sessions/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves direct CLI outside-tmux omx team Bash behavior", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-team-cli-outside-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          source: "cli",
          session_id: "sess-team-cli-outside",
          tool_name: "Bash",
          tool_use_id: "tool-team-cli-outside",
          tool_input: { command: "omx team status my-team" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves source-less outside-tmux omx team Bash behavior when no native session evidence exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-team-cli-nosource-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: "sess-team-cli-nosource",
          tool_name: "Bash",
          tool_use_id: "tool-team-cli-nosource",
          tool_input: { command: "omx team status my-team" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a destructive-command caution on PreToolUse for rm -rf dist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-danger-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-danger",
          tool_input: { command: "rm -rf dist" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
        },
        systemMessage:
          "Destructive Bash command detected (`rm -rf dist`). Confirm the target and expected side effects before running it.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for neutral pwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-neutral-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-neutral",
          tool_input: { command: "pwd" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse git commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-invalid",
          tool_input: { command: 'git commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for `git help commit`", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-help-commit-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-help-commit",
          tool_input: { command: "git help commit" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for `git config alias.ci commit`", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-config-alias-commit-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-config-alias-commit",
          tool_input: { command: "git config alias.ci commit" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for `git tag commit`", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-tag-commit-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-tag-commit",
          tool_input: { command: "git tag commit" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse env-prefixed git commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-env-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-env-invalid",
          tool_input: { command: 'HUSKY=0 git commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse git commit when git options appear before the real commit subcommand", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-option-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-option-invalid",
          tool_input: { command: 'git -c core.editor=true commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse env wrapper-prefixed git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-env-wrapper-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-env-wrapper-invalid",
          tool_input: { command: 'env git.exe commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-invalid",
          tool_input: { command: 'git.exe commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse env flag wrapper-prefixed git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-env-flag-wrapper-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-env-flag-wrapper-invalid",
          tool_input: { command: 'env -i PATH=/usr/bin git.exe commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse env value-taking wrapper-prefixed git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-env-value-wrapper-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-env-value-wrapper-invalid",
          tool_input: { command: 'env -u FOO git.exe commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse path-qualified Windows git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-windows-path-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-windows-path-invalid",
          tool_input: { command: '"C:/Program Files/Git/cmd/git.exe" commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse quoted backslash Windows git.exe commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-exe-commit-windows-backslash-path-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-exe-commit-windows-backslash-path-invalid",
          tool_input: { command: '"C:\\Program Files\\Git\\cmd\\git.exe" commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse path-qualified git commit when the inline message is not Lore-compliant", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-path-invalid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-path-invalid",
          tool_input: { command: '/usr/bin/git commit -m "fix tests"' },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add a blank line after the subject before the narrative body.",
            "- Add a narrative body paragraph explaining the decision context.",
            "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add a blank line after the subject before the narrative body.",
          "- Add a narrative body paragraph explaining the decision context.",
          "- Add at least one Lore trailer such as `Constraint:`, `Confidence:`, or `Tested:`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse git commit when the message comes from an external source", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-file-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-file",
          tool_input: { command: "git commit -F .git/COMMIT_EDITMSG" },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Use inline `git commit -m ...` paragraphs for Lore-format commits in this path; file/editor/reuse/fixup message sources are not inspectable safely from pre-tool-use enforcement.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Use inline `git commit -m ...` paragraphs for Lore-format commits in this path; file/editor/reuse/fixup message sources are not inspectable safely from pre-tool-use enforcement.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks PreToolUse git commit when Lore trailers exist but the OmX co-author trailer is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-missing-omx-coauthor-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-missing-omx-coauthor",
          tool_input: {
            command: [
              'git commit',
              '-m "Prevent invalid history from bypassing Lore enforcement"',
              '-m "The native pre-tool-use hook now blocks inline git commit messages that skip Lore trailers or the required OmX co-author trailer."',
              '-m "Constraint: Native PreToolUse can only inspect the Bash command text"',
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "git commit is blocked until the inline commit message satisfies the Lore format and includes the required OmX co-author trailer.",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: [
            "Lore-format git commit enforcement triggered.",
            "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          ].join("\n"),
        },
        systemMessage: [
          "git commit is blocked until the inline commit message follows the Lore protocol and includes `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
          "- Add the required co-author trailer: `Co-authored-by: OmX <omx@oh-my-codex.dev>`.",
        ].join("\n"),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on PreToolUse for Lore-compliant git commit with OmX co-author trailer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-git-commit-valid-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-valid",
          tool_input: {
            command: [
              'git commit',
              '-m "Prevent invalid history from bypassing Lore enforcement"',
              '-m "The native pre-tool-use hook now blocks inline git commit messages that skip Lore trailers or the required OmX co-author trailer."',
              '-m "Constraint: Native PreToolUse can only inspect the Bash command text"',
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
              '-m "Co-authored-by: OmX <omx@oh-my-codex.dev>"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("warns on PreToolUse git commit when mapped source changes lack staged docs refresh", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-document-refresh-warn-"));
    try {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      await writeFile(join(cwd, "README.md"), "base\n", "utf-8");
      execFileSync("git", ["add", "README.md", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-doc-refresh-warn",
          tool_input: {
            command: [
              'git commit',
              '-m "Keep native hooks aligned with docs"',
              '-m "Update the stop hook internals without refreshing the operator docs yet."',
              '-m "Constraint: native hook warning MVP must remain non-blocking on commit path"',
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
              '-m "Co-authored-by: OmX <omx@oh-my-codex.dev>"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "pre-tool-use");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, undefined);
      assert.equal((result.outputJson as { hookSpecificOutput?: { hookEventName?: string } } | null)?.hookSpecificOutput?.hookEventName, "PreToolUse");
      assert.match(JSON.stringify(result.outputJson), /Document-refresh warning/);
      assert.match(JSON.stringify(result.outputJson), /docs\/codex-native-hooks\.md/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not warn on PreToolUse when relevant docs are staged", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-document-refresh-docs-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      await mkdir(join(cwd, "docs"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      await writeFile(join(cwd, "docs", "codex-native-hooks.md"), "initial\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts", "docs/codex-native-hooks.md"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");
      await writeFile(join(cwd, "docs", "codex-native-hooks.md"), "updated\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts", "docs/codex-native-hooks.md"], { cwd, stdio: "ignore" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-doc-refresh-docs",
          tool_input: {
            command: [
              'git commit',
              '-m "Keep native hooks aligned with docs"',
              '-m "Update the stop hook internals and refresh the native hook docs together."',
              '-m "Constraint: native hook warning MVP must remain non-blocking on commit path"',
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
              '-m "Co-authored-by: OmX <omx@oh-my-codex.dev>"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not run commit-path document-refresh against payload cwd when git -C targets another repo", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-document-refresh-chdir-"));
    const otherRepo = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-document-refresh-other-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });

      execFileSync("git", ["init"], { cwd: otherRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: otherRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: otherRepo, stdio: "ignore" });
      await writeFile(join(otherRepo, "README.md"), "base\n", "utf-8");
      execFileSync("git", ["add", "README.md"], { cwd: otherRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: otherRepo, stdio: "ignore" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-doc-refresh-chdir",
          tool_input: {
            command: [
              `git -C ${JSON.stringify(otherRepo)}`,
              'commit',
              '-m "Keep native hooks aligned with docs"',
              '-m "Document-refresh check should not inspect the caller cwd when commit targets another repo."',
              '-m "Constraint: alternate git targets are skipped unless hook-side repo resolution is added explicitly"',
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
              '-m "Co-authored-by: OmX <omx@oh-my-codex.dev>"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  it("suppresses PreToolUse document-refresh warning when commit message includes an exemption", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-pretool-document-refresh-exempt-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-git-commit-doc-refresh-exempt",
          tool_input: {
            command: [
              'git commit',
              '-m "Keep native hooks aligned with docs"',
              '-m "Update the stop hook internals without docs refresh because behavior is internal-only."',
              '-m "Constraint: native hook warning MVP must remain non-blocking on commit path"',
              `-m "${DOCUMENT_REFRESH_EXEMPTION_PREFIX} internal-only behavior verified"`,
              '-m "Tested: node --test dist/scripts/__tests__/codex-native-hook.test.js"',
              '-m "Co-authored-by: OmX <omx@oh-my-codex.dev>"',
            ].join(" "),
          },
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns PostToolUse remediation guidance for command-not-found output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-failure-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-fail",
          tool_input: { command: "foo --version" },
          tool_response: "{\"exit_code\":127,\"stdout\":\"\",\"stderr\":\"bash: foo: command not found\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash output indicates a command/setup failure that should be fixed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "Bash reported `command not found`, `permission denied`, or a missing file/path. Verify the command, dependency installation, PATH, file permissions, and referenced paths before retrying.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent when successful search output contains old Bash failure text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-successful-search-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-search-log",
          tool_input: { command: "rg 'command not found' .omx/logs" },
          tool_response: JSON.stringify({
            exit_code: 0,
            stdout: "old-session.log: bash: foo: command not found",
            stderr: "",
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent for rc-zero build logs that mention missing grep paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-build-log-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-build-log",
          tool_input: { command: "npm run build" },
          tool_response: JSON.stringify({
            exit_code: 0,
            stdout: "build passed\nnote: grep fixture says no such file or directory",
            stderr: "",
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent when successful output includes prior hook context text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-recursive-context-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-hook-context",
          tool_input: { command: "cat transcript.txt" },
          tool_response: JSON.stringify({
            exit_code: 0,
            stdout:
              "Bash reported `command not found`, `permission denied`, or a missing file/path. Verify the command, dependency installation, PATH, file permissions, and referenced paths before retrying.",
            stderr: "",
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns PostToolUse MCP transport fallback guidance for clear MCP transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-transport-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-transport",
          tool_input: { mode: "team", active: true },
          tool_response: "{\"error\":\"MCP transport closed\",\"details\":\"stdio pipe closed before response\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      const output = result.outputJson as {
        decision?: string;
        reason?: string;
        hookSpecificOutput?: { additionalContext?: string };
      } | null;
      assert.equal(output?.decision, "block");
      assert.equal(
        output?.reason,
        "The MCP tool appears to have lost its transport/server connection. Preserve state, debug the transport failure, and use OMX CLI/file-backed fallbacks instead of retrying blindly.",
      );
      const additionalContext = String(
        output?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(
        additionalContext,
        /omx state state_write --input/,
      );
      assert.match(
        additionalContext,
        /plain Node stdio processes/i,
      );
      assert.match(
        additionalContext,
        /read-stall-state/,
      );
      assert.match(
        additionalContext,
        /OMX_MCP_TRANSPORT_DEBUG=1/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not classify non-transport MCP failures as transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-nontransport-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-nontransport",
          tool_input: { active: true },
          tool_response: "{\"error\":\"validation failed\",\"details\":\"mode is required\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks active team state failed on MCP transport death without deleting team state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-mcp-transport-"));
    const previousCwd = process.cwd();
    try {
      process.chdir(cwd);
      await initTeamState(
        "transport-team",
        "task",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-transport" },
      );
      await writeJson(join(cwd, ".omx", "state", "team-state.json"), {
        active: true,
        team_name: "transport-team",
        current_phase: "team-exec",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-transport",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-transport-team",
          tool_input: { mode: "team", active: true },
          tool_response: "{\"error\":\"MCP transport closed\",\"details\":\"stdio pipe closed before response\"}",
        },
        { cwd },
      );

      const phase = await readTeamPhase("transport-team", cwd);
      const attention = await readTeamLeaderAttention("transport-team", cwd);
      assert.equal(phase?.current_phase, "failed");
      assert.equal(attention?.leader_attention_reason, "mcp_transport_dead");
      assert.equal(attention?.leader_attention_pending, true);
      assert.equal(existsSync(join(cwd, ".omx", "state", "team", "transport-team")), true);
    } finally {
      process.chdir(previousCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks canonical team state failed when native payload session ids differ during MCP transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-team-native-transport-"));
    const previousCwd = process.cwd();
    const canonicalSessionId = "omx-canonical-session";
    const nativeSessionId = "codex-native-session";
    try {
      process.chdir(cwd);
      await writeSessionStart(cwd, canonicalSessionId);
      const sessionPath = join(cwd, ".omx", "state", "session.json");
      const sessionState = JSON.parse(
        await readFile(sessionPath, "utf-8"),
      ) as { session_id?: string; native_session_id?: string };
      await writeFile(
        sessionPath,
        JSON.stringify(
          {
            ...sessionState,
            native_session_id: nativeSessionId,
          },
          null,
          2,
        ),
      );

      await initTeamState(
        "transport-team",
        "task",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: canonicalSessionId },
      );
      await writeJson(join(cwd, ".omx", "state", "team-state.json"), {
        active: true,
        team_name: "transport-team",
        current_phase: "team-exec",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: nativeSessionId,
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-transport-team-native",
          tool_input: { mode: "team", active: true },
          tool_response: "{\"error\":\"MCP transport closed\",\"details\":\"stdio pipe closed before response\"}",
        },
        { cwd },
      );

      const phase = await readTeamPhase("transport-team", cwd);
      const attention = await readTeamLeaderAttention("transport-team", cwd);
      assert.equal(phase?.current_phase, "failed");
      assert.equal(attention?.leader_attention_reason, "mcp_transport_dead");
      assert.equal(attention?.leader_attention_pending, true);
      assert.equal(attention?.leader_session_id, canonicalSessionId);
    } finally {
      process.chdir(previousCwd);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats stderr-only informative non-zero output as reviewable instead of a generic failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-informative-stderr-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-useful-stderr",
          tool_input: { command: "gh pr checks" },
          tool_response: "{\"exit_code\":8,\"stdout\":\"\",\"stderr\":\"build pending\\nlint pass\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats non-zero gh pr checks style output as informative instead of a generic failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-informative-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-useful",
          tool_input: { command: "gh pr checks" },
          tool_response: "{\"exit_code\":8,\"stdout\":\"build\\tpending\\t2m\\nlint\\tpass\\t18s\",\"stderr\":\"\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The Bash command returned a non-zero exit code but produced useful output that should be reviewed before retrying.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "The Bash output appears informative despite the non-zero exit code. Review and report the output before retrying instead of assuming the command simply failed.",
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns MCP transport-death guidance and preserves failed team state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-dead-"));
    try {
      await initTeamState(
        "mcp-transport-dead-team",
        "transport failure fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-mcp-dead" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-mcp-dead",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-dead",
          tool_response: JSON.stringify({
            error: "transport closed",
            message: "MCP server disconnected",
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason || ""), /lost its transport\/server connection/);
      const hookSpecificOutput = result.outputJson?.hookSpecificOutput as {
        hookEventName?: string;
        additionalContext?: string;
      } | undefined;
      assert.equal(hookSpecificOutput?.hookEventName, "PostToolUse");
      assert.match(
        String(hookSpecificOutput?.additionalContext || ""),
        /Retry via CLI parity with `omx state state_write --input '\{\}' --json`\./,
      );
      assert.match(
        String(hookSpecificOutput?.additionalContext || ""),
        /omx team api read-stall-state/,
      );

      const phase = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "team", "mcp-transport-dead-team", "phase.json"), "utf-8"),
      ) as { current_phase?: string; transitions?: Array<{ reason?: string }> };
      assert.equal(phase.current_phase, "failed");
      assert.equal(phase.transitions?.at(-1)?.reason, "mcp_transport_dead");

      const attention = JSON.parse(
        await readFile(join(cwd, ".omx", "state", "team", "mcp-transport-dead-team", "leader-attention.json"), "utf-8"),
      ) as { leader_attention_reason?: string; attention_reasons?: string[] };
      assert.equal(attention.leader_attention_reason, "mcp_transport_dead");
      assert.ok(attention.attention_reasons?.includes("mcp_transport_dead"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stays silent on neutral successful PostToolUse output", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-neutral-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          tool_name: "Bash",
          tool_use_id: "tool-ok",
          tool_input: { command: "pwd" },
          tool_response: "{\"exit_code\":0,\"stdout\":\"/repo\",\"stderr\":\"\"}",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns CLI fallback guidance and preserves failed team state on clear MCP transport death", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-posttool-mcp-transport-"));
    try {
      await initTeamState(
        "transport-team",
        "transport failure fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-mcp-transport" },
      );
      await writeJson(join(cwd, ".omx", "state", "team-state.json"), {
        active: true,
        team_name: "transport-team",
        current_phase: "team-exec",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PostToolUse",
          cwd,
          session_id: "sess-stop-mcp-transport",
          tool_name: "mcp__omx_state__state_write",
          tool_use_id: "tool-mcp-fail",
          tool_input: { mode: "team", active: true },
          tool_response: JSON.stringify({
            error: "MCP transport closed unexpectedly",
            exit_code: 1,
          }),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "post-tool-use");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "The MCP tool appears to have lost its transport/server connection. Preserve state, debug the transport failure, and use OMX CLI/file-backed fallbacks instead of retrying blindly.",
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext:
            "Clear MCP transport-death signal detected. Preserve current team/runtime state. Retry via CLI parity with `omx state state_write --input '{\"mode\":\"team\",\"active\":true}' --json`. OMX MCP servers are plain Node stdio processes, so they still shut down when stdin/transport closes. If this happened during team runtime, inspect first with `omx team status <team>` or `omx team api read-stall-state --input '{\"team_name\":\"<team>\"}' --json`, and only force cleanup after capturing needed state. For root-cause debugging, rerun with `OMX_MCP_TRANSPORT_DEBUG=1` to log why the stdio transport closed.",
        },
      });

      const phase = await readTeamPhase("transport-team", cwd);
      const attention = await readTeamLeaderAttention("transport-team", cwd);
      assert.equal(phase?.current_phase, "failed");
      assert.equal(attention?.leader_attention_reason, "mcp_transport_dead");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Autopilot is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autopilot-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "autopilot-state.json"), {
        active: true,
        current_phase: "execution",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-autopilot",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX autopilot is still active (phase: execution); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "autopilot_execution",
        systemMessage: "OMX autopilot is still active (phase: execution).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate Autopilot planning Stop replays so stale planning state cannot loop indefinitely", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autopilot-planning-replay-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "autopilot-state.json"), {
        active: true,
        current_phase: "planning",
      });
      const payload = {
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-stop-autopilot-planning-replay",
        thread_id: "thread-stop-autopilot-planning-replay",
        turn_id: "turn-stop-autopilot-planning-replay",
        last_assistant_message: "Autopilot planning is still active.",
      };

      const first = await dispatchCodexNativeHook(payload, { cwd });
      const replay = await dispatchCodexNativeHook(
        {
          ...payload,
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(first.omxEventName, "stop");
      assert.deepEqual(first.outputJson, {
        decision: "block",
        reason:
          "OMX autopilot is still active (phase: planning); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "autopilot_planning",
        systemMessage: "OMX autopilot is still active (phase: planning).",
      });
      assert.equal(replay.omxEventName, "stop");
      assert.equal(replay.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from stale root Autopilot planning state when the explicit session has no scoped state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-root-autopilot-planning-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current", cwd });
      await writeJson(join(stateDir, "autopilot-state.json"), {
        active: true,
        mode: "autopilot",
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop when an explicit blocked_on_user run_outcome is present on a mode state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autopilot-blocked-outcome-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "autopilot-state.json"), {
        active: true,
        current_phase: "execution",
        run_outcome: "blocked_on_user",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-autopilot-blocked-outcome",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Ultrawork is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ultrawork-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "ultrawork-state.json"), {
        active: true,
        current_phase: "executing",
      });

      const result = await dispatchCodexNativeHook(
        { hook_event_name: "Stop", cwd, session_id: "sess-stop-ultrawork" },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX ultrawork is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ultrawork_executing",
        systemMessage: "OMX ultrawork is still active (phase: executing).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while UltraQA is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ultraqa-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "ultraqa-state.json"), {
        active: true,
        current_phase: "diagnose",
      });

      const result = await dispatchCodexNativeHook(
        { hook_event_name: "Stop", cwd, session_id: "sess-stop-ultraqa" },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX ultraqa is still active (phase: diagnose); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ultraqa_diagnose",
        systemMessage: "OMX ultraqa is still active (phase: diagnose).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while team phase is non-terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "team-exec",
        team_name: "review-team",
      });
      await writeJson(join(stateDir, "team", "review-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (review-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop for a team worker with a non-terminal assigned task via native worker context", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-worker-"));
    const prevTeamWorker = process.env.OMX_TEAM_WORKER;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const prevLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    try {
      await initTeamState(
        "worker-stop-team",
        "worker stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-worker" },
      );
      const workerDir = join(cwd, ".omx", "state", "team", "worker-stop-team", "workers", "worker-1");
      await writeJson(join(workerDir, "status.json"), {
        state: "idle",
        current_task_id: "1",
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(cwd, ".omx", "state", "team", "worker-stop-team", "tasks", "task-1.json"), {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "in_progress",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });

      process.env.OMX_TEAM_WORKER = "worker-stop-team/worker-1";
      process.env.OMX_TEAM_STATE_ROOT = join(cwd, ".omx", "state");
      process.env.OMX_TEAM_LEADER_CWD = cwd;

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd: join(cwd, ".omx", "team", "worker-stop-team", "worktrees", "worker-1"),
          session_id: "sess-stop-team-worker",
        },
        { cwd: join(cwd, ".omx", "team", "worker-stop-team", "worktrees", "worker-1") },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX team worker worker-1 is still assigned non-terminal task 1 (in_progress); continue the current assigned task or report a concrete blocker before stopping.",
        stopReason: "team_worker_worker-1_1_in_progress",
        systemMessage: "OMX team worker worker-1 is still assigned task 1 (in_progress).",
      });
    } finally {
      if (typeof prevTeamWorker === "string") process.env.OMX_TEAM_WORKER = prevTeamWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof prevLeaderCwd === "string") process.env.OMX_TEAM_LEADER_CWD = prevLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses identical team worker Stop replays but re-blocks fresh turns and task state changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-worker-repeat-"));
    try {
      await initTeamState(
        "worker-repeat-team",
        "worker stop repeat guard",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-worker-repeat" },
      );
      const stateDir = join(cwd, ".omx", "state");
      const workerDir = join(stateDir, "team", "worker-repeat-team", "workers", "worker-1");
      const taskPath = join(stateDir, "team", "worker-repeat-team", "tasks", "task-1.json");
      await writeJson(join(workerDir, "status.json"), {
        state: "idle",
        current_task_id: "1",
        updated_at: new Date().toISOString(),
      });
      await writeJson(taskPath, {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "in_progress",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });

      process.env.OMX_TEAM_WORKER = "worker-repeat-team/worker-1";
      process.env.OMX_TEAM_STATE_ROOT = stateDir;
      process.env.OMX_TEAM_LEADER_CWD = cwd;

      const workerCwd = join(cwd, ".omx", "team", "worker-repeat-team", "worktrees", "worker-1");
      const basePayload = {
        hook_event_name: "Stop",
        cwd: workerCwd,
        session_id: "sess-stop-team-worker-repeat",
        thread_id: "thread-stop-team-worker-repeat",
        turn_id: "turn-stop-team-worker-repeat-1",
        last_assistant_message: "I need to stop before this task is done.",
      };
      const expectedInProgress = {
        decision: "block",
        reason:
          "OMX team worker worker-1 is still assigned non-terminal task 1 (in_progress); continue the current assigned task or report a concrete blocker before stopping.",
        stopReason: "team_worker_worker-1_1_in_progress",
        systemMessage: "OMX team worker worker-1 is still assigned task 1 (in_progress).",
      };

      const first = await dispatchCodexNativeHook(basePayload, { cwd: workerCwd });
      const replay = await dispatchCodexNativeHook(
        { ...basePayload, stop_hook_active: true },
        { cwd: workerCwd },
      );
      const freshTurn = await dispatchCodexNativeHook(
        { ...basePayload, turn_id: "turn-stop-team-worker-repeat-2", stop_hook_active: true },
        { cwd: workerCwd },
      );

      await writeJson(taskPath, {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "blocked",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });
      const stateChanged = await dispatchCodexNativeHook(
        { ...basePayload, turn_id: "turn-stop-team-worker-repeat-2", stop_hook_active: true },
        { cwd: workerCwd },
      );

      assert.deepEqual(first.outputJson, expectedInProgress);
      assert.deepEqual(replay.outputJson, null);
      assert.deepEqual(freshTurn.outputJson, expectedInProgress);
      assert.deepEqual(stateChanged.outputJson, {
        decision: "block",
        reason:
          "OMX team worker worker-1 is still assigned non-terminal task 1 (blocked); continue the current assigned task or report a concrete blocker before stopping.",
        stopReason: "team_worker_worker-1_1_blocked",
        systemMessage: "OMX team worker worker-1 is still assigned task 1 (blocked).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop for a team worker when assigned task is terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-worker-terminal-"));
    const prevTeamWorker = process.env.OMX_TEAM_WORKER;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState(
        "worker-stop-team-terminal",
        "worker stop terminal fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-worker-terminal" },
      );
      const workerDir = join(cwd, ".omx", "state", "team", "worker-stop-team-terminal", "workers", "worker-1");
      await writeJson(join(workerDir, "status.json"), {
        state: "done",
        current_task_id: "1",
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(cwd, ".omx", "state", "team", "worker-stop-team-terminal", "tasks", "task-1.json"), {
        id: "1",
        subject: "hook task",
        description: "finish hook task",
        status: "completed",
        owner: "worker-1",
        created_at: new Date().toISOString(),
      });

      process.env.OMX_TEAM_WORKER = "worker-stop-team-terminal/worker-1";
      process.env.OMX_TEAM_STATE_ROOT = join(cwd, ".omx", "state");

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-worker-terminal",
        },
        { cwd },
      );

      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (worker-stop-team-terminal) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      if (typeof prevTeamWorker === "string") process.env.OMX_TEAM_WORKER = prevTeamWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state when coarse mode state is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-canonical-"));
    try {
      await initTeamState(
        "canonical-team",
        "canonical stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-canonical" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("emits one concise final decision summary and auto-finalize guidance when release-readiness already has a stable final recommendation and no active worker tasks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-release-readiness-finalize-"));
    try {
      await initTeamState(
        "release-ready-team",
        "release readiness finalize",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-release-ready" },
      );
      await writeReleaseReadinessLeaderAttention(
        "release-ready-team",
        "sess-stop-release-ready",
        cwd,
        { workRemaining: false },
      );
      await writeReleaseReadinessStateMarker(
        "sess-stop-release-ready",
        "release-ready-team",
        cwd,
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-release-ready",
          thread_id: "thread-stop-release-ready",
          turn_id: "turn-stop-release-ready-1",
          mode: "release-readiness",
          last_assistant_message: "Launch-ready: yes",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          'Stable final recommendation already reached with no active worker tasks. Emit exactly one concise final decision summary aligned to "Launch-ready: yes." with no filler or residual acknowledgements (for example "yes"), then stop.',
        stopReason: "release_readiness_auto_finalize",
        systemMessage:
          "OMX release-readiness detected a stable final recommendation with no active worker tasks; emit one concise final decision summary and finalize.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not auto-finalize non-release team stops that happen to contain a stable recommendation summary", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-non-release-readiness-control-"));
    try {
      await initTeamState(
        "general-review-team",
        "general team stop control",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-general-review" },
      );
      await writeReleaseReadinessLeaderAttention(
        "general-review-team",
        "sess-stop-general-review",
        cwd,
        { workRemaining: false },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-general-review",
          thread_id: "thread-stop-general-review",
          turn_id: "turn-stop-general-review-1",
          last_assistant_message: "Launch-ready: yes",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (general-review-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires canonical-team Stop output for a later fresh Stop reply when coarse mode state is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-canonical-refire-"));
    try {
      await initTeamState(
        "canonical-team-refire",
        "canonical stop fallback refire",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-canonical-refire" },
      );

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical-refire",
          thread_id: "thread-stop-team-canonical-refire",
          turn_id: "turn-stop-team-canonical-refire-1",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-canonical-refire",
          thread_id: "thread-stop-team-canonical-refire",
          turn_id: "turn-stop-team-canonical-refire-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-team-refire) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from canonical team state alone when the canonical phase is terminal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-terminal-"));
    try {
      await initTeamState(
        "terminal-team",
        "terminal stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-terminal" },
      );
      await writeJson(join(cwd, ".omx", "state", "team", "terminal-team", "phase.json"), {
        current_phase: "complete",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-terminal",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state when manifest session ownership is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-legacy-"));
    try {
      await initTeamState(
        "legacy-team",
        "legacy stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-legacy" },
      );
      const manifestPath = join(cwd, ".omx", "state", "team", "legacy-team", "manifest.v2.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as Record<string, unknown>;
      await writeJson(manifestPath, {
        ...manifest,
        leader: {
          ...(manifest.leader as Record<string, unknown> | undefined),
          session_id: "",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-legacy",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (legacy-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("reads canonical Stop fallback team state from OMX_TEAM_STATE_ROOT when configured", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-root-"));
    const sharedRoot = join(cwd, "shared-root");
    const priorTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_TEAM_STATE_ROOT = "shared-root";
      await initTeamState(
        "canonical-root-team",
        "canonical stop root fallback",
        "executor",
        1,
        cwd,
        undefined,
        { ...process.env, OMX_SESSION_ID: "sess-stop-team-root", OMX_TEAM_STATE_ROOT: "shared-root" },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-root",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (canonical-root-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
      assert.equal(existsSync(join(sharedRoot, "team", "canonical-root-team", "phase.json")), true);
    } finally {
      if (typeof priorTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = priorTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output from canonical team state rooted via OMX_TEAM_STATE_ROOT", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-env-root-"));
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_TEAM_STATE_ROOT = "shared-team-state";
      await initTeamState(
        "env-root-team",
        "env root stop fallback",
        "executor",
        1,
        cwd,
        undefined,
        {
          ...process.env,
          OMX_SESSION_ID: "sess-stop-team-env-root",
          OMX_TEAM_STATE_ROOT: "shared-team-state",
        },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-env-root",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (env-root-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      if (typeof previousTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop from session-scoped team mode when session.json points to another session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-session-mismatch-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-live-team"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-other-team" });
      await writeJson(join(stateDir, "sessions", "sess-live-team", "team-state.json"), {
        active: true,
        mode: "team",
        current_phase: "team-exec",
        team_name: "session-live-team",
      });
      await writeJson(join(stateDir, "team", "session-live-team", "phase.json"), {
        current_phase: "team-exec",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-live-team",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (session-live-team) at phase team-exec; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-exec",
        systemMessage: "OMX team pipeline is still active at phase team-exec.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output for active ralplan skill with matching active mode state and without active subagents", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-skill"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-skill" });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill", "ralplan-state.json"), {
        active: true,
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX skill ralplan is still active (phase: planning); continue until the current ralplan workflow reaches a terminal state.",
        stopReason: "skill_ralplan_planning",
        systemMessage: "OMX skill ralplan is still active (phase: planning).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on stale ralplan skill-active state when the matching mode state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-stale-skill"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-stale-skill" });
      await writeJson(join(stateDir, "sessions", "sess-stop-stale-skill", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
        session_id: "sess-stop-stale-skill",
        active_skills: [{
          skill: "ralplan",
          phase: "planning",
          active: true,
          session_id: "sess-stop-stale-skill",
        }],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-stale-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on active ralplan skill when subagents are still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-skill-subagent-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-skill-subagent"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-skill-subagent" });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-subagent", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-subagent", "ralplan-state.json"), {
        active: true,
        current_phase: "planning",
      });
      await writeJson(join(stateDir, "subagent-tracking.json"), {
        schemaVersion: 1,
        sessions: {
          "sess-stop-skill-subagent": {
            session_id: "sess-stop-skill-subagent",
            leader_thread_id: "leader-1",
            updated_at: new Date().toISOString(),
            threads: {
              "leader-1": {
                thread_id: "leader-1",
                kind: "leader",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
              "sub-1": {
                thread_id: "sub-1",
                kind: "subagent",
                first_seen_at: new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                turn_count: 1,
              },
            },
          },
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill-subagent",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block on stale root ralplan skill when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-root-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-stale-root-skill",
          thread_id: "thread-stop-stale-root-skill",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop while autoresearch is active without validator completion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autoresearch-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-autoresearch"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-autoresearch", cwd });
      await writeJson(join(stateDir, "sessions", "sess-stop-autoresearch", "autoresearch-state.json"), {
        active: true,
        mode: "autoresearch",
        current_phase: "executing",
        session_id: "sess-stop-autoresearch",
        validation_mode: "mission-validator-script",
        mission_validator_command: "node scripts/validate.js",
        completion_artifact_path: '.omx/specs/autoresearch-demo/completion.json',
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-autoresearch",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: "OMX autoresearch is still active (phase: executing); continue until validator evidence is complete before stopping.",
        stopReason: "autoresearch_executing",
        systemMessage: "OMX autoresearch is still active (phase: executing); continue until validator evidence is complete before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows Stop once autoresearch validator evidence is complete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-autoresearch-complete-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const specDir = join(cwd, '.omx', 'specs', 'autoresearch-demo');
      await mkdir(join(stateDir, "sessions", "sess-stop-autoresearch-complete"), { recursive: true });
      await mkdir(specDir, { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-autoresearch-complete", cwd });
      await writeJson(join(stateDir, "sessions", "sess-stop-autoresearch-complete", "autoresearch-state.json"), {
        active: true,
        mode: "autoresearch",
        current_phase: "reviewing",
        session_id: "sess-stop-autoresearch-complete",
        validation_mode: "mission-validator-script",
        mission_validator_command: "node scripts/validate.js",
        completion_artifact_path: '.omx/specs/autoresearch-demo/completion.json',
      });
      await writeJson(join(specDir, 'completion.json'), { status: 'passed', passed: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-autoresearch-complete",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from stale root autoresearch state when the explicit session has no scoped autoresearch state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-root-autoresearch-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const specDir = join(cwd, '.omx', 'specs', 'autoresearch-demo');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await mkdir(specDir, { recursive: true });
      await writeJson(join(stateDir, 'session.json'), { session_id: 'sess-current', cwd });
      await writeJson(join(stateDir, 'autoresearch-state.json'), {
        active: true,
        mode: 'autoresearch',
        current_phase: 'executing',
        validation_mode: 'mission-validator-script',
        mission_validator_command: 'node scripts/validate.js',
        completion_artifact_path: '.omx/specs/autoresearch-demo/completion.json',
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: 'Stop',
          cwd,
          session_id: 'sess-current',
        },
        { cwd },
      );

      assert.equal(result.omxEventName, 'stop');
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop solely because deep-interview is active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview", "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview", "deep-interview-state.json"), {
        active: true,
        current_phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-deep-interview",
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop when deep-interview has a pending omx question obligation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview-question"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview-question" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-stop-deep-interview-question",
        thread_id: "thread-stop-deep-interview-question",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        session_id: "sess-stop-deep-interview-question",
        thread_id: "thread-stop-deep-interview-question",
        question_enforcement: {
          obligation_id: "obligation-1",
          source: "omx-question",
          status: "pending",
          requested_at: "2026-04-19T03:20:00.000Z",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-deep-interview-question",
          thread_id: "thread-stop-deep-interview-question",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "Deep interview is still active (phase: intent-first) and has a pending structured question obligation; use `omx question` before stopping.",
        stopReason: "deep_interview_question_required",
        systemMessage:
          "OMX deep-interview is still active (phase: intent-first) and requires a structured question via omx question before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop when a same-session deep-interview question obligation is pending even after the mode marked itself inactive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-inactive-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview-question-inactive"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview-question-inactive" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-inactive", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-stop-deep-interview-question-inactive",
        thread_id: "thread-stop-deep-interview-question-inactive",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-inactive", "deep-interview-state.json"), {
        active: false,
        mode: "deep-interview",
        current_phase: "intent-first",
        lifecycle_outcome: "askuserQuestion",
        run_outcome: "blocked_on_user",
        completed_at: "2026-04-19T03:20:30.000Z",
        session_id: "sess-stop-deep-interview-question-inactive",
        thread_id: "thread-stop-deep-interview-question-inactive",
        question_enforcement: {
          obligation_id: "obligation-inactive",
          source: "omx-question",
          status: "pending",
          lifecycle_outcome: "askuserQuestion",
          requested_at: "2026-04-19T03:20:00.000Z",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-deep-interview-question-inactive",
          thread_id: "thread-stop-deep-interview-question-inactive",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "Deep interview is still active (phase: intent-first) and has a pending structured question obligation; use `omx question` before stopping.",
        stopReason: "deep_interview_question_required",
        systemMessage:
          "OMX deep-interview is still active (phase: intent-first) and requires a structured question via omx question before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not re-block Stop after a same-session deep-interview question record is already answered", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-answered-"));
    try {
      const sessionId = "sess-stop-deep-interview-question-answered";
      const stateDir = join(cwd, ".omx", "state");
      const sessionDir = join(stateDir, "sessions", sessionId);
      await mkdir(join(sessionDir, "questions"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: sessionId });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: sessionId,
        thread_id: "thread-stop-deep-interview-question-answered",
      });
      await writeJson(join(sessionDir, "deep-interview-state.json"), {
        active: false,
        mode: "deep-interview",
        current_phase: "intent-first",
        lifecycle_outcome: "askuserQuestion",
        run_outcome: "blocked_on_user",
        completed_at: "2026-04-19T03:20:30.000Z",
        session_id: sessionId,
        thread_id: "thread-stop-deep-interview-question-answered",
        question_enforcement: {
          obligation_id: "obligation-answered",
          source: "omx-question",
          status: "pending",
          lifecycle_outcome: "askuserQuestion",
          requested_at: "2026-04-19T03:20:00.000Z",
        },
      });
      await writeJson(join(sessionDir, "questions", "question-answered.json"), {
        kind: "omx.question/v1",
        question_id: "question-answered",
        session_id: sessionId,
        created_at: "2026-04-19T03:20:05.000Z",
        updated_at: "2026-04-19T03:20:10.000Z",
        status: "answered",
        question: "What should happen next?",
        options: [{ label: "Continue", value: "continue" }],
        allow_other: false,
        other_label: "Other",
        multi_select: false,
        type: "single-answerable",
        source: "deep-interview",
        answer: {
          kind: "option",
          value: "continue",
          selected_labels: ["Continue"],
          selected_values: ["continue"],
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: sessionId,
          thread_id: "thread-stop-deep-interview-question-answered",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);

      const state = JSON.parse(
        await readFile(join(sessionDir, "deep-interview-state.json"), "utf-8"),
      ) as {
        lifecycle_outcome?: string;
        question_enforcement?: { status?: string; question_id?: string; satisfied_at?: string };
        run_outcome?: string;
      };
      assert.equal(state.question_enforcement?.status, "satisfied");
      assert.equal(state.question_enforcement?.question_id, "question-answered");
      assert.ok(state.question_enforcement?.satisfied_at);
      assert.equal(state.lifecycle_outcome, undefined);
      assert.equal(state.run_outcome, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps blocking pending deep-interview question Stop replays until the obligation changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-replay-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview-question-replay"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview-question-replay" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-replay", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-stop-deep-interview-question-replay",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-replay", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        question_enforcement: {
          obligation_id: "obligation-replay",
          source: "omx-question",
          status: "pending",
          requested_at: "2026-04-19T03:20:00.000Z",
        },
      });

      const payload = {
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-stop-deep-interview-question-replay",
      };
      const expected = {
        decision: "block",
        reason:
          "Deep interview is still active (phase: intent-first) and has a pending structured question obligation; use `omx question` before stopping.",
        stopReason: "deep_interview_question_required",
        systemMessage:
          "OMX deep-interview is still active (phase: intent-first) and requires a structured question via omx question before stopping.",
      };

      const first = await dispatchCodexNativeHook(payload, { cwd });
      const replay = await dispatchCodexNativeHook({ ...payload, stop_hook_active: true }, { cwd });

      assert.equal(first.omxEventName, "stop");
      assert.deepEqual(first.outputJson, expected);
      assert.equal(replay.omxEventName, "stop");
      assert.deepEqual(replay.outputJson, expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop once the deep-interview question obligation is satisfied or cleared", async () => {
    for (const status of ["satisfied", "cleared"] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-native-hook-stop-deep-interview-question-${status}-`));
      try {
        const stateDir = join(cwd, ".omx", "state");
        await mkdir(join(stateDir, "sessions", `sess-stop-deep-interview-question-${status}`), { recursive: true });
        await writeJson(join(stateDir, "session.json"), { session_id: `sess-stop-deep-interview-question-${status}` });
        await writeJson(join(stateDir, "sessions", `sess-stop-deep-interview-question-${status}`, "skill-active-state.json"), {
          version: 1,
          active: true,
          skill: "deep-interview",
          phase: "planning",
          session_id: `sess-stop-deep-interview-question-${status}`,
        });
        await writeJson(join(stateDir, "sessions", `sess-stop-deep-interview-question-${status}`, "deep-interview-state.json"), {
          active: true,
          mode: "deep-interview",
          current_phase: "intent-first",
          question_enforcement: {
            obligation_id: `obligation-${status}`,
            source: "omx-question",
            status,
            requested_at: "2026-04-19T03:20:00.000Z",
            ...(status === "satisfied"
              ? { question_id: "question-1", satisfied_at: "2026-04-19T03:21:00.000Z" }
              : { cleared_at: "2026-04-19T03:21:00.000Z", clear_reason: "error" }),
          },
        });

        const result = await dispatchCodexNativeHook(
          {
            hook_event_name: "Stop",
            cwd,
            session_id: `sess-stop-deep-interview-question-${status}`,
          },
          { cwd },
        );

        assert.equal(result.omxEventName, "stop");
        assert.equal(result.outputJson, null);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it("ignores pending deep-interview question obligations from another session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-foreign-session-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-other"), { recursive: true });
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "sessions", "sess-other", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-other",
      });
      await writeJson(join(stateDir, "sessions", "sess-other", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        question_enforcement: {
          obligation_id: "obligation-foreign",
          source: "omx-question",
          status: "pending",
          requested_at: "2026-04-19T03:20:00.000Z",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks a new same-session deep-interview question obligation even after an earlier round was satisfied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-deep-interview-question-next-round-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-deep-interview-question-next-round"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-deep-interview-question-next-round" });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-next-round", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-stop-deep-interview-question-next-round",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-deep-interview-question-next-round", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
        question_enforcement: {
          obligation_id: "obligation-next-round",
          source: "omx-question",
          status: "pending",
          requested_at: "2026-04-19T03:22:00.000Z",
          question_id: "question-old-round",
          satisfied_at: "2026-04-19T03:21:00.000Z",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-deep-interview-question-next-round",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "Deep interview is still active (phase: intent-first) and has a pending structured question obligation; use `omx question` before stopping.",
        stopReason: "deep_interview_question_required",
        systemMessage:
          "OMX deep-interview is still active (phase: intent-first) and requires a structured question via omx question before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores root skill-active fallback from a different thread when evaluating Stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-foreign-thread-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "",
        thread_id: "other-thread",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-main",
          thread_id: "main-thread",
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a non-blocking Stop document-refresh warning before auto-nudge when Ralph is not active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-document-refresh-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-doc-refresh",
          last_assistant_message: "Launch-ready: yes",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal((result.outputJson as { decision?: string } | null)?.decision, undefined);
      assert.equal((result.outputJson as { hookSpecificOutput?: { hookEventName?: string } } | null)?.hookSpecificOutput?.hookEventName, "Stop");
      assert.match(JSON.stringify(result.outputJson), /Document-refresh warning/);
      assert.match(JSON.stringify(result.outputJson), /staged \+ unstaged changes/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not warn on ordinary non-terminal Stop attempts before auto-nudge", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-document-refresh-nonterminal-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-doc-refresh-nonterminal",
          last_assistant_message: "Continuing implementation; next I will run focused tests.",
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("dedupes identical Stop document-refresh warnings during active Stop-hook replays", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-document-refresh-dedupe-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");

      const payload = {
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-stop-doc-refresh-dedupe",
        last_assistant_message: "Launch-ready: yes",
      } as const;

      const first = await dispatchCodexNativeHook(payload, { cwd });
      const replay = await dispatchCodexNativeHook({ ...payload, stop_hook_active: true }, { cwd });

      assert.match(JSON.stringify(first.outputJson), /Document-refresh warning/);
      assert.equal(replay.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses Stop document-refresh warning when the final handoff message includes an exemption", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-document-refresh-exempt-"));
    try {
      await mkdir(join(cwd, "src", "scripts"), { recursive: true });
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 1;\n", "utf-8");
      execFileSync("git", ["add", "src/scripts/codex-native-hook.ts"], { cwd, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd, stdio: "ignore" });
      await writeFile(join(cwd, "src", "scripts", "codex-native-hook.ts"), "export const hook = 2;\n", "utf-8");

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-doc-refresh-exempt",
          last_assistant_message: `${DOCUMENT_REFRESH_EXEMPTION_PREFIX} internal-only behavior verified`,
        },
        { cwd },
      );

      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Stop continuation output while Ralph is active without an explicit session pin", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
        }),
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ralph_executing",
        systemMessage:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Stop from session-scoped Ralph state when session.json points to another session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ralph-session-mismatch-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-live-ralph"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-other-ralph" });
      await writeJson(join(stateDir, "sessions", "sess-live-ralph", "ralph-state.json"), {
        active: true,
        current_phase: "executing",
        session_id: "sess-live-ralph",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-live-ralph",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ralph_executing",
        systemMessage:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from stale session-scoped Ralph state that belongs to another session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-session-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await mkdir(join(stateDir, "sessions", "sess-stale"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "sessions", "sess-stale", "ralph-state.json"), {
        active: true,
        current_phase: "starting",
        session_id: "sess-stale",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from stale current-session Ralph state when session.json points to a dead owner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-current-session-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-dead"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), {
        session_id: "sess-dead",
        cwd,
        pid: Number.MAX_SAFE_INTEGER,
        started_at: "2026-01-01T00:00:00.000Z",
      });
      await writeJson(join(stateDir, "sessions", "sess-dead", "ralph-state.json"), {
        active: true,
        current_phase: "verifying",
        session_id: "sess-dead",
      });
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "team",
        phase: "team-exec",
        active_skills: [{ skill: "team", phase: "team-exec", active: true, session_id: "sess-dead" }],
      });
      await writeJson(join(stateDir, "native-stop-state.json"), {
        sessions: {
          "sess-dead": {
            last_signature: "ralph-stop|sess-dead|thread-1|no-message|verifying",
            updated_at: "2026-04-20T21:00:00.000Z",
          },
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-dead",
          thread_id: "thread-1",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from another session-scoped Ralph state when an explicit session_id has no active Ralph state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-explicit-session-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-other"), { recursive: true });
      await writeJson(join(stateDir, "sessions", "sess-other", "ralph-state.json"), {
        active: true,
        current_phase: "starting",
        session_id: "sess-other",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from root Ralph fallback when the current session has no scoped Ralph state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-root-fallback-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current", cwd });
      await writeJson(join(stateDir, "ralph-state.json"), {
        active: true,
        current_phase: "executing",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop when the current session Ralph state is cancelled even if stale root fallback remains", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-cancelled-session-ralph-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current", cwd });
      await writeJson(join(stateDir, "sessions", "sess-current", "ralph-state.json"), {
        active: false,
        current_phase: "cancelled",
        completed_at: "2026-04-10T23:30:38.000Z",
        session_id: "sess-current",
      });
      await writeJson(join(stateDir, "ralph-state.json"), {
        active: true,
        current_phase: "starting",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from root Ralph fallback when an explicit session_id is present and session.json points to another worktree", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-root-fallback-cwd-mismatch-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "session.json"), {
        session_id: "sess-elsewhere",
        cwd: join(cwd, "..", "different-worktree"),
      });
      await writeJson(join(stateDir, "ralph-state.json"), {
        active: true,
        current_phase: "executing",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps blocking Ralph Stop replays until the active task advances", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ralph-replay-"));
    const previousOmxSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        join(stateDir, "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
        }),
      );

      process.env.OMX_SESSION_ID = "sess-stop-ralph-replay";
      const payload = {
        hook_event_name: "Stop",
        cwd,
        last_assistant_message: "Next active targets:\n\n1. scheduler integration\n\nI am continuing.",
      };
      const expected = {
        decision: "block",
        reason:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ralph_executing",
        systemMessage:
          "OMX Ralph is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
      };

      const first = await dispatchCodexNativeHook(payload, { cwd });
      const replay = await dispatchCodexNativeHook(
        {
          ...payload,
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(first.omxEventName, "stop");
      assert.deepEqual(first.outputJson, expected);
      assert.equal(replay.omxEventName, "stop");
      assert.deepEqual(replay.outputJson, expected);
    } finally {
      if (typeof previousOmxSessionId === "string") process.env.OMX_SESSION_ID = previousOmxSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lets dispatcher dedupe identical native stop hook replays after Stop payload normalization", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ralph-hook-dedupe-"));
    const previousOmxSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-ralph-hook-dedupe"), { recursive: true });
      await writeHookCounterPlugin(cwd);
      await writeFile(
        join(stateDir, "sessions", "sess-stop-ralph-hook-dedupe", "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
          session_id: "sess-stop-ralph-hook-dedupe",
        }),
      );

      process.env.OMX_SESSION_ID = "sess-stop-ralph-hook-dedupe";
      const payload = {
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-stop-ralph-hook-dedupe",
        thread_id: "thread-stop-ralph-hook-dedupe",
        turn_id: "turn-stop-ralph-hook-dedupe-1",
        last_assistant_message: "Next active targets:\n\n1. scheduler integration\n\nI am continuing.",
      };

      await dispatchCodexNativeHook(payload, { cwd });
      await dispatchCodexNativeHook(
        {
          ...payload,
          stop_hook_active: true,
        },
        { cwd },
      );

      const marker = JSON.parse(
        await readFile(join(cwd, ".omx", "stop-hook-counter.json"), "utf-8"),
      ) as { count: number };
      assert.equal(marker.count, 1);
    } finally {
      if (typeof previousOmxSessionId === "string") process.env.OMX_SESSION_ID = previousOmxSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves per-turn native stop hook delivery even when stop_hook_active remains true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ralph-hook-refire-"));
    const previousOmxSessionId = process.env.OMX_SESSION_ID;
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-ralph-hook-refire"), { recursive: true });
      await writeHookCounterPlugin(cwd);
      await writeFile(
        join(stateDir, "sessions", "sess-stop-ralph-hook-refire", "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
          session_id: "sess-stop-ralph-hook-refire",
        }),
      );

      process.env.OMX_SESSION_ID = "sess-stop-ralph-hook-refire";
      const payload = {
        hook_event_name: "Stop",
        cwd,
        session_id: "sess-stop-ralph-hook-refire",
        thread_id: "thread-stop-ralph-hook-refire",
        turn_id: "turn-stop-ralph-hook-refire-1",
        last_assistant_message: "Continuing current task.",
      };

      await dispatchCodexNativeHook(payload, { cwd });
      await dispatchCodexNativeHook(
        {
          ...payload,
          turn_id: "turn-stop-ralph-hook-refire-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      await writeFile(
        join(stateDir, "sessions", "sess-stop-ralph-hook-refire", "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "executing",
          session_id: "sess-stop-ralph-hook-refire",
        }),
      );

      await dispatchCodexNativeHook(
        {
          ...payload,
          turn_id: "turn-stop-ralph-hook-refire-3",
          stop_hook_active: true,
        },
        { cwd },
      );

      const marker = JSON.parse(
        await readFile(join(cwd, ".omx", "stop-hook-counter.json"), "utf-8"),
      ) as { count: number };
      assert.equal(marker.count, 3);
    } finally {
      if (typeof previousOmxSessionId === "string") process.env.OMX_SESSION_ID = previousOmxSessionId;
      else delete process.env.OMX_SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("returns Stop continuation output for native auto-nudge stall prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto";

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-blocks duplicate native auto-nudge replays for the same Stop reply", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-once-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-once";

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-once",
          thread_id: "thread-stop-auto",
          turn_id: "turn-stop-auto-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-once",
          thread_id: "thread-stop-auto",
          turn_id: "turn-stop-auto-1",
          stop_hook_active: true,
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-blocks duplicate native auto-nudge replays across native/canonical session-id drift", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-session-drift-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "omx-canonical";
      await writeJson(join(stateDir, "session.json"), {
        session_id: "omx-canonical",
        native_session_id: "codex-native",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "codex-native",
          thread_id: "thread-stop-auto-drift",
          turn_id: "turn-stop-auto-drift-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "omx-canonical",
          thread_id: "thread-stop-auto-drift",
          turn_id: "turn-stop-auto-drift-1",
          stop_hook_active: true,
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });

      const persisted = JSON.parse(
        await readFile(join(stateDir, "native-stop-state.json"), "utf-8"),
      ) as { sessions?: Record<string, unknown> };
      assert.deepEqual(Object.keys(persisted.sessions ?? {}), ["omx-canonical"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("dedupes native stop hook replay across owner launch SessionStart reconciliation drift", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-dispatch-session-drift-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "omx-canonical"), { recursive: true });
      await writeHookCounterPlugin(cwd);
      process.env.OMX_SESSION_ID = "omx-canonical";
      await writeSessionStart(cwd, "omx-canonical");
      await writeJson(join(stateDir, "sessions", "omx-canonical", "ralph-state.json"), {
        active: true,
        current_phase: "executing",
        session_id: "omx-canonical",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "codex-native-new",
        },
        { cwd, sessionOwnerPid: process.pid },
      );

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "codex-native-new",
          thread_id: "thread-stop-hook-drift",
          turn_id: "turn-stop-hook-drift-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "omx-canonical",
          thread_id: "thread-stop-hook-drift",
          turn_id: "turn-stop-hook-drift-1",
          stop_hook_active: true,
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      const marker = JSON.parse(
        await readFile(join(cwd, ".omx", "stop-hook-counter.json"), "utf-8"),
      ) as { count: number };
      assert.equal(marker.count, 1);

      const sessionState = JSON.parse(
        await readFile(join(stateDir, "session.json"), "utf-8"),
      ) as { session_id?: string; native_session_id?: string };
      assert.equal(sessionState.session_id, "omx-canonical");
      assert.equal(sessionState.native_session_id, "codex-native-new");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires native auto-nudge for a later fresh Stop reply even when stop_hook_active is true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-refire-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-refire";

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-refire",
          thread_id: "thread-stop-auto-refire",
          turn_id: "turn-stop-auto-refire-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-refire",
          thread_id: "thread-stop-auto-refire",
          turn_id: "turn-stop-auto-refire-2",
          stop_hook_active: true,
          last_assistant_message: "Continue with the cleanup from here.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("auto-continues native Stop on permission-seeking prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-permission-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-permission";

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-permission",
          last_assistant_message: "Would you like me to continue with the cleanup?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("auto-continues native Stop on \"if you want\" permission-seeking prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-if-you-want-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-if-you-want";

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-if-you-want",
          last_assistant_message: "If you want, I can continue with the cleanup from here.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not auto-continue native Stop while deep-interview is waiting on an intent-first question", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-question-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-auto-question"), { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-question";
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-auto-question" });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-question", "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "deep-interview",
        phase: "planning",
        session_id: "sess-stop-auto-question",
        thread_id: "thread-stop-auto-question",
        input_lock: {
          active: true,
          scope: "deep-interview-auto-approval",
          blocked_inputs: ["yes", "proceed"],
          message: "Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.",
        },
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-question", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-question",
          thread_id: "thread-stop-auto-question",
          turn_id: "turn-stop-auto-question-1",
          last_assistant_message: [
            "Round 2 | Target: Decision boundary | Ambiguity: 24%",
            "",
            "If an existing project spider still declares session_mode = \"owned\", should ZenX fail loudly so the stale attribute is removed, or should it ignore the attribute and initialize the session pool anyway?",
            "Keep going once I have your answer.",
          ].join("\n"),
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses native auto-nudge re-fire while session-scoped deep-interview state is still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-state-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-auto-interview"), { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-interview";
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-auto-interview" });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-interview", "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-interview",
          thread_id: "thread-stop-auto-interview",
          turn_id: "turn-stop-auto-interview-2",
          stop_hook_active: true,
          last_assistant_message: "If you want, I can keep going from here.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses native auto-nudge when root deep-interview mode state is active without an explicit session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-deep-interview-mode-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-mode";
      await writeJson(join(stateDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          turn_id: "turn-stop-auto-mode-1",
          last_assistant_message: "Would you like me to continue with the next step?",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview mode state when the explicit session-scoped mode state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-mode-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-stale-root-mode";
      await writeJson(join(stateDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-mode",
          thread_id: "thread-stop-auto-stale-root-mode",
          turn_id: "turn-stop-auto-stale-root-mode-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview skill state when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-skill-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-stale-root-skill";
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-skill",
          thread_id: "thread-stop-auto-stale-root-skill",
          turn_id: "turn-stop-auto-stale-root-skill-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from stale root deep-interview input lock when the explicit session-scoped canonical skill state is absent", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-stale-root-lock-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-stale-root-lock";
      await writeJson(join(stateDir, "skill-active-state.json"), {
        active: true,
        skill: "deep-interview",
        phase: "planning",
        input_lock: {
          active: true,
          scope: "deep-interview-auto-approval",
          blocked_inputs: ["yes", "proceed"],
          message: "Deep interview is active; auto-approval shortcuts are blocked until the interview finishes.",
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-stale-root-lock",
          thread_id: "thread-stop-auto-stale-root-lock",
          turn_id: "turn-stop-auto-stale-root-lock-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress native auto-nudge from active root deep-interview state when the current scoped mode state is explicitly inactive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-inactive-scoped-mode-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-auto-inactive-mode"), { recursive: true });
      process.env.OMX_SESSION_ID = "sess-stop-auto-inactive-mode";
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-auto-inactive-mode" });
      await writeJson(join(stateDir, "sessions", "sess-stop-auto-inactive-mode", "deep-interview-state.json"), {
        active: false,
        mode: "deep-interview",
        current_phase: "completed",
      });
      await writeJson(join(stateDir, "deep-interview-state.json"), {
        active: true,
        mode: "deep-interview",
        current_phase: "intent-first",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-auto-inactive-mode",
          thread_id: "thread-stop-auto-inactive-mode",
          turn_id: "turn-stop-auto-inactive-mode-1",
          last_assistant_message: "Keep going and finish the cleanup.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("auto-continues native Stop for permission-seeking prompts even outside OMX runtime", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-auto-nudge-plain-session-"));
    try {
      await dispatchCodexNativeHook(
        {
          hook_event_name: "SessionStart",
          cwd,
          session_id: "plain-stop-session",
        },
        {
          cwd,
          sessionOwnerPid: process.pid,
        },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "plain-stop-session",
          thread_id: "plain-thread",
          turn_id: "plain-turn-1",
          last_assistant_message: "If you want, I can continue with the cleanup from here.",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason: DEFAULT_AUTO_NUDGE_RESPONSE,
        stopReason: "auto_nudge",
        systemMessage:
          "OMX native Stop detected a stall/permission-style handoff and continued the turn automatically.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-fires team Stop output for a later fresh Stop reply while the team is still active", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-refire-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "team-exec",
        team_name: "review-team",
      });
      await writeJson(join(stateDir, "team", "review-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-refire",
          thread_id: "thread-stop-team-refire",
          turn_id: "turn-stop-team-refire-1",
        },
        { cwd },
      );

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-team-refire",
          thread_id: "thread-stop-team-refire",
          turn_id: "turn-stop-team-refire-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (review-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate team Stop replays across native/canonical session-id drift", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-team-session-drift-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "omx-canonical"), { recursive: true });
      process.env.OMX_SESSION_ID = "omx-canonical";
      await writeJson(join(stateDir, "session.json"), {
        session_id: "omx-canonical",
        native_session_id: "codex-native",
      });
      await writeJson(join(stateDir, "sessions", "omx-canonical", "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "current-team",
        session_id: "omx-canonical",
      });
      await writeJson(join(stateDir, "team", "current-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 1,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "codex-native",
          thread_id: "thread-stop-team-drift",
          turn_id: "turn-stop-team-drift-1",
        },
        { cwd },
      );

      const duplicate = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "omx-canonical",
          thread_id: "thread-stop-team-drift",
          turn_id: "turn-stop-team-drift-1",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(duplicate.omxEventName, "stop");
      assert.deepEqual(duplicate.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (current-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });

      const fresh = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "omx-canonical",
          thread_id: "thread-stop-team-drift",
          turn_id: "turn-stop-team-drift-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(fresh.omxEventName, "stop");
      assert.deepEqual(fresh.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (current-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });

      const persisted = JSON.parse(
        await readFile(join(stateDir, "native-stop-state.json"), "utf-8"),
      ) as { sessions?: Record<string, unknown> };
      assert.deepEqual(Object.keys(persisted.sessions ?? {}), ["omx-canonical"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate ultrawork Stop replays while stop_hook_active stays true", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-ultrawork-repeat-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(stateDir, { recursive: true });
      await writeJson(join(stateDir, "ultrawork-state.json"), {
        active: true,
        current_phase: "executing",
      });

      const first = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-ultrawork-repeat",
          thread_id: "thread-stop-ultrawork-repeat",
          turn_id: "turn-stop-ultrawork-repeat-1",
        },
        { cwd },
      );

      const repeated = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-ultrawork-repeat",
          thread_id: "thread-stop-ultrawork-repeat",
          turn_id: "turn-stop-ultrawork-repeat-1",
          stop_hook_active: true,
        },
        { cwd },
      );

      const fresh = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-ultrawork-repeat",
          thread_id: "thread-stop-ultrawork-repeat",
          turn_id: "turn-stop-ultrawork-repeat-2",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(first.omxEventName, "stop");
      assert.deepEqual(repeated.outputJson, null);
      assert.equal(fresh.omxEventName, "stop");
      assert.deepEqual(fresh.outputJson, {
        decision: "block",
        reason: "OMX ultrawork is still active (phase: executing); continue the task and gather fresh verification evidence before stopping.",
        stopReason: "ultrawork_executing",
        systemMessage: "OMX ultrawork is still active (phase: executing).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("re-blocks active ralplan skill state on repeated Stop hooks", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-skill-repeat-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-stop-skill-repeat"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-stop-skill-repeat" });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-repeat", "skill-active-state.json"), {
        active: true,
        skill: "ralplan",
        phase: "planning",
      });
      await writeJson(join(stateDir, "sessions", "sess-stop-skill-repeat", "ralplan-state.json"), {
        active: true,
        current_phase: "planning",
      });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill-repeat",
          thread_id: "thread-stop-skill-repeat",
          turn_id: "turn-stop-skill-repeat-1",
        },
        { cwd },
      );

      const repeated = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-stop-skill-repeat",
          thread_id: "thread-stop-skill-repeat",
          turn_id: "turn-stop-skill-repeat-1",
          stop_hook_active: true,
        },
        { cwd },
      );

      assert.equal(repeated.omxEventName, "stop");
      assert.deepEqual(repeated.outputJson, {
        decision: "block",
        reason:
          "OMX skill ralplan is still active (phase: planning); continue until the current ralplan workflow reaches a terminal state.",
        stopReason: "skill_ralplan_planning",
        systemMessage: "OMX skill ralplan is still active (phase: planning).",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from another session's stale root team state when no scoped team state exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-stale-root-team-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "stale-root-team",
        session_id: "sess-other",
      });
      await writeJson(join(stateDir, "team", "stale-root-team", "phase.json"), {
        current_phase: "team-exec",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block Stop from orphaned team mode state after cleanup removed canonical team artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-orphaned-team-state-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "cleaned-team",
        session_id: "sess-current",
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prefers the current session team state over a stale root team fallback during Stop", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-current-session-team-preferred-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "sessions", "sess-current", "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "current-team",
        session_id: "sess-current",
      });
      await writeJson(join(stateDir, "team", "current-team", "phase.json"), {
        current_phase: "team-verify",
        max_fix_attempts: 3,
        current_fix_attempt: 1,
        transitions: [],
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "stale-root-team",
        session_id: "sess-other",
      });
      await writeJson(join(stateDir, "team", "stale-root-team", "phase.json"), {
        current_phase: "team-exec",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.deepEqual(result.outputJson, {
        decision: "block",
        reason:
          `OMX team pipeline is still active (current-team) at phase team-verify; continue coordinating until the team reaches a terminal phase.${TEAM_STOP_COMMIT_GUIDANCE}`,
        stopReason: "team_team-verify",
        systemMessage: "OMX team pipeline is still active at phase team-verify.",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not fall back to active root team state when the current scoped team state is inactive", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-stop-inactive-scoped-team-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      await mkdir(join(stateDir, "sessions", "sess-current"), { recursive: true });
      await writeJson(join(stateDir, "session.json"), { session_id: "sess-current" });
      await writeJson(join(stateDir, "sessions", "sess-current", "team-state.json"), {
        active: false,
        current_phase: "complete",
        team_name: "scoped-finished-team",
        session_id: "sess-current",
      });
      await writeJson(join(stateDir, "team-state.json"), {
        active: true,
        current_phase: "starting",
        team_name: "root-fallback-team",
        session_id: "sess-current",
      });
      await writeJson(join(stateDir, "team", "root-fallback-team", "phase.json"), {
        current_phase: "team-exec",
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "Stop",
          cwd,
          session_id: "sess-current",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "stop");
      assert.equal(result.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Triage layer integration tests
// ---------------------------------------------------------------------------

describe("codex native hook triage integration", () => {
  const priorCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    resetTriageConfigCache();
  });

  afterEach(() => {
    if (typeof priorCodexHome === "string") process.env.CODEX_HOME = priorCodexHome;
    else delete process.env.CODEX_HOME;
    resetTriageConfigCache();
  });

  // ── Group 1: Keyword bypass (triage must NOT run) ────────────────────────

  it("does not inject triage advisory for $ralplan keyword prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-keyword-ralplan-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-kw-ralplan-1",
          thread_id: "thread-triage-kw-1",
          turn_id: "turn-triage-kw-1",
          prompt: "$ralplan implement issue #1307",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(additionalContext, /read-only\/question-shaped/);
      assert.doesNotMatch(additionalContext, /narrow edit-shaped/);
      assert.doesNotMatch(additionalContext, /visual\/style request/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-kw-ralplan-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not inject triage advisory for autopilot keyword prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-keyword-autopilot-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-kw-autopilot-1",
          thread_id: "thread-triage-kw-ap-1",
          turn_id: "turn-triage-kw-ap-1",
          prompt: "$autopilot build this",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(additionalContext, /read-only\/question-shaped/);
      assert.doesNotMatch(additionalContext, /narrow edit-shaped/);
      assert.doesNotMatch(additionalContext, /visual\/style request/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-kw-autopilot-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 2: HEAVY injection ─────────────────────────────────────────────

  it("injects HEAVY advisory and writes prompt-routing-state for a multi-step goal prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-heavy-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-heavy-1",
          thread_id: "thread-triage-heavy-1",
          turn_id: "turn-triage-heavy-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /multi-step goal with no workflow keyword/);
      assert.match(additionalContext, /Prefer the existing autopilot-style workflow/);

      // skill-active-state.json must NOT be written (triage is advisory only)
      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);

      // prompt-routing-state.json must be written with lane=HEAVY
      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-heavy-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        version?: number;
        last_triage?: { lane?: string; destination?: string };
        suppress_followup?: boolean;
      };
      assert.equal(state.version, 1);
      assert.equal(state.last_triage?.lane, "HEAVY");
      assert.equal(state.last_triage?.destination, "autopilot");
      assert.equal(state.suppress_followup, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 3: LIGHT/explore ────────────────────────────────────────────────

  it("injects LIGHT/explore advisory and writes state for a question-shaped prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-light-explore-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-explore-1",
          thread_id: "thread-triage-explore-1",
          turn_id: "turn-triage-explore-1",
          prompt: "explain this function",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /read-only\/question-shaped/);
      assert.match(additionalContext, /Prefer the explore role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-explore-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
        suppress_followup?: boolean;
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "explore");
      assert.equal(state.suppress_followup, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 4: LIGHT/executor ───────────────────────────────────────────────

  it("injects LIGHT/executor advisory and writes state for a narrow edit-shaped prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-light-executor-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-executor-1",
          thread_id: "thread-triage-executor-1",
          turn_id: "turn-triage-executor-1",
          prompt: "fix typo in src/foo.ts",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /narrow edit-shaped/);
      assert.match(additionalContext, /Prefer the executor role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-executor-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "executor");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 5: LIGHT/designer ───────────────────────────────────────────────

  it("injects LIGHT/designer advisory and writes state for a visual/style prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-light-designer-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-designer-1",
          thread_id: "thread-triage-designer-1",
          turn_id: "turn-triage-designer-1",
          prompt: "make the button blue",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /visual\/style request/);
      assert.match(additionalContext, /Prefer the designer role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-designer-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "designer");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("injects LIGHT/researcher advisory and writes state for an official-doc lookup prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-light-researcher-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-researcher-1",
          thread_id: "thread-triage-researcher-1",
          turn_id: "turn-triage-researcher-1",
          prompt: "Find the official docs and version compatibility notes for this SDK",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /external documentation\/reference research request/);
      assert.match(additionalContext, /Prefer the researcher role surface/);
      assert.doesNotMatch(additionalContext, /skill: researcher activated/);

      assert.equal(existsSync(join(cwd, ".omx", "state", "skill-active-state.json")), false);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-researcher-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
        suppress_followup?: boolean;
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
      assert.equal(state.last_triage?.reason, "external_reference_research");
      assert.equal(state.suppress_followup, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes Korean external lookup phrasing to researcher without treating it as workflow activation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-light-researcher-ko-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-researcher-ko-1",
          thread_id: "thread-triage-researcher-ko-1",
          turn_id: "turn-triage-researcher-ko-1",
          prompt: "OpenAI Responses API 공식 문서 찾아줘",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /Prefer the researcher role surface/);
      assert.equal(result.skillState, null);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-researcher-ko-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes official-doc question prompts to researcher instead of explore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-question-researcher-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-question-researcher-1",
          thread_id: "thread-triage-question-researcher-1",
          turn_id: "turn-triage-question-researcher-1",
          prompt: "where can I find official docs for OpenAI Responses API?",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the explore role surface/);
      assert.match(additionalContext, /Prefer the researcher role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-question-researcher-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
      assert.equal(state.last_triage?.reason, "external_reference_research");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes endpoint-shaped official-doc lookups to researcher instead of local explore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-endpoint-researcher-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-endpoint-researcher-1",
          thread_id: "thread-triage-endpoint-researcher-1",
          turn_id: "turn-triage-endpoint-researcher-1",
          prompt: "find official docs for api/v1/responses",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the explore role surface/);
      assert.match(additionalContext, /Prefer the researcher role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-endpoint-researcher-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
      assert.equal(state.last_triage?.reason, "external_reference_research");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes dotted technology official-doc lookups to researcher instead of local explore", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-dotted-tech-researcher-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-dotted-tech-researcher-1",
          thread_id: "thread-triage-dotted-tech-researcher-1",
          turn_id: "turn-triage-dotted-tech-researcher-1",
          prompt: "find official docs for Node.js",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the explore role surface/);
      assert.match(additionalContext, /Prefer the researcher role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-dotted-tech-researcher-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
      assert.equal(state.last_triage?.reason, "external_reference_research");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes URL-shaped official-doc lookups with repo paths to researcher instead of local routes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-url-path-researcher-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-url-path-researcher-1",
          thread_id: "thread-triage-url-path-researcher-1",
          turn_id: "turn-triage-url-path-researcher-1",
          prompt: "find official docs for github.com/org/repo/src/foo.ts",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the executor role surface/);
      assert.doesNotMatch(additionalContext, /Prefer the explore role surface/);
      assert.match(additionalContext, /Prefer the researcher role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-url-path-researcher-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "researcher");
      assert.equal(state.last_triage?.reason, "external_reference_research");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps implementation-shaped official-doc prompts on HEAVY instead of researcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-researcher-implementation-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-researcher-implementation-1",
          thread_id: "thread-triage-researcher-implementation-1",
          turn_id: "turn-triage-researcher-implementation-1",
          prompt: "implement auth using official docs for the SDK",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /multi-step goal with no workflow keyword/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-researcher-implementation-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "HEAVY");
      assert.equal(state.last_triage?.destination, "autopilot");
      assert.equal(state.last_triage?.reason, "implementation_research_goal");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps planning-shaped official-doc prompts on HEAVY instead of researcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-researcher-planning-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-researcher-planning-1",
          thread_id: "thread-triage-researcher-planning-1",
          turn_id: "turn-triage-researcher-planning-1",
          prompt: "research and plan auth migration using official docs for the SDK",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /multi-step goal with no workflow keyword/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-researcher-planning-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "HEAVY");
      assert.equal(state.last_triage?.destination, "autopilot");
      assert.equal(state.last_triage?.reason, "implementation_research_goal");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps local source lookup prompts off researcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-local-source-explore-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-local-source-1",
          thread_id: "thread-triage-local-source-1",
          turn_id: "turn-triage-local-source-1",
          prompt: "search source for parseConfig in src/config.ts",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /Prefer the executor role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-local-source-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "executor");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps anchored local API usage prompts on executor instead of researcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-local-api-executor-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-local-api-1",
          thread_id: "thread-triage-local-api-1",
          turn_id: "turn-triage-local-api-1",
          prompt: "find API usage in src/foo.ts",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /Prefer the executor role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-local-api-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "executor");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps project-scoped local API usage prompts on explore instead of researcher", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-project-api-explore-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-project-api-1",
          thread_id: "thread-triage-project-api-1",
          turn_id: "turn-triage-project-api-1",
          prompt: "find API usage in this project",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /Prefer the explore role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-project-api-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "explore");
      assert.equal(state.last_triage?.reason, "local_reference_lookup");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps repository changelog lookup prompts on explore despite generic docs terms", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-repo-changelog-explore-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-repo-changelog-1",
          thread_id: "thread-triage-repo-changelog-1",
          turn_id: "turn-triage-repo-changelog-1",
          prompt: "find changelog in this repository",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the researcher role surface/);
      assert.match(additionalContext, /Prefer the explore role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-repo-changelog-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "explore");
      assert.equal(state.last_triage?.reason, "local_reference_lookup");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes anchored read-only questions through explore before executor", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-anchored-question-explore-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-anchored-question-1",
          thread_id: "thread-triage-anchored-question-1",
          turn_id: "turn-triage-anchored-question-1",
          prompt: "what does src/foo.ts do?",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /Prefer the executor role surface/);
      assert.match(additionalContext, /Prefer the explore role surface/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-anchored-question-1", "prompt-routing-state.json");
      const state = JSON.parse(await readFile(stateFile, "utf-8")) as {
        last_triage?: { lane?: string; destination?: string; reason?: string };
      };
      assert.equal(state.last_triage?.lane, "LIGHT");
      assert.equal(state.last_triage?.destination, "explore");
      assert.equal(state.last_triage?.reason, "question_or_explanation");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 6: PASS (no triage injection, no state) ────────────────────────

  it("produces no triage advisory and no state for trivial greeting prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-pass-hello-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-pass-hello-1",
          thread_id: "thread-triage-pass-1",
          turn_id: "turn-triage-pass-1",
          prompt: "hello",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(additionalContext, /read-only\/question-shaped/);
      assert.doesNotMatch(additionalContext, /narrow edit-shaped/);
      assert.doesNotMatch(additionalContext, /visual\/style request/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-pass-hello-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("produces no triage advisory and no state for ambiguous short prompts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-pass-short-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-pass-short-1",
          thread_id: "thread-triage-pass-short-1",
          turn_id: "turn-triage-pass-short-1",
          prompt: "fix the thing",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(additionalContext, /read-only\/question-shaped/);
      assert.doesNotMatch(additionalContext, /narrow edit-shaped/);
      assert.doesNotMatch(additionalContext, /visual\/style request/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-pass-short-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 7: Turn-2 suppression (same session across two invocations) ────

  it("suppresses HEAVY triage re-injection on a short follow-up in the same session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-suppress-heavy-"));
    const sessionId = "triage-suppress-heavy-1";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      // Turn 1: HEAVY fires
      const turn1 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-suppress-heavy-1",
          turn_id: "turn-suppress-heavy-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );
      const ctx1 = String(
        (turn1.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(ctx1, /multi-step goal with no workflow keyword/);

      // Turn 2: short follow-up — triage suppressed
      const turn2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-suppress-heavy-1",
          turn_id: "turn-suppress-heavy-2",
          prompt: "yes, settings page",
        },
        { cwd },
      );
      const ctx2 = String(
        (turn2.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(ctx2, /multi-step goal/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("suppresses LIGHT/explore triage re-injection on a short follow-up in the same session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-suppress-explore-"));
    const sessionId = "triage-suppress-explore-1";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      // Turn 1: LIGHT/explore fires
      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-suppress-explore-1",
          turn_id: "turn-suppress-explore-1",
          prompt: "explain this function",
        },
        { cwd },
      );

      // Turn 2: short follow-up — no duplicate LIGHT injection
      const turn2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-suppress-explore-1",
          turn_id: "turn-suppress-explore-2",
          prompt: "the auth helper",
        },
        { cwd },
      );
      const ctx2 = String(
        (turn2.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(ctx2, /read-only\/question-shaped/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 8: First-turn PASS does NOT block later triage ─────────────────

  it("still applies triage on turn 2 when turn 1 was a PASS with no state written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-pass-then-light-"));
    const sessionId = "triage-pass-then-light-1";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      // Turn 1: PASS — no state written
      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-pass-then-light-1",
          turn_id: "turn-pass-then-light-1",
          prompt: "hello",
        },
        { cwd },
      );
      assert.equal(
        existsSync(join(cwd, ".omx", "state", "sessions", sessionId, "prompt-routing-state.json")),
        false,
      );

      // Turn 2: LIGHT/executor should fire normally
      const turn2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-pass-then-light-1",
          turn_id: "turn-pass-then-light-2",
          prompt: "fix typo in src/foo.ts",
        },
        { cwd },
      );
      const ctx2 = String(
        (turn2.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(ctx2, /narrow edit-shaped/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 9: Opt-out forces PASS ─────────────────────────────────────────

  it("produces no triage advisory when prompt contains 'just chat' opt-out", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-optout-chat-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-optout-chat-1",
          thread_id: "thread-optout-chat-1",
          turn_id: "turn-optout-chat-1",
          prompt: "add dark mode toggle to the settings page, but just chat about it",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(additionalContext, /read-only\/question-shaped/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-optout-chat-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("produces no triage advisory when prompt contains 'no workflow' opt-out", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-optout-noworkflow-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-optout-noworkflow-1",
          thread_id: "thread-optout-noworkflow-1",
          turn_id: "turn-optout-noworkflow-1",
          prompt: "make the button blue, no workflow",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /visual\/style request/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-optout-noworkflow-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 10: Keyword on follow-up turn wins cleanly ─────────────────────

  it("keyword on turn 2 suppresses triage and writes no triage state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-kw-followup-"));
    const sessionId = "triage-kw-followup-1";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      // Turn 1: neutral prompt — triage may or may not fire, doesn't matter
      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-kw-followup-1",
          turn_id: "turn-kw-followup-1",
          prompt: "hello",
        },
        { cwd },
      );

      // Turn 2: keyword prompt — keyword fast-path runs, triage does NOT add extra advisory
      const turn2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-kw-followup-1",
          turn_id: "turn-kw-followup-2",
          prompt: "$ralph continue",
        },
        { cwd },
      );

      assert.equal(turn2.skillState?.skill, "ralph");

      const ctx2 = String(
        (turn2.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(ctx2, /multi-step goal with no workflow keyword/);
      assert.doesNotMatch(ctx2, /read-only\/question-shaped/);
      assert.doesNotMatch(ctx2, /narrow edit-shaped/);
      assert.doesNotMatch(ctx2, /visual\/style request/);

      // No triage state written on the keyword turn
      const triageState = join(cwd, ".omx", "state", "sessions", sessionId, "prompt-routing-state.json");
      // The state from turn 1 (if any) must not have been created either (hello = PASS)
      assert.equal(existsSync(triageState), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // ── Group 11: Config-disabled path ───────────────────────────────────────

  it("produces no triage advisory and no state when triage is disabled in config", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "omx-triage-config-disabled-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-config-disabled-cwd-"));
    try {
      // Write a .omx-config.json in the fake CODEX_HOME that disables triage
      await writeJson(join(tmpHome, ".omx-config.json"), {
        promptRouting: { triage: { enabled: false } },
      });
      process.env.CODEX_HOME = tmpHome;
      resetTriageConfigCache();

      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-disabled-1",
          thread_id: "thread-triage-disabled-1",
          turn_id: "turn-triage-disabled-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(additionalContext, /multi-step goal with no workflow keyword/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-disabled-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), false);
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps triage default-enabled when config omits promptRouting.triage.enabled", async () => {
    const tmpHome = await mkdtemp(join(tmpdir(), "omx-triage-config-omitted-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-config-omitted-cwd-"));
    const previousCodexHome = process.env.CODEX_HOME;
    try {
      await writeJson(join(tmpHome, ".omx-config.json"), {
        promptRouting: {},
      });
      process.env.CODEX_HOME = tmpHome;
      resetTriageConfigCache();

      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "triage-defaulted-1",
          thread_id: "thread-triage-defaulted-1",
          turn_id: "turn-triage-defaulted-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /multi-step goal with no workflow keyword/);

      const stateFile = join(cwd, ".omx", "state", "sessions", "triage-defaulted-1", "prompt-routing-state.json");
      assert.equal(existsSync(stateFile), true);
    } finally {
      if (typeof previousCodexHome === "string") process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
      resetTriageConfigCache();
      await rm(tmpHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not suppress a short anchored follow-up that is a new request", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-short-new-request-"));
    const sessionId = "triage-short-new-request-1";
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-short-new-request-1",
          turn_id: "turn-short-new-request-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );

      const turn2 = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: "thread-short-new-request-1",
          turn_id: "turn-short-new-request-2",
          prompt: "fix typo in src/foo.ts",
        },
        { cwd },
      );

      const ctx2 = String(
        (turn2.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(ctx2, /narrow edit-shaped/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips triage state persistence for malformed explicit session ids without writing root state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-triage-invalid-session-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "bad/session",
          thread_id: "thread-triage-invalid-session-1",
          turn_id: "turn-triage-invalid-session-1",
          prompt: "add dark mode toggle to the settings page",
        },
        { cwd },
      );

      const additionalContext = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } })?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.match(additionalContext, /multi-step goal with no workflow keyword/);
      assert.equal(existsSync(join(cwd, ".omx", "state", "prompt-routing-state.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
