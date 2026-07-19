import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

 describe('#3212 ralplan authenticated anchor surface', () => {
  it('fails the explicit adapted-surface preflight and neutralizes routing-only Ralplan state', async () => {
    let resolved = false;
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      cancelRalplan: async () => { cancelled = true; },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(cancelled, true);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
  it('passes preflight when the current session has a durable attested leader', async () => {
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      cwd: () => '/tmp/omx-preflight-authenticated',
      cancelRalplan: async () => { cancelled = true; },
      resolveSessionScope: async () => ({ cwd: '/tmp/omx-preflight-authenticated', stateDir: '/tmp/omx-preflight-authenticated/.omx/state', sessionId: 'session', metadata: { sessionId: 'session' } }) as never,
      readTrackingState: async () => ({ ok: true, state: { schemaVersion: 1, sessions: { session: { session_id: 'session', leader_thread_id: 'leader', leader_attested_at: new Date().toISOString(), updated_at: new Date().toISOString(), threads: {} } }, pending_role_intents: [] } }),
      verifyLeaderAttestation: () => true,
    });
    assert.equal(result.exitCode, undefined);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: true, session_id: 'session', leader_thread_id: 'leader' });
    assert.equal(cancelled, false);
  });
  it('fails preflight when the attested leader is also tracked as a subagent', async () => {
    let cancelled = false;
    const result = await invoke(['preflight', '--json'], {
      cwd: () => '/tmp/omx-preflight-collision',
      cancelRalplan: async () => { cancelled = true; },
      resolveSessionScope: async () => ({ cwd: '/tmp/omx-preflight-collision', stateDir: '/tmp/omx-preflight-collision/.omx/state', sessionId: 'session', metadata: { sessionId: 'session' } }) as never,
      readTrackingState: async () => ({ ok: true, state: { schemaVersion: 1, sessions: {
        session: { session_id: 'session', leader_thread_id: 'leader', leader_attested_at: new Date().toISOString(), updated_at: new Date().toISOString(), threads: {} },
        foreign: { session_id: 'foreign', updated_at: new Date().toISOString(), threads: { leader: { thread_id: 'leader', kind: 'subagent', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), turn_count: 1 } } },
      }, pending_role_intents: [] } }),
      verifyLeaderAttestation: () => true,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(cancelled, true);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('returns unknown_role for a syntactically valid uninstalled role', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'synthetic-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies installed roles without a current authenticated anchor', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'synthetic-parent', '--session', 'synthetic-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role.toLowerCase() === 'architect' ? 'architect' : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'native_anchor_unavailable' });
  });
});
