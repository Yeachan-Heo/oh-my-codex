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

function cleanQualityGate(): string {
  return JSON.stringify({
    aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner passed' },
    verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
    codeReview: { recommendation: 'APPROVE', architectStatus: 'CLEAR', evidence: '$code-review APPROVE + CLEAR' },
  });
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
    assert.match(ULTRAGOAL_HELP, /aggregate mode/);
    assert.match(ULTRAGOAL_HELP, /blocked/);
    assert.match(ULTRAGOAL_HELP, /fresh Codex thread/);
    assert.match(ULTRAGOAL_HELP, /get_goal\/create_goal\/update_goal/);
    assert.match(ULTRAGOAL_HELP, /add-goal/);
    assert.match(ULTRAGOAL_HELP, /record-review-blockers/);
    assert.match(ULTRAGOAL_HELP, /quality-gate-json/);
    assert.match(ULTRAGOAL_HELP, /ai-slop-cleaner/);
    assert.match(ULTRAGOAL_HELP, /code-review/);
  });

  it('creates and starts goals through the command surface', async () => {
    await withCwd(async (cwd) => {
      const created = await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone\n- Second milestone']));
      assert.equal(created.exitCode, undefined);
      assert.match(created.stdout.join('\n'), /ultragoal plan created: 2 goal/);

      const next = await capture(() => ultragoalCommand(['complete-goals']));
      const output = next.stdout.join('\n');
      assert.match(output, /Ultragoal aggregate-goal handoff/);
      assert.match(output, /create_goal payload/);
      assert.match(output, /Codex goal = the whole ultragoal run/);
      assert.doesNotMatch(output, /fresh Codex thread/);
      assert.match(output, /omx ultragoal checkpoint --goal-id G001-first-milestone --status complete/);

      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { activeGoalId?: string; codexGoalMode?: string; codexObjective?: string };
      assert.equal(goals.activeGoalId, 'G001-first-milestone');
      assert.equal(goals.codexGoalMode, 'aggregate');
      assert.match(goals.codexObjective ?? '', /Complete all ultragoal stories/);
    });
  });

  it('checkpoints a goal and reports status as json', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { codexObjective: string };
      const checkpoint = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', JSON.stringify({ goal: { objective: goals.codexObjective, status: 'complete' } }),
        '--quality-gate-json', cleanQualityGate(),
        '--json',
      ]));
      assert.equal(checkpoint.exitCode, undefined);
      const parsed = JSON.parse(checkpoint.stdout.join('\n')) as { summary: { complete: number } };
      assert.equal(parsed.summary.complete, 1);
    });
  });

  it('labels aggregate product completion separately from microgoal bookkeeping status', async () => {
    await withCwd(async () => {
      const taskObjective = 'Fix ultragoal task-scoped goal reconciliation.';
      await capture(() => ultragoalCommand(['create-goals', '--brief', taskObjective, '--goal', 'First::Synthetic slice 1.', '--goal', 'Second::Synthetic slice 2.']));
      await capture(() => ultragoalCommand(['complete-goals']));

      const checkpoint = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first',
        '--status', 'complete',
        '--evidence', 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
        '--codex-goal-json', JSON.stringify({ goal: { objective: taskObjective, status: 'complete' } }),
        '--quality-gate-json', cleanQualityGate(),
      ]));
      assert.equal(checkpoint.exitCode, undefined);

      const status = await capture(() => ultragoalCommand(['status']));
      const output = status.stdout.join('\n');
      assert.match(output, /ultragoal aggregate product: complete/);
      assert.match(output, /microgoal ledger bookkeeping \(progress-only\): 0\/2 complete, 1 pending, 1 in progress/);
    });
  });

  it('adds goals through the command surface', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      const added = await capture(() => ultragoalCommand([
        'add-goal',
        '--title', 'Resolve final code-review blockers',
        '--objective', 'Fix blockers and rerun gates.',
        '--evidence', 'review findings',
        '--json',
      ]));

      assert.equal(added.exitCode, undefined);
      const parsed = JSON.parse(added.stdout.join('\n')) as { addedGoal: { id: string; status: string }; summary: { pending: number } };
      assert.equal(parsed.addedGoal.id, 'G002-resolve-final-code-review-blockers');
      assert.equal(parsed.addedGoal.status, 'pending');
      assert.equal(parsed.summary.pending, 2);
    });
  });

  it('records final review blockers through the command surface', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- Final milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { codexObjective: string };

      const blocked = await capture(() => ultragoalCommand([
        'record-review-blockers',
        '--goal-id', 'G001-final-milestone',
        '--title', 'Resolve final code-review blockers',
        '--objective', 'Fix blockers and rerun final gates.',
        '--evidence', 'code-review REQUEST CHANGES',
        '--codex-goal-json', JSON.stringify({ goal: { objective: goals.codexObjective, status: 'active' } }),
        '--json',
      ]));

      assert.equal(blocked.exitCode, undefined);
      const parsed = JSON.parse(blocked.stdout.join('\n')) as { blockedGoal: { status: string }; addedGoal: { status: string }; summary: { reviewBlocked: number; pending: number } };
      assert.equal(parsed.blockedGoal.status, 'review_blocked');
      assert.equal(parsed.addedGoal.status, 'pending');
      assert.equal(parsed.summary.reviewBlocked, 1);
      assert.equal(parsed.summary.pending, 1);
    });
  });

  it('requires matching complete Codex goal proof before completing a checkpoint', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { codexObjective: string };

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
        '--codex-goal-json', JSON.stringify({ goal: { objective: goals.codexObjective, status: 'active' } }),
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
      assert.match(mismatch.stderr.join('\n'), /--status blocked/);
      assert.match(mismatch.stderr.join('\n'), /fresh Codex thread/);
    });
  });

  it('fails closed for malformed final quality-gate json', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { codexObjective: string };

      const malformed = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', JSON.stringify({ goal: { objective: goals.codexObjective, status: 'complete' } }),
        '--quality-gate-json', '{bad json',
      ]));

      assert.equal(malformed.exitCode, 1);
      assert.match(malformed.stderr.join('\n'), /Invalid --quality-gate-json/);
    });
  });

  it('records blocked legacy Codex-goal checkpoints as non-terminal', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone', '--codex-goal-mode', 'per-story']));
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
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone', '--codex-goal-mode', 'per-story']));
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
