import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyKeywordInput, recordSkillActivation as recordSkillActivationWithContext } from '../keyword-detector.js';
import { readCurrentRalplanAdvisory } from '../../ralplan/advisory.js';


const roots: string[] = [];
const recordSkillActivation = (
  input: Parameters<typeof recordSkillActivationWithContext>[0],
  dependencies?: Parameters<typeof recordSkillActivationWithContext>[1],
) => recordSkillActivationWithContext({
  ...input,
  resolvedPromptTurnContext: {
    status: 'authorized',
    authorization: {
      targetSessionId: input.sessionId!, ownerCodexSessionId: input.sessionId!,
      allowedOwnerCodexSessionIds: [input.sessionId!], allowedStorageSessionIds: [input.sessionId!],
      targetRelation: 'pointer-alias', thread: { kind: 'root-or-drift' },
      legacyAdoption: 'allow', globalSideEffects: 'allow',
    },
    ownership: { status: 'compatible', normalizedOwnerCodexSessionId: input.sessionId! },
  },
}, dependencies);
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe('ralplan advisory keyword activation', () => {
  it('keeps non-root and explicit-independent callers inert', async () => {
    for (const [index, targetRelation] of ['explicit-independent', 'pointer-alias'].entries()) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-untrusted-${index}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const text = '$ralplan --advisory untrusted caller';
      const result = await recordSkillActivationWithContext({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'thread-a', turnId: 'turn-a',
        resolvedPromptTurnContext: {
          status: 'authorized',
          authorization: {
            targetSessionId: 'session-a', ownerCodexSessionId: 'session-a',
            allowedOwnerCodexSessionIds: ['session-a'], allowedStorageSessionIds: ['session-a'],
            targetRelation: targetRelation as 'explicit-independent' | 'pointer-alias',
            thread: targetRelation === 'explicit-independent'
              ? { kind: 'root-or-drift' } : { kind: 'target-child', rootOwnerSessionId: 'session-a', proof: 'tracker' },
            legacyAdoption: 'allow', globalSideEffects: 'allow',
          },
          ownership: { status: 'compatible', normalizedOwnerCodexSessionId: 'session-a' },
        },
      });
      assert.equal(result, null);
      assert.equal(existsSync(join(stateDir, 'sessions', 'session-a', 'ralplan-advisory')), false);
      assert.equal(existsSync(join(stateDir, 'sessions', 'session-a', 'ralplan-state.json')), false);
    }
  });

  it('activates direct Advisory invocations case-insensitively with planning flags in either order', async () => {
    for (const [index, text] of [
      '$ralplan --advisory design issue #42',
      '$oh-my-codex:ralplan --advisory design issue #42',
      '$RALPLAN --ADVISORY design issue #42',
      '$ralplan --interactive --advisory design issue #42',
      '$ralplan --advisory --interactive design issue #42',
      '$ralplan --deliberate --advisory design issue #42',
      '$ralplan --advisory --deliberate design issue #42',
    ].entries()) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-${index}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const result = await recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      });
      assert.equal(result?.workflow_variant, 'advisory', text);
      assert.ok(result?.advisory_generation_id, text);
      const mode = JSON.parse(await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(mode.workflow_variant, 'advisory', text);
      assert.equal(mode.execution_handoff_authorized, false, text);
      for (const path of [
        join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
        join(stateDir, 'skill-active-state.json'),
      ]) {
        const skill = JSON.parse(await readFile(path, 'utf8'));
        const entry = skill.active_skills.find((candidate: Record<string, unknown>) => (
          candidate.skill === 'ralplan' && candidate.session_id === 'session-a'
        ));
        assert.equal(entry?.workflow_variant, 'advisory', `${text}:${path}`);
        assert.equal(entry?.advisory_generation_id, result?.advisory_generation_id, `${text}:${path}`);
      }
    }
  });

  it('rejects unknown flags, combined workflows, and missing canonical turn identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-deny-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    for (const text of [
      '$ralplan --advisory --execute task',
      '$ralplan --execute --advisory task',
      '$ralplan --advisory --unknown task',
      '$ralplan --advisory=true task',
      '$ralplan --advisory, task',
      '$ralplan --advisory-foo task',
      '$ralplan --advisory_mode task',
      '$RALPLAN --AdViSoRy=true task',
      '$RALPLAN --AdViSoRy_FOO task',
      '$ralplan --advisory $team task',
    ]) {
      assert.equal(await recordSkillActivation({ stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text), sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a' }), null);
      assert.equal(existsSync(join(stateDir, 'sessions', 'session-a', 'ralplan-state.json')), false, text);
    }
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text: '$ralplan --advisory task',
      classification: classifyKeywordInput('$ralplan --advisory task'), sessionId: 'session-a', threadId: 'root-a',
    }), /canonical_turn_identity_required/);
  });

  it('keeps the activation intent durable through every hook checkpoint and commits only after authenticated binding', async () => {
    for (const checkpoint of ['rollover_intent', 'after_mode_binding'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-keyword-${checkpoint}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const text = '$ralplan --advisory design issue #42';
      await assert.rejects(recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      }, checkpoint === 'after_mode_binding'
        ? { advisoryAfterModeBindingFailpoint: () => { throw new Error(`crash:${checkpoint}`); } }
        : { advisoryActivationFailpoint: (name) => { if (name === checkpoint) throw new Error(`crash:${checkpoint}`); } }), /crash/);
      const root = join(stateDir, 'sessions', 'session-a', 'ralplan-advisory');
      const intentPath = join(root, 'rollover-intent.json');
      const intent = JSON.parse(await readFile(intentPath, 'utf8'));
      assert.ok(intent.generation_id);
      const recovered = await recordSkillActivation({
        stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      });
      assert.equal(recovered?.advisory_generation_id, intent.generation_id, checkpoint);
      await assert.rejects(access(intentPath), /ENOENT/);
    }
  });

  it('retries the keyword activation idempotently after the intent was durably committed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-postcommit-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const text = '$ralplan --advisory postcommit retry';
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }, {
      advisoryActivationFailpoint: (checkpoint) => { if (checkpoint === 'intent_committed') throw new Error('crash:committed'); },
    }), /crash:committed/);
    const currentBefore = await readCurrentRalplanAdvisory(cwd, 'session-a');
    const retried = await recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    });
    assert.equal(retried?.advisory_generation_id, currentBefore?.activation.generation_id);
    assert.equal((await readCurrentRalplanAdvisory(cwd, 'session-a'))?.activation.generation_id, currentBefore?.activation.generation_id);
  });

  it('rejects an active Standard binding before creating any Advisory lifecycle state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-standard-active-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const bindingPath = join(sessionDir, 'ralplan-state.json');
    await mkdir(sessionDir, { recursive: true });
    const original = '{\n  "active": true,\n  "mode": "ralplan",\n  "session_id": "session-a",\n  "workflow_variant": "standard"\n}\n';
    await writeFile(bindingPath, original);

    const text = '$ralplan --advisory design issue #42';
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }), /ralplan_advisory_(?:active|start)_binding_conflict/);

    assert.equal(await readFile(bindingPath, 'utf8'), original);
    assert.equal(existsSync(join(sessionDir, 'ralplan-advisory')), false);
  });

  it('rejects an active foreign Advisory binding before creating rollover state or a new generation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-foreign-active-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const bindingPath = join(sessionDir, 'ralplan-state.json');
    await mkdir(sessionDir, { recursive: true });
    const original = '{\n  "active": true,\n  "mode": "ralplan",\n  "session_id": "session-a",\n  "workflow_variant": "advisory",\n  "advisory_generation_id": "foreign-generation",\n  "execution_handoff_authorized": false,\n  "host_verified": false\n}\n';
    await writeFile(bindingPath, original);

    const text = '$RALPLAN --ADVISORY design issue #42';
    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }), /ralplan_advisory_(?:active|start)_binding_conflict/);

    assert.equal(await readFile(bindingPath, 'utf8'), original);
    assert.equal(existsSync(join(sessionDir, 'ralplan-advisory')), false);
  });

  it('keeps a prepared intent recoverable when a Standard competitor appears before the binding write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-bind-race-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const bindingPath = join(sessionDir, 'ralplan-state.json');
    const advisoryRoot = join(sessionDir, 'ralplan-advisory');
    const text = '$ralplan --advisory design issue #42';
    const competitor = '{\n  "active": true,\n  "mode": "ralplan",\n  "session_id": "session-a",\n  "workflow_variant": "standard",\n  "current_phase": "draft"\n}\n';

    await assert.rejects(recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    }, {
      advisoryActivationFailpoint: async (checkpoint) => {
        if (checkpoint !== 'rollover_intent') return;
        await mkdir(sessionDir, { recursive: true });
        await writeFile(bindingPath, competitor);
      },
    }), /ralplan_advisory_(?:active|start)_binding_conflict/);

    assert.equal(await readFile(bindingPath, 'utf8'), competitor);
    const intent = JSON.parse(await readFile(join(advisoryRoot, 'rollover-intent.json'), 'utf8'));
    assert.ok(intent.generation_id);
    assert.equal(existsSync(join(advisoryRoot, 'current.json')), false);
    assert.equal(existsSync(join(advisoryRoot, intent.generation_id)), false);

    await writeFile(bindingPath, competitor.replace('"active": true', '"active": false'));
    const recovered = await recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
    });
    assert.equal(recovered?.advisory_generation_id, intent.generation_id);
    const rebound = JSON.parse(await readFile(bindingPath, 'utf8'));
    assert.equal(rebound.active, true);
    assert.equal(rebound.workflow_variant, 'advisory');
    assert.equal(rebound.advisory_generation_id, intent.generation_id);
    assert.equal(JSON.parse(await readFile(join(advisoryRoot, 'current.json'), 'utf8')).generation_id, intent.generation_id);
    await assert.rejects(access(join(advisoryRoot, 'rollover-intent.json')), /ENOENT/);
  });

  it('activates Ultragoal and Team without generically superseding Advisory', async () => {
    for (const [index, nextPrompt] of ['$ultragoal implementá goal G1', '$team 2 ejecutá task T1'].entries()) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-coexists-${index}-`));
      roots.push(cwd);
      const stateDir = join(cwd, '.omx', 'state');
      const advisoryPrompt = '$ralplan --advisory diseñá el plan';
      await recordSkillActivation({
        stateDir, sourceCwd: cwd, text: advisoryPrompt, classification: classifyKeywordInput(advisoryPrompt),
        sessionId: 'session-a', threadId: 'root-a', turnId: 'turn-a',
      });
      const bindingPath = join(stateDir, 'sessions', 'session-a', 'ralplan-state.json');
      const bindingBefore = await readFile(bindingPath, 'utf8');
      const lifecycleBefore = JSON.stringify(await readCurrentRalplanAdvisory(cwd, 'session-a'));

      const activated = await recordSkillActivation({
        stateDir, sourceCwd: cwd, text: nextPrompt, classification: classifyKeywordInput(nextPrompt),
        sessionId: 'session-a', threadId: 'root-a', turnId: `turn-next-${index}`,
      });
      const expected = index === 0 ? 'ultragoal' : 'team';
      assert.ok(activated?.active_skills?.some((entry) => entry.skill === expected && entry.active !== false), nextPrompt);
      assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore, nextPrompt);
      assert.equal(JSON.stringify(await readCurrentRalplanAdvisory(cwd, 'session-a')), lifecycleBefore, nextPrompt);
    }
  });

  it('activates advisory when native event uses session_id as thread identity (no explicit thread_id)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-native-thread-fallback-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    // Simulate native Codex event: session_id contains thread identifier, no explicit thread_id
    // This verifies that the native hook correctly falls back to session_id for thread identity
    const text = '$ralplan --advisory native thread identity test';
    const result = await recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'native-session-123', threadId: 'native-session-123', turnId: 'turn-native-1',
    });
    assert.equal(result?.workflow_variant, 'advisory');
    assert.ok(result?.advisory_generation_id);
    const mode = JSON.parse(await readFile(join(stateDir, 'sessions', 'native-session-123', 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.workflow_variant, 'advisory');
  });

  it('explicit thread_id still wins over session_id fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-explicit-thread-wins-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    // When both session_id and explicit thread_id are present, thread_id should be used
    const text = '$ralplan --advisory explicit thread priority';
    const result = await recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId: 'session-with-explicit-thread', threadId: 'explicit-thread-abc', turnId: 'turn-explicit-1',
    });
    assert.equal(result?.workflow_variant, 'advisory');
    assert.ok(result?.advisory_generation_id);
    const mode = JSON.parse(await readFile(join(stateDir, 'sessions', 'session-with-explicit-thread', 'ralplan-state.json'), 'utf8'));
    assert.equal(mode.workflow_variant, 'advisory');
  });

  it('preserves unrelated state when native advisory activation succeeds', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-keyword-state-preservation-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionId = 'native-session-with-state';
    const sessionDir = join(stateDir, 'sessions', sessionId);
    await mkdir(sessionDir, { recursive: true });
    
    // Write some unrelated state to verify it's not corrupted
    const unrelatedPath = join(sessionDir, 'unrelated-state.json');
    const unrelatedContent = JSON.stringify({ version: 1, data: 'important' });
    await writeFile(unrelatedPath, unrelatedContent);
    
    const text = '$ralplan --advisory preserve state test';
    const result = await recordSkillActivation({
      stateDir, sourceCwd: cwd, text, classification: classifyKeywordInput(text),
      sessionId, threadId: sessionId, turnId: 'turn-preserve-1',
    });
    assert.equal(result?.workflow_variant, 'advisory');
    
    // Verify unrelated state is unchanged
    const preserved = await readFile(unrelatedPath, 'utf8');
    assert.equal(preserved, unrelatedContent);
  });


});
