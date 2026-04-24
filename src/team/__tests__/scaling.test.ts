import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  initTeamState,
  createTask,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  readWorkerStatus,
  writeWorkerStatus,
  withScalingLock,
  DEFAULT_MAX_WORKERS,
} from '../state.js';
import { isScalingEnabled, scaleUp, scaleDown } from '../scaling.js';

delete process.env.OMX_TEAM_STATE_ROOT;

async function initCommittedGitRepo(cwd: string): Promise<void> {
  execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'OMX Test'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'omx@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-worktree-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

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


  it('persists scaled-up task roles in canonical task state and inbox ids', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '\%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    echo "42424"',
          '    ;;',
          '  send-keys)',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-role', 'task', 'executor', 1, cwd);
      await createTask('scale-up-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-role';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-role',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const createdTask = await readTask('scale-up-role', '2', cwd);
      assert.equal(createdTask?.role, 'writer');
      assert.equal(createdTask?.owner, 'worker-2');

      const workerIdentity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'identity.json'), 'utf-8')) as { role?: string };
      assert.equal(workerIdentity.role, 'writer');

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Task 2/);
      assert.match(inbox, /Role: writer/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('removes generated worktree-root AGENTS when scale-up rolls back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  send-keys)
    exit 1
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('rollback-worktree', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('rollback-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-rollback-worktree';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'rollback-worktree', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'rollback-worktree',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_dispatch_failed:worker-2/);

      const workerRootAgents = join(cwd, '.omx', 'team', 'rollback-worktree', 'worktrees', 'worker-2', 'AGENTS.md');
      assert.equal(await readFile(workerRootAgents, 'utf-8'), '# Root project instructions\n');
      const backupPath = join(cwd, '.git', 'worktrees', 'worker-2', 'omx', 'root-agents-backup.json');
      assert.equal(existsSync(backupPath), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('uses canonical root AGENTS bootstrap for scaled worktree workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('canonical-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('canonical-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-canonical-root';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'canonical-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'canonical-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.4-mini',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'canonical-root', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.doesNotMatch(inbox, /## Your Specialization/);
      assert.match(inbox, /\*\*Role:\*\* writer/);

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'canonical-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.match(rootAgents, /exact gpt-5\.4-mini model/);
      assert.match(rootAgents, /strict execution order: inspect -> plan -> act -> verify/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up when the final worker model is gpt-5.5', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'test-engineer.md'), '<identity>Test Engineer</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'frontier-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('frontier-role', 'task', 'executor', 1, cwd);
      await createTask('frontier-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('frontier-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-frontier-role';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'frontier-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'frontier-role',
        1,
        'executor',
        [{ subject: 'test routing report only', description: 'test routing report only', owner: 'worker-2', role: 'test-engineer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*test-engineer\*\* role/);
      assert.match(workerAgents, /<identity>Test Engineer<\/identity>/);
      assert.doesNotMatch(workerAgents, /exact gpt-5\.4-mini model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up for gpt-5.4-mini-tuned overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('mini-tuned-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('mini-tuned-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-mini-tuned-root';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'mini-tuned-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'mini-tuned-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.4-mini-tuned',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'mini-tuned-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.doesNotMatch(rootAgents, /exact gpt-5\.4-mini model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves leader/HUD layout by avoiding tiled relayout during scale-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-up-layout', 'task', 'executor', 1, cwd);

      const config = await readTeamConfig('scale-up-layout', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-layout';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-layout', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-layout',
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /split-window -v -t %21/);
      assert.doesNotMatch(tmuxLog, /select-layout .*tiled/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions detached worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-detached-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  list-panes)',
          '    echo "45454"',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-detached-worktree';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: true, name: null },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: true, name: null });
      assert.ok(worker?.worktree_path, 'scaled worker should have detached worktree path');
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, true);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.throws(
        () => execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, stdio: 'pipe' }),
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions named worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%42"',
          '    ;;',
          '  list-panes)',
          '    echo "46464"',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-named-worktree';
      const branchBase = 'feature/team-scale';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: false, name: branchBase },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: false, name: branchBase });
      assert.equal(worker?.worktree_branch, `${branchBase}/worker-2`);
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, false);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.equal(
        execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, encoding: 'utf-8' }).trim(),
        `${branchBase}/worker-2`,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
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


describe('scaleDown worktree AGENTS cleanup', () => {
  it('removes generated worktree-root AGENTS during scale-down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-worktree-agents-'));
    try {
      await initTeamState('scale-down-worktree', 'task', 'executor', 2, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const worktree = join(cwd, '.omx', 'team', 'scale-down-worktree', 'worktrees', 'worker-2');
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'AGENTS.md'), '# Tracked root instructions\n', 'utf8');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json'),
        JSON.stringify({ existed: true, tracked: false, previousContent: '# Tracked root instructions\n' }, null, 2),
        'utf8',
      );
      await writeFile(join(worktree, 'AGENTS.md'), '# Generated runtime instructions\n', 'utf8');

      const config = await readTeamConfig('scale-down-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.worktree_path = worktree;
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'scale-down-worktree',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.equal(await readFile(join(worktree, 'AGENTS.md'), 'utf-8'), '# Tracked root instructions\n');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('scaleDown teardown hardening', () => {
  it('scaleDown removes workers when pane is already dead or missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-dead-'));
    try {
      await initTeamState('dead-pane', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('dead-pane', cwd);
      assert.ok(config);
      if (!config) return;

      config.workers[1]!.pane_id = '%404';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'dead-pane',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.removedWorkers, ['worker-2']);

      const updated = await readTeamConfig('dead-pane', cwd);
      assert.ok(updated);
      assert.equal(updated?.workers.some((worker) => worker.name === 'worker-2'), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('scaleDown never targets leader or hud panes during teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-exclusions-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-fake-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('exclusions', 'task', 'executor', 4, cwd);
      const config = await readTeamConfig('exclusions', cwd);
      assert.ok(config);
      if (!config) return;
      config.leader_pane_id = '%11';
      config.hud_pane_id = '%12';
      config.workers[0]!.pane_id = '%11';
      config.workers[1]!.pane_id = '%12';
      config.workers[2]!.pane_id = '%13';
      config.workers[3]!.pane_id = '%14';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'exclusions',
        cwd,
        { workerNames: ['worker-1', 'worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %12/);
      assert.match(tmuxLog, /kill-pane -t %13/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
