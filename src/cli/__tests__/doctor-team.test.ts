import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

function runOmx(
  cwd: string,
  argv: string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string; error?: string } {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'bin', 'omx.js');
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

      const res = runOmx(wd, ['doctor', '--team']);
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

      const res = runOmx(wd, ['doctor', '--team']);
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /delayed_status_lag/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prints orphan_tmux_session when tmux session exists without matching team state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-doctor-team-'));
    try {
      const fakeBin = join(wd, 'bin');
      await mkdir(fakeBin, { recursive: true });
      const tmuxPath = join(fakeBin, 'tmux');
      await writeFile(tmuxPath, '#!/bin/sh\nif [ "$1" = "list-sessions" ]; then echo "omx-team-orphan"; exit 0; fi\nexit 0\n');
      spawnSync('chmod', ['+x', tmuxPath], { encoding: 'utf-8' });

      const res = runOmx(wd, ['doctor', '--team'], { PATH: `${fakeBin}:${process.env.PATH || ''}` });
      if (shouldSkipForSpawnPermissions(res.error)) return;
      assert.equal(res.status, 1, res.stderr || res.stdout);
      assert.match(res.stdout, /orphan_tmux_session/);
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
