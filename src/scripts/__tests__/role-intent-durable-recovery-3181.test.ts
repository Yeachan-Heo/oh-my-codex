import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
  bindPendingRoleIntentUnderLock,
  readSubagentTrackingState,
  readSubagentTrackingStateStrict,
  recordPendingRoleIntent,
  subagentTrackingPath,
} from '../../subagents/tracker.js';

const ARCHITECT_TOKEN = 'abcdef0123456789abcdef0123456789';
const CRITIC_TOKEN = '00112233445566778899aabbccddeeff';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3194-'));
  try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

describe('#3194 pending role-intent durability', () => {
  it('keeps Architect before Critic as distinct single-flight intents and preserves binding integrity', async () => {
    await withCwd(async (cwd) => {
      const architect = recordPendingRoleIntent(cwd, {
        role: 'architect', sessionId: 'synthetic-session', parentThreadId: 'synthetic-parent', correlationToken: ARCHITECT_TOKEN, nowMs: 0,
      });
      assert.equal(architect.ok, true);
      const critic = recordPendingRoleIntent(cwd, {
        role: 'critic', sessionId: 'synthetic-session', parentThreadId: 'synthetic-parent', correlationToken: CRITIC_TOKEN, nowMs: 0,
      });
      assert.deepEqual(critic, { ok: false, reason: 'single_flight_conflict' });
      const binding = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'synthetic-session', parentThreadId: 'synthetic-parent', correlationToken: ARCHITECT_TOKEN, nowMs: 1,
      }, (state) => state);
      assert.equal(binding?.role, 'architect');
      assert.equal(binding?.alreadyBound, false);
      const retry = bindPendingRoleIntentUnderLock(cwd, {
        sessionId: 'synthetic-session', parentThreadId: 'synthetic-parent', correlationToken: ARCHITECT_TOKEN, nowMs: 2,
      }, () => { throw new Error('an existing binding must not invoke the callback'); });
      assert.equal(retry?.alreadyBound, true);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 1);
      assert.equal(state.pending_role_intents[0]?.binding_state, 'bound');
      assert.equal(state.pending_role_intents[0]?.correlation_token, ARCHITECT_TOKEN);
    });
  });

  it('strictly rejects corrupt durable tracker bytes without mutation', async () => {
    await withCwd(async (cwd) => {
      const path = subagentTrackingPath(cwd);
      const corrupt = '{ synthetic corrupt tracker';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, corrupt);
      assert.deepEqual(await readSubagentTrackingStateStrict(cwd), { ok: false });
      assert.equal(await readFile(path, 'utf8'), corrupt);
    });
  });
});
