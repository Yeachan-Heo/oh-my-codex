import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GOAL_HARNESS_HELP, goalHarnessCommand } from '../goal-harness.js';
import { HELP } from '../index.js';
import { OMG_HELP, main as goalProductMain } from '../omg-main.js';

async function withCwd<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-cli-'));
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

function passingEvidence(): string {
  return JSON.stringify({
    actor: 'leader',
    objectiveAudit: 'CLI test maps the objective to create, late gate, and Codex snapshot reconciliation.',
    implementationEvidence: ['src/cli/goal-harness.ts enforces the goal-harness command path.'],
    externalVerification: [{ command: 'node --test dist/cli/__tests__/goal-harness.test.js', status: 'pass', evidence: 'CLI test passed.' }],
    adversarialReview: { status: 'clear', evidence: 'The CLI path rejects missing phase and weak worker evidence.' },
    convergenceChallenge: { status: 'passed', alternativesConsidered: 2, evidence: 'A premature no-phase advance path and a direct-complete path were tested and rejected.' },
  });
}

describe('cli/goal-harness', () => {
  it('prints help with the single-goal and worker boundary', () => {
    assert.match(GOAL_HARNESS_HELP, /Lightweight Codex goal-native OMX harness/);
    assert.match(GOAL_HARNESS_HELP, /Workers never call create_goal or update_goal/);
    assert.match(HELP, /omx goal-harness[\s\S]*single-goal OMX-derived autonomy harness/i);
    assert.match(OMG_HELP, /Oh My Goal/);
    assert.match(OMG_HELP, /npx -p oh-my-codex omg/);
  });

  it('exposes the goal harness as the sibling omg product CLI', async () => {
    const help = await capture(() => goalProductMain(['--help']));
    assert.equal(help.exitCode, undefined);
    assert.match(help.stdout.join('\n'), /Oh My Goal/);
    assert.match(help.stdout.join('\n'), /omx goal-harness <command>/);

    const version = await capture(() => goalProductMain(['version']));
    assert.equal(version.exitCode, undefined);
    assert.match(version.stdout.join('\n'), /^\d+\.\d+\.\d+$/);
  });

  it('creates artifacts and emits a truthful Codex goal handoff', async () => {
    await withCwd(async (cwd) => {
      const created = await capture(() => goalHarnessCommand([
        'create',
        '--objective', 'Build a goal-native harness with Team worker evidence and late gates.',
        '--slug', 'cli-harness',
      ]));
      assert.equal(created.exitCode, undefined);
      assert.match(created.stdout.join('\n'), /goal-harness created: cli-harness/);

      const handoff = await capture(() => goalHarnessCommand(['start', '--slug', 'cli-harness']));
      const output = handoff.stdout.join('\n');
      assert.match(output, /goal-harness Codex goal handoff/);
      assert.match(output, /Keep one Codex goal as the top-level objective/);
      assert.match(output, /The leader is the only actor allowed to call update_goal/);
      assert.match(output, /omx goal-harness gate --slug cli-harness/);

      const mission = await readFile(join(cwd, '.omx/goals/goal-harness/cli-harness/mission.md'), 'utf-8');
      assert.match(mission, /Only the leader owns the Codex goal/);
      assert.match(mission, /runtime\.json/);
    });
  });

  it('rejects unsafe CLI shortcuts before they can mutate harness state', async () => {
    await withCwd(async () => {
      await capture(() => goalHarnessCommand([
        'create',
        '--objective', 'Guard goal-harness command boundaries.',
        '--slug', 'guardrails',
      ]));

      const missingPhase = await capture(() => goalHarnessCommand(['advance', '--slug', 'guardrails']));
      assert.equal(missingPhase.exitCode, 1);
      assert.match(missingPhase.stderr.join('\n'), /Missing --phase/);

      const missingRole = await capture(() => goalHarnessCommand([
        'record-trajectory',
        '--slug', 'guardrails',
        '--source', 'worker',
        '--summary', 'Worker evidence without a role',
        '--evidence', 'Concrete evidence but missing worker role',
        '--score', '80',
      ]));
      assert.equal(missingRole.exitCode, 1);
      assert.match(missingRole.stderr.join('\n'), /worker role/i);

      const missingScore = await capture(() => goalHarnessCommand([
        'record-trajectory',
        '--slug', 'guardrails',
        '--source', 'worker',
        '--role', 'critic',
        '--summary', 'Worker evidence without a score',
        '--evidence', 'Concrete evidence but missing candidate score',
      ]));
      assert.equal(missingScore.exitCode, 1);
      assert.match(missingScore.stderr.join('\n'), /require a score/i);
    });
  });

  it('syncs active get_goal snapshots for token budget awareness', async () => {
    await withCwd(async () => {
      const created = await capture(() => goalHarnessCommand([
        'create',
        '--objective', 'Track active Codex goal budget in the harness.',
        '--slug', 'goal-sync',
        '--json',
      ]));
      const payload = JSON.parse(created.stdout.join('\n')) as { run: { objective: string } };

      const synced = await capture(() => goalHarnessCommand([
        'sync-goal',
        '--slug', 'goal-sync',
        '--codex-goal-json', JSON.stringify({
          goal: { objective: payload.run.objective, status: 'active', token_budget: 90000 },
          remainingTokens: 61000,
        }),
      ]));

      assert.equal(synced.exitCode, undefined);
      assert.match(synced.stdout.join('\n'), /codex goal synced: goal-sync/);
      assert.match(synced.stdout.join('\n'), /token budget: 90000/);
      assert.match(synced.stdout.join('\n'), /remaining tokens: 61000/);

      const status = await capture(() => goalHarnessCommand(['status', '--slug', 'goal-sync']));
      assert.match(status.stdout.join('\n'), /token budget: 90000/);
      assert.match(status.stdout.join('\n'), /remaining tokens: 61000/);
    });
  });

  it('keeps next command on intake and ralplan before trajectory search', async () => {
    await withCwd(async () => {
      await capture(() => goalHarnessCommand([
        'create',
        '--objective', 'Somehow use a team to build a persistent goal harness with verification.',
        '--slug', 'cli-next-flow',
      ]));

      const first = await capture(() => goalHarnessCommand(['next', '--slug', 'cli-next-flow']));
      assert.match(first.stdout.join('\n'), /deep-interview intake/);
      assert.match(first.stdout.join('\n'), /goal-harness interview --slug cli-next-flow/);

      await capture(() => goalHarnessCommand(['interview', '--slug', 'cli-next-flow']));
      const second = await capture(() => goalHarnessCommand(['next', '--slug', 'cli-next-flow']));
      assert.match(second.stdout.join('\n'), /ralplan/);
      assert.match(second.stdout.join('\n'), /goal-harness plan --slug cli-next-flow/);
    });
  });

  it('runs the slug-aware completion gate and reconciles a fresh complete Codex snapshot', async () => {
    await withCwd(async () => {
      const created = await capture(() => goalHarnessCommand([
        'create',
        '--objective', 'Complete the goal-harness CLI path with local validation.',
        '--slug', 'cli-completion',
        '--json',
      ]));
      const payload = JSON.parse(created.stdout.join('\n')) as { run: { objective: string } };

      await capture(() => goalHarnessCommand([
        'record-trajectory',
        '--slug', 'cli-completion',
        '--id', 'T001-minimal',
        '--summary', 'Minimal CLI completion path',
        '--evidence', 'Simple path, but lacks independent pressure.',
        '--score', '70',
        '--novelty-score', '15',
      ]));
      await capture(() => goalHarnessCommand([
        'record-trajectory',
        '--slug', 'cli-completion',
        '--id', 'T002-pressured',
        '--summary', 'CLI completion path with critic pressure',
        '--evidence', 'Keeps one Codex goal while requiring review before late phase.',
        '--score', '91',
        '--novelty-score', '55',
      ]));
      await capture(() => goalHarnessCommand([
        'select',
        '--slug', 'cli-completion',
        '--trajectory-id', 'T002-pressured',
        '--evidence', 'Best verified path before late completion.',
      ]));
      await capture(() => goalHarnessCommand([
        'record-trajectory',
        '--slug', 'cli-completion',
        '--source', 'worker',
        '--role', 'critic',
        '--summary', 'Critic pressure before CLI late phase',
        '--evidence', 'Critic checked the CLI completion boundary.',
        '--score', '84',
      ]));

      const advanced = await capture(() => goalHarnessCommand([
        'advance',
        '--slug', 'cli-completion',
        '--phase', 'late',
        '--evidence', 'CLI completion evidence is ready.',
      ]));
      assert.equal(advanced.exitCode, undefined);

      const gate = await capture(() => goalHarnessCommand([
        'gate',
        '--slug', 'cli-completion',
        '--evidence-json', passingEvidence(),
        '--json',
      ]));
      assert.equal(gate.exitCode, undefined);
      const gatePayload = JSON.parse(gate.stdout.join('\n')) as { ok: boolean; run: { status: string } };
      assert.equal(gatePayload.ok, true);
      assert.equal(gatePayload.run.status, 'validation_passed');

      const completed = await capture(() => goalHarnessCommand([
        'complete',
        '--slug', 'cli-completion',
        '--codex-goal-json', JSON.stringify({ goal: { objective: payload.run.objective, status: 'complete' } }),
      ]));
      assert.equal(completed.exitCode, undefined);
      assert.match(completed.stdout.join('\n'), /goal-harness complete: cli-completion/);
      assert.match(completed.stdout.join('\n'), /matched a fresh complete get_goal snapshot/);
    });
  });
});
