import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV } from '../autopilot-wait.js';
import { evaluateQuestionPolicy } from '../policy.js';

const tempDirs: string[] = [];
const originalOmxRoot = process.env.OMX_ROOT;
const originalOmxStateRoot = process.env.OMX_STATE_ROOT;
const originalOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-question-policy-'));
  tempDirs.push(cwd);
  process.env.OMX_ROOT = cwd;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  return cwd;
}

after(async () => {
  if (originalOmxRoot === undefined) delete process.env.OMX_ROOT;
  else process.env.OMX_ROOT = originalOmxRoot;
  if (originalOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
  else process.env.OMX_STATE_ROOT = originalOmxStateRoot;
  if (originalOmxTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
  else process.env.OMX_TEAM_STATE_ROOT = originalOmxTeamStateRoot;
  await Promise.all(tempDirs.splice(0).map((dir) => import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }))));
});

describe('evaluateQuestionPolicy', { concurrency: false }, () => {
  it('allows non-team leader sessions with no blocked modes', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-1' }));
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-1', env: { ...process.env, OMX_TEAM_WORKER: '' } });
    assert.equal(result.allowed, true);
  });

  it('blocks worker contexts immediately', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-1', env: { ...process.env, OMX_TEAM_WORKER: 'demo/worker-1' } });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'worker_blocked');
    assert.equal(result.fallbackAllowed, false);
  });

  it('blocks canonical active team ownership for the current session', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const teamRoot = join(cwd, '.omx', 'state', 'team', 'alpha');
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'manifest.v2.json'), JSON.stringify({
      schema_version: 2,
      name: 'alpha',
      task: 'demo',
      leader: { session_id: 'sess-team', worker_id: 'leader-fixed', role: 'coordinator' },
      policy: { display_mode: 'auto', worker_launch_mode: 'interactive', dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 2000 },
      governance: { approvals: 'leader', merge_strategy: 'sequential' },
      lifecycle_profile: 'default',
      permissions_snapshot: { sandbox_mode: 'workspace-write', approval_policy: 'never' },
      tmux_session: 'alpha:0',
      worker_count: 1,
      workers: [],
      next_task_id: 1,
      created_at: new Date().toISOString(),
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));
    await writeFile(join(teamRoot, 'phase.json'), JSON.stringify({ current_phase: 'team-exec', max_fix_attempts: 3, current_fix_attempt: 0, transitions: [], updated_at: new Date().toISOString() }));
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-team' }));
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-team', env: { ...process.env, OMX_TEAM_WORKER: '' } });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'team_blocked');
    assert.equal(result.fallbackAllowed, false);
  });

  it('blocks active execution-like workflows for the current session', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-ralph');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({ mode: 'ralph', active: true }));
    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-ralph' }));
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-ralph', env: { ...process.env, OMX_TEAM_WORKER: '' } });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'active_execution_mode_blocked');
    assert.equal(result.fallbackAllowed, false);
  });

  it('does not falsely block from another session team state', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const teamRoot = join(cwd, '.omx', 'state', 'team', 'beta');
    await mkdir(teamRoot, { recursive: true });
    await writeFile(join(teamRoot, 'manifest.v2.json'), JSON.stringify({
      schema_version: 2,
      name: 'beta',
      task: 'demo',
      leader: { session_id: 'sess-other', worker_id: 'leader-fixed', role: 'coordinator' },
      policy: { display_mode: 'auto', worker_launch_mode: 'interactive', dispatch_mode: 'hook_preferred_with_fallback', dispatch_ack_timeout_ms: 2000 },
      governance: { approvals: 'leader', merge_strategy: 'sequential' },
      lifecycle_profile: 'default',
      permissions_snapshot: { sandbox_mode: 'workspace-write', approval_policy: 'never' },
      tmux_session: 'beta:0',
      worker_count: 1,
      workers: [],
      next_task_id: 1,
      created_at: new Date().toISOString(),
      leader_pane_id: null,
      hud_pane_id: null,
      resize_hook_name: null,
      resize_hook_target: null,
    }));
    await writeFile(join(teamRoot, 'phase.json'), JSON.stringify({ current_phase: 'team-exec', max_fix_attempts: 3, current_fix_attempt: 0, transitions: [], updated_at: new Date().toISOString() }));
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-main', env: { ...process.env, OMX_TEAM_WORKER: '' } });
    assert.equal(result.allowed, true);
  });

  it('allows deep-interview state when no execution-like workflow is active', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({ mode: 'deep-interview', active: true }));
    const result = await evaluateQuestionPolicy({ cwd, explicitSessionId: 'sess-di', env: { ...process.env, OMX_TEAM_WORKER: '' } });
    assert.equal(result.allowed, true);
    assert.equal(result.fallbackAllowed, true);
  });
});

