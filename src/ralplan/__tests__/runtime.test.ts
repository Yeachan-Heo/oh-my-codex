import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode } from '../../modes/base.js';
import { cancelRalplanConsensus, runRalplanConsensus } from '../runtime.js';
import {
  REQUIRED_CONTEXT_PACK_ROLES,
  readContextPackDocument,
  writeContextPackDocument,
  type ContextPackRole,
} from '../../planning/context-packs.js';

const CONTEXT_PACK_SCHEMA = 'omx-context-pack-v1';

function defaultReadFirstRef(
  slug: string,
  role: ContextPackRole,
): { label: string; path: string; relationTag: string } {
  if (role === 'scope') {
    return { label: 'boundary', path: `docs/${slug}-boundary.md`, relationTag: 'bounds' };
  }
  if (role === 'verify') {
    return { label: 'acceptance', path: `docs/${slug}-acceptance.md`, relationTag: 'verifies' };
  }
  return { label: 'implementation', path: `docs/${slug}-implementation.md`, relationTag: 'implements' };
}

function sessionStatePath(cwd: string, sessionId: string): string {
  return join(cwd, '.omx', 'state', 'sessions', sessionId, 'ralplan-state.json');
}

async function readScopedRalplanState(cwd: string, sessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(sessionStatePath(cwd, sessionId), 'utf-8'));
}

async function writeContextPackSet(cwd: string, slug: string): Promise<string> {
  const contextDir = join(cwd, '.omx', 'context');
  await mkdir(contextDir, { recursive: true });

  const lines = ['## Context Pack Outcome'];
  for (const role of REQUIRED_CONTEXT_PACK_ROLES) {
    const readFirstRef = defaultReadFirstRef(slug, role);
    await mkdir(join(cwd, 'docs'), { recursive: true });
    await writeFile(
      join(cwd, readFirstRef.path),
      `# ${readFirstRef.label}\n\n${role} context for ${slug}.\n`,
    );
  }

  const relativePath = `.omx/context/context-20260420T000000Z-${slug}.json`;
  writeContextPackDocument(join(cwd, relativePath), {
    schema: CONTEXT_PACK_SCHEMA,
    slug,
    entries: REQUIRED_CONTEXT_PACK_ROLES.map((role) => {
      const readFirstRef = defaultReadFirstRef(slug, role);
      return {
        label: readFirstRef.label,
        path: readFirstRef.path,
        roles: [role],
        tags: [],
        relationPath: [
          { tag: 'plan', target: slug },
          { tag: readFirstRef.relationTag, target: readFirstRef.path },
        ],
      };
    }),
  }, { refreshBasis: true });
  lines.push(`- pack: created \`${relativePath}\``);

  return `${lines.join('\n')}\n`;
}

