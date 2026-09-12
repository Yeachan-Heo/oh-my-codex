import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activateOrResumeRalplanAdvisory as activateRalplanAdvisoryWithProvenance,
  type ActivateOrResumeRalplanAdvisoryInput,
  type AdvisoryActivationCheckpoint,
} from '../advisory-activation.js';
import {
  ADVISORY_ACTIVATION_VERIFIER_TEST_SEAM,
  verifyPinnedJsonAndSync,
} from '../advisory-activation-verifier.js';
import { listActiveSkills, listTransitionActiveSkills, writeSkillActiveStateCopiesForStateDir } from '../../state/skill-active.js';
import { __setCanonicalModeBindingLeaseTestHooksForTests, resolveValidatedCanonicalModeBinding } from '../../state/mode-binding-lease.js';
import { executeStateOperation, outsideStateFileWriteTransaction, withStateFileWriteTransaction, writeStateFile } from '../../state/operations.js';
import {
  administrativelyAbandonRalplanAdvisory,
  commitPreparedRalplanAdvisoryActivationInternal,
  prepareAdvisoryCloseout,
} from '../advisory.js';

const roots: string[] = [];
const activateOrResumeRalplanAdvisory = (
  input: Omit<ActivateOrResumeRalplanAdvisoryInput, 'producer' | 'threadKind' | 'resumeOnly'>,
) => activateRalplanAdvisoryWithProvenance({ ...input, producer: 'native', threadKind: 'root-or-drift' });
afterEach(async () => {
  __setCanonicalModeBindingLeaseTestHooksForTests({});
  ADVISORY_ACTIVATION_VERIFIER_TEST_SEAM.fileSync = undefined;
  ADVISORY_ACTIVATION_VERIFIER_TEST_SEAM.directorySync = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('central Ralplan Advisory activation owner', () => {
  it('accepts degraded Windows file and directory fsync outcomes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-windows-fsync-'));
    roots.push(cwd);
    const path = join(cwd, 'projection.json');
    await writeFile(path, '{"schema_version":1}\n');
    ADVISORY_ACTIVATION_VERIFIER_TEST_SEAM.fileSync = async () => 'unsupported-windows-eperm';
    ADVISORY_ACTIVATION_VERIFIER_TEST_SEAM.directorySync = async () => 'unsupported-windows-eperm';
    const value = await verifyPinnedJsonAndSync(path, (record) => record.schema_version === 1);
    assert.equal(value.schema_version, 1);
  });

  it('fails Advisory closed on unsupported platforms before creating intent or state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-unsupported-'));
    roots.push(cwd);
    __setCanonicalModeBindingLeaseTestHooksForTests({ platform: 'win32' });
    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory unsupported', generationId: 'generation-a',
    }), /unsupported on win32/);
    assert.equal(existsSync(join(cwd, '.omx')), false);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
  });

  it('rejects a byte-identical state-root replacement before commit and retains the intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-state-root-swap-'));
    roots.push(cwd);
    const stateRoot = join(cwd, '.omx', 'state');
    const displaced = join(cwd, '.omx', 'state.displaced');
    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory state root swap', generationId: 'generation-a',
      failpoint: async (checkpoint) => {
        if (checkpoint !== 'before_commit') return;
        await rename(stateRoot, displaced);
        await cp(displaced, stateRoot, { recursive: true });
      },
    }), /state root identity changed/);
    const advisoryRoot = join(stateRoot, 'sessions', 'session-a', 'ralplan-advisory');
    await readFile(join(advisoryRoot, 'rollover-intent.json'));
    assert.equal(existsSync(join(advisoryRoot, 'current.json')), false);
  });

  it('keeps activation preparation and commit imports behind the central owner boundary', async () => {
    const advisorySource = await readFile(join(process.cwd(), 'src', 'ralplan', 'advisory.ts'), 'utf8');
    assert.doesNotMatch(advisorySource, /export async function activateRalplanAdvisory\b/);
    assert.doesNotMatch(advisorySource, /consumeActivationIntent|beforeActivationCommit/);
    for (const relative of [
      ['src', 'ralplan', 'runtime.ts'],
      ['src', 'hooks', 'keyword-detector.ts'],
      ['src', 'scripts', 'codex-native-hook.ts'],
    ]) {
      const source = await readFile(join(process.cwd(), ...relative), 'utf8');
      assert.doesNotMatch(source, /prepareRalplanAdvisoryActivationInternal|readAuthorizedPendingRalplanActivation|commitPreparedRalplanAdvisoryActivationInternal/);
    }
  });

  it('holds sanctioned mode writers outside the complete Advisory handoff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-mode-binding-lock-'));
    roots.push(cwd);
    const result = await activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory serialized handoff', generationId: 'generation-a',
      failpoint: async (checkpoint) => {
        if (checkpoint !== 'after_mode') return;
        const competitor = await executeStateOperation('state_write', {
          workingDirectory: cwd,
          session_id: 'session-a',
          mode: 'ralplan',
          state: { active: true, workflow_variant: 'standard', current_phase: 'draft' },
        });
        assert.equal(competitor.isError, true);
        assert.match(String((competitor.payload as { error?: string }).error), /timed out waiting for .*lock|lease helper (request timed out|exited)|lease-mutex lock acquisition timed out/);
      },
    });
    assert.equal(result.projection.corruption, null);
  });

  it('releases a failed activation lease and never removes a successor lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-mode-binding-release-'));
    roots.push(cwd);
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory failed lease release', generationId: 'generation-a',
      failpoint: (checkpoint) => { if (checkpoint === 'after_mode') throw new Error('forced-activation-failure'); },
    }), /forced-activation-failure/);
    await withStateFileWriteTransaction(bindingPath, async () => undefined);

    const lockPath = (await resolveValidatedCanonicalModeBinding(bindingPath)).leasePath;
    const displaced = `${lockPath}.old-owner`;
    await assert.rejects(withStateFileWriteTransaction(bindingPath, async () => {
      const ownerEntry = (await readdir(lockPath)).find((entry) => entry.startsWith('owner-'));
      assert.ok(ownerEntry);
      await rename(lockPath, displaced);
      await mkdir(lockPath);
      await writeFile(join(lockPath, 'owner-successor-token'), 'successor-token');
    }), /ownership lost/);
    assert.equal(await readFile(join(lockPath, 'owner-successor-token'), 'utf8'), 'successor-token');
    assert.ok((await readdir(displaced)).some((entry) => entry.startsWith('owner-')));
  });

  it('rejects a symlinked lock namespace without touching its target or running work', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-lock-symlink-'));
    const external = await mkdtemp(join(tmpdir(), 'omx-advisory-lock-external-'));
    roots.push(cwd, external);
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await symlink(external, join(cwd, '.omx-state-locks'));
    let ran = false;
    await assert.rejects(withStateFileWriteTransaction(bindingPath, async () => { ran = true; }), /real directory/);
    assert.equal(ran, false);
    assert.deepEqual(await readdir(external), []);
  });

  it('rejects unsafe activation identities before creating lease or lifecycle artifacts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-invalid-identity-'));
    roots.push(cwd);
    await assert.rejects(activateOrResumeRalplanAdvisory({
      cwd, sessionId: '..', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory invalid identity', generationId: 'generation-a',
    }), /sessionId_invalid/);
    assert.equal(existsSync(join(cwd, '.omx-state-locks')), false);
    assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
  });

  it('pins the lock namespace and rejects a replacement without admitting a second owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-lock-namespace-swap-'));
    roots.push(cwd);
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const namespacePath = join(cwd, '.omx-state-locks');
    const displaced = join(cwd, '.omx-state-locks.displaced');
    let secondRan = false;
    await assert.rejects(withStateFileWriteTransaction(bindingPath, async () => {
      await rename(namespacePath, displaced);
      await mkdir(namespacePath);
      const second = outsideStateFileWriteTransaction(() => withStateFileWriteTransaction(bindingPath, async () => {
        secondRan = true;
      }));
      await assert.rejects(second, /namespace identity mismatch/);
    }), /namespace changed/);
    assert.equal(secondRan, false);
    assert.ok((await readdir(namespacePath)).length <= 2);
    assert.ok((await readdir(displaced)).length <= 2);
  });

  it('reclaims a dead helper lease while the parent process remains alive', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-dead-lock-helper-'));
    roots.push(cwd);
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let spawned = 0;
    let firstChild: import('node:child_process').ChildProcessWithoutNullStreams | undefined;
    __setCanonicalModeBindingLeaseTestHooksForTests({
      onHelperSpawn: (child) => {
        spawned += 1;
        if (spawned === 1) firstChild = child;
      },
      afterAcquire: () => { firstChild?.kill('SIGKILL'); },
    });
    await assert.rejects(withStateFileWriteTransaction(bindingPath, async () => undefined), /helper/);
    await withStateFileWriteTransaction(bindingPath, async () => undefined);
    assert.equal(spawned, 2);
  });

  it('lets a detached excluded writer acquire a fresh reentrant lease after activation releases', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-detached-writer-'));
    roots.push(cwd);
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    let detached: Promise<void> | undefined;
    await activateOrResumeRalplanAdvisory({
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory detached writer', generationId: 'generation-a',
      failpoint: (checkpoint) => {
        if (checkpoint !== 'after_mode') return;
        detached = withStateFileWriteTransaction(bindingPath, async () => {
          const bytes = await readFile(bindingPath, 'utf8');
          await writeStateFile(bindingPath, bytes);
        });
      },
    });
    await detached;
  });

  it('keeps one generation recoverable across every publication checkpoint', async () => {
    const checkpoints: AdvisoryActivationCheckpoint[] = [
      'after_intent', 'after_mode', 'after_run_state',
      'before_skill_mirror_commit', 'after_skill_mirror_transaction',
      'after_session_skill', 'after_root_skill', 'before_mode_fsync', 'before_commit',
    ];
    for (const checkpoint of checkpoints) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-${checkpoint}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a',
        activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá',
      };
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: (name) => { if (name === checkpoint) throw new Error(`crash:${name}`); },
      }), /crash/);
      const root = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory');
      const intent = JSON.parse(await readFile(join(root, 'rollover-intent.json'), 'utf8'));
      const recovered = await activateOrResumeRalplanAdvisory(input);
      assert.equal(recovered.activation.generation_id, intent.generation_id, checkpoint);
      assert.equal(recovered.projection.corruption, null, checkpoint);
      assert.equal(JSON.parse(await readFile(join(root, 'current.json'), 'utf8')).generation_id, intent.generation_id, checkpoint);
      const binding = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json'), 'utf8'));
      assert.equal(binding.advisory_generation_id, intent.generation_id, checkpoint);
      assert.equal(binding.execution_handoff_authorized, false, checkpoint);
      assert.equal(binding.host_verified, false, checkpoint);
    }
  });

  it('preserves foreign-session Team root state while repairing Advisory mirrors and retrying', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-merge-'));
    roots.push(cwd);
    const stateDir = join(cwd, '.omx', 'state');
    await mkdir(stateDir, { recursive: true });
    const foreignTeam = {
      version: 1, active: true, skill: 'ralplan', phase: 'architect-review', session_id: 'session-b',
      workflow_variant: 'standard', marker: 'foreign-top-level',
      active_skills: [
        { skill: 'team', active: true, phase: 'executing', session_id: 'session-b' },
        { skill: 'ralplan', active: true, phase: 'architect-review', session_id: 'session-b', workflow_variant: 'standard' },
      ],
    };
    await writeFile(join(stateDir, 'skill-active-state.json'), `${JSON.stringify(foreignTeam, null, 2)}\n`);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_root_skill') throw new Error('crash:root'); },
    }), /crash:root/);
    for (const phase of ['failed activation', 'retry']) {
      const root = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf8'));
      assert.ok(root.active_skills.some((entry: Record<string, unknown>) => entry.skill === 'team' && entry.session_id === 'session-b'), phase);
      assert.equal(root.skill, foreignTeam.skill, phase);
      assert.equal(root.session_id, foreignTeam.session_id, phase);
      assert.equal(root.workflow_variant, foreignTeam.workflow_variant, phase);
      assert.equal(root.marker, foreignTeam.marker, phase);
      assert.deepEqual(
        listTransitionActiveSkills(root, 'session-b').map((entry) => [entry.skill, entry.workflow_variant]),
        [['team', undefined], ['ralplan', 'standard']],
        phase,
      );
      if (phase === 'failed activation') await activateOrResumeRalplanAdvisory(input);
    }
  });

  it('rejects a regular-file replacement between pinned validation and fsync without consuming the intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-pinned-replace-'));
    roots.push(cwd);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    const replacement = `${bindingPath}.replacement`;
    const replacementBytes = '{"active":true,"mode":"ralplan","session_id":"session-a","workflow_variant":"standard"}\n';
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint !== 'before_mode_fsync') return;
        await writeFile(replacement, replacementBytes);
        await rename(replacement, bindingPath);
      },
    }), /projection_(?:identity|content)_changed/);
    assert.equal(await readFile(bindingPath, 'utf8'), replacementBytes);
    await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
  });

  it('rejects a same-inode overwrite after validation without consuming the intent', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-pinned-overwrite-'));
    roots.push(cwd);
    const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
    const bindingPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-state.json');
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint === 'before_mode_fsync') await writeFile(bindingPath, '{"active":false}\n');
      },
    }), /projection_content_changed/);
    await readFile(join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
  });

  it('revalidates every runtime mirror under the activation lock immediately before consuming intent', async () => {
    for (const target of ['run-state.json', 'skill-active-state.json', 'root-skill'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-precommit-${target}-`));
      roots.push(cwd);
      const input = { cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a', prompt: '$ralplan --advisory planificá' };
      const stateDir = join(cwd, '.omx', 'state');
      const targetPath = target === 'root-skill'
        ? join(stateDir, 'skill-active-state.json')
        : join(stateDir, 'sessions', 'session-a', target);
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: async (checkpoint) => {
          if (checkpoint === 'before_commit') await writeFile(targetPath, '{"active":false}\n');
        },
      }), /projection_mismatch/);
      await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
      const recovered = await activateOrResumeRalplanAdvisory(input);
      assert.equal(recovered.projection.corruption, null, target);
    }
  });

  it('does not prepare or consume activation state without authenticated root provenance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-auth-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory authenticated activation',
    };
    await assert.rejects(activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown',
    }), /activation_authority_required/);
    assert.equal(await activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown', resumeOnly: true,
    }), null);
    assert.equal(existsSync(join(cwd, '.omx')), false);

    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_intent') throw new Error('crash:intent'); },
    }), /crash:intent/);
    const intentPath = join(cwd, '.omx', 'state', 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json');
    const before = await readFile(intentPath, 'utf8');
    assert.equal(await activateRalplanAdvisoryWithProvenance({
      ...input, producer: 'native', threadKind: 'unknown', resumeOnly: true,
    }), null);
    assert.equal(await readFile(intentPath, 'utf8'), before);
  });

  it('returns the same committed generation after a crash at the post-commit boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-postcommit-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory idempotent activation', generationId: 'generation-a',
    };
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, failpoint: (checkpoint) => { if (checkpoint === 'intent_committed') throw new Error('crash:committed'); },
    }), /crash:committed/);
    const retried = await activateOrResumeRalplanAdvisory(input);
    assert.equal(retried.activation.generation_id, 'generation-a');
    assert.equal(retried.projection.activation.generation_id, 'generation-a');
    const stateDir = join(cwd, '.omx', 'state');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const state = JSON.parse(await readFile(path, 'utf8'));
      state.active_skills = state.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['workflow_variant', 'advisory_generation_id'].includes(key)))
        : entry);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
    const repaired = await activateOrResumeRalplanAdvisory(input);
    assert.equal(repaired.activation.generation_id, 'generation-a');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const entry = listActiveSkills(JSON.parse(await readFile(path, 'utf8')))
        .find((candidate) => candidate.skill === 'ralplan' && candidate.session_id === 'session-a');
      assert.equal(entry?.workflow_variant, 'advisory', path);
      assert.equal(entry?.advisory_generation_id, 'generation-a', path);
    }
    const sessionSkillPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
    const conflicted = JSON.parse(await readFile(sessionSkillPath, 'utf8'));
    conflicted.active_skills = conflicted.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
      ? { ...entry, advisory_generation_id: 'generation-foreign' }
      : entry);
    await writeFile(sessionSkillPath, `${JSON.stringify(conflicted, null, 2)}\n`);
    await assert.rejects(activateOrResumeRalplanAdvisory(input), /session_skill_binding_conflict/);
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input, prompt: '$ralplan --advisory different prompt',
    }), /committed_activation_authority_mismatch/);
  });

  it('rejects an exact-session foreign root generation without mutating root bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-conflict-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory root conflict', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const rootPath = join(cwd, '.omx', 'state', 'skill-active-state.json');
    const root = JSON.parse(await readFile(rootPath, 'utf8'));
    root.active_skills = root.active_skills.map((entry: Record<string, unknown>) => (
      entry.skill === 'ralplan' && entry.session_id === 'session-a'
        ? { ...entry, advisory_generation_id: 'generation-foreign' }
        : entry
    ));
    const foreignBytes = `${JSON.stringify(root, null, 2)}\n`;
    await writeFile(rootPath, foreignBytes);

    await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
    assert.equal(await readFile(rootPath, 'utf8'), foreignBytes);
  });

  it('rejects conflicting exact-session root top-level binding metadata byte-exactly', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-root-top-conflict-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory root top conflict', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const stateDir = join(cwd, '.omx', 'state');
    const rootPath = join(stateDir, 'skill-active-state.json');
    const sessionPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
    const root = JSON.parse(await readFile(rootPath, 'utf8'));
    root.session_id = 'session-a';
    root.workflow_variant = 'advisory';
    root.advisory_generation_id = 'generation-foreign';
    const foreignRootBytes = `${JSON.stringify(root, null, 2)}\n`;
    await writeFile(rootPath, foreignRootBytes);
    const sessionBytes = await readFile(sessionPath, 'utf8');

    await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
    assert.equal(await readFile(rootPath, 'utf8'), foreignRootBytes);
    assert.equal(await readFile(sessionPath, 'utf8'), sessionBytes);
  });

  it('rejects wrong-typed exact-session root top-level binding fields byte-exactly', async () => {
    for (const [field, value] of [
      ['workflow_variant', { forged: true }],
      ['advisory_generation_id', 42],
    ] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-root-top-type-${field}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: `$ralplan --advisory root top type ${field}`, generationId: 'generation-a',
      };
      await activateOrResumeRalplanAdvisory(input);
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      const sessionPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
      const root = JSON.parse(await readFile(rootPath, 'utf8'));
      root.session_id = 'session-a';
      root[field] = value;
      const foreignRootBytes = `${JSON.stringify(root, null, 2)}\n`;
      await writeFile(rootPath, foreignRootBytes);
      const sessionBytes = await readFile(sessionPath, 'utf8');

      await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
      assert.equal(await readFile(rootPath, 'utf8'), foreignRootBytes);
      assert.equal(await readFile(sessionPath, 'utf8'), sessionBytes);
    }
  });

  it('rejects wrong-typed nested root and session binding fields byte-exactly', async () => {
    for (const [surface, field, value] of [
      ['root-entry', 'workflow_variant', false],
      ['root-entry', 'advisory_generation_id', 0],
      ['session-entry', 'workflow_variant', { forged: true }],
      ['session-entry', 'advisory_generation_id', []],
    ] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-${surface}-${field}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: `$ralplan --advisory ${surface} ${field}`, generationId: 'generation-a',
      };
      await activateOrResumeRalplanAdvisory(input);
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      const sessionPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
      const targetPath = surface === 'root-entry' ? rootPath : sessionPath;
      const target = JSON.parse(await readFile(targetPath, 'utf8'));
      const entry = target.active_skills.find((candidate: { skill?: string }) => candidate.skill === 'ralplan');
      entry[field] = value;
      await writeFile(targetPath, `${JSON.stringify(target, null, 2)}\n`);
      const rootBytes = await readFile(rootPath, 'utf8');
      const sessionBytes = await readFile(sessionPath, 'utf8');

      await assert.rejects(activateOrResumeRalplanAdvisory(input), /skill_binding_conflict/);
      assert.equal(await readFile(rootPath, 'utf8'), rootBytes);
      assert.equal(await readFile(sessionPath, 'utf8'), sessionBytes);
    }
  });

  it('rejects conflicting legacy-unscoped root ownership byte-exactly', async () => {
    for (const surface of ['top-level', 'root-entry'] as const) {
      for (const field of ['workflow_variant', 'advisory_generation_id'] as const) {
        const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-legacy-owner-${surface}-${field}-`));
        roots.push(cwd);
        const input = {
          cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
          prompt: `$ralplan --advisory legacy owner ${surface} ${field}`, generationId: 'generation-a',
        };
        await activateOrResumeRalplanAdvisory(input);
        const rootPath = join(cwd, '.omx', 'state', 'skill-active-state.json');
        const root = JSON.parse(await readFile(rootPath, 'utf8'));
        const target = surface === 'top-level'
          ? root
          : root.active_skills.find((entry: Record<string, unknown>) => entry.skill === 'ralplan');
        delete target.session_id;
        target.owner_codex_session_id = 'session-a';
        target[field] = field === 'workflow_variant' ? 'standard' : 'generation-foreign';
        await writeFile(rootPath, `${JSON.stringify(root, null, 2)}\n`);
        const before = await readFile(rootPath, 'utf8');

        await assert.rejects(activateOrResumeRalplanAdvisory(input), /root_skill_binding_conflict/);
        assert.equal(await readFile(rootPath, 'utf8'), before, `${surface}:${field}`);
      }
    }
  });

  it('never follows an initial or validation-time session mirror symlink', async () => {
    for (const timing of ['initial', 'during-validation'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-session-symlink-${timing}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: `$ralplan --advisory session symlink ${timing}`, generationId: 'generation-a',
      };
      await activateOrResumeRalplanAdvisory(input);
      const stateDir = join(cwd, '.omx', 'state');
      const rootPath = join(stateDir, 'skill-active-state.json');
      const sessionPath = join(stateDir, 'sessions', 'session-a', 'skill-active-state.json');
      const externalPath = join(cwd, `external-${timing}.json`);
      const externalBytes = `external-${timing}\n`;
      await writeFile(externalPath, externalBytes);
      const rootBytes = await readFile(rootPath, 'utf8');
      if (timing === 'initial') {
        await unlink(sessionPath);
        await symlink(externalPath, sessionPath);
      }
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: timing === 'during-validation'
          ? async (checkpoint) => {
              if (checkpoint !== 'before_skill_mirror_commit') return;
              await unlink(sessionPath);
              await symlink(externalPath, sessionPath);
            }
          : undefined,
      }), /ELOOP|file-changed|session mirror changed|atomic-replace-failed|recovery is ambiguous/);
      assert.equal(await readFile(externalPath, 'utf8'), externalBytes, timing);
      assert.equal(await readFile(rootPath, 'utf8'), rootBytes, timing);
    }
  });

  it('rejects a Darwin-style parent-directory swap without mutating either directory or root', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-session-parent-swap-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory session parent swap', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const stateDir = join(cwd, '.omx', 'state');
    const sessionDir = join(stateDir, 'sessions', 'session-a');
    const displacedDir = join(stateDir, 'sessions', 'session-a-displaced');
    const externalDir = join(cwd, 'external-session');
    const externalSkillPath = join(externalDir, 'skill-active-state.json');
    const originalSkillPath = join(sessionDir, 'skill-active-state.json');
    const rootPath = join(stateDir, 'skill-active-state.json');
    await mkdir(externalDir);
    const externalBytes = 'external-parent-swap\n';
    await writeFile(externalSkillPath, externalBytes);
    const originalBytes = await readFile(originalSkillPath, 'utf8');
    const rootBytes = await readFile(rootPath, 'utf8');

    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint !== 'before_skill_mirror_commit') return;
        await rename(sessionDir, displacedDir);
        await symlink(externalDir, sessionDir, 'dir');
      },
    }), /parent changed|unsupported|ENOTSUP/);
    assert.equal(await readFile(externalSkillPath, 'utf8'), externalBytes);
    assert.equal(await readFile(join(displacedDir, 'skill-active-state.json'), 'utf8'), originalBytes);
    assert.equal(await readFile(rootPath, 'utf8'), rootBytes);
  });

  it('keeps fast repair atomic when a Standard writer wins immediately after the mirror transaction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-fast-repair-race-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory repair race', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    const stateDir = join(cwd, '.omx', 'state');
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const state = JSON.parse(await readFile(path, 'utf8'));
      state.active_skills = state.active_skills.map((entry: Record<string, unknown>) => entry.skill === 'ralplan'
        ? Object.fromEntries(Object.entries(entry).filter(([key]) => !['workflow_variant', 'advisory_generation_id'].includes(key)))
        : entry);
      await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
    }
    const standardState = {
      version: 1, active: true, skill: 'ralplan', phase: 'planning', session_id: 'session-a',
      active_skills: [{ skill: 'ralplan', active: true, phase: 'planning', session_id: 'session-a' }],
    };
    let competitor: Promise<void> | undefined;
    await assert.rejects(activateOrResumeRalplanAdvisory({
      ...input,
      failpoint: async (checkpoint) => {
        if (checkpoint === 'before_skill_mirror_commit') {
          competitor = writeSkillActiveStateCopiesForStateDir(stateDir, standardState, 'session-a');
        }
        if (checkpoint === 'after_skill_mirror_transaction') await competitor;
      },
    }), /projection_mismatch/);
    for (const path of [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ]) {
      const entries = listActiveSkills(JSON.parse(await readFile(path, 'utf8')));
      const entry = entries.find((candidate) => candidate.skill === 'ralplan' && candidate.session_id === 'session-a');
      assert.ok(entry, path);
      assert.equal(entry.workflow_variant, undefined, path);
      assert.equal(entry.advisory_generation_id, undefined, path);
    }
  });

  it('rejects fast-path success when mode or run state drifts during the skill mirror commit', async () => {
    for (const surface of ['mode', 'run'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-fast-${surface}-drift-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: `$ralplan --advisory fast ${surface} drift`, generationId: 'generation-a',
      };
      await activateOrResumeRalplanAdvisory(input);
      const stateDir = join(cwd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'session-a');
      const targetPath = join(sessionDir, surface === 'mode' ? 'ralplan-state.json' : 'run-state.json');
      const advisoryRoot = join(sessionDir, 'ralplan-advisory');
      const currentPath = join(advisoryRoot, 'current.json');
      const currentBytes = await readFile(currentPath, 'utf8');

      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input,
        failpoint: async (checkpoint) => {
          if (checkpoint !== 'before_skill_mirror_commit') return;
          const state = JSON.parse(await readFile(targetPath, 'utf8'));
          if (surface === 'mode') delete state.workflow_variant;
          else state.active = false;
          await writeFile(targetPath, `${JSON.stringify(state, null, 2)}\n`);
        },
      }), /projection_mismatch/);

      assert.equal(await readFile(currentPath, 'utf8'), currentBytes, surface);
      assert.equal(existsSync(join(advisoryRoot, 'rollover-intent.json')), false, surface);
      const drifted = JSON.parse(await readFile(targetPath, 'utf8'));
      assert.equal(surface === 'mode' ? drifted.workflow_variant : drifted.active, surface === 'mode' ? undefined : false);
    }
  });

  it('rejects a terminal generation behind a stale active binding without repairing skill mirrors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-advisory-activation-terminal-stale-binding-'));
    roots.push(cwd);
    const input = {
      cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
      prompt: '$ralplan --advisory terminal stale binding', generationId: 'generation-a',
    };
    await activateOrResumeRalplanAdvisory(input);
    await prepareAdvisoryCloseout({
      cwd, sessionId: 'session-a', generationId: 'generation-a', closingTurnId: 'turn-close', iteration: 1,
    });
    await administrativelyAbandonRalplanAdvisory({
      cwd, sessionId: 'session-a', generationId: 'generation-a', rootThreadId: 'root-a', turnId: 'turn-close',
    });
    const stateDir = join(cwd, '.omx', 'state');
    const skillPaths = [
      join(stateDir, 'sessions', 'session-a', 'skill-active-state.json'),
      join(stateDir, 'skill-active-state.json'),
    ];
    const before = await Promise.all(skillPaths.map((path) => readFile(path, 'utf8')));
    await assert.rejects(activateOrResumeRalplanAdvisory(input), /not_precloseout/);
    assert.deepEqual(await Promise.all(skillPaths.map((path) => readFile(path, 'utf8'))), before);
  });

  it('rejects direct commit when any required mirror is missing and retains the intent', async () => {
    for (const target of ['ralplan-state.json', 'run-state.json', 'session-skill', 'root-skill'] as const) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-advisory-activation-commit-bypass-${target}-`));
      roots.push(cwd);
      const input = {
        cwd, sessionId: 'session-a', rootThreadId: 'root-a', activationTurnId: 'turn-a',
        prompt: '$ralplan --advisory commit boundary',
      };
      await assert.rejects(activateOrResumeRalplanAdvisory({
        ...input, failpoint: (checkpoint) => { if (checkpoint === 'after_root_skill') throw new Error('crash:prepared'); },
      }), /crash:prepared/);
      const stateDir = join(cwd, '.omx', 'state');
      const targetPath = target === 'root-skill'
        ? join(stateDir, 'skill-active-state.json')
        : target === 'session-skill'
          ? join(stateDir, 'sessions', 'session-a', 'skill-active-state.json')
          : join(stateDir, 'sessions', 'session-a', target);
      await rm(targetPath);
      await assert.rejects(commitPreparedRalplanAdvisoryActivationInternal({
        cwd, sessionId: 'session-a', producer: 'native', threadKind: 'root-or-drift',
        rootThreadId: 'root-a', activationTurnId: 'turn-a',
      }), /binding_conflict|ENOENT|projection_/);
      await readFile(join(stateDir, 'sessions', 'session-a', 'ralplan-advisory', 'rollover-intent.json'));
    }
  });
});
