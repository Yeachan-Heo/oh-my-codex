import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { OmxQuestionError, type OmxQuestionProcessRunner } from '../client.js';
import {
  AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV,
  markAutopilotDeepInterviewQuestionWaiting,
  readAutopilotDeepInterviewQuestionWaitState,
} from '../autopilot-wait.js';
import {
  reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords,
  runDeepInterviewQuestion,
} from '../deep-interview.js';

const tempDirs: string[] = [];
const originalOmxRoot = process.env.OMX_ROOT;
const originalOmxStateRoot = process.env.OMX_STATE_ROOT;
const originalOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
const originalQuestionWaitLockTimeout = process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-question-'));
  tempDirs.push(cwd);
  process.env.OMX_ROOT = cwd;
  delete process.env.OMX_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  await mkdir(join(cwd, '.omx', 'state', 'sessions', 'sess-di'), { recursive: true });
  await writeFile(
    join(cwd, '.omx', 'state', 'session.json'),
    JSON.stringify({ session_id: 'sess-di' }, null, 2),
  );
  await writeFile(
    join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json'),
    JSON.stringify({
      active: true,
      mode: 'deep-interview',
      current_phase: 'intent-first',
      started_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
      session_id: 'sess-di',
    }, null, 2),
  );
  return cwd;
}

