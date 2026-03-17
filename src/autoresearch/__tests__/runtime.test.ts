import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AutoresearchMissionContract } from '../contracts.js';
import {
  assertResetSafeWorktree,
  buildAutoresearchInstructions,
  loadAutoresearchRunManifest,
  materializeAutoresearchMissionToWorktree,
  prepareAutoresearchRuntime,
  processAutoresearchCandidate,
} from '../runtime.js';
import { readModeState } from '../../modes/base.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-autoresearch-runtime-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

async function makeContract(repo: string): Promise<AutoresearchMissionContract> {
  const missionDir = join(repo, 'missions', 'demo');
  await mkdir(missionDir, { recursive: true });
  await mkdir(join(repo, 'scripts'), { recursive: true });
  const missionFile = join(missionDir, 'mission.md');
  const sandboxFile = join(missionDir, 'sandbox.md');
  const missionContent = '# Mission\nSolve the task.\n';
  const sandboxContent = `---\nevaluator:\n  command: node scripts/eval.js\n  format: json\n---\nStay inside the mission boundary.\n`;
  await writeFile(missionFile, missionContent, 'utf-8');
  await writeFile(sandboxFile, sandboxContent, 'utf-8');
  await writeFile(join(repo, 'score.txt'), '1\n', 'utf-8');
  await writeFile(join(repo, 'scripts', 'eval.js'), "import { readFileSync } from 'node:fs';\nconst score = Number(readFileSync('score.txt', 'utf-8').trim());\nprocess.stdout.write(JSON.stringify({ pass: true, score }));\n", 'utf-8');
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
      frontmatter: { evaluator: { command: 'node scripts/eval.js', format: 'json' } },
      evaluator: { command: 'node scripts/eval.js', format: 'json' },
      body: 'Stay inside the mission boundary.',
    },
    missionSlug: 'missions-demo',
  };
}

