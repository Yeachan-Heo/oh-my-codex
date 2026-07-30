import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { dispatchCodexNativeHook } from "../codex-native-hook.js";

// Regression coverage for the run-scoped Conductor recovery deadlock:
// `omx` launches with a run-scoped state root set OMX_ROOT to an isolated run
// directory (state tree at $OMX_ROOT/.omx/state), export OMX_* environment
// names beyond the Conductor guard's allowlist, and prepend
// $OMX_ROOT/.omx/runtime/bin (holding an `omx` shim that execs the canonical
// package CLI) to PATH. The Conductor guard previously treated each of those
// launcher-authenticated facts as hostile, so once ultragoal Conductor mode
// armed, every omx CLI transport was denied — including bare `omx cancel`,
// the documented recovery surface. The session could not exit its own
// Conductor state.
//
// These tests stage an armed ultragoal Conductor session under a faithful
// run-scoped launcher environment and pin:
//   1. plain source writes stay DENIED (the guard must not lose its teeth,
//      and the control proves the fixture actually arms the guard);
//   2. bare `omx cancel` / `omx cancel --force` pass through (recovery).

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify(value, null, 2));
}

const PACKAGE_CLI_PATH = realpathSync(fileURLToPath(new URL("../../cli/omx.js", import.meta.url)));

const MANAGED_ENV_NAMES = [
  "OMX_ROOT",
  "OMX_STATE_ROOT",
  "OMX_TEAM_STATE_ROOT",
  "OMX_SESSION_ID",
  "OMX_TEAM_WORKER_LAUNCH_ARGS",
  "PATH",
  "NODE_OPTIONS",
  "OPENSSL_CONF",
  "NODE_V8_COVERAGE",
  "NODE_COMPILE_CACHE",
  "NODE_REDIRECT_WARNINGS",
  "NODE_REPORT_DIRECTORY",
  "NODE_REPORT_FILENAME",
  "BASH_ENV",
] as const;

interface ArmedRunScopedSession {
  cwd: string;
  runRoot: string;
  sessionId: string;
  leaderThreadId: string;
}

async function stageArmedRunScopedConductorSession(tag: string): Promise<ArmedRunScopedSession> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-conductor-recovery-${tag}-repo-`));
  const runRoot = await mkdtemp(join(tmpdir(), `omx-conductor-recovery-${tag}-run-`));
  const stateDir = join(runRoot, ".omx", "state");
  const sessionId = `sess-conductor-recovery-${tag}`;
  const leaderThreadId = `thread-conductor-recovery-${tag}`;
  const now = "2026-07-29T22:22:41.918Z";

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
  await writeJson(join(stateDir, "skill-active-state.json"), {
    version: 1,
    active: true,
    skill: "ultragoal",
    keyword: "",
    phase: "executing",
    activated_at: now,
    updated_at: now,
    source: "state-operations",
    session_id: sessionId,
    active_skills: [
      { skill: "ultragoal", phase: "executing", active: true, activated_at: now, updated_at: now, session_id: sessionId },
    ],
  });
  await writeJson(join(stateDir, "sessions", sessionId, "skill-active-state.json"), {
    version: 1,
    active: true,
    skill: "ultragoal",
    keyword: "",
    phase: "executing",
    activated_at: now,
    updated_at: now,
    source: "state-operations",
    owner_codex_session_id: leaderThreadId,
    input_lock: null,
  });
  await writeJson(join(stateDir, "sessions", sessionId, "ultragoal-state.json"), {
    active: true,
    current_phase: "executing",
    run_outcome: "continue",
    iteration: 3,
    last_turn_at: now,
  });

  // Faithful launcher runtime shim: $OMX_ROOT/.omx/runtime/bin/omx execs the
  // canonical package CLI through an absolute node interpreter.
  const shimDir = join(runRoot, ".omx", "runtime", "bin");
  await mkdir(shimDir, { recursive: true });
  const shimPath = join(shimDir, "omx");
  await writeFile(shimPath, `#!/bin/sh\nexec '${process.execPath}' '${PACKAGE_CLI_PATH}' "$@"\n`);
  chmodSync(shimPath, 0o700);

  return { cwd, runRoot, sessionId, leaderThreadId };
}

function applyRunScopedLauncherEnvironment(session: ArmedRunScopedSession, basePath: string): void {
  for (const name of [
    "NODE_OPTIONS", "OPENSSL_CONF", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE",
    "NODE_REDIRECT_WARNINGS", "NODE_REPORT_DIRECTORY", "NODE_REPORT_FILENAME", "BASH_ENV",
  ]) {
    delete process.env[name];
  }
  process.env.OMX_ROOT = session.runRoot;
  process.env.OMX_SESSION_ID = session.sessionId;
  // A real launcher export that is NOT on the guard's permitted-name allowlist;
  // inherited names must be tolerated (only inline assignments stay strict).
  process.env.OMX_TEAM_WORKER_LAUNCH_ARGS = '"--dangerously-bypass-approvals-and-sandbox" "--model" "gpt-5.6-sol"';
  process.env.PATH = `${join(session.runRoot, ".omx", "runtime", "bin")}:${basePath}`;
}

