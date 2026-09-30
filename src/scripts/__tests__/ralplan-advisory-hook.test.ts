import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  readCurrentRalplanAdvisory,
  reconcileRalplanAdvisory,
  observeRalplanAdvisoryPrompt,
  terminalizeRalplanAdvisory,
} from '../../ralplan/advisory.js';
import { activateOrResumeRalplanAdvisory } from '../../ralplan/advisory-activation.js';
import {
  buildRalplanAdvisoryRoutingObservation,
  dispatchCodexNativeHook,
} from '../codex-native-hook.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function terminalFixture(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  roots.push(cwd);
  const sessionId = 'session-a';
  const stateDir = join(cwd, '.omx', 'state');
  const sessionDir = join(stateDir, 'sessions', sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
    leader_thread_id: 'root-a', started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
  }));
  await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
    schemaVersion: 1,
    sessions: {
      [sessionId]: {
        session_id: sessionId, leader_thread_id: 'root-a',
        threads: { 'root-a': { thread_id: 'root-a', kind: 'leader' } },
      },
    },
  }));
  const { activation } = await activateOrResumeRalplanAdvisory({
    cwd, sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-a', generationId: 'generation-a',
    prompt: '$ralplan --advisory hook fixture', producer: 'native', threadKind: 'root-or-drift',
  });
  const activeMode = {
    active: true, mode: 'ralplan', current_phase: 'draft', iteration: 1,
    session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-a',
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
    execution_handoff_authorized: false, host_verified: false, planning_complete: false,
  };
  await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(activeMode));
  await terminalizeRalplanAdvisory({
    cwd, sessionId, generationId: activation.generation_id, closingTurnId: 'turn-close', iteration: 1,
    outcome: 'cancelled', integrityStatus: 'proven',
  });
  const inactiveMode = {
    ...activeMode, active: false, current_phase: 'complete', planning_complete: true,
    execution_handoff_authorized: false, host_verified: false,
    ralplan_consensus_gate: { complete: false },
  };
  await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));
  await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(inactiveMode));
  return { cwd, sessionId, stateDir, sessionDir, activation };
}

async function conflictingReplayFixture(prefix: string, standardPhase = 'architect-review') {
  const fixture = await terminalFixture(prefix);
  // Replace the committed cancellation fixture with a fresh generation whose
  // journal is deliberately left prepared before any mirror replay.
  await rm(join(fixture.sessionDir, 'ralplan-advisory'), { recursive: true, force: true });
  const { activation } = await activateOrResumeRalplanAdvisory({
    cwd: fixture.cwd, sessionId: fixture.sessionId, rootThreadId: 'root-a', activationTurnId: 'turn-replay', generationId: 'generation-replay',
    prompt: '$ralplan --advisory replay fixture', producer: 'native', threadKind: 'root-or-drift',
  });
  const advisoryMode = {
    active: true, mode: 'ralplan', current_phase: 'draft', session_id: fixture.sessionId, thread_id: 'root-a', turn_id: 'turn-replay',
    workflow_variant: 'advisory', advisory_generation_id: activation.generation_id,
  };
  await writeFile(join(fixture.sessionDir, 'ralplan-state.json'), JSON.stringify(advisoryMode));
  await assert.rejects(terminalizeRalplanAdvisory({
    cwd: fixture.cwd, sessionId: fixture.sessionId, generationId: activation.generation_id,
    closingTurnId: 'turn-close-replay', iteration: 1, outcome: 'cancelled', integrityStatus: 'proven',
    terminalModeUpdates: {
      ...advisoryMode, active: false, current_phase: 'cancelled', execution_handoff_authorized: false, host_verified: false,
    },
    failpoint: (name) => { if (name === 'journal-prepare') throw new Error('prepared-replay'); },
  }), /prepared-replay/);
  const standardMode = {
    active: true, mode: 'ralplan', workflow_variant: 'standard', current_phase: standardPhase,
    session_id: fixture.sessionId, thread_id: 'root-standard', turn_id: 'turn-standard',
  };
  const modePath = join(fixture.sessionDir, 'ralplan-state.json');
  await writeFile(modePath, JSON.stringify(standardMode));
  return { ...fixture, activation, generationDir: join(fixture.sessionDir, 'ralplan-advisory', activation.generation_id), modePath, standardMode };
}

