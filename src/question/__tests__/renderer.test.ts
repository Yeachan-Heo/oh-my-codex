import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildQuestionUiTmuxArgs,
  closeQuestionRenderer,
  computeAdaptiveQuestionPaneHeight,
  formatQuestionAnswerForInjection,
  formatQuestionAnswersForInjection,
  injectQuestionAnswerToPane,
  findLiveQuestionsForSession,
  injectQuestionAnswersToPane,
  launchQuestionRenderer,
  resolveQuestionRendererStrategy,
  estimateQuestionRenderFootprint,
  shouldOpenQuestionInNewWindow,
  supersedeLiveQuestionsForSession,
} from '../renderer.js';
import { buildSendPaneArgvs } from '../../notifications/tmux-detector.js';

describe('resolveQuestionRendererStrategy', () => {
  it('prefers inside-tmux when TMUX is present', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('fails closed when tmux exists but TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'unsupported',
    );
  });

  it('uses inline-tty on Windows when no tmux bridge exists but the current terminal is interactive', () => {
    assert.equal(
      resolveQuestionRendererStrategy(
        {} as NodeJS.ProcessEnv,
        '/usr/bin/tmux',
        { platform: 'win32', stdinIsTTY: true, stdoutIsTTY: true },
      ),
      'inline-tty',
    );
  });

  it('supports explicit host-pane bridge hints when TMUX is absent', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_RETURN_PANE: '%77' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_LEADER_PANE_ID: '%88' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'inside-tmux',
    );
  });

  it('uses an interactive shell pane for native Windows psmux sessions', () => {
    assert.equal(
      resolveQuestionRendererStrategy(
        { TMUX: 'psmux-session', TMUX_PANE: '%44' } as NodeJS.ProcessEnv,
        'C:/Program Files/psmux/psmux.exe',
        { platform: 'win32' },
      ),
      'windows-psmux-shell-pane',
    );
    assert.equal(
      resolveQuestionRendererStrategy(
        { TMUX: 'socket,1,0', TMUX_PANE: '%45' } as NodeJS.ProcessEnv,
        'C:/Program Files/psmux/psmux.exe',
        { platform: 'win32' },
      ),
      'windows-psmux-shell-pane',
    );
  });

  it('keeps the detached Windows console path for explicit non-psmux return bridges', () => {
    assert.equal(
      resolveQuestionRendererStrategy(
        { OMX_QUESTION_RETURN_PANE: '%45' } as NodeJS.ProcessEnv,
        'C:/Program Files/psmux/psmux.exe',
        { platform: 'win32' },
      ),
      'windows-console',
    );
  });

  it('supports persisted workflow pane bridges when TMUX is absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-strategy-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        tmux_pane_id: '%91',
      }, null, 2));

      assert.equal(
        resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, '/usr/bin/tmux', { cwd, sessionId: 'sess-stateful' }),
        'inside-tmux',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects malformed explicit host-pane bridge hints', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_RETURN_PANE: 'not-a-pane' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'unsupported',
    );
  });

  it('uses noop test renderer override when requested', () => {
    assert.equal(
      resolveQuestionRendererStrategy({ OMX_QUESTION_TEST_RENDERER: 'noop' } as NodeJS.ProcessEnv, '/usr/bin/tmux'),
      'test-noop',
    );
  });

  it('fails closed when neither attached tmux nor tmux binary exists', () => {
    assert.equal(
      resolveQuestionRendererStrategy({} as NodeJS.ProcessEnv, undefined),
      'unsupported',
    );
  });
});


describe('question renderer cleanup', () => {
  it('kills tmux pane renderers by target pane id', () => {
    const calls: string[][] = [];
    const closed = closeQuestionRenderer({
      renderer: 'tmux-pane',
      target: '%42',
      launched_at: '2026-05-11T00:00:00.000Z',
    }, (args) => {
      calls.push(args);
      return '';
    });

    assert.equal(closed, true);
    assert.deepEqual(calls, [['kill-pane', '-t', '%42']]);
  });

  it('ignores invalid, noop, and Windows process renderers during cleanup', () => {
    const calls: string[][] = [];
    assert.equal(closeQuestionRenderer(undefined, (args) => { calls.push(args); return ''; }), false);
    assert.equal(closeQuestionRenderer({
      renderer: 'tmux-session',
      target: 'test-noop-renderer',
      launched_at: '2026-05-11T00:00:00.000Z',
    }, (args) => { calls.push(args); return ''; }), false);
    assert.equal(closeQuestionRenderer({
      renderer: 'windows-console',
      target: 'pid:1234',
      pid: 1234,
      launched_at: '2026-05-11T00:00:00.000Z',
    }, (args) => { calls.push(args); return ''; }), false);
    assert.deepEqual(calls, []);
  });
});


describe('adaptive question pane sizing', () => {
  it('computes large adaptive heights with caps and fallback-sized terminals', () => {
    assert.equal(computeAdaptiveQuestionPaneHeight(50, 10), 30);
    assert.equal(computeAdaptiveQuestionPaneHeight(50, 42), 42);
    assert.equal(computeAdaptiveQuestionPaneHeight(20, 50), 18);
    assert.equal(computeAdaptiveQuestionPaneHeight(Number.NaN, 10), 24);
    assert.equal(computeAdaptiveQuestionPaneHeight(9, 20), 7);
  });
});

