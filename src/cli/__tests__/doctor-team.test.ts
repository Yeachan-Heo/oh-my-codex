import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  const r = spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error?.message };
}

function shouldSkipForSpawnPermissions(err?: string): boolean {
  return typeof err === 'string' && /(EPERM|EACCES)/i.test(err);
}

async function createFakeTmuxBin(wd: string, script: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(tmuxPath, script);
  spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });
  return fakeBin;
}

describe('omx doctor --team', () => {
  it('exits non-zero and prints resume_blocker when team state references missing tmux session', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'alpha',
        tmux_session: 'omx-team-alpha',
      }));

      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /resume_blocker/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('warns without failing when a prompt worker pid is live but identity cannot be verified', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-prompt-'));
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false,
    });
    const sleeperPid = sleeper.pid ?? 0;

    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'prompt-alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'prompt-alpha',
        worker_launch_mode: 'prompt',
        tmux_session: 'prompt-team-alpha',
        workers: [{ name: 'worker-1', pid: sleeperPid }],
      }));
      await writeFile(join(teamRoot, 'manifest.v2.json'), JSON.stringify({
        name: 'prompt-alpha',
        policy: { worker_launch_mode: 'prompt' },
        tmux_session: 'prompt-team-alpha',
        workers: [{ name: 'worker-1', pid: sleeperPid }],
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# prompt-mode teams do not require tmux session checks\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /prompt_resume_unavailable/);
      assert.match(res.stdout, /prompt-alpha\/worker-1/);
      assert.match(res.stdout, new RegExp(String(sleeperPid)));
      assert.match(res.stdout, /cannot verify that the PID still belongs/);
      assert.match(res.stdout, /Results: 1 warnings, 0 failed/);
    } finally {
      if (sleeperPid > 0) {
        try {
          process.kill(sleeperPid, 'SIGKILL');
        } catch {
          // already exited
        }
      }
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit resume_blocker when tmux is unavailable', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'alpha');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'alpha',
        tmux_session: 'omx-team-alpha',
      }));

      const res = runOmx(wd, ['doctor', '--team'], { PATH: '' });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /resume_blocker/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints slow_shutdown when shutdown request is stale and ack missing', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const workerDir = join(wd, '.omx', 'state', 'team', 'beta', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team', 'beta', 'config.json'), JSON.stringify({
        name: 'beta',
        tmux_session: 'omx-team-beta',
      }));

      const requestedAt = new Date(Date.now() - 60_000).toISOString();
      await writeFile(join(workerDir, 'shutdown-request.json'), JSON.stringify({ requested_at: requestedAt }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /slow_shutdown/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints delayed_status_lag when worker is working and heartbeat is stale', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const workerDir = join(wd, '.omx', 'state', 'team', 'gamma', 'workers', 'worker-1');
      await mkdir(workerDir, { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'team', 'gamma', 'config.json'), JSON.stringify({
        name: 'gamma',
        tmux_session: 'omx-team-gamma',
      }));

      const lastTurnAt = new Date(Date.now() - 120_000).toISOString();
      await writeFile(join(workerDir, 'status.json'), JSON.stringify({ state: 'working', updated_at: new Date().toISOString() }));
      await writeFile(join(workerDir, 'heartbeat.json'), JSON.stringify({
        pid: 123,
        last_turn_at: lastTurnAt,
        turn_count: 10,
        alive: true,
      }));

      const fakeBin = await createFakeTmuxBin(wd, '#!/bin/sh\n# list-sessions success with no sessions\nexit 0\n');
      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /delayed_status_lag/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints orphan_tmux_session as warning when tmux session cannot be attributed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-orphan"; exit 0; fi\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /orphan_tmux_session/);
      assert.match(res.stdout, /possibly external project/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints stale_leader when HUD state is old and team tmux session is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'epsilon');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'epsilon',
        tmux_session: 'omx-team-epsilon',
      }));

      // Stale HUD state (leader inactive for 5 minutes)
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      }));

      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      // Fake tmux reports the team session exists
      await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-epsilon"; exit 0; fi\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit stale_leader when HUD state is fresh', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const teamRoot = join(wd, '.omx', 'state', 'team', 'zeta');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'zeta',
        tmux_session: 'omx-team-zeta',
      }));

      // Fresh HUD state (leader active 10 seconds ago)
      await writeFile(join(wd, '.omx', 'state', 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 10_000).toISOString(),
        turn_count: 20,
      }));

      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-zeta"; exit 0; fi\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.doesNotMatch(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit stale_leader when leader recently checked team status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const teamRoot = join(stateDir, 'team', 'eta');
      await mkdir(join(teamRoot, 'workers', 'worker-1'), { recursive: true });
      await writeFile(join(teamRoot, 'config.json'), JSON.stringify({
        name: 'eta',
        tmux_session: 'omx-team-eta',
      }));

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: new Date(Date.now() - 300_000).toISOString(),
        turn_count: 5,
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: new Date(Date.now() - 5_000).toISOString(),
        last_source: 'team_status',
        last_team_name: 'eta',
      }));

      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-eta"; exit 0; fi\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /stale_leader/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not emit orphan_tmux_session when tmux reports no server running', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(
        tmuxPath,
        '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "no server running on /tmp/tmux-1000/default" 1>&2; exit 1; fi\nexit 0\n',
      );
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.doesNotMatch(res.stdout, /orphan_tmux_session/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
