import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MANAGED_HOOK_EVENTS, buildManagedCodexHooksConfig } from "../../config/codex-hooks.js";
import { writeSessionStart } from "../../hooks/session.js";
import { createSubagentTrackingState, readSubagentTrackingState, recordNativeSubagentAuthorityObservation, recordSubagentTurn, withCrossProcessFileLockSync } from "../../subagents/tracker.js";
import { dispatchCodexNativeHook, mapCodexHookEventToOmxEvent } from "../codex-native-hook.js";
import { CODEX_HOOK_EVENT_NAMES, extractRawCodexHookEventName, MAX_NATIVE_STDIN_JSON_BYTES } from "../hook-payload-guard.js";
import { MANAGED_CODEX_HOOK_EVENTS } from "../smoke-packed-install.js";

describe("native hook protocol compatibility", () => {
  let cwd: string;
  let env: NodeJS.ProcessEnv;
  const sessionId = "omx-protocol-session";
  const parentId = "native-parent";
  const agentId = "native-child";

  beforeEach(async () => {
    env = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("OMX_") || key === "CODEX_THREAD_ID") delete process.env[key];
    }
    cwd = await realpath(await mkdtemp(join(tmpdir(), "omx-native-protocol-")));
    process.env.CODEX_HOME = join(cwd, "codex-home");
    await mkdir(process.env.CODEX_HOME);
  });
  afterEach(async () => {
    process.env = env;
    await rm(cwd, { recursive: true, force: true });
  });

  function stop(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      hook_event_name: "SubagentStop",
      cwd,
      session_id: parentId,
      agent_id: agentId,
      agent_type: "executor",
      turn_id: "child-turn-1",
      transcript_path: null,
      agent_transcript_path: null,
      last_assistant_message: null,
      stop_hook_active: false,
      ...overrides,
    };
  }

  async function start(): Promise<void> {
    await writeSessionStart(cwd, sessionId, { nativeSessionId: parentId, pid: process.pid });
  }

  function runNativeHookCli(input = JSON.stringify(stop())) {
    return spawnSync(process.execPath, [join(process.cwd(), "dist/scripts/codex-native-hook.js")], {
      cwd, env: process.env, input, encoding: "utf8", timeout: 10_000,
    });
  }

  async function captureLifecycle(notifications: Record<string, unknown>): Promise<string> {
    await writeFile(join(process.env.CODEX_HOME!, ".omx-config.json"), JSON.stringify({
      notifications: { enabled: true, ...notifications },
    }));
    const eventsPath = join(cwd, "child-events.jsonl");
    await mkdir(join(cwd, ".omx/hooks"), { recursive: true });
    await writeFile(join(cwd, ".omx/hooks/capture.mjs"),
      `import { appendFileSync } from 'node:fs';\nexport function onHookEvent(event) { appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\\n'); }\n`);
    return eventsPath;
  }

  for (const notifications of [
    { verbosity: "session", includeChildAgents: true },
    { verbosity: "agent" },
    { verbosity: "verbose" },
    { verbosity: "session" },
    { verbosity: "minimal" },
  ]) {
    it(`applies the SubagentStop lifecycle policy for ${JSON.stringify(notifications)}`, async () => {
      await start();
      const eventsPath = await captureLifecycle(notifications);
      await dispatchCodexNativeHook(stop());
      assert.ok((await readSubagentTrackingState(cwd)).sessions[sessionId]!.threads[agentId]!.completed_at);
      if (notifications.includeChildAgents !== true && !["agent", "verbose"].includes(notifications.verbosity)) {
        assert.equal(existsSync(eventsPath), false);
        return;
      }
      await dispatchCodexNativeHook(stop({ stop_hook_active: true, stopHookActive: true }));
      const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "subagent-stop");
      assert.equal(events[0].source, "native");
      assert.equal(events[0].session_id, sessionId);
      assert.equal(events[0].thread_id, agentId);
      assert.equal(events[0].turn_id, "child-turn-1");
      assert.equal(events[0].context.native_session_id, agentId);
      assert.equal(events[0].context.payload.session_id, parentId);
      assert.equal(events[0].context.payload.stop_hook_active, undefined);
      assert.equal(events[0].context.payload.stopHookActive, undefined);
      await dispatchCodexNativeHook(stop({ turn_id: "child-turn-2" }));
      assert.equal((await readFile(eventsPath, "utf8")).trim().split("\n").length, 2);
    });
  }

  it("deduplicates interleaved child and turn replays independently", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    await dispatchCodexNativeHook(stop());
    await dispatchCodexNativeHook(stop({ agent_id: "other-child" }));
    await dispatchCodexNativeHook(stop());
    await dispatchCodexNativeHook(stop({ turn_id: "child-turn-2" }));
    await dispatchCodexNativeHook(stop());
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => [event.thread_id, event.turn_id]), [
      [agentId, "child-turn-1"], ["other-child", "child-turn-1"], [agentId, "child-turn-2"],
    ]);
  });

  it("deduplicates lifecycle hooks when legacy Stop and SubagentStop report the same child turn", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    const legacyFirstChild = "legacy-first-child";
    const nativeFirstChild = "native-first-child";
    for (const childThreadId of [legacyFirstChild, nativeFirstChild]) {
      recordNativeSubagentAuthorityObservation(cwd, {
        sessionIds: [sessionId], childThreadId, parentThreadId: parentId,
        rootNativeSessionId: parentId, authorityEvidence: "valid",
      });
    }

    await dispatchCodexNativeHook({
      hook_event_name: "Stop", cwd, session_id: legacyFirstChild,
      thread_id: legacyFirstChild, turn_id: "turn-legacy-first", stop_hook_active: true,
    });
    await dispatchCodexNativeHook(stop({ agent_id: legacyFirstChild, turn_id: "turn-legacy-first" }));
    await dispatchCodexNativeHook(stop({ agent_id: nativeFirstChild, turn_id: "turn-native-first" }));
    await dispatchCodexNativeHook({
      hook_event_name: "Stop", cwd, session_id: nativeFirstChild,
      thread_id: nativeFirstChild, turn_id: "turn-native-first", stop_hook_active: true,
    });

    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => [event.event, event.thread_id, event.turn_id]), [
      ["stop", legacyFirstChild, "turn-legacy-first"],
      ["subagent-stop", nativeFirstChild, "turn-native-first"],
    ]);
  });

  it("does not deduplicate separate SubagentStop completions when turn IDs are absent", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    await dispatchCodexNativeHook(stop({ turn_id: null }));
    await dispatchCodexNativeHook(stop({ turn_id: null }));

    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.event), ["subagent-stop", "subagent-stop"]);
    assert.deepEqual(events.map(event => event.turn_id), [undefined, undefined]);
  });

  it("does not treat missing turn IDs as proof of a duplicate completion", () => {
    const first = recordSubagentTurn(createSubagentTrackingState(), {
      sessionId, threadId: agentId, kind: "subagent", completed: true,
      completionSource: "native_stop_event",
    });
    const second = recordSubagentTurn(first, {
      sessionId, threadId: agentId, kind: "subagent", completed: true,
      completionSource: "native_stop_event",
    });

    assert.equal(
      second.sessions[sessionId]!.threads[agentId]!.turn_count,
      first.sessions[sessionId]!.threads[agentId]!.turn_count + 1,
    );
  });

  it("keeps malformed tracker authority bytes intact and returns CLI no-op with a diagnostic", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    const trackerPath = join(cwd, ".omx/state/subagent-tracking.json");
    const malformed = '{"schemaVersion":1,"sessions":{"preserve-authority":';
    await writeFile(trackerPath, malformed);
    const result = runNativeHookCli();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(await readFile(trackerPath, "utf8"), malformed);
    assert.equal(existsSync(eventsPath), false);
    const logDir = join(cwd, ".omx/logs");
    const logFile = (await readdir(logDir)).find(name => name.startsWith("native-hook-"));
    assert.ok(logFile);
    const diagnostic = await readFile(join(logDir, logFile), "utf8");
    assert.match(diagnostic, /native_subagent_completion_tracking_error/);
    assert.match(diagnostic, /Malformed subagent tracker authority state/);
  });

  it("returns CLI no-op without dispatch or mutation when the tracker lock stays held", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    recordNativeSubagentAuthorityObservation(cwd, {
      sessionIds: [sessionId], childThreadId: agentId, parentThreadId: parentId,
      rootNativeSessionId: parentId, authorityEvidence: "valid",
    });
    const trackerPath = join(cwd, ".omx/state/subagent-tracking.json");
    const before = await readFile(trackerPath, "utf8");
    const result = withCrossProcessFileLockSync(trackerPath, () => runNativeHookCli());
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.equal(await readFile(trackerPath, "utf8"), before);
    assert.equal(existsSync(eventsPath), false);
  });

  it("rejects unbound identities before opted-in SubagentStop lifecycle dispatch", async () => {
    await start();
    const eventsPath = await captureLifecycle({ includeChildAgents: true });
    for (const overrides of [{ session_id: "foreign-parent" }, { agent_id: parentId }, { agent_id: null }]) {
      await dispatchCodexNativeHook(stop(overrides));
    }
    assert.equal(existsSync(eventsPath), false);
    assert.equal(existsSync(join(cwd, ".omx/state/subagent-tracking.json")), false);
  });

  it("keeps setup, bounded input parsing, dispatch, plugin, and packed smoke event rosters aligned", async () => {
    assert.deepEqual(CODEX_HOOK_EVENT_NAMES, MANAGED_HOOK_EVENTS);
    assert.deepEqual(MANAGED_CODEX_HOOK_EVENTS, MANAGED_HOOK_EVENTS);
    const plugin = JSON.parse(await readFile(join(process.cwd(), "plugins/oh-my-codex/hooks/hooks.json"), "utf8"));
    assert.deepEqual(Object.keys(plugin.hooks), [...MANAGED_HOOK_EVENTS]);
    const config = buildManagedCodexHooksConfig("/repo");
    assert.deepEqual(Object.keys(config.hooks), [...MANAGED_HOOK_EVENTS]);
    for (const event of MANAGED_HOOK_EVENTS) {
      assert.equal(extractRawCodexHookEventName(JSON.stringify({ hook_event_name: event })), event);
      assert.ok(mapCodexHookEventToOmxEvent(event));
      assert.match(config.hooks[event][0]!.hooks[0]!.command, /codex-native-hook\.js/);
    }
    assert.equal(mapCodexHookEventToOmxEvent("SubagentStop"), "subagent-stop");
  });

  it("records the child, accepts nullable optional fields, and never changes the leader pointer or grants authority", async () => {
    await start();
    const pointer = join(cwd, ".omx/state/session.json");
    const before = await readFile(pointer, "utf8");
    const modePath = join(cwd, ".omx/state/autopilot-state.json");
    const activeMode = JSON.stringify({ active: true, current_phase: "implementation", session_id: sessionId });
    await writeFile(modePath, activeMode);
    const result = await dispatchCodexNativeHook(stop({ future_field: { ignored: true } }));
    assert.equal(result.hookEventName, "SubagentStop");
    assert.equal(result.omxEventName, "subagent-stop");
    assert.equal(result.outputJson, null);
    assert.equal(await readFile(pointer, "utf8"), before);
    assert.equal(await readFile(modePath, "utf8"), activeMode);
    const state = await readSubagentTrackingState(cwd);
    const thread = state.sessions[sessionId]!.threads[agentId]!;
    assert.equal(thread.kind, "subagent");
    assert.equal(thread.mode, "executor");
    assert.equal(thread.completion_source, "native_stop_event");
    assert.equal(thread.last_completed_turn_id, "child-turn-1");
    assert.ok(thread.completed_at);
    assert.equal(thread.direct_child_root_id, undefined);
    assert.equal(state.sessions[sessionId]!.threads[parentId], undefined);
    assert.equal(state.sessions[parentId], undefined);
  });

  it("completes the child in every existing correlated tracker partition", async () => {
    await start();
    recordNativeSubagentAuthorityObservation(cwd, {
      sessionIds: [sessionId, parentId, "previous-canonical-session"],
      childThreadId: agentId,
      parentThreadId: parentId,
      rootNativeSessionId: parentId,
      authorityEvidence: "valid",
    });

    await dispatchCodexNativeHook(stop());

    const state = await readSubagentTrackingState(cwd);
    for (const partitionId of [sessionId, parentId, "previous-canonical-session"]) {
      const thread = state.sessions[partitionId]?.threads[agentId];
      assert.equal(thread?.kind, "subagent");
      assert.equal(thread?.completion_source, "native_stop_event");
      assert.equal(thread?.last_completed_turn_id, "child-turn-1");
      assert.ok(thread?.completed_at);
      assert.equal(thread?.status, "closed");
      assert.equal(thread?.direct_child_root_id, parentId);
    }
  });

  it("deduplicates replays and legacy Stop for the same child turn, but records a new turn", async () => {
    await start();
    recordNativeSubagentAuthorityObservation(cwd, {
      sessionIds: [sessionId], childThreadId: agentId, parentThreadId: parentId,
      rootNativeSessionId: parentId, authorityEvidence: "valid",
    });
    const legacy = { hook_event_name: "Stop", cwd, session_id: sessionId, thread_id: agentId,
      turn_id: "child-turn-1", stop_hook_active: true };
    await dispatchCodexNativeHook(legacy);
    const first = (await readSubagentTrackingState(cwd)).sessions[sessionId]!.threads[agentId]!;
    await Promise.all([dispatchCodexNativeHook(stop()), dispatchCodexNativeHook(stop())]);
    await dispatchCodexNativeHook(legacy);
    const replay = (await readSubagentTrackingState(cwd)).sessions[sessionId]!.threads[agentId]!;
    assert.deepEqual(replay, first);
    await dispatchCodexNativeHook(stop({ turn_id: "child-turn-2" }));
    const next = (await readSubagentTrackingState(cwd)).sessions[sessionId]!.threads[agentId]!;
    assert.equal(next.turn_count, first.turn_count + 1);
    assert.equal(next.last_completed_turn_id, "child-turn-2");
  });

  it("ignores absent, malformed, conflicting, foreign, or leader identities without creating tracking state", async () => {
    await start();
    for (const overrides of [
      { agent_id: null }, { agent_id: "" }, { agent_id: {} }, { agent_id: "../escape" },
      { agent_id: parentId }, { agent_id: sessionId }, { session_id: null },
      { session_id: "" }, { session_id: {} }, { session_id: "other-session" },
      { sessionId: "conflicting-session" },
    ]) {
      const result = await dispatchCodexNativeHook(stop(overrides));
      assert.equal(result.outputJson, null);
      assert.equal(existsSync(join(cwd, ".omx/state/subagent-tracking.json")), false, JSON.stringify(overrides));
    }
  });

  it("does not promote a legacy child Stop without thread_id into its own leader session", async () => {
    await start();
    recordNativeSubagentAuthorityObservation(cwd, {
      sessionIds: [sessionId], childThreadId: agentId, parentThreadId: parentId,
      rootNativeSessionId: parentId, authorityEvidence: "valid",
    });
    const before = await readSubagentTrackingState(cwd);
    await dispatchCodexNativeHook({
      hook_event_name: "Stop", cwd, session_id: agentId,
      turn_id: "child-turn-1", stop_hook_active: true,
    });
    assert.deepEqual(await readSubagentTrackingState(cwd), before);
    await dispatchCodexNativeHook(stop());
    const state = await readSubagentTrackingState(cwd);
    assert.equal(state.sessions[agentId], undefined);
    assert.ok(state.sessions[sessionId]!.threads[agentId]!.completed_at);
  });

  it("does not bootstrap a root session from a standalone SubagentStop", async () => {
    assert.equal((await dispatchCodexNativeHook(stop())).outputJson, null);
    assert.equal(existsSync(join(cwd, ".omx")), false);
  });

  it("does not apply leader Stop behavior to malformed SubagentStop input", async () => {
    await start();
    const result = runNativeHookCli('{"hook_event_name":"SubagentStop",');

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  it("does not block an oversized SubagentStop completion", async () => {
    await start();
    const result = runNativeHookCli(JSON.stringify({
      ...stop(),
      oversized_field: "x".repeat(MAX_NATIVE_STDIN_JSON_BYTES),
    }));

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });
});
