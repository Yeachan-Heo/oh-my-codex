import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readHookCancelTransactionRecoveryState,
  terminalizeExactAutopilotSessionForHookCancel,
} from "../codex-native-hook.js";

const NOW = "2026-07-25T00:00:00.000Z";

type Fixture = {
  cwd: string;
  stateDir: string;
  sessionId: string;
  sessionDir: string;
  autopilotPath: string;
  skillPath: string;
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function fixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), "omx-3293-cancel-"));
  const stateDir = join(cwd, ".omx", "state");
  const sessionId = "session-3293";
  const sessionDir = join(stateDir, "sessions", sessionId);
  const autopilotPath = join(sessionDir, "autopilot-state.json");
  const skillPath = join(sessionDir, "skill-active-state.json");
  await writeJson(autopilotPath, {
    active: true, mode: "autopilot", current_phase: "deep-interview", session_id: sessionId, cwd,
    handoff_artifacts: { interview: "preserve" }, unrelated: { preserved: true },
  });
  await writeJson(skillPath, {
    version: 1, active: true, skill: "autopilot", phase: "deep-interview", session_id: sessionId, cwd,
    active_skills: [
      { skill: "autopilot", active: true, phase: "deep-interview", session_id: sessionId, cwd, marker: "cancel" },
      { skill: "ralph", active: true, phase: "execution", session_id: sessionId, cwd, marker: "keep" },
    ],
  });
  return { cwd, stateDir, sessionId, sessionDir, autopilotPath, skillPath };
}

async function terminalize(f: Fixture) {
  return terminalizeExactAutopilotSessionForHookCancel({ stateDir: f.stateDir, canonicalSessionId: f.sessionId, cwd: f.cwd, nowIso: NOW });
}

async function withFixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.cwd, { recursive: true, force: true }); }
}

test("terminalizes the exact active deep-interview session while preserving handoff and unrelated skill entries", async () => {
  await withFixture(async (f) => {
    assert.deepEqual(await terminalize(f), { ok: true });
    const autopilot = JSON.parse(await readFile(f.autopilotPath, "utf8"));
    const skill = JSON.parse(await readFile(f.skillPath, "utf8"));
    assert.deepEqual(autopilot.handoff_artifacts, { interview: "preserve" });
    assert.deepEqual(autopilot.unrelated, { preserved: true });
    assert.equal(autopilot.active, false); assert.equal(autopilot.current_phase, "cancelled");
    assert.equal(autopilot.completed_at, NOW); assert.equal(autopilot.last_turn_at, NOW);
    assert.equal(skill.active, true); assert.equal(skill.skill, "ralph"); assert.equal(skill.phase, "execution");
    assert.deepEqual(skill.active_skills[0], { skill: "autopilot", active: false, phase: "cancelled", session_id: f.sessionId, cwd: f.cwd, marker: "cancel", updated_at: NOW });
    assert.deepEqual(skill.active_skills[1], { skill: "ralph", active: true, phase: "execution", session_id: f.sessionId, cwd: f.cwd, marker: "keep" });
    assert.equal(existsSync(join(f.sessionDir, ".hook-cancel-transaction.json")), false);
    assert.equal(existsSync(join(f.sessionDir, ".hook-cancel.lock")), false);
  });
});

test("preserves a second session byte-for-byte", async () => {
  await withFixture(async (f) => {
    const other = join(f.stateDir, "sessions", "other-session", "autopilot-state.json");
    await writeJson(other, { active: true, mode: "autopilot", current_phase: "deep-interview", sentinel: "other" });
    const before = await readFile(other);
    assert.equal((await terminalize(f)).ok, true);
    assert.deepEqual(await readFile(other), before);
  });
});

test("denies a pre-existing exact-session lock without mutation", async () => {
  await withFixture(async (f) => {
    const before = await readFile(f.autopilotPath); await writeFile(join(f.sessionDir, ".hook-cancel.lock"), "held");
    assert.deepEqual(await terminalize(f), { ok: false, reason: "lock_held" });
    assert.deepEqual(await readFile(f.autopilotPath), before);
  });
});

test("denies a pre-existing prepared journal with a value-free recovery reason", async () => {
  await withFixture(async (f) => {
    await writeFile(join(f.sessionDir, ".hook-cancel-transaction.json"), JSON.stringify({ version: 1, phase: "prepared" }));
    assert.deepEqual(await terminalize(f), { ok: false, reason: "recovery_required" });
    assert.equal(await readHookCancelTransactionRecoveryState({ stateDir: f.stateDir, canonicalSessionId: f.sessionId }), "recovery_required");
  });
});

for (const sessionId of [".", "..", "../escape"]) {
  test(`denies unsafe session id ${JSON.stringify(sessionId)} without mutation`, async () => {
    await withFixture(async (f) => {
      const before = [await readFile(f.autopilotPath), await readFile(f.skillPath)];
      assert.deepEqual(await terminalizeExactAutopilotSessionForHookCancel({ stateDir: f.stateDir, canonicalSessionId: sessionId, cwd: f.cwd, nowIso: NOW }), { ok: false, reason: "invalid_target" });
      assert.equal(await readHookCancelTransactionRecoveryState({ stateDir: f.stateDir, canonicalSessionId: sessionId }), "invalid_target");
      assert.deepEqual([await readFile(f.autopilotPath), await readFile(f.skillPath)], before);
    });
  });
}

