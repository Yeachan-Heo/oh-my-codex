import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ultragoalCommand, ULTRAGOAL_HELP } from '../ultragoal.js';

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-cli-'));
  const previous = process.cwd();
  try {
    process.chdir(cwd);
    return await run(cwd);
  } finally {
    process.chdir(previous);
    await rm(cwd, { recursive: true, force: true });
  }
}

async function capture(run: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[]; exitCode: string | number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  const log = mock.method(console, 'log', (...args: unknown[]) => stdout.push(args.map(String).join(' ')));
  const error = mock.method(console, 'error', (...args: unknown[]) => stderr.push(args.map(String).join(' ')));
  try {
    await run();
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    log.mock.restore();
    error.mock.restore();
    process.exitCode = previousExitCode;
  }
}

describe('cli/ultragoal', () => {
  it('prints help with artifact and goal-mode constraints', async () => {
    assert.match(ULTRAGOAL_HELP, /create-goals/);
    assert.match(ULTRAGOAL_HELP, /complete-goals/);
    assert.match(ULTRAGOAL_HELP, /blocked/);
    assert.match(ULTRAGOAL_HELP, /fresh Codex thread/);
    assert.match(ULTRAGOAL_HELP, /get_goal\/create_goal\/update_goal/);
  });

  it('creates and starts goals through the command surface', async () => {
    await withCwd(async (cwd) => {
      const created = await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone\n- Second milestone']));
      assert.equal(created.exitCode, undefined);
      assert.match(created.stdout.join('\n'), /ultragoal plan created: 2 goal/);

      const next = await capture(() => ultragoalCommand(['complete-goals']));
      const output = next.stdout.join('\n');
      assert.match(output, /Ultragoal active-goal handoff/);
      assert.match(output, /create_goal payload/);
      assert.match(output, /fresh Codex thread/);
      assert.match(output, /--status blocked/);
      assert.match(output, /omx ultragoal checkpoint --goal-id G001-first-milestone --status complete/);

      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { activeGoalId?: string };
      assert.equal(goals.activeGoalId, 'G001-first-milestone');
    });
  });

  it('checkpoints a goal and reports status as json', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const checkpoint = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', '{"goal":{"objective":"First milestone","status":"complete"}}',
        '--json',
      ]));
      assert.equal(checkpoint.exitCode, undefined);
      const parsed = JSON.parse(checkpoint.stdout.join('\n')) as { summary: { complete: number } };
      assert.equal(parsed.summary.complete, 1);
    });
  });

  it('requires matching complete Codex goal proof before completing a checkpoint', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));

      const missing = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
      ]));
      assert.equal(missing.exitCode, 1);
      assert.match(missing.stderr.join('\n'), /call get_goal/);

      const incomplete = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', '{"goal":{"objective":"First milestone","status":"active"}}',
      ]));
      assert.equal(incomplete.exitCode, 1);
      assert.match(incomplete.stderr.join('\n'), /not complete/);

      const mismatch = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', '{"goal":{"objective":"Different","status":"complete"}}',
      ]));
      assert.equal(mismatch.exitCode, 1);
      assert.match(mismatch.stderr.join('\n'), /objective mismatch/);
    });
  });

  it('records blocked legacy Codex-goal checkpoints as non-terminal', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));

      const blocked = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'blocked',
        '--evidence', 'completed aggregate Codex goal blocks create_goal',
        '--codex-goal-json', '{"goal":{"objective":"achieve all goals on this repo ultragoal status","status":"complete"}}',
        '--json',
      ]));

      assert.equal(blocked.exitCode, undefined);
      const parsed = JSON.parse(blocked.stdout.join('\n')) as { summary: { inProgress: number; failed: number }; plan: { activeGoalId?: string } };
      assert.equal(parsed.summary.inProgress, 1);
      assert.equal(parsed.summary.failed, 0);
      assert.equal(parsed.plan.activeGoalId, 'G001-first-milestone');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
    });
  });

  it('does not let blocked checkpoints bypass active Codex-goal mismatch protection', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));

      const blocked = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'blocked',
        '--evidence', 'active wrong goal',
        '--codex-goal-json', '{"goal":{"objective":"Different active work","status":"active"}}',
      ]));

      assert.equal(blocked.exitCode, 1);
      assert.match(blocked.stderr.join('\n'), /strict objective mismatch protection remains required/);
    });
  });
});
