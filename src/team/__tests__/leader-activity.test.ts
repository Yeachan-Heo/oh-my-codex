import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isLeaderRuntimeStale,
  readLatestLeaderActivityMsFromStateDir,
  recordLeaderRuntimeActivity,
} from '../leader-activity.js';

async function withWindowsPlatform(run: () => Promise<void> | void): Promise<void> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await run();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  }
}

async function createWorktreePointerFixture(cwd: string): Promise<{ gitDir: string; commonDir: string }> {
  const gitDir = join(cwd, '.git-admin', 'worktrees', 'feature');
  const commonDir = join(cwd, '.git-admin');
  await mkdir(join(gitDir, 'logs'), { recursive: true });
  await mkdir(join(commonDir, 'logs', 'refs', 'heads'), { recursive: true });
  await mkdir(commonDir, { recursive: true });
  await writeFile(join(cwd, '.git'), `gitdir: ${relative(cwd, gitDir)}\n`);
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/worktree-branch\n');
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  await writeFile(join(gitDir, 'logs', 'HEAD'), 'old\n');
  await writeFile(join(commonDir, 'logs', 'refs', 'heads', 'worktree-branch'), 'new\n');
  await writeFile(join(commonDir, 'config'), '');
  return { gitDir, commonDir };
}

describe('leader runtime activity', () => {
  it('records team status activity with shared leader activity metadata', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-'));
    try {
      const nowIso = '2026-03-21T04:11:12.000Z';
      await recordLeaderRuntimeActivity(cwd, 'team_status', 'alpha', nowIso);

      const activity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'leader-runtime-activity.json'), 'utf-8')) as {
        last_activity_at?: string;
        last_team_status_at?: string;
        last_source?: string;
        last_team_name?: string;
      };

      assert.equal(activity.last_activity_at, nowIso);
      assert.equal(activity.last_team_status_at, nowIso);
      assert.equal(activity.last_source, 'team_status');
      assert.equal(activity.last_team_name, 'alpha');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses the newest runtime signal across hud and explicit leader activity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:05:00.000Z',
        last_source: 'team_status',
      }));

      const lastActivityMs = await readLatestLeaderActivityMsFromStateDir(stateDir);
      assert.equal(lastActivityMs, Date.parse('2026-03-21T04:05:00.000Z'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });



  it('treats the leader as active when any runtime signal is still fresh', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      const nowMs = Date.parse('2026-03-21T04:10:00.000Z');

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:09:50.000Z',
        last_source: 'team_status',
      }));

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, nowMs), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats the leader as stale only when every valid runtime signal is stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      const nowMs = Date.parse('2026-03-21T04:10:00.000Z');

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:05:00.000Z',
        last_source: 'team_status',
      }));

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, nowMs), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });



  it('treats recent leader-branch git movement as activity even when runtime timestamps are stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-git-'));
    try {
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
      await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });

      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:00:00.000Z',
        last_source: 'team_status',
      }));

      await writeFile(join(cwd, 'README.md'), 'hello world\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'leader progress'], { cwd, stdio: 'ignore' });

      const headMs = Number(execFileSync('git', ['show', '-s', '--format=%ct', 'HEAD'], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()) * 1000;

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, headMs + 5_000), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats worktree .git file pointers as recent branch activity on Windows', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-worktree-'));
    try {
      const { gitDir, commonDir } = await createWorktreePointerFixture(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:00:00.000Z',
        last_source: 'team_status',
      }));

      const staleMs = Date.parse('2026-03-21T04:00:00.000Z');
      const recentMs = Date.parse('2026-03-21T04:10:00.000Z');
      const staleDate = new Date(staleMs);
      const recentDate = new Date(recentMs);
      await utimes(join(gitDir, 'HEAD'), staleDate, staleDate);
      await utimes(join(gitDir, 'logs', 'HEAD'), staleDate, staleDate);
      await utimes(join(commonDir, 'logs', 'refs', 'heads', 'worktree-branch'), recentDate, recentDate);

      await withWindowsPlatform(async () => {
        assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, recentMs + 5_000), false);
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses absolute git-path results for real worktree reflogs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-worktree-real-'));
    const worktreePath = `${cwd}-wt`;
    try {
      execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
      await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
      execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], {
        cwd,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2026-03-21T04:00:00.000Z',
          GIT_COMMITTER_DATE: '2026-03-21T04:00:00.000Z',
        },
      });
      execFileSync('git', ['worktree', 'add', '-b', 'feature', worktreePath], { cwd, stdio: 'ignore' });

      const stateDir = join(worktreePath, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({
        last_turn_at: '2026-03-21T04:00:00.000Z',
      }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({
        last_activity_at: '2026-03-21T04:00:00.000Z',
        last_source: 'team_status',
      }));

      const headLogPath = execFileSync('git', ['rev-parse', '--git-path', 'logs/HEAD'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const branchLogPath = execFileSync('git', ['rev-parse', '--git-path', 'logs/refs/heads/feature'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      const staleMs = Date.parse('2026-03-21T04:00:00.000Z');
      const recentMs = Date.parse('2026-03-21T04:10:00.000Z');
      const staleDate = new Date(staleMs);
      const recentDate = new Date(recentMs);
      await utimes(headLogPath, staleDate, staleDate);
      await utimes(branchLogPath, recentDate, recentDate);

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, recentMs + 5_000), false);
    } finally {
      await rm(worktreePath, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats missing or invalid runtime evidence as not stale', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-leader-activity-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, Date.now()), false);

      await writeFile(join(stateDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'not-a-date' }));
      await writeFile(join(stateDir, 'leader-runtime-activity.json'), JSON.stringify({ last_activity_at: '' }));

      assert.equal(await isLeaderRuntimeStale(stateDir, 30_000, Date.now()), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
