import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performanceGoalCommand, PERFORMANCE_GOAL_HELP } from '../performance-goal.js';
import { HELP } from '../index.js';

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-performance-goal-cli-'));
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

describe('cli/performance-goal', () => {
  it('prints help with evaluator gate and goal-mode constraints', () => {
    assert.match(PERFORMANCE_GOAL_HELP, /evaluator-gated performance optimization/i);
    assert.match(PERFORMANCE_GOAL_HELP, /get_goal\/create_goal\/update_goal/);
    assert.match(PERFORMANCE_GOAL_HELP, /passing checkpoint/i);
    assert.match(HELP, /omx performance-goal[\s\S]*evaluator-backed performance goals/);
  });

  it('creates artifacts and emits a truthful Codex goal handoff', async () => {
    await withCwd(async (cwd) => {
      const created = await capture(() => performanceGoalCommand([
        'create',
        '--objective', 'Reduce CLI startup latency by 20%',
        '--evaluator-command', 'npm run perf:startup',
        '--evaluator-contract', 'PASS when p95 startup latency improves by at least 20% with no regression failures.',
        '--slug', 'startup-latency',
      ]));
      assert.equal(created.exitCode, undefined);
      assert.match(created.stdout.join('\n'), /performance goal created: startup-latency/);

      const handoff = await capture(() => performanceGoalCommand(['start', '--slug', 'startup-latency']));
      const output = handoff.stdout.join('\n');
      assert.match(output, /Performance goal handoff/);
      assert.match(output, /First call get_goal/);
      assert.match(output, /call create_goal/);
      assert.match(output, /Do not treat this shell command as hidden Codex goal mutation/);
      assert.match(output, /update_goal\(\{status: "complete"\}\)/);
      assert.ok(output.indexOf('update_goal({status: "complete"})') < output.indexOf('omx performance-goal complete --slug startup-latency'));
      assert.match(output, /--codex-goal-json/);
      assert.match(output, /npm run perf:startup/);

      const state = JSON.parse(await readFile(join(cwd, '.omx/goals/performance/startup-latency/state.json'), 'utf-8')) as { status: string; artifactPaths: { evaluator: string } };
      assert.equal(state.status, 'in_progress');
      assert.equal(state.artifactPaths.evaluator, '.omx/goals/performance/startup-latency/evaluator.md');
    });
  });


  it('rejects missing values for value-taking flags instead of consuming the next flag', async () => {
    await withCwd(async () => {
      const result = await capture(() => performanceGoalCommand([
        'create',
        '--objective', 'Reduce latency',
        '--evaluator-command',
        '--evaluator-contract', 'PASS when evaluator succeeds.',
      ]));

      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.join('\n'), /Missing value for --evaluator-command/);
    });
  });

  it('blocks completion until evaluator validation passes', async () => {
    await withCwd(async () => {
      await capture(() => performanceGoalCommand([
        'create',
        '--objective', 'Improve hot path throughput',
        '--evaluator-command', 'node bench.js',
        '--evaluator-contract', 'PASS when throughput is above baseline and tests pass.',
        '--slug', 'throughput',
      ]));

      const premature = await capture(() => performanceGoalCommand(['complete', '--slug', 'throughput']));
      assert.equal(premature.exitCode, 1);
      assert.match(premature.stderr.join('\n'), /Cannot complete performance goal until evaluator validation has a passing checkpoint/);

      const failed = await capture(() => performanceGoalCommand(['checkpoint', '--slug', 'throughput', '--status', 'fail', '--evidence', 'benchmark regressed']));
      assert.equal(failed.exitCode, undefined);
      const stillBlocked = await capture(() => performanceGoalCommand(['complete', '--slug', 'throughput']));
      assert.equal(stillBlocked.exitCode, 1);

      const passed = await capture(() => performanceGoalCommand(['checkpoint', '--slug', 'throughput', '--status', 'pass', '--evidence', 'benchmark and tests passed']));
      assert.equal(passed.exitCode, undefined);
      const completed = await capture(() => performanceGoalCommand([
        'complete',
        '--slug', 'throughput',
        '--codex-goal-json', '{"goal":{"objective":"Improve hot path throughput","status":"complete"}}',
        '--json',
      ]));
      assert.equal(completed.exitCode, undefined);
      const parsed = JSON.parse(completed.stdout.join('\n')) as { state: { status: string } };
      assert.equal(parsed.state.status, 'complete');

      const afterComplete = await capture(() => performanceGoalCommand(['checkpoint', '--slug', 'throughput', '--status', 'fail', '--evidence', 'late regression']));
      assert.equal(afterComplete.exitCode, 1);
      assert.match(afterComplete.stderr.join('\n'), /already complete/);
    });
  });

  it('prints explicit terminal cleanup after successful completion without claiming hidden clear', async () => {
    await withCwd(async () => {
      await capture(() => performanceGoalCommand([
        'create',
        '--objective', 'Reduce tail latency',
        '--evaluator-command', 'node bench.js',
        '--evaluator-contract', 'PASS when p99 latency improves.',
        '--slug', 'tail-latency',
      ]));
      await capture(() => performanceGoalCommand(['checkpoint', '--slug', 'tail-latency', '--status', 'pass', '--evidence', 'bench pass']));

      const completed = await capture(() => performanceGoalCommand([
        'complete',
        '--slug', 'tail-latency',
        '--codex-goal-json', '{"goal":{"objective":"Reduce tail latency","status":"complete"}}',
      ]));

      const output = completed.stdout.join('\n');
      assert.equal(completed.exitCode, undefined);
      assert.match(output, /Terminal next step for another goal in this same Codex thread\/session: run \/goal clear/);
      assert.match(output, /OMX shell commands and hooks do not call \/goal clear or hidden thread\/goal\/clear routes/);
      assert.doesNotMatch(output, /cleared Codex goal state/i);
    });
  });

  it('requires matching complete Codex goal proof for completion', async () => {
    await withCwd(async () => {
      await capture(() => performanceGoalCommand([
        'create',
        '--objective', 'Reduce allocations',
        '--evaluator-command', 'node bench.js',
        '--evaluator-contract', 'PASS when allocations fall and tests pass.',
        '--slug', 'allocations',
      ]));
      await capture(() => performanceGoalCommand(['checkpoint', '--slug', 'allocations', '--status', 'pass', '--evidence', 'bench pass']));

      const missing = await capture(() => performanceGoalCommand(['complete', '--slug', 'allocations']));
      assert.equal(missing.exitCode, 1);
      assert.match(missing.stderr.join('\n'), /call get_goal/);

      const incomplete = await capture(() => performanceGoalCommand([
        'complete',
        '--slug', 'allocations',
        '--codex-goal-json', '{"goal":{"objective":"Reduce allocations","status":"active"}}',
      ]));
      assert.equal(incomplete.exitCode, 1);
      assert.match(incomplete.stderr.join('\n'), /not complete/);

      const malformed = await capture(() => performanceGoalCommand([
        'complete',
        '--slug', 'allocations',
        '--codex-goal-json', '{bad-json}',
      ]));
      assert.equal(malformed.exitCode, 1);
      assert.match(malformed.stderr.join('\n'), /neither valid JSON nor a readable path/);
    });
  });
});