test("denies a symlinked session directory component", async () => {
  await withFixture(async (f) => {
    const linked = join(f.stateDir, "sessions", "linked-session"); await symlink(f.sessionDir, linked);
    assert.deepEqual(await terminalizeExactAutopilotSessionForHookCancel({ stateDir: f.stateDir, canonicalSessionId: "linked-session", cwd: f.cwd, nowIso: NOW }), { ok: false, reason: "invalid_target" });
  });
});

test("denies a symlinked or non-regular target file", async () => {
  await withFixture(async (f) => {
    await rm(f.autopilotPath); await symlink(f.skillPath, f.autopilotPath);
    assert.equal((await terminalize(f)).ok, false);
  });
  await withFixture(async (f) => {
    await rm(f.autopilotPath); await mkdir(f.autopilotPath);
    assert.equal((await terminalize(f)).ok, false);
  });
});

test("denies state changed during preflight without mutation", async () => {
  await withFixture(async (f) => {
    const before = await readFile(f.autopilotPath);
    const prior = process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER;
    process.env.NODE_ENV = "test";
    process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = "preflight-instability";
    try {
      assert.deepEqual(await terminalize(f), { ok: false, reason: "preflight_failed" });
    } finally {
      if (prior === undefined) delete process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER;
      else process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = prior;
    }
    assert.deepEqual(await readFile(f.autopilotPath), before);
  });
});

test("denies malformed or oversized JSON without mutation", async () => {
  await withFixture(async (f) => { await writeFile(f.autopilotPath, "{"); const before = await readFile(f.autopilotPath); assert.equal((await terminalize(f)).ok, false); assert.deepEqual(await readFile(f.autopilotPath), before); });
  await withFixture(async (f) => { const bytes = Buffer.alloc(1024 * 1024 + 1, 0x20); await writeFile(f.autopilotPath, bytes); assert.equal((await terminalize(f)).ok, false); assert.deepEqual(await readFile(f.autopilotPath), bytes); });
});

test("denies contradictory owner session or cwd fields without mutation", async () => {
  await withFixture(async (f) => { await writeJson(f.skillPath, { active: true, skill: "autopilot", phase: "deep-interview", session_id: "other", cwd: f.cwd }); assert.deepEqual(await terminalize(f), { ok: false, reason: "state_mismatch" }); });
  await withFixture(async (f) => { await writeJson(f.autopilotPath, { active: true, mode: "autopilot", current_phase: "deep-interview", session_id: f.sessionId, cwd: join(f.cwd, "other") }); assert.deepEqual(await terminalize(f), { ok: false, reason: "state_mismatch" }); });
});

test("denies a missing paired skill-active state without mutation", async () => {
  await withFixture(async (f) => { const before = await readFile(f.autopilotPath); await rm(f.skillPath); assert.deepEqual(await terminalize(f), { ok: false, reason: "preflight_failed" }); assert.deepEqual(await readFile(f.autopilotPath), before); });
});

test("cleans a lock whose initialization fails before the transaction starts", async () => {
  await withFixture(async (f) => {
    const original = [await readFile(f.autopilotPath), await readFile(f.skillPath)];
    const prior = process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER;
    process.env.NODE_ENV = "test";
    process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = "lock-acquire";
    try {
      assert.deepEqual(await terminalize(f), { ok: false, reason: "lock_held" });
    } finally {
      if (prior === undefined) delete process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER;
      else process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = prior;
    }
    assert.equal(existsSync(join(f.sessionDir, ".hook-cancel.lock")), false);
    assert.deepEqual([await readFile(f.autopilotPath), await readFile(f.skillPath)], original);
  });
});

for (const boundary of ["journal-fsync", "partial-first-data-write", "first-data-write", "partial-second-data-write", "second-data-write", "verification", "journal-commit", "unlink", "lock-release"]) {
  test(`fault injection after ${boundary} never leaves a torn two-file state`, async () => {
    await withFixture(async (f) => {
      const original = [await readFile(f.autopilotPath), await readFile(f.skillPath)];
      const prior = process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER;
      process.env.NODE_ENV = "test"; process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = boundary;
      try { await terminalize(f); } finally { if (prior === undefined) delete process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER; else process.env.OMX_NATIVE_HOOK_TEST_CANCEL_TRANSACTION_FAIL_AFTER = prior; }
      const now = [await readFile(f.autopilotPath), await readFile(f.skillPath)];
      const journal = existsSync(join(f.sessionDir, ".hook-cancel-transaction.json"));
      assert.ok((now[0].equals(original[0]) && now[1].equals(original[1])) || (!now[0].equals(original[0]) && !now[1].equals(original[1])) || journal, boundary);
    });
  });
}
