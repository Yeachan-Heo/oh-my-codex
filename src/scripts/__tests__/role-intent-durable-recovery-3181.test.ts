import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../../cli/ralplan.js';
import { readSubagentTrackingState, subagentTrackingPath } from '../../subagents/tracker.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

// #3181 durable bootstrap-order recovery: a crash/restart AFTER the authenticated adapted
// Architect role intent is durably recorded but BEFORE the first worker spawn must, on the
// SAME canonical session, recover the EXACT pending intent/receipt/spawn_task_name before
// any leader action. This is durable-ordering behavior, not initial-run field presence.

interface Receipt {
  ok: boolean;
  intent: { role: string; session_id: string; parent_thread_id: string; correlation_token: string };
  spawn_task_name: string;
}

async function invoke(cwd: string, args: string[]): Promise<{ json: unknown; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { cwd: () => cwd, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
    return { json: JSON.parse(stdout.join('\n')), exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

function roleIntentArgs(role: string, parentThread: string): string[] {
  return ['role-intent', 'write', '--role', role, '--parent-thread', parentThread, '--json'];
}

async function withFreshEnv(fn: () => Promise<void>): Promise<void> {
  const prior = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
  delete process.env.OMX_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.SESSION_ID;
  try {
    await fn();
  } finally {
    for (const key of ['OMX_SESSION_ID', 'CODEX_SESSION_ID', 'SESSION_ID'] as const) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

// Both plugin and legacy delivery drive the same native hook + CLI + tracker recovery path.
// Leader attestation is established only on the strictly-gated fresh leader PreToolUse
// entry point (the role-intent command's own PreToolUse fires before it executes); both
// deliveries route through it, so durable recovery is proven identically for each.
const DELIVERIES: Array<{ label: string; event: 'SessionStart' | 'PreToolUse' }> = [
  { label: 'plugin (PreToolUse-seeded)', event: 'PreToolUse' },
  { label: 'legacy (PreToolUse-seeded)', event: 'PreToolUse' },
];

async function seedAuthenticatedLeader(cwd: string, sessionId: string, event: 'SessionStart' | 'PreToolUse'): Promise<void> {
  if (event === 'SessionStart') {
    await dispatchCodexNativeHook({ hook_event_name: 'SessionStart', cwd, session_id: sessionId }, { cwd, sessionOwnerPid: process.pid });
  } else {
    await dispatchCodexNativeHook(
      {
        hook_event_name: 'PreToolUse',
        cwd,
        session_id: sessionId,
        thread_id: sessionId,
        tool_name: 'Bash',
        tool_use_id: 'tool-first',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      },
      { cwd, sessionOwnerPid: process.pid },
    );
  }
}

describe('#3181 durable bootstrap-order recovery', () => {
  for (const { label, event } of DELIVERIES) {
    it(`${label}: same-session resume recovers the exact adapted Architect intent/receipt/spawn_task_name before any spawn`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-recover-'));
      await withFreshEnv(async () => {
        try {
          const sessionId = `codex-native-${event}`;
          await seedAuthenticatedLeader(cwd, sessionId, event);

          // Durably record the Architect intent (before any worker spawn).
          const first = (await invoke(cwd, roleIntentArgs('architect', sessionId))).json as Receipt;
          assert.equal(first.ok, true);
          assert.equal(first.intent.role, 'architect');
          const token = first.intent.correlation_token;
          const spawnTaskName = first.spawn_task_name;

          // Crash/restart-before-first-spawn: durable state persists on disk. On the SAME
          // canonical session, the resumed leader re-runs role-intent and MUST recover the
          // exact intent/receipt/spawn_task_name — never a fresh unrelated intent.
          const resumed = (await invoke(cwd, roleIntentArgs('architect', sessionId))).json as Receipt;
          assert.equal(resumed.intent.correlation_token, token, 'exact correlation token must be recovered');
          assert.equal(resumed.spawn_task_name, spawnTaskName, 'exact spawn_task_name must be recovered');

          const state = await readSubagentTrackingState(cwd);
          assert.equal(state.pending_role_intents.length, 1, 'no unrelated replacement intent may be created');
          assert.equal(state.pending_role_intents[0]?.role, 'architect');

          // Ordering invariant: while the Architect intent is still live (pre-spawn), a Critic
          // request for the same leader must NOT reorder/replace it — single_flight_conflict.
          const critic = (await invoke(cwd, roleIntentArgs('critic', sessionId))).json as { ok: boolean; reason?: string };
          assert.deepEqual(critic, { ok: false, reason: 'single_flight_conflict' });
          assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      });
    });
  }

  it('idempotent retry after crash-during-recovery converges to one intent/receipt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-recover-retry-'));
    await withFreshEnv(async () => {
      try {
        const sessionId = 'codex-native-retry';
        await seedAuthenticatedLeader(cwd, sessionId, 'PreToolUse');
        const receipts: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const r = (await invoke(cwd, roleIntentArgs('architect', sessionId))).json as Receipt;
          receipts.push(r.intent.correlation_token);
        }
        assert.equal(new Set(receipts).size, 1, 'every retry recovers the same receipt');
        assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });

  it('foreign-session resume fails closed and never adopts the foreign leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-recover-foreign-'));
    const prior = process.env.OMX_SESSION_ID;
    try {
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      // Real leader session A is authenticated and has a durable intent.
      await withFreshEnv(async () => {
        await seedAuthenticatedLeader(cwd, 'codex-native-A', 'PreToolUse');
        const r = (await invoke(cwd, roleIntentArgs('architect', 'codex-native-A'))).json as Receipt;
        assert.equal(r.ok, true);
      });
      // A foreign process selects session A by environment while the usable pointer is A's
      // session.json — but resumes from a DIFFERENT workspace is simulated by pointing the
      // env at A while attempting to bind a foreign leader thread.
      process.env.OMX_SESSION_ID = 'codex-native-A';
      const foreign = (await invoke(cwd, roleIntentArgs('architect', 'attacker-thread'))).json as { ok: boolean; reason?: string };
      assert.equal(foreign.ok, false);
      assert.equal(foreign.reason, 'native_anchor_mismatch');
    } finally {
      if (prior === undefined) delete process.env.OMX_SESSION_ID;
      else process.env.OMX_SESSION_ID = prior;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('malformed/corrupt durable tracker on resume fails closed (native_anchor_unavailable) and never overwrites the evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-recover-malformed-'));
    await withFreshEnv(async () => {
      try {
        const sessionId = 'codex-native-malformed';
        await seedAuthenticatedLeader(cwd, sessionId, 'PreToolUse');
        (await invoke(cwd, roleIntentArgs('architect', sessionId))).json as Receipt;
        // Corrupt the durable tracker. Per FR-20 the malformed evidence must not be trusted:
        // the CLI strict-reads it and fails closed rather than reading it as empty and
        // overwriting it via the legacy path (which would erase leader/subagent evidence).
        const corrupt = '{ corrupt tracker not valid json';
        await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
        await writeFile(subagentTrackingPath(cwd), corrupt);

        // A spoofed parent AND the real native leader both fail closed on a corrupt tracker.
        const spoofed = (await invoke(cwd, roleIntentArgs('architect', 'attacker-thread'))).json as { ok: boolean; reason?: string };
        assert.deepEqual(spoofed, { ok: false, reason: 'native_anchor_unavailable' }, 'spoof on a corrupt tracker fails closed');
        const nativeLeader = (await invoke(cwd, roleIntentArgs('architect', sessionId))).json as { ok: boolean; reason?: string };
        assert.deepEqual(nativeLeader, { ok: false, reason: 'native_anchor_unavailable' }, 'even the native leader fails closed on a corrupt tracker');

        // The corrupt tracker is never overwritten (evidence preserved, not silently reset).
        assert.equal(await readFile(subagentTrackingPath(cwd), 'utf-8'), corrupt, 'corrupt tracker must not be overwritten');
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  });
});
