import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MANAGED_HOOK_EVENTS, buildManagedCodexHooksConfig } from "../../config/codex-hooks.js";
import { writeSessionStart } from "../../hooks/session.js";
import { readSubagentTrackingState, recordNativeSubagentAuthorityObservation } from "../../subagents/tracker.js";
import { dispatchCodexNativeHook, mapCodexHookEventToOmxEvent } from "../codex-native-hook.js";
import { CODEX_HOOK_EVENT_NAMES, extractRawCodexHookEventName } from "../hook-payload-guard.js";
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
});
