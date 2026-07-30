import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { dispatchCodexNativeHook, terminalizeExactUltragoalSessionForHookCancel } from "../codex-native-hook.js";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function fixture(suffix: string) {
  const cwd = await mkdtemp(join(tmpdir(), `omx-3358-ultragoal-cancel-${suffix}-`));
  const stateDir = join(cwd, ".omx", "state");
  const sessionId = `session-${suffix}`;
  const threadId = `thread-${suffix}`;
  const sessionDir = join(stateDir, "sessions", sessionId);
  await writeJson(join(stateDir, "session.json"), {
    session_id: sessionId,
    cwd,
    leader_thread_id: threadId,
  });
  await writeJson(join(stateDir, "subagent-tracking.json"), {
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId,
        leader_thread_id: threadId,
        threads: { [threadId]: { thread_id: threadId, kind: "leader" } },
      },
    },
  });
  await writeJson(join(sessionDir, "ultragoal-state.json"), {
    active: true,
    mode: "ultragoal",
    current_phase: "planning",
    session_id: sessionId,
    workingDirectory: cwd,
    durable_artifacts: { goals: "preserve", ledger: "preserve" },
  });
  await writeJson(join(sessionDir, "skill-active-state.json"), {
    active: true,
    skill: "ultragoal",
    phase: "planning",
    session_id: sessionId,
    cwd,
    active_skills: [
      { active: true, skill: "ultragoal", phase: "planning", session_id: sessionId, thread_id: threadId, cwd, marker: "cancel" },
      { active: true, skill: "ralph", phase: "execution", session_id: sessionId, thread_id: threadId, cwd, marker: "keep" },
      { active: true, skill: "ultragoal", phase: "planning", session_id: sessionId, thread_id: threadId, cwd: join(cwd, "foreign"), marker: "foreign-cwd" },
    ],
  });
  return { cwd, stateDir, sessionId, threadId, sessionDir };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function preTool(f: Fixture, command: string, overrides: Record<string, unknown> = {}) {
  return dispatchCodexNativeHook({
    hook_event_name: "PreToolUse",
    cwd: f.cwd,
    session_id: f.sessionId,
    thread_id: f.threadId,
    agent_id: f.threadId,
    tool_name: "Bash",
    tool_use_id: `tool-${Math.random()}`,
    tool_input: { command },
    ...overrides,
  }, { cwd: f.cwd });
}

function stop(f: Fixture) {
  return dispatchCodexNativeHook({
    hook_event_name: "Stop",
    cwd: f.cwd,
    session_id: f.sessionId,
    thread_id: f.threadId,
  }, { cwd: f.cwd });
}

