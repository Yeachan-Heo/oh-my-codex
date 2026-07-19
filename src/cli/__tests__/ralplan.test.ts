import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ralplanCommand,
  RALPLAN_NEUTRALIZE_TEST_SEAM,
  type RalplanCommandDependencies,
} from '../ralplan.js';

interface RoutingFixture {
  cwd: string;
  sessionId: string;
  sessionDir: string;
  ralplanPath: string;
  skillPath: string;
  originalRalplan: Buffer;
  originalSkill: Buffer;
}

async function invoke(args: string[], deps: RalplanCommandDependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

function clearNeutralizeSeam(): void {
  delete RALPLAN_NEUTRALIZE_TEST_SEAM.fail;
  delete RALPLAN_NEUTRALIZE_TEST_SEAM.random;
  delete RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish;
  delete RALPLAN_NEUTRALIZE_TEST_SEAM.beforeRollback;
  delete RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync;
}

async function makeRoutingFixture(): Promise<RoutingFixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-preflight-'));
  const sessionId = 'owned-session';
  const sessionDir = join(cwd, '.omx', 'state', 'sessions', sessionId);
  const ralplanPath = join(sessionDir, 'ralplan-state.json');
  const skillPath = join(sessionDir, 'skill-active-state.json');
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({
    session_id: sessionId,
    cwd,
    state_root: join(cwd, '.omx', 'state'),
  }));
  await writeFile(ralplanPath, JSON.stringify({
    active: true,
    mode: 'ralplan',
    current_phase: 'planning',
    session_id: sessionId,
  }, null, 2));
  await writeFile(skillPath, JSON.stringify({
    active: true,
    skill: 'ralplan',
    phase: 'planning',
    current_phase: 'planning',
    session_id: sessionId,
    active_skills: [
      { skill: 'ralplan', active: true, phase: 'planning', current_phase: 'planning' },
      { skill: 'team', active: true, phase: 'executing' },
    ],
  }, null, 2));
  return {
    cwd,
    sessionId,
    sessionDir,
    ralplanPath,
    skillPath,
    originalRalplan: await readFile(ralplanPath),
    originalSkill: await readFile(skillPath),
  };
}

async function withFixture(run: (fixture: RoutingFixture) => Promise<void>): Promise<void> {
  const previousSessionId = process.env.OMX_SESSION_ID;
  const fixture = await makeRoutingFixture();
  process.env.OMX_SESSION_ID = fixture.sessionId;
  clearNeutralizeSeam();
  try {
    await run(fixture);
  } finally {
    clearNeutralizeSeam();
    if (previousSessionId === undefined) delete process.env.OMX_SESSION_ID;
    else process.env.OMX_SESSION_ID = previousSessionId;
    await rm(fixture.cwd, { recursive: true, force: true });
  }
}

async function runPreflight(fixture: RoutingFixture) {
  const result = await invoke(['preflight', '--json'], { cwd: () => fixture.cwd });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  return result;
}

async function assertOriginalPair(fixture: RoutingFixture): Promise<void> {
  assert.deepEqual(await readFile(fixture.ralplanPath), fixture.originalRalplan);
  assert.deepEqual(await readFile(fixture.skillPath), fixture.originalSkill);
}

async function assertNeutralizedPair(fixture: RoutingFixture): Promise<void> {
  const ralplan = JSON.parse(await readFile(fixture.ralplanPath, 'utf8')) as Record<string, unknown>;
  const skill = JSON.parse(await readFile(fixture.skillPath, 'utf8')) as Record<string, unknown>;
  assert.equal(ralplan.active, false);
  assert.equal(ralplan.current_phase, 'cancelled');
  assert.equal(skill.active, false);
  assert.equal(skill.phase, 'cancelled');
  assert.equal(skill.current_phase, 'cancelled');
  const activeSkills = skill.active_skills as Array<Record<string, unknown>>;
  assert.equal(activeSkills.find((entry) => entry.skill === 'ralplan')?.active, false);
  assert.equal(activeSkills.find((entry) => entry.skill === 'ralplan')?.current_phase, 'cancelled');
}

