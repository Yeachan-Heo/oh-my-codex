import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTeamState, saveTeamConfig, readTeamConfig } from '../state.js';
import { shutdownTeam } from '../runtime.js';

// No live workers: temporary repositories with prompt configs or a mocked detached tmux session.
describe('shutdown worktree preservation', () => {
  const scenarios = [
    { failure: 'signing', force: false },
    { failure: 'signing', force: true },
    { failure: 'git-add', force: true },
    { failure: 'merge-conflict', force: true },
    { failure: 'status', force: true },
    { failure: 'late-write', force: true },
    { failure: 'merge-conflict', force: true, ignoreOmx: false },
    { failure: 'late-write', force: true, ignoreOmx: false },
    { failure: 'signing', force: true, trackedReport: true },
    { failure: 'status', force: true, trackedReport: true },
    { failure: 'signing', force: true, detached: true },
    { failure: 'merge-conflict', force: true, detached: true },
    { failure: 'late-write', force: true, detached: true },
  ];
  for (const { failure: failureKind, force, ignoreOmx = true, trackedReport = false, detached = false } of scenarios) {
    it(`preserves work after ${failureKind} failure (force=${force}, ignoreOmx=${ignoreOmx}, detached=${detached}) and supports retry`, { skip: process.platform === 'win32' }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-shutdown-preservation-'));
      const repo = join(root, 'repo');
      const worker = join(root, 'worker');
      const previousPath = process.env.PATH;
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      try {
        await mkdir(repo);
        const bin = join(root, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
        git('init');
        git('config', 'user.name', 'Shutdown Test');
        git('config', 'user.email', 'shutdown@example.invalid');
        git('config', 'commit.gpgsign', 'false');
        if (ignoreOmx && !trackedReport) await writeFile(join(repo, '.gitignore'), '.omx/\n');
        await writeFile(join(repo, 'work.txt'), 'original\n');
        git('add', '.');
        git('commit', '-m', 'initial');
        if (trackedReport) {
          await mkdir(join(repo, '.omx'));
          await writeFile(join(repo, '.omx', 'diff.md'), 'tracked report\n');
          git('add', '.omx/diff.md');
          git('commit', '-m', 'add tracked report');
        }
        git('worktree', 'add', '--detach', worker, 'HEAD');
        const config = await initTeamState('preserve', 'shutdown safety', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: detached ? 'interactive' : 'prompt' });
        Object.assign(config.workers[0]!, {
          worktree_path: worker,
          worktree_repo_root: repo,
          worktree_created: true,
          worktree_detached: true,
        });
        const tmuxLogPath = join(bin, 'tmux.log');
        if (detached) {
          Object.assign(config, {
            tmux_session: 'omx-team-preserve',
            tmux_session_id: '$1',
            tmux_session_created: '1700000000',
            leader_pane_id: '%1',
            leader_pane_pid: 4241,
            hud_pane_id: null,
            tmux_pane_owner_id: 'team:preserve',
          });
          config.workers[0]!.pane_id = '';
          config.workers[0]!.pid = undefined;
          await writeFile(join(bin, 'tmux'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    [ ! -f "${tmuxLogPath}.killed" ] || exit 0
    case "$*" in
      *'#{session_name}'*) printf '%%1\\t0\\t4241\\tomx-team-preserve\\t$1\\t1700000000\\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\\t0\\t4241\\n' ;;
      *) exit 1 ;;
    esac ;;
  show-option|show-options) echo 'team:preserve' ;;
  list-sessions)
    [ ! -f "${tmuxLogPath}.killed" ] || exit 0
    printf 'omx-team-preserve\\t$1\\t1700000000\\n' ;;
  if-shell)
    case "\${6:-}" in
      'kill-session -t $1') : > "${tmuxLogPath}.killed" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
        }
        await saveTeamConfig(config, repo);
        await writeFile(join(worker, 'work.txt'), 'unique unsaved work\n');
        const indexLock = git('-C', worker, 'rev-parse', '--git-path', 'index.lock');
        if (failureKind === 'signing') {
          git('config', 'commit.gpgsign', 'true');
          git('config', 'gpg.program', join(root, 'missing-signing-program'));
        } else if (failureKind === 'git-add') {
          await writeFile(indexLock, 'fixture lock');
        } else if (failureKind === 'merge-conflict') {
          await writeFile(join(repo, 'work.txt'), 'leader change\n');
          git('add', 'work.txt');
          git('commit', '-m', 'conflicting leader change');
        } else if (failureKind === 'status') {
          const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
          await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst fs = require('fs');\nif (process.argv[2] === 'status' && process.cwd() === fs.realpathSync(${JSON.stringify(worker)})) process.exit(1);\nconst r = require('child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'});\nprocess.exit(r.status ?? 1);\n`, { mode: 0o755 });
        } else {
          await writeFile(join(bin, 'omx'), `#!${process.execPath}\nrequire('fs').writeFileSync('late.txt', 'written after checkpoint');\nprocess.exit(1);\n`, { mode: 0o755 });
        }

        let failure: unknown;
        try { await shutdownTeam('preserve', repo, { force }); } catch (error) { failure = error; }
        assert.equal(existsSync(worker), true, 'failed preservation must not delete the worker worktree');
        assert.equal(await readFile(join(worker, 'work.txt'), 'utf8'), 'unique unsaved work\n');
        assert.ok(await readTeamConfig('preserve', repo), 'keep recovery state for retry');
        assert.match(String(failure), /shutdown_worktree_preservation_failed/);
        if (detached) {
          assert.equal((await readTeamConfig('preserve', repo))?.tmux_session, 'omx-team-preserve');
          assert.equal(existsSync(`${tmuxLogPath}.killed`), false, 'preservation failure must precede detached-session destruction');
          assert.equal(existsSync(join(repo, '.omx', 'state', 'team', 'preserve', '.detached-session-destroy-receipt.json')), false);
        }

        if (!ignoreOmx && !trackedReport) assert.equal(existsSync(join(worker, '.omx', 'diff.md')), true, 'failed shutdown leaves a generated report for the retry');
        if (trackedReport) assert.equal(await readFile(join(worker, '.omx', 'diff.md'), 'utf8'), 'tracked report\n', 'tracked report is preserved when shutdown fails');
        if (failureKind === 'late-write') assert.equal(await readFile(join(worker, 'late.txt'), 'utf8'), 'written after checkpoint');
        await rm(join(bin, 'git'), { force: true });
        await rm(indexLock, { force: true });
        await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        git('config', 'commit.gpgsign', 'false');
        if (failureKind === 'merge-conflict') {
          await writeFile(join(repo, 'work.txt'), 'unique unsaved work\n');
          git('add', 'work.txt');
          git('commit', '-m', 'resolve shutdown conflict');
        }
        await shutdownTeam('preserve', repo, { force: true });
        assert.equal(existsSync(worker), false);
        assert.equal(await readTeamConfig('preserve', repo), null);
        if (detached) {
          const tmuxLog = await readFile(tmuxLogPath, 'utf8');
          assert.equal((tmuxLog.match(/if-shell -F -t %1/g) ?? []).length, 1, 'destroy the detached session exactly once');
          assert.equal(existsSync(`${tmuxLogPath}.killed`), true);
        }
        assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'unique unsaved work\n');
        if (failureKind === 'late-write') assert.equal(await readFile(join(repo, 'late.txt'), 'utf8'), 'written after checkpoint');
        if (!trackedReport) {
          assert.equal(git('log', '--all', '--format=', '--name-only', '--', '.omx/diff.md'), '', 'generated reports must never enter checkpoint or merge history');
        } else {
          assert.equal(await readFile(join(repo, '.omx', 'diff.md'), 'utf8'), 'tracked report\n', 'tracked report content is preserved after successful retry');
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

// Regression tests for review issues #3896
describe('shutdown preservation review fixes', () => {
  it('removes a staged generated report from retry checkpoints', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-report-provenance-'));
    const repo = join(root, 'repo');
    const worker = join(root, 'worker');
    const previousPath = process.env.PATH;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      await mkdir(repo);
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      git('init');
      git('config', 'user.name', 'Report Test');
      git('config', 'user.email', 'report@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      await writeFile(join(repo, '.gitignore'), '.omx/\n');
      await writeFile(join(repo, 'work.txt'), 'original\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      git('worktree', 'add', '--detach', worker, 'HEAD');
      const config = await initTeamState('report-test', 'report provenance test', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt' });
      Object.assign(config.workers[0]!, {
        worktree_path: worker,
        worktree_repo_root: repo,
        worktree_created: true,
        worktree_detached: true,
      });
      await saveTeamConfig(config, repo);
      // Scenario: generated report left by failed shutdown, then added to index by git add -A
      await mkdir(join(worker, '.omx'));
      await writeFile(join(worker, '.omx', 'diff.md'), 'generated report\n');
      await writeFile(join(worker, 'work.txt'), 'unique unsaved work\n');
      execFileSync('git', ['add', '-A'], { cwd: worker });
      // .omx is ignored, so explicitly stage the report to exercise index-vs-HEAD detection.
      git('-C', worker, 'add', '-f', '.omx/diff.md');
      assert.equal(git('-C', worker, 'ls-files', '--', '.omx/diff.md'), '.omx/diff.md');
      assert.equal(git('-C', worker, 'ls-tree', 'HEAD', '.omx/diff.md'), '');
      // An index lock prevents checkpointing on the first shutdown.
      const indexLock = git('-C', worker, 'rev-parse', '--git-path', 'index.lock');
      await writeFile(indexLock, 'fixture lock');
      let failure: unknown;
      try { await shutdownTeam('report-test', repo, { force: true }); } catch (error) { failure = error; }
      assert.equal(existsSync(worker), true, 'preservation failure keeps worktree');
      assert.ok(await readTeamConfig('report-test', repo), 'preservation failure keeps config');
      assert.match(String(failure), /shutdown_worktree_preservation_failed/);
      // The generated report should have been removed (not in HEAD), even though it was staged
      assert.equal(existsSync(join(worker, '.omx', 'diff.md')), false, 'generated report is removed (not in HEAD)');
      assert.equal(await readFile(join(worker, 'work.txt'), 'utf8'), 'unique unsaved work\n');
      // Retry succeeds
      await rm(indexLock, { force: true });
      await shutdownTeam('report-test', repo, { force: true });
      assert.equal(existsSync(worker), false);
      assert.equal(await readTeamConfig('report-test', repo), null);
      assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'unique unsaved work\n');
      assert.equal(git('log', '--all', '--format=', '--name-only', '--', '.omx/diff.md'), '', 'staged generated reports must not enter Git history');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects concurrent modifications to intentionally tracked reports (P2 4359237848)', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-tracked-report-'));
    const repo = join(root, 'repo');
    const worker = join(root, 'worker');
    const previousPath = process.env.PATH;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      await mkdir(repo);
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      process.env.PATH = `${bin}:${previousPath ?? ''}`;
      git('init');
      git('config', 'user.name', 'Tracked Report Test');
      git('config', 'user.email', 'tracked@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      await writeFile(join(repo, 'work.txt'), 'original\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      // Commit an intentionally tracked report
      await mkdir(join(repo, '.omx'));
      await writeFile(join(repo, '.omx', 'diff.md'), 'tracked report v1\n');
      git('add', '.omx/diff.md');
      git('commit', '-m', 'add tracked report');
      git('worktree', 'add', '--detach', worker, 'HEAD');
      const config = await initTeamState('tracked-test', 'tracked report test', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt' });
      Object.assign(config.workers[0]!, {
        worktree_path: worker,
        worktree_repo_root: repo,
        worktree_created: true,
        worktree_detached: true,
      });
      await saveTeamConfig(config, repo);
      await writeFile(join(worker, 'work.txt'), 'unique unsaved work\n');
      // Summary generation runs after checkpointing; modify the real tracked file then.
      await writeFile(join(bin, 'omx'), `#!${process.execPath}\nrequire('fs').writeFileSync('.omx/diff.md', 'tracked report v2\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
      await assert.rejects(
        () => shutdownTeam('tracked-test', repo, { force: true }),
        /shutdown_worktree_preservation_failed:.*:worktree changed or could not be verified/,
      );
      assert.equal(existsSync(worker), true, 'preservation failure keeps worktree');
      assert.ok(await readTeamConfig('tracked-test', repo), 'preservation failure keeps config');
      assert.equal(await readFile(join(worker, '.omx', 'diff.md'), 'utf8'), 'tracked report v2\n');
      assert.equal(git('-C', worker, 'show', 'HEAD:.omx/diff.md'), 'tracked report v1', 'late write was not checkpointed');
      assert.equal(git('-C', worker, 'status', '--porcelain', '--', '.omx/diff.md'), 'M .omx/diff.md');
      assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'unique unsaved work\n', 'checkpoint was merged before final verification');
      assert.equal(await readFile(join(repo, '.omx', 'diff.md'), 'utf8'), 'tracked report v1\n');

      await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      await shutdownTeam('tracked-test', repo, { force: true });
      assert.equal(existsSync(worker), false);
      assert.equal(await readTeamConfig('tracked-test', repo), null);
      assert.equal(await readFile(join(repo, '.omx', 'diff.md'), 'utf8'), 'tracked report v2\n', 'retry preserves the late write');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
