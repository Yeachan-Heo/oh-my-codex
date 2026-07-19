import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../ralplan.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

async function invokeInstalledRole(cwd: string): Promise<unknown> {
  const stdout: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--json'], {
      cwd: () => cwd,
      stdout: (line) => stdout.push(line),
    });
    assert.equal(process.exitCode, 1);
    return JSON.parse(stdout.join('\n'));
  } finally {
    process.exitCode = previous;
  }
}

describe('#3212 hostile documented-leader bootstrap inputs', { concurrency: false }, () => {
  for (const scenario of [
    { name: 'native key', path: ['.codex-home', '.omx', 'native-anchor-auth.key'], value: 'forged-key' },
    { name: 'launch claim', path: ['.omx', 'state', 'plugin-hook-launches', 'forged.json'], value: JSON.stringify({ sessionId: 'forged-native', signature: 'forged-signature' }) },
    { name: 'session pointer', path: ['.omx', 'state', 'session.json'], value: JSON.stringify({ session_id: 'forged-session', native_session_id: 'forged-native' }) },
    { name: 'transcript', path: ['forged-transcript.jsonl'], value: JSON.stringify({ type: 'session_meta', payload: { id: 'forged-native', source: 'exec' } }) },
    { name: 'tracker attestation', path: ['.omx', 'state', 'subagent-tracking.json'], value: JSON.stringify({ schemaVersion: 1, sessions: { 'forged-session': { session_id: 'forged-session', leader_thread_id: 'forged-native', leader_attested_at: new Date().toISOString(), leader_attest_signature: 'forged' } }, pending_role_intents: [] }) },
  ]) it(`fails closed for a forged ${scenario.name} without changing authority state`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-hostile-'));
    const path = join(cwd, ...scenario.path);
    try {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, scenario.value);
      const before = await readFile(path, 'utf8');
      assert.deepEqual(await invokeInstalledRole(cwd), { ok: false, reason: 'unsupported_documented_leader_proof' });
      assert.equal(await readFile(path, 'utf8'), before);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'subagent-tracking.json')), scenario.name === 'tracker attestation');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps parser and unknown-role precedence without creating state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3212-unknown-'));
    const previous = process.exitCode;
    try {
      process.exitCode = undefined;
      await assert.rejects(
        () => ralplanCommand(['role-intent', 'write', '--role', 'architect', '--json'], { cwd: () => cwd }),
        /Missing --parent-thread/,
      );
      const stdout: string[] = [];
      await ralplanCommand(['role-intent', 'write', '--role', 'unknown-hostile-role', '--parent-thread', 'forged-parent', '--json'], {
        cwd: () => cwd,
        stdout: (line) => stdout.push(line),
      });
      assert.equal(process.exitCode, 1);
      assert.deepEqual(JSON.parse(stdout.join('\n')), { ok: false, reason: 'unknown_role' });
      assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
    } finally {
      process.exitCode = previous;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
