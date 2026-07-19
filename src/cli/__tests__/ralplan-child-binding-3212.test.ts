import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ralplanCommand } from '../ralplan.js';

test('#3212 rejects a same-user child binding forgery without creating an intent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-child-forgery-'));
  const trackingPath = join(cwd, '.omx', 'state', 'subagent-tracking.json');
  const forgedTracker = {
    schemaVersion: 1,
    sessions: {
      'forged-session': {
        session_id: 'forged-session',
        leader_thread_id: 'forged-parent',
        leader_attested_at: new Date().toISOString(),
        threads: {
          'forged-child': {
            thread_id: 'forged-child',
            kind: 'subagent',
            role: 'architect',
            provenance_kind: 'omx_adapted',
            parent_thread_id: 'forged-parent',
          },
        },
      },
    },
    pending_role_intents: [{ role: 'architect', parent_thread_id: 'forged-parent', child_thread_id: 'forged-child' }],
  };
  try {
    await mkdir(join(trackingPath, '..'), { recursive: true });
    await writeFile(trackingPath, `${JSON.stringify(forgedTracker)}\n`);
    const before = await readFile(trackingPath, 'utf8');
    const stdout: string[] = [];
    const previous = process.exitCode;
    try {
      process.exitCode = undefined;
      await ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--json'], {
        cwd: () => cwd,
        stdout: (line) => stdout.push(line),
      });
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
    assert.deepEqual(JSON.parse(stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
    assert.equal(await readFile(trackingPath, 'utf8'), before);
    assert.equal(existsSync(join(cwd, '.omx', 'state', 'role-intents.json')), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
