import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
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
import { createQuestionRecord } from "../../question/state.js";

const originalRoots = process.env.OMX_MCP_WORKDIR_ROOTS;
const originalOmxRoot = process.env.OMX_ROOT;
const originalOmxStateRoot = process.env.OMX_STATE_ROOT;
const originalTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;

afterEach(() => {
  if (typeof originalRoots === "string") process.env.OMX_MCP_WORKDIR_ROOTS = originalRoots;
  else delete process.env.OMX_MCP_WORKDIR_ROOTS;
  if (typeof originalOmxRoot === "string") process.env.OMX_ROOT = originalOmxRoot;
  else delete process.env.OMX_ROOT;
  if (typeof originalOmxStateRoot === "string") process.env.OMX_STATE_ROOT = originalOmxStateRoot;
  else delete process.env.OMX_STATE_ROOT;
  if (typeof originalTeamStateRoot === "string") process.env.OMX_TEAM_STATE_ROOT = originalTeamStateRoot;
  else delete process.env.OMX_TEAM_STATE_ROOT;
});

async function tempWorkspace(name: string): Promise<string> {
  delete process.env.OMX_ROOT;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  return await mkdtemp(join(tmpdir(), name));
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

  it("lists question events and submits bounded answers without terminal input proxying", async () => {
    const cwd = await tempWorkspace("omx-hermes-questions-");
    try {
      const { record } = await createQuestionRecord(cwd, {
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

      const submitted = await hermesSubmitQuestionAnswer({
        workingDirectory: cwd,
        session_id: "sess-q",
        question_id: record.question_id,
        answer: { kind: "option", value: "a", selected_labels: ["A"], selected_values: ["a"] },
        allow_mutation: true,
      });
      assert.equal(submitted.ok, true);
      assert.equal(submitted.data?.question.status, "answered");
      assert.equal(submitted.data?.answers[0]?.answer.value, "a");
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
      let observed: { command: string; args: string[]; cwd?: string } | null = null;
      const result = await hermesStartSession(
        { workingDirectory: cwd, prompt: "$ralph fix it", worktreeName: "pkg/demo", allow_mutation: true },
        {
          resolveOmxCliEntryPath: () => "/opt/omx/dist/cli/omx.js",
          spawnProcess: ((command: string, args: string[], options: { cwd?: string }) => {
            observed = { command, args, cwd: options.cwd };
            return { pid: 4242, unref() {} };
          }) as never,
        },
      );

      assert.equal(result.ok, true);
      assert.deepEqual(observed, {
        command: "/opt/omx/dist/cli/omx.js",
        args: ["--tmux", "--worktree=pkg/demo", "$ralph fix it"],
        cwd,
      });
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
