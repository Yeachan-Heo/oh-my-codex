import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoresearchGoalCommand, AUTORESEARCH_GOAL_HELP } from '../autoresearch-goal.js';

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-goal-'));
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

describe('cli/autoresearch-goal', () => {
  it('prints help with goal-mode and deprecated-command boundaries', () => {
    assert.match(AUTORESEARCH_GOAL_HELP, /professor-critic/i);
    assert.match(AUTORESEARCH_GOAL_HELP, /does not revive deprecated omx autoresearch/i);
    assert.match(AUTORESEARCH_GOAL_HELP, /get_goal\/create_goal\/update_goal/i);
    assert.match(AUTORESEARCH_GOAL_HELP, /blocked until professor-critic validation records verdict=pass/i);
  });

  it('creates durable artifacts and emits a safe Codex goal handoff', async () => {
    await withCwd(async (cwd) => {
      const created = await capture(() => autoresearchGoalCommand([
        'create',
        '--topic', 'Map migration risk',
        '--rubric', 'Professor critic must verify source citations and reject unsupported claims.',
        '--critic-command', 'node scripts/critic.js',
      ]));
      assert.equal(created.exitCode, undefined);
      assert.match(created.stdout.join('\n'), /autoresearch-goal created: map-migration-risk/);

      const handoff = await capture(() => autoresearchGoalCommand(['handoff', '--slug', 'map-migration-risk']));
      const output = handoff.stdout.join('\n');
      assert.match(output, /Autoresearch-goal active-goal handoff/);
      assert.match(output, /This shell command does not mutate hidden Codex \/goal state/);
      assert.match(output, /First call get_goal/);
      assert.match(output, /call create_goal with the payload below/);
      assert.match(output, /Do not call update_goal\(\{status: "complete"\}\) until the professor-critic verdict is pass/);
      assert.match(output, /do not revive deprecated omx autoresearch/i);

      const mission = JSON.parse(await readFile(join(cwd, '.omx/goals/autoresearch/map-migration-risk/mission.json'), 'utf-8')) as { status: string; critic_command: string };
      assert.equal(mission.status, 'in_progress');
      assert.equal(mission.critic_command, 'node scripts/critic.js');
    });
  });


  it('rejects missing values for value-taking flags instead of consuming the next flag', async () => {
    await withCwd(async () => {
      const result = await capture(() => autoresearchGoalCommand([
        'create',
        '--topic', 'Map risk',
        '--rubric',
        '--slug', 'map-risk',
      ]));

      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.join('\n'), /Missing value for --rubric/);
    });
  });

  it('blocks completion until a passing professor-critic verdict is recorded', async () => {
    await withCwd(async (cwd) => {
      await capture(() => autoresearchGoalCommand([
        'create',
        '--topic', 'Research flaky tests',
        '--rubric', 'Professor critic requires reproduction evidence and a cited root cause.',
      ]));

      const initiallyBlocked = await capture(() => autoresearchGoalCommand(['complete', '--slug', 'research-flaky-tests']));
      assert.equal(initiallyBlocked.exitCode, 1);
      assert.match(initiallyBlocked.stderr.join('\n'), /cannot complete until professor-critic validation records verdict=pass/);

      await capture(() => autoresearchGoalCommand([
        'verdict',
        '--slug', 'research-flaky-tests',
        '--verdict', 'fail',
        '--evidence', 'critic rejected missing reproduction logs',
      ]));
      const stillBlocked = await capture(() => autoresearchGoalCommand(['complete', '--slug', 'research-flaky-tests']));
      assert.equal(stillBlocked.exitCode, 1);

      await capture(() => autoresearchGoalCommand([
        'verdict',
        '--slug', 'research-flaky-tests',
        '--verdict', 'pass',
        '--evidence', 'critic approved report.md with reproduction logs and citations',
        '--artifact', '.omx/specs/autoresearch-flaky-tests/report.md',
      ]));
      const expectedObjective = [
        'Autoresearch goal: Research flaky tests',
        '',
        'Research methodology / professor-critic rubric:',
        'Professor critic requires reproduction evidence and a cited root cause.',
        '',
        'Completion gate: record a passing professor-critic verdict with omx autoresearch-goal verdict --slug research-flaky-tests --verdict pass --evidence "<critic artifact/evidence>". After the objective audit passes, call update_goal({status: "complete"}), call get_goal again, then run omx autoresearch-goal complete --slug research-flaky-tests --codex-goal-json "<fresh get_goal JSON or path>".',
      ].join('\n');
      const completed = await capture(() => autoresearchGoalCommand([
        'complete',
        '--slug', 'research-flaky-tests',
        '--codex-goal-json', JSON.stringify({ goal: { objective: expectedObjective, status: 'complete' } }),
      ]));
      assert.equal(completed.exitCode, undefined);
      assert.match(completed.stdout.join('\n'), /autoresearch-goal complete: research-flaky-tests/);
      assert.match(completed.stdout.join('\n'), /matched a fresh complete get_goal snapshot/);

      const completion = JSON.parse(await readFile(join(cwd, '.omx/goals/autoresearch/research-flaky-tests/completion.json'), 'utf-8')) as { verdict: string; passed: boolean };
      assert.equal(completion.verdict, 'pass');
      assert.equal(completion.passed, true);

      const mission = JSON.parse(await readFile(join(cwd, '.omx/goals/autoresearch/research-flaky-tests/mission.json'), 'utf-8')) as { status: string; completed_at?: string };
      assert.equal(mission.status, 'complete');
      assert.match(mission.completed_at ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const status = await capture(() => autoresearchGoalCommand(['status', '--slug', 'research-flaky-tests']));
      assert.match(status.stdout.join('\n'), /autoresearch-goal: research-flaky-tests \[complete\]/);

      const afterComplete = await capture(() => autoresearchGoalCommand([
        'verdict',
        '--slug', 'research-flaky-tests',
        '--verdict', 'fail',
        '--evidence', 'late critic rejection',
      ]));
      assert.equal(afterComplete.exitCode, 1);
      assert.match(afterComplete.stderr.join('\n'), /already complete/);
    });
  });

  it('accepts legacy autoresearch goal objective snapshots for in-flight missions', async () => {
    await withCwd(async () => {
      await capture(() => autoresearchGoalCommand([
        'create',
        '--topic', 'Research legacy handoff',
        '--rubric', 'Professor critic requires old handoff compatibility.',
      ]));
      await capture(() => autoresearchGoalCommand([
        'verdict',
        '--slug', 'research-legacy-handoff',
        '--verdict', 'pass',
        '--evidence', 'critic approved legacy in-flight mission',
      ]));
      const legacyObjective = [
        'Autoresearch goal: Research legacy handoff',
        '',
        'Research methodology / professor-critic rubric:',
        'Professor critic requires old handoff compatibility.',
        '',
        'Completion gate: record a passing professor-critic verdict with omx autoresearch-goal verdict --slug research-legacy-handoff --verdict pass --evidence "<critic artifact/evidence>", then run omx autoresearch-goal complete --slug research-legacy-handoff.',
      ].join('\n');

      const completed = await capture(() => autoresearchGoalCommand([
        'complete',
        '--slug', 'research-legacy-handoff',
        '--codex-goal-json', JSON.stringify({ goal: { objective: legacyObjective, status: 'complete' } }),
      ]));

      assert.equal(completed.exitCode, undefined);
      assert.match(completed.stdout.join('\n'), /autoresearch-goal complete: research-legacy-handoff/);
    });
  });

  it('requires matching complete Codex goal proof for completion', async () => {
    await withCwd(async (cwd) => {
      await capture(() => autoresearchGoalCommand([
        'create',
        '--topic', 'Research goal snapshots',
        '--rubric', 'Professor critic requires concrete citations.',
      ]));
      await capture(() => autoresearchGoalCommand([
        'verdict',
        '--slug', 'research-goal-snapshots',
        '--verdict', 'pass',
        '--evidence', 'critic approved cited report',
      ]));

      const missing = await capture(() => autoresearchGoalCommand(['complete', '--slug', 'research-goal-snapshots']));
      assert.equal(missing.exitCode, 1);
      assert.match(missing.stderr.join('\n'), /call get_goal/);

      const incomplete = await capture(() => autoresearchGoalCommand([
        'complete',
        '--slug', 'research-goal-snapshots',
        '--codex-goal-json', '{"goal":{"objective":"Different","status":"active"}}',
      ]));
      assert.equal(incomplete.exitCode, 1);
      assert.match(incomplete.stderr.join('\n'), /objective mismatch/);
      assert.match(incomplete.stderr.join('\n'), /not complete/);

      const mismatched = await capture(() => autoresearchGoalCommand([
        'complete',
        '--slug', 'research-goal-snapshots',
        '--codex-goal-json', '{"goal":{"objective":"Autoresearch goal: Different completed mission","status":"complete"}}',
      ]));

      assert.equal(mismatched.exitCode, 1);
      assert.match(mismatched.stderr.join('\n'), /objective mismatch/);

      const completion = JSON.parse(
        await readFile(join(cwd, '.omx/goals/autoresearch/research-goal-snapshots/completion.json'), 'utf-8'),
      ) as {
        verdict: string;
        passed: boolean;
        codex_goal_reconciliation?: unknown;
      };
      assert.equal(completion.verdict, 'pass');
      assert.equal(completion.passed, true);
      assert.equal(completion.codex_goal_reconciliation, undefined);

      const mission = JSON.parse(
        await readFile(join(cwd, '.omx/goals/autoresearch/research-goal-snapshots/mission.json'), 'utf-8'),
      ) as { status: string };
      assert.equal(mission.status, 'passed');
    });
  });
});