async function assertAtomicPair(fixture: RoutingFixture): Promise<void> {
  const [ralplan, skill] = await Promise.all([readFile(fixture.ralplanPath), readFile(fixture.skillPath)]);
  const original = ralplan.equals(fixture.originalRalplan) && skill.equals(fixture.originalSkill);
  if (original) return;
  await assertNeutralizedPair(fixture);
}

describe('#3194 ralplan CLI unsupported-only surface', () => {
  it('fails the explicit adapted-surface preflight without unproven mutation', async () => {
    let resolved = false;
    let neutralized = false;
    const result = await invoke(['preflight', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
      neutralizeOwnedRoutingRalplan: async () => { neutralized = true; return false; },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(resolved, false);
    assert.equal(neutralized, true);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });

  it('neutralizes both canonical session routing files for an ordinary owned seed', async () => {
    await withFixture(async (fixture) => {
      await runPreflight(fixture);
      await assertNeutralizedPair(fixture);
    });
  });

  for (const point of ['temp-create', 'temp-write', 'temp-sync', 'first-publish', 'second-publish', 'directory-sync', 'read-back', 'cleanup'] as const) {
    it(`keeps the canonical pair atomic when ${point} fails once`, async () => {
      await withFixture(async (fixture) => {
        let injected = false;
        RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (observed) => {
          if (!injected && observed === point) {
            injected = true;
            throw new Error(`injected ${point}`);
          }
        };
        await runPreflight(fixture);
        assert.equal(injected, true);
        await assertAtomicPair(fixture);
      });
    });
  }

  it('retries a one-shot rollback failure and restores both original canonical files', async () => {
    await withFixture(async (fixture) => {
      let secondPublishFailed = false;
      let rollbackFailed = false;
      const syncPhases: string[] = [];
      RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (point) => {
        if (point === 'second-publish' && !secondPublishFailed) {
          secondPublishFailed = true;
          throw new Error('injected second publish');
        }
        if (point === 'rollback' && !rollbackFailed) {
          rollbackFailed = true;
          throw new Error('injected rollback');
        }
      };
      RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync = (phase) => { syncPhases.push(phase); };
      await runPreflight(fixture);
      assert.equal(secondPublishFailed, true);
      assert.equal(rollbackFailed, true);
      assert.ok(syncPhases.includes('prepare'));
      assert.ok(syncPhases.includes('rollback'));
      await assertOriginalPair(fixture);
    });
  });

  it('fsyncs the directory around a successful publish', async () => {
    await withFixture(async (fixture) => {
      const phases: string[] = [];
      RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync = (phase) => { phases.push(phase); };
      await runPreflight(fixture);
      assert.deepEqual(phases.slice(0, 2), ['prepare', 'publish']);
      await assertNeutralizedPair(fixture);
    });
  });

  it('does not overwrite a pre-created predictable temporary name', async () => {
    await withFixture(async (fixture) => {
      const predictable = Buffer.from('predictable');
      const tempPath = join(fixture.sessionDir, `.ralplan-recovery-0.${predictable.toString('hex')}`);
      await writeFile(tempPath, 'foreign temp');
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => predictable;
      await runPreflight(fixture);
      assert.equal(await readFile(tempPath, 'utf8'), 'foreign temp');
      await assertOriginalPair(fixture);
    });
  });

  it('fails closed when controlled random temporary names collide', async () => {
    await withFixture(async (fixture) => {
      const collision = Buffer.alloc(24, 7);
      await writeFile(join(fixture.sessionDir, `.ralplan-recovery-0.${collision.toString('hex')}`), 'collision');
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => collision;
      await runPreflight(fixture);
      await assertOriginalPair(fixture);
    });
  });

  it('does not publish over a foreign replacement before first publish', async () => {
    await withFixture(async (fixture) => {
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish = async (index) => {
        if (index === 0) await writeFile(fixture.ralplanPath, 'foreign-before-first');
      };
      await runPreflight(fixture);
      assert.equal(await readFile(fixture.ralplanPath, 'utf8'), 'foreign-before-first');
      assert.deepEqual(await readFile(fixture.skillPath), fixture.originalSkill);
    });
  });

  it('rolls back the first publish without overwriting a foreign replacement between publishes', async () => {
    await withFixture(async (fixture) => {
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish = async (index) => {
        if (index === 1) await writeFile(fixture.skillPath, 'foreign-between-publishes');
      };
      await runPreflight(fixture);
      assert.equal(await readFile(fixture.skillPath, 'utf8'), 'foreign-between-publishes');
      assert.deepEqual(await readFile(fixture.ralplanPath), fixture.originalRalplan);
    });
  });

  it('preserves recovery files and does not overwrite a foreign replacement before rollback', async () => {
    await withFixture(async (fixture) => {
      RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (point) => {
        if (point === 'second-publish') throw new Error('force rollback');
      };
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforeRollback = async () => {
        await writeFile(fixture.ralplanPath, 'foreign-before-rollback');
      };
      await runPreflight(fixture);
      assert.equal(await readFile(fixture.ralplanPath, 'utf8'), 'foreign-before-rollback');
      const names = await readdir(fixture.sessionDir);
      assert.ok(names.some((name) => name.startsWith('.ralplan-recovery-')));
    });
  });

  for (const invalidCase of ['absent', 'malformed', 'oversized', 'symlink', 'hardlink', 'foreign-owner', 'substantive'] as const) {
    it(`leaves ${invalidCase} routing state byte-for-byte unchanged`, async () => {
      await withFixture(async (fixture) => {
        if (invalidCase === 'absent') await rm(fixture.skillPath);
        if (invalidCase === 'malformed') await writeFile(fixture.ralplanPath, '{not json');
        if (invalidCase === 'oversized') await writeFile(fixture.ralplanPath, Buffer.alloc(128 * 1024 + 1, 1));
        if (invalidCase === 'symlink') {
          const target = join(fixture.cwd, 'outside.json');
          await writeFile(target, fixture.originalRalplan);
          await rm(fixture.ralplanPath);
          await symlink(target, fixture.ralplanPath);
        }
        if (invalidCase === 'hardlink') {
          const target = join(fixture.cwd, 'hardlinked.json');
          await writeFile(target, fixture.originalRalplan);
          await rm(fixture.ralplanPath);
          await link(target, fixture.ralplanPath);
        }
        if (invalidCase === 'foreign-owner') await writeFile(fixture.ralplanPath, JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning', session_id: 'foreign-session' }));
        if (invalidCase === 'substantive') await writeFile(fixture.ralplanPath, JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'executing', session_id: fixture.sessionId }));

        const beforeRalplan = await readFile(fixture.ralplanPath);
        const beforeSkill = await readFile(fixture.skillPath).catch(() => null);
        await runPreflight(fixture);
        assert.deepEqual(await readFile(fixture.ralplanPath), beforeRalplan);
        if (beforeSkill === null) await assert.rejects(() => readFile(fixture.skillPath));
        else assert.deepEqual(await readFile(fixture.skillPath), beforeSkill);
        if (invalidCase === 'symlink') assert.equal((await lstat(fixture.ralplanPath)).isSymbolicLink(), true);
        if (invalidCase === 'hardlink') assert.equal((await lstat(fixture.ralplanPath)).nlink, 2);
      });
    });
  }

  it('validates malformed arguments before resolving a role', async () => {
    let resolved = false;
    await assert.rejects(() => invoke(['role-intent', 'write', '--role', 'architect', '--json'], {
      resolveInstalledRoleName: () => { resolved = true; return 'architect'; },
    }), /Missing --parent-thread/);
    assert.equal(resolved, false);
  });

  it('keeps unknown-role precedence without consulting an authority state source', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'synthetic-unknown', '--parent-thread', 'forged-parent', '--json'], {
      resolveInstalledRoleName: () => null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });

  it('denies an installed role without consulting forgeable authority state', async () => {
    const result = await invoke(['role-intent', 'write', '--role', 'architect', '--parent-thread', 'forged-parent', '--session', 'forged-session', '--ttl-ms', '1', '--json'], {
      resolveInstalledRoleName: (role) => role === 'architect' ? role : null,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unsupported_documented_leader_proof' });
  });
});
