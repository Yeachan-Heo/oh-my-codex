import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  bindTeamWorkerNativeSession,
  teamWorkerNativeSessionBindingPath,
  type TeamWorkerNativeSessionBinding,
} from '../worker-capability.js';

describe('Team worker native session binding', () => {
  it('does not recreate a worker directory removed by rollback', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'omx-worker-binding-rollback-'));
    const binding: TeamWorkerNativeSessionBinding = {
      version: 1,
      team_name: 'rollback-team',
      worker_name: 'worker-1',
      native_session_id: 'worker-native',
      leader_session_id: 'leader-native',
      team_created_at: new Date().toISOString(),
      worker_cwd: stateRoot,
      team_state_root: stateRoot,
      capability_sha256: 'capability',
      bound_at: new Date().toISOString(),
    };
    const bindingPath = teamWorkerNativeSessionBindingPath(stateRoot, binding.team_name, binding.worker_name);
    const workerDir = dirname(bindingPath);
    await mkdir(workerDir, { recursive: true });
    await rm(workerDir, { recursive: true });

    try {
      const result = await bindTeamWorkerNativeSession(stateRoot, binding);
      assert.equal(result, null);
      assert.equal(existsSync(workerDir), false);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