async function snapshotDirectoryBytes(root: string): Promise<Array<[string, string]>> {
  const values: Array<[string, string]> = [];
  const walk = async (directory: string, prefix = ''): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, relative);
      else values.push([relative, (await readFile(path)).toString('base64')]);
    }
  };
  await walk(root);
  return values;
}

describe('ralplan advisory non-authoritative native hooks', () => {
  it('the packed hook never emits a PreToolUse block for Advisory, including mutation and unknown MCP transports', async () => {
    const { cwd, sessionId } = await terminalFixture('omx-advisory-nonauthoritative-pretool-');
    for (const toolName of ['Write', 'Bash', 'mcp__omx_goal__create_goal', 'mcp__thirdparty__commit', 'mcp__unknown__anything']) {
      const packed = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
        tool_name: toolName, tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
      } as never, { cwd });
      assert.notEqual(packed.outputJson?.decision, 'block', toolName);
    }
    const cli = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'scripts', 'codex-native-hook.js')], {
      cwd,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
        tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'packed.ts'), content: 'x' },
      }),
      encoding: 'utf8',
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.notEqual((JSON.parse(cli.stdout || '{}') as Record<string, unknown>).decision, 'block');
  });

  it('observes an explicit later execution request without automatic handoff or persistent elevation', async () => {
    const { cwd, sessionId, sessionDir, activation } = await terminalFixture('omx-advisory-routing-observation-');
    const before = await readCurrentRalplanAdvisory(cwd, sessionId);
    const observed = await observeRalplanAdvisoryPrompt({
      cwd, sessionId, turnId: 'turn-execute', threadId: 'root-a', prompt: 'implementá el plan .omx/plans/plan.md',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    const context = buildRalplanAdvisoryRoutingObservation(observed.intent, observed.projection, mode) ?? '';
    assert.match(context, /ended as cancelled/i);
    assert.doesNotMatch(context, /planning is complete/i);
    const after = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.deepEqual(after?.fence, before?.fence);
    assert.equal(mode.active, false);
    assert.equal(mode.planning_complete, true);
    assert.equal(mode.host_verified, false);
    assert.equal(mode.execution_handoff_authorized, false);
    await assert.rejects(readFile(join(sessionDir, 'ralplan-advisory', activation.generation_id, 'release-authority.json')), /ENOENT/);
  });

  it('keeps classifier negatives inert and supplies context only for a primary affirmative request', async () => {
    for (const [index, prompt] of ['¿podés implementarlo?', 'no quiero implementar', 'considerá implementar', 'copiá la frase implementá el plan'].entries()) {
      const { cwd, sessionId } = await terminalFixture(`omx-advisory-routing-negative-${index}-`);
      const observed = await observeRalplanAdvisoryPrompt({
        cwd, sessionId, turnId: `turn-${index}`, threadId: 'root-a', prompt,
        producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
      });
      const context = buildRalplanAdvisoryRoutingObservation(observed.intent, observed.projection, null) ?? '';
      assert.doesNotMatch(context, /non-authoritative routing observation/i, prompt);
    }
  });

  it('reports positive routing context only for a complete approved proven lifecycle without a conflicting workflow', async () => {
    const { cwd, sessionId } = await terminalFixture('omx-advisory-routing-matrix-');
    const base = (await readCurrentRalplanAdvisory(cwd, sessionId))!;
    const digest = 'a'.repeat(64);
    const approved = {
      ...base,
      fence: {
        ...base.fence!, state: 'closed', outcome: 'approved', integrity_status: 'proven', evidence_bundle_sha256: digest,
        iteration_id: 'iteration-a', plan_manifest_sha256: 'b'.repeat(64), architect_review_sha256: 'c'.repeat(64),
        critic_review_sha256: 'd'.repeat(64),
      },
      journal: {
        ...base.journal!, phase: 'committed', outcome: 'approved', integrity_status: 'proven', evidence_bundle_sha256: digest,
        terminal_mode_updates: { ralplan_review_lifecycle: {
          complete: true, sequence_valid: true, iteration: base.fence!.iteration, iteration_id: 'iteration-a',
          plan_manifest_sha256: 'b'.repeat(64), architect_review_sha256: 'c'.repeat(64),
          critic_review_sha256: 'd'.repeat(64), evidence_bundle_sha256: digest,
          evidence_scope: 'local_runtime', host_observable: false, host_verified: false,
        } },
      },
    } as typeof base;
    const advisoryBinding = {
      active: false, workflow_variant: 'advisory', advisory_generation_id: base.activation.generation_id,
      execution_handoff_authorized: false, host_verified: false, ralplan_consensus_gate: { complete: false },
    };
    const positive = buildRalplanAdvisoryRoutingObservation('execute', approved, advisoryBinding) ?? '';
    assert.match(positive, /planning is complete/i);
    assert.match(buildRalplanAdvisoryRoutingObservation('execute', approved, null) ?? '', /planning is complete/i);
    assert.equal(buildRalplanAdvisoryRoutingObservation('execute', approved, { workflow_variant: 'standard', active: true }), null);

    for (const [state, outcome, expected] of [
      ['pending_closeout', undefined, /still pending/i],
      ['recovery_required', 'failed', /requires lifecycle recovery/i],
      ['abandoned', 'abandoned', /ended as abandoned/i],
      ['abandoned', 'cancelled', /ended as cancelled/i],
    ] as const) {
      const projection = { ...base, fence: { ...base.fence!, state, outcome } } as typeof base;
      assert.match(buildRalplanAdvisoryRoutingObservation('execute', projection, advisoryBinding) ?? '', expected);
    }
    const incomplete = { ...approved, journal: { ...approved.journal!, terminal_mode_updates: {} } } as typeof base;
    assert.match(buildRalplanAdvisoryRoutingObservation('execute', incomplete, advisoryBinding) ?? '', /does not contain a complete/i);
  });

  it('retains terminal evidence across restart-shaped reads without creating authorization', async () => {
    const { cwd, sessionId, sessionDir } = await terminalFixture('omx-advisory-restart-evidence-');
    const first = await readCurrentRalplanAdvisory(cwd, sessionId);
    const second = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.deepEqual(second?.fence, first?.fence);
    assert.equal(second?.corruption, null);
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.host_verified, false);
    assert.equal(mode.execution_handoff_authorized, false);
  });

  it('surfaces reconciliation failures non-authoritatively while SessionStart and Stop continue normally', async () => {
    const { cwd, sessionId } = await terminalFixture('omx-advisory-reconcile-diagnostic-');
    const reconcileFailure = async (): Promise<never> => { throw new Error('test-reconcile-visible'); };
    const start = await dispatchCodexNativeHook({
      hook_event_name: 'SessionStart', cwd, session_id: sessionId, thread_id: 'root-a', source: 'startup',
    }, { cwd, reconcileRalplanAdvisoryFn: reconcileFailure });
    const startContext = ((start.outputJson?.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext ?? '') as string;
    assert.match(startContext, /test-reconcile-visible/);
    assert.match(startContext, /non-authoritative diagnostic/);
    assert.match(startContext, /Execution environment/i, 'normal SessionStart context should still be produced');

    const stopFixture = await terminalFixture('omx-advisory-stop-reconcile-diagnostic-');
    const stop = await dispatchCodexNativeHook({
      hook_event_name: 'Stop', cwd: stopFixture.cwd, source: 'codex-app', session_id: stopFixture.sessionId,
      thread_id: 'root-a', turn_id: 'turn-stop-diagnostic',
    }, { cwd: stopFixture.cwd, reconcileRalplanAdvisoryFn: reconcileFailure });
    assert.notEqual(stop.outputJson?.decision, 'block');
    const baselineFixture = await terminalFixture('omx-advisory-stop-reconcile-baseline-');
    const baselineStop = await dispatchCodexNativeHook({
      hook_event_name: 'Stop', cwd: baselineFixture.cwd, source: 'codex-app', session_id: baselineFixture.sessionId,
      thread_id: 'root-a', turn_id: 'turn-stop-baseline',
    }, { cwd: baselineFixture.cwd });
    assert.deepEqual(stop.outputJson, baselineStop.outputJson, 'diagnostic must not change the Stop decision/output contract');
    const logDir = join(stopFixture.cwd, '.omx', 'logs');
    const logBytes = (await Promise.all((await (await import('node:fs/promises')).readdir(logDir))
      .map((name) => readFile(join(logDir, name), 'utf8')))).join('\n');
    assert.match(logBytes, /ralplan_advisory_reconciliation_diagnostic/);
    assert.match(logBytes, /test-reconcile-visible/);
  });

  it('does not replay a terminal Advisory journal over a live standard workflow on SessionStart or Stop', async () => {
    const snapshotRelevant = async (fixture: Awaited<ReturnType<typeof conflictingReplayFixture>>) => ({
      mode: await readFile(fixture.modePath, 'utf8'),
      generation: await snapshotDirectoryBytes(fixture.generationDir),
      sessionSkill: await readFile(join(fixture.sessionDir, 'skill-active-state.json'), 'utf8').catch(() => null),
      rootSkill: await readFile(join(fixture.stateDir, 'skill-active-state.json'), 'utf8').catch(() => null),
    });

    const startFixture = await conflictingReplayFixture('omx-advisory-standard-start-conflict-');
    const startBefore = await snapshotRelevant(startFixture);
    const start = await dispatchCodexNativeHook({
      hook_event_name: 'SessionStart', cwd: startFixture.cwd, session_id: startFixture.sessionId,
      thread_id: 'root-standard', source: 'startup',
    }, { cwd: startFixture.cwd });
    const startContext = ((start.outputJson?.hookSpecificOutput as Record<string, unknown> | undefined)?.additionalContext ?? '') as string;
    assert.match(startContext, /live_session_binding_conflict/);
    assert.deepEqual(await snapshotRelevant(startFixture), startBefore);
    const routed = await observeRalplanAdvisoryPrompt({
      cwd: startFixture.cwd, sessionId: startFixture.sessionId, turnId: 'turn-replan-conflict', threadId: 'root-standard',
      prompt: 'replanificá el plan', producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    assert.equal(routed.intent, 'unrelated');
    assert.equal(routed.projection?.corruption, 'live_session_binding_conflict');
    assert.deepEqual(await snapshotRelevant(startFixture), startBefore);

    const stopFixture = await conflictingReplayFixture('omx-advisory-standard-stop-conflict-', 'critic-review');
    const stopBefore = await snapshotRelevant(stopFixture);
    const stop = await dispatchCodexNativeHook({
      hook_event_name: 'Stop', cwd: stopFixture.cwd, source: 'codex-app', session_id: stopFixture.sessionId,
      thread_id: 'root-standard', turn_id: 'turn-stop-standard-conflict',
    }, { cwd: stopFixture.cwd });
    assert.deepEqual(await snapshotRelevant(stopFixture), stopBefore);
    const logBytes = (await Promise.all((await readdir(join(stopFixture.cwd, '.omx', 'logs')))
      .map((name) => readFile(join(stopFixture.cwd, '.omx', 'logs', name), 'utf8')))).join('\n');
    assert.match(logBytes, /live_session_binding_conflict/);

    const baselineFixture = await conflictingReplayFixture('omx-advisory-standard-stop-baseline-', 'critic-review');
    await rm(join(baselineFixture.sessionDir, 'ralplan-advisory'), { recursive: true, force: true });
    const baseline = await dispatchCodexNativeHook({
      hook_event_name: 'Stop', cwd: baselineFixture.cwd, source: 'codex-app', session_id: baselineFixture.sessionId,
      thread_id: 'root-standard', turn_id: 'turn-stop-standard-baseline',
    }, { cwd: baselineFixture.cwd });
    assert.deepEqual(stop.outputJson, baseline.outputJson);
  });

  it('ignores forged local release authority and permits a later standard Ralplan binding', async () => {
    const { cwd, sessionId, stateDir, sessionDir, activation } = await terminalFixture('omx-advisory-forged-authority-');
    const generationDir = join(sessionDir, 'ralplan-advisory', activation.generation_id);
    await writeFile(join(generationDir, 'release-authority.json'), JSON.stringify({ authority_kind: 'forged-local' }));
    const observed = await observeRalplanAdvisoryPrompt({
      cwd, sessionId, turnId: 'turn-execute', threadId: 'root-a', prompt: 'implementá el plan .omx/plans/plan.md',
      producer: 'native', threadKind: 'root-or-drift', isSubagentPromptSubmit: false,
    });
    assert.equal(observed.intent, 'execute');
    assert.equal(observed.projection?.fence?.state, 'abandoned');
    const standardMode = {
      active: true, mode: 'ralplan', current_phase: 'draft', iteration: 1,
      session_id: sessionId, thread_id: 'root-a', turn_id: 'turn-standard', workflow_variant: 'standard',
    };
    await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify(standardMode));
    await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify(standardMode));
    const history = await readCurrentRalplanAdvisory(cwd, sessionId);
    assert.equal(history?.corruption, null);
    assert.equal(history?.fence?.state, 'abandoned');
    const write = await dispatchCodexNativeHook({
      hook_event_name: 'PreToolUse', cwd, session_id: sessionId, thread_id: 'root-a',
      tool_name: 'Write', tool_input: { file_path: join(cwd, 'src', 'x.ts'), content: 'x' },
    } as never, { cwd });
    assert.notEqual(write.outputJson?.decision, 'block');
  });

  it('(a) activates advisory via UserPromptSubmit with session_id + turn_id, no thread_id/threadId', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-thread-native-fallback-'));
    roots.push(cwd);
    const sessionId = 'native-dispatch-session-a';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
      leader_thread_id: sessionId, started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
    }));
    await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionId]: {
          session_id: sessionId, leader_thread_id: sessionId,
          threads: { [sessionId]: { thread_id: sessionId, kind: 'leader' } },
        },
      },
    }));
    // No thread_id or threadId: the hook dispatch should resolve threadId to session_id (fallback)
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      source: 'codex-app',
      session_id: sessionId,
      turn_id: 'turn-fallback-a',
      prompt: '$ralplan --advisory native dispatch test',
    });
    assert.notEqual(result.outputJson?.decision, 'block', 'advisory should activate without explicit thread_id');
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.workflow_variant, 'advisory', 'workflow_variant should be advisory');
    // Verify that advisory was actually created (has generation_id)
    assert.ok(mode.advisory_generation_id, 'advisory_generation_id should be persisted');
    // Verify thread_id is persisted as session_id (fallback case)
    assert.equal(mode.thread_id, sessionId, 'thread_id should fall back to session_id');
  });

  it('(b) resolves threadId when thread_id is empty string but threadId is non-empty', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-thread-alias-'));
    roots.push(cwd);
    const sessionId = 'native-dispatch-session-b';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
      leader_thread_id: 'T-valid', started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
    }));
    await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionId]: {
          session_id: sessionId, leader_thread_id: 'T-valid',
          threads: { 'T-valid': { thread_id: 'T-valid', kind: 'leader' } },
        },
      },
    }));
    // Empty thread_id but non-empty threadId: should use threadId (not empty string)
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      source: 'codex-app',
      session_id: sessionId,
      thread_id: '', // Empty thread_id
      threadId: 'T-valid', // Non-empty threadId should be used
      turn_id: 'turn-alias-b',
      prompt: '$ralplan --advisory dispatch threadId resolution',
    });
    // With the fix, this should work. With the bug, this would have an empty threadId and might fail.
    assert.notEqual(result.outputJson?.decision, 'block', 'advisory should activate with threadId alias');
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.workflow_variant, 'advisory', 'workflow_variant should be advisory');
    assert.ok(mode.advisory_generation_id, 'advisory_generation_id should be persisted');
    // Verify thread_id is persisted as threadId (not session_id)
    assert.equal(mode.thread_id, 'T-valid', 'thread_id should resolve from threadId, not session_id');
  });

  it('(c) prefers explicit thread_id over session_id even with different session identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-dispatch-thread-explicit-'));
    roots.push(cwd);
    const sessionId = 'native-dispatch-session-c';
    const explicitThreadId = 'T-explicit-c';
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId, native_session_id: sessionId, owner_codex_session_id: sessionId,
      leader_thread_id: explicitThreadId, started_at: '2026-08-28T00:00:00.000Z', cwd, state_root: stateDir,
    }));
    await writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionId]: {
          session_id: sessionId, leader_thread_id: explicitThreadId,
          threads: { [explicitThreadId]: { thread_id: explicitThreadId, kind: 'leader' } },
        },
      },
    }));
    // Explicit thread_id different from session_id: explicit should win
    const result = await dispatchCodexNativeHook({
      hook_event_name: 'UserPromptSubmit',
      cwd,
      source: 'codex-app',
      session_id: sessionId, // Different from thread_id
      thread_id: explicitThreadId, // Explicit thread_id
      turn_id: 'turn-explicit-c',
      prompt: '$ralplan --advisory dispatch explicit thread test',
    });
    assert.notEqual(result.outputJson?.decision, 'block', 'advisory should activate with explicit thread_id');
    const mode = JSON.parse(await readFile(join(sessionDir, 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.workflow_variant, 'advisory', 'workflow_variant should be advisory');
    assert.ok(mode.advisory_generation_id, 'advisory_generation_id should be persisted');
    // Verify thread_id is persisted as explicit thread_id (not session_id)
    assert.equal(mode.thread_id, explicitThreadId, 'thread_id should be explicit thread_id, not session_id');
  });
});