function refreshContextPackBasis(cwd: string, slug: string): void {
  const packPath = join(cwd, '.omx', 'context', `context-20260420T000000Z-${slug}.json`);
  const document = readContextPackDocument(packPath);
  assert.ok(document, `expected context pack at ${packPath}`);
  writeContextPackDocument(packPath, document, { refreshBasis: true });
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
          const contextPackOutcome = await writeContextPackSet(cwd, 'success');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-success.md');
          await writeFile(prdPath, `# plan\n\n${contextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-success.md'), '# tests\n');
          refreshContextPackBasis(cwd, 'success');
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
          const contextPackOutcome = await writeContextPackSet(cwd, 'loop');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-loop.md');
          await writeFile(prdPath, `# loop plan\n\n${contextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-loop.md'), '# loop tests\n');
          refreshContextPackBasis(cwd, 'loop');
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

  it('fails closed when critic approves before the handoff is pack-ready', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-pack-gate-'));
    const sessionId = 'sess-ralplan-pack-gate';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          const contextPackOutcome = await writeContextPackSet(cwd, 'pack-gate');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-pack-gate.md');
          await writeFile(prdPath, `# plan\n\n${contextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-pack-gate.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath, artifacts: { drafted: true } };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic-ok' };
        },
      }, { task: 'fail closed until pack is synced', cwd });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.planningComplete, false);
      assert.equal(result.error, 'ralplan_handoff_not_ready');

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.equal(finalState?.planning_complete, false);
      assert.equal(finalState?.error, 'ralplan_handoff_not_ready');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when critic approves a plan-only handoff without a declared context pack', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-plan-only-gate-'));
    const sessionId = 'sess-ralplan-plan-only-gate';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          await mkdir(plansDir, { recursive: true });
          const prdPath = join(plansDir, 'prd-plan-only-gate.md');
          await writeFile(
            prdPath,
            '# plan\n\nLaunch via omx ralph "Execute approved plan-only handoff"\n',
          );
          await writeFile(join(plansDir, 'test-spec-plan-only-gate.md'), '# tests\n');
          return { summary: `draft-${ctx.iteration}`, planPath: prdPath, artifacts: { drafted: true } };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic-ok' };
        },
      }, { task: 'fail closed until a ready context pack is declared', cwd });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.planningComplete, false);
      assert.equal(result.error, 'ralplan_handoff_not_ready');

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'failed');
      assert.equal(finalState?.planning_complete, false);
      assert.equal(finalState?.error, 'ralplan_handoff_not_ready');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('validates the session-approved plan instead of the lexicographically latest PRD on disk', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-approved-plan-'));
    const sessionId = 'sess-ralplan-approved-plan';
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          const approvedContextPackOutcome = await writeContextPackSet(cwd, 'alpha');
          const staleContextPackOutcome = await writeContextPackSet(cwd, 'zeta');
          await mkdir(plansDir, { recursive: true });

          const approvedPlanPath = join(plansDir, 'prd-alpha.md');
          await writeFile(approvedPlanPath, `# alpha\n\n${approvedContextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-alpha.md'), '# alpha tests\n');
          refreshContextPackBasis(cwd, 'alpha');

          await writeFile(join(plansDir, 'prd-zeta.md'), `# zeta\n\n${staleContextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-zeta.md'), '# zeta tests\n');

          return { summary: `draft-${ctx.iteration}`, planPath: approvedPlanPath };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic-ok' };
        },
      }, { task: 'honor the approved alpha handoff', cwd });

      assert.equal(result.status, 'completed');
      assert.equal(result.phase, 'complete');
      assert.equal(result.planningComplete, true);
      assert.equal(result.latestPlanPath, join(cwd, '.omx', 'plans', 'prd-alpha.md'));

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'complete');
      assert.equal(finalState?.planning_complete, true);
      assert.equal(finalState?.latest_plan_path, join(cwd, '.omx', 'plans', 'prd-alpha.md'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts repo-relative draft plan paths when process cwd differs from the workspace root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-relative-plan-'));
    const processCwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-process-cwd-'));
    const sessionId = 'sess-ralplan-relative-plan';
    const previousCwd = process.cwd();
    try {
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId }));

      process.chdir(processCwd);
      const result = await runRalplanConsensus({
        async draft(ctx) {
          const plansDir = join(cwd, '.omx', 'plans');
          const contextPackOutcome = await writeContextPackSet(cwd, 'relative-plan');
          await mkdir(plansDir, { recursive: true });
          await writeFile(join(plansDir, 'prd-relative-plan.md'), `# relative plan\n\n${contextPackOutcome}`);
          await writeFile(join(plansDir, 'test-spec-relative-plan.md'), '# relative tests\n');
          refreshContextPackBasis(cwd, 'relative-plan');
          return { summary: `draft-${ctx.iteration}`, planPath: '.omx/plans/prd-relative-plan.md' };
        },
        async architectReview() {
          return { verdict: 'approve', summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve', summary: 'critic-ok' };
        },
      }, { task: 'allow repo-relative ralplan handoff validation', cwd });

      assert.equal(result.status, 'completed');
      assert.equal(result.phase, 'complete');
      assert.equal(result.planningComplete, true);
      assert.equal(result.latestPlanPath, '.omx/plans/prd-relative-plan.md');

      const finalState = await readModeState('ralplan', cwd);
      assert.equal(finalState?.active, false);
      assert.equal(finalState?.current_phase, 'complete');
      assert.equal(finalState?.planning_complete, true);
      assert.equal(finalState?.latest_plan_path, '.omx/plans/prd-relative-plan.md');
    } finally {
      process.chdir(previousCwd);
      await rm(processCwd, { recursive: true, force: true });
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
