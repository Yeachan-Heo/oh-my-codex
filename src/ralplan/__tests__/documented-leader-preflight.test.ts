import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readModeState } from '../../modes/base.js';
import { readSkillActiveState } from '../../state/skill-active.js';
import { recordSkillActivation } from '../../hooks/keyword-detector.js';
import {
  UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE, UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE,
  evaluateCodex01445PreToolUse, neutralizeOwnedRoutingRalplan, parseCodex01445AdaptedRoleIntentCommand,
  readNeutralizedRoutingOverlay, RALPLAN_NEUTRALIZE_TEST_SEAM,
} from '../documented-leader-preflight.js';

const command = (role: string) => `omx ralplan role-intent write --role ${role} --parent-thread "$CODEX_THREAD_ID" --json`;
describe('Codex 0.144.5 adapted role-intent preflight', () => {
  it('recognizes only the canonical standalone form', () => {
    assert.deepEqual(parseCodex01445AdaptedRoleIntentCommand(command('architect'), 'linux'), { role: 'architect' });
    assert.equal(parseCodex01445AdaptedRoleIntentCommand(`${command('architect')}; id`, 'linux'), null);
  });
  it('denies installed and unknown roles distinctly', () => {
    const resolveInstalledRoleName = (role: string) => role === 'architect' ? role : null;
    assert.equal(evaluateCodex01445PreToolUse({ tool_name: 'Bash', tool_input: { command: command('architect') } }, { resolveInstalledRoleName, platform: 'linux' }), UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE);
    assert.equal(evaluateCodex01445PreToolUse({ tool_name: 'Bash', tool_input: { command: command('missing') } }, { resolveInstalledRoleName, platform: 'linux' }), UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE);
  });
});

interface Fixture { cwd: string; sessionId: string; directory: string; ralplanPath: string; skillPath: string; ralplan: Buffer; skill: Buffer; }
function clear(): void { delete RALPLAN_NEUTRALIZE_TEST_SEAM.fail; delete RALPLAN_NEUTRALIZE_TEST_SEAM.random; delete RALPLAN_NEUTRALIZE_TEST_SEAM.directorySync; delete RALPLAN_NEUTRALIZE_TEST_SEAM.afterPin; delete RALPLAN_NEUTRALIZE_TEST_SEAM.onError; delete RALPLAN_NEUTRALIZE_TEST_SEAM.platform; delete RALPLAN_NEUTRALIZE_TEST_SEAM.darwinHelperMode; }
async function fixture(): Promise<Fixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-generation-')); const sessionId = 'owned-session';
  const directory = join(cwd, '.omx', 'state', 'sessions', sessionId); const ralplanPath = join(directory, 'ralplan-state.json'); const skillPath = join(directory, 'skill-active-state.json');
  await mkdir(directory, { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
  // This is the keyword-detector producer shape: mode state has no source field; skill state carries keyword provenance.
  await writeFile(ralplanPath, JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning', started_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', session_id: sessionId, thread_id: 'thread', turn_id: 'turn' }));
  await writeFile(skillPath, JSON.stringify({ version: 1, active: true, skill: 'ralplan', keyword: '$ralplan', phase: 'planning', activated_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', source: 'keyword-detector', session_id: sessionId, thread_id: 'thread', turn_id: 'turn', initialized_mode: 'ralplan', initialized_state_path: `.omx/state/sessions/${sessionId}/ralplan-state.json`, active_skills: [{ skill: 'ralplan', phase: 'planning', active: true, activated_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', session_id: sessionId, thread_id: 'thread', turn_id: 'turn' }] }));
  return { cwd, sessionId, directory, ralplanPath, skillPath, ralplan: await readFile(ralplanPath), skill: await readFile(skillPath) };
}
function pairDigest(f: Fixture): string { return digestBytes(f.ralplan, f.skill); }
function digestBytes(ralplan: Buffer, skill: Buffer): string { return createHash('sha256').update('ralplan-state.json\0').update(ralplan).update('\0skill-active-state.json\0').update(skill).digest('hex'); }
async function mintCommittedGeneration(f: Fixture): Promise<void> {
  const [ralplan, skill] = await Promise.all([readFile(f.ralplanPath), readFile(f.skillPath)]);
  const digest = digestBytes(ralplan, skill); const token = 'f'.repeat(48); const dataFile = `.ralplan-neutralization-${digest}-${token}.json`;
  const record = { version: 1, digest, canonical: { ralplan: { sha256: createHash('sha256').update(ralplan).digest('hex'), size: ralplan.length }, skill: { sha256: createHash('sha256').update(skill).digest('hex'), size: skill.length } } };
  await writeFile(join(f.directory, dataFile), `${JSON.stringify(record)}\n`);
  await writeFile(join(f.directory, `.ralplan-neutralization-${digest}-${token}.commit.json`), `${JSON.stringify({ version: 1, digest, dataFile, committed: true })}\n`);
}
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> { const old = process.env.OMX_SESSION_ID; const f = await fixture(); process.env.OMX_SESSION_ID = f.sessionId; clear(); try { await fn(f); } finally { clear(); old === undefined ? delete process.env.OMX_SESSION_ID : process.env.OMX_SESSION_ID = old; await rm(f.cwd, { recursive: true, force: true }); } }
async function originals(f: Fixture): Promise<void> { assert.deepEqual(await readFile(f.ralplanPath), f.ralplan); assert.deepEqual(await readFile(f.skillPath), f.skill); }
async function visibleNeutralized(f: Fixture): Promise<void> { assert.equal((await readModeState('ralplan', f.cwd))?.active, false); assert.equal((await readSkillActiveState(f.skillPath))?.active, false); }
function generations(f: Fixture): Promise<string[]> { return readdir(f.directory).then((names) => names.filter((name) => name.startsWith('.ralplan-neutralization-'))); }

