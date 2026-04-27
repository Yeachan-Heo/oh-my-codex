import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveCanonicalTeamStateRoot,
  resolveWorkerNotifyTeamStateRoot,
  resolveWorkerNotifyTeamStateRootPath,
  resolveWorkerTeamStateRoot,
  resolveWorkerTeamStateRootPath,
} from '../state-root.js';
import { resolveTeamStateDirForWorker } from '../../scripts/notify-hook/team-worker.js';

describe('state-root', () => {
  it('resolveCanonicalTeamStateRoot resolves to leader .omx/state', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {}),
      '/tmp/demo/project/.omx/state',
    );
  });

  it('prefers OMX_TEAM_STATE_ROOT when present', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '/tmp/shared/team-state',
      }),
      '/tmp/shared/team-state',
    );
  });

  it('resolves relative OMX_TEAM_STATE_ROOT from the leader cwd', () => {
    assert.equal(
      resolveCanonicalTeamStateRoot('/tmp/demo/project', {
        OMX_TEAM_STATE_ROOT: '../shared/state',
      }),
      '/tmp/demo/shared/state',
    );
  });



  async function writeTeamMetadata(
    stateRoot: string,
    teamName: string,
    filename: 'config.json' | 'manifest.v2.json',
    workers: Array<{ name: string }>,
    extra: Record<string, unknown> = {},
  ) {
    const teamDir = join(stateRoot, 'team', teamName);
    await mkdir(teamDir, { recursive: true });
    await writeFile(join(teamDir, filename), JSON.stringify({
      name: teamName,
      workers,
      ...extra,
    }, null, 2));
  }

  async function writeIdentity(
    stateRoot: string,
    teamName: string,
    workerName: string,
    worktreePath: string,
    teamStateRoot: string = stateRoot,
  ) {
    const workerDir = join(stateRoot, 'team', teamName, 'workers', workerName);
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, 'identity.json'), JSON.stringify({
      name: workerName,
      index: 1,
      role: 'executor',
      assigned_tasks: ['1'],
      worktree_path: worktreePath,
      team_state_root: teamStateRoot,
    }, null, 2));
  }

  it('resolves worker root from OMX_TEAM_STATE_ROOT only when identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-env-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    assert.equal(
      await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: stateRoot,
      }),
      stateRoot,
    );

    const rejected = await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-2' }, {
      OMX_TEAM_STATE_ROOT: stateRoot,
    });
    assert.equal(rejected, null);
  });

  it('resolves from leader cwd state root when worker identity validates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-leader-'));
    const leader = join(root, 'leader');
    const worktree = join(root, 'worker');
    const stateRoot = join(leader, '.omx', 'state');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_LEADER_CWD: leader,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'leader_cwd');
  });

  it('allows cwd .omx/state only when identity exists and worktree path matches cwd', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'omx-state-root-cwd-'));
    const stateRoot = join(worktree, '.omx', 'state');
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {});
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, stateRoot);
    assert.equal(resolved.source, 'cwd');
  });



  it('resolves non-git worker notify root from identity metadata without probing local cwd state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-'));
    const leader = join(root, 'leader');
    const leaderHintRoot = join(leader, '.omx', 'state');
    const canonicalStateRoot = join(root, 'canonical-state');
    const worktree = join(root, 'worker');
    await mkdir(worktree, { recursive: true });
    await writeIdentity(leaderHintRoot, 'team-a', 'worker-1', worktree, canonicalStateRoot);
    await writeIdentity(canonicalStateRoot, 'team-a', 'worker-1', worktree);

    const resolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_LEADER_CWD: leader,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.stateRoot, canonicalStateRoot);
    assert.equal(resolved.source, 'identity_metadata');
  });



  it('accepts non-git worker notify roots with canonical markers but no identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-markers-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(join(stateRoot, 'team', 'team-a', 'workers', 'worker-1'), { recursive: true });
    await mkdir(worktree, { recursive: true });

    const workerDirResolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_STATE_ROOT: stateRoot,
    });
    assert.equal(workerDirResolved.ok, true);
    assert.equal(workerDirResolved.stateRoot, stateRoot);
    assert.equal(workerDirResolved.source, 'worker_directory');

    const configStateRoot = join(root, 'config-state');
    await writeTeamMetadata(configStateRoot, 'team-a', 'config.json', [{ name: 'worker-2' }]);
    const configResolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-2' }, {
      OMX_TEAM_STATE_ROOT: configStateRoot,
    });
    assert.equal(configResolved.ok, true);
    assert.equal(configResolved.stateRoot, configStateRoot);
    assert.equal(configResolved.source, 'config_metadata');

    const manifestStateRoot = join(root, 'manifest-state');
    await writeTeamMetadata(manifestStateRoot, 'team-a', 'manifest.v2.json', [{ name: 'worker-3' }]);
    const manifestResolved = await resolveWorkerNotifyTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-3' }, {
      OMX_TEAM_STATE_ROOT: manifestStateRoot,
    });
    assert.equal(manifestResolved.ok, true);
    assert.equal(manifestResolved.stateRoot, manifestStateRoot);
    assert.equal(manifestResolved.source, 'manifest_metadata');
  });

  it('rejects non-git worker notify roots without a matching canonical marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-reject-markers-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worktree');
    await mkdir(stateRoot, { recursive: true });
    await mkdir(worktree, { recursive: true });

    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: stateRoot,
      }),
      null,
    );

    const wrongTeamRoot = join(root, 'wrong-team');
    await writeTeamMetadata(wrongTeamRoot, 'team-a', 'config.json', [{ name: 'worker-1' }], { name: 'other-team' });
    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: wrongTeamRoot,
      }),
      null,
    );

    const missingWorkerRoot = join(root, 'missing-worker');
    await writeTeamMetadata(missingWorkerRoot, 'team-a', 'config.json', [{ name: 'worker-2' }]);
    await writeTeamMetadata(missingWorkerRoot, 'team-a', 'manifest.v2.json', [{ name: 'worker-3' }]);
    assert.equal(
      await resolveWorkerNotifyTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: missingWorkerRoot,
      }),
      null,
    );
  });

  it('does not guess cwd .omx/state for non-git worker notify resolution', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-no-cwd-'));
    const stateRoot = join(worktree, '.omx', 'state');
    await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

    const notifyResolved = await resolveWorkerNotifyTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {});
    assert.equal(notifyResolved, null);

    const postToolUseResolved = await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {});
    assert.equal(postToolUseResolved, stateRoot);
  });



  it('notify-hook worker state resolution reuses the non-git resolver', async () => {
    const previousStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const previousLeaderCwd = process.env.OMX_TEAM_LEADER_CWD;
    try {
      delete process.env.OMX_TEAM_STATE_ROOT;
      delete process.env.OMX_TEAM_LEADER_CWD;
      const worktree = await mkdtemp(join(tmpdir(), 'omx-state-root-notify-reuse-'));
      const stateRoot = join(worktree, '.omx', 'state');
      await writeIdentity(stateRoot, 'team-a', 'worker-1', worktree);

      assert.equal(
        await resolveTeamStateDirForWorker(worktree, { teamName: 'team-a', workerName: 'worker-1' }),
        null,
      );
    } finally {
      if (typeof previousStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      if (typeof previousLeaderCwd === 'string') process.env.OMX_TEAM_LEADER_CWD = previousLeaderCwd;
      else delete process.env.OMX_TEAM_LEADER_CWD;
    }
  });

  it('rejects missing identity, ambiguous root, and worktree mismatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-state-root-reject-'));
    const stateRoot = join(root, 'state');
    const worktree = join(root, 'worker');
    const otherWorktree = join(root, 'other-worker');
    await mkdir(worktree, { recursive: true });
    await mkdir(otherWorktree, { recursive: true });

    assert.equal(
      await resolveWorkerTeamStateRootPath(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
        OMX_TEAM_STATE_ROOT: stateRoot,
      }),
      null,
    );

    await writeIdentity(stateRoot, 'team-a', 'worker-1', otherWorktree);
    const mismatch = await resolveWorkerTeamStateRoot(worktree, { teamName: 'team-a', workerName: 'worker-1' }, {
      OMX_TEAM_STATE_ROOT: stateRoot,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'identity_worktree_mismatch');
  });
});
