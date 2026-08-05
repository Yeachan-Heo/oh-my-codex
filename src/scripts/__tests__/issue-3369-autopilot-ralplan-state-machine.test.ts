import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";
import { executeStateOperation } from "../../state/operations.js";

const omxBin = fileURLToPath(new URL("../../cli/omx.js", import.meta.url));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

function runOmx(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
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

describe("issue #3369 Autopilot Ralplan state-machine self-lock", () => {
  it("cancels identity-stripped Autopilot Ralplan state without executing Bash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3369-ralplan-cancel-"));
    const sessionId = "sess-3369-ralplan-cancel";
    const threadId = "thread-3369-ralplan-cancel";
    const stateDir = join(cwd, ".omx", "state");
    const sessionDir = join(stateDir, "sessions", sessionId);
    try {
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
      await writeJson(join(sessionDir, "autopilot-state.json"), {
        active: true,
        current_phase: "ralplan",
        run_outcome: "continue",
      });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        version: 1,
        active: true,
        skill: "autopilot",
        phase: "ralplan",
        source: "state-operations",
        session_id: sessionId,
        active_skills: [{
          skill: "autopilot",
          phase: "ralplan",
          active: true,
          session_id: sessionId,
        }],
      });

      const result = await dispatchCodexNativeHook({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: sessionId,
        thread_id: threadId,
        agent_id: threadId,
        tool_name: "Bash",
        tool_input: { command: "omx cancel" },
      }, { cwd });

      assert.equal(result.outputJson?.decision, "block");
      assert.match(JSON.stringify(result.outputJson), /cancelled_exact_session/);
      assert.equal(JSON.parse(await readFile(join(sessionDir, "autopilot-state.json"), "utf8")).active, false);
      assert.equal(JSON.parse(await readFile(join(sessionDir, "skill-active-state.json"), "utf8")).active, false);

      const stop1 = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        thread_id: threadId,
      }, { cwd });
      const stop2 = await dispatchCodexNativeHook({
        hook_event_name: "Stop",
        cwd,
        session_id: sessionId,
        thread_id: threadId,
      }, { cwd });
      assert.equal(stop1.outputJson, null);
      assert.equal(stop2.outputJson, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats blank optional skill owners as absent for exact-session cancel", async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "omx-3369-blank-owner-")));
    const sessionId = "sess-3369-blank-owner";
    const nativeSessionId = "native-3369-blank-owner";
    const stateDir = join(cwd, ".omx", "state");
    const sessionDir = join(stateDir, "sessions", sessionId);
    try {
      await writeJson(join(stateDir, "session.json"), {
        session_id: sessionId,
        native_session_id: nativeSessionId,
        cwd,
        platform: process.platform,
        state_root: stateDir,
      });
      await mkdir(join(stateDir, "sessions", nativeSessionId), { recursive: true });
      await writeJson(join(stateDir, "sessions", nativeSessionId, "session-owner.json"), {
        session_id: nativeSessionId,
        native_session_id: nativeSessionId,
        cwd,
        platform: process.platform,
      });
      await writeJson(join(sessionDir, "autopilot-state.json"), {
        active: true,
        mode: "autopilot",
        current_phase: "ralplan",
        session_id: sessionId,
      });
      await writeJson(join(sessionDir, "skill-active-state.json"), {
        active: true,
        skill: "autopilot",
        phase: "ralplan",
        session_id: sessionId,
        owner_codex_session_id: "",
        active_skills: [{
          skill: "autopilot",
          phase: "ralplan",
          active: true,
          session_id: sessionId,
          owner_codex_session_id: "",
        }],
      });

      const result = runOmx(cwd, { OMX_ROOT: cwd, OMX_SESSION_ID: sessionId }, "cancel");
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Cancelled: autopilot/);
      assert.equal(JSON.parse(await readFile(join(sessionDir, "autopilot-state.json"), "utf8")).active, false);
      assert.equal(JSON.parse(await readFile(join(sessionDir, "skill-active-state.json"), "utf8")).active, false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks Ralplan-to-Autopilot transition without local-owner lifecycle evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omx-3369-fresh-admission-"));
    try {
      await withEnv({ OMX_ROOT: cwd, OMX_SESSION_ID: undefined }, async () => {
        const sessionDir = join(cwd, ".omx", "state", "sessions", "sess-3369-fresh");
        await writeJson(join(sessionDir, "ralplan-state.json"), {
          active: true,
          current_phase: "planning",
          run_outcome: "continue",
        });
        await writeJson(join(sessionDir, "skill-active-state.json"), {
          version: 1,
          active: true,
          skill: "ralplan",
          phase: "planning",
          source: "test-fixture",
          session_id: "sess-3369-fresh",
          active_skills: [{
            skill: "ralplan",
            phase: "planning",
            active: true,
            session_id: "sess-3369-fresh",
          }],
        });

        const response = await executeStateOperation("state_write", {
          workingDirectory: cwd,
          mode: "autopilot",
          active: true,
          current_phase: "deep-interview",
          session_id: "sess-3369-fresh",
        });
        assert.equal(response.isError, true);
        assert.match(String((response.payload as { error?: string }).error || ""), /native_subagent_consensus_evidence_missing/);
        await assert.rejects(readFile(join(sessionDir, "autopilot-state.json")));
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
