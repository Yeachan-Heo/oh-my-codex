import assert from 'node:assert/strict';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE,
  UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE,
  evaluateCodex01445PreToolUse,
  parseCodex01445AdaptedRoleIntentCommand,
  neutralizeOwnedRoutingRalplan,
  RALPLAN_NEUTRALIZE_TEST_SEAM,
} from '../documented-leader-preflight.js';

const posixCommand = (role: string) =>
  `omx ralplan role-intent write --role ${role} --parent-thread "$CODEX_THREAD_ID" --json`;
const windowsCommand = (role: string) =>
  `omx ralplan role-intent write --role ${role} --parent-thread "%CODEX_THREAD_ID%" --json`;

describe('Codex 0.144.5 adapted role-intent preflight', () => {
  it('recognizes only the canonical standalone POSIX and Windows forms', () => {
    assert.deepEqual(parseCodex01445AdaptedRoleIntentCommand(posixCommand('architect'), 'linux'), { role: 'architect' });
    assert.deepEqual(parseCodex01445AdaptedRoleIntentCommand(windowsCommand('critic'), 'win32'), { role: 'critic' });
    for (const command of [
      'ROLE=architect ' + posixCommand('architect'),
      'env ' + posixCommand('architect'),
      posixCommand('architect') + '; id',
      posixCommand('architect') + ' > out',
      'omx ralplan role-intent write --role architect --json',
      'omx ralplan role-intent write --role architect --role critic --parent-thread "$CODEX_THREAD_ID" --json',
      'omx ralplan role-intent write --parent-thread "$CODEX_THREAD_ID" --role architect --json',
      'omx ralplan role-intent write --role $ROLE --parent-thread "$CODEX_THREAD_ID" --json',
    ]) assert.equal(parseCodex01445AdaptedRoleIntentCommand(command, 'linux'), null, command);
  });

  it('denies installed roles and preserves unknown-role precedence without inspecting unrelated tools', () => {
    let calls = 0;
    const resolveInstalledRoleName = (role: string) => {
      calls += 1;
      return role === 'architect' || role === 'custom-role' ? role : null;
    };
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('architect') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('custom-role') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'Bash',
      tool_input: { command: posixCommand('missing-role') },
    }, { resolveInstalledRoleName, platform: 'linux' }), UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({
      tool_name: 'apply_patch', agent_role: 'architect', tool_input: { command: posixCommand('architect') },
    }, { resolveInstalledRoleName, platform: 'linux' }), undefined);
    assert.equal(calls, 3);
  });
});

