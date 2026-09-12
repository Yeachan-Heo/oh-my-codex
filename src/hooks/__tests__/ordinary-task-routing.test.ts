import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { detectPrimaryKeyword } from '../keyword-detector.js';
import { dispatchCodexNativeHook } from '../../scripts/codex-native-hook.js';

// Isolate fixture ownership/capability from the invoking OMX session.
const envKeys = ['OMX_TEAM_WORKER', 'OMX_TEAM_INTERNAL_WORKER', 'OMX_TEAM_STATE_ROOT', 'OMX_TEAM_LEADER_CWD', 'OMX_TEAM_MODE', 'OMX_SESSION_ID', 'OMX_ROOT', 'OMX_STATE_ROOT', 'SESSION_ID', 'OMX_QUESTION_RETURN_PANE', 'OMX_LEADER_PANE_ID', 'TMUX', 'TMUX_PANE', 'OMX_TMUX_HUD_OWNER'];
const priorEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of envKeys) { priorEnv.set(key, process.env[key]); delete process.env[key]; }
});
afterEach(() => {
  for (const key of envKeys) {
    const value = priorEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  priorEnv.clear();
});

const ordinaryPrompts = [
  'build me a small dashboard',
  'I want a starter API',
  'autopilot',
  'ultragoal',
  'fix the null check in src/example.ts',
  'refactor this helper without changing behavior',
  'run npm test and fix the failing assertion',
  'run autopilot tests',
  'why did autopilot fail?',
  'what is autopilot mode?',
  'what is ultragoal mode?',
  'compare autopilot mode with ultragoal',
  'inspect .omx/ultragoal/goals.json',
  'the documentation mentions `$autopilot`',
  'go ahead and implement the approved change',
  '按照这个plan开始执行优化',
  '这些优化都做了么',
];
const requestedWorkflows = [
  ['$autopilot implement the bounded fix', 'autopilot'],
  ['$ultragoal implement the bounded fix', 'ultragoal'],
  ['run autopilot', 'autopilot'],
  ['start autopilot', 'autopilot'],
  ['use autopilot', 'autopilot'],
  ['use autopilot mode', 'autopilot'],
  ['use autopilot mode for this task', 'autopilot'],
  ['run autopilot workflow on this repo', 'autopilot'],
  ['please run ultragoal workflow for this launch', 'ultragoal'],
] as const;

// This is a routing/state regression corpus, not a model-quality benchmark.
describe('ordinary-task routing corpus', () => {
  for (const prompt of ordinaryPrompts) {
    it(`does not activate a workflow for ${JSON.stringify(prompt)}`, async () => {
      assert.equal(detectPrimaryKeyword(prompt), null);
      const cwd = await mkdtemp(join(tmpdir(), 'omx-ordinary-routing-'));
      try {
        await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
        const result = await dispatchCodexNativeHook({
          hook_event_name: 'UserPromptSubmit', cwd,
          session_id: 'ordinary-task', prompt,
        }, { cwd });
        const output = JSON.stringify(result.outputJson);
        assert.doesNotMatch(output, /Newest user input is|Treat it as authorization to act now/);
        const paths = await readdir(join(cwd, '.omx', 'state'), { recursive: true });
        assert.deepEqual(paths.filter((path) => /(?:skill-active|autopilot|ultragoal|ralplan|deep-interview)-state\.json$/.test(path)), []);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const [prompt, skill] of requestedWorkflows) {
    it(`preserves requested ${JSON.stringify(prompt)}`, async () => {
      assert.equal(detectPrimaryKeyword(prompt)?.skill, skill);
      const cwd = await mkdtemp(join(tmpdir(), 'omx-requested-routing-'));
      try {
        await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
        const result = await dispatchCodexNativeHook({
          hook_event_name: 'UserPromptSubmit', cwd,
          session_id: 'requested-task', prompt,
        }, { cwd });
        assert.doesNotMatch(JSON.stringify(result.outputJson), /Newest user input is|Treat it as authorization to act now/);
        const paths = await readdir(join(cwd, '.omx', 'state'), { recursive: true });
        assert.ok(paths.some((path) => path.endsWith(`${skill}-state.json`)));
        assert.ok(paths.some((path) => path.endsWith('skill-active-state.json')));
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const token of ['$ralph', '$ultrawork', '$pipeline', '$autoresearch-goal']) {
    it(`diagnoses ${token} without activating a replacement workflow`, async () => {
      assert.equal(detectPrimaryKeyword(token), null);
      const cwd = await mkdtemp(join(tmpdir(), 'omx-retired-routing-'));
      try {
        await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
        const result = await dispatchCodexNativeHook({
          hook_event_name: 'UserPromptSubmit', cwd,
          session_id: 'retired-task', prompt: token,
        }, { cwd });
        assert.match(JSON.stringify(result.outputJson), /has been removed/);
        const paths = await readdir(join(cwd, '.omx', 'state'), { recursive: true });
        assert.deepEqual(paths.filter((path) => /-state\.json$/.test(path) && !path.endsWith('skill-active-state.json')), []);
        const diagnosticPath = paths.find((path) => path.endsWith('skill-active-state.json'));
        assert.ok(diagnosticPath);
        const diagnostic = JSON.parse(await readFile(join(cwd, '.omx', 'state', diagnosticPath), 'utf8'));
        assert.equal(diagnostic.active, false);
        assert.deepEqual(diagnostic.active_skills, []);
        assert.match(diagnostic.transition_error, /has been removed/);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

});
