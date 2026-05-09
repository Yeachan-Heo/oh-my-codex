import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  generateWorkerOverlay,
  applyWorkerOverlay,
  stripWorkerOverlay,
  generateWorkerRootAgentsContent,
  writeTeamWorkerInstructionsFile,
  writeWorkerRoleInstructionsFile,
  writeWorkerWorktreeRootAgentsFile,
  removeWorkerWorktreeRootAgentsFile,
  removeTeamWorkerInstructionsFile,
  generateInitialInbox,
  generateTaskAssignmentInbox,
  generateShutdownInbox,
  generateTriggerMessage,
  buildTriggerDirective,
  generateMailboxTriggerMessage,
  buildMailboxTriggerDirective,
  generateLeaderMailboxTriggerMessage,
  buildLeaderMailboxTriggerDirective,
} from "../worker-bootstrap.js";
import { composeRoleInstructionsForRole } from "../../agents/native-config.js";
import { buildTeamWorkerGoalInstruction } from "../goal-workflow.js";
import type { TeamTask } from "../state.js";

function setMockCodexHome(codexHomePath: string): () => void {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHomePath;
  return () => {
    if (typeof previous === "string") process.env.CODEX_HOME = previous;
    else delete process.env.CODEX_HOME;
  };
}

describe("worker bootstrap", () => {
  it("worker skill lifecycle instructions are claim-safe (issue #448)", async () => {
    const workerSkill = await readFile(
      join(process.cwd(), "skills", "worker", "SKILL.md"),
      "utf8",
    );

    assert.match(workerSkill, /omx team api claim-task/);
    assert.match(workerSkill, /omx team api transition-task-status/);
    assert.match(workerSkill, /omx team api release-task-claim/);
    assert.match(
      workerSkill,
      /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/,
    );
    assert.doesNotMatch(workerSkill, /Write completion to the task file/i);
    assert.doesNotMatch(
      workerSkill,
      /`?\{"status":"completed","result":"\.\.\."\}`?/,
    );
    assert.doesNotMatch(
      workerSkill,
      /`?\{"status":"failed","error":"\.\.\."\}`?/,
    );
  });

  it("generateWorkerOverlay produces markdown with correct start/end markers", () => {
    const overlay = generateWorkerOverlay("alpha-team");

    assert.match(overlay, /<!-- OMX:TEAM:WORKER:START -->/);
    assert.match(overlay, /<!-- OMX:TEAM:WORKER:END -->/);
  });

  it("generateWorkerOverlay includes the team name", () => {
    const overlay = generateWorkerOverlay("my-team");
    assert.match(overlay, /team "my-team"/);
    assert.match(
      overlay,
      /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/,
    );
    assert.match(overlay, /<leader_cwd>\/\.codex\/skills\/worker\/SKILL\.md/);
    assert.match(overlay, /Resolve canonical team state root/i);
    assert.match(overlay, /<team_state_root>\/team\/my-team\/tasks/);
    assert.match(overlay, /tasks\/task-<id>\.json/);
    assert.match(overlay, /task_id: "<id>"/);
    assert.match(overlay, /omx team api claim-task/);
    assert.match(overlay, /omx team api transition-task-status/);
    assert.match(overlay, /omx team api release-task-claim/);
    assert.doesNotMatch(
      overlay,
      /On completion: write \{"status": "completed"/,
    );
    assert.match(
      overlay,
      /You may spawn Codex native subagents when parallel execution improves throughput/,
    );
    assert.match(
      overlay,
      /Use subagents only for independent, bounded subtasks/,
    );
    assert.match(
      overlay,
      /do not pass workingDirectory unless the lead explicitly tells you to/,
    );
    assert.doesNotMatch(overlay, /tasks\/\{id\}\.json/);
  });

  it("applyWorkerOverlay appends to existing AGENTS.md content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      await writeFile(agentsMdPath, "# Base AGENTS\n\nBase content.\n", "utf8");

      const overlay = generateWorkerOverlay("team-a");
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, "utf8");
      assert.match(content, /# Base AGENTS/);
      assert.match(content, /Base content\./);
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:END -->/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("applyWorkerOverlay is idempotent (calling twice doesn't duplicate)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      await writeFile(agentsMdPath, "# Base\n", "utf8");

      const overlay = generateWorkerOverlay("team-idempotent");
      await applyWorkerOverlay(agentsMdPath, overlay);
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, "utf8");
      const starts = content.match(/<!-- OMX:TEAM:WORKER:START -->/g) ?? [];
      const ends = content.match(/<!-- OMX:TEAM:WORKER:END -->/g) ?? [];

      assert.equal(starts.length, 1);
      assert.equal(ends.length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stripWorkerOverlay removes the overlay section", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      const base = "# Base\n\nKeep me.\n";
      const overlay = generateWorkerOverlay("team-strip");

      await writeFile(agentsMdPath, `${base}\n${overlay}\n`, "utf8");
      await stripWorkerOverlay(agentsMdPath);

      const content = await readFile(agentsMdPath, "utf8");
      assert.match(content, /# Base/);
      assert.match(content, /Keep me\./);
      assert.doesNotMatch(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.doesNotMatch(content, /<!-- OMX:TEAM:WORKER:END -->/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stripWorkerOverlay is idempotent (calling on already-stripped is no-op)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      await writeFile(agentsMdPath, "# Base only\n", "utf8");

      const before = await readFile(agentsMdPath, "utf8");
      await stripWorkerOverlay(agentsMdPath);
      const afterFirst = await readFile(agentsMdPath, "utf8");
      await stripWorkerOverlay(agentsMdPath);
      const afterSecond = await readFile(agentsMdPath, "utf8");

      assert.equal(afterFirst, before);
      assert.equal(afterSecond, before);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("applyWorkerOverlay works on non-existent file (creates it)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      const overlay = generateWorkerOverlay("new-team");

      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, "utf8");
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /team "new-team"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("applyWorkerOverlay reaps stale AGENTS lock directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const agentsMdPath = join(cwd, "AGENTS.md");
      const lockPath = join(cwd, ".omx", "state", "agents-md.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: 999_999_999, ts: Date.now() - 60_000 }),
        "utf8",
      );

      await writeFile(agentsMdPath, "# Base\n", "utf8");
      const overlay = generateWorkerOverlay("team-stale-lock");
      await applyWorkerOverlay(agentsMdPath, overlay);

      const content = await readFile(agentsMdPath, "utf8");
      assert.match(content, /team "team-stale-lock"/);
      await assert.rejects(readFile(join(lockPath, "owner.json"), "utf8"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("generateInitialInbox includes worker name, team name, and all tasks", () => {
    const tasks: TeamTask[] = [
      {
        id: "1",
        subject: "First task",
        description: "Do first thing",
        status: "pending",
        created_at: new Date().toISOString(),
      },
      {
        id: "2",
        subject: "Second task",
        description: "Do second thing",
        status: "in_progress",
        created_at: new Date().toISOString(),
      },
    ];

    const inbox = generateInitialInbox(
      "worker-1",
      "team-inbox",
      "executor",
      tasks,
    );

    assert.match(inbox, /# Worker Assignment: worker-1/);
    assert.match(inbox, /\*\*Team:\*\* team-inbox/);
    assert.match(inbox, /\*\*Role:\*\* executor/);
    assert.match(inbox, /\*\*Task 1\*\*: First task/);
    assert.match(inbox, /\*\*Task 2\*\*: Second task/);
    assert.match(inbox, /Resolve canonical team state root/);
    assert.match(
      inbox,
      /<team_state_root>\/team\/team-inbox\/tasks\/task-<id>\.json/,
    );
    assert.match(inbox, /omx team api claim-task/);
    assert.match(inbox, /omx team api transition-task-status/);
    assert.match(inbox, /omx team api release-task-claim/);
    assert.match(
      inbox,
      /\$\{CODEX_HOME:-~\/\.codex\}\/skills\/worker\/SKILL\.md/,
    );
    assert.match(inbox, /\/\.codex\/skills\/worker\/SKILL\.md/);
    assert.match(inbox, /ACK: worker-1 initialized/);
    assert.match(inbox, /Mailbox Delivery Protocol \(Required\)/);
    assert.match(inbox, /mailbox-mark-delivered/);
    assert.match(
      inbox,
      /continue executing your assigned work or the next feasible task/i,
    );
    assert.doesNotMatch(
      inbox,
      /Write `\{"status": "completed", "result": "brief summary"\}` to the task file/,
    );
    assert.match(inbox, /Verification Requirements/);
    assert.match(inbox, /Fix-Verify Loop/);
  });




  it("generateInitialInbox includes scrum/team worker goal handoff tied to task IDs and claims", () => {
    const tasks: TeamTask[] = [{
      id: "4",
      subject: "Implement team goal workflow",
      description: "Wire per-worker goals into bootstrap",
      status: "in_progress",
      owner: "worker-4",
      created_at: new Date(0).toISOString(),
      claim: {
        owner: "worker-4",
        token: "claim-token",
        leased_until: "2026-05-04T12:32:13.456Z",
      },
    }];

    const workerGoalInstruction = buildTeamWorkerGoalInstruction(
      "team-goal",
      "worker-4",
      tasks,
      { teamStateRoot: "/tmp/.omx/state" },
    );
    const inbox = generateInitialInbox("worker-4", "team-goal", "executor", tasks, {
      teamStateRoot: "/tmp/.omx/state",
      workerGoalInstruction,
    });

    assert.match(inbox, /## Scrum \/ Team Goal Workflow/);
    assert.match(inbox, /task IDs 4 instead of creating a duplicate task list/);
    assert.match(inbox, /Task 4: Implement team goal workflow/);
    assert.match(inbox, /active claim owner: worker-4 until 2026-05-04T12:32:13\.456Z/);
    assert.match(inbox, /Durable OMX source of truth/);
    assert.match(inbox, /logical Codex goal handoff only/);
    assert.doesNotMatch(inbox, /\/tmp\/\.omx\/state\/goals\/team/);
    assert.doesNotMatch(inbox, /leader-audit\.json/);
    assert.match(inbox, /get_goal/);
    assert.match(inbox, /create_goal.*only when no active goal exists/i);
    assert.match(inbox, /update_goal\(\{status: "complete"\}\).*verification evidence/i);
    assert.match(inbox, /shell\/team APIs persist only OMX artifacts and task state/);
  });


  it("generateInitialInbox includes repo-aware decomposition ownership hints", () => {
    const inbox = generateInitialInbox(
      "worker-1",
      "team-dag",
      "executor",
      [
        {
          id: "1",
          subject: "Implement DAG importer",
          description: "Implement repo-aware decomposition",
          status: "pending",
          owner: "worker-1",
          role: "executor",
          created_at: "2026-04-27T00:00:00.000Z",
          depends_on: ["0"],
          filePaths: ["src/team/repo-aware-decomposition.ts"],
          domains: ["team decomposition"],
          lane: "implementation",
          allocation_reason: "preserves low-overlap file/domain ownership",
        } as TeamTask,
      ],
    );

    assert.match(inbox, /Depends on: 0/);
    assert.match(inbox, /File paths: src\/team\/repo-aware-decomposition\.ts/);
    assert.match(inbox, /Domains: team decomposition/);
    assert.match(inbox, /Lane: implementation/);
    assert.match(inbox, /Allocation reason: preserves low-overlap file\/domain ownership/);
  });

  it("generateInitialInbox shows blocked_by info for blocked tasks", () => {
    const tasks: TeamTask[] = [
      {
        id: "3",
        subject: "Blocked task",
        description: "Wait on dependencies",
        status: "pending",
        blocked_by: ["1", "2"],
        created_at: new Date().toISOString(),
      },
    ];

    const inbox = generateInitialInbox(
      "worker-2",
      "team-blocked",
      "executor",
      tasks,
    );
    assert.match(inbox, /Blocked by: 1, 2/);
  });

  it("generateInitialInbox uses workerRole when provided", () => {
    const tasks: TeamTask[] = [
      {
        id: "1",
        subject: "Test task",
        description: "Write tests",
        status: "pending",
        created_at: new Date().toISOString(),
      },
    ];
    const inbox = generateInitialInbox(
      "worker-1",
      "team-role",
      "executor",
      tasks,
      {
        workerRole: "test-engineer",
      },
    );
    assert.match(inbox, /\*\*Role:\*\* test-engineer/);
    assert.doesNotMatch(inbox, /\*\*Role:\*\* executor/);
  });

  it("generateInitialInbox includes specialization section when rolePromptContent provided", () => {
    const tasks: TeamTask[] = [
      {
        id: "1",
        subject: "Design UI",
        description: "Build component",
        status: "pending",
        created_at: new Date().toISOString(),
      },
    ];
    const inbox = generateInitialInbox(
      "worker-2",
      "team-spec",
      "executor",
      tasks,
      {
        workerRole: "designer",
        rolePromptContent:
          "You focus on UI/UX design and component architecture.",
      },
    );
    assert.match(inbox, /## Your Specialization/);
    assert.match(inbox, /\*\*designer\*\* agent/);
    assert.match(inbox, /UI\/UX design and component architecture/);
  });

  it("generateInitialInbox omits specialization section when no rolePromptContent", () => {
    const tasks: TeamTask[] = [
      {
        id: "1",
        subject: "Task",
        description: "Do work",
        status: "pending",
        created_at: new Date().toISOString(),
      },
    ];
    const inbox = generateInitialInbox(
      "worker-1",
      "team-no-spec",
      "executor",
      tasks,
      {
        workerRole: "executor",
      },
    );
    assert.doesNotMatch(inbox, /## Your Specialization/);
  });

  it("generateInitialInbox shows task role in task list", () => {
    const tasks: TeamTask[] = [
      {
        id: "1",
        subject: "Test task",
        description: "Write tests",
        status: "pending",
        role: "test-engineer",
        created_at: new Date().toISOString(),
      },
    ];
    const inbox = generateInitialInbox(
      "worker-1",
      "team-task-role",
      "executor",
      tasks,
    );
    assert.match(inbox, /Role: test-engineer/);
  });



  it("generateInitialInbox includes Native Subagent Delegation Contract for broad delegated tasks", () => {
    const tasks: TeamTask[] = [{
      id: "7",
      subject: "Investigate runtime failure",
      description: "Search runtime and debug flaky assignment behavior",
      status: "pending",
      created_at: new Date(0).toISOString(),
      delegation: {
        mode: "auto",
        max_parallel_subtasks: 3,
        required_parallel_probe: true,
        spawn_before_serial_search_threshold: 3,
        child_model_policy: "standard",
        child_model: "gpt-5.4-mini",
        subtask_candidates: ["Map runtime assignment flow", "Inspect bootstrap tests"],
        child_report_format: "bullets",
        skip_allowed_reason_required: true,
      },
    }];

    const inbox = generateInitialInbox("worker-1", "team-delegation", "executor", tasks);

    assert.match(inbox, /Native Subagent Delegation Contract/);
    assert.match(inbox, /Task 7/);
    assert.match(inbox, /before doing more than 3 serial repo-search\/read commands/i);
    assert.match(inbox, /spawn up to 3 Codex native subagents/i);
    assert.match(inbox, /gpt-5\.4-mini/);
    assert.match(inbox, /Map runtime assignment flow/);
    assert.match(inbox, /Subagent evidence reporting fields/);
    assert.match(inbox, /Delegation compliance evidence \(required for completion\)/);
    assert.match(inbox, /Subagent spawn evidence:/);
    assert.match(inbox, /Subagent skip reason:/);
    assert.match(inbox, /missing_delegation_compliance_evidence/);
  });

  it("generateInitialInbox keeps mode none tasks quiet about delegation contract", () => {
    const tasks: TeamTask[] = [{
      id: "8",
      subject: "Fix typo",
      description: "Fix one typo in README.md",
      status: "pending",
      created_at: new Date(0).toISOString(),
      delegation: { mode: "none" },
    }];

    const inbox = generateInitialInbox("worker-1", "team-narrow", "executor", tasks);

    assert.doesNotMatch(inbox, /Native Subagent Delegation Contract/);
    assert.doesNotMatch(inbox, /gpt-5\.4-mini/);
  });

  it("generateTaskAssignmentInbox includes task ID and description", () => {
    const inbox = generateTaskAssignmentInbox(
      "worker-3",
      "team-followup",
      "42",
      "Implement parser update",
    );

    assert.match(inbox, /\*\*Task ID:\*\* 42/);
    assert.match(inbox, /Implement parser update/);
    assert.match(inbox, /team_state_root/);
    assert.match(inbox, /team\/team-followup\/tasks\/task-42\.json/);
    assert.match(inbox, /omx team api claim-task/);
    assert.match(inbox, /omx team api transition-task-status/);
    assert.match(inbox, /omx team api release-task-claim/);
    assert.doesNotMatch(
      inbox,
      /Write `\{"status": "completed", "result": "brief summary"\}` when done/,
    );
    assert.match(inbox, /Verification Requirements/);
    assert.match(inbox, /PASS\/FAIL/);
  });





  it("generateTaskAssignmentInbox includes worker goal handoff for task-object follow-ups", () => {
    const inbox = generateTaskAssignmentInbox(
      "worker-2",
      "team-followup-goal",
      {
        id: "9",
        subject: "Finish worker audit",
        description: "Complete the worker audit slice",
        status: "pending",
        created_at: new Date(0).toISOString(),
      },
    );

    assert.match(inbox, /## Scrum \/ Team Goal Workflow/);
    assert.match(inbox, /Task 9: Finish worker audit/);
    assert.match(inbox, /claim required before work/);
    assert.match(inbox, /Durable OMX source of truth/);
    assert.match(inbox, /logical Codex goal handoff only/);
    assert.match(inbox, /omx team api transition-task-status/);
    assert.doesNotMatch(inbox, /<team_state_root>\/goals\/team/);
    assert.doesNotMatch(inbox, /leader-audit\.json/);
  });


  it("generateTaskAssignmentInbox includes delegation contract for follow-up task object", () => {
    const inbox = generateTaskAssignmentInbox(
      "worker-3",
      "team-followup",
      {
        id: "42",
        subject: "Investigate parser regression",
        description: "Investigate parser regression across tests",
        status: "pending",
        created_at: new Date(0).toISOString(),
        delegation: {
          mode: "auto",
          max_parallel_subtasks: 3,
          required_parallel_probe: true,
          spawn_before_serial_search_threshold: 3,
          child_model_policy: "standard",
          child_model: "gpt-5.4-mini",
          subtask_candidates: ["Search parser references", "Review parser tests"],
          child_report_format: "bullets",
          skip_allowed_reason_required: true,
        },
      },
    );

    assert.match(inbox, /Native Subagent Delegation Contract/);
    assert.match(inbox, /spawn up to 3 Codex native subagents/i);
    assert.match(inbox, /gpt-5\.4-mini/);
    assert.match(inbox, /Search parser references/);
    assert.match(inbox, /Subagent spawn evidence:/);
    assert.match(inbox, /Subagent skip reason:/);
  });

  it("generateShutdownInbox contains exit instruction and concrete ack path", () => {
    const inbox = generateShutdownInbox("team-x", "worker-1");

    assert.match(inbox, /Shutdown Request/);
    assert.match(inbox, /team_state_root/);
    assert.match(inbox, /team\/team-x\/workers\/worker-1\/shutdown-ack\.json/);
    assert.match(inbox, /Type `exit` or press Ctrl\+C/);
  });

  it("generateTriggerMessage is always < 200 characters", () => {
    const message = generateTriggerMessage(
      "worker-very-long-name",
      "team-with-a-reasonably-long-name",
    );
    assert.ok(message.length < 200);
  });

  it("generateTriggerMessage does not contain [OMX_TMUX_INJECT]", () => {
    const message = generateTriggerMessage("worker-1", "team-safe");
    assert.equal(message.includes("[OMX_TMUX_INJECT]"), false);
  });

  it("generateTriggerMessage contains the inbox path", () => {
    const message = generateTriggerMessage("worker-9", "team-path");
    assert.match(
      message,
      /\.omx\/state\/team\/team-path\/workers\/worker-9\/inbox\.md/,
    );
    assert.match(message, /start work now/i);
    assert.match(message, /concrete progress/i);
    assert.match(message, /continue assigned work/i);
    assert.match(message, /next feasible task/i);
  });

  it("buildTriggerDirective keeps human text separate from orchestration intent", () => {
    const directive = buildTriggerDirective("worker-9", "team-path");
    assert.equal(directive.intent, "followup-relaunch");
    assert.match(directive.text, /\.omx\/state\/team\/team-path\/workers\/worker-9\/inbox\.md/);
    assert.doesNotMatch(directive.text, /OMX_INTENT/);
  });

  it("generateTriggerMessage uses provided state-root reference for worktree workers", () => {
    const message = generateTriggerMessage(
      "worker-9",
      "team-path",
      "$OMX_TEAM_STATE_ROOT",
    );
    assert.match(
      message,
      /\$OMX_TEAM_STATE_ROOT\/team\/team-path\/workers\/worker-9\/inbox\.md/,
    );
    assert.match(message, /work now/i);
    assert.match(message, /report progress/i);
    assert.match(message, /continue assigned work/i);
    assert.match(message, /next feasible task/i);
    assert.ok(message.length < 200);
  });

  it("generateMailboxTriggerMessage is always < 200 characters", () => {
    const message = generateMailboxTriggerMessage(
      "worker-long-name",
      "team-with-long-name",
      42,
    );
    assert.ok(message.length < 200);
  });

  it("generateMailboxTriggerMessage contains mailbox path and count", () => {
    const message = generateMailboxTriggerMessage("worker-2", "team-mail", 3);
    assert.match(message, /3 new message/);
    assert.match(
      message,
      /Read .*\.omx\/state\/team\/team-mail\/mailbox\/worker-2\.json/,
    );
    assert.match(message, /act now/i);
    assert.match(message, /concrete progress/i);
    assert.match(message, /continue assigned work/i);
    assert.match(message, /next feasible task/i);
  });

  it("buildMailboxTriggerDirective keeps mailbox review intent out of display text", () => {
    const directive = buildMailboxTriggerDirective("worker-2", "team-mail", 3);
    assert.equal(directive.intent, "pending-mailbox-review");
    assert.match(directive.text, /3 new message/);
    assert.doesNotMatch(directive.text, /OMX_INTENT/);
  });

  it("generateMailboxTriggerMessage uses provided state-root reference for worktree workers", () => {
    const message = generateMailboxTriggerMessage(
      "worker-2",
      "team-mail",
      3,
      "$OMX_TEAM_STATE_ROOT",
    );
    assert.match(message, /3 new msg/);
    assert.match(
      message,
      /read .*\$OMX_TEAM_STATE_ROOT\/team\/team-mail\/mailbox\/worker-2\.json/i,
    );
    assert.match(message, /act/i);
    assert.match(message, /report progress/i);
    assert.match(message, /continue assigned work/i);
    assert.match(message, /next feasible task/i);
    assert.ok(message.length < 200);
  });

  it("generateLeaderMailboxTriggerMessage is always < 200 characters", () => {
    const message = generateLeaderMailboxTriggerMessage(
      "team-with-long-name",
      "worker-long-name",
    );
    assert.ok(message.length < 200);
  });

  it("generateLeaderMailboxTriggerMessage tells the leader to read the mailbox and decide the next step", () => {
    const message = generateLeaderMailboxTriggerMessage(
      "team-mail",
      "worker-2",
    );
    assert.match(
      message,
      /Read .*\.omx\/state\/team\/team-mail\/mailbox\/leader-fixed\.json/,
    );
    assert.match(message, /worker-2 sent a new message/);
    assert.match(message, /Review it and decide the next concrete step/);
    assert.doesNotMatch(message, /\bReply\b/i);
  });

  it("buildLeaderMailboxTriggerDirective records leader mailbox-review intent separately", () => {
    const directive = buildLeaderMailboxTriggerDirective("team-mail", "worker-2");
    assert.equal(directive.intent, "pending-mailbox-review");
    assert.match(directive.text, /worker-2 sent a new message/);
    assert.doesNotMatch(directive.text, /OMX_INTENT/);
  });

  it("generateLeaderMailboxTriggerMessage uses provided state-root reference for worktree leaders", () => {
    const message = generateLeaderMailboxTriggerMessage(
      "team-mail",
      "worker-2",
      "$OMX_TEAM_STATE_ROOT",
    );
    assert.match(
      message,
      /read .*\$OMX_TEAM_STATE_ROOT\/team\/team-mail\/mailbox\/leader-fixed\.json/i,
    );
    assert.match(message, /new msg from worker-2/i);
    assert.match(message, /review it; decide next step/i);
    assert.doesNotMatch(message, /\breply\b/i);
    assert.ok(message.length < 200);
  });

  it("writeTeamWorkerInstructionsFile composes user + project AGENTS.md with overlay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    const restoreCodexHome = setMockCodexHome(join(cwd, "home", ".codex"));
    try {
      await mkdir(join(cwd, "home", ".codex"), { recursive: true });
      await writeFile(
        join(cwd, "home", ".codex", "AGENTS.md"),
        "# User Instructions\n\nStart globally.\n",
        "utf8",
      );
      await writeFile(
        join(cwd, "AGENTS.md"),
        "# Project Instructions\n\nDo good work.\n",
        "utf8",
      );

      const overlay = generateWorkerOverlay("compose-team");
      const outPath = await writeTeamWorkerInstructionsFile(
        "compose-team",
        cwd,
        overlay,
      );

      const content = await readFile(outPath, "utf8");
      assert.match(content, /# User Instructions/);
      assert.match(content, /# Project Instructions/);
      assert.ok(
        content.indexOf("# User Instructions") <
          content.indexOf("# Project Instructions"),
      );
      assert.match(content, /Do good work/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /<!-- OMX:TEAM:WORKER:END -->/);

      // Verify project AGENTS.md was NOT modified
      const projectContent = await readFile(join(cwd, "AGENTS.md"), "utf8");
      assert.doesNotMatch(projectContent, /<!-- OMX:TEAM:WORKER:START -->/);
    } finally {
      restoreCodexHome();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writeTeamWorkerInstructionsFile deduplicates duplicate skill references in favor of project scope", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    const restoreCodexHome = setMockCodexHome(join(cwd, "home", ".codex"));
    try {
      const userAgentsPath = join(cwd, "home", ".codex", "AGENTS.md");
      const projectAgentsPath = join(cwd, "AGENTS.md");
      const userSkillDir = join(cwd, "home", ".codex", "skills", "help");
      const projectSkillDir = join(cwd, ".codex", "skills", "help");

      await mkdir(join(cwd, "home", ".codex"), { recursive: true });
      await mkdir(userSkillDir, { recursive: true });
      await mkdir(projectSkillDir, { recursive: true });
      await writeFile(join(userSkillDir, "SKILL.md"), "# user help\n", "utf8");
      await writeFile(
        join(projectSkillDir, "SKILL.md"),
        "# project help\n",
        "utf8",
      );
      await writeFile(
        userAgentsPath,
        "- help user (file: /tmp/home/.codex/skills/help/SKILL.md)\n",
        "utf8",
      );
      await writeFile(
        projectAgentsPath,
        "- help project (file: /tmp/project/.codex/skills/help/SKILL.md)\n",
        "utf8",
      );

      const overlay = generateWorkerOverlay("dedupe-team");
      const outPath = await writeTeamWorkerInstructionsFile(
        "dedupe-team",
        cwd,
        overlay,
      );
      const content = await readFile(outPath, "utf8");

      assert.equal((content.match(/skills\/help\/SKILL\.md/g) || []).length, 1);
      assert.doesNotMatch(content, /help user/);
      assert.match(content, /help project/);
    } finally {
      restoreCodexHome();
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("generateWorkerRootAgentsContent includes hardcoded paths and role prompt without base AGENTS", () => {
    const content = generateWorkerRootAgentsContent({
      teamName: "root-team",
      workerName: "worker-3",
      workerRole: "writer",
      rolePromptContent: "<identity>You are Writer.</identity>",
      teamStateRoot: "/tmp/state",
      leaderCwd: "/repo",
      worktreePath: "/repo/.omx/team/root-team/worktrees/worker-3",
    });

    assert.match(content, /Worker: worker-3/);
    assert.match(content, /Inbox path: \/tmp\/state\/team\/root-team\/workers\/worker-3\/inbox\.md/);
    assert.match(content, /mailbox\/worker-3\.json/);
    assert.match(content, /<identity>You are Writer\.<\/identity>/);
    assert.doesNotMatch(content, /# Project Instructions/);
    assert.doesNotMatch(content, /# User Instructions/);
  });

  it("writeWorkerRoleInstructionsFile layers role prompt on top of team worker instructions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const overlay = generateWorkerOverlay("role-team");
      const basePath = await writeTeamWorkerInstructionsFile(
        "role-team",
        cwd,
        overlay,
      );
      const outPath = await writeWorkerRoleInstructionsFile(
        "role-team",
        "worker-2",
        cwd,
        basePath,
        "writer",
        "<identity>Writer role prompt</identity>",
      );

      const content = await readFile(outPath, "utf8");
      assert.match(content, /team "role-team"/);
      assert.match(content, /<!-- OMX:TEAM:ROLE:START -->/);
      assert.match(content, /\*\*writer\*\* role/);
      assert.match(content, /<identity>Writer role prompt<\/identity>/);
      assert.doesNotMatch(content, /exact gpt-5\.4-mini model/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writeWorkerRoleInstructionsFile preserves precomposed mini guidance as wrapper-only content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const overlay = generateWorkerOverlay("mini-role-team");
      const basePath = await writeTeamWorkerInstructionsFile(
        "mini-role-team",
        cwd,
        overlay,
      );
      const composedRoleInstructions = composeRoleInstructionsForRole(
        "writer",
        "---\ndescription: demo\n---\n\n<identity>You are Writer.</identity>",
        "gpt-5.4-mini",
      );
      const outPath = await writeWorkerRoleInstructionsFile(
        "mini-role-team",
        "worker-2",
        cwd,
        basePath,
        "writer",
        composedRoleInstructions,
      );

      const content = await readFile(outPath, "utf8");
      assert.match(content, /<identity>You are Writer\.<\/identity>/);
      assert.match(content, /exact gpt-5\.4-mini model/);
      assert.match(content, /strict execution order: inspect -> plan -> act -> verify/);
      assert.equal((content.match(/<exact_model_guidance>/g) || []).length, 1);
      assert.equal((content.match(/resolved_model: gpt-5\.4-mini/g) || []).length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("generateWorkerRootAgentsContent hardcodes runtime paths and role prompt without inherited AGENTS", () => {
    const content = generateWorkerRootAgentsContent({
      teamName: "root-team",
      workerName: "worker-2",
      workerRole: "writer",
      rolePromptContent: "<identity>You are Writer.</identity>",
      teamStateRoot: "/tmp/project/.omx/state",
      leaderCwd: "/tmp/project",
      worktreePath: "/tmp/project/.omx/team/root-team/worktrees/worker-2",
    });

    assert.match(content, /# Team Worker Runtime Instructions/);
    assert.match(content, /Inbox path: \/tmp\/project\/.omx\/state\/team\/root-team\/workers\/worker-2\/inbox\.md/);
    assert.match(content, /Mailbox path: \/tmp\/project\/.omx\/state\/team\/root-team\/mailbox\/worker-2\.json/);
    assert.match(content, /Leader mailbox path: \/tmp\/project\/.omx\/state\/team\/root-team\/mailbox\/leader-fixed\.json/);
    assert.match(content, /You are operating as the \*\*writer\*\* role/);
    assert.match(content, /<identity>You are Writer\.<\/identity>/);
    assert.doesNotMatch(content, /# Project Instructions/);
    assert.doesNotMatch(content, /# User Instructions/);
  });

  it("writeWorkerWorktreeRootAgentsFile writes disposable root AGENTS and remove restores tracked content", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-root-agents-"));
    const worktree = join(cwd, "worktree");
    try {
      await mkdir(join(cwd, ".omx", "state", "team", "restore-team", "workers", "worker-1"), { recursive: true });
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, "AGENTS.md"), "# Base tracked AGENTS\n", "utf8");

      const outPath = await writeWorkerWorktreeRootAgentsFile({
        teamName: "restore-team",
        workerName: "worker-1",
        workerRole: "writer",
        rolePromptContent: "<identity>Writer role prompt</identity>",
        teamStateRoot: join(cwd, ".omx", "state"),
        leaderCwd: cwd,
        worktreePath: worktree,
      });

      const generated = await readFile(outPath, "utf8");
      assert.match(generated, /Team Worker Runtime Instructions/);
      assert.match(generated, /Writer role prompt/);

      await removeWorkerWorktreeRootAgentsFile("restore-team", "worker-1", join(cwd, ".omx", "state"), worktree);
      const restored = await readFile(join(worktree, "AGENTS.md"), "utf8");
      assert.equal(restored, "# Base tracked AGENTS\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("generateInitialInbox omits duplicated specialization when root AGENTS is canonical", () => {
    const tasks: TeamTask[] = [{
      id: "1",
      subject: "Task",
      description: "Do task",
      status: "pending",
      created_at: new Date().toISOString(),
    }];

    const inbox = generateInitialInbox(
      "worker-1",
      "team-root-canonical",
      "writer",
      tasks,
      {
        workerRole: "writer",
        rolePromptContent: "<identity>You are Writer.</identity>",
        worktreeRootAgentsCanonical: true,
      },
    );

    assert.doesNotMatch(inbox, /## Your Specialization/);
    assert.match(inbox, /\*\*Role:\*\* writer/);
  });

  it("writeTeamWorkerInstructionsFile works without project AGENTS.md", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const overlay = generateWorkerOverlay("no-agents-team");
      const outPath = await writeTeamWorkerInstructionsFile(
        "no-agents-team",
        cwd,
        overlay,
      );

      const content = await readFile(outPath, "utf8");
      assert.match(content, /<!-- OMX:TEAM:WORKER:START -->/);
      assert.match(content, /team "no-agents-team"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("removeTeamWorkerInstructionsFile cleans up the file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      const overlay = generateWorkerOverlay("cleanup-team");
      await writeTeamWorkerInstructionsFile("cleanup-team", cwd, overlay);
      await removeTeamWorkerInstructionsFile("cleanup-team", cwd);

      const { existsSync } = await import("fs");
      const outPath = join(
        cwd,
        ".omx",
        "state",
        "team",
        "cleanup-team",
        "worker-agents.md",
      );
      assert.equal(existsSync(outPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("removeTeamWorkerInstructionsFile is safe to call when file does not exist", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-worker-bootstrap-"));
    try {
      // Should not throw
      await removeTeamWorkerInstructionsFile("nonexistent-team", cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("generateInitialInbox includes approved repository context summary when provided", () => {
    const inbox = generateInitialInbox(
      "worker-1",
      "context-team",
      "executor",
      [{ id: "1", subject: "Implement", description: "Do task", status: "pending", owner: "worker-1", created_at: "2026-04-30T00:00:00.000Z" }],
      {
        approvedContextSummary: {
          sourcePath: ".omx/plans/repo-context-issue-2039.md",
          content: "Key boundary: preserve approved context only for matching launches.",
          truncated: false,
        },
      },
    );

    assert.match(inbox, /## Approved Repository Context Summary/);
    assert.match(inbox, /Source: \.omx\/plans\/repo-context-issue-2039\.md/);
    assert.match(inbox, /preserve approved context only for matching launches/);
  });

  it("generateInitialInbox prefers approved handoff context when provided", () => {
    const inbox = generateInitialInbox(
      "worker-1",
      "context-team",
      "executor",
      [{ id: "1", subject: "Implement", description: "Do task", status: "pending", owner: "worker-1", created_at: "2026-04-30T00:00:00.000Z" }],
      {
        approvedContextSection: [
          "- Approved plan: .omx/plans/prd-issue-2039.md",
          "- Test specs: .omx/plans/test-spec-issue-2039.md",
          "- Approved context pack: .omx/context/context-20260507T120000Z-issue-2039.json",
          "- Build refs (read first): src/build-1.ts",
          "- Read the build refs above before broader repo exploration.",
        ].join("\n"),
        approvedContextSummary: {
          sourcePath: ".omx/plans/repo-context-issue-2039.md",
          content: "This legacy summary should be suppressed when the handoff section is present.",
          truncated: false,
        },
      },
    );

    assert.match(inbox, /## Approved Handoff Context/);
    assert.match(inbox, /Approved plan: \.omx\/plans\/prd-issue-2039\.md/);
    assert.match(inbox, /Test specs: \.omx\/plans\/test-spec-issue-2039\.md/);
    assert.match(inbox, /Approved context pack: \.omx\/context\/context-20260507T120000Z-issue-2039\.json/);
    assert.match(inbox, /Build refs \(read first\): src\/build-1\.ts/);
    assert.doesNotMatch(inbox, /## Approved Repository Context Summary/);
  });

  it("generateTaskAssignmentInbox includes approved handoff context when provided", () => {
    const inbox = generateTaskAssignmentInbox(
      "worker-1",
      "team-followup",
      {
        id: "42",
        subject: "Implement parser update",
        description: "Implement parser update",
        status: "pending",
        created_at: "2026-04-30T00:00:00.000Z",
      },
      {
        approvedContextSection: [
          "- Approved plan: .omx/plans/prd-issue-2040.md",
          "- Test specs: .omx/plans/test-spec-issue-2040.md",
          "- Approved context pack: .omx/context/context-20260507T120000Z-issue-2040.json",
          "- Build refs (read first): src/build-1.ts",
          "- Verify refs: src/verify-2.ts",
        ].join("\n"),
      },
    );

    assert.match(inbox, /## Approved Handoff Context/);
    assert.match(inbox, /Approved plan: \.omx\/plans\/prd-issue-2040\.md/);
    assert.match(inbox, /Test specs: \.omx\/plans\/test-spec-issue-2040\.md/);
    assert.match(inbox, /Approved context pack: \.omx\/context\/context-20260507T120000Z-issue-2040\.json/);
    assert.match(inbox, /Build refs \(read first\): src\/build-1\.ts/);
    assert.match(inbox, /Verify refs: src\/verify-2\.ts/);
  });

});