interface RoutingFixture {
  cwd: string;
  sessionId: string;
  sessionDir: string;
  ralplanPath: string;
  skillPath: string;
  originalRalplan: Buffer;
  originalSkill: Buffer;
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

async function neutralize(fixture: RoutingFixture): Promise<boolean> {
  return neutralizeOwnedRoutingRalplan(fixture.cwd);
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


describe('#3194 documented leader preflight neutralization transaction', () => {
  it('neutralizes both canonical session routing files for an ordinary owned seed', async () => {
    await withFixture(async (fixture) => {
      await neutralize(fixture);
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
        await neutralize(fixture);
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
      await neutralize(fixture);
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
      await neutralize(fixture);
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
      await neutralize(fixture);
      assert.equal(await readFile(tempPath, 'utf8'), 'foreign temp');
      await assertOriginalPair(fixture);
    });
  });

  it('fails closed when controlled random temporary names collide', async () => {
    await withFixture(async (fixture) => {
      const collision = Buffer.alloc(24, 7);
      await writeFile(join(fixture.sessionDir, `.ralplan-recovery-0.${collision.toString('hex')}`), 'collision');
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => collision;
      await neutralize(fixture);
      await assertOriginalPair(fixture);
    });
  });

  it('does not follow or overwrite a pre-created recovery symlink', async () => {
    await withFixture(async (fixture) => {
      const predictable = Buffer.from('recovery-symlink');
      const recoveryPath = join(fixture.sessionDir, `.ralplan-recovery-0.${predictable.toString('hex')}`);
      const target = join(fixture.cwd, 'foreign-recovery-target');
      await writeFile(target, 'foreign recovery target');
      await symlink(target, recoveryPath);
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => predictable;
      await neutralize(fixture);
      assert.equal((await lstat(recoveryPath)).isSymbolicLink(), true);
      assert.equal(await readFile(target, 'utf8'), 'foreign recovery target');
      await assertOriginalPair(fixture);
    });
  });

  it('cleans owned recovery files when a pre-created replacement temporary collides', async () => {
    await withFixture(async (fixture) => {
      const randomValues = [Buffer.alloc(24, 1), Buffer.alloc(24, 2), Buffer.alloc(24, 3)];
      const replacementPath = join(fixture.sessionDir, `.ralplan-next-0.${randomValues[2].toString('hex')}`);
      await writeFile(replacementPath, 'foreign replacement temporary');
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => randomValues.shift() ?? Buffer.alloc(24, 4);
      await neutralize(fixture);
      assert.equal(await readFile(replacementPath, 'utf8'), 'foreign replacement temporary');
      assert.deepEqual((await readdir(fixture.sessionDir)).filter((name) => name.startsWith('.ralplan-recovery-')), []);
      await assertOriginalPair(fixture);
    });
  });

  it('does not publish over a foreign replacement before first publish', async () => {
    await withFixture(async (fixture) => {
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish = async (index) => {
        if (index === 0) {
          await rm(fixture.ralplanPath);
          await writeFile(fixture.ralplanPath, 'foreign-before-first');
        }
      };
      await neutralize(fixture);
      assert.equal(await readFile(fixture.ralplanPath, 'utf8'), 'foreign-before-first');
      assert.deepEqual(await readFile(fixture.skillPath), fixture.originalSkill);
    });
  });

  it('rolls back the first publish without overwriting a foreign replacement between publishes', async () => {
    await withFixture(async (fixture) => {
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforePublish = async (index) => {
        if (index === 1) {
          await rm(fixture.skillPath);
          await writeFile(fixture.skillPath, 'foreign-between-publishes');
        }
      };
      await neutralize(fixture);
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
        await rm(fixture.ralplanPath);
        await writeFile(fixture.ralplanPath, 'foreign-before-rollback');
      };
      await neutralize(fixture);
      assert.equal(await readFile(fixture.ralplanPath, 'utf8'), 'foreign-before-rollback');
      const names = await readdir(fixture.sessionDir);
      assert.ok(names.some((name) => name.startsWith('.ralplan-recovery-')));
    });
  });

  it('does not use a same-user replacement of a recovery file during rollback', async () => {
    await withFixture(async (fixture) => {
      const randomValues = [Buffer.alloc(24, 11), Buffer.alloc(24, 12), Buffer.alloc(24, 13), Buffer.alloc(24, 14)];
      const recoveryPath = join(fixture.sessionDir, `.ralplan-recovery-0.${randomValues[0].toString('hex')}`);
      let replaced = false;
      RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => randomValues.shift() ?? Buffer.alloc(24, 15);
      RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (point) => {
        if (point === 'second-publish') throw new Error('force rollback');
      };
      RALPLAN_NEUTRALIZE_TEST_SEAM.beforeRollback = async () => {
        if (replaced) return;
        replaced = true;
        await rm(recoveryPath);
        await writeFile(recoveryPath, 'foreign recovery before rollback');
      };
      await neutralize(fixture);
      assert.equal(replaced, true);
      assert.equal(await readFile(recoveryPath, 'utf8'), 'foreign recovery before rollback');
      assert.equal((JSON.parse(await readFile(fixture.ralplanPath, 'utf8')) as Record<string, unknown>).active, false);
      assert.deepEqual(await readFile(fixture.skillPath), fixture.originalSkill);
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
        await neutralize(fixture);
        assert.deepEqual(await readFile(fixture.ralplanPath), beforeRalplan);
        if (beforeSkill === null) await assert.rejects(() => readFile(fixture.skillPath));
        else assert.deepEqual(await readFile(fixture.skillPath), beforeSkill);
        if (invalidCase === 'symlink') assert.equal((await lstat(fixture.ralplanPath)).isSymbolicLink(), true);
        if (invalidCase === 'hardlink') assert.equal((await lstat(fixture.ralplanPath)).nlink, 2);
      });
    });
  }

});