describe('question window topology selection', () => {
  it('switches to a new tmux window only after the split height budget is exceeded', () => {
    assert.equal(shouldOpenQuestionInNewWindow(20, 18), false);
    assert.equal(shouldOpenQuestionInNewWindow(20, 19), true);
    assert.equal(shouldOpenQuestionInNewWindow(5, 3), false);
    assert.equal(shouldOpenQuestionInNewWindow(5, 4), true);
  });

  it('counts wrapped question text more conservatively in narrow panes', () => {
    const record = {
      kind: 'omx.question/v1',
      question_id: 'question-1',
      created_at: '2026-05-01T10:08:52.523Z',
      updated_at: '2026-05-01T10:08:52.523Z',
      status: 'pending',
      question: 'x'.repeat(180),
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'y'.repeat(140),
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
      source: 'deep-interview',
      questions: [{
        id: 'q-1',
        question: 'x'.repeat(180),
        options: [{
          label: 'Only option',
          value: 'only',
          description: 'y'.repeat(140),
        }],
        allow_other: false,
        multi_select: false,
        type: 'single-answerable',
      }],
    } as any;

    assert.ok(estimateQuestionRenderFootprint(record, 20) > estimateQuestionRenderFootprint(record, 80));
  });

  it('sizes multi-question records from the largest visible screen rather than summing every question', () => {
    const longQuestion = {
      id: 'q-2',
      question: 'x'.repeat(220),
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'y'.repeat(180),
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
    };
    const shortQuestion = {
      id: 'q-1',
      question: 'Short question?',
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'Short description.',
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
    };
    const shared = {
      kind: 'omx.question/v1',
      question_id: 'question-1',
      created_at: '2026-05-01T10:08:52.523Z',
      updated_at: '2026-05-01T10:08:52.523Z',
      status: 'pending',
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
      source: 'deep-interview',
    };
    const multiQuestionRecord = {
      ...shared,
      questions: [shortQuestion, longQuestion],
    } as any;
    const shortRecord = {
      ...shared,
      questions: [shortQuestion],
    } as any;
    const longRecord = {
      ...shared,
      questions: [longQuestion],
    } as any;

    const multiFootprint = estimateQuestionRenderFootprint(multiQuestionRecord, 20);
    const shortFootprint = estimateQuestionRenderFootprint(shortRecord, 20);
    const longFootprint = estimateQuestionRenderFootprint(longRecord, 20);

    assert.ok(multiFootprint >= longFootprint);
    assert.ok(multiFootprint < shortFootprint + longFootprint);
  });

  it('includes the review screen when sizing multi-question records', () => {
    const shortQuestion = {
      id: 'q-1',
      question: 'First short question?',
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'Short description.',
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
    };
    const shortSecondQuestion = {
      id: 'q-2',
      question: 'Second short question?',
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'Short description.',
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
    };
    const shortThirdQuestion = {
      id: 'q-3',
      question: 'Third short question?',
      options: [{
        label: 'Only option',
        value: 'only',
        description: 'Short description.',
      }],
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
    };
    const shared = {
      kind: 'omx.question/v1',
      question_id: 'question-1',
      created_at: '2026-05-01T10:08:52.523Z',
      updated_at: '2026-05-01T10:08:52.523Z',
      status: 'pending',
      allow_other: false,
      multi_select: false,
      type: 'single-answerable',
      source: 'deep-interview',
    };
    const singleScreenRecord = {
      ...shared,
      questions: [shortQuestion],
    } as any;
    const reviewScreenRecord = {
      ...shared,
      questions: [shortQuestion, shortSecondQuestion, shortThirdQuestion],
    } as any;

    assert.ok(estimateQuestionRenderFootprint(reviewScreenRecord, 80) > estimateQuestionRenderFootprint(singleScreenRecord, 80));
  });

  it('sizes review screens from selected answers when multi-select summaries wrap', () => {
    const questions = Array.from({ length: 5 }, (_, index) => ({
      id: `q-${index + 1}`,
      question: `Question ${index + 1}?`,
      options: [
        { label: 'Alpha option', value: 'alpha' },
        { label: 'Beta option', value: 'beta' },
        { label: 'Gamma option', value: 'gamma' },
      ],
      allow_other: false,
      multi_select: true,
      type: 'multi-answerable',
    }));
    const record = {
      kind: 'omx.question/v1',
      question_id: 'question-1',
      created_at: '2026-05-01T10:08:52.523Z',
      updated_at: '2026-05-01T10:08:52.523Z',
      status: 'pending',
      allow_other: false,
      multi_select: true,
      type: 'multi-answerable',
      source: 'deep-interview',
      questions,
    } as any;

    assert.equal(shouldOpenQuestionInNewWindow(20, estimateQuestionRenderFootprint(record, 20)), true);
  });
});