async function withEnv<T>(values: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await run();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
async function writeSupervisedUltragoal(f: Fixture) {
  const autopilotPath = join(f.sessionDir, "autopilot-state.json");
  const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
  const skillPath = join(f.sessionDir, "skill-active-state.json");
  await writeJson(autopilotPath, {
    active: true,
    mode: "autopilot",
    current_phase: "ultragoal",
    session_id: f.sessionId,
    marker: "parent",
  });
  await writeJson(ultragoalPath, {
    active: true,
    mode: "ultragoal",
    current_phase: "executing",
    session_id: f.sessionId,
    marker: "child",
  });
  await writeJson(skillPath, {
    version: 1,
    active: true,
    skill: "autopilot",
    phase: "ultragoal",
    session_id: f.sessionId,
    active_skills: [{ skill: "autopilot", phase: "ultragoal", active: true, session_id: f.sessionId }],
  });
  return { autopilotPath, ultragoalPath, skillPath };
}

describe("issue #3358 Ultragoal cancellation lifecycle", () => {
  for (const command of ["omx cancel", "omx cancel --force"]) {
    it(`hook-owns exact same-session ${command} even when inherited shell startup is untrusted`, async () => {
      const f = await fixture(command.endsWith("--force") ? "force" : "plain");
      try {
        const otherSessionDir = join(f.stateDir, "sessions", "other-session");
        await writeJson(join(otherSessionDir, "ultragoal-state.json"), {
          active: true,
          mode: "ultragoal",
          current_phase: "planning",
          session_id: "other-session",
          workingDirectory: f.cwd,
          marker: "other",
        });
        await writeJson(join(otherSessionDir, "skill-active-state.json"), {
          active: true,
          skill: "ultragoal",
          phase: "planning",
          session_id: "other-session",
          cwd: f.cwd,
        });
        const otherBefore = await Promise.all([
          readFile(join(otherSessionDir, "ultragoal-state.json")),
          readFile(join(otherSessionDir, "skill-active-state.json")),
        ]);

        const result = await withEnv({ BASH_ENV: join(f.cwd, "hostile-bash-startup") }, () => preTool(f, command));
        assert.equal(result.outputJson?.decision, "block");
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);

        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        const ultragoal = JSON.parse(await readFile(ultragoalPath, "utf8"));
        const skill = JSON.parse(await readFile(skillPath, "utf8"));
        assert.equal(ultragoal.active, false);
        assert.equal(ultragoal.current_phase, "cancelled");
        assert.deepEqual(ultragoal.durable_artifacts, { goals: "preserve", ledger: "preserve" });
        assert.equal(skill.active, true);
        assert.equal(skill.skill, "ralph");
        assert.equal(skill.phase, "execution");
        assert.equal(skill.active_skills[0].active, false);
        assert.equal(skill.active_skills[0].phase, "cancelled");
        assert.equal(skill.active_skills[0].marker, "cancel");
        assert.deepEqual(skill.active_skills[1], {
          active: true,
          skill: "ralph",
          phase: "execution",
          session_id: f.sessionId,
          thread_id: f.threadId,
          cwd: f.cwd,
          marker: "keep",
        });
        assert.deepEqual(skill.active_skills[2], {
          active: true,
          skill: "ultragoal",
          phase: "planning",
          session_id: f.sessionId,
          thread_id: f.threadId,
          cwd: join(f.cwd, "foreign"),
          marker: "foreign-cwd",
        });
        assert.equal(existsSync(join(f.sessionDir, ".hook-cancel-transaction.json")), false);
        assert.equal(existsSync(join(f.sessionDir, ".hook-cancel.lock")), false);
        assert.deepEqual(await Promise.all([
          readFile(join(otherSessionDir, "ultragoal-state.json")),
          readFile(join(otherSessionDir, "skill-active-state.json")),
        ]), otherBefore);

        const terminalBytes = await Promise.all([readFile(ultragoalPath), readFile(skillPath)]);
        assert.equal((await stop(f)).outputJson, null);
        assert.equal((await stop(f)).outputJson, null);
        assert.deepEqual(await Promise.all([readFile(ultragoalPath), readFile(skillPath)]), terminalBytes);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const command of [
    " BASH_ENV=/tmp/prelude omx cancel --force",
    "omx cancel --force; true",
    " omx cancel --force ",
  ]) {
    it(`rejects non-exact cancellation grammar without terminalizing: ${JSON.stringify(command)}`, async () => {
      const f = await fixture(`grammar-${command.length}`);
      try {
        const before = await Promise.all([
          readFile(join(f.sessionDir, "ultragoal-state.json")),
          readFile(join(f.sessionDir, "skill-active-state.json")),
        ]);
        const result = await preTool(f, command);
        assert.equal(result.outputJson?.decision, "block");
        assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.deepEqual(await Promise.all([
          readFile(join(f.sessionDir, "ultragoal-state.json")),
          readFile(join(f.sessionDir, "skill-active-state.json")),
        ]), before);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const command of ["omx cancel", "omx cancel --force"]) {
    it(`accepts affirmative alternate lifecycle identity aliases for ${command}`, async () => {
      const f = await fixture(`aliases-${command.endsWith("--force") ? "force" : "plain"}`);
      try {
        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
        state.sessionId = state.session_id;
        delete state.session_id;
        state.cwd = state.workingDirectory;
        delete state.workingDirectory;
        const skill = JSON.parse(await readFile(skillPath, "utf8"));
        skill.sessionId = skill.session_id;
        delete skill.session_id;
        skill.workingDirectory = skill.cwd;
        delete skill.cwd;
        skill.active_skills[0].sessionId = skill.active_skills[0].session_id;
        delete skill.active_skills[0].session_id;
        skill.active_skills[0].workingDirectory = skill.active_skills[0].cwd;
        delete skill.active_skills[0].cwd;
        await writeJson(ultragoalPath, state);
        await writeJson(skillPath, skill);
        const result = await preTool(f, command);
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.equal(JSON.parse(await readFile(ultragoalPath, "utf8")).active, false);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });

    it(`accepts canonical generated lifecycle state without cwd aliases for ${command}`, async () => {
      const f = await fixture(`canonical-no-cwd-${command.endsWith("--force") ? "force" : "plain"}`);
      try {
        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
        delete state.workingDirectory;
        const skill = JSON.parse(await readFile(skillPath, "utf8"));
        delete skill.cwd;
        delete skill.active_skills[0].cwd;
        await writeJson(ultragoalPath, state);
        await writeJson(skillPath, skill);
        const result = await preTool(f, command);
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.equal(JSON.parse(await readFile(ultragoalPath, "utf8")).active, false);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });

    for (const missingIdentity of [
      "workflow-session",
      "skill-state",
      "skill-target-session",
    ] as const) {
      it(`rejects ${missingIdentity} identity without mutation for ${command}`, async () => {
        const f = await fixture(`missing-${missingIdentity}-${command.endsWith("--force") ? "force" : "plain"}`);
        try {
          const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
          const skillPath = join(f.sessionDir, "skill-active-state.json");
          const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
          const skill = JSON.parse(await readFile(skillPath, "utf8"));
          if (missingIdentity === "workflow-session") delete state.session_id;
          if (missingIdentity === "skill-state") {
            delete skill.session_id;
            delete skill.cwd;
          }
          if (missingIdentity === "skill-target-session") delete skill.active_skills[0].session_id;
          await writeJson(ultragoalPath, state);
          await writeJson(skillPath, skill);
          const before = await Promise.all([readFile(ultragoalPath), readFile(skillPath)]);
          const result = await preTool(f, command);
          assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
          assert.deepEqual(await Promise.all([readFile(ultragoalPath), readFile(skillPath)]), before);
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  for (const command of ["omx cancel", "omx cancel --force"]) {
    it(`supports canonical Windows Ultragoal cancellation for ${command}`, async () => {
      const f = await fixture(`windows-${command.endsWith("--force") ? "force" : "plain"}`);
      try {
        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
        delete state.workingDirectory;
        const skill = JSON.parse(await readFile(skillPath, "utf8"));
        delete skill.cwd;
        delete skill.active_skills[0].cwd;
        await writeJson(ultragoalPath, state);
        await writeJson(skillPath, skill);
        const result = await withEnv({ NODE_ENV: "test", OMX_NATIVE_HOOK_TEST_PLATFORM: "win32" }, () => preTool(f, command));
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.equal(JSON.parse(await readFile(ultragoalPath, "utf8")).active, false);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  it("denies foreign Windows lifecycle identity without mutation", async () => {
    const f = await fixture("windows-foreign");
    try {
      const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
      const skillPath = join(f.sessionDir, "skill-active-state.json");
      const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
      state.session_id = "foreign-session";
      await writeJson(ultragoalPath, state);
      const before = await Promise.all([readFile(ultragoalPath), readFile(skillPath)]);
      const result = await withEnv({ NODE_ENV: "test", OMX_NATIVE_HOOK_TEST_PLATFORM: "win32" }, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.deepEqual(await Promise.all([readFile(ultragoalPath), readFile(skillPath)]), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("denies a Windows reparse-style target without touching its destination", async () => {
    const f = await fixture("windows-reparse");
    try {
      const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
      const outsidePath = join(f.cwd, "outside-ultragoal-state.json");
      await writeJson(outsidePath, {
        active: true,
        mode: "ultragoal",
        current_phase: "planning",
        session_id: f.sessionId,
        workingDirectory: f.cwd,
        marker: "outside",
      });
      const outsideBefore = await readFile(outsidePath);
      await rm(ultragoalPath);
      await symlink(outsidePath, ultragoalPath, "file");
      const result = await withEnv({ NODE_ENV: "test", OMX_NATIVE_HOOK_TEST_PLATFORM: "win32" }, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.deepEqual(await readFile(outsidePath), outsideBefore);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("denies Windows target substitution detected during pinned preflight", async () => {
    const f = await fixture("windows-substitution");
    try {
      const paths = [
        join(f.sessionDir, "ultragoal-state.json"),
        join(f.sessionDir, "skill-active-state.json"),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      const result = await withEnv({
        NODE_ENV: "test",
        OMX_NATIVE_HOOK_TEST_PLATFORM: "win32",
        OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER: "preflight-instability",
      }, () => preTool(f, "omx cancel --force"));
      assert.equal(result.outputJson?.decision, "block");
      assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const strictMissingCwd of ["workflow", "skill"] as const) {
    it(`keeps the exported transaction helper strict when ${strictMissingCwd} cwd identity is missing`, async () => {
      const f = await fixture(`strict-${strictMissingCwd}-cwd`);
      try {
        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        if (strictMissingCwd === "workflow") {
          const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
          delete state.workingDirectory;
          await writeJson(ultragoalPath, state);
        } else {
          const skill = JSON.parse(await readFile(skillPath, "utf8"));
          delete skill.cwd;
          delete skill.active_skills[0].cwd;
          await writeJson(skillPath, skill);
        }
        const before = await Promise.all([readFile(ultragoalPath), readFile(skillPath)]);
        assert.deepEqual(await terminalizeExactUltragoalSessionForHookCancel({
          stateDir: f.stateDir,
          canonicalSessionId: f.sessionId,
          cwd: f.cwd,
          nowIso: "2026-07-29T00:00:00.000Z",
        }), { ok: false, reason: "state_mismatch" });
        assert.deepEqual(await Promise.all([readFile(ultragoalPath), readFile(skillPath)]), before);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const command of ["omx cancel", "omx cancel --force"]) {
    it(`cancels canonical Autopilot-supervised Ultragoal parent, child, and mirror for ${command}`, async () => {
      const f = await fixture(`supervised-${command.endsWith("--force") ? "force" : "plain"}`);
      try {
        const paths = await writeSupervisedUltragoal(f);
        const result = await preTool(f, command);
        assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        const autopilot = JSON.parse(await readFile(paths.autopilotPath, "utf8"));
        const ultragoal = JSON.parse(await readFile(paths.ultragoalPath, "utf8"));
        const skill = JSON.parse(await readFile(paths.skillPath, "utf8"));
        assert.equal(autopilot.active, false);
        assert.equal(autopilot.current_phase, "cancelled");
        assert.equal(autopilot.marker, "parent");
        assert.equal(ultragoal.active, false);
        assert.equal(ultragoal.current_phase, "cancelled");
        assert.equal(ultragoal.marker, "child");
        assert.equal(skill.active, false);
        assert.equal(skill.skill, "autopilot");
        assert.equal(skill.phase, "cancelled");
        assert.equal(skill.active_skills[0].active, false);
        assert.equal(skill.active_skills[0].phase, "cancelled");
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  it("rejects a conflicting supervised parent cwd alias without mutation", async () => {
    const f = await fixture("supervised-parent-cwd-conflict");
    try {
      const paths = await writeSupervisedUltragoal(f);
      const parent = JSON.parse(await readFile(paths.autopilotPath, "utf8"));
      parent.cwd = f.cwd;
      parent.workingDirectory = join(f.cwd, "foreign");
      await writeJson(paths.autopilotPath, parent);
      const statePaths = [paths.autopilotPath, paths.ultragoalPath, paths.skillPath];
      const before = await Promise.all(statePaths.map((path) => readFile(path)));
      const result = await preTool(f, "omx cancel --force");
      assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.deepEqual(await Promise.all(statePaths.map((path) => readFile(path))), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const boundary of [
    "journal-fsync",
    "partial-parent-data-write",
    "parent-data-write",
    "partial-first-data-write",
    "first-data-write",
    "partial-second-data-write",
    "second-data-write",
    "verification",
    "journal-commit",
    "unlink",
    "lock-release",
  ]) {
    it(`keeps supervised parent, child, and mirror transactionally aligned after ${boundary}`, async () => {
      const f = await fixture(`supervised-fault-${boundary}`);
      try {
        const paths = await writeSupervisedUltragoal(f);
        const statePaths = [paths.autopilotPath, paths.ultragoalPath, paths.skillPath];
        const before = await Promise.all(statePaths.map((path) => readFile(path)));
        await withEnv({ NODE_ENV: "test", OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER: boundary }, () => preTool(f, "omx cancel --force"));
        const after = await Promise.all(statePaths.map((path) => readFile(path)));
        const changed = after.map((bytes, index) => !bytes.equals(before[index]));
        assert.ok(changed.every((value) => value === changed[0]), boundary);
        if (changed[0]) {
          for (const bytes of after) {
            const state = JSON.parse(bytes.toString("utf8"));
            assert.equal(state.active, false, boundary);
            assert.equal(state.current_phase ?? state.phase, "cancelled", boundary);
          }
        }
        const journalPath = join(f.sessionDir, ".hook-cancel-transaction.json");
        if (boundary === "journal-fsync") {
          const journal = JSON.parse(await readFile(journalPath, "utf8"));
          assert.ok(journal.targets.parent_autopilot);
          assert.ok(journal.targets.workflow_state);
          assert.ok(journal.targets.skill_active);
        }
        assert.equal(existsSync(join(f.sessionDir, ".hook-cancel.lock")), false);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const scenario of [
    "terminal-phase",
    "completing-phase",
    "foreign-cwd",
    "conflicting-cwd-aliases",
    "conflicting-skill-cwd-aliases",
    "conflicting-session-aliases",
    "malformed-cwd-alias",
    "malformed-session-alias",
    "malformed-skill-active",
  ] as const) {
    it(`does not hook-own ${scenario} Ultragoal lifecycle state`, async () => {
      const f = await fixture(scenario);
      try {
        const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
        const skillPath = join(f.sessionDir, "skill-active-state.json");
        const state = JSON.parse(await readFile(ultragoalPath, "utf8"));
        const skill = JSON.parse(await readFile(skillPath, "utf8"));
        if (scenario === "terminal-phase") state.current_phase = "complete";
        if (scenario === "completing-phase") state.current_phase = "completing";
        if (scenario === "foreign-cwd") state.workingDirectory = join(f.cwd, "foreign");
        if (scenario === "conflicting-cwd-aliases") {
          state.cwd = f.cwd;
          state.workingDirectory = join(f.cwd, "foreign");
        }
        if (scenario === "conflicting-session-aliases") state.sessionId = "other-session";
        if (scenario === "malformed-cwd-alias") state.cwd = 42;
        if (scenario === "malformed-session-alias") state.sessionId = 42;
        if (scenario === "conflicting-skill-cwd-aliases") {
          skill.cwd = f.cwd;
          skill.workingDirectory = join(f.cwd, "foreign");
        }
        if (scenario === "malformed-skill-active") skill.active_skills[0].active = "false";
        await writeJson(ultragoalPath, state);
        await writeJson(skillPath, skill);
        const before = await Promise.all([readFile(ultragoalPath), readFile(skillPath)]);
        const result = await preTool(f, "omx cancel --force");
        assert.doesNotMatch(JSON.stringify(result.outputJson), /cancelled_exact_session/);
        assert.deepEqual(await Promise.all([readFile(ultragoalPath), readFile(skillPath)]), before);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  it("prefers active Ultragoal over simultaneous stale Autopilot state", async () => {
    const f = await fixture("ultragoal-priority");
    try {
      const autopilotPath = join(f.sessionDir, "autopilot-state.json");
      await writeJson(autopilotPath, {
        active: true,
        mode: "autopilot",
        current_phase: "deep-interview",
        session_id: f.sessionId,
        workingDirectory: f.cwd,
        marker: "preserve",
      });
      const autopilotBefore = await readFile(autopilotPath);
      const result = await preTool(f, "omx cancel");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.equal(JSON.parse(await readFile(join(f.sessionDir, "ultragoal-state.json"), "utf8")).active, false);
      assert.deepEqual(await readFile(autopilotPath), autopilotBefore);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("prefers active canonical Autopilot deep-interview over stale terminal Ultragoal state", async () => {
    const f = await fixture("stale-terminal-ultragoal");
    try {
      const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
      const autopilotPath = join(f.sessionDir, "autopilot-state.json");
      const skillPath = join(f.sessionDir, "skill-active-state.json");
      await writeJson(ultragoalPath, {
        active: false,
        mode: "ultragoal",
        current_phase: "completed",
        session_id: f.sessionId,
        marker: "stale-child",
      });
      await writeJson(autopilotPath, {
        active: true,
        mode: "autopilot",
        current_phase: "deep-interview",
        session_id: f.sessionId,
        marker: "active-parent",
      });
      await writeJson(skillPath, {
        active: true,
        skill: "autopilot",
        phase: "deep-interview",
        session_id: f.sessionId,
        active_skills: [{ active: true, skill: "autopilot", phase: "deep-interview", session_id: f.sessionId }],
      });
      const staleUltragoal = await readFile(ultragoalPath);
      const result = await preTool(f, "omx cancel");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.deepEqual(await readFile(ultragoalPath), staleUltragoal);
      const autopilot = JSON.parse(await readFile(autopilotPath, "utf8"));
      const skill = JSON.parse(await readFile(skillPath, "utf8"));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, "cancelled");
      assert.equal(skill.active, false);
      assert.equal(skill.phase, "cancelled");
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("denies Autopilot fallback when an active Ultragoal lifecycle has a mismatched mirror", async () => {
    const f = await fixture("active-ultragoal-mirror-mismatch");
    try {
      const autopilotPath = join(f.sessionDir, "autopilot-state.json");
      const ultragoalPath = join(f.sessionDir, "ultragoal-state.json");
      const skillPath = join(f.sessionDir, "skill-active-state.json");
      await writeJson(autopilotPath, {
        active: true,
        mode: "autopilot",
        current_phase: "deep-interview",
        session_id: f.sessionId,
      });
      await writeJson(skillPath, {
        active: true,
        skill: "autopilot",
        phase: "deep-interview",
        session_id: f.sessionId,
        active_skills: [{ active: true, skill: "autopilot", phase: "deep-interview", session_id: f.sessionId }],
      });
      const paths = [autopilotPath, ultragoalPath, skillPath];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      const result = await preTool(f, "omx cancel");
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /active_state/);
      assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  it("rejects a malformed payload session alias without terminalizing", async () => {
    const f = await fixture("malformed-payload-session");
    try {
      const paths = [
        join(f.sessionDir, "ultragoal-state.json"),
        join(f.sessionDir, "skill-active-state.json"),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      const result = await preTool(f, "omx cancel --force", { sessionId: 42 });
      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /session_binding/);
      assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
  it("rejects native-child cancellation authority without terminalizing the owner session", async () => {
    const f = await fixture("native-child");
    try {
      const paths = [
        join(f.sessionDir, "ultragoal-state.json"),
        join(f.sessionDir, "skill-active-state.json"),
      ];
      const before = await Promise.all(paths.map((path) => readFile(path)));
      for (const overrides of [
        {
          thread_id: "child-thread",
          agent_id: "child-thread",
          is_subagent: true,
          parent_session_id: f.sessionId,
        },
        {
          thread_id: f.threadId,
          agent_id: f.threadId,
          source: { subagent: { thread_spawn: { parent_thread_id: f.threadId } } },
        },
      ]) {
        const result = await preTool(f, "omx cancel --force", overrides);
        assert.equal(result.outputJson?.decision, "block");
        assert.match(JSON.stringify(result.outputJson), /actor_authority/);
        assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
      }
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
});