after(async () => {
  if (originalOmxRoot === undefined) delete process.env.OMX_ROOT;
  else process.env.OMX_ROOT = originalOmxRoot;
  if (originalOmxStateRoot === undefined) delete process.env.OMX_STATE_ROOT;
  else process.env.OMX_STATE_ROOT = originalOmxStateRoot;
  if (originalOmxTeamStateRoot === undefined) delete process.env.OMX_TEAM_STATE_ROOT;
  else process.env.OMX_TEAM_STATE_ROOT = originalOmxTeamStateRoot;
  if (originalQuestionWaitLockTimeout === undefined) delete process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;
  else process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = originalQuestionWaitLockTimeout;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runDeepInterviewQuestion', { concurrency: false }, () => {
  it('tracks a pending obligation before omx question returns and satisfies it afterward', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');
    let inFlightQuestionStatus = '';

    const runner: OmxQuestionProcessRunner = async () => {
      const inFlightState = JSON.parse(await readFile(statePath, 'utf-8')) as {
        question_enforcement?: { status?: string; lifecycle_outcome?: string };
        lifecycle_outcome?: string;
        run_outcome?: string;
        active?: boolean;
      };
      inFlightQuestionStatus = inFlightState.question_enforcement?.status ?? '';
      assert.equal(inFlightState.question_enforcement?.lifecycle_outcome, 'askuserQuestion');
      assert.equal(inFlightState.lifecycle_outcome, 'askuserQuestion');
      assert.equal(inFlightState.run_outcome, 'blocked_on_user');
      assert.equal(inFlightState.active, false);
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          question_id: 'question-1',
          session_id: 'sess-di',
          prompt: {
            question: 'What should happen next?',
            options: [{ label: 'Launch', value: 'launch' }],
            allow_other: false,
            other_label: 'Other',
            multi_select: false,
            source: 'deep-interview',
          },
          answer: {
            kind: 'option',
            value: 'launch',
            selected_labels: ['Launch'],
            selected_values: ['launch'],
          },
        }),
        stderr: '',
      };
    };

    const result = await runDeepInterviewQuestion(
      {
        session_id: 'sess-di',
        question: 'What should happen next?',
        options: [{ label: 'Launch', value: 'launch' }],
        allow_other: false,
      },
      {
        cwd,
        argv1: '/repo/dist/cli/omx.js',
        runner,
      },
    );

    assert.equal(result.question_id, 'question-1');
    assert.equal(inFlightQuestionStatus, 'pending');

    const finalState = JSON.parse(await readFile(statePath, 'utf-8')) as {
      lifecycle_outcome?: string;
      question_enforcement?: {
        obligation_id?: string;
        lifecycle_outcome?: string;
        status?: string;
        question_id?: string;
        satisfied_at?: string;
      };
      run_outcome?: string;
    };
    assert.equal(finalState.question_enforcement?.status, 'satisfied');
    assert.equal(finalState.question_enforcement?.lifecycle_outcome, 'askuserQuestion');
    assert.equal(finalState.question_enforcement?.question_id, 'question-1');
    assert.ok(finalState.question_enforcement?.obligation_id);
    assert.ok(finalState.question_enforcement?.satisfied_at);
    assert.equal(finalState.lifecycle_outcome, undefined);
    assert.equal(finalState.run_outcome, undefined);
  });

  it('clears the pending obligation when omx question fails after being attempted', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');

    await assert.rejects(
      runDeepInterviewQuestion(
        {
          session_id: 'sess-di',
          question: 'What should happen next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd,
          argv1: '/repo/dist/cli/omx.js',
          runner: async () => ({
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              error: {
                code: 'team_blocked',
                message: 'omx question is unavailable while this session owns active team mode.',
              },
            }),
            stderr: '',
          }),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'team_blocked');
        return true;
      },
    );

    const finalState = JSON.parse(await readFile(statePath, 'utf-8')) as {
      lifecycle_outcome?: string;
      question_enforcement?: {
        lifecycle_outcome?: string;
        status?: string;
        clear_reason?: string;
        cleared_at?: string;
      };
      run_outcome?: string;
    };
    assert.equal(finalState.question_enforcement?.status, 'cleared');
    assert.equal(finalState.question_enforcement?.lifecycle_outcome, 'askuserQuestion');
    assert.equal(finalState.question_enforcement?.clear_reason, 'error');
    assert.ok(finalState.question_enforcement?.cleared_at);
    assert.equal(finalState.lifecycle_outcome, undefined);
    assert.equal(finalState.run_outcome, undefined);
  });

  it('clears the pending obligation when question renderer launch fails', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');

    await assert.rejects(
      runDeepInterviewQuestion(
        {
          session_id: 'sess-di',
          question: 'What should happen next?',
          options: [{ label: 'Launch', value: 'launch' }],
          allow_other: false,
        },
        {
          cwd,
          argv1: '/repo/dist/cli/omx.js',
          runner: async () => ({
            code: 1,
            stdout: JSON.stringify({
              ok: false,
              error: {
                code: 'question_runtime_failed',
                message: 'omx question cannot open a visible renderer because this process is outside an attached tmux pane and has no explicit tmux return bridge.',
              },
            }),
            stderr: '',
          }),
        },
      ),
      (error) => {
        assert.ok(error instanceof OmxQuestionError);
        assert.equal(error.code, 'question_runtime_failed');
        return true;
      },
    );

    const finalState = JSON.parse(await readFile(statePath, 'utf-8')) as {
      lifecycle_outcome?: string;
      question_enforcement?: {
        lifecycle_outcome?: string;
        status?: string;
        clear_reason?: string;
        cleared_at?: string;
      };
      run_outcome?: string;
    };
    assert.equal(finalState.question_enforcement?.status, 'cleared');
    assert.equal(finalState.question_enforcement?.lifecycle_outcome, 'askuserQuestion');
    assert.equal(finalState.question_enforcement?.clear_reason, 'error');
    assert.ok(finalState.question_enforcement?.cleared_at);
    assert.equal(finalState.lifecycle_outcome, undefined);
    assert.equal(finalState.run_outcome, undefined);
  });

  it('reconciles a pending obligation from an already-answered same-session question record', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');
    const questionsDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'questions');
    await mkdir(questionsDir, { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        active: false,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        started_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:00:00.000Z',
        completed_at: '2026-04-19T00:00:30.000Z',
        session_id: 'sess-di',
        lifecycle_outcome: 'askuserQuestion',
        run_outcome: 'blocked_on_user',
        question_enforcement: {
          obligation_id: 'obligation-answered-record',
          source: 'omx-question',
          status: 'pending',
          lifecycle_outcome: 'askuserQuestion',
          requested_at: '2026-04-19T00:00:10.000Z',
        },
      }, null, 2),
    );
    await writeFile(
      join(questionsDir, 'question-answered.json'),
      JSON.stringify({
        kind: 'omx.question/v1',
        question_id: 'question-answered',
        session_id: 'sess-di',
        created_at: '2026-04-19T00:00:12.000Z',
        updated_at: '2026-04-19T00:00:20.000Z',
        status: 'answered',
        question: 'What should happen next?',
        options: [{ label: 'Launch', value: 'launch' }],
        allow_other: false,
        other_label: 'Other',
        multi_select: false,
        type: 'single-answerable',
        source: 'deep-interview',
        answer: {
          kind: 'option',
          value: 'launch',
          selected_labels: ['Launch'],
          selected_values: ['launch'],
        },
      }, null, 2),
    );

    const reconciled = await reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords(
      cwd,
      'sess-di',
      new Date('2026-04-19T00:00:21.000Z'),
    );

    assert.equal(reconciled?.question_enforcement?.status, 'satisfied');
    assert.equal(reconciled?.question_enforcement?.question_id, 'question-answered');
    assert.equal(reconciled?.question_enforcement?.satisfied_at, '2026-04-19T00:00:21.000Z');
    assert.equal(reconciled?.lifecycle_outcome, undefined);
    assert.equal(reconciled?.run_outcome, undefined);

    const finalState = JSON.parse(await readFile(statePath, 'utf-8')) as {
      lifecycle_outcome?: string;
      question_enforcement?: {
        status?: string;
        question_id?: string;
        satisfied_at?: string;
      };
      run_outcome?: string;
    };
    assert.equal(finalState.question_enforcement?.status, 'satisfied');
    assert.equal(finalState.question_enforcement?.question_id, 'question-answered');
    assert.equal(finalState.question_enforcement?.satisfied_at, '2026-04-19T00:00:21.000Z');
    assert.equal(finalState.lifecycle_outcome, undefined);
    assert.equal(finalState.run_outcome, undefined);
  });
});

