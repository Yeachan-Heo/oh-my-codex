import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
    codeReview: {
      recommendation: 'APPROVE',
      architectStatus: 'CLEAR',
      evidence: '$code-review APPROVE + CLEAR',
      independentReview: {
        codeReviewer: { agentRole: 'code-reviewer', evidence: 'code-reviewer subagent returned APPROVE' },
        architect: { agentRole: 'architect', evidence: 'architect subagent returned CLEAR' },
      },
    },
    architectureInvariantGate: {
      status: 'passed',
      sourceArtifacts: ['.omx/ultragoal/brief.md', '.omx/ultragoal/goals.json'],
      invariants: [],
      evidence: 'architect verified no additional architecture invariants were declared in the brief',
    },
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
  it('refuses mutating ultragoal commands from Team worker environments', async () => {
    const mutators: string[][] = [
      ['create-goals', '--brief', 'worker must not create'],
      ['create', '--brief', 'worker must not create'],
      ['add-goal', '--title', 'Worker goal', '--objective', 'Do not add'],
      ['steer', '--kind', 'add_subgoal', '--title', 'Worker steer', '--objective', 'Do not steer', '--evidence', 'worker evidence', '--rationale', 'worker rationale'],
      ['record-review-blockers', '--goal-id', 'G001-first', '--title', 'Blocker', '--objective', 'Do not record', '--evidence', 'worker evidence', '--codex-goal-json', JSON.stringify({ goal: { objective: 'x', status: 'active' } })],
      ['complete-goals'],
      ['complete'],
      ['next'],
      ['start-next'],
      ['checkpoint', '--goal-id', 'G001-first', '--status', 'complete', '--evidence', 'worker evidence'],
    ];
    const envCases: Array<[string, string]> = [
      ['OMX_TEAM_WORKER', 'display-team/worker-1'],
      ['OMX_TEAM_INTERNAL_WORKER', 'internal-team/worker-1'],
    ];

    for (const [envName, envValue] of envCases) {
      for (const args of mutators) {
        await withCwd(async (cwd) => {
          const previousPublic = process.env.OMX_TEAM_WORKER;
          const previousInternal = process.env.OMX_TEAM_INTERNAL_WORKER;
          delete process.env.OMX_TEAM_WORKER;
          delete process.env.OMX_TEAM_INTERNAL_WORKER;
          process.env[envName] = envValue;
          try {
            const result = await capture(() => ultragoalCommand(args));
            assert.equal(result.exitCode, 1, `${envName} should block ${args[0]}`);
            assert.match(result.stderr.join('\n'), /leader-owned/i);
            assert.match(result.stderr.join('\n'), /report checkpoint evidence upward/i);
            assert.equal(existsSync(join(cwd, '.omx/ultragoal/goals.json')), false);
            assert.equal(existsSync(join(cwd, '.omx/ultragoal/ledger.jsonl')), false);
          } finally {
            if (typeof previousPublic === 'string') process.env.OMX_TEAM_WORKER = previousPublic;
            else delete process.env.OMX_TEAM_WORKER;
            if (typeof previousInternal === 'string') process.env.OMX_TEAM_INTERNAL_WORKER = previousInternal;
            else delete process.env.OMX_TEAM_INTERNAL_WORKER;
          }
        });
      }
    }
  });

  it('allows ultragoal help and status from Team worker environments', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      const previousPublic = process.env.OMX_TEAM_WORKER;
      const previousInternal = process.env.OMX_TEAM_INTERNAL_WORKER;
      process.env.OMX_TEAM_WORKER = 'display-team/worker-1';
      process.env.OMX_TEAM_INTERNAL_WORKER = 'internal-team/worker-1';
      try {
        const help = await capture(() => ultragoalCommand(['help']));
        assert.equal(help.exitCode, undefined);
        assert.match(help.stdout.join('\n'), /omx ultragoal/);

        const status = await capture(() => ultragoalCommand(['status']));
        assert.equal(status.exitCode, undefined);
        assert.match(status.stdout.join('\n'), /ultragoal:/);
      } finally {
        if (typeof previousPublic === 'string') process.env.OMX_TEAM_WORKER = previousPublic;
        else delete process.env.OMX_TEAM_WORKER;
        if (typeof previousInternal === 'string') process.env.OMX_TEAM_INTERNAL_WORKER = previousInternal;
        else delete process.env.OMX_TEAM_INTERNAL_WORKER;
      }
    });
  });

  it('prints help with artifact and goal-mode constraints', async () => {
    assert.match(ULTRAGOAL_HELP, /create-goals/);
    assert.match(ULTRAGOAL_HELP, /complete-goals/);
    assert.match(ULTRAGOAL_HELP, /aggregate mode/);
    assert.match(ULTRAGOAL_HELP, /blocked/);
    assert.doesNotMatch(ULTRAGOAL_HELP, /fresh (?:Codex )?(?:thread|session)s?/i);
    assert.match(ULTRAGOAL_HELP, /get_goal\/create_goal\/update_goal/);
    assert.match(ULTRAGOAL_HELP, /does not call \/goal clear/);
    assert.match(ULTRAGOAL_HELP, /multiple sequential ultragoal runs/);
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
      assert.match(output, /does not call \/goal clear/);
      assert.match(output, /After a completed aggregate run/);
      assert.match(output, /omx ultragoal checkpoint --goal-id G001-first-milestone --status complete/);

      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { activeGoalId?: string; codexGoalMode?: string; codexObjective?: string };
      assert.equal(goals.activeGoalId, 'G001-first-milestone');
      assert.equal(goals.codexGoalMode, 'aggregate');
      assert.match(goals.codexObjective ?? '', /Complete the durable ultragoal plan/);
      assert.match(goals.codexObjective ?? '', /including later accepted\/appended stories/);
      assert.doesNotMatch(goals.codexObjective ?? '', /G001-first-milestone/);
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

  it('prints explicit terminal cleanup after final checkpoint without claiming hidden clear', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- Final milestone']));
      await capture(() => ultragoalCommand(['complete-goals']));
      const goals = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { codexObjective: string };

      const checkpoint = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-final-milestone',
        '--status', 'complete',
        '--evidence', 'tests and final review passed',
        '--codex-goal-json', JSON.stringify({ goal: { objective: goals.codexObjective, status: 'complete' } }),
        '--quality-gate-json', cleanQualityGate(),
      ]));

      const output = checkpoint.stdout.join('\n');
      assert.equal(checkpoint.exitCode, undefined);
      assert.match(output, /Terminal next step for another goal in this same Codex thread\/session: run \/goal clear/);
      assert.match(output, /OMX shell commands and hooks do not call \/goal clear or hidden thread\/goal\/clear routes/);
      assert.doesNotMatch(output, /cleared Codex goal state/i);
    });
  });

  it('places completed-goal preflight remediation before create_goal guidance', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- First milestone']));
      const next = await capture(() => ultragoalCommand(['complete-goals']));
      const output = next.stdout.join('\n');

      assert.match(output, /get_goal reports status complete before create_goal/);
      assert.match(output, /Run \/goal clear in the Codex UI before starting another goal/);
      assert.ok(output.indexOf('get_goal reports status complete before create_goal') < output.indexOf('create_goal payload'));
      assert.match(output, /OMX did not and cannot clear hidden Codex goal state/);
    });
  });

  it('reports artifact-backed completion when Codex goal DB schema is unavailable', async () => {
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
      ]));
      assert.equal(checkpoint.exitCode, undefined);

      const status = await capture(() => ultragoalCommand([
        'status',
        '--codex-goal-json',
        JSON.stringify({ error: 'SqliteError: no such table: thread_goals' }),
        '--json',
      ]));
      assert.equal(status.exitCode, undefined);
      const parsed = JSON.parse(status.stdout.join('\n')) as {
        summary: { complete: number; aggregateComplete: boolean; artifactComplete: boolean };
        codexGoalFallback?: { status: string; reason: string; message: string };
        reconciliation?: { ok: boolean; warnings: string[]; snapshot: { unavailableReason?: string } };
      };
      assert.equal(parsed.summary.complete, 1);
      assert.equal(parsed.summary.aggregateComplete, false);
      assert.equal(parsed.summary.artifactComplete, true);
      assert.equal(parsed.codexGoalFallback?.status, 'codex_goal_reconciliation_unavailable');
      assert.equal(parsed.codexGoalFallback?.reason, 'db_schema_context_error');
      assert.match(parsed.codexGoalFallback?.message ?? '', /artifact-backed Ultragoal status remains available/);
      assert.equal(parsed.reconciliation?.ok, true);
      assert.equal(parsed.reconciliation?.snapshot.unavailableReason, 'db_schema_context_error');

      const human = await capture(() => ultragoalCommand([
        'status',
        '--codex-goal-json',
        JSON.stringify({ error: 'SQL error: no such table: thread_goals' }),
      ]));
      const output = human.stdout.join('\n');
      assert.match(output, /ultragoal artifact goals: complete/);
      assert.match(output, /codex goal fallback: Codex goal DB\/schema\/context is unavailable/);
      assert.match(output, /codex goal warning: .*no such table: thread_goals/);
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

  it('steers ultragoal plans through structured CLI fields with audit output', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const steered = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'add_subgoal',
        '--title', 'Prompt submit bridge',
        '--objective', 'Implement bounded prompt-submit bridge behavior.',
        '--evidence', '.omx/ultragoal G002-cli-and-prompt-submit-bridge needs a structured CLI bridge before hook wiring.',
        '--rationale', 'A structured CLI mutation keeps steering explicit and audited without broad natural-language mutation.',
        '--idempotency-key', 'g002-cli-add-subgoal',
        '--json',
      ]));

      assert.equal(steered.exitCode, undefined);
      const parsed = JSON.parse(steered.stdout.join('\n')) as {
        accepted: boolean;
        deduped: boolean;
        audit: { kind: string; source: string; idempotencyKey: string };
        summary: { pending: number };
      };
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.deduped, false);
      assert.equal(parsed.audit.kind, 'add_subgoal');
      assert.equal(parsed.audit.source, 'cli');
      assert.equal(parsed.audit.idempotencyKey, 'g002-cli-add-subgoal');
      assert.equal(parsed.summary.pending, 2);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_accepted"/);
      assert.match(ledger, /g002-cli-add-subgoal/);
    });
  });

  it('dedupes structured CLI steering by idempotency key', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const args = [
        'steer',
        '--kind', 'add_subgoal',
        '--title', 'Prompt submit bridge',
        '--objective', 'Implement bounded prompt-submit bridge behavior.',
        '--evidence', '.omx/ultragoal G002-cli-and-prompt-submit-bridge evidence.',
        '--rationale', 'Explicit structured steering should be idempotent.',
        '--idempotency-key', 'same-cli-steer',
        '--json',
      ];

      await capture(() => ultragoalCommand(args));
      const second = await capture(() => ultragoalCommand(args));
      const parsed = JSON.parse(second.stdout.join('\n')) as { accepted: boolean; deduped: boolean; summary: { pending: number } };
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.deduped, true);
      assert.equal(parsed.summary.pending, 2);
    });
  });

  it('rejects broad natural-language steering instead of guessing mutations', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const rejected = await capture(() => ultragoalCommand(['steer', 'please rewrite goals however seems best']));

      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr.join('\n'), /rejects broad natural-language mutation requests/);
    });
  });

  it('rejects legacy proposal json with an invalid steering kind', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const rejected = await capture(() => ultragoalCommand([
        'steer',
        '--proposal',
        JSON.stringify({
          kind: 'make_goal_easier',
          source: 'cli',
          evidence: 'The proposal came from a stale integration path.',
          rationale: 'Invalid mutation kinds must not bypass the structured allowlist.',
        }),
        '--json',
      ]));

      assert.equal(rejected.exitCode, 1);
      assert.match(rejected.stderr.join('\n'), /Invalid --kind: make_goal_easier/);
    });
  });

  it('rejects invalid steering source and reports the accepted audit source', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const invalid = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'annotate_ledger',
        '--source', 'forged',
        '--evidence', '.omx/ultragoal G002 invalid source evidence.',
        '--rationale', 'Invalid sources must not enter the steering audit.',
        '--json',
      ]));

      assert.equal(invalid.exitCode, 1);
      assert.match(invalid.stderr.join('\n'), /Invalid --source: forged/);

      const accepted = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'annotate_ledger',
        '--source', 'finding',
        '--evidence', '.omx/ultragoal G002 reviewer finding evidence.',
        '--rationale', 'The CLI should report the actual accepted audit source.',
        '--json',
      ]));
      assert.equal(accepted.exitCode, undefined);
      const parsed = JSON.parse(accepted.stdout.join('\n')) as { audit: { source: string } };
      assert.equal(parsed.audit.source, 'finding');
    });
  });

  it('surfaces rejected structured steering audit results', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- CLI bridge']));
      const rejected = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'revise_pending_wording',
        '--target-goal-id', 'G999-missing',
        '--evidence', '.omx/ultragoal G002-cli-and-prompt-submit-bridge invalid target evidence.',
        '--rationale', 'This intentionally uses a missing goal to prove rejection audit output.',
        '--title', 'New title',
        '--json',
      ]));

      assert.equal(rejected.exitCode, 1);
      const parsed = JSON.parse(rejected.stdout.join('\n')) as {
        accepted: boolean;
        rejectedReasons: string[];
        audit: { kind: string; source: string; targetGoalId: string };
      };
      assert.equal(parsed.accepted, false);
      assert.equal(parsed.audit.kind, 'revise_pending_wording');
      assert.equal(parsed.audit.source, 'cli');
      assert.equal(parsed.audit.targetGoalId, 'G999-missing');
      assert.match(parsed.rejectedReasons.join(' | '), /unknown/);
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

  it('steers an ultragoal mutation through structured flags', async () => {
    await withCwd(async (cwd) => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- Add and steer goal']));
      const result = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'add_subgoal',
        '--title', 'Add steering telemetry',
        '--objective', 'Add explicit steering bridge telemetry evidence to ultragoal.',
        '--evidence', 'structured steer test',
        '--rationale', 'Test should exercise bounded CLI steering path.',
        '--idempotency-key', 'cli-steer-e2e',
        '--json',
      ]));

      assert.equal(result.exitCode, undefined);
      const parsed = JSON.parse(result.stdout.join('\n')) as { accepted: boolean; deduped: boolean; planSummary: { pending: number } };
      assert.equal(parsed.accepted, true);
      assert.equal(parsed.deduped, false);
      assert.equal(parsed.planSummary.pending, 2);

      const replay = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'add_subgoal',
        '--title', 'Add steering telemetry',
        '--objective', 'Add explicit steering bridge telemetry evidence to ultragoal.',
        '--evidence', 'structured steer test',
        '--rationale', 'Test should exercise bounded CLI steering path.',
        '--idempotency-key', 'cli-steer-e2e',
        '--json',
      ]));
      const deduped = JSON.parse(replay.stdout.join('\n')) as { deduped: boolean; planSummary: { pending: number } };
      assert.equal(deduped.deduped, true);
      assert.equal(deduped.planSummary.pending, 2);
    });
  });

  it('errors when missing required steering evidence or rationale', async () => {
    await withCwd(async () => {
      await capture(() => ultragoalCommand(['create-goals', '--brief', '- Add and steer goal']));
      const result = await capture(() => ultragoalCommand([
        'steer',
        '--kind', 'add_subgoal',
        '--title', 'No evidence',
        '--objective', 'Missing evidence and rationale should fail.',
      ]));
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.join('\n'), /Missing --evidence/);
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
      assert.match(mismatch.stderr.join('\n'), /Codex goal context/);
      assert.doesNotMatch(mismatch.stderr.join('\n'), /fresh (?:Codex )?(?:thread|session)s?/i);

      const unavailable = await capture(() => ultragoalCommand([
        'checkpoint',
        '--goal-id', 'G001-first-milestone',
        '--status', 'complete',
        '--evidence', 'tests passed',
        '--codex-goal-json', '{"error":"SqliteError: no such table: thread_goals"}',
      ]));
      assert.equal(unavailable.exitCode, 1);
      assert.match(unavailable.stderr.join('\n'), /DB\/schema\/context error/);
      assert.match(unavailable.stderr.join('\n'), /strict completion reconciliation can be proven/);
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

  it('circuit-breaks repeated GHCR authorization blockers and skips them on retry-failed', async () => {
    await withCwd(async (cwd) => {
      const ghcrBlocker = [
        'GHCR_USERNAME/GHCR_READ_TOKEN/GHCR_BEARER_TOKEN unset;',
        'gh auth scopes omit read:packages;',
        'package API returns HTTP 403 requiring read:packages;',
        'anonymous image verifier returns HTTP 401 authentication required.',
      ].join(' ');

      await capture(() => ultragoalCommand(['create-goals', '--brief', '- Prove GHCR smoke service']));
      await capture(() => ultragoalCommand(['complete-goals']));

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const checkpoint = await capture(() => ultragoalCommand([
          'checkpoint',
          '--goal-id', 'G001-prove-ghcr-smoke-service',
          '--status', 'failed',
          '--evidence', ghcrBlocker,
          '--json',
        ]));
        assert.equal(checkpoint.exitCode, undefined);
        const parsed = JSON.parse(checkpoint.stdout.join('\n')) as {
          plan: { goals: Array<{ status: string; blockerOccurrenceCount?: number; requiredExternalDecision?: string; nonRetriable?: boolean }> };
          summary: { failed: number; needsUserDecision: number };
        };
        const goal = parsed.plan.goals[0];
        if (attempt < 3) {
          assert.equal(goal.status, 'failed');
          assert.equal(parsed.summary.failed, 1);
          assert.equal(parsed.summary.needsUserDecision, 0);
          await capture(() => ultragoalCommand(['complete-goals', '--retry-failed']));
        } else {
          assert.equal(goal.status, 'needs_user_decision');
          assert.equal(goal.blockerOccurrenceCount, 3);
          assert.equal(goal.nonRetriable, true);
          assert.match(goal.requiredExternalDecision ?? '', /make the GHCR package public/);
          assert.equal(parsed.summary.failed, 0);
          assert.equal(parsed.summary.needsUserDecision, 1);
        }
      }

      const retry = await capture(() => ultragoalCommand(['complete-goals', '--retry-failed']));
      const output = retry.stdout.join('\n');
      assert.doesNotMatch(output, /Ultragoal aggregate-goal handoff/);
      assert.match(output, /blocked on repeated external authorization/);
      assert.match(output, /Required external decision: make the GHCR package public/);
      assert.match(output, /Do not run complete-goals --retry-failed again/);

      const plan = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as { activeGoalId?: string; goals: Array<{ status: string; nonRetriable?: boolean }> };
      assert.equal(plan.activeGoalId, undefined);
      assert.equal(plan.goals[0].status, 'needs_user_decision');
      assert.equal(plan.goals[0].nonRetriable, true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_needs_user_decision"/);
      assert.match(ledger, /GHCR_PULL_ACCESS/);
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
