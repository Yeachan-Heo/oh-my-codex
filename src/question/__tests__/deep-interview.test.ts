import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { OmxQuestionError, type OmxQuestionProcessRunner } from '../client.js';
import {
  reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords,
  runDeepInterviewQuestion,
} from '../deep-interview.js';

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-deep-interview-question-'));
  tempDirs.push(cwd);
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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runDeepInterviewQuestion', () => {
  it('tracks a pending obligation before omx question returns and satisfies it afterward', async () => {
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

  it('clears the pending obligation when omx question fails after being attempted', async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');

    await assert.rejects(
      runDeepInterviewQuestion(
        {
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

  it('clears the pending obligation when question renderer launch fails', async () => {
    const cwd = await makeRepo();
    const statePath = join(cwd, '.omx', 'state', 'sessions', 'sess-di', 'deep-interview-state.json');

    await assert.rejects(
      runDeepInterviewQuestion(
        {
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

  it('reconciles a pending obligation from an already-answered same-session question record', async () => {
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
