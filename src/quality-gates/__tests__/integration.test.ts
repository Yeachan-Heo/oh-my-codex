import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPlanStageGates } from '../plan-stage-wiring.js';
import { qualityGatesCommand } from '../../bin/quality-gates-cli.js';
import { runRalplanConsensus, type RalplanConsensusExecutor } from '../../ralplan/runtime.js';
import { readModeStateForExplicitSession } from '../../modes/base.js';
import { readSubagentTrackingState } from '../../subagents/tracker.js';
import type { QualityGate } from '../../config/quality-gates.js';

const blocking: QualityGate = { skill: 'risk-check', mode: 'blocking', model: 'review-model' };
const advisory: QualityGate = { skill: 'style-check', mode: 'advisory' };
const sessionId = 'quality-gates-integration';

function executor(events: string[], qualityGateReview?: RalplanConsensusExecutor['qualityGateReview']): RalplanConsensusExecutor {
  return {
    async draft() { events.push('draft'); return { summary: 'Plan with acceptance criteria' }; },
    async architectReview() { events.push('architect'); return { verdict: 'approve', agent_role: 'architect' }; },
    async criticReview() { events.push('critic'); return { verdict: 'approve', agent_role: 'critic' }; },
    qualityGateReview,
  };
}

describe('quality gates integration', () => {
  let cwd: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'omx-quality-gates-integration-'));
    originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = cwd;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    rmSync(cwd, { recursive: true, force: true });
  });
  function configure(gates: QualityGate[]) {
    writeFileSync(join(cwd, '.omx-config.json'), JSON.stringify({ qualityGates: { plan: gates, interview: [advisory] } }));
  }
  function run(callback?: RalplanConsensusExecutor['qualityGateReview'], events: string[] = [], maxIterations = 1) {
    return runRalplanConsensus(executor(events, callback), { task: 'Review a deployment plan', cwd, sessionId, maxIterations });
  }

  it('loads configured plan gates from .omx-config.json rather than other stages', () => {
    configure([blocking, advisory]);
    assert.deepEqual(getPlanStageGates(), [blocking, advisory]);
  });

  it('dispatches configured gate subagents after Critic and collects native results', async () => {
    configure([blocking, advisory]);
    const events: string[] = [];
    const result = await run(async ctx => {
      events.push(ctx.gate.skill);
      assert.deepEqual(ctx.gate, ctx.gate.skill === blocking.skill ? blocking : advisory);
      assert.equal(ctx.draft.summary, 'Plan with acceptance criteria');
      assert.equal(ctx.architectReview.verdict, 'approve');
      assert.equal(ctx.criticReview.verdict, 'approve');
      return { verdict: 'approve', summary: `Passed ${ctx.gate.skill}`, provenance_kind: 'native_subagent', thread_id: `thread-${ctx.gate.skill}` };
    }, events);
    assert.deepEqual(events, ['draft', 'architect', 'critic', 'risk-check', 'style-check']);
    assert.equal(result.status, 'completed');
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['risk-check'].verdict, 'approve');
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['style-check'].summary, 'Passed style-check');
    const state = await readModeStateForExplicitSession('ralplan', sessionId, cwd);
    assert.deepEqual((state?.ralplan_consensus_gate as Record<string, unknown>).qualityGateResults, result.ralplanConsensusGate.qualityGateResults);
    const tracking = await readSubagentTrackingState(cwd);
    assert.ok(tracking.sessions[sessionId]?.threads['thread-risk-check']?.completed_at);
    assert.ok(tracking.sessions[sessionId]?.threads['thread-style-check']?.completed_at);
  });

  it('blocks progression when a blocking gate rejects an otherwise approved plan', async () => {
    configure([blocking]);
    const result = await run(async () => ({ verdict: 'reject', summary: 'Rollback is missing', provenance_kind: 'native_subagent', thread_id: 'blocking-thread' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.planningComplete, false);
    assert.equal(result.ralplanConsensusGate.complete, false);
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['risk-check'].verdict, 'reject');
    const state = await readModeStateForExplicitSession('ralplan', sessionId, cwd);
    assert.notEqual((state?.ralplan_execution_handoff as Record<string, unknown> | undefined)?.authorized, true);
  });

  it('records advisory rejection without blocking progression', async () => {
    configure([advisory]);
    const result = await run(async () => ({ verdict: 'reject', summary: 'Consider a shorter title', provenance_kind: 'native_subagent', thread_id: 'advisory-thread' }));
    assert.equal(result.status, 'completed');
    assert.equal(result.planningComplete, true);
    assert.equal(result.ralplanConsensusGate.complete, true);
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['style-check'].verdict, 'reject');
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['style-check'].summary, 'Consider a shorter title');
  });

  it('retries blocked plans and collects a fresh passing gate result', async () => {
    configure([blocking]);
    const events: string[] = [];
    const result = await run(async ctx => {
      events.push(`gate-${ctx.iteration}`);
      return { verdict: ctx.iteration === 1 ? 'iterate' : 'approve', summary: `Review ${ctx.iteration}`, provenance_kind: 'native_subagent', thread_id: `retry-thread-${ctx.iteration}` };
    }, events, 2);
    assert.deepEqual(events, ['draft', 'architect', 'critic', 'gate-1', 'draft', 'architect', 'critic', 'gate-2']);
    assert.equal(result.iteration, 2);
    assert.equal(result.status, 'completed');
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['risk-check'].verdict, 'approve');
  });

  it('fails closed when a configured blocking gate cannot spawn', async () => {
    configure([blocking]);
    const result = await run();
    assert.equal(result.status, 'failed');
    assert.equal(result.ralplanConsensusGate.complete, false);
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['risk-check'].verdict, 'unavailable');
  });

  it('lists configured CLI gates with stage and mode partitions', () => {
    configure([blocking, advisory]);
    assert.deepEqual(JSON.parse(qualityGatesCommand(['list', '--stage', 'plan', '--json'], cwd)), {
      gates: [blocking, advisory], stage: 'plan', advisory: [advisory], blocking: [blocking],
    });
  });

  it('records unavailable advisory gates without blocking completion', async () => {
    configure([advisory]);
    const result = await run(async () => { throw new Error('Subagent unavailable'); });
    assert.equal(result.status, 'completed');
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['style-check'].verdict, 'unavailable');
    assert.match(result.ralplanConsensusGate.qualityGateResults?.['style-check'].summary ?? '', /Subagent unavailable/);
  });

  it('does not accept a blocking approval without native subagent evidence', async () => {
    configure([blocking]);
    const result = await run(async () => ({ verdict: 'approve', summary: 'Unverified approval' }));
    assert.equal(result.status, 'failed');
    assert.equal(result.ralplanConsensusGate.complete, false);
    assert.equal(result.ralplanConsensusGate.qualityGateResults?.['risk-check'].verdict, 'unavailable');
  });

  it('feeds blocking exceptions into revision and enforces the five-iteration cap', async () => {
    configure([blocking]);
    let drafts = 0;
    const implementation = executor([], async () => { throw new Error('Gate spawn failed'); });
    implementation.draft = async ctx => {
      drafts++;
      if (ctx.iteration > 1) {
        assert.equal(ctx.gateResults.at(-1)?.verdict, 'unavailable');
        assert.match(ctx.gateResults.at(-1)?.summary ?? '', /Gate spawn failed/);
      }
      return { summary: 'Revised deployment plan' };
    };
    const result = await runRalplanConsensus(implementation, {
      task: 'Review a deployment plan', cwd, sessionId, maxIterations: 9,
    });
    assert.equal(drafts, 5);
    assert.equal(result.iteration, 5);
    assert.equal(result.status, 'failed');
    assert.equal(result.ralplanConsensusGate.complete, false);
  });

  it('returns a structured CLI error for an invalid stage', () => {
    const output = JSON.parse(qualityGatesCommand(['list', '--stage', 'planning', '--json'], cwd));
    assert.equal(typeof output.error, 'string');
    assert.match(output.error, /stage/i);
    assert.equal(output.gates, undefined);
  });
});