function buildPreToolUsePayload(session: ArmedRunScopedSession, toolInput: Record<string, unknown>) {
  return {
    hook_event_name: "PreToolUse",
    cwd: session.cwd,
    session_id: session.sessionId,
    thread_id: session.leaderThreadId,
    agent_id: session.leaderThreadId,
    source: "native",
    tool_name: "Bash",
    tool_use_id: `tool-conductor-recovery-${session.sessionId}`,
    tool_input: toolInput,
  };
}

describe("Conductor recovery under a run-scoped launcher environment", () => {
  const savedEnv = new Map<string, string | undefined>();

  function saveEnv(): void {
    for (const name of MANAGED_ENV_NAMES) savedEnv.set(name, process.env[name]);
  }

  afterEach(() => {
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
  });

  it("keeps denying direct source writes while Conductor mode is armed (control: fixture arms the guard)", async () => {
    saveEnv();
    const session = await stageArmedRunScopedConductorSession("control");
    try {
      applyRunScopedLauncherEnvironment(session, savedEnv.get("PATH") ?? "");
      const result = await dispatchCodexNativeHook(
        buildPreToolUsePayload(session, { command: "printf x > src/blocked.ts" }),
        { cwd: session.cwd },
      );
      assert.equal(result.outputJson?.decision, "block");
      assert.match(String(result.outputJson?.reason ?? ""), /Conductor mode is active/);
    } finally {
      await rm(session.cwd, { recursive: true, force: true });
      await rm(session.runRoot, { recursive: true, force: true });
    }
  });

  it("allows bare `omx cancel` while Conductor mode is armed on a run-scoped session", async () => {
    saveEnv();
    const session = await stageArmedRunScopedConductorSession("cancel");
    try {
      applyRunScopedLauncherEnvironment(session, savedEnv.get("PATH") ?? "");
      const result = await dispatchCodexNativeHook(
        buildPreToolUsePayload(session, { command: "omx cancel" }),
        { cwd: session.cwd },
      );
      assert.notEqual(
        result.outputJson?.decision,
        "block",
        `bare omx cancel must stay recoverable: ${JSON.stringify(result.outputJson)}`,
      );
    } finally {
      await rm(session.cwd, { recursive: true, force: true });
      await rm(session.runRoot, { recursive: true, force: true });
    }
  });

  it("allows a bare omx help query when the CLI resolution is proven trusted, even with PATH entries inside the repo", async () => {
    // With a repo rooted at $HOME every user bin directory lives "inside the
    // repository", so conductorPathMayResolveRepositoryExecutable is
    // permanently true; it must not override a PROVEN trusted package-CLI
    // resolution, or pure help queries deny as "PATH mutation <unresolved>".
    saveEnv();
    const session = await stageArmedRunScopedConductorSession("help-query");
    try {
      // A repo-internal bin directory ahead of the shim in PATH (empty, so
      // resolution still hits the trusted shim) plus a nonexistent one —
      // both shapes that make the may-resolve heuristic fire.
      const repoBin = join(session.cwd, "node_modules", ".bin");
      await mkdir(repoBin, { recursive: true });
      const repoBinMissing = join(session.cwd, "bin");
      applyRunScopedLauncherEnvironment(session, savedEnv.get("PATH") ?? "");
      process.env.PATH = `${repoBin}:${repoBinMissing}:${process.env.PATH}`;
      const result = await dispatchCodexNativeHook(
        buildPreToolUsePayload(session, { command: "omx ultragoal create-goals --help" }),
        { cwd: session.cwd },
      );
      assert.notEqual(
        result.outputJson?.decision,
        "block",
        `trusted omx help query must not deny: ${JSON.stringify(result.outputJson)}`,
      );
    } finally {
      await rm(session.cwd, { recursive: true, force: true });
      await rm(session.runRoot, { recursive: true, force: true });
    }
  });

  it("allows `omx cancel --force` while Conductor mode is armed on a run-scoped session", async () => {
    saveEnv();
    const session = await stageArmedRunScopedConductorSession("cancel-force");
    try {
      applyRunScopedLauncherEnvironment(session, savedEnv.get("PATH") ?? "");
      const result = await dispatchCodexNativeHook(
        buildPreToolUsePayload(session, { command: "omx cancel --force" }),
        { cwd: session.cwd },
      );
      assert.notEqual(
        result.outputJson?.decision,
        "block",
        `omx cancel --force must stay recoverable: ${JSON.stringify(result.outputJson)}`,
      );
    } finally {
      await rm(session.cwd, { recursive: true, force: true });
      await rm(session.runRoot, { recursive: true, force: true });
    }
  });
});