describe('launchQuestionRenderer', () => {
  it('fails before building UI argv or invoking tmux when no visible renderer is available', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '';
    try {
      assert.throws(
        () => launchQuestionRenderer(
          {
            cwd: '/repo',
            recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
            env: {} as NodeJS.ProcessEnv,
          },
          {
            strategy: 'unsupported',
            execTmux: (args) => {
              calls.push(args);
              return '';
            },
            sleepSync: () => {},
          },
        ),
        (error) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /visible renderer/i);
          assert.match(error.message, /attached tmux pane/i);
          assert.match(error.message, /Run omx question from inside tmux/i);
          assert.doesNotMatch(error.message, /tmux is unavailable/i);
          return true;
        },
      );
    } finally {
      process.argv[1] = originalArgv1;
    }

    assert.deepEqual(calls, []);
  });

  it('opens an interactive foreground split when already inside an attached tmux session', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%42\n';
          if (args[0] === 'list-panes') return '0\t%42\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%42');
    assert.equal(result.return_target, '%11');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.ok(!splitCall.includes('-d'));
    assert.ok(splitCall.includes('-t'));
    assert.ok(splitCall.includes('%11'));
    assert.notEqual(splitCall[3], '12');
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.ok(splitCall.includes('-e'));
    assert.ok(splitCall.includes('OMX_SESSION_ID=s1'));
    assert.ok(splitCall.includes('OMX_QUESTION_RETURN_TARGET=%11'));
    assert.ok(splitCall.includes('OMX_QUESTION_RETURN_TRANSPORT=tmux-send-keys'));
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %42 -F #{pane_dead}\t#{pane_id}'));
  });

  it('opens a new tmux window when the current pane is too short for the question frame', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-new-window-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 's1', 'questions');
      mkdirSync(stateDir, { recursive: true });
      const recordPath = join(stateDir, 'question-1.json');
      writeFileSync(recordPath, JSON.stringify({
        kind: 'omx.question/v1',
        question_id: 'question-1',
        created_at: '2026-05-01T10:08:52.523Z',
        updated_at: '2026-05-01T10:08:52.523Z',
        status: 'pending',
        question: 'Round 1 | Target: definition-boundary | Ambiguity: 42%\n\nСамая важная неоднозначность: что именно считать системной метрикой скорости для TTS / Image / Voice, чтобы прогресс-бар и карточки не врали оператору?',
        options: [
          { label: 'Stage timings', value: 'stage-timings', description: 'Считать отдельно реальные этапы: TTS synthesis, image/still generation, voice/video final generation; для каждого нужны stage timestamps/metadata.' },
          { label: 'Wall-clock by artifact', value: 'wall-clock-by-artifact', description: 'Брать общий wall-clock от createdAt до completed и нормализовать по типу результата: 1 image / N sec, 1s video / N sec.' },
          { label: 'Hybrid recommended', value: 'hybrid', description: 'Сначала использовать wall-clock fallback, но добавлять stage timings для новых генераций, когда этапы можно инструментировать.' },
        ],
        allow_other: true,
        other_label: 'Other',
        multi_select: false,
        type: 'single-answerable',
        questions: [{
          id: 'q-1',
          question: 'Round 1 | Target: definition-boundary | Ambiguity: 42%\n\nСамая важная неоднозначность: что именно считать системной метрикой скорости для TTS / Image / Voice, чтобы прогресс-бар и карточки не врали оператору?',
          options: [
            { label: 'Stage timings', value: 'stage-timings', description: 'Считать отдельно реальные этапы: TTS synthesis, image/still generation, voice/video final generation; для каждого нужны stage timestamps/metadata.' },
            { label: 'Wall-clock by artifact', value: 'wall-clock-by-artifact', description: 'Брать общий wall-clock от createdAt до completed и нормализовать по типу результата: 1 image / N sec, 1s video / N sec.' },
            { label: 'Hybrid recommended', value: 'hybrid', description: 'Сначала использовать wall-clock fallback, но добавлять stage timings для новых генераций, когда этапы можно инструментировать.' },
          ],
          allow_other: true,
          other_label: 'Other',
          multi_select: false,
          type: 'single-answerable',
        }],
        source: 'deep-interview',
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath,
          sessionId: 's1',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{session_attached}')) return '1\n';
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '5\n';
            if (args[0] === 'display-message' && args.includes('#{session_id}')) return '$1\n';
            if (args[0] === 'new-window') return '%42\n';
            if (args[0] === 'list-panes' && args[2] === '%42') return '0\t%42\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.renderer, 'tmux-pane');
      assert.equal(result.target, '%42');
      assert.equal(result.return_target, '%11');
      assert.equal(result.return_transport, 'tmux-send-keys');
      const newWindowCall = calls.find((call) => call[0] === 'new-window');
      assert.ok(newWindowCall);
      const targetIndex = newWindowCall.indexOf('-t');
      assert.notEqual(targetIndex, -1);
      assert.deepEqual(newWindowCall.slice(targetIndex, targetIndex + 2), ['-t', '$1']);
      assert.equal(calls.some((call) => call[0] === 'split-window'), false);
      assert.equal(calls.some((call) => call[0] === 'display-message' && call.includes('#{session_id}')), true);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it('opens a new tmux window when wrapped content would exceed the split budget in a narrow pane', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-wrapped-window-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 's1', 'questions');
      mkdirSync(stateDir, { recursive: true });
      const recordPath = join(stateDir, 'question-1.json');
      writeFileSync(recordPath, JSON.stringify({
        kind: 'omx.question/v1',
        question_id: 'question-1',
        created_at: '2026-05-01T10:08:52.523Z',
        updated_at: '2026-05-01T10:08:52.523Z',
        status: 'pending',
        question: 'x'.repeat(220),
        options: [{
          label: 'Only option',
          value: 'only',
          description: 'y'.repeat(180),
        }],
        allow_other: false,
        multi_select: false,
        type: 'single-answerable',
        source: 'deep-interview',
        questions: [{
          id: 'q-1',
          question: 'x'.repeat(220),
          options: [{
            label: 'Only option',
            value: 'only',
            description: 'y'.repeat(180),
          }],
          allow_other: false,
          multi_select: false,
          type: 'single-answerable',
        }],
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath,
          sessionId: 's1',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{session_attached}')) return '1\n';
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '20\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '20\n';
            if (args[0] === 'display-message' && args.includes('#{session_id}')) return '$1\n';
            if (args[0] === 'new-window') return '%99\n';
            if (args[0] === 'list-panes' && args[2] === '%99') return '0\t%99\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.renderer, 'tmux-pane');
      assert.equal(result.target, '%99');
      assert.equal(result.return_target, '%11');
      assert.equal(result.return_transport, 'tmux-send-keys');
      const newWindowCall = calls.find((call) => call[0] === 'new-window');
      assert.ok(newWindowCall);
      const targetIndex = newWindowCall.indexOf('-t');
      assert.notEqual(targetIndex, -1);
      assert.deepEqual(newWindowCall.slice(targetIndex, targetIndex + 2), ['-t', '$1']);
      assert.equal(calls.some((call) => call[0] === 'split-window'), false);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it('falls back to the default tmux width when the width probe fails', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-width-fallback-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 's1', 'questions');
      mkdirSync(stateDir, { recursive: true });
      const recordPath = join(stateDir, 'question-1.json');
      writeFileSync(recordPath, JSON.stringify({
        kind: 'omx.question/v1',
        question_id: 'question-1',
        created_at: '2026-05-01T10:08:52.523Z',
        updated_at: '2026-05-01T10:08:52.523Z',
        status: 'pending',
        question: 'x'.repeat(2000),
        options: [{
          label: 'Only option',
          value: 'only',
          description: 'y'.repeat(1000),
        }],
        allow_other: false,
        multi_select: false,
        type: 'single-answerable',
        source: 'deep-interview',
        questions: [{
          id: 'q-1',
          question: 'x'.repeat(2000),
          options: [{
            label: 'Only option',
            value: 'only',
            description: 'y'.repeat(1000),
          }],
          allow_other: false,
          multi_select: false,
          type: 'single-answerable',
        }],
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath,
          sessionId: 's1',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{session_attached}')) return '1\n';
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '20\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}') && args.includes('-t')) throw new Error('width query failed');
            if (args[0] === 'display-message' && args.includes('#{pane_width}') && !args.includes('-t')) return '3\n';
            if (args[0] === 'display-message' && args.includes('#{session_id}')) return '$1\n';
            if (args[0] === 'new-window') return '%88\n';
            if (args[0] === 'list-panes' && args[2] === '%88') return '0\t%88\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.renderer, 'tmux-pane');
      assert.equal(result.target, '%88');
      assert.equal(result.return_target, '%11');
      assert.equal(result.return_transport, 'tmux-send-keys');
      const newWindowCall = calls.find((call) => call[0] === 'new-window');
      assert.ok(newWindowCall);
      const targetIndex = newWindowCall.indexOf('-t');
      assert.notEqual(targetIndex, -1);
      assert.deepEqual(newWindowCall.slice(targetIndex, targetIndex + 2), ['-t', '$1']);
      assert.equal(calls.some((call) => call[0] === 'display-message' && call.includes('#{pane_height}')), false);
      assert.equal(calls.some((call) => call[0] === 'display-message' && call.includes('#{pane_width}') && !call.includes('-t')), false);
      assert.equal(calls.some((call) => call[0] === 'split-window'), false);
    } finally {
      rmSync(cwd, { recursive: true });
    }
  });

  it('targets the explicit leader pane even when the caller is already inside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-leader.json',
        sessionId: 's1',
        env: {
          TMUX: '/tmp/tmux-demo',
          TMUX_PANE: '%22',
          OMX_QUESTION_RETURN_PANE: '%44',
        } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%45\n';
          if (args[0] === 'list-panes') return '0\t%45\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.target, '%45');
    assert.equal(result.return_target, '%44');
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.deepEqual(splitCall.slice(0, 6), ['split-window', '-v', '-l', '24', '-t', '%44']);
  });

  it('fails closed before splitting when inside a detached tmux session', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-detached.json',
          sessionId: 's1',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message') return '0\n';
            if (args[0] === 'split-window') return '%99\n';
            return '';
          },
          sleepSync: () => {},
        },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /visible renderer/i);
        assert.match(error.message, /no attached client/i);
        assert.match(error.message, /attached tmux pane/i);
        return true;
      },
    );

    assert.deepEqual(calls, [['display-message', '-p', '-t', '%11', '#{session_attached}']]);
  });

  it('targets an explicit host pane when launching from a container without TMUX', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-bridge.json',
        sessionId: 's1',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: { OMX_QUESTION_RETURN_PANE: '%77' } as NodeJS.ProcessEnv,
      },
        {
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '80\n';
            if (args[0] === 'split-window') return '%78\n';
            if (args[0] === 'list-panes') return '0\t%78\n';
            return '';
          },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%78');
    assert.equal(result.return_target, '%77');
    assert.equal(result.return_transport, 'tmux-send-keys');
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.ok(!splitCall.includes('-d'));
    assert.deepEqual(splitCall.slice(0, 3), ['split-window', '-v', '-l']);
    assert.equal(splitCall[3], '24');
    assert.ok(splitCall.includes('-t'));
    assert.ok(splitCall.includes('%77'));
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %78 -F #{pane_dead}\t#{pane_id}'));
  });

  it('opens a visible Windows psmux shell pane and injects the question UI command literally', () => {
    const tmuxCalls: string[][] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-bridge.json',
        sessionId: 's1',
        nowIso: '2026-04-24T00:00:00.000Z',
        env: { TMUX: 'psmux-session', TMUX_PANE: '%44' } as NodeJS.ProcessEnv,
        platform: 'win32',
      },
      {
        execTmux: (args) => {
          tmuxCalls.push(args);
          if (args[0] === 'new-window') return '%55\n';
          if (args[0] === 'list-panes' && args[2] === '%55') return '0\t%55\n';
          return '';
        },
        spawnDetachedRenderer: (command, args, options) => {
          spawnCalls.push({ command, args, options: options as Record<string, unknown> });
          return { pid: 1234, unref: () => {} };
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-pane');
    assert.equal(result.target, '%55');
    assert.equal(result.return_target, '%44');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.deepEqual(spawnCalls, []);
    assert.equal(tmuxCalls.some((call) => call[0] === 'split-window'), false);
    assert.deepEqual(tmuxCalls[0], [
      'new-window',
      '-n',
      'OMX Question',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      '/repo',
    ]);
    assert.deepEqual(tmuxCalls[1], ['list-panes', '-t', '%55', '-F', '#{pane_dead}\t#{pane_id}']);
    const literalSend = tmuxCalls.find((call) => call[0] === 'send-keys' && call.includes('-l'));
    assert.ok(literalSend);
    assert.deepEqual(literalSend.slice(0, 6), ['send-keys', '-t', '%55', '-l', '--', literalSend[5] ?? '']);
    assert.match(literalSend[5] ?? '', /^set "OMX_SESSION_ID=s1" && set "OMX_QUESTION_RETURN_TARGET=%%44" && set "OMX_QUESTION_RETURN_TRANSPORT=tmux-send-keys" && /);
    assert.match(literalSend[5] ?? '', /"question" "--ui" "--state-path" "\/repo\/\.omx\/state\/sessions\/s1\/questions\/question-bridge\.json"$/);
    assert.deepEqual(tmuxCalls.filter((call) => call[0] === 'send-keys' && call.includes('C-m')), [
      ['send-keys', '-t', '%55', 'C-m'],
    ]);
  });

  it('keeps the detached Windows console path for explicit non-psmux return bridges', () => {
    const tmuxCalls: string[][] = [];
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const result = launchQuestionRenderer(
      {
        cwd: 'C:/repo',
        recordPath: 'C:/repo/.omx/state/sessions/s1/questions/question-bridge.json',
        sessionId: 's1',
        nowIso: '2026-04-24T00:00:00.000Z',
        env: { OMX_QUESTION_RETURN_PANE: '%44' } as NodeJS.ProcessEnv,
        platform: 'win32',
      },
      {
        execTmux: (args) => {
          tmuxCalls.push(args);
          return '';
        },
        spawnDetachedRenderer: (command, args, options) => {
          spawnCalls.push({ command, args, options: options as Record<string, unknown> });
          return { pid: 1234, unref: () => {} };
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'windows-console');
    assert.equal(result.target, 'pid:1234');
    assert.equal(result.pid, 1234);
    assert.equal(result.return_target, '%44');
    assert.equal(result.return_transport, 'tmux-send-keys');
    assert.deepEqual(tmuxCalls, []);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]?.command, 'cmd.exe');
    assert.deepEqual(spawnCalls[0]?.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.match(spawnCalls[0]?.args[3] || '', /start "OMX Question" \/wait/);
    assert.match(spawnCalls[0]?.args[3] || '', /"question" "--ui" "--state-path"/);
    assert.match(spawnCalls[0]?.args[3] || '', /question-bridge\.json"/);
    assert.equal(spawnCalls[0]?.options.cwd, 'C:/repo');
    assert.equal(spawnCalls[0]?.options.detached, true);
    assert.equal(spawnCalls[0]?.options.windowsHide, true);
    const env = spawnCalls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(env.OMX_SESSION_ID, 's1');
    assert.equal(env.OMX_QUESTION_RETURN_TARGET, '%44');
    assert.equal(env.OMX_QUESTION_RETURN_TRANSPORT, 'tmux-send-keys');
  });

  it('targets a persisted workflow pane when launching from a container without TMUX', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-persisted-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'intent-first',
        tmux_pane_id: '%91',
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(stateDir, 'questions', 'question-bridge.json'),
          sessionId: 'sess-stateful',
          env: {} as NodeJS.ProcessEnv,
        },
        {
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '80\n';
            if (args[0] === 'split-window') return '%92\n';
            if (args[0] === 'list-panes') return '0\t%92\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.renderer, 'tmux-pane');
      assert.equal(result.target, '%92');
      assert.equal(result.return_target, '%91');
      assert.equal(result.return_transport, 'tmux-send-keys');
      const splitCall = calls.find((call) => call[0] === 'split-window');
      assert.ok(splitCall);
      assert.deepEqual(splitCall.slice(0, 3), ['split-window', '-v', '-l']);
      assert.equal(splitCall[3], '24');
      assert.ok(splitCall.includes('%91'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('fails before prompting state when a reported split pane is already gone', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-1.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%42\n';
            throw new Error("can't find pane: %42");
          },
          sleepSync: () => {},
        },
      ),
      /Question UI pane %42 disappeared immediately after launch/,
    );

    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-1.json',
    ]);
    assert.ok(calls.some((call) => call.join(' ') === 'list-panes -t %42 -F #{pane_dead}\t#{pane_id}'));
  });

  it('uses inline-tty on Windows without invoking tmux when no attached tmux pane is available', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-inline.json',
        sessionId: 's1',
        nowIso: '2026-04-23T00:00:00.000Z',
        env: {} as NodeJS.ProcessEnv,
        platform: 'win32',
        stdinIsTTY: true,
        stdoutIsTTY: true,
      },
      {
        execTmux: (args) => {
          calls.push(args);
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'inline-tty');
    assert.equal(result.target, 'inline-tty');
    assert.deepEqual(calls, []);
  });

  it('falls back to the persisted session mode pane when Bash/tool env lost TMUX_PANE', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state', 'sessions', 'sess-stateful');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'planning',
        tmux_pane_id: '%91',
      }, null, 2));

      const calls: string[][] = [];
      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(cwd, '.omx', 'state', 'sessions', 'sess-stateful', 'questions', 'question-3.json'),
          sessionId: 'sess-stateful',
          env: { TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '80\n';
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%77\n';
            if (args[0] === 'list-panes') return '0\t%77\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%91');
      assert.equal(result.return_transport, 'tmux-send-keys');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%91', '#{session_attached}']);
      assert.ok(calls.some((call) => call[0] === 'split-window'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('prefers session-scoped persisted panes over root workflow fallback panes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-renderer-precedence-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionStateDir = join(rootStateDir, 'sessions', 'sess-stateful');
      mkdirSync(sessionStateDir, { recursive: true });
      writeFileSync(join(rootStateDir, 'team-state.json'), JSON.stringify({
        active: true,
        mode: 'team',
        current_phase: 'executing',
        tmux_pane_id: '%10',
      }, null, 2));
      writeFileSync(join(sessionStateDir, 'ralplan-state.json'), JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'planning',
        tmux_pane_id: '%91',
      }, null, 2));

      const result = launchQuestionRenderer(
        {
          cwd,
          recordPath: join(sessionStateDir, 'questions', 'question-4.json'),
          sessionId: 'sess-stateful',
          env: { TMUX: '/tmp/tmux-demo' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '80\n';
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%77\n';
            if (args[0] === 'list-panes') return '0\t%77\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%91');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('passes direct tmux argv so non-POSIX default shells do not parse a shell string', () => {
    const calls: string[][] = [];
    launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/question with spaces.json',
        sessionId: 'sess-123',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%428' } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%77\n';
          if (args[0] === 'list-panes') return '0\t%77\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%428', '#{session_attached}']);
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    assert.equal(splitCall.some((part) => /question --ui --state-path/.test(part)), false);
    assert.equal(splitCall.some((part) => /^'.*'$/.test(part)), false);
    assert.equal(splitCall[splitCall.length - 6], process.execPath);
    assert.equal(splitCall[splitCall.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(splitCall.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/question with spaces.json',
    ]);
  });

  it('resolves the leader return target before opening the question pane', () => {
    const calls: string[][] = [];
    const originalTmuxPane = process.env.TMUX_PANE;
    const originalTmux = process.env.TMUX;
    process.env.TMUX_PANE = '%200';
    process.env.TMUX = '/tmp/tmux-leader';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/question-4.json',
          sessionId: 'sess-123',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%200' } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') {
              process.env.TMUX_PANE = '%201';
              return '%201\n';
            }
            if (args[0] === 'list-panes') return '0\t%201\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.return_target, '%200');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%200', '#{session_attached}']);
    } finally {
      if (typeof originalTmuxPane === 'string') process.env.TMUX_PANE = originalTmuxPane;
      else delete process.env.TMUX_PANE;
      if (typeof originalTmux === 'string') process.env.TMUX = originalTmux;
      else delete process.env.TMUX;
    }
  });

  it('uses detached sessions outside tmux', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
        nowIso: '2026-04-19T00:00:00.000Z',
        env: {} as NodeJS.ProcessEnv,
      },
      {
        strategy: 'detached-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'has-session') return '';
          return 'omx-question-question-2\n';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.renderer, 'tmux-session');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.ok(calls[0]?.includes('-d'));
    assert.equal(calls[0]?.[calls[0]!.length - 6], process.execPath);
    assert.equal(calls[0]?.[calls[0]!.length - 5]?.endsWith('/dist/cli/omx.js'), true);
    assert.deepEqual(calls[0]?.slice(-4), [
      'question',
      '--ui',
      '--state-path',
      '/repo/.omx/state/sessions/s1/questions/question-2.json',
    ]);
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('fails when a detached tmux session disappears immediately after launch', () => {
    const calls: string[][] = [];
    assert.throws(
      () => launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-2.json',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {} as NodeJS.ProcessEnv,
        },
        {
          strategy: 'detached-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'new-session') return 'omx-question-question-2\n';
            throw new Error('can\'t find session: omx-question-question-2');
          },
          sleepSync: () => {},
        },
      ),
      /Question UI session omx-question-question-2 disappeared immediately after launch/,
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.[0], 'new-session');
    assert.deepEqual(calls[1], ['has-session', '-t', 'omx-question-question-2']);
  });

  it('prefers the current launcher path over a stale ambient OMX_ENTRY_PATH when spawning the UI', () => {
    const calls: string[][] = [];
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/repo/dist/cli/omx.js';
    try {
      const result = launchQuestionRenderer(
        {
          cwd: '/repo',
          recordPath: '/repo/.omx/state/sessions/s1/questions/question-3.json',
          sessionId: 's1',
          nowIso: '2026-04-19T00:00:00.000Z',
          env: {
            TMUX: '/tmp/tmux-demo',
            TMUX_PANE: '%11',
            OMX_ENTRY_PATH: '/stale/global/dist/cli/omx.js',
          } as NodeJS.ProcessEnv,
        },
        {
          strategy: 'inside-tmux',
          execTmux: (args) => {
            calls.push(args);
            if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
            if (args[0] === 'display-message') return '1\n';
            if (args[0] === 'split-window') return '%42\n';
            if (args[0] === 'list-panes') return '0\t%42\n';
            return '';
          },
          sleepSync: () => {},
        },
      );

      assert.equal(result.target, '%42');
      assert.deepEqual(calls[0], ['display-message', '-p', '-t', '%11', '#{session_attached}']);
      const splitCall = calls.find((call) => call[0] === 'split-window');
      assert.ok(splitCall);
      assert.equal(splitCall.includes('/repo/dist/cli/omx.js'), true);
      assert.equal(splitCall.includes('/stale/global/dist/cli/omx.js'), false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe('question answer injection', () => {
  it('formats other answers into a single-line continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswerForInjection({
        kind: 'other',
        value: 'hello\nworld',
        selected_labels: ['Other'],
        selected_values: ['hello\nworld'],
        other_text: 'hello\nworld',
      }),
      '[omx question answered] hello world',
    );
  });

  it('formats batch answers into one continuation-safe prompt', () => {
    assert.equal(
      formatQuestionAnswersForInjection([
        {
          question_id: 'first',
          answer: {
            kind: 'option',
            value: 'a',
            selected_labels: ['A'],
            selected_values: ['a'],
          },
        },
        {
          question_id: 'second',
          answer: {
            kind: 'multi',
            value: ['b', 'custom\nvalue'],
            selected_labels: ['B', 'Other'],
            selected_values: ['b', 'custom\nvalue'],
            other_text: 'custom\nvalue',
          },
        },
      ]),
      '[omx question answered] first: a; second: b, custom value',
    );
  });

  it('injects the answered text back into the requester pane and submits with isolated double C-m', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswerToPane(
      '%11',
      {
        kind: 'option',
        value: 'proceed',
        selected_labels: ['Proceed'],
        selected_values: ['proceed'],
      },
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, buildSendPaneArgvs('%11', '[omx question answered] proceed', true));
    assert.deepEqual(sleeps, [120, 100]);
    assert.equal(calls.some((argv) => argv.includes('Enter')), false);
  });

  it('injects all batch answers back into the requester pane', () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const ok = injectQuestionAnswersToPane(
      '%11',
      [
        {
          question_id: 'first',
          answer: {
            kind: 'option',
            value: 'a',
            selected_labels: ['A'],
            selected_values: ['a'],
          },
        },
        {
          question_id: 'second',
          answer: {
            kind: 'option',
            value: 'd',
            selected_labels: ['D'],
            selected_values: ['d'],
          },
        },
      ],
      (args) => {
        calls.push(args);
        return '';
      },
      (ms) => {
        sleeps.push(ms);
      },
    );

    assert.equal(ok, true);
    assert.deepEqual(calls, buildSendPaneArgvs('%11', '[omx question answered] first: a; second: d', true));
    assert.deepEqual(sleeps, [120, 100]);
  });
});