describe('documented leader immutable neutralization generation', () => {
  it('publishes one durable generation while canonical pair remains byte-for-byte immutable', async () => withFixture(async (f) => {
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); await originals(f); await visibleNeutralized(f); assert.equal((await generations(f)).length, 2);

  }));
  for (const point of ['data-create', 'data-write', 'data-sync', 'commit-create', 'commit-write', 'commit-sync', 'directory-sync', 'commit-final-write', 'commit-final-sync'] as const) it(`keeps canonical and readers unchanged when ${point} fails`, async () => withFixture(async (f) => {

    RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (seen) => { if (seen === point) throw new Error(point); };
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); await originals(f);
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
  }));
  it('never overwrites a colliding data or commit pathname and retries with a new correlated pair', async () => withFixture(async (f) => {
    const digest = pairDigest(f); const token = 'a'.repeat(48); const collision = join(f.directory, `.ralplan-neutralization-${digest}-${token}.json`); await writeFile(collision, 'foreign');
    const values = [Buffer.from(token, 'hex'), Buffer.from('b'.repeat(48), 'hex')]; RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => values.shift() ?? Buffer.alloc(24, 3);
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); assert.equal(await readFile(collision, 'utf8'), 'foreign'); await originals(f); await visibleNeutralized(f);
  }));
  it('never overwrites a colliding commit pathname and leaves its first data file inert', async () => withFixture(async (f) => {
    const digest = pairDigest(f); const token = 'e'.repeat(48); const commit = join(f.directory, `.ralplan-neutralization-${digest}-${token}.commit.json`); await writeFile(commit, 'foreign');
    const values = [Buffer.from(token, 'hex'), Buffer.from('f'.repeat(48), 'hex')]; RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => values.shift() ?? Buffer.alloc(24, 6);
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); assert.equal(await readFile(commit, 'utf8'), 'foreign'); await originals(f); await visibleNeutralized(f);
  }));

  it('leaves a pre-created generation symlink untouched', async () => withFixture(async (f) => {
    const target = join(f.cwd, 'foreign-generation'); await writeFile(target, 'foreign');
    const path = join(f.directory, `.ralplan-neutralization-${pairDigest(f)}-${'c'.repeat(48)}.json`); await symlink(target, path);
    const values = [Buffer.from('c'.repeat(48), 'hex'), Buffer.from('d'.repeat(48), 'hex')]; RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => values.shift() ?? Buffer.alloc(24, 4);
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); assert.equal(await readFile(target, 'utf8'), 'foreign'); assert.equal((await lstat(path)).isSymbolicLink(), true); await originals(f);
  }));
  it('retries after a partial uncommitted pair with a distinct immutable pair', async () => withFixture(async (f) => {
    const values = [Buffer.alloc(24, 9), Buffer.alloc(24, 10)]; RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => values.shift() ?? Buffer.alloc(24, 11);
    let failed = false; RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (point) => { if (!failed && point === 'commit-final-sync') { failed = true; throw new Error('partial'); } };
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); await originals(f);
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
    delete RALPLAN_NEUTRALIZE_TEST_SEAM.fail;
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); await originals(f); await visibleNeutralized(f); assert.ok((await generations(f)).length >= 3);
  }));
  it('ignores pending, malformed, symlink, and hardlink generation pairs', async () => withFixture(async (f) => {
    RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => Buffer.alloc(24, 7);
    RALPLAN_NEUTRALIZE_TEST_SEAM.fail = (point) => { if (point === 'commit-final-write') throw new Error('pending'); };
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false);
    const pending = `.ralplan-neutralization-${pairDigest(f)}-${'8'.repeat(48)}.commit.json`;
    await writeFile(join(f.directory, pending), JSON.stringify({ version: 1, digest: pairDigest(f), dataFile: 'missing.json', committed: false }));
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true);
    const target = join(f.cwd, 'target'); await writeFile(target, '{}'); await symlink(target, join(f.directory, '.ralplan-neutralization-symlink.json')); await link(target, join(f.directory, '.ralplan-neutralization-hardlink.json'));
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true); assert.equal((await lstat(join(f.directory, '.ralplan-neutralization-symlink.json'))).isSymbolicLink(), true);
  }));
  it('rejects mixed workflow state without publishing an overlay', async () => withFixture(async (f) => {
    const skill = JSON.parse(await readFile(f.skillPath, 'utf8')); skill.active_skills.push({ skill: 'team', active: true, phase: 'executing', session_id: f.sessionId }); await writeFile(f.skillPath, JSON.stringify(skill));
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); assert.equal((await readModeState('ralplan', f.cwd))?.active, true);
  }));
  it('keeps a mixed Team pair active despite a forged valid committed generation', async () => withFixture(async (f) => {
    const skill = JSON.parse(await readFile(f.skillPath, 'utf8')); skill.active_skills.push({ skill: 'team', active: true, phase: 'executing', session_id: f.sessionId }); await writeFile(f.skillPath, JSON.stringify(skill));
    await mintCommittedGeneration(f);
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
  }));
  for (const [field, value] of [
    ['native_subagent_support', { supported: true }],
    ['ralplan_consensus_gate', { complete: false }],
    ['review_history', [{ verdict: 'approve' }]],
  ] as const) {
    it(`keeps substantive Ralplan field ${field} active despite a forged valid committed generation`, async () => withFixture(async (f) => {
      const ralplan = JSON.parse(await readFile(f.ralplanPath, 'utf8')); ralplan[field] = value; await writeFile(f.ralplanPath, JSON.stringify(ralplan));
      await mintCommittedGeneration(f);
      assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
    }));
  }
  for (const [field, value] of [
    ['initialized_mode', 'team'],
    ['initialized_state_path', '.omx/state/ralplan-state.json'],
    ['initialized_state_path', '.omx/state/sessions/foreign/ralplan-state.json'],
    ['version', '1'],
    ['keyword', '$team'],
    ['activated_at', []],
    ['session_id', []],
  ] as const) {
    it(`keeps state active despite a forged generation with invalid skill ${field}`, async () => withFixture(async (f) => {
      const skill = JSON.parse(await readFile(f.skillPath, 'utf8')); skill[field] = value; await writeFile(f.skillPath, JSON.stringify(skill));
      await mintCommittedGeneration(f);
      assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
    }));
  }
  it('keeps state active despite a forged generation missing initialization metadata', async () => withFixture(async (f) => {
    const skill = JSON.parse(await readFile(f.skillPath, 'utf8')); delete skill.initialized_mode; delete skill.initialized_state_path; await writeFile(f.skillPath, JSON.stringify(skill));
    await mintCommittedGeneration(f);
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
  }));
  it('makes stale generation inert after either canonical byte string changes', async () => withFixture(async (f) => {
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); await writeFile(f.ralplanPath, Buffer.concat([f.ralplan, Buffer.from(' ')]));
    assert.equal((await readModeState('ralplan', f.cwd))?.active, true); assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
  }));
  it('derives the inert overlay from canonical bytes instead of trusting attacker-supplied generation state', async () => withFixture(async (f) => {
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true);
    const dataName = (await generations(f)).find((name) => name.endsWith('.json') && !name.endsWith('.commit.json'));
    assert.ok(dataName);
    const dataPath = join(f.directory, dataName);
    const data = JSON.parse(await readFile(dataPath, 'utf8')) as Record<string, unknown>;
    data.overlay = { ralplan: { active: true, current_phase: 'complete' }, skill: { active: true, phase: 'handoff' } };
    await writeFile(dataPath, `${JSON.stringify(data)}\n`);
    await visibleNeutralized(f);
    await originals(f);
  }));
  for (const keyword of ['$RALPLAN', '$oh-my-codex:ralplan', '$OH-MY-CODEX:RALPLAN', 'CONSENSUS PLAN'] as const) {
    it(`neutralizes the real producer's normalized Ralplan keyword ${keyword}`, async () => withFixture(async (f) => {
      const activated = await recordSkillActivation({ stateDir: join(f.cwd, '.omx', 'state'), sourceCwd: f.cwd, sessionId: f.sessionId, threadId: 'thread', turnId: 'turn', text: keyword, nowIso: '2026-01-01T00:00:00.000Z' });
      assert.ok(activated);
      assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true); await visibleNeutralized(f);
    }));
  }
  it('rejects an unrelated explicit keyword without publishing an overlay', async () => withFixture(async (f) => {
    const skill = JSON.parse(await readFile(f.skillPath, 'utf8')); skill.keyword = '$team'; await writeFile(f.skillPath, JSON.stringify(skill));
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); assert.equal((await generations(f)).length, 0);
  }));
  for (const [target, field, value] of [
    ['ralplan', 'session_id', 'pointer-alias'],
    ['skill', 'session_id', 'pointer-alias'],
    ['entry', 'session_id', 'pointer-alias'],
    ['ralplan', 'thread_id', 'different-thread'],
    ['skill', 'turn_id', 'different-turn'],
    ['entry', 'owner_codex_session_id', 'different-owner'],
  ] as const) {
    it(`rejects pair identity mismatch in ${target}.${field}`, async () => withFixture(async (f) => {
      const ralplan = JSON.parse(await readFile(f.ralplanPath, 'utf8')); const skill = JSON.parse(await readFile(f.skillPath, 'utf8'));
      const state = target === 'ralplan' ? ralplan : target === 'skill' ? skill : skill.active_skills[0]; state[field] = value;
      await Promise.all([writeFile(f.ralplanPath, JSON.stringify(ralplan)), writeFile(f.skillPath, JSON.stringify(skill))]);
      assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); assert.equal((await generations(f)).length, 0);
      await mintCommittedGeneration(f); assert.equal((await readModeState('ralplan', f.cwd))?.active, true);
    }));
  }
  it('pins the session directory before a parent-path swap', async () => withFixture(async (f) => {
    const parked = `${f.directory}-parked`; const foreign = join(f.cwd, 'foreign-session');
    await mkdir(foreign); await writeFile(join(foreign, 'ralplan-state.json'), 'foreign-ralplan'); await writeFile(join(foreign, 'skill-active-state.json'), 'foreign-skill');
    const before = await Promise.all([readFile(join(foreign, 'ralplan-state.json')), readFile(join(foreign, 'skill-active-state.json'))]);
    RALPLAN_NEUTRALIZE_TEST_SEAM.afterPin = async () => { await rename(f.directory, parked); await symlink(foreign, f.directory); };
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true);
    assert.deepEqual(await Promise.all([readFile(join(foreign, 'ralplan-state.json')), readFile(join(foreign, 'skill-active-state.json'))]), before);
    assert.equal((await readdir(foreign)).some((name) => name.startsWith('.ralplan-neutralization-')), false);
    assert.ok((await readdir(parked)).some((name) => name.startsWith('.ralplan-neutralization-')));
  }));
  it('executes the Darwin cwd helper for publication and overlay reads', async () => withFixture(async (f) => {
    RALPLAN_NEUTRALIZE_TEST_SEAM.platform = 'darwin';
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true);
    assert.equal((await readNeutralizedRoutingOverlay(f.ralplanPath, 'ralplan'))?.active, false);
    assert.equal((await readNeutralizedRoutingOverlay(f.skillPath, 'skill'))?.active, false);
    await originals(f);
  }));
  it('executes the Darwin cwd helper collision path', async () => withFixture(async (f) => {
    RALPLAN_NEUTRALIZE_TEST_SEAM.platform = 'darwin';
    const token = 'a'.repeat(48); const collision = join(f.directory, `.ralplan-neutralization-${pairDigest(f)}-${token}.json`);
    await writeFile(collision, 'foreign'); const tokens = [token, 'b'.repeat(48)]; RALPLAN_NEUTRALIZE_TEST_SEAM.random = () => Buffer.from(tokens.shift() ?? 'c'.repeat(48), 'hex');
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true);
    assert.equal(await readFile(collision, 'utf8'), 'foreign');
  }));
  it('keeps the Darwin helper cwd pinned across a parent rename and symlink swap', async () => withFixture(async (f) => {
    RALPLAN_NEUTRALIZE_TEST_SEAM.platform = 'darwin';
    const parked = `${f.directory}-parked`; const foreign = join(f.cwd, 'foreign-session');
    await mkdir(foreign); await writeFile(join(foreign, 'ralplan-state.json'), 'foreign'); await writeFile(join(foreign, 'skill-active-state.json'), 'foreign');
    RALPLAN_NEUTRALIZE_TEST_SEAM.afterPin = async () => { await rename(f.directory, parked); await symlink(foreign, f.directory); };
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), true);
    assert.equal((await readdir(foreign)).some((name) => name.startsWith('.ralplan-neutralization-')), false);
    assert.ok((await readdir(parked)).some((name) => name.startsWith('.ralplan-neutralization-')));
  }));
  for (const mode of ['failure', 'malformed'] as const) it(`fails closed when the Darwin helper ${mode}s`, async () => withFixture(async (f) => {
    RALPLAN_NEUTRALIZE_TEST_SEAM.platform = 'darwin'; RALPLAN_NEUTRALIZE_TEST_SEAM.darwinHelperMode = mode;
    assert.equal(await neutralizeOwnedRoutingRalplan(f.cwd), false); await originals(f);
  }));

  for (const mutate of [
    (ralplan: Record<string, unknown>) => { ralplan.session_id = ` ${String(ralplan.session_id)} `; },
    (ralplan: Record<string, unknown>) => { ralplan.started_at = 'not-a-timestamp'; },
    (ralplan: Record<string, unknown>) => { ralplan.started_at = '2026-01-01T00:00:01.000Z'; },
    (_ralplan: Record<string, unknown>, skill: Record<string, unknown>) => { skill.updated_at = '2026-01-01T00:00:01.000Z'; },
  ]) {
    it('keeps producer-impossible session or timestamp pairs active despite a forged generation', async () => withFixture(async (f) => {
      const ralplan = JSON.parse(await readFile(f.ralplanPath, 'utf8')) as Record<string, unknown>;
      const skill = JSON.parse(await readFile(f.skillPath, 'utf8')) as Record<string, unknown>;
      mutate(ralplan, skill);
      await writeFile(f.ralplanPath, JSON.stringify(ralplan));
      await writeFile(f.skillPath, JSON.stringify(skill));
      await mintCommittedGeneration(f);
      assert.equal((await readModeState('ralplan', f.cwd))?.active, true);
      assert.equal((await readSkillActiveState(f.skillPath))?.active, true);
    }));
  }
  it('ignores generations stored under a padded session-directory basename', async () => withFixture(async (f) => {
    const paddedDirectory = join(f.cwd, '.omx', 'state', 'sessions', ` ${f.sessionId} `);
    await mkdir(paddedDirectory, { recursive: true });
    const padded: Fixture = {
      ...f,
      directory: paddedDirectory,
      ralplanPath: join(paddedDirectory, 'ralplan-state.json'),
      skillPath: join(paddedDirectory, 'skill-active-state.json'),
    };
    await writeFile(padded.ralplanPath, f.ralplan);
    await writeFile(padded.skillPath, f.skill);
    await mintCommittedGeneration(padded);
    assert.equal(await readNeutralizedRoutingOverlay(padded.ralplanPath, 'ralplan'), null);
    assert.equal(await readNeutralizedRoutingOverlay(padded.skillPath, 'skill'), null);
  }));
});
