import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  initTeamState,
  readTeamConfig,
  readWorkerStatus,
  writeWorkerStatus,
  withScalingLock,
  writeAtomic,
} from '../state.js';
import { isScalingEnabled, scaleUp, scaleDown } from '../scaling.js';

// ── isScalingEnabled ──────────────────────────────────────────────────────────

describe('isScalingEnabled', () => {
  it('returns false when env var is not set', () => {
    assert.equal(isScalingEnabled({}), false);
  });

  it('returns false when env var is empty string', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '' }), false);
  });

  it('returns false when env var is "0"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '0' }), false);
  });

  it('returns false when env var is "false"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'false' }), false);
  });

  it('returns false when env var is "no"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'no' }), false);
  });

  it('returns true when env var is "1"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '1' }), true);
  });

  it('returns true when env var is "true"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'true' }), true);
  });

  it('returns true when env var is "yes"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'yes' }), true);
  });

  it('returns true when env var is "on"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'on' }), true);
  });

  it('returns true when env var is "enabled"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'enabled' }), true);
  });

  it('returns true case-insensitively', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'TRUE' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'Yes' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'ON' }), true);
  });

  it('returns true with leading/trailing whitespace', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '  1  ' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: ' true ' }), true);
  });
});

// ── WorkerStatus draining state ───────────────────────────────────────────────

describe('WorkerStatus draining state', () => {
  it('writeWorkerStatus writes draining status and readWorkerStatus reads it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-drain-'));
    try {
      await initTeamState('drain-test', 'task', 'executor', 2, cwd);
      const drainingStatus = {
        state: 'draining' as const,
        reason: 'scale_down requested',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus('drain-test', 'worker-1', drainingStatus, cwd);
      const status = await readWorkerStatus('drain-test', 'worker-1', cwd);
      assert.equal(status.state, 'draining');
      assert.equal(status.reason, 'scale_down requested');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns unknown for non-existent worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-nw-'));
    try {
      await initTeamState('nw-test', 'task', 'executor', 1, cwd);
      const status = await readWorkerStatus('nw-test', 'worker-99', cwd);
      assert.equal(status.state, 'unknown');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Monotonic worker index counter ────────────────────────────────────────────

describe('Monotonic worker index counter', () => {
  it('initTeamState sets next_worker_index to workerCount + 1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-idx-'));
    try {
      const cfg = await initTeamState('idx-test', 'task', 'executor', 3, cwd);
      assert.equal(cfg.next_worker_index, 4);

      // Verify on disk
      const diskCfg = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'idx-test', 'config.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(diskCfg.next_worker_index, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('next_worker_index is present in manifest.v2.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-manif-'));
    try {
      await initTeamState('manif-test', 'task', 'executor', 2, cwd);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'manif-test', 'manifest.v2.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(manifest.next_worker_index, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTeamConfig preserves next_worker_index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-read-'));
    try {
      await initTeamState('read-test', 'task', 'executor', 5, cwd);
      const config = await readTeamConfig('read-test', cwd);
      assert.ok(config);
      assert.equal(config.next_worker_index, 6);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── File-based scaling lock ───────────────────────────────────────────────────

describe('withScalingLock', () => {
  it('acquires and releases lock for successful operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-'));
    try {
      await initTeamState('lock-test', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', 'team', 'lock-test', '.lock.scaling');

      const result = await withScalingLock('lock-test', cwd, async () => {
        // Lock should exist during execution
        assert.equal(existsSync(lockDir), true);
        return 42;
      });

      assert.equal(result, 42);
      // Lock should be released after execution
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases lock even when function throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-err-'));
    try {
      await initTeamState('lock-err', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', 'team', 'lock-err', '.lock.scaling');

      await assert.rejects(
        withScalingLock('lock-err', cwd, async () => {
          throw new Error('test error');
        }),
        { message: 'test error' },
      );

      // Lock should be released after error
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-con-'));
    try {
      await initTeamState('lock-con', 'task', 'executor', 1, cwd);
      const order: number[] = [];

      // Launch two operations concurrently - second should wait for first
      const op1 = withScalingLock('lock-con', cwd, async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 100));
        order.push(2);
        return 'first';
      });

      // Small delay to ensure op1 acquires lock first
      await new Promise(r => setTimeout(r, 10));

      const op2 = withScalingLock('lock-con', cwd, async () => {
        order.push(3);
        return 'second';
      });

      const [r1, r2] = await Promise.all([op1, op2]);
      assert.equal(r1, 'first');
      assert.equal(r2, 'second');
      // First operation should complete (1, 2) before second starts (3)
      assert.deepEqual(order, [1, 2, 3]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── scaleUp / scaleDown error cases ──────────────────────────────────────────

describe('scaleUp', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleUp('test', 1, 'executor', [], '/tmp', {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error for invalid count', async () => {
    const result = await scaleUp(
      'test', 0, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error for negative count', async () => {
    const result = await scaleUp(
      'test', -1, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error when tmux is not available', async () => {
    // Temporarily remove PATH so tmux binary is not found
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await scaleUp(
        'test', 1, 'executor', [], '/tmp',
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /tmux is not available/);
      }
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
    }
  });
});

describe('scaleDown', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleDown('test', '/tmp', {}, {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error when team not found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-nf-'));
    try {
      const result = await scaleDown(
        'nonexistent', cwd, {},
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when trying to remove all workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-all-'));
    try {
      await initTeamState('all-test', 'task', 'executor', 1, cwd);
      const result = await scaleDown(
        'all-test', cwd,
        { workerNames: ['worker-1'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /at least 1 must remain/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error for worker not in team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-miss-'));
    try {
      await initTeamState('miss-test', 'task', 'executor', 2, cwd);
      const result = await scaleDown(
        'miss-test', cwd,
        { workerNames: ['worker-99'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Worker worker-99 not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when not enough idle workers and force=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-busy-'));
    try {
      await initTeamState('busy-test', 'task', 'executor', 2, cwd);
      // Write working status for both workers
      await writeWorkerStatus('busy-test', 'worker-1', {
        state: 'working',
        current_task_id: 't-1',
        updated_at: new Date().toISOString(),
      }, cwd);
      await writeWorkerStatus('busy-test', 'worker-2', {
        state: 'working',
        current_task_id: 't-2',
        updated_at: new Date().toISOString(),
      }, cwd);
      const result = await scaleDown(
        'busy-test', cwd,
        { count: 1 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Not enough idle workers/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