describe('question renderer in-flight dedupe', () => {
  function writeQuestionRecord(path: string, overrides: Record<string, unknown>): void {
    writeFileSync(path, JSON.stringify({
      kind: 'omx.question/v1',
      question_id: 'question-default',
      session_id: 'sess-dedupe',
      created_at: '2026-05-27T00:00:00.000Z',
      updated_at: '2026-05-27T00:00:00.000Z',
      status: 'prompting',
      question: 'Pick one',
      options: [{ label: 'A', value: 'a' }],
      allow_other: false,
      other_label: 'Other',
      multi_select: false,
      type: 'single-answerable',
      questions: [{
        id: 'q-1',
        question: 'Pick one',
        options: [{ label: 'A', value: 'a' }],
        allow_other: false,
        other_label: 'Other',
        multi_select: false,
        type: 'single-answerable',
      }],
      renderer: {
        renderer: 'tmux-pane',
        target: '%41',
        launched_at: '2026-05-27T00:00:00.000Z',
      },
      ...overrides,
    }, null, 2));
  }

  it('finds only live prompting question renderers for the same session', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-dedupe-find-'));
    try {
      const dir = join(cwd, '.omx', 'state', 'sessions', 'sess-dedupe', 'questions');
      mkdirSync(dir, { recursive: true });
      writeQuestionRecord(join(dir, 'question-live.json'), {
        question_id: 'question-live',
        created_at: '2026-05-27T00:00:01.000Z',
        renderer: { renderer: 'tmux-pane', target: '%41', launched_at: '2026-05-27T00:00:01.000Z' },
      });
      writeQuestionRecord(join(dir, 'question-dead.json'), {
        question_id: 'question-dead',
        created_at: '2026-05-27T00:00:02.000Z',
        renderer: { renderer: 'tmux-pane', target: '%42', launched_at: '2026-05-27T00:00:02.000Z' },
      });
      writeQuestionRecord(join(dir, 'question-answered.json'), {
        question_id: 'question-answered',
        status: 'answered',
        created_at: '2026-05-27T00:00:03.000Z',
        renderer: { renderer: 'tmux-pane', target: '%43', launched_at: '2026-05-27T00:00:03.000Z' },
      });

      const live = findLiveQuestionsForSession(cwd, 'sess-dedupe', (args) => {
        if (args[0] === 'list-panes' && args[2] === '%41') return '0\t%41\n';
        if (args[0] === 'list-panes' && args[2] === '%42') throw new Error('missing pane');
        if (args[0] === 'list-panes' && args[2] === '%43') return '0\t%43\n';
        return '';
      });

      assert.deepEqual(live.map((item) => item.record.question_id), ['question-live']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('marks prior live prompting panes superseded and kills them before a new tmux split', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-dedupe-launch-'));
    try {
      const dir = join(cwd, '.omx', 'state', 'sessions', 'sess-dedupe', 'questions');
      mkdirSync(dir, { recursive: true });
      const priorPath = join(dir, 'question-prior.json');
      const nextPath = join(dir, 'question-next.json');
      writeQuestionRecord(priorPath, {
        question_id: 'question-prior',
        renderer: {
          renderer: 'tmux-pane',
          target: '%41',
          launched_at: '2026-05-27T00:00:00.000Z',
        },
      });
      writeQuestionRecord(nextPath, {
        question_id: 'question-next',
        status: 'pending',
        renderer: undefined,
      });

      const calls: string[][] = [];
      const result = launchQuestionRenderer({
        cwd,
        recordPath: nextPath,
        sessionId: 'sess-dedupe',
        nowIso: '2026-05-27T00:01:00.000Z',
        env: { TMUX: '/tmp/tmux-demo', TMUX_PANE: '%11' } as NodeJS.ProcessEnv,
      }, {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{session_attached}')) return '1\n';
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
          if (args[0] === 'display-message' && args.includes('#{pane_width}')) return '80\n';
          if (args[0] === 'list-panes' && args[2] === '%41') return '0\t%41\n';
          if (args[0] === 'kill-pane') return '';
          if (args[0] === 'split-window') return '%44\n';
          if (args[0] === 'list-panes' && args[2] === '%44') return '0\t%44\n';
          return '';
        },
        sleepSync: () => {},
      });

      assert.equal(result.target, '%44');
      const prior = JSON.parse(readFileSync(priorPath, 'utf-8')) as { status: string; error?: { code?: string }; updated_at?: string };
      assert.equal(prior.status, 'superseded');
      assert.equal(prior.error?.code, 'question_superseded');
      assert.equal(prior.updated_at, '2026-05-27T00:01:00.000Z');
      const killIndex = calls.findIndex((call) => call.join(' ') === 'kill-pane -t %41');
      const splitIndex = calls.findIndex((call) => call[0] === 'split-window');
      assert.ok(killIndex >= 0);
      assert.ok(splitIndex > killIndex);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not supersede answered records when launching a replacement renderer', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-question-dedupe-answered-'));
    try {
      const dir = join(cwd, '.omx', 'state', 'sessions', 'sess-dedupe', 'questions');
      mkdirSync(dir, { recursive: true });
      const answeredPath = join(dir, 'question-answered.json');
      writeQuestionRecord(answeredPath, {
        question_id: 'question-answered',
        status: 'answered',
        renderer: {
          renderer: 'tmux-pane',
          target: '%41',
          launched_at: '2026-05-27T00:00:00.000Z',
        },
      });

      const superseded = supersedeLiveQuestionsForSession(cwd, 'sess-dedupe', (args) => {
        if (args[0] === 'list-panes') return '0\t%41\n';
        throw new Error(`unexpected tmux call: ${args.join(' ')}`);
      });

      assert.deepEqual(superseded, []);
      const answered = JSON.parse(readFileSync(answeredPath, 'utf-8')) as { status: string };
      assert.equal(answered.status, 'answered');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('buildQuestionUiTmuxArgs', () => {
  const recordPath = '/repo/.omx/state/sessions/s1/questions/question-1.json';

  it('passes env via tmux -e flags on real tmux (no cmux)', () => {
    const args = buildQuestionUiTmuxArgs(recordPath, {
      cwd: '/repo',
      sessionId: 's1',
      returnTarget: '%11',
      underCmux: false,
    });
    assert.ok(args.includes('-e'));
    assert.ok(args.includes('OMX_SESSION_ID=s1'));
    assert.ok(args.includes('OMX_QUESTION_RETURN_TARGET=%11'));
    assert.ok(args.includes('OMX_QUESTION_RETURN_TRANSPORT=tmux-send-keys'));
    // tmux execs the command argv directly, so command tokens stay raw/unquoted.
    assert.ok(args.includes(process.execPath));
    assert.equal(args.includes('export'), false);
    assert.equal(args.includes('&&'), false);
    assert.equal(args.some((token) => /^'.*'$/.test(token)), false);
  });

  it('delivers env via a single shell-neutral env-prefixed command and never emits a bare -e under cmux', () => {
    const args = buildQuestionUiTmuxArgs(recordPath, {
      cwd: '/repo',
      sessionId: 's1',
      returnTarget: '%11',
      underCmux: true,
    });
    // A single shell-command argument: stays correct on both the cmux shim and a
    // real tmux that inherits cmux env vars (single arg -> run via the shell).
    assert.equal(args.length, 1);
    const command = args[0];
    // `env` keeps it shell-neutral (works in fish/zsh/sh); no POSIX-only `export`/`&&`.
    assert.match(command, /^env /);
    assert.equal(command.includes('export'), false);
    assert.equal(command.includes('&&'), false);
    assert.equal(command.startsWith('-e'), false);
    assert.equal(command.includes(' -e '), false);
    assert.ok(command.includes("OMX_SESSION_ID='s1'"));
    assert.ok(command.includes("OMX_QUESTION_RETURN_TARGET='%11'"));
    assert.ok(command.includes("OMX_QUESTION_RETURN_TRANSPORT='tmux-send-keys'"));
    // The executable env runs is the real command (quoted node), never `-e`.
    assert.ok(command.includes(`'tmux-send-keys' '${process.execPath}' `));
    assert.ok(command.endsWith(`'${recordPath}'`));
  });

  it('single-quotes values containing =, % and spaces so they survive the cmux shell command', () => {
    const trickyReturnTarget = 'pane=%5 with spaces';
    const trickySessionId = 'sess=a%b c';
    const args = buildQuestionUiTmuxArgs(recordPath, {
      cwd: '/repo',
      sessionId: trickySessionId,
      returnTarget: trickyReturnTarget,
      underCmux: true,
    });
    const command = args[0];
    // `=`, `%`, and spaces round-trip intact inside single quotes.
    assert.match(command, /^env /);
    assert.ok(command.includes(`OMX_SESSION_ID='${trickySessionId}'`));
    assert.ok(command.includes(`OMX_QUESTION_RETURN_TARGET='${trickyReturnTarget}'`));
    assert.equal(command.includes(' -e '), false);
  });

  it('escapes embedded single quotes in env values under cmux', () => {
    const args = buildQuestionUiTmuxArgs(recordPath, {
      cwd: '/repo',
      sessionId: "a'b=c",
      underCmux: true,
    });
    // POSIX single-quote escaping: a'b=c -> 'a'\''b=c'
    assert.ok(args[0].includes("OMX_SESSION_ID='a'\\''b=c'"));
  });

  it('omits the env prefix entirely when there are no env vars under cmux', () => {
    const args = buildQuestionUiTmuxArgs(recordPath, { cwd: '/repo', underCmux: true });
    assert.equal(args.length, 1);
    assert.equal(args[0].startsWith('env '), false);
    assert.equal(args[0].includes('export'), false);
    assert.equal(args[0].includes('&&'), false);
    assert.ok(args[0].startsWith(`'${process.execPath}' `));
  });
});

describe('launchQuestionRenderer under cmux', () => {
  it('drops bare -e and exports env so the cmux split pane runs the real command', () => {
    const calls: string[][] = [];
    const result = launchQuestionRenderer(
      {
        cwd: '/repo',
        recordPath: '/repo/.omx/state/sessions/s1/questions/question-cmux.json',
        sessionId: 's1',
        env: {
          TMUX: '/tmp/tmux-demo',
          TMUX_PANE: '%11',
          CMUX_SOCKET_PATH: '/tmp/cmux.sock',
        } as NodeJS.ProcessEnv,
      },
      {
        strategy: 'inside-tmux',
        execTmux: (args) => {
          calls.push(args);
          if (args[0] === 'display-message' && args.includes('#{pane_height}')) return '40\n';
          if (args[0] === 'display-message') return '1\n';
          if (args[0] === 'split-window') return '%55\n';
          if (args[0] === 'list-panes') return '0\t%55\n';
          return '';
        },
        sleepSync: () => {},
      },
    );

    assert.equal(result.target, '%55');
    const splitCall = calls.find((call) => call[0] === 'split-window');
    assert.ok(splitCall);
    // cwd (-c) and pane flags are preserved exactly as on real tmux.
    assert.ok(splitCall.includes('-c'));
    assert.ok(splitCall.includes('/repo'));
    assert.ok(splitCall.includes('-P'));
    // No bare `-e` leaks into the cmux pane command (the original bug).
    assert.equal(splitCall.includes('-e'), false);
    // The pane command is a single shell-neutral env-prefixed shell-command argument.
    const paneCommand = splitCall[splitCall.length - 1];
    assert.match(paneCommand, /^env /);
    assert.equal(paneCommand.includes(' -e '), false);
    assert.equal(paneCommand.includes('export'), false);
    assert.ok(paneCommand.includes("OMX_SESSION_ID='s1'"));
    assert.ok(paneCommand.includes("OMX_QUESTION_RETURN_TARGET='%11'"));
    // env runs the real command (quoted node), never `-e`.
    assert.ok(paneCommand.includes(`'${process.execPath}' `));
  });
});