describe('runDeepInterviewQuestion autopilot wait bridge', { concurrency: false }, () => {
  it('does not overwrite an already pending Autopilot deep-interview question', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
    const autopilotPath = join(sessionDir, 'autopilot-state.json');
    await writeFile(autopilotPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      current_phase: 'waiting-for-user',
      run_outcome: 'blocked_on_user',
      lifecycle_outcome: 'askuserQuestion',
      session_id: 'sess-di',
      state: {
        deep_interview_question: {
          status: 'waiting_for_user',
          source: 'omx-question',
          obligation_id: 'obligation-original',
          previous_phase: 'deep-interview',
          requested_at: '2026-04-19T00:00:00.000Z',
        },
      },
    }, null, 2));

    const started = await markAutopilotDeepInterviewQuestionWaiting(cwd, 'sess-di', {
      obligation_id: 'obligation-new',
      source: 'omx-question',
      status: 'pending',
      lifecycle_outcome: 'askuserQuestion',
      requested_at: '2026-04-19T00:01:00.000Z',
    });

    assert.equal(started, false);
    const autopilotState = JSON.parse(await readFile(autopilotPath, 'utf-8')) as {
      state?: { deep_interview_question?: { obligation_id?: string; requested_at?: string } };
    };
    assert.equal(autopilotState.state?.deep_interview_question?.obligation_id, 'obligation-original');
    assert.equal(autopilotState.state?.deep_interview_question?.requested_at, '2026-04-19T00:00:00.000Z');
  });

  it('serializes concurrent Autopilot deep-interview question ownership claims', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
    const autopilotPath = join(sessionDir, 'autopilot-state.json');
    await writeFile(autopilotPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      current_phase: 'deep-interview',
      session_id: 'sess-di',
      state: { deep_interview_gate: { status: 'required' } },
    }, null, 2));

    const obligations = Array.from({ length: 24 }, (_, index) => ({
      obligation_id: `obligation-${index}`,
      source: 'omx-question' as const,
      status: 'pending' as const,
      lifecycle_outcome: 'askuserQuestion' as const,
      requested_at: `2026-04-19T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));

    const results = await Promise.all(
      obligations.map((obligation) => markAutopilotDeepInterviewQuestionWaiting(
        cwd,
        'sess-di',
        obligation,
      )),
    );

    assert.equal(results.filter(Boolean).length, 1);
    const winningObligationIds = obligations
      .filter((_, index) => results[index])
      .map((obligation) => obligation.obligation_id);
    assert.equal(winningObligationIds.length, 1);

    const autopilotState = JSON.parse(await readFile(autopilotPath, 'utf-8')) as {
      current_phase?: string;
      run_outcome?: string;
      lifecycle_outcome?: string;
      state?: { deep_interview_question?: { obligation_id?: string; status?: string } };
    };
    assert.equal(autopilotState.current_phase, 'waiting-for-user');
    assert.equal(autopilotState.run_outcome, 'blocked_on_user');
    assert.equal(autopilotState.lifecycle_outcome, 'askuserQuestion');
    assert.equal(autopilotState.state?.deep_interview_question?.status, 'waiting_for_user');
    assert.equal(
      autopilotState.state?.deep_interview_question?.obligation_id,
      winningObligationIds[0],
    );
  });

  it('blocks instead of prompting when the Autopilot wait claim cannot acquire its lock', { concurrency: false }, async () => {
    const previousTimeout = process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;
    process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = '1';
    try {
      const cwd = await makeRepo();
      const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
      const autopilotPath = join(sessionDir, 'autopilot-state.json');
      await writeFile(autopilotPath, JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
        session_id: 'sess-di',
        state: { deep_interview_gate: { status: 'required' } },
      }, null, 2));
      await mkdir(`${autopilotPath}.deep-interview-question.lock`);

      let runnerCalled = false;
      await assert.rejects(
        runDeepInterviewQuestion(
          { session_id: 'sess-di', question: 'Clarify?', allow_other: true },
          {
            cwd,
            argv1: '/repo/dist/cli/omx.js',
            runner: async () => {
              runnerCalled = true;
              return { code: 1, stdout: '', stderr: '' };
            },
          },
        ),
        (error: unknown) => error instanceof OmxQuestionError
          && error.code === 'active_execution_mode_blocked',
      );

      assert.equal(runnerCalled, false);
      assert.equal(await readAutopilotDeepInterviewQuestionWaitState(cwd, 'sess-di'), null);
      const deepInterviewState = JSON.parse(await readFile(
        join(sessionDir, 'deep-interview-state.json'),
        'utf-8',
      )) as { question_enforcement?: unknown };
      assert.equal(deepInterviewState.question_enforcement, undefined);
    } finally {
      if (previousTimeout === undefined) delete process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS;
      else process.env.OMX_AUTOPILOT_QUESTION_WAIT_LOCK_TIMEOUT_MS = previousTimeout;
    }
  });

  it('fails terminally instead of replacing another pending Autopilot question owner', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
    const autopilotPath = join(sessionDir, 'autopilot-state.json');
    const deepInterviewPath = join(sessionDir, 'deep-interview-state.json');
    await writeFile(autopilotPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      current_phase: 'waiting-for-user',
      run_outcome: 'blocked_on_user',
      lifecycle_outcome: 'askuserQuestion',
      session_id: 'sess-di',
      state: {
        deep_interview_question: {
          status: 'waiting_for_user',
          source: 'omx-question',
          obligation_id: 'obligation-original',
          previous_phase: 'deep-interview',
          requested_at: '2026-04-19T00:00:00.000Z',
        },
      },
    }, null, 2));
    await writeFile(deepInterviewPath, JSON.stringify({
      active: false,
      mode: 'deep-interview',
      session_id: 'sess-di',
      question_enforcement: {
        obligation_id: 'obligation-original',
        source: 'omx-question',
        status: 'pending',
        lifecycle_outcome: 'askuserQuestion',
        requested_at: '2026-04-19T00:00:00.000Z',
      },
    }, null, 2));

    let runnerCalled = false;
    await assert.rejects(
      runDeepInterviewQuestion(
        { session_id: 'sess-di', question: 'Clarify?', allow_other: true },
        {
          cwd,
          argv1: '/repo/dist/cli/omx.js',
          runner: async () => {
            runnerCalled = true;
            return { code: 1, stdout: '', stderr: '' };
          },
        },
      ),
      (error: unknown) => error instanceof OmxQuestionError
        && error.code === 'active_execution_mode_blocked',
    );

    assert.equal(runnerCalled, false);
    const deepInterviewState = JSON.parse(await readFile(deepInterviewPath, 'utf-8')) as {
      question_enforcement?: { obligation_id?: string; status?: string };
    };
    assert.equal(deepInterviewState.question_enforcement?.obligation_id, 'obligation-original');
    assert.equal(deepInterviewState.question_enforcement?.status, 'pending');
  });

  it('persists readable autopilot waiting-for-user state while omx question is in flight and restores it after answer', { concurrency: false }, async () => {
    const cwd = await makeRepo();
    const sessionDir = join(cwd, '.omx', 'state', 'sessions', 'sess-di');
    const autopilotPath = join(sessionDir, 'autopilot-state.json');
    await writeFile(autopilotPath, JSON.stringify({
      active: true,
      mode: 'autopilot',
      current_phase: 'deep-interview',
      started_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
      session_id: 'sess-di',
      state: { deep_interview_gate: { status: 'required' } },
    }, null, 2));

    let observedWait = false;
    const runner: OmxQuestionProcessRunner = async (_command, _args, runnerOptions) => {
      const waitState = await readAutopilotDeepInterviewQuestionWaitState(cwd, 'sess-di');
      assert.ok(waitState);
      assert.equal(waitState.previousPhase, 'deep-interview');
      assert.equal(
        runnerOptions.env[AUTOPILOT_DEEP_INTERVIEW_QUESTION_OWNER_ENV],
        waitState.obligationId,
      );
      const autopilotState = JSON.parse(await readFile(autopilotPath, 'utf-8')) as {
        active?: boolean;
        current_phase?: string;
        run_outcome?: string;
        lifecycle_outcome?: string;
        state?: { deep_interview_question?: { status?: string; obligation_id?: string } };
      };
      assert.equal(autopilotState.active, true);
      assert.equal(autopilotState.current_phase, 'waiting-for-user');
      assert.equal(autopilotState.run_outcome, 'blocked_on_user');
      assert.equal(autopilotState.lifecycle_outcome, 'askuserQuestion');
      assert.equal(autopilotState.state?.deep_interview_question?.status, 'waiting_for_user');
      assert.ok(autopilotState.state?.deep_interview_question?.obligation_id);
      observedWait = true;
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          question_id: 'question-autopilot-1',
          session_id: 'sess-di',
          questions: [{ id: 'q-1', question: 'Clarify?', options: [], allow_other: true, other_label: 'Other', type: 'single-answerable', multi_select: false, source: 'deep-interview' }],
          answers: [{ question_id: 'q-1', index: 0, answer: { kind: 'freeform', value: 'answer' } }],
          answer: { kind: 'freeform', value: 'answer' },
        }),
        stderr: '',
      };
    };

    await runDeepInterviewQuestion(
      { session_id: 'sess-di', question: 'Clarify?', allow_other: true },
      { cwd, argv1: '/repo/dist/cli/omx.js', runner },
    );

    assert.equal(observedWait, true);
    assert.equal(await readAutopilotDeepInterviewQuestionWaitState(cwd, 'sess-di'), null);
    const finalAutopilot = JSON.parse(await readFile(autopilotPath, 'utf-8')) as {
      active?: boolean;
      current_phase?: string;
      run_outcome?: string;
      lifecycle_outcome?: string;
      state?: { deep_interview_question?: { status?: string; question_id?: string; satisfied_at?: string } };
    };
    assert.equal(finalAutopilot.active, true);
    assert.equal(finalAutopilot.current_phase, 'deep-interview');
    assert.equal(finalAutopilot.run_outcome, undefined);
    assert.equal(finalAutopilot.lifecycle_outcome, undefined);
    assert.equal(finalAutopilot.state?.deep_interview_question?.status, 'satisfied');
    assert.equal(finalAutopilot.state?.deep_interview_question?.question_id, 'question-autopilot-1');
    assert.ok(finalAutopilot.state?.deep_interview_question?.satisfied_at);
  });
});
