import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { dirname, join } from 'path';
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

function runOmxWithEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

describe('CLI session-scoped state parity', () => {
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

  it('status does not report a root fallback mode as active after current-session clear', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-clear-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-clear';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(stateDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'legacy-root',
      }));
      await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({
        active: true,
        mode: 'deep-interview',
        current_phase: 'session-active',
      }));

      const clearResult = runOmx(
        wd,
        'state',
        'clear',
        '--input',
        '{"mode":"deep-interview"}',
        '--json',
      );
      assert.equal(clearResult.status, 0, clearResult.stderr || clearResult.stdout);
      assert.match(clearResult.stdout, /"cleared":true/);

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.doesNotMatch(statusResult.stdout, /deep-interview: ACTIVE/);
      assert.match(statusResult.stdout, /deep-interview: inactive \(phase: cleared\)/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancels hook-visible run-dir session state when worktree state list-active is empty', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-worktree-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-runs-'));
    try {
      const sessionId = 'sess-run-dir-cancel';
      const runDir = join(runsRoot, 'run-20260610121751-b6c4');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(runSessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'deep-interview',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'deep-interview', active: true, session_id: sessionId }],
      }, null, 2));
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({
        launcher: 'omx --madmax',
        created_at: '2026-06-10T12:17:51.000Z',
        cwd: runDir,
        source_cwd: wd,
        argv: ['codex'],
        run_dir: runDir,
      })}\n`);

      const listResult = runOmx(wd, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });

      const cancelResult = runOmxWithEnv(wd, { OMX_RUNS_DIR: runsRoot }, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: autopilot/);
      assert.doesNotMatch(cancelResult.stdout, /No active modes to cancel/);

      const autopilot = JSON.parse(await readFile(join(runSessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, 'cancelled');
      assert.ok(typeof autopilot.completed_at === 'string' && autopilot.completed_at.length > 0);

      const skillActive = JSON.parse(await readFile(join(runSessionDir, 'skill-active-state.json'), 'utf-8'));
      assert.equal(skillActive.active, false);
      assert.equal(skillActive.current_phase, 'cancelled');
      assert.equal(skillActive.phase, 'cancelled');
      assert.deepEqual(
        skillActive.active_skills.map((skill: { active: unknown; phase: unknown }) => ({
          active: skill.active,
          phase: skill.phase,
        })),
        [{ active: false, phase: 'cancelled' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('reports hook-visible run-dir session state in status when worktree state list-active is empty', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-status-worktree-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-status-runs-'));
    try {
      const sessionId = 'sess-run-dir-status';
      const runDir = join(runsRoot, 'run-20260610121751-c7d5');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({
        launcher: 'omx --madmax',
        created_at: '2026-06-10T12:17:51.000Z',
        cwd: runDir,
        source_cwd: wd,
        argv: ['codex'],
        run_dir: runDir,
      })}\n`);

      const listResult = runOmx(wd, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });

      const statusResult = runOmxWithEnv(wd, { OMX_RUNS_DIR: runsRoot }, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: ACTIVE \(phase: deep-interview\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
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
});