describe('autoresearch runtime', () => {
  it('builds bootstrap instructions with mission, sandbox, and evaluator contract', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const instructions = buildAutoresearchInstructions(contract, { runId: 'missions-demo-20260314t000000z', iteration: 1, baselineCommit: 'abc1234', lastKeptCommit: 'abc1234', resultsFile: 'results.tsv', candidateFile: '.omx/logs/autoresearch/missions-demo-20260314t000000z/candidate.json', keepPolicy: 'score_improvement' });
      assert.match(instructions, /exactly one experiment cycle/i);
      assert.match(instructions, /required output field: pass/i);
      assert.match(instructions, /optional output field: score/i);
      assert.match(instructions, /Iteration state snapshot:/i);
      assert.match(instructions, /Mission file:/i);
      assert.match(instructions, /Sandbox policy:/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('allows untracked .omx runtime files when checking reset safety', async () => {
    const repo = await initRepo();
    try {
      await mkdir(join(repo, '.omx', 'logs'), { recursive: true });
      await mkdir(join(repo, '.omx', 'state'), { recursive: true });
      await writeFile(join(repo, '.omx', 'logs', 'hooks-2026-03-15.jsonl'), '{}\n', 'utf-8');
      await writeFile(join(repo, '.omx', 'metrics.json'), '{}\n', 'utf-8');
      await writeFile(join(repo, '.omx', 'state', 'hud-state.json'), '{}\n', 'utf-8');

      assert.doesNotThrow(() => assertResetSafeWorktree(repo));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('prepares runtime artifacts and persists autoresearch mode state', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      await mkdir(join(repo, 'node_modules', 'fixture-dep'), { recursive: true });
      await writeFile(join(repo, 'node_modules', 'fixture-dep', 'index.js'), 'export default 1;\n', 'utf-8');
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t000000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t000000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T000000Z' });

      assert.equal(existsSync(worktreeContract.missionFile), true);
      assert.equal(existsSync(worktreeContract.sandboxFile), true);
      assert.equal(existsSync(runtime.instructionsFile), true);
      assert.equal(existsSync(runtime.manifestFile), true);
      assert.equal(existsSync(runtime.ledgerFile), true);
      assert.equal(existsSync(runtime.latestEvaluatorFile), true);
      assert.equal(existsSync(runtime.resultsFile), true);
      assert.equal(existsSync(join(worktreePath, 'node_modules')), true);
      assert.doesNotThrow(() => assertResetSafeWorktree(worktreePath));

      const manifest = JSON.parse(await readFile(runtime.manifestFile, 'utf-8')) as Record<string, unknown>;
      assert.equal(manifest.mission_slug, 'missions-demo');
      assert.equal(manifest.branch_name, 'autoresearch/missions-demo/20260314t000000z');
      assert.equal(manifest.mission_dir, join(worktreePath, 'missions', 'demo'));
      assert.equal(manifest.worktree_path, worktreePath);
      assert.equal(manifest.results_file, runtime.resultsFile);
      assert.equal(typeof manifest.baseline_commit, 'string');

      const ledger = JSON.parse(await readFile(runtime.ledgerFile, 'utf-8')) as Record<string, unknown>;
      assert.equal(Array.isArray(ledger.entries), true);
      assert.equal((ledger.entries as unknown[]).length, 1);

      const latestEvaluator = JSON.parse(await readFile(runtime.latestEvaluatorFile, 'utf-8')) as Record<string, unknown>;
      assert.equal(latestEvaluator.status, 'pass');
      assert.equal(latestEvaluator.pass, true);
      assert.equal(latestEvaluator.score, 1);

      const results = await readFile(runtime.resultsFile, 'utf-8');
      assert.match(results, /^iteration	commit	pass	score	status	description$/m);
      assert.match(results, /^0	.+	true	1	baseline	initial baseline evaluation$/m);

      const state = await readModeState('autoresearch', repo);
      assert.ok(state);

      const worktreeState = await readModeState('autoresearch', worktreePath);
      assert.equal(worktreeState, null);
      assert.equal(state?.active, true);
      assert.equal(state?.current_phase, 'running');
      assert.equal(state?.mission_slug, 'missions-demo');
      assert.equal(state?.mission_dir, join(worktreePath, 'missions', 'demo'));
      assert.equal(state?.worktree_path, worktreePath);
      assert.equal(state?.bootstrap_instructions_path, runtime.instructionsFile);
      assert.equal(state?.latest_evaluator_status, 'pass');
      assert.equal(state?.results_file, runtime.resultsFile);
      assert.equal(state?.baseline_commit, manifest.baseline_commit);

      const instructions = await readFile(runtime.instructionsFile, 'utf-8');
      assert.match(instructions, /Last kept score:\s+1/i);
      assert.match(instructions, /previous_iteration_outcome/i);
      assert.match(instructions, /baseline established/i);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});


describe('autoresearch parity decisions', () => {
  it('keeps improved candidates and resets discarded candidates back to the last kept commit', async () => {
    const repo = await initRepo();
    try {
      const contract = await makeContract(repo);
      const worktreePath = join(repo, '.omx', 'worktrees', 'autoresearch-missions-demo-20260314t010000z');
      execFileSync('git', ['worktree', 'add', '-b', 'autoresearch/missions-demo/20260314t010000z', worktreePath, 'HEAD'], {
        cwd: repo,
        stdio: 'ignore',
      });
      const worktreeContract = await materializeAutoresearchMissionToWorktree(contract, worktreePath);
      const runtime = await prepareAutoresearchRuntime(worktreeContract, repo, worktreePath, { runTag: '20260314T010000Z' });

      await writeFile(join(worktreePath, 'score.txt'), '2\n', 'utf-8');
      execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'improve score'], { cwd: worktreePath, stdio: 'ignore' });
      const improvedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      const initialManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: improvedCommit,
        base_commit: initialManifest.last_kept_commit,
        description: 'improved score',
        notes: ['score raised to 2'],
        created_at: '2026-03-14T01:00:00.000Z',
      }, null, 2)}\n`, 'utf-8');

      const keepDecision = await processAutoresearchCandidate(worktreeContract, initialManifest, repo);
      assert.equal(keepDecision, 'keep');
      const keptManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      assert.equal(keptManifest.last_kept_commit, improvedCommit);

      await writeFile(join(worktreePath, 'score.txt'), '1\n', 'utf-8');
      execFileSync('git', ['add', 'score.txt'], { cwd: worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worse score'], { cwd: worktreePath, stdio: 'ignore' });
      const worseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      const beforeDiscardManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      await writeFile(runtime.candidateFile, `${JSON.stringify({
        status: 'candidate',
        candidate_commit: worseCommit,
        base_commit: beforeDiscardManifest.last_kept_commit,
        description: 'worse score',
        notes: ['score dropped back to 1'],
        created_at: '2026-03-14T01:05:00.000Z',
      }, null, 2)}\n`, 'utf-8');

      const discardDecision = await processAutoresearchCandidate(worktreeContract, beforeDiscardManifest, repo);
      assert.equal(discardDecision, 'discard');
      const headAfterDiscard = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath, encoding: 'utf-8' }).trim();
      assert.equal(headAfterDiscard, improvedCommit);

      const finalManifest = await loadAutoresearchRunManifest(repo, runtime.runId);
      const results = await readFile(runtime.resultsFile, 'utf-8');
      assert.match(results, /^1\t.+\ttrue\t2\tkeep\timproved score$/m);
      assert.match(results, /^2\t.+\ttrue\t1\tdiscard\tworse score$/m);

      const ledger = JSON.parse(await readFile(runtime.ledgerFile, 'utf-8')) as {
        entries: Array<{ decision: string; description: string }>;
      };
      assert.equal(ledger.entries.length, 3);
      assert.deepEqual(
        ledger.entries.map((entry) => [entry.decision, entry.description]),
        [
          ['baseline', 'initial baseline evaluation'],
          ['keep', 'improved score'],
          ['discard', 'worse score'],
        ],
      );

      const instructions = await readFile(runtime.instructionsFile, 'utf-8');
      assert.match(instructions, /"previous_iteration_outcome": "discard:score did not improve"/);
      assert.match(instructions, /"decision": "keep"/);
      assert.match(instructions, /"decision": "discard"/);
      assert.equal(finalManifest.last_kept_commit, improvedCommit);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
