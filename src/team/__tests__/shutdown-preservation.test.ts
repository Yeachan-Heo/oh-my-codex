import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTeamState, saveTeamConfig, readTeamConfig } from '../state.js';
import { shutdownTeam } from '../runtime.js';
import { readTeamCommitHygieneLedger } from '../commit-hygiene.js';

async function seedGeneratedReport(worker: string, content: string): Promise<void> {
  await mkdir(join(worker, '.omx'), { recursive: true });
  await writeFile(join(worker, '.omx', 'diff.md'), content);
  const receipt = execFileSync('git', ['rev-parse', '--git-path', 'omx-shutdown-report.sha256'], { cwd: worker, encoding: 'utf8' }).trim();
  await writeFile(receipt, createHash('sha256').update(content).digest('hex'));
}

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
    { failure: 'signing', force: true, detached: true, hud: true },
  ];
  for (const { failure: failureKind, force, ignoreOmx = true, trackedReport = false, detached = false, hud = false } of scenarios) {
    it(`preserves work after ${failureKind} failure (force=${force}, ignoreOmx=${ignoreOmx}, detached=${detached}, hud=${hud}) and supports retry`, { skip: process.platform === 'win32' }, async () => {
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
            leader_pane_pid: 999999991,  // Non-live PID to avoid affecting unrelated processes
            hud_pane_id: hud ? '%2' : null,
            hud_pane_pid: hud ? 999999992 : undefined,  // Non-live PID to avoid affecting unrelated processes
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
      *'#{session_name}'*)
        printf '%%1\\t0\\t999999991\\tomx-team-preserve\\t$1\\t1700000000\\n'
        if [ -n "${hud ? '1' : ''}" ] && [ ! -f "${tmuxLogPath}.hud-killed" ]; then printf '%%2\\t0\\t999999992\\tomx-team-preserve\\t$1\\t1700000000\\n'; fi ;;
      *'-a -F #{pane_id}'*)
        printf '%%1\\t0\\t999999991\\n'
        if [ -n "${hud ? '1' : ''}" ] && [ ! -f "${tmuxLogPath}.hud-killed" ]; then printf '%%2\\t0\\t999999992\\n'; fi ;;
      *) exit 1 ;;
    esac ;;
  kill-pane)
    [ "$*" = 'kill-pane -t %2' ] || exit 1
    : > "${tmuxLogPath}.hud-killed" ;;
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
        if (failureKind === 'merge-conflict') {
          const ledger = await readTeamCommitHygieneLedger('preserve', repo);
          assert.ok(ledger.entries.some((entry) => entry.operation === 'shutdown_checkpoint' && entry.operational_commit === git('-C', worker, 'rev-parse', 'HEAD')));
        }
        if (detached) {
          assert.equal((await readTeamConfig('preserve', repo))?.tmux_session, 'omx-team-preserve');
          assert.equal(existsSync(`${tmuxLogPath}.killed`), false, 'preservation failure must precede detached-session destruction');
          assert.equal(existsSync(join(repo, '.omx', 'state', 'team', 'preserve', '.detached-session-destroy-receipt.json')), false);
        }
        if (hud) {
          assert.equal(existsSync(`${tmuxLogPath}.hud-killed`), true, 'the HUD pane is torn down before preservation');
          assert.equal((await readTeamConfig('preserve', repo))?.hud_pane_id, null, 'the gone HUD pane is not left in retained state');
        }

        if (!ignoreOmx && failureKind === 'merge-conflict') assert.equal(existsSync(join(worker, '.omx', 'diff.md')), true, 'merge failure retains a generated report for retry');
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
      await seedGeneratedReport(worker, 'generated report\n');
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

  it('handles git diff --cached properly when no changes remain after add (P2 4359805733)', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-git-diff-cached-'));
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
      git('config', 'user.name', 'Git Diff Test');
      git('config', 'user.email', 'gitdiff@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      await writeFile(join(repo, 'work.txt'), 'original\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      git('worktree', 'add', '--detach', worker, 'HEAD');
      
      const config = await initTeamState('gitdiff-test', 'git diff test', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt' });
      Object.assign(config.workers[0]!, {
        worktree_path: worker,
        worktree_repo_root: repo,
        worktree_created: true,
        worktree_detached: true,
      });
      await saveTeamConfig(config, repo);
      
      // Simulate a prior failed shutdown that left only a staged .omx/diff.md
      // This reproduces the Codex scenario where git add -A results in no changes to commit
      await mkdir(join(worker, '.omx'), { recursive: true });
      await seedGeneratedReport(worker, 'prior failed report\n');
      git('-C', worker, 'add', '.omx/diff.md');  // Stage the generated report
      
      // Removing the generated report leaves an empty index after git add -A.
      let firstFailure: unknown;
      try { await shutdownTeam('gitdiff-test', repo, { force: true }); } catch (error) { firstFailure = error; }
      
      // On 6c13b438 (without git diff --cached), this would fail with commit error.
      // On the current head (with git diff --cached), this should succeed because we check for changes first.
      assert.equal(firstFailure, undefined, 'shutdown should succeed even when only staged generated report remains');
      
      // Verify the shutdown succeeded and cleaned up
      assert.equal(existsSync(worker), false, 'worktree destroyed on shutdown');
      assert.equal(await readTeamConfig('gitdiff-test', repo), null, 'config removed on shutdown');
      assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'original\n', 'original state preserved');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('verifies prompt-mode worker pid is cleared before preservation (P1 4359237825)', { skip: process.platform === 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-prompt-pid-clear-'));
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
      git('config', 'user.name', 'Prompt PID Test');
      git('config', 'user.email', 'promptpid@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      await writeFile(join(repo, 'work.txt'), 'original\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      git('worktree', 'add', '--detach', worker, 'HEAD');
      
      const config = await initTeamState('promptpid-test', 'prompt PID test', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: 'prompt' });
      Object.assign(config.workers[0]!, {
        worktree_path: worker,
        worktree_repo_root: repo,
        worktree_created: true,
        worktree_detached: true,
        pid: 999999993,  // Non-live PID to avoid affecting unrelated processes
      });
      await saveTeamConfig(config, repo);
      await writeFile(join(worker, 'work.txt'), 'unique unsaved work\n');
      
      // Cause a preservation failure
      const indexLock = git('-C', worker, 'rev-parse', '--git-path', 'index.lock');
      await writeFile(indexLock, 'fixture lock');
      
      let failure: unknown;
      try { await shutdownTeam('promptpid-test', repo, { force: true }); } catch (error) { failure = error; }
      
      // First shutdown should fail
      assert.match(String(failure), /shutdown_worktree_preservation_failed/);
      
      // Verify worker pid was cleared in the persisted config
      const configAfterFirstShutdown = await readTeamConfig('promptpid-test', repo);
      assert.ok(configAfterFirstShutdown, 'config preserved after first shutdown');
      assert.equal(configAfterFirstShutdown.workers[0]?.pid, undefined, 'worker.pid must be cleared before preservation attempt');
      
      // Retry should succeed without reusing the old PID
      await rm(indexLock, { force: true });
      await shutdownTeam('promptpid-test', repo, { force: true });
      
      assert.equal(existsSync(worker), false);
      assert.equal(await readTeamConfig('promptpid-test', repo), null);
      assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'unique unsaved work\n');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withReviewFixture(run: (fixture: {
  root: string; repo: string; worker: string; bin: string;
  git: (...args: string[]) => string;
}) => Promise<void>, launchMode: 'prompt' | 'interactive' = 'prompt'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'omx-shutdown-review-'));
  const repo = join(root, 'repo');
  const worker = join(root, 'worker');
  const bin = join(root, 'bin');
  const previousPath = process.env.PATH;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    await mkdir(repo);
    await mkdir(bin);
    await writeFile(join(bin, 'omx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    git('init');
    git('config', 'user.name', 'Shutdown Review Test');
    git('config', 'user.email', 'shutdown@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(repo, '.gitignore'), '.env\n');
    await writeFile(join(repo, 'work.txt'), 'original\n');
    git('add', '.');
    git('commit', '-m', 'initial');
    git('worktree', 'add', '--detach', worker, 'HEAD');
    const config = await initTeamState('review', 'shutdown review', 'executor', 1, repo, undefined, { OMX_TEAM_WORKER_LAUNCH_MODE: launchMode });
    Object.assign(config.workers[0]!, { worktree_path: worker, worktree_repo_root: repo, worktree_created: true, worktree_detached: true });
    await saveTeamConfig(config, repo);
    await run({ root, repo, worker, bin, git });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

describe('remaining shutdown review regressions', { skip: process.platform === 'win32' }, () => {
  for (const ignored of [false, true]) {
    for (const phase of ['stage', 'receipt', 'publish', 'published', 'receipt-error']) {
      it(`recovers report publication interruption (${phase}, ignored=${ignored})`, async () => {
        await withReviewFixture(async ({ repo, worker, git }) => {
          if (ignored) {
            await writeFile(join(worker, '.gitignore'), '.env\n.omx/\n');
          }
          await writeFile(join(worker, 'work.txt'), 'preserved work\n');
          const report = join(worker, '.omx', 'diff.md');
          const receipt = git('-C', worker, 'rev-parse', '--git-path', 'omx-shutdown-report.sha256');
          const script = `
            import fs from 'node:fs';
            import { syncBuiltinESMExports } from 'node:module';
            const rename = fs.promises.rename;
            const link = fs.promises.link;
            const writeFile = fs.promises.writeFile;
            fs.promises.writeFile = async (path, data, ...options) => {
              if (${JSON.stringify(phase)} === 'stage' && String(path).startsWith(${JSON.stringify(`${receipt}.content.tmp.`)})) {
                await writeFile(path, String(data).slice(0, 10), ...options);
                process.exit(73);
              }
              return writeFile(path, data, ...options);
            };
            fs.promises.rename = async (src, dest) => {
              if (dest === ${JSON.stringify(receipt)} && ${JSON.stringify(phase)}.startsWith('receipt')) {
                if (${JSON.stringify(phase)} === 'receipt') process.exit(73);
                fs.writeFileSync(${JSON.stringify(join(worker, 'late.txt'))}, 'late work');
                throw Object.assign(new Error('receipt write failed'), { code: 'EIO' });
              }
              return rename(src, dest);
            };
            fs.promises.link = async (src, dest) => {
              if (dest === ${JSON.stringify(report)}) {
                if (${JSON.stringify(phase)} === 'publish') process.exit(73);
                await link(src, dest);
                if (${JSON.stringify(phase)} === 'published') process.exit(73);
                return;
              }
              return link(src, dest);
            };
            syncBuiltinESMExports();
            const { shutdownTeam } = await import(${JSON.stringify(new URL('../runtime.js', import.meta.url).href)});
            await shutdownTeam('review', ${JSON.stringify(repo)}, { force: true });
          `;
          assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          }), (error: unknown) => (error as { status: number }).status === (phase === 'receipt-error' ? 1 : 73));
          assert.equal(existsSync(report), phase === 'published');
          assert.equal(await readFile(join(repo, 'work.txt'), 'utf8'), 'preserved work\n');
          if (phase === 'published' && ignored) {
            const bytes = await readFile(report);
            await rm(report);
            await writeFile(report, bytes);
            await assert.rejects(shutdownTeam('review', repo, { force: true }), /shutdown_worktree_preservation_failed/);
            assert.deepEqual(await readFile(report), bytes, 'a replacement inode is user-owned even with identical bytes');
            await rm(report);
          }
          await shutdownTeam('review', repo, { force: true });
          assert.equal(existsSync(worker), false);
          assert.equal(git('log', '--all', '--oneline', '--', '.omx/diff.md'), '', 'generated reports never enter history');
          if (phase === 'receipt-error') assert.equal(await readFile(join(repo, 'late.txt'), 'utf8'), 'late work');
        });
      });
    }
  }

  for (const staged of [false, true]) {
    it(`preserves a user-authored report through staging failure and retry (staged=${staged})`, async () => {
      await withReviewFixture(async ({ repo, worker, git }) => {
        await mkdir(join(worker, '.omx'));
        await writeFile(join(worker, '.omx', 'diff.md'), 'user notes\n');
        if (staged) git('-C', worker, 'add', '.omx/diff.md');
        const indexLock = git('-C', worker, 'rev-parse', '--git-path', 'index.lock');
        await writeFile(indexLock, 'lock');
        await assert.rejects(shutdownTeam('review', repo, { force: true }), /shutdown_worktree_preservation_failed/);
        assert.equal(await readFile(join(worker, '.omx', 'diff.md'), 'utf8'), 'user notes\n');
        await rm(indexLock);
        await shutdownTeam('review', repo, { force: true });
        assert.equal(await readFile(join(repo, '.omx', 'diff.md'), 'utf8'), 'user notes\n');
      });
    });
  }

  it('preserves edits to a generated report instead of trusting its old receipt', async () => {
    await withReviewFixture(async ({ repo, worker }) => {
      await seedGeneratedReport(worker, 'generated\n');
      await writeFile(join(worker, '.omx', 'diff.md'), 'user added recovery notes\n');
      await shutdownTeam('review', repo, { force: true });
      assert.equal(await readFile(join(repo, '.omx', 'diff.md'), 'utf8'), 'user added recovery notes\n');
    });
  });

  for (const link of ['parent', 'report']) {
    for (const tracked of [false, true]) {
      it(`never writes through a ${link} symlink (tracked=${tracked})`, async () => {
        await withReviewFixture(async ({ root, repo, worker, git }) => {
          const external = join(root, 'external');
          await mkdir(external);
          await writeFile(join(external, 'diff.md'), 'external bytes\n');
          if (link === 'parent') await symlink(external, join(worker, '.omx'));
          else {
            await mkdir(join(worker, '.omx'));
            await symlink(join(external, 'diff.md'), join(worker, '.omx', 'diff.md'));
          }
          if (tracked) {
            git('-C', worker, 'add', '.omx');
            git('-C', worker, 'commit', '-m', 'tracked symlink');
          }
          await writeFile(join(worker, 'work.txt'), 'worker bytes\n');
          await assert.rejects(shutdownTeam('review', repo, { force: true }), /shutdown_worktree_preservation_failed/);
          assert.equal(await readFile(join(external, 'diff.md'), 'utf8'), 'external bytes\n');
          assert.equal(await readFile(join(worker, 'work.txt'), 'utf8'), 'worker bytes\n');
          assert.ok(await readTeamConfig('review', repo));
        });
      });
    }
  }

  it('retains ignored files without committing potentially secret data', async () => {
    await withReviewFixture(async ({ repo, worker, git }) => {
      await writeFile(join(worker, '.env'), 'SECRET=keep-local\n');
      await assert.rejects(shutdownTeam('review', repo, { force: true }), /shutdown_worktree_preservation_failed/);
      assert.equal(await readFile(join(worker, '.env'), 'utf8'), 'SECRET=keep-local\n');
      assert.equal(git('log', '--all', '--format=', '--name-only', '--', '.env'), '');
      assert.ok(await readTeamConfig('review', repo));
      await rm(join(worker, '.env'));
      await shutdownTeam('review', repo, { force: true });
      assert.equal(existsSync(worker), false);
    });
  });

  it('lets Git reject a write that arrives at the final worktree removal command', async () => {
    await withReviewFixture(async ({ repo, worker, bin }) => {
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      await writeFile(join(bin, 'git'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'worktree' && args[1] === 'remove') require('fs').writeFileSync(${JSON.stringify(join(worker, 'last.txt'))}, 'last write');
const r = require('child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
      await assert.rejects(shutdownTeam('review', repo, { force: true }), /worktree_rollback_failed/);
      assert.equal(await readFile(join(worker, 'last.txt'), 'utf8'), 'last write');
      assert.ok(await readTeamConfig('review', repo));
      await rm(join(bin, 'git'));
      await shutdownTeam('review', repo, { force: true });
      assert.equal(await readFile(join(repo, 'last.txt'), 'utf8'), 'last write');
    });
  });


});

describe('shutdown teardown progress', { skip: process.platform === 'win32' }, () => {
  for (const failure of ['kill', 'proof']) {
    it(`persists a removed shared pane before a later ${failure} failure and retries`, async () => {
      await withReviewFixture(async ({ repo, bin }) => {
        const config = await readTeamConfig('review', repo);
        assert.ok(config);
        Object.assign(config, { worker_launch_mode: 'interactive', tmux_session: 'leader:0', leader_pane_id: '%10', leader_pane_pid: 2000000010, hud_pane_id: null, tmux_pane_owner_id: 'owner-1' });
        Object.assign(config.workers[0]!, { pane_id: '%13', pid: 2000000013 });
        config.workers.push({ ...config.workers[0]!, name: 'worker-2', index: 2, pane_id: '%14', pid: 2000000014, worktree_path: undefined });
        config.workers.push({ ...config.workers[1]!, name: 'worker-3', index: 3, pane_id: '%15', pid: 2000000015 });
        config.worker_count = 3;
        await saveTeamConfig(config, repo);
        const log = join(bin, 'tmux.log');
        await writeFile(join(bin, 'tmux'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    case "$*" in
      *'-a -F #{pane_id}'*)
        printf '%%10\t0\t2000000010\n'
        [ -f '${log}.gone13' ] || printf '%%13\t0\t2000000013\n'
        if [ ! -f '${log}.gone14' ]; then
          if [ '${failure}' = proof ] && [ -f '${log}.gone13' ] && [ ! -f '${log}.retry' ]; then
            printf '%%14\t0\t2000000099\n'
          else printf '%%14\t0\t2000000014\n'; fi
        fi
        [ -f '${log}.gone15' ] || printf '%%15\t0\t2000000015\n'
        exit 0 ;;
      *'-t leader:0'*)
        printf '%%10\tzsh\tzsh\n'
        [ -f '${log}.gone13' ] || printf '%%13\tcodex\tenv OMX_TEAM_INTERNAL_WORKER=review/worker-1 codex\n'
        [ -f '${log}.gone14' ] || printf '%%14\tcodex\tenv OMX_TEAM_INTERNAL_WORKER=review/worker-2 codex\n'
        [ -f '${log}.gone15' ] || printf '%%15\tcodex\tenv OMX_TEAM_INTERNAL_WORKER=review/worker-3 codex\n'
        exit 0 ;;
      *) exit 1 ;;
    esac ;;
  show-option|show-options) echo owner-1 ;;
  kill-pane)
    if [ "$3" = '%13' ]; then : > '${log}.gone13';
    elif [ -f '${log}.retry' ]; then
      if [ "$3" = '%14' ]; then : > '${log}.gone14'; else : > '${log}.gone15'; fi;
    else exit 1; fi ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
        await assert.rejects(shutdownTeam('review', repo, { force: true }), /shutdown_.*(teardown_failed|proof_unavailable)/);
        const retained = await readTeamConfig('review', repo);
        assert.equal(retained?.workers[0]?.pane_id, undefined);
        assert.equal(retained?.workers[0]?.pid, undefined);
        assert.equal(retained?.workers[1]?.pane_id, '%14');
        assert.equal(retained?.workers[1]?.pid, 2000000014);
        assert.equal(retained?.workers[2]?.pane_id, '%15', 'an unattempted worker must retain its identity');
        assert.equal(retained?.workers[2]?.pid, 2000000015);
        await writeFile(`${log}.retry`, '1');
        await shutdownTeam('review', repo, { force: true });
        assert.equal(await readTeamConfig('review', repo), null);
        assert.equal((await readFile(log, 'utf8')).split('kill-pane -t %13').length - 1, 1);
      }, 'interactive');
    });
  }

  it('retries terminal cleanup after detached session destruction without changing its receipt identity', async () => {
    await withReviewFixture(async ({ repo, bin }) => {
      const config = await readTeamConfig('review', repo);
      assert.ok(config);
      Object.assign(config, { worker_launch_mode: 'interactive', tmux_session: 'omx-team-review', tmux_session_id: '$1', tmux_session_created: '1700000000', leader_pane_id: '%1', leader_pane_pid: 999999991, hud_pane_id: null, tmux_pane_owner_id: 'team:review' });
      config.workers[0]!.pane_id = '';
      config.workers[0]!.pid = undefined;
      await saveTeamConfig(config, repo);
      const mailbox = join(repo, '.omx', 'state', 'team', 'review', 'mailbox');
      const log = join(bin, 'tmux.log');
      await writeFile(join(bin, 'tmux'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  -V) echo 'tmux 3.4' ;;
  list-panes)
    [ ! -f '${log}.killed' ] || exit 0
    case "$*" in
      *'#{session_name}'*) printf '%%1\t0\t999999991\tomx-team-review\t$1\t1700000000\n' ;;
      *'-a -F #{pane_id}'*) printf '%%1\t0\t999999991\n' ;;
      *) exit 1 ;;
    esac ;;
  show-option|show-options) echo 'team:review' ;;
  list-sessions)
    [ ! -f '${log}.killed' ] || exit 0
    printf 'omx-team-review\t$1\t1700000000\n' ;;
  if-shell)
    case "\${6:-}" in
      'kill-session -t $1')
        : > '${log}.killed'
        rm -rf '${mailbox}'
        printf 'block mailbox retirement' > '${mailbox}' ;;
      *) exit 1 ;;
    esac ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
      await assert.rejects(shutdownTeam('review', repo, { force: true }), /retireTeamMailboxMessages/);
      assert.equal((await readTeamConfig('review', repo))?.tmux_session, 'omx-team-review');
      await rm(mailbox);
      await mkdir(mailbox);
      await shutdownTeam('review', repo, { force: true });
      assert.equal(await readTeamConfig('review', repo), null);
      assert.equal((await readFile(log, 'utf8')).split('if-shell -F -t %1').length - 1, 1);
    }, 'interactive');
  });
});
