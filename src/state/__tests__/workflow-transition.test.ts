import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkflowTransitionMessage,
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  readActiveWorkflowModes,
} from '../workflow-transition.js';
import { reconcileWorkflowTransition } from '../workflow-transition-reconcile.js';

describe('workflow transition rules', () => {
  it('allows the approved overlap matrix and denies unsupported combinations', () => {
    const cases: Array<{
      current: string[];
      requested: 'team' | 'ralph' | 'ultrawork' | 'autopilot' | 'autoresearch';
      allowed: boolean;
      resulting: string[];
    }> = [
      { current: [], requested: 'team', allowed: true, resulting: ['team'] },
      { current: ['team'], requested: 'ralph', allowed: true, resulting: ['team', 'ralph'] },
      { current: ['ralph'], requested: 'team', allowed: true, resulting: ['ralph', 'team'] },
      { current: ['team'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'team', allowed: true, resulting: ['ultrawork', 'team'] },
      { current: ['ralph'], requested: 'ultrawork', allowed: true, resulting: ['ralph', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'ralph', allowed: true, resulting: ['ultrawork', 'ralph'] },
      { current: ['autopilot'], requested: 'team', allowed: false, resulting: ['autopilot'] },
      { current: ['team'], requested: 'autopilot', allowed: false, resulting: ['team'] },
      { current: ['autoresearch'], requested: 'ralph', allowed: false, resulting: ['autoresearch'] },
      { current: ['team', 'ralph'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ralph', 'ultrawork'] },
      { current: ['team', 'ultrawork'], requested: 'ralph', allowed: true, resulting: ['team', 'ultrawork', 'ralph'] },
    ];

    for (const testCase of cases) {
      const decision = evaluateWorkflowTransition(testCase.current, testCase.requested);
      assert.equal(decision.allowed, testCase.allowed, `${testCase.current.join(',')} -> ${testCase.requested}`);
      assert.deepEqual(decision.resultingModes, testCase.resulting, `${testCase.current.join(',')} -> ${testCase.requested}`);
    }
  });

  it('builds actionable denial guidance that names both clearing paths', () => {
    const error = buildWorkflowTransitionError(['team'], 'autopilot', 'start');
    assert.match(error, /Cannot start autopilot: team is already active\./);
    assert.match(error, /Unsupported workflow overlap: team \+ autopilot\./);
    assert.match(error, /Current state is unchanged\./);
    assert.match(error, /Clear incompatible workflow state yourself via/);
    assert.match(error, /`omx state clear --mode <mode>`/);
    assert.match(error, /`omx_state\.\*` MCP tools/);
  });

  it('returns auto-complete decisions for allowlisted forward transitions', () => {
    const interviewToRalplan = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(interviewToRalplan.allowed, true);
    assert.equal(interviewToRalplan.kind, 'auto-complete');
    assert.deepEqual(interviewToRalplan.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToRalplan.resultingModes, ['ralplan']);
    assert.equal(interviewToRalplan.transitionMessage, 'mode transiting: deep-interview -> ralplan');

    const interviewToAutoresearch = evaluateWorkflowTransition(['deep-interview'], 'autoresearch');
    assert.equal(interviewToAutoresearch.allowed, true);
    assert.equal(interviewToAutoresearch.kind, 'auto-complete');
    assert.deepEqual(interviewToAutoresearch.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToAutoresearch.resultingModes, ['autoresearch']);
    assert.equal(interviewToAutoresearch.transitionMessage, 'mode transiting: deep-interview -> autoresearch');

    const ralplanToRalph = evaluateWorkflowTransition(['ralplan', 'ultrawork'], 'ralph');
    assert.equal(ralplanToRalph.allowed, true);
    assert.equal(ralplanToRalph.kind, 'auto-complete');
    assert.deepEqual(ralplanToRalph.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToRalph.resultingModes, ['ultrawork', 'ralph']);

    const ralplanToAutoresearch = evaluateWorkflowTransition(['ralplan'], 'autoresearch');
    assert.equal(ralplanToAutoresearch.allowed, true);
    assert.equal(ralplanToAutoresearch.kind, 'auto-complete');
    assert.deepEqual(ralplanToAutoresearch.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToAutoresearch.resultingModes, ['autoresearch']);
  });

  it('builds rollback denial guidance for execution-to-planning transitions', () => {
    const error = buildWorkflowTransitionError(['ralph'], 'ralplan', 'start');
    assert.match(error, /Execution-to-planning rollback auto-complete is not allowed\./);
    assert.match(error, /First clear current state first and retry if this action is intended\./);
    assert.match(error, /Clear incompatible workflow state yourself via/);
  });


  it('allows autopilot to return to ralplan for non-clean code-review cycles', () => {
    const decision = evaluateWorkflowTransition(['autopilot'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'auto-complete');
    assert.deepEqual(decision.autoCompleteModes, ['autopilot']);
    assert.deepEqual(decision.resultingModes, ['ralplan']);
    assert.equal(decision.transitionMessage, 'mode transiting: autopilot -> ralplan');
  });

  it('formats transition audit messages', () => {
    assert.equal(
      buildWorkflowTransitionMessage('ralplan', 'ralph'),
      'mode transiting: ralplan -> ralph',
    );
  });

  it('ignores stale root workflow state for session-scoped active decisions', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-active-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-current');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(stateDir, 'ralph-state.json'),
        JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(stateDir, 'session.json'),
        JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
        'utf-8',
      );

      assert.deepEqual(await readActiveWorkflowModes(wd, 'sess-current'), []);
      assert.deepEqual(await readActiveWorkflowModes(wd), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete stale root workflow state during a session transition', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-current');
      const rootRalphPath = join(stateDir, 'ralph-state.json');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        rootRalphPath,
        JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
        'utf-8',
      );

      const transition = await reconcileWorkflowTransition(wd, 'ralplan', {
        action: 'start',
        sessionId: 'sess-current',
        source: 'test',
      });

      assert.equal(transition.decision.allowed, true);
      assert.deepEqual(transition.decision.currentModes, []);
      assert.deepEqual(transition.completedPaths, []);

      const rootRalph = JSON.parse(await readFile(rootRalphPath, 'utf-8')) as { active?: unknown };
      assert.equal(rootRalph.active, true);
      assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
