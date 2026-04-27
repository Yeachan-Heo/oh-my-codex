import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleTeamWorkerPostToolUseSuccess, teamWorkerPostToolUseInternals } from '../team-worker-posttooluse.js';
import { readTeamEvents } from '../../../team/state/events.js';

async function initWorkerFixture(): Promise<{ cwd: string; stateRoot: string; env: NodeJS.ProcessEnv }> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-posttooluse-worker-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });

  const stateRoot = join(cwd, '.omx', 'state');
  const workerDir = join(stateRoot, 'team', 'demo-team', 'workers', 'worker-1');
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, 'identity.json'), JSON.stringify({
    name: 'worker-1',
    team_state_root: stateRoot,
    worktree_path: cwd,
  }, null, 2), 'utf-8');
  await writeFile(join(stateRoot, 'team', 'demo-team', 'phase.json'), JSON.stringify({ current_phase: 'team-exec' }, null, 2), 'utf-8');
  await writeFile(join(stateRoot, 'team', 'demo-team', 'config.json'), JSON.stringify({ leader_cwd: cwd }, null, 2), 'utf-8');
  return {
    cwd,
    stateRoot,
    env: {
      ...process.env,
      OMX_TEAM_WORKER: 'demo-team/worker-1',
      OMX_TEAM_STATE_ROOT: stateRoot,
    },
  };
}

const successPayload = {
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_response: { exit_code: 0 },
  tool_use_id: 'tool-1',
};

describe('handleTeamWorkerPostToolUseSuccess', () => {
  it('creates a safe worker checkpoint, ledger entries, leader signal, and dedupe marker', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'feature.txt'), 'feature\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    assert.equal(result.handled, true);
    assert.equal(result.status, 'applied');
    assert.ok(result.checkpointCommit);
    assert.deepEqual(result.operationKinds, ['auto_checkpoint', 'worker_clean_rebase', 'leader_integration_attempt']);

    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    assert.equal(log, 'omx(team): auto-checkpoint worker-1');

    const events = await readTeamEvents('demo-team', fixture.cwd, { type: 'worker_integration_attempt_requested' });
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, 'worker_integration_attempt_requested');
    assert.equal(event.worker, 'worker-1');
    const metadata = event.metadata as Record<string, unknown>;
    assert.equal(metadata.operation_kind, 'leader_integration_attempt');
    assert.equal(metadata.outcome_status, 'applied');
    assert.equal(metadata.source, 'posttooluse');
    assert.equal(metadata.dedupe_key, result.dedupeKey);
    assert.match(String(metadata.leader_head_observed), /^[0-9a-f]{40}$/);

    const dedupe = JSON.parse(await readFile(join(fixture.stateRoot, 'team', 'demo-team', 'workers', 'worker-1', 'posttooluse-dedupe.json'), 'utf-8')) as { keys: string[] };
    assert.equal(dedupe.keys.includes(result.dedupeKey!), true);

    const ledger = JSON.parse(await readFile(join(fixture.cwd, '.omx', 'reports', 'team-commit-hygiene', 'demo-team.ledger.json'), 'utf-8')) as { entries: Array<{ operation: string; status: string }> };
    assert.equal(ledger.entries.some((entry) => entry.operation === 'auto_checkpoint' && entry.status === 'applied'), true);
    assert.equal(ledger.entries.some((entry) => entry.operation === 'worker_clean_rebase' && entry.status === 'noop'), true);
    assert.equal(ledger.entries.some((entry) => entry.operation === 'leader_integration_attempt' && entry.status === 'applied'), true);
  });

  it('records noop without creating a checkpoint commit', async () => {
    const fixture = await initWorkerFixture();
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    assert.equal(result.status, 'noop');
    assert.equal(result.checkpointCommit, null);
    assert.equal(after, before);
  });

  it('skips protected runtime-only changes', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'AGENTS.md'), 'generated worker instructions\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'only_protected_paths_changed');
    assert.equal(result.checkpointCommit, null);
  });

  it('does not checkpoint its own runtime report artifacts on a repeated PostToolUse turn', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'feature.txt'), 'feature\n', 'utf-8');

    const first = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);
    const headAfterFirst = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    const second = await handleTeamWorkerPostToolUseSuccess({ ...successPayload, tool_use_id: 'tool-2' }, fixture.cwd, fixture.env);
    const headAfterSecond = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    const events = await readTeamEvents('demo-team', fixture.cwd, { type: 'worker_integration_attempt_requested' });

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'noop');
    assert.equal(headAfterSecond, headAfterFirst);
    assert.equal(events.length, 1);
  });

  it('skips checkpointing when the index is already staged and preserves staged changes', async () => {
    const fixture = await initWorkerFixture();
    await writeFile(join(fixture.cwd, 'pre-staged.txt'), 'already staged\n', 'utf-8');
    execFileSync('git', ['add', 'pre-staged.txt'], { cwd: fixture.cwd, stdio: 'ignore' });
    await writeFile(join(fixture.cwd, 'unstaged.txt'), 'new work\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);
    const staged = execFileSync('git', ['diff', '--name-only', '--cached'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);
    const status = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: fixture.cwd, encoding: 'utf-8' });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'index_not_clean');
    assert.deepEqual(staged, ['pre-staged.txt']);
    assert.match(status, /\?\? unstaged\.txt/);
  });

  it('unstages checkpointable paths when checkpoint commit fails after staging', async () => {
    const fixture = await initWorkerFixture();
    const hookPath = join(fixture.cwd, '.git', 'hooks', 'prepare-commit-msg');
    await writeFile(hookPath, '#!/bin/sh\nexit 42\n', 'utf-8');
    await chmod(hookPath, 0o755);
    await writeFile(join(fixture.cwd, 'commit-fail.txt'), 'must not remain staged\n', 'utf-8');

    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, fixture.cwd, fixture.env);
    const staged = execFileSync('git', ['diff', '--name-only', '--cached'], { cwd: fixture.cwd, encoding: 'utf-8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: fixture.cwd, encoding: 'utf-8' });

    assert.equal(result.status, 'skipped');
    assert.match(result.reason ?? '', /^git_commit_failed:/);
    assert.equal(staged, '');
    assert.match(status, /\?\? commit-fail\.txt/);
  });

  it('exports canonical dedupe and protected-path helpers for fallback suppression', () => {
    const key = teamWorkerPostToolUseInternals.buildDedupeKey({
      teamName: 'team',
      workerName: 'worker-1',
      workerHeadAfter: 'after',
      operationKind: 'leader_integration_attempt',
    });
    assert.equal(key, 'team|worker-1|after|leader_integration_attempt');
    assert.equal(teamWorkerPostToolUseInternals.isProtectedCheckpointPath('.omx/state/team/x'), true);
    assert.equal(teamWorkerPostToolUseInternals.isProtectedCheckpointPath('src/index.ts'), false);
  });

  it('fails closed for missing worker identity without guessed state writes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-posttooluse-missing-identity-'));
    const result = await handleTeamWorkerPostToolUseSuccess(successPayload, cwd, {
      ...process.env,
      OMX_TEAM_WORKER: 'demo-team/worker-1',
      OMX_TEAM_STATE_ROOT: join(cwd, '.omx', 'state'),
    });

    assert.equal(result.handled, false);
    assert.equal(result.status, 'skipped');
    assert.equal(existsSync(join(cwd, '.omx', 'state', 'team')), false);
  });
});