describe('evaluateQuestionPolicy autopilot deep-interview wait', { concurrency: false }, () => {
  it('allows a deep-interview question to start while autopilot is in its deep-interview phase', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-auto-start');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
      mode: 'autopilot',
      active: true,
      current_phase: 'deep-interview',
    }, null, 2));
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'autopilot',
      phase: 'deep-interview',
      active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: 'sess-auto-start' }],
      session_id: 'sess-auto-start',
    }, null, 2));

    const allowed = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto-start',
      questionSource: 'deep-interview',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });
    assert.equal(allowed.allowed, true);

    const unrelatedSource = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto-start',
      questionSource: 'implementation',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });
    assert.equal(unrelatedSource.allowed, false);
    assert.equal(unrelatedSource.code, 'active_execution_mode_blocked');
  });

  it('blocks duplicate deep-interview questions while autopilot is already waiting', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-auto');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
      mode: 'autopilot',
      active: true,
      current_phase: 'waiting-for-user',
      run_outcome: 'blocked_on_user',
      lifecycle_outcome: 'askuserQuestion',
      state: {
        deep_interview_question: {
          status: 'waiting_for_user',
          source: 'omx-question',
          obligation_id: 'obligation-1',
          previous_phase: 'deep-interview',
        },
      },
    }, null, 2));
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'autopilot',
      phase: 'deep-interview',
      active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: 'sess-auto' }],
      session_id: 'sess-auto',
    }, null, 2));

    await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess-auto' }));
    const duplicateQuestion = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto',
      questionSource: 'deep-interview',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });
    assert.equal(duplicateQuestion.allowed, false);
    assert.equal(duplicateQuestion.code, 'active_execution_mode_blocked');

    const owningQuestion = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto',
      questionSource: 'deep-interview',
      env: {
        ...process.env,
        OMX_TEAM_WORKER: '',
        [AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV]: 'obligation-1',
      },
    });
    assert.equal(owningQuestion.allowed, true);

    const wrongOwnerQuestion = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto',
      questionSource: 'deep-interview',
      env: {
        ...process.env,
        OMX_TEAM_WORKER: '',
        [AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV]: 'obligation-other',
      },
    });
    assert.equal(wrongOwnerQuestion.allowed, false);
    assert.equal(wrongOwnerQuestion.code, 'active_execution_mode_blocked');

    const unrelatedSource = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto',
      questionSource: 'implementation',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });
    assert.equal(unrelatedSource.allowed, false);
    assert.equal(unrelatedSource.code, 'active_execution_mode_blocked');

    await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({ mode: 'ralph', active: true }));
    const unrelatedMode = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto',
      questionSource: 'deep-interview',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });
    assert.equal(unrelatedMode.allowed, false);
    assert.equal(unrelatedMode.code, 'active_execution_mode_blocked');
  });

  it('rejects malformed autopilot waits that are not for the deep-interview child phase', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-auto-ralplan-wait');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
      mode: 'autopilot',
      active: true,
      current_phase: 'waiting-for-user',
      run_outcome: 'blocked_on_user',
      lifecycle_outcome: 'askuserQuestion',
      state: {
        deep_interview_question: {
          status: 'waiting_for_user',
          source: 'omx-question',
          obligation_id: 'obligation-ralplan',
          previous_phase: 'ralplan',
        },
      },
    }, null, 2));
    await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
      active: true,
      skill: 'autopilot',
      phase: 'ralplan',
      active_skills: [{ skill: 'autopilot', phase: 'ralplan', active: true, session_id: 'sess-auto-ralplan-wait' }],
      session_id: 'sess-auto-ralplan-wait',
    }, null, 2));

    const result = await evaluateQuestionPolicy({
      cwd,
      explicitSessionId: 'sess-auto-ralplan-wait',
      questionSource: 'deep-interview',
      env: { ...process.env, OMX_TEAM_WORKER: '' },
    });

    assert.equal(result.allowed, false);
    assert.equal(result.code, 'active_execution_mode_blocked');
  });
});
