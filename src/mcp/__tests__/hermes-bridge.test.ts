import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  hermesListQuestionEvents,
  hermesListQuestions,
  hermesListArtifacts,
  hermesListSessions,
  hermesReadArtifact,
  hermesReadStatus,
  hermesReadTail,
  hermesReportStatus,
  hermesSendPrompt,
  hermesSubmitQuestionAnswer,
  hermesStartSession,
} from "../hermes-bridge.js";
import { createQuestionRecord, markQuestionPrompting } from "../../question/state.js";

const originalRoots = process.env.OMX_MCP_WORKDIR_ROOTS;
const originalOmxRoot = process.env.OMX_ROOT;
const originalOmxStateRoot = process.env.OMX_STATE_ROOT;
const originalTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
const originalSessionId = process.env.OMX_SESSION_ID;
const originalCodexSessionId = process.env.CODEX_SESSION_ID;
const originalGenericSessionId = process.env.SESSION_ID;

beforeEach(() => {
  delete process.env.OMX_MCP_WORKDIR_ROOTS;
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.SESSION_ID;
});

afterEach(() => {
  if (typeof originalRoots === "string") process.env.OMX_MCP_WORKDIR_ROOTS = originalRoots;
  else delete process.env.OMX_MCP_WORKDIR_ROOTS;
  if (typeof originalOmxRoot === "string") process.env.OMX_ROOT = originalOmxRoot;
  else delete process.env.OMX_ROOT;
  if (typeof originalOmxStateRoot === "string") process.env.OMX_STATE_ROOT = originalOmxStateRoot;
  else delete process.env.OMX_STATE_ROOT;
  if (typeof originalTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = originalTeamStateRoot;
  else delete process.env.OMX_TEAM_STATE_ROOT;
  if (typeof originalSessionId === "string") process.env.OMX_SESSION_ID = originalSessionId;
  else delete process.env.OMX_SESSION_ID;
  if (typeof originalCodexSessionId === "string") process.env.CODEX_SESSION_ID = originalCodexSessionId;
  else delete process.env.CODEX_SESSION_ID;
  if (typeof originalGenericSessionId === "string") process.env.SESSION_ID = originalGenericSessionId;
  else delete process.env.SESSION_ID;
});

async function tempWorkspace(name: string): Promise<string> {
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  return await realpath(await mkdtemp(join(await realpath(tmpdir()), name)));
}

describe("Hermes MCP bridge core", () => {
  it("lists session-scoped OMX state without exposing terminal internals", async () => {
    const cwd = await tempWorkspace("omx-hermes-list-");
    try {
      await mkdir(join(cwd, ".omx", "state", "sessions", "sess-a"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "state", "sessions", "sess-a", "ralph-state.json"),
        JSON.stringify({ active: true, current_phase: "executing" }),
      );

      const result = await hermesListSessions({ workingDirectory: cwd });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.sessions, [
        { session_id: "sess-a", active: false, source: "session_state_dir", modes: ["ralph"] },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("projects status without leaking raw internal mode state", async () => {
    const cwd = await tempWorkspace("omx-hermes-status-");
    try {
      await mkdir(join(cwd, ".omx", "state", "sessions", "sess-a"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "state", "sessions", "sess-a", "ralph-state.json"),
        JSON.stringify({
          active: true,
          current_phase: "verifying",
          run_outcome: "continue",
          lifecycle_outcome: "finished",
          updated_at: "2026-05-11T00:00:00.000Z",
          completed_at: "2026-05-11T00:01:00.000Z",
          private_control_room: { token: "do-not-leak" },
          state: { prompt_to_artifact_checklist: ["internal"] },
        }),
      );

      const result = await hermesReadStatus({ workingDirectory: cwd, session_id: "sess-a" });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.modes, [
        {
          mode: "ralph",
          scope: "session",
          active: true,
          phase: "verifying",
          run_outcome: "continue",
          lifecycle_outcome: "finished",
          updated_at: "2026-05-11T00:00:00.000Z",
          completed_at: "2026-05-11T00:01:00.000Z",
        },
      ]);
      assert.equal(JSON.stringify(result).includes("do-not-leak"), false);
      assert.equal(JSON.stringify(result).includes("prompt_to_artifact_checklist"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("projects current session metadata without leaking process or tmux internals", async () => {
    const cwd = await tempWorkspace("omx-hermes-current-status-");
    try {
      const result = await hermesReadStatus(
        { workingDirectory: cwd },
        {
          readUsableSessionState: async () => ({
            session_id: "sess-current",
            native_session_id: "native-current",
            cwd,
            started_at: "2026-05-11T00:00:00.000Z",
            pid: 12345,
            pid_cmdline: "codex --secret",
            pid_start_ticks: 67890,
            tmux_session_name: "private-tmux",
          }),
        },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.session, {
        session_id: "sess-current",
        native_session_id: "native-current",
        cwd,
        started_at: "2026-05-11T00:00:00.000Z",
      });
      assert.equal(JSON.stringify(result).includes("12345"), false);
      assert.equal(JSON.stringify(result).includes("codex --secret"), false);
      assert.equal(JSON.stringify(result).includes("private-tmux"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads a bounded session-history tail without tmux scrollback", async () => {
    const cwd = await tempWorkspace("omx-hermes-tail-");
    try {
      await mkdir(join(cwd, ".omx", "logs"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "logs", "session-history.jsonl"),
        ["one", "two", "three"].map((message) => JSON.stringify({ message })).join("\n") + "\n",
      );

      const result = await hermesReadTail({ workingDirectory: cwd, lines: 2 });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.tail, [JSON.stringify({ message: "two" }), JSON.stringify({ message: "three" })]);
      assert.match(result.data?.path ?? "", /session-history\.jsonl$/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("requires explicit mutation opt-in before queuing prompts", async () => {
    const result = await hermesSendPrompt({ session_id: "sess-a", prompt: "continue" });

    assert.equal(result.ok, false);
    assert.equal(result.code, "mutation_not_allowed");
  });

  it("lists question events and submits bounded answers with safe leader-pane resume injection", async () => {
    const cwd = await tempWorkspace("omx-hermes-questions-");
    try {
      const { record, recordPath } = await createQuestionRecord(cwd, {
        question: "Pick one",
        options: [{ label: "A", value: "a" }],
        allow_other: false,
        other_label: "Other",
        multi_select: false,
        source: "hermes-test",
      }, "sess-q", new Date("2026-05-11T00:00:00.000Z"), {
        emitEvent: true,
        runId: "run-q",
      });
      await markQuestionPrompting(recordPath, {
        renderer: "tmux-pane",
        target: "%42",
        launched_at: "2026-05-14T00:00:00.000Z",
        return_target: "%11",
        return_transport: "tmux-send-keys",
      });

      const listed = await hermesListQuestions({ workingDirectory: cwd, session_id: "sess-q" });
      assert.equal(listed.ok, true);
      assert.equal(listed.data?.questions[0]?.question_id, record.question_id);
      assert.equal(listed.data?.questions[0]?.source, "hermes-test");
      assert.equal(JSON.stringify(listed).includes("tmux scrollback"), false);

      const events = await hermesListQuestionEvents({ workingDirectory: cwd });
      assert.equal(events.ok, true);
      assert.equal(events.data?.events[0]?.type, "question-created");
      assert.equal(events.data?.events[0]?.run_id, "run-q");

      const missingMutation = await hermesSubmitQuestionAnswer({
        workingDirectory: cwd,
        session_id: "sess-q",
        question_id: record.question_id,
        answer: { kind: "option", value: "a", selected_labels: ["A"], selected_values: ["a"] },
      });
      assert.equal(missingMutation.ok, false);
      assert.equal(missingMutation.code, "mutation_not_allowed");

      const injected: Array<{ paneId: string; value: string | string[] }> = [];
      const submitted = await hermesSubmitQuestionAnswer(
        {
          workingDirectory: cwd,
          session_id: "sess-q",
          question_id: record.question_id,
          answer: { kind: "option", value: "a", selected_labels: ["A"], selected_values: ["a"] },
          allow_mutation: true,
        },
        {
          injectAnswersToPane: (paneId, answers) => {
            injected.push({ paneId, value: answers[0]!.answer.value });
            return true;
          },
        },
      );
      assert.equal(submitted.ok, true);
      assert.equal(submitted.data?.question.status, "answered");
      assert.equal(submitted.data?.answers[0]?.answer.value, "a");
      assert.deepEqual(injected, [{ paneId: "%11", value: "a" }]);
      const answeredEvents = await hermesListQuestionEvents({ workingDirectory: cwd });
      assert.equal(answeredEvents.data?.events.find((event) => event.type === "question-answered")?.run_id, "run-q");

      const duplicate = await hermesSubmitQuestionAnswer({
        workingDirectory: cwd,
        session_id: "sess-q",
        question_id: record.question_id,
        answer: { kind: "option", value: "a", selected_labels: ["A"], selected_values: ["a"] },
        allow_mutation: true,
      });
      assert.equal(duplicate.ok, false);
      assert.equal(duplicate.code, "question_not_open");

      const unknown = await hermesSubmitQuestionAnswer({
        workingDirectory: cwd,
        session_id: "sess-q",
        question_id: "question-unknown",
        answer: { kind: "option", value: "a", selected_labels: ["A"], selected_values: ["a"] },
        allow_mutation: true,
      });
      assert.equal(unknown.ok, false);
      assert.equal(unknown.code, "question_unknown");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("routes selected prompts to a bound tmux session when no active exec queue accepts input", async () => {
    const cwd = await tempWorkspace("omx-hermes-tmux-prompt-");
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(join(cwd, ".omx", "state", "session.json"), JSON.stringify({
        session_id: "sess-tmux",
        native_session_id: "native-tmux",
        started_at: "2026-05-11T00:00:00.000Z",
        cwd,
        pid: 12345,
        tmux_session_name: "omx-detached-demo",
        tmux_pane_id: "%42",
      }));
      const tmuxCalls: string[][] = [];

      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "native-tmux", prompt: "continue\nwith care", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
          execTmuxFileSync: (args) => {
            tmuxCalls.push(args);
            if (args[0] === "show-options") return "sess-tmux\n";
            if (args[0] === "display-message") return "omx-detached-demo\n";
            return "";
          },
        },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(result.data, {
        session_id: "sess-tmux",
        tmux_session_name: "omx-detached-demo",
        target: "%42",
        transport: "tmux_send_keys",
      });
      assert.deepEqual(tmuxCalls, [
        ["has-session", "-t", "omx-detached-demo"],
        ["show-options", "-qv", "-t", "omx-detached-demo", "@omx_instance_id"],
        ["display-message", "-p", "-t", "%42", "#{session_name}"],
        ["send-keys", "-t", "%42", "-l", "--", "continue with care"],
        ["send-keys", "-t", "%42", "C-m"],
        ["send-keys", "-t", "%42", "C-m"],
      ]);
      assert.equal(tmuxCalls.some((args) => args.includes("attach-session")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns prompt_not_accepted when tmux pane delivery fails", async () => {
    const cwd = await tempWorkspace("omx-hermes-tmux-prompt-fail-");
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(join(cwd, ".omx", "state", "session.json"), JSON.stringify({
        session_id: "sess-tmux",
        started_at: "2026-05-11T00:00:00.000Z",
        cwd,
        pid: 12345,
        tmux_session_name: "omx-detached-demo",
        tmux_pane_id: "%42",
      }));

      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "sess-tmux", prompt: "continue", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
          execTmuxFileSync: (args) => {
            if (args[0] === "show-options") return "sess-tmux\n";
            if (args[0] === "display-message") return "omx-detached-demo\n";
            if (args[0] === "send-keys") throw new Error("pane closed");
            return "";
          },
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "prompt_not_accepted");
      assert.match(result.error ?? "", /unsupported_session_kind:tmux_prompt_delivery_failed:omx-detached-demo:%42:tmux_send_failed/);
      assert.doesNotMatch(result.error ?? "", /pane closed/);
      assert.doesNotMatch(result.error ?? "", /continue/);
      assert.doesNotMatch(result.error ?? "", /invalid_input/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects tmux prompt delivery when the stored target is not a pane id", async () => {
    const cwd = await tempWorkspace("omx-hermes-tmux-invalid-pane-");
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(join(cwd, ".omx", "state", "session.json"), JSON.stringify({
        session_id: "sess-tmux",
        started_at: "2026-05-11T00:00:00.000Z",
        cwd,
        pid: 12345,
        tmux_session_name: "omx-detached-demo",
        tmux_pane_id: "omx-detached-demo",
      }));
      const tmuxCalls: string[][] = [];

      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "sess-tmux", prompt: "continue", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
          execTmuxFileSync: (args) => {
            tmuxCalls.push(args);
            return "";
          },
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "prompt_not_accepted");
      assert.match(result.error ?? "", /unsupported_session_kind:invalid_tmux_pane_binding:omx-detached-demo/);
      assert.deepEqual(tmuxCalls, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects tmux prompt delivery when the stored pane is not in the bound session", async () => {
    const cwd = await tempWorkspace("omx-hermes-tmux-pane-mismatch-");
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(join(cwd, ".omx", "state", "session.json"), JSON.stringify({
        session_id: "sess-tmux",
        started_at: "2026-05-11T00:00:00.000Z",
        cwd,
        pid: 12345,
        tmux_session_name: "omx-detached-demo",
        tmux_pane_id: "%42",
      }));

      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "sess-tmux", prompt: "continue", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
          execTmuxFileSync: (args) => {
            if (args[0] === "show-options") return "sess-tmux\n";
            if (args[0] === "display-message") return "other-session\n";
            return "";
          },
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "prompt_not_accepted");
      assert.match(result.error ?? "", /unsupported_session_kind:tmux_prompt_delivery_failed:omx-detached-demo:%42:pane_session_mismatch:%42:other-session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects tmux prompt delivery when the tmux instance tag does not match session state", async () => {
    const cwd = await tempWorkspace("omx-hermes-tmux-instance-mismatch-");
    try {
      await mkdir(join(cwd, ".omx", "state"), { recursive: true });
      await writeFile(join(cwd, ".omx", "state", "session.json"), JSON.stringify({
        session_id: "sess-tmux",
        started_at: "2026-05-11T00:00:00.000Z",
        cwd,
        pid: 12345,
        tmux_session_name: "omx-detached-demo",
        tmux_pane_id: "%42",
      }));

      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "sess-tmux", prompt: "continue", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
          execTmuxFileSync: (args) => {
            if (args[0] === "show-options") return "other-session\n";
            return "";
          },
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "prompt_not_accepted");
      assert.match(result.error ?? "", /unsupported_session_kind:tmux_prompt_delivery_failed:omx-detached-demo:%42:tmux_instance_mismatch:omx-detached-demo:other-session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a clear unsupported-session-kind diagnostic when no exec or tmux binding can accept prompts", async () => {
    const cwd = await tempWorkspace("omx-hermes-no-prompt-binding-");
    try {
      const result = await hermesSendPrompt(
        { workingDirectory: cwd, session_id: "sess-missing", prompt: "continue", allow_mutation: true },
        {
          injectExecFollowup: async () => {
            throw new Error("job_not_input_accepting:no_active_exec_session");
          },
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.code, "prompt_not_accepted");
      assert.match(result.error ?? "", /unsupported_session_kind:no_active_exec_session_or_tmux_binding:sess-missing/);
      assert.doesNotMatch(result.error ?? "", /job_not_input_accepting:no_active_exec_session/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("queues selected prompts through the audited exec follow-up contract", async () => {
    const result = await hermesSendPrompt(
      { session_id: "sess-a", prompt: "continue", actor: "hermes-test", allow_mutation: true },
      {
        injectExecFollowup: async ({ sessionId, prompt, actor }) => ({
          queued: {
            id: "followup-1",
            session_id: sessionId,
            prompt,
            actor: actor ?? "missing",
            created_at: "2026-05-11T00:00:00.000Z",
          },
          queuePath: "/tmp/queue.json",
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      followup_id: "followup-1",
      session_id: "sess-a",
      queue_path: "/tmp/queue.json",
    });
  });

  it("starts sessions in tmux worktree mode and requires mutation opt-in", async () => {
    const cwd = await tempWorkspace("omx-hermes-start-");
    try {
      const observed: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
      const result = await hermesStartSession(
        { workingDirectory: cwd, prompt: "$ralph fix it", worktreeName: "pkg/demo", allow_mutation: true },
        {
          resolveOmxCliEntryPath: () => "/opt/omx/dist/cli/omx.js",
          spawnProcess: ((command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
            observed.push({ command, args, cwd: options.cwd, env: options.env });
            return { pid: 4242, unref() {} };
          }) as never,
        },
      );

      assert.equal(result.ok, true);
      assert.equal(observed[0]?.command, "/opt/omx/dist/cli/omx.js");
      assert.deepEqual(observed[0]?.args, ["--tmux", "--worktree=pkg/demo", "$ralph fix it"]);
      assert.equal(observed[0]?.cwd, cwd);
      assert.equal(observed[0]?.env?.OMX_HERMES_MCP_BRIDGE, "1");
      assert.equal(observed[0]?.env?.TMUX, undefined);
      assert.equal(observed[0]?.env?.TMUX_PANE, undefined);
      assert.equal(result.data?.pid, 4242);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("lists and reads only safe result artifact paths", async () => {
    const cwd = await tempWorkspace("omx-hermes-artifacts-");
    try {
      await mkdir(join(cwd, ".omx", "plans"), { recursive: true });
      await writeFile(join(cwd, ".omx", "plans", "prd-demo.md"), "hello artifact");

      const list = await hermesListArtifacts({ workingDirectory: cwd });
      assert.equal(list.ok, true);
      assert.deepEqual(list.data?.artifacts, [{ path: ".omx/plans/prd-demo.md", bytes: 14 }]);

      const read = await hermesReadArtifact({ workingDirectory: cwd, path: ".omx/plans/prd-demo.md", max_bytes: 5 });
      assert.equal(read.ok, true);
      assert.deepEqual(read.data, { path: ".omx/plans/prd-demo.md", content: "hello", truncated: true });

      const rejected = await hermesReadArtifact({ workingDirectory: cwd, path: "package.json" });
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, "artifact_outside_safe_roots");

      const traversal = await hermesReadArtifact({ workingDirectory: cwd, path: ".omx/plans/../../package.json" });
      assert.equal(traversal.ok, false);
      assert.equal(traversal.code, "artifact_outside_safe_roots");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("reads large artifacts with max_bytes truncation and reports stat sizes", async () => {
    const cwd = await tempWorkspace("omx-hermes-large-artifact-");
    try {
      await mkdir(join(cwd, ".omx", "plans"), { recursive: true });
      const content = `${"a".repeat(1024 * 1024)}tail`;
      await writeFile(join(cwd, ".omx", "plans", "large.md"), content);

      const list = await hermesListArtifacts({ workingDirectory: cwd });
      assert.equal(list.ok, true);
      assert.deepEqual(list.data?.artifacts, [{ path: ".omx/plans/large.md", bytes: content.length }]);

      const read = await hermesReadArtifact({ workingDirectory: cwd, path: ".omx/plans/large.md", max_bytes: 8 });
      assert.equal(read.ok, true);
      assert.deepEqual(read.data, { path: ".omx/plans/large.md", content: "aaaaaaaa", truncated: true });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads session-history tails from a bounded suffix", async () => {
    const cwd = await tempWorkspace("omx-hermes-large-tail-");
    try {
      await mkdir(join(cwd, ".omx", "logs"), { recursive: true });
      await writeFile(
        join(cwd, ".omx", "logs", "session-history.jsonl"),
        `${"ignored\n".repeat(40_000)}one\ntwo\nthree\n`,
      );

      const result = await hermesReadTail({ workingDirectory: cwd, lines: 2 });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.tail, ["two", "three"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not list artifacts from safe-root directories symlinked outside the worktree", async () => {
    const cwd = await tempWorkspace("omx-hermes-list-root-symlink-");
    const outside = await tempWorkspace("omx-hermes-list-root-outside-");
    try {
      await mkdir(join(cwd, ".omx"), { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secret.md"), "outside artifact");
      await symlink(outside, join(cwd, ".omx", "plans"));

      const result = await hermesListArtifacts({ workingDirectory: cwd });

      assert.equal(result.ok, true);
      assert.deepEqual(result.data?.artifacts, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects session-history tails symlinked outside the worktree", async () => {
    const cwd = await tempWorkspace("omx-hermes-tail-symlink-");
    const outside = await tempWorkspace("omx-hermes-tail-outside-");
    try {
      await mkdir(join(cwd, ".omx", "logs"), { recursive: true });
      const outsideLog = join(outside, "session-history.jsonl");
      await writeFile(outsideLog, "secret\n");
      await symlink(outsideLog, join(cwd, ".omx", "logs", "session-history.jsonl"));

      const result = await hermesReadTail({ workingDirectory: cwd, lines: 1 });

      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid_input");
      assert.match(result.error ?? "", /outside working directory/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects safe-root artifact symlinks that resolve outside the worktree", async () => {
    const cwd = await tempWorkspace("omx-hermes-artifact-symlink-");
    const outside = await mkdtemp(join(tmpdir(), "omx-hermes-artifact-outside-"));
    try {
      await mkdir(join(cwd, ".omx", "plans"), { recursive: true });
      const outsideFile = join(outside, "host.md");
      await writeFile(outsideFile, "outside artifact");
      await symlink(outsideFile, join(cwd, ".omx", "plans", "host.md"));

      const result = await hermesReadArtifact({ workingDirectory: cwd, path: ".omx/plans/host.md" });
      assert.equal(result.ok, false);
      assert.equal(result.code, "artifact_outside_safe_roots");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });


  it("rejects workdir-root candidate symlinks that would expose outside artifacts", async () => {
    const allowed = await tempWorkspace("omx-hermes-allowed-root-");
    const outside = await tempWorkspace("omx-hermes-outside-root-");
    try {
      await mkdir(join(outside, ".omx", "plans"), { recursive: true });
      await writeFile(join(outside, ".omx", "plans", "secret.md"), "outside via workdir symlink");
      await symlink(outside, join(allowed, "link"));
      process.env.OMX_MCP_WORKDIR_ROOTS = allowed;

      const result = await hermesReadArtifact({
        workingDirectory: join(allowed, "link"),
        path: ".omx/plans/secret.md",
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid_input");
      assert.match(result.error ?? "", /outside allowed roots/);
    } finally {
      await rm(allowed, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlinked OMX_MCP_WORKDIR_ROOTS entries before reading artifacts", async () => {
    const intended = await tempWorkspace("omx-hermes-intended-root-");
    const outside = await tempWorkspace("omx-hermes-outside-root-");
    try {
      await mkdir(join(outside, ".omx", "plans"), { recursive: true });
      await writeFile(join(outside, ".omx", "plans", "secret.md"), "outside via symlinked root");
      const symlinkedRoot = join(intended, "allowed-link");
      await symlink(outside, symlinkedRoot);
      process.env.OMX_MCP_WORKDIR_ROOTS = symlinkedRoot;

      const result = await hermesReadArtifact({
        workingDirectory: symlinkedRoot,
        path: ".omx/plans/secret.md",
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "invalid_input");
      assert.match(result.error ?? "", /resolves through a symlink/);
    } finally {
      await rm(intended, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes a bounded Hermes coordination report", async () => {
    const cwd = await tempWorkspace("omx-hermes-report-");
    try {
      const result = await hermesReportStatus(
        {
          workingDirectory: cwd,
          session_id: "sess-a",
          status: "complete",
          summary: "PR opened",
          pr_url: "https://github.com/Yeachan-Heo/oh-my-codex/pull/1",
          allow_mutation: true,
        },
        { now: () => new Date("2026-05-11T00:00:00.000Z") },
      );

      assert.equal(result.ok, true);
      assert.match(result.data?.path ?? "", /sessions[/\\]sess-a[/\\]hermes-coordination\.json$/);
      assert.deepEqual(result.data?.report, {
        status: "complete",
        updated_at: "2026-05-11T00:00:00.000Z",
        summary: "PR opened",
        pr_url: "https://github.com/Yeachan-Heo/oh-my-codex/pull/1",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
