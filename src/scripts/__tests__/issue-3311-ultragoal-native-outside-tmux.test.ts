import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

// Regression coverage for OMX #3311: on native Codex App / native-hook
// surfaces outside tmux, standalone Ultragoal must not activate an
// execution-blocking Main-root Conductor state when no authorized executor
// will ever be reachable (Team is tmux-only; native child/descendant
// provenance intentionally grants no write authority per #3127). The guard
// under test refuses the *activation* write itself; it must never affect
// already-active sessions, non-ultragoal modes, non-native launchers, or
// attached-tmux transport.

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value, null, 2));
}

const ACTIVATION_INPUT = JSON.stringify({
  mode: "ultragoal",
  active: true,
  current_phase: "planning",
});

async function writeLeaderSessionFixture(
  stateDir: string,
  sessionId: string,
  leaderThreadId: string,
  cwd: string,
): Promise<void> {
  await writeJson(join(stateDir, "session.json"), {
    session_id: sessionId,
    native_session_id: leaderThreadId,
    cwd,
  });
  await writeJson(join(stateDir, "subagent-tracking.json"), {
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: leaderThreadId,
        threads: {
          [leaderThreadId]: { thread_id: leaderThreadId, kind: "leader" },
        },
      },
    },
  });
}

describe("issue-3311: standalone Ultragoal native-App outside-tmux activation guard", () => {
  const originalTmux = process.env.TMUX;

  afterEach(() => {
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  });

  it("blocks fresh standalone-ultragoal Conductor activation on native App outside tmux (Bash state write)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-bash-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-bash-no-owner";
      const leaderThreadId = "thread-3311-bash-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${ACTIVATION_INPUT}' --json` },
        },
        { cwd },
      );

      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      const context = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(context, /native child\/descendant provenance does not grant write authority/);
      assert.doesNotMatch(context, /write-assignment|assignment-backed|scoped native .*grant/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fresh standalone-ultragoal Conductor activation on native App outside tmux (structured state_write)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-mcp-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-mcp-no-owner";
      const leaderThreadId = "thread-3311-mcp-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "mcp__omx_state__state_write",
          tool_input: { mode: "ultragoal", active: true, current_phase: "planning" },
        },
        { cwd },
      );

      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      const context = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(context, /native child\/descendant provenance does not grant write authority/);
      assert.doesNotMatch(context, /write-assignment|assignment-backed|scoped native .*grant/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fresh standalone-ultragoal Conductor activation via a compound Bash command (leading unrelated omx state write)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-bash-compound-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-bash-compound-no-owner";
      const leaderThreadId = "thread-3311-bash-compound-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const benignInput = JSON.stringify({ mode: "team", active: false });
      const command = `omx state write --input '${benignInput}' --json; omx state write --input '${ACTIVATION_INPUT}' --json`;

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command },
        },
        { cwd },
      );

      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      const context = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(context, /native child\/descendant provenance does not grant write authority/);
      assert.doesNotMatch(context, /write-assignment|assignment-backed|scoped native .*grant/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks fresh standalone-ultragoal Conductor activation via a nested MCP state_write payload (state:{current_phase})", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-mcp-nested-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-mcp-nested-no-owner";
      const leaderThreadId = "thread-3311-mcp-nested-no-owner";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "mcp__omx_state__state_write",
          tool_input: { mode: "ultragoal", active: true, state: { current_phase: "planning" } },
        },
        { cwd },
      );

      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows the same activation write when attached to tmux (Team is reachable)", async () => {
    process.env.TMUX = "/tmp/tmux-3311,12345,0";
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-tmux-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-tmux-attached";
      const leaderThreadId = "thread-3311-tmux-attached";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${ACTIVATION_INPUT}' --json` },
        },
        { cwd },
      );

      assert.notEqual(result.outputJson?.decision, "block");
      assert.doesNotMatch(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows the same activation write from a non-native (CLI) launcher outside tmux", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-cli-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-cli-launcher";
      const leaderThreadId = "thread-3311-cli-launcher";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "cli",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${ACTIVATION_INPUT}' --json` },
        },
        { cwd },
      );

      assert.notEqual(result.outputJson?.decision, "block");
      assert.doesNotMatch(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not re-block an already-active ultragoal session on a phase update (prior plan / live session untouched)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-already-active-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-already-active";
      const leaderThreadId = "thread-3311-already-active";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);
      await writeJson(join(stateDir, "sessions", sessionId, "skill-active-state.json"), {
        active: true,
        skill: "ultragoal",
        phase: "planning",
        session_id: sessionId,
        active_skills: [{ skill: "ultragoal", phase: "planning", active: true, session_id: sessionId }],
      });
      await writeJson(join(stateDir, "sessions", sessionId, "ultragoal-state.json"), {
        active: true,
        mode: "ultragoal",
        current_phase: "planning",
        session_id: sessionId,
      });

      const phaseUpdateInput = JSON.stringify({ mode: "ultragoal", active: true, current_phase: "executing" });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${phaseUpdateInput}' --json` },
        },
        { cwd },
      );

      // The new pre-activation guard must never fire here; the existing
      // Main-root Conductor write-guard (unchanged by this fix) governs
      // already-active sessions instead.
      assert.doesNotMatch(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block a native-child actor's attempted activation write (existing OWNER_CONFIRMATION_REQUIRED path applies unchanged)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-native-child-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-native-child";
      const leaderThreadId = "thread-3311-native-child-leader";
      const childThreadId = "thread-3311-native-child-worker";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: childThreadId,
          agent_id: childThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${ACTIVATION_INPUT}' --json` },
        },
        { cwd },
      );

      assert.doesNotMatch(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block autopilot-supervised ultragoal activation (mode is autopilot, not standalone ultragoal)", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-autopilot-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-autopilot-child";
      const leaderThreadId = "thread-3311-autopilot-child";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);

      const autopilotInput = JSON.stringify({ mode: "autopilot", active: true, current_phase: "ultragoal" });
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          agent_id: leaderThreadId,
          source: "native",
          tool_name: "Bash",
          tool_input: { command: `omx state write --input '${autopilotInput}' --json` },
        },
        { cwd },
      );

      assert.doesNotMatch(String(result.outputJson?.reason ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // --- Primary activation path: UserPromptSubmit "$ultragoal ..." ---
  // recordSkillActivation -> persistStatefulSkillSeedState seeds active/planning
  // ultragoal state synchronously as a side effect of prompt handling, before any
  // PreToolUse call occurs. These cases exercise that exact seeding path (the
  // reported #3311 repro: "invoke standalone Ultragoal for a new scoped
  // implementation task" -> state becomes active/planning), not a raw PreToolUse
  // state write.

  it("blocks the primary '$ultragoal' UserPromptSubmit activation on native App outside tmux, with a prior completed plan present", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-prompt-no-owner-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      // A prior completed plan must not be silently reused, and must not by
      // itself make the activation reachable (Team/child authority are still
      // absent on this surface either way).
      await writeJson(join(cwd, ".omx", "ultragoal", "goals.json"), {
        version: 1,
        brief: "prior completed launch",
        goals: [{ id: "G000", title: "Prior", objective: "Prior", status: "complete" }],
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-3311-prompt-no-owner",
          thread_id: "thread-3311-prompt-no-owner",
          turn_id: "turn-3311-prompt-no-owner",
          source: "native",
          prompt: "$ultragoal split this launch into durable goals",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.active, false);
      assert.equal(result.skillState?.skill, "ultragoal");
      assert.match(String(result.skillState?.transition_error ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext || "",
      );
      assert.match(message, /OMX-ULTRAGOAL-NO-OWNER/);

      // The deadlock-causing seed file must never be written for this fresh
      // no-owner activation.
      assert.equal(
        existsSync(join(cwd, ".omx", "state", "sessions", "sess-3311-prompt-no-owner", "ultragoal-state.json")),
        false,
      );
      // The prior completed plan is untouched (not silently reused/rewritten).
      const priorPlan = JSON.parse(
        readFileSync(join(cwd, ".omx", "ultragoal", "goals.json"), "utf-8"),
      ) as { goals?: Array<{ id?: string; status?: string }> };
      assert.equal(priorPlan.goals?.[0]?.status, "complete");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("allows the primary '$ultragoal' UserPromptSubmit activation when attached to tmux (Team is reachable)", async () => {
    process.env.TMUX = "/tmp/tmux-3311-prompt,12345,0";
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-prompt-tmux-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-3311-prompt-tmux",
          thread_id: "thread-3311-prompt-tmux",
          turn_id: "turn-3311-prompt-tmux",
          source: "native",
          prompt: "$ultragoal split this launch into durable goals",
        },
        { cwd },
      );

      assert.equal(result.skillState?.skill, "ultragoal");
      assert.equal(result.skillState?.initialized_mode, "ultragoal");
      assert.equal(result.skillState?.transition_error, undefined);
      assert.equal(
        existsSync(join(cwd, ".omx", "state", "sessions", "sess-3311-prompt-tmux", "ultragoal-state.json")),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not re-block continuation of an already-active '$ultragoal' UserPromptSubmit session outside tmux", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-prompt-continue-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-prompt-continue";
      const leaderThreadId = "thread-3311-prompt-continue";
      await writeLeaderSessionFixture(stateDir, sessionId, leaderThreadId, cwd);
      await writeJson(join(stateDir, "sessions", sessionId, "skill-active-state.json"), {
        active: true,
        skill: "ultragoal",
        phase: "planning",
        session_id: sessionId,
        active_skills: [{ skill: "ultragoal", phase: "planning", active: true, session_id: sessionId }],
      });
      await writeJson(join(stateDir, "sessions", sessionId, "ultragoal-state.json"), {
        active: true,
        mode: "ultragoal",
        current_phase: "planning",
        session_id: sessionId,
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: leaderThreadId,
          turn_id: "turn-3311-prompt-continue",
          source: "native",
          prompt: "$ultragoal continue with the next milestone",
        },
        { cwd },
      );

      assert.doesNotMatch(String(result.skillState?.transition_error ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not block the primary '$ultragoal' UserPromptSubmit activation from a non-native (CLI) launcher outside tmux", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-prompt-cli-"));
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: "sess-3311-prompt-cli",
          thread_id: "thread-3311-prompt-cli",
          turn_id: "turn-3311-prompt-cli",
          source: "cli",
          prompt: "$ultragoal split this launch into durable goals",
        },
        { cwd },
      );

      assert.equal(result.skillState?.initialized_mode, "ultragoal");
      assert.equal(result.skillState?.transition_error, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // --- Autopilot-supervised child recognition must not be intercepted ---
  // #3311 repair-2: the prompt guard must refuse only a truly *standalone*
  // fresh Ultragoal activation. When Autopilot is already active and
  // supervising a child phase (e.g. ralplan), a "$ultragoal" prompt is a
  // supervised-child transition handled entirely by recordSkillActivation's
  // own isAutopilotSupervisedChildSkill branch; it must remain reachable on
  // native App outside tmux exactly as it was on the pre-#3311-fix baseline.

  it("does not intercept Autopilot-supervised '$ultragoal' child-phase recognition on native App outside tmux", async () => {
    delete process.env.TMUX;
    const cwd = await mkdtemp(join(tmpdir(), "omx-native-hook-3311-autopilot-supervised-"));
    try {
      const stateDir = join(cwd, ".omx", "state");
      const sessionId = "sess-3311-autopilot-supervised";
      const threadId = "thread-3311-autopilot-supervised";
      await mkdir(join(stateDir, "sessions", sessionId), { recursive: true });
      await writeJson(join(stateDir, "sessions", sessionId, "skill-active-state.json"), {
        active: true,
        skill: "autopilot",
        phase: "ralplan",
        session_id: sessionId,
        active_skills: [{ skill: "autopilot", phase: "ralplan", active: true, session_id: sessionId }],
      });
      await writeJson(join(stateDir, "sessions", sessionId, "autopilot-state.json"), {
        active: true,
        mode: "autopilot",
        current_phase: "ralplan",
        session_id: sessionId,
        state: {
          handoff_artifacts: {
            ralplan_consensus_gate: { required: true, complete: false },
          },
        },
      });

      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          cwd,
          session_id: sessionId,
          thread_id: threadId,
          turn_id: "turn-3311-autopilot-supervised",
          source: "native",
          prompt: "$ultragoal turn the approved plan into durable goals",
        },
        { cwd },
      );

      assert.equal(result.omxEventName, "keyword-detector");
      assert.equal(result.skillState?.active, true);
      assert.equal(result.skillState?.skill, "autopilot");
      assert.equal(result.skillState?.supervised_child_skill, "ultragoal");
      assert.equal(result.skillState?.transition_error, undefined);
      assert.doesNotMatch(String(result.skillState?.transition_error ?? ""), /OMX-ULTRAGOAL-NO-OWNER/);
      const message = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext || "",
      );
      assert.doesNotMatch(message, /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
