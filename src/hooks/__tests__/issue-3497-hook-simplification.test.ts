import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";

import {
  TEAM_TMUX_CAPABILITY_WARNING,
  buildAdvisoryPreToolUseOutput,
  buildTeamCapabilityWarningMessage,
} from "../native/capability-warnings.js";
import { sanitizeNativeHookOutput, toAdvisoryOrCancelPreToolUseOutput } from "../native/pre-tool-use-advisory.js";
import { dispatchCodexNativeHook } from "../../scripts/codex-native-hook.js";
import { buildNativePreToolUseOutput, classifyOmxQuestionPreToolUse } from "../../scripts/codex-native-pre-post.js";

describe("issue #3497 hook simplification / Codex App capability warnings", () => {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;

  before(() => {
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  after(() => {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
    if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = previousTmuxPane;
  });

  it("converts PreToolUse deny/block into advisory output", () => {
    const advisory = toAdvisoryOrCancelPreToolUseOutput({
      decision: "block",
      reason: "planning gate would have locked here",
      systemMessage: "do not hard-lock ordinary work",
    });
    assert.ok(advisory);
    assert.notEqual((advisory as { decision?: string }).decision, "block");
    assert.notEqual(
      (advisory as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
      "deny",
    );
    assert.match(String(advisory.systemMessage), /do not hard-lock|planning gate/);
  });

  it("preserves authority-decreasing cancel deny", () => {
    const cancel = toAdvisoryOrCancelPreToolUseOutput({
      decision: "block",
      reason: "OMX direct cancellation completed for this session; the external command was intentionally not executed.",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "cancelled_exact_session",
      },
    });
    assert.equal(
      (cancel as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput
        .permissionDecision,
      "deny",
    );
    assert.equal(
      (cancel as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput
        .permissionDecisionReason,
      "cancelled_exact_session",
    );
  });

  it("sanitizeNativeHookOutput is advisory for ordinary PreToolUse denies", () => {
    const out = sanitizeNativeHookOutput("PreToolUse", {
      decision: "block",
      reason: "conductor write guard",
    });
    assert.ok(out);
    assert.notEqual(
      (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision,
      "deny",
    );
  });

  it("outside-tmux omx team emits capability warning, not a lock", () => {
    const output = buildNativePreToolUseOutput({
      tool_name: "Bash",
      tool_input: { command: "omx team status demo" },
      cwd: process.cwd(),
      session_id: "sess-3497-team",
      source: "native",
    });
    assert.ok(output);
    assert.notEqual((output as { decision?: string }).decision, "block");
    assert.match(String(output.systemMessage ?? ""), /Capability warning|team features require/i);
    assert.match(TEAM_TMUX_CAPABILITY_WARNING, /tmux/i);
    assert.match(buildTeamCapabilityWarningMessage("x"), /Original command|tmux|x/i);
  });

  it("outside-tmux omx question is advisory capability warning", () => {
    const classification = classifyOmxQuestionPreToolUse("omx question --prompt hi", {
      tool_name: "Bash",
      tool_input: { command: "omx question --prompt hi" },
      cwd: process.cwd(),
      session_id: "sess-3497-q",
      source: "native",
    });
    assert.equal(classification.kind, "denied");
    if (classification.kind !== "denied") return;
    assert.notEqual(classification.output.decision, "block");
    assert.match(String(classification.output.systemMessage ?? ""), /Capability warning/i);
  });

  it("buildAdvisoryPreToolUseOutput never sets permissionDecision deny", () => {
    const out = buildAdvisoryPreToolUseOutput("hello advisory");
    assert.equal(
      (out.hookSpecificOutput as { permissionDecision?: string }).permissionDecision,
      undefined,
    );
    assert.equal(out.decision, undefined);
  });

  it("Codex App (no tmux) ordinary PreToolUse Bash path does not lock", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3497-ordinary-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo ordinary-path" },
          cwd,
          session_id: "sess-3497-ordinary",
          source: "native",
        },
        { cwd },
      );
      const output = result.outputJson;
      if (output) {
        assert.notEqual(output.decision, "block");
        const permission = (output.hookSpecificOutput as { permissionDecision?: string } | undefined)
          ?.permissionDecision;
        assert.notEqual(permission, "deny");
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps Autopilot lifecycle and service metadata writes advisory across phases", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3497-autopilot-service-"));
    const sessionId = "sess-3497-autopilot-service";
    const stateDir = join(cwd, ".omx", "state");
    const sessionDir = join(stateDir, "sessions", sessionId);
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, "session.json"), JSON.stringify({ session_id: sessionId, cwd, state_root: stateDir }));
      for (const phase of ["deep-interview", "ralplan", "ultragoal", "code-review"]) {
        await writeFile(join(sessionDir, "autopilot-state.json"), JSON.stringify({ mode: "autopilot", active: true, current_phase: phase, session_id: sessionId }));
        for (const tool of [
          { name: "Bash", input: { command: `omx state write --input '{"mode":"autopilot","current_phase":"${phase}"}' --json` } },
          { name: "Bash", input: { command: 'omx ultragoal checkpoint --goal-id G001 --status complete --evidence verified --codex-goal-json snapshot.json' } },
          { name: "Edit", input: { file_path: join(sessionDir, "autopilot-state.json") } },
          { name: "Edit", input: { file_path: join(cwd, ".omx", "ultragoal", "ledger.jsonl") } },
        ]) {
          const result = await dispatchCodexNativeHook({
            hook_event_name: "PreToolUse", tool_name: tool.name, tool_input: tool.input,
            cwd, session_id: sessionId, source: "native",
          }, { cwd });
          assert.notEqual(result.outputJson?.decision, "block", `${phase}: ${tool.name}`);
          assert.notEqual((result.outputJson?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision, "deny", `${phase}: ${tool.name}`);
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("Codex App (no tmux) UserPromptSubmit $ultragoal is not hard-blocked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3497-ultragoal-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "$ultragoal implement a tiny fix",
          cwd,
          session_id: "sess-3497-ultragoal",
          source: "native",
        },
        { cwd },
      );
      const skill = result.skillState as { skill?: string; transition_error?: string; active?: boolean } | null;
      // May activate or seed ultragoal; must not carry the old outside-tmux hard lock reason.
      if (skill?.transition_error) {
        assert.doesNotMatch(skill.transition_error, /OMX-ULTRAGOAL-NO-OWNER/);
        assert.doesNotMatch(skill.transition_error, /cannot activate.*ultragoal/i);
      }
      const ctx = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext ?? "",
      );
      assert.doesNotMatch(ctx, /OMX-ULTRAGOAL-NO-OWNER/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("Codex App (no tmux) $team yields capability warning instead of locking tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3497-team-prompt-"));
    try {
      const result = await dispatchCodexNativeHook(
        {
          hook_event_name: "UserPromptSubmit",
          prompt: "$team split this across workers",
          cwd,
          session_id: "sess-3497-team-prompt",
          source: "native",
        },
        { cwd },
      );
      const skill = result.skillState as { skill?: string; transition_error?: string; active?: boolean } | null;
      const ctx = String(
        (result.outputJson as { hookSpecificOutput?: { additionalContext?: string } } | null)
          ?.hookSpecificOutput?.additionalContext ?? "",
      );
      const combined = `${skill?.transition_error ?? ""}\n${ctx}`;
      assert.match(combined, /Capability warning|tmux/i);
      assert.doesNotMatch(combined, /denied workflow keyword/i);
      // Team must not hard-activate as a live workflow on outside-tmux.
      if (skill?.skill === "team") {
        assert.equal(skill.active, false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
