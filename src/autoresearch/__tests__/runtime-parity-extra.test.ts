import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutoresearchMissionContract } from '../contracts.js';
import {
  assertResetSafeWorktree,
  decideAutoresearchOutcome,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
  resumeAutoresearchRuntime,
} from '../runtime.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-parity-extra-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function makeContract(repo: string, keepPolicy?: 'score_improvement' | 'pass_only'): Promise<AutoresearchMissionContract> {
  const missionDir = join(repo, 'missions', 'demo');
  await mkdir(missionDir, { recursive: true });
  await mkdir(join(repo, 'scripts'), { recursive: true });
  const missionFile = join(missionDir, 'mission.md');
  const sandboxFile = join(missionDir, 'sandbox.md');
  const missionContent = '# Mission\nSolve the task.\n';
  const keepPolicyLine = keepPolicy ? `  keep_policy: ${keepPolicy}\n` : '';
  const sandboxContent = `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n${keepPolicyLine}---\nStay inside the mission boundary.\n`;
  await writeFile(missionFile, missionContent, 'utf-8');
  await writeFile(sandboxFile, sandboxContent, 'utf-8');
  await writeFile(join(repo, 'score.txt'), '1\n', 'utf-8');
  await writeFile(join(repo, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: true, score: 1 }));\n", 'utf-8');
  execFileSync('git', ['add', 'missions/demo/mission.md', 'missions/demo/sandbox.md', 'scripts/eval.js', 'score.txt'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add autoresearch fixtures'], { cwd: repo, stdio: 'ignore' });
  return {
    missionDir,
    repoRoot: repo,
    missionFile,
    sandboxFile,
    missionRelativeDir: 'missions/demo',
    missionContent,
    sandboxContent,
    sandbox: {
      frontmatter: { evaluator: { command: 'node scripts/eval.js', format: 'json', ...(keepPolicy ? { keep_policy: keepPolicy } : {}) } },
      evaluator: { command: 'node scripts/eval.js', format: 'json', ...(keepPolicy ? { keep_policy: keepPolicy } : {}) },
      body: 'Stay inside the mission boundary.',
    },
    missionSlug: 'missions-demo',
  };
}

describe('autoresearch runtime parity extras', () => {
  it('treats allowed runtime files as reset-safe and blocks unrelated dirt', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t020000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t020000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T020000Z' });

      await writeFile(join(worktreePath, 'results.tsv'), 'iteration\tcommit\tpass\tscore\tstatus\tdescription\n', 'utf-8');
      await writeFile(join(worktreePath, 'run.log'), 'ok\n', 'utf-8');
      assert.doesNotThrow(() => assertResetSafeWorktree(worktreePath));

      await writeFile(join(worktreePath, 'scratch.tmp'), 'nope\n', 'utf-8');
      assert.throws(() => assertResetSafeWorktree(worktreePath), /autoresearch_reset_requires_clean_worktree/i);

      const manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      assert.equal(manifest.results_file, join(worktreePath, 'results.tsv'));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects concurrent fresh runs via the repo-root active-run lock', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePathA = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t030000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t030000z', worktreePathA, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContractA = await materializeAutoresearchMissionToWorktree(contract, worktreePathA);
      const runtimeA = await prepareAutoresearchRuntime(worktreeContractA, repo, worktreePathA, { runTag: '20260314T030000Z' });

      const worktreePathB = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t030500z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t030500z', worktreePathB, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContractB = await materializeAutoresearchMissionToWorktree(contract, worktreePathB);

      await assert.rejects(
        () => prepareAutoresearchRuntime(worktreeContractB, repo, worktreePathB, { runTag: '20260314T030500Z' }),
        /autoresearch_active_run_exists/i,
      );
      assert.equal(existsSync(runtimeA.manifestFile), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('resumes a running manifest and rejects missing worktrees', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t040000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t040000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T040000Z' });
      const statePath = join(repo, '.omx', 'state', 'autoresearch-state.json');
      const idleState = {
        schema_version: 1,
        active: false,
        run_id: runtime.runId,
        mission_slug: contract.missionSlug,
        repo_root: repo,
        worktree_path: worktreePath,
        status: 'idle',
        updated_at: '2026-03-14T04:05:00.000Z',
      };
      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');

      const resumed = await resumeAutoresearchRuntime(repo, runtime.runId);
      assert.equal(resumed.runId, runtime.runId);
      assert.equal(resumed.worktreePath, worktreePath);

      await writeFile(statePath, `${JSON.stringify(idleState, null, 2)}\n`, 'utf-8');
      await rm(worktreePath, { recursive: true, force: true });
      await assert.rejects(
        () => resumeAutoresearchRuntime(repo, runtime.runId),
        /autoresearch_resume_missing_worktree/i,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('decides ambiguous vs keep based on keep_policy semantics', () => {
    const candidate = {
      status: 'candidate' as const,
      candidate_commit: 'abc1234',
      base_commit: 'base1234',
      description: 'candidate',
      notes: [],
      created_at: '2026-03-14T05:00:00.000Z',
    };

    const ambiguous = decideAutoresearchOutcome(
      { keep_policy: 'score_improvement', last_kept_score: null },
      candidate,
      { command: 'node eval.js', ran_at: '2026-03-14T05:00:01.000Z', status: 'pass', pass: true, exit_code: 0 },
    );
    assert.equal(ambiguous.decision, 'ambiguous');
    assert.equal(ambiguous.keep, false);

    const kept = decideAutoresearchOutcome(
      { keep_policy: 'pass_only', last_kept_score: null },
      candidate,
      { command: 'node eval.js', ran_at: '2026-03-14T05:00:01.000Z', status: 'pass', pass: true, exit_code: 0 },
    );
    assert.equal(kept.decision, 'keep');
    assert.equal(kept.keep, true);
  });

  it('resume rejects terminal manifests', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t050000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t050000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T050000Z' });
      const manifest = JSON.parse(await readFile(runtime.manifestFile, 'utf-8')) as Record<string, unknown>;
      manifest.status = 'completed';
      await writeFile(runtime.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
      await writeFile(join(repo, '.omx', 'state', 'autoresearch-state.json'), `${JSON.stringify({
        schema_version: 1,
        active: false,
        run_id: runtime.runId,
        mission_slug: contract.missionSlug,
        repo_root: repo,
        worktree_path: worktreePath,
        status: 'completed',
        updated_at: '2026-03-14T05:05:00.000Z',
      }, null, 2)}\n`, 'utf-8');

      await assert.rejects(
        () => resumeAutoresearchRuntime(repo, runtime.runId),
        /autoresearch_resume_terminal_run/i,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('records noop and abort candidate branches explicitly', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t060000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t060000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T060000Z' });

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'noop',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'no useful change',
        notes: ['noop branch'],
        created_at: '2026-03-14T06:01:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'noop');

      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'abort',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'operator stop',
        notes: ['abort branch'],
        created_at: '2026-03-14T06:02:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'abort');

      const results = await readFile(runtime.resultsFile, 'utf-8');
      assert.match(results, /^1\t.+\t\t\tnoop\tno useful change$/m);
      assert.match(results, /^2\t.+\t\t\tabort\toperator stop$/m);

      const finalManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      assert.equal(finalManifest.status, 'stopped');
      assert.equal(finalManifest.stop_reason, 'candidate abort');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects candidate integrity mismatches and missing candidate artifacts with actionable failure state', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t070000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t070000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T070000Z' });

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'invalid candidate',
        notes: ['missing commit'],
        created_at: '2026-03-14T07:01:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'error');

      let failedManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      assert.equal(failedManifest.status, 'failed');
      assert.match(failedManifest.stop_reason || '', /non-null candidate_commit/i);

      const failureResults = await readFile(runtime.resultsFile, 'utf-8');
      assert.match(failureResults, /^1\t.+\t\t\terror\tinvalid candidate$/m);

      const secondWorktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t071000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t071000z', secondWorktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const secondContract = await materializeAutoresearchMissionToWorktree(contract, secondWorktreePath);
      const secondRuntime = await prepareAutoresearchRuntime(secondContract, repo, secondWorktreePath, { runTag: '20260314T071000Z' });

      manifest = await loadAutoresearchRunManifest(repo, secondRuntime.runId);
      await writeFile(secondRuntime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: manifest.last_kept_commit,
        base_commit: 'deadbeef',
        description: 'mismatched base',
        notes: ['bad base'],
        created_at: '2026-03-14T07:02:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(secondContract, manifest, repo), 'error');

      failedManifest = await loadAutoresearchRunManifest(repo, secondRuntime.runId);
      assert.equal(failedManifest.status, 'failed');
      assert.match(failedManifest.stop_reason || '', /base_commit/i);

      const thirdWorktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t072000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t072000z', thirdWorktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const thirdContract = await materializeAutoresearchMissionToWorktree(contract, thirdWorktreePath);
      const thirdRuntime = await prepareAutoresearchRuntime(thirdContract, repo, thirdWorktreePath, { runTag: '20260314T072000Z' });

      manifest = await loadAutoresearchRunManifest(repo, thirdRuntime.runId);
      await rm(thirdRuntime.candidateFile, { force: true });
      assert.equal(await processAutoresearchCandidate(thirdContract, manifest, repo), 'error');
      failedManifest = await loadAutoresearchRunManifest(repo, thirdRuntime.runId);
      assert.equal(failedManifest.status, 'failed');
      assert.match(failedManifest.stop_reason || '', /autoresearch_candidate_missing/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('handles interrupted, evaluator failure, and evaluator parse-error branches', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t080000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t080000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T080000Z' });

      let manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'interrupted',
        candidate_commit: null,
        base_commit: manifest.last_kept_commit,
        description: 'clean interrupt',
        notes: ['ctrl-c'],
        created_at: '2026-03-14T08:01:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'interrupted');

      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(join(worktreePath, 'scripts', 'eval.js'), "process.stdout.write(JSON.stringify({ pass: false, score: 0 }));\n", 'utf-8');
      await writeFile(join(worktreePath, 'score.txt'), '0\n', 'utf-8');
      execFileSync('git', ['add', 'scripts/eval.js', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'make evaluator fail'], { cwd: worktreePath, stdio: 'ignore' });
      const failingCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: failingCommit,
        base_commit: manifest.last_kept_commit,
        description: 'failing evaluator branch',
        notes: ['pass false'],
        created_at: '2026-03-14T08:02:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'discard');

      manifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(join(worktreePath, 'scripts', 'eval.js'), "process.stdout.write('not json');\n", 'utf-8');
      execFileSync('git', ['add', 'scripts/eval.js'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'break evaluator json'], { cwd: worktreePath, stdio: 'ignore' });
      const parseErrorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: parseErrorCommit,
        base_commit: manifest.last_kept_commit,
        description: 'parse error branch',
        notes: ['invalid json'],
        created_at: '2026-03-14T08:03:00.000Z',
      }, null, 2)}\n`, 'utf-8');
      assert.equal(await processAutoresearchCandidate(worktreeContract, manifest, repo), 'discard');

      const results = await readFile(runtime.resultsFile, 'utf-8');
      assert.match(results, /^1\t.+\t\t\tinterrupted\tclean interrupt$/m);
      assert.match(results, /^2\t.+\tfalse\t0\tdiscard\tfailing evaluator branch$/m);
      assert.match(results, /^3\t.+\t\t\tdiscard\tparse error branch$/m);

      const ledger = JSON.parse(await readFile(runtime.ledgerFile, 'utf-8')) as {
        entries: Array<{ decision: string; decision_reason: string }>;
      };
      assert.equal(ledger.entries[1]?.decision, 'interrupted');
      assert.equal(ledger.entries[2]?.decision, 'discard');
      assert.equal(ledger.entries[3]?.decision, 'discard');
      assert.match(ledger.entries[3]?.decision_reason || '', /evaluator error/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
