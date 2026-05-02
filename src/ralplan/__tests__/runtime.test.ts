import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode } from '../../modes/base.js';
import { cancelRalplanConsensus, runRalplanConsensus } from '../runtime.js';

function sessionStatePath(cwd: string, sessionId: string): string {
  return join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json');
}

async function readScopedRalplanState(cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionStatePath(cwd, sessionId), 'utf-8'));
}

describe('ralplan runtime', () => {
  it('persists a successful session-scoped lifecycle through complete', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-'));
    const sessionId = 'sess-ralplan-success';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const seenPhases: string[] = [];
      const result = await runRalplanConsensus({
        async draft(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'draft');
          assert.equal(state.iteration, 1);

          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-success.md');
          await writeFile(prdPath, '# plan\n');
          await writeFile(join(plansDir, 'test-spec-success.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath, artifacts: { drafted: true } };
        },
        async architectReview() {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'architect-review');
          assert.equal(state.iteration, 1);
          return { verdict: 'approve', summary: 'architect-ok', artifacts: { architected: true } };
        },
        async criticReview() {
          const state = await readScopedRalplanState(cwd, sessionId);
          seenPhases.push(String(state.current_phase));
          assert.equal(state.current_phase, 'critic-review');
          assert.equal(state.iteration, 1);
          return { verdict: 'approve', summary: 'critic-ok', artifacts: { critiqued: true } };
        },
      }, { task: 'implement live ralplan runtime', cwd });

      assert.equal(result.status, 'completed');
      assert.equal(result.phase, 'complete');
      assert.equal(result.iteration, 1);
      assert.equal(result.planningComplete, true);
      assert.deepEqual(seenPhases, ['draft', 'architect-review', 'critic-review']);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'ralplan-state.json')), false);
      assert.equal(existsSync(sessionStatePath(cwd, sessionId)), true);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'complete');
      assert.equal(finalState?.iteration, 1);
      assert.equal(finalState?.planning_complete, true);
      assert.match(String(finalState?.status_message || ''), /Status: complete/);
      assert.equal(finalState?.latest_architect_verdict, 'approve');
      assert.equal(finalState?.latest_critic_verdict, 'approve');
      assert.equal(Array.isArray(finalState?.review_history), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('increments iteration when critic requests a re-review loop', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-loop-'));
    const sessionId = 'sess-ralplan-loop';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const draftIterations: number[] = [];
      const criticVerdicts: string[] = [];
      let criticCalls = 0;

      const result = await runRalplanConsensus({
        async draft(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          draftIterations.push(Number(state.iteration));
          assert.equal(state.current_phase, 'draft');

          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-loop.md');
          await writeFile(prdPath, '# loop plan\n');
          await writeFile(join(plansDir, 'test-spec-loop.md'), '# loop tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath };
        },
        async architectReview(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          assert.equal(state.current_phase, 'architect-review');
          return { verdict: 'approve', summary: `architect-${ctx.iteration}` };
        },
        async criticReview(ctx) {
          const state = await readScopedRalplanState(cwd, sessionId);
          assert.equal(state.current_phase, 'critic-review');
          criticCalls += 1;
          const verdict = criticCalls === 1 ? 'iterate' : 'approve';
          criticVerdicts.push(verdict);
          return { verdict, summary: `critic-${ctx.iteration}-${verdict}` };
        },
      }, { task: 'loop until approval', cwd, maxIterations: 3 });

      assert.equal(result.status, 'completed');
      assert.equal(result.iteration, 2);
      assert.deepEqual(draftIterations, [1, 2]);
      assert.deepEqual(criticVerdicts, ['iterate', 'approve']);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.current_phase, 'complete');
      assert.equal(finalState?.iteration, 2);
      assert.equal((finalState?.review_history as Array<unknown>).length, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks failed cleanly when execution throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-fail-'));
    const sessionId = 'sess-ralplan-fail';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft' };
        },
        async architectReview() {
          throw new Error('architect blew up');
        },
        async criticReview() {
          throw new Error('should not run');
        },
      }, { task: 'failing ralplan runtime', cwd });

      assert.equal(result.status, 'failed');
      assert.match(result.error || '', /architect blew up/);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.match(String(finalState?.status_message || ''), /Status: failed/);
      assert.match(String(finalState?.error || ''), /architect blew up/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('marks cancelled state cleanly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-cancel-'));
    const sessionId = 'sess-ralplan-cancel';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      await startMode('ralplan', 'cancel me', 2, cwd);
      await cancelRalplanConsensus(cwd);

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'cancelled');
      assert.ok(typeof finalState?.completed_at === 'string' && finalState.completed_at.length > 0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
