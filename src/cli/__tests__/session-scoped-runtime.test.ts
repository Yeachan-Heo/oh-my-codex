import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { resolveRepoPath } from '../index.js';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');

function runOmx(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: 'utf-8',
  });
}

describe('CLI session-scoped state parity', () => {
  it('treats Windows drive-letter evidence paths as absolute when resolving stale evidence', () => {
    assert.equal(
      resolveRepoPath('/repo/worktree', 'C:\\Users\\alice\\project\\.omx\\plans\\prd.md'),
      'C:\\Users\\alice\\project\\.omx\\plans\\prd.md',
    );
  });

  it('status and cancel include session-scoped states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-scope-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess1' }));
      const scopedDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      await mkdir(scopedDir, { recursive: true });
      await writeFile(join(scopedDir, 'team-state.json'), JSON.stringify({
        active: true,
        current_phase: 'team-exec',
      }));

      const statusResult = runOmx(wd, 'status');
      if (statusResult.error && /(EPERM|EACCES)/i.test(statusResult.error.message)) return;
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /team: ACTIVE/);

      const cancelResult = runOmx(wd, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: team/);

      const updated = JSON.parse(await readFile(join(scopedDir, 'team-state.json'), 'utf-8'));
      assert.equal(updated.active, false);
      assert.equal(updated.current_phase, 'cancelled');
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels linked ultrawork when Ralph is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-link-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-link';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));

      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 10,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        linked_ultrawork: true,
      }));
      await writeFile(join(sessionDir, 'ultrawork-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
      }));

      const cancelResult = runOmx(wd, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralph/);
      assert.match(cancelResult.stdout, /Cancelled: ultrawork/);

      const ralph = JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, false);
      assert.equal(ralph.current_phase, 'cancelled');
      assert.ok(typeof ralph.completed_at === 'string');

      const ultrawork = JSON.parse(await readFile(join(sessionDir, 'ultrawork-state.json'), 'utf-8'));
      assert.equal(ultrawork.active, false);
      assert.equal(ultrawork.current_phase, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not mutate unrelated sessions when cancelling current session mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cross-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionA = join(stateDir, 'sessions', 'sessA');
      const sessionB = join(stateDir, 'sessions', 'sessB');
      await mkdir(sessionA, { recursive: true });
      await mkdir(sessionB, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sessA' }));

      await writeFile(join(sessionA, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
      }));
      await writeFile(join(sessionB, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
      }));

      const cancelResult = runOmx(wd, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralph/);

      const aState = JSON.parse(await readFile(join(sessionA, 'ralph-state.json'), 'utf-8'));
      const bState = JSON.parse(await readFile(join(sessionB, 'ralph-state.json'), 'utf-8'));
      assert.equal(aState.active, false);
      assert.equal(aState.current_phase, 'cancelled');
      assert.equal(bState.active, true);
      assert.equal(bState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels stale Ralph startup state and clears matching skill-active state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-stale' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-stale',
      }));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'starting',
        session_id: 'sess-stale',
        active_skills: [{ skill: 'ralph', phase: 'starting', active: true, session_id: 'sess-stale' }],
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled stale Ralph session\./);

      const ralph = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, false);
      assert.equal(ralph.current_phase, 'cancelled');
      assert.ok(typeof ralph.completed_at === 'string' && ralph.completed_at.length > 0);

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(skillState.active, false);
      assert.deepEqual(skillState.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves unrelated root skill entries when cancelling scoped stale Ralph state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-root-skill-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-current';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        session_id: sessionId,
      }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'starting',
        session_id: sessionId,
        active_skills: [{ skill: 'ralph', phase: 'starting', active: true, session_id: sessionId }],
      }));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'deep-interview',
        phase: 'planning',
        active_skills: [{ skill: 'deep-interview', phase: 'planning', active: true, session_id: '' }],
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled stale Ralph session\./);

      const rootSkillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(rootSkillState.active, true);
      assert.equal(rootSkillState.skill, 'deep-interview');
      assert.equal(rootSkillState.active_skills.length, 1);
      assert.equal(rootSkillState.active_skills[0].skill, 'deep-interview');
      assert.equal(rootSkillState.active_skills[0].phase, 'planning');
      assert.equal(rootSkillState.active_skills[0].active, true);

      const sessionSkillState = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(sessionSkillState.active, false);
      assert.deepEqual(sessionSkillState.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('clears a stale root Ralph skill entry when scoped stale cleanup targets a different visible session skill', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-root-global-skill-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-current';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        session_id: sessionId,
      }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'deep-interview',
        phase: 'planning',
        session_id: sessionId,
        active_skills: [{ skill: 'deep-interview', phase: 'planning', active: true, session_id: sessionId }],
      }));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'starting',
        active_skills: [{ skill: 'ralph', phase: 'starting', active: true }],
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled stale Ralph session\./);

      const rootSkillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(rootSkillState.active, false);
      assert.deepEqual(rootSkillState.active_skills, []);

      const sessionSkillState = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(sessionSkillState.active, true);
      assert.equal(sessionSkillState.skill, 'deep-interview');
      assert.equal(sessionSkillState.active_skills.length, 1);
      assert.equal(sessionSkillState.active_skills[0].skill, 'deep-interview');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps normal Ralph cancel behavior when --stale is not provided', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-normal-cancel-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-normal' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-normal',
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralph/);

      const ralph = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, false);
      assert.equal(ralph.current_phase, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refuses stale Ralph cancellation when startup evidence exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-refuse-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const contextDir = join(wd, '.omx', 'context');
      await mkdir(stateDir, { recursive: true });
      await mkdir(contextDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-refuse' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-refuse',
        context_snapshot_path: '.omx/context/seed.md',
      }));
      await writeFile(join(contextDir, 'seed.md'), '# snapshot\n');

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 1, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Refused stale Ralph cancellation\./);

      const ralph = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, true);
      assert.equal(ralph.current_phase, 'starting');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('refuses stale Ralph cancellation for fresh or actively executing runs', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-age-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-fresh' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        thread_id: 'sess-fresh',
      }));

      let cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 1, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /too fresh/);

      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-fresh',
      }));

      cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 1, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /phase executing/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not mutate unrelated sessions during stale Ralph cancellation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-cross-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const otherSessionDir = join(stateDir, 'sessions', 'sess-other');
      await mkdir(otherSessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-current' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-current',
      }));
      await writeFile(join(otherSessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'executing',
        started_at: '2026-02-22T00:00:00.000Z',
        session_id: 'sess-other',
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);

      const currentState = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      const otherState = JSON.parse(await readFile(join(otherSessionDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(currentState.current_phase, 'cancelled');
      assert.equal(otherState.active, true);
      assert.equal(otherState.current_phase, 'executing');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels stale root Ralph state when the current session has no scoped Ralph entry', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(join(stateDir, 'sessions', 'sess-current'), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-current' }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-current',
      }));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'starting',
        session_id: '',
        active_skills: [{ skill: 'ralph', phase: 'starting', active: true, session_id: '' }],
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled stale Ralph session\./);

      const ralph = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(ralph.active, false);
      assert.equal(ralph.current_phase, 'cancelled');

      const skillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(skillState.active, false);
      assert.deepEqual(skillState.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels stale root Ralph state when the current session already has terminal scoped Ralph state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-stale-root-terminal-scoped-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', 'sess-current');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-current' }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        current_phase: 'cancelled',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        session_id: 'sess-current',
      }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: false,
        skill: 'ralph',
        phase: '',
        session_id: 'sess-current',
        active_skills: [],
      }));
      await writeFile(join(stateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        current_phase: 'starting',
        started_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z',
        thread_id: 'sess-current',
      }));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'starting',
        session_id: '',
        active_skills: [{ skill: 'ralph', phase: 'starting', active: true, session_id: '' }],
      }));

      const cancelResult = runOmx(wd, 'cancel', 'ralph', '--stale');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled stale Ralph session\./);

      const rootRalph = JSON.parse(await readFile(join(stateDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(rootRalph.active, false);
      assert.equal(rootRalph.current_phase, 'cancelled');

      const rootSkillState = JSON.parse(await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(rootSkillState.active, false);
      assert.deepEqual(rootSkillState.active_skills, []);

      const scopedRalph = JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8'));
      assert.equal(scopedRalph.active, false);
      assert.equal(scopedRalph.current_phase, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
