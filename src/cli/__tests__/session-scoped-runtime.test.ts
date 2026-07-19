import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, readFile } from 'fs/promises';

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');

function cleanOmxEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of [
    'OMX_ROOT',
    'OMX_STATE_ROOT',
    'OMX_TEAM_STATE_ROOT',
    'OMX_SESSION_ID',
    'CODEX_SESSION_ID',
    'SESSION_ID',
    'OMX_RUNS_DIR',
  ]) {
    delete env[name];
  }
  return {
    ...env,
    ...(overrides.FAKE_TMUX_SESSION_NAME ? {
      FAKE_TMUX_PANE_PID: '4242',
      FAKE_TMUX_INTERNAL_SESSION_ID: '$1',
      FAKE_TMUX_SESSION_CREATED: '100',
    } : {}),
    ...overrides,
  };
}

function runOmx(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: 'utf-8',
    env: cleanOmxEnv(),
  });
}

function runOmxWithEnv(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [omxBin, ...args], {
    cwd,
    encoding: 'utf-8',
    env: cleanOmxEnv(env),
  });
}

async function createFakeTmuxBin(root: string): Promise<string> {
  const binDir = join(root, 'bin');
  const tmuxPath = join(binDir, 'tmux');
  await mkdir(binDir, { recursive: true });
  await writeFile(tmuxPath, `#!/bin/sh
case "$1" in
  list-panes)
    count=0
    if [ -n "$FAKE_TMUX_COUNTER_FILE" ] && [ -f "$FAKE_TMUX_COUNTER_FILE" ]; then count=$(cat "$FAKE_TMUX_COUNTER_FILE"); fi
    count=$((count + 1))
    if [ -n "$FAKE_TMUX_COUNTER_FILE" ]; then printf '%s' "$count" > "$FAKE_TMUX_COUNTER_FILE"; fi
    created="$FAKE_TMUX_SESSION_CREATED"
    if [ "$FAKE_TMUX_REPLACE_AFTER_FIRST" = "1" ] && [ "$count" -gt 1 ]; then created=$((created + 1)); fi
    printf '%%42\\t0\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$FAKE_TMUX_PANE_PID" "$FAKE_TMUX_SESSION_NAME" "$FAKE_TMUX_INTERNAL_SESSION_ID" "$created" "$FAKE_OMX_SESSION_ID"
    ;;
  *) exit 1 ;;
esac
`);

  await chmod(tmuxPath, 0o755);
  return binDir;
}

async function writeActiveRunRecord(options: {
  runsRoot: string;
  contextKey: string;
  sourceCwd: string;
  runDir: string;
  sessionId: string;
  tmuxSessionName: string;
  worktreeCwd?: string;

}): Promise<void> {
  const activeDir = join(options.runsRoot, 'active-detached');
  await mkdir(activeDir, { recursive: true });
  await writeFile(join(activeDir, `${options.contextKey}.json`), JSON.stringify({
    version: 1,
    context_key: options.contextKey,
    created_at: '2026-07-19T00:00:00.000Z',
    source_cwd: options.sourceCwd,
    ...(options.worktreeCwd ? { worktree_cwd: options.worktreeCwd } : {}),

    argv: ['--madmax'],
    run_dir: options.runDir,
    tmux_session_name: options.tmuxSessionName,
    session_id: options.sessionId,
    tmux_pane_id: '%42',
    tmux_internal_session_id: '$1',
    tmux_session_created: '100',
    tmux_pane_pid: 4242,
  }, null, 2));
}


describe('CLI session-scoped state parity', () => {
  it('status and cancel include session-scoped states', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-session-scope-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(wd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: 'sess1', cwd: wd, state_root: join(wd, '.omx', 'state') }));
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

  it('does not mutate an unmatched implicit OMX session, including force cleanup', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-unmatched-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'canonical-session';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ralphPath = join(sessionDir, 'ralph-state.json');
      const nativeStopPath = join(sessionDir, 'native-stop-state.json');
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(ralphPath, JSON.stringify({ active: true, current_phase: 'executing' }));
      await writeFile(nativeStopPath, JSON.stringify({
        sessions: { [sessionId]: { last_signature: 'ralph-stop|pending' } },
      }));

      const cancelResult = runOmxWithEnv(
        wd,
        { OMX_SESSION_ID: 'unmatched-session' },
        'cancel',
        '--force',
      );

      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /OMX_SESSION_ID is not bound to session\.json/);
      assert.deepEqual(
        JSON.parse(await readFile(ralphPath, 'utf-8')),
        { active: true, current_phase: 'executing' },
      );
      assert.deepEqual(
        JSON.parse(await readFile(nativeStopPath, 'utf-8')),
        { sessions: { [sessionId]: { last_signature: 'ralph-stop|pending' } } },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores ambient Codex session aliases that do not own writable cancellation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-codex-session-mismatch-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const ownerSession = 'owner-session';
      const foreignSession = 'foreign-codex-session';
      const ownerPath = join(stateDir, 'sessions', ownerSession, 'ralplan-state.json');
      const foreignPath = join(stateDir, 'sessions', foreignSession, 'team-state.json');
      const ownerState = JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'executing' }, null, 2);
      const foreignState = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      await mkdir(dirname(ownerPath), { recursive: true });
      await mkdir(dirname(foreignPath), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: ownerSession, cwd: wd, state_root: stateDir }));

      await writeFile(ownerPath, ownerState);
      await writeFile(foreignPath, foreignState);

      for (const environmentName of ['CODEX_SESSION_ID', 'SESSION_ID']) {
        await writeFile(ownerPath, ownerState);
        const cancelResult = runOmxWithEnv(wd, { [environmentName]: foreignSession }, 'cancel');
        assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
        assert.match(cancelResult.stdout, /Cancelled: ralplan/);
        assert.doesNotMatch(cancelResult.stdout, /Cancelled: team/);
        assert.equal(JSON.parse(await readFile(ownerPath, 'utf-8')).active, false);
        assert.equal(await readFile(foreignPath, 'utf-8'), foreignState);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps root cancellation authoritative despite ambient session aliases', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-root-ambient-session-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const foreignSession = 'foreign-ambient-session';
      const rootPath = join(stateDir, 'team-state.json');
      const foreignPath = join(stateDir, 'sessions', foreignSession, 'ralplan-state.json');
      const rootState = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      const foreignState = JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'executing' }, null, 2);
      await mkdir(dirname(foreignPath), { recursive: true });
      await writeFile(rootPath, rootState);
      await writeFile(foreignPath, foreignState);

      for (const environmentName of ['CODEX_SESSION_ID', 'SESSION_ID']) {
        await writeFile(rootPath, rootState);
        const cancelResult = runOmxWithEnv(wd, { [environmentName]: foreignSession }, 'cancel');
        assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
        assert.match(cancelResult.stdout, /Cancelled: team/);
        assert.doesNotMatch(cancelResult.stdout, /Cancelled: ralplan/);
        assert.equal(JSON.parse(await readFile(rootPath, 'utf-8')).active, false);
        assert.equal(await readFile(foreignPath, 'utf-8'), foreignState);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported cancellation flags before mutation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-flags-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const statePath = join(stateDir, 'team-state.json');
      const state = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, state);
      for (const args of [['--all'], ['--unknown'], ['--force', '--all']]) {
        const result = runOmx(wd, 'cancel', ...args);
        assert.notEqual(result.status, 0);
        assert.equal(await readFile(statePath, 'utf-8'), state);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects symlinked ordinary-scope state targets', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-root-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-root-symlink-outside-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const outsidePath = join(outside, 'team-state.json');
      const state = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      await mkdir(stateDir, { recursive: true });
      await writeFile(outsidePath, state);
      await symlink(outsidePath, join(stateDir, 'team-state.json'));
      const result = runOmx(wd, 'cancel');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /non-regular state target/);
      assert.equal(await readFile(outsidePath, 'utf-8'), state);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects symlinked session authority directories', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-session-root-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-session-root-outside-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'session-root-link';
      const outsidePath = join(outside, 'ralplan-state.json');
      const state = JSON.stringify({ active: true, mode: 'ralplan', session_id: sessionId, current_phase: 'executing' }, null, 2);
      await mkdir(join(stateDir, 'sessions'), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(outsidePath, state);
      await symlink(outside, join(stateDir, 'sessions', sessionId), 'dir');
      const result = runOmx(wd, 'cancel');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /symlinked authority component|unusable/);
      assert.equal(await readFile(outsidePath, 'utf-8'), state);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('denies contradictory selected session state transaction-wide', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-contradictory-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-contradictory';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const contradictoryPath = join(sessionDir, 'ralplan-state.json');
      const validPath = join(sessionDir, 'autopilot-state.json');
      const contradictory = JSON.stringify({ active: true, mode: 'team', session_id: 'foreign', current_phase: 'team-exec' }, null, 2);
      const valid = JSON.stringify({ active: true, mode: 'autopilot', session_id: sessionId, current_phase: 'executing' }, null, 2);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(contradictoryPath, contradictory);
      await writeFile(validPath, valid);
      const result = runOmx(wd, 'cancel');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /contradictory mode state/);
      assert.equal(await readFile(contradictoryPath, 'utf-8'), contradictory);
      assert.equal(await readFile(validPath, 'utf-8'), valid);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails closed when owned session state is malformed', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-malformed-owner-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'malformed-owner';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const malformedPath = join(sessionDir, 'ralplan-state.json');
      const teamPath = join(stateDir, 'team-state.json');
      const malformedState = '{"active":true';
      const rootTeamState = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));

      await writeFile(malformedPath, malformedState);
      await writeFile(teamPath, rootTeamState);

      const cancelResult = runOmx(wd, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /Refusing partial cancellation/);
      assert.doesNotMatch(cancelResult.stdout, /Cancelled: team/);
      assert.equal(await readFile(malformedPath, 'utf-8'), malformedState);
      assert.equal(await readFile(teamPath, 'utf-8'), rootTeamState);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies wrong-typed and nested ownership contradictions transaction-wide', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-owner-evidence-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'owner-evidence-session';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const skillPath = join(sessionDir, 'skill-active-state.json');
      const modePath = join(sessionDir, 'autopilot-state.json');
      const skillState = JSON.stringify({ active: true, skill: 'autopilot', owner_codex_session_id: 42, active_skills: [{ skill: 'autopilot', active: true, owner_codex_session_id: 'foreign-owner' }] }, null, 2);
      const modeState = JSON.stringify({ active: true, mode: 'autopilot', session_id: sessionId }, null, 2);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(skillPath, skillState);
      await writeFile(modePath, modeState);
      const result = runOmx(wd, 'cancel');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /contradictory owner_codex_session_id/);
      assert.equal(await readFile(skillPath, 'utf-8'), skillState);
      assert.equal(await readFile(modePath, 'utf-8'), modeState);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps root Team compatibility state read-only when current-session Ralplan owns cancellation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-cancel-cross-mode-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-ralplan-owner';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ralplanPath = join(sessionDir, 'ralplan-state.json');
      const teamPath = join(stateDir, 'team-state.json');
      const skillActivePath = join(stateDir, 'skill-active-state.json');
      const nativeStopPath = join(stateDir, 'native-stop-state.json');
      const ralplanState = JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'executing',
      }, null, 2);
      const rootTeamState = JSON.stringify({
        active: true,
        mode: 'team',
        current_phase: 'team-exec',
      }, null, 2);
      const rootSkillActiveState = JSON.stringify({
        version: 1,
        active: true,
        skill: 'team',
        phase: 'team-exec',
        active_skills: [{ skill: 'team', phase: 'team-exec', active: true }],
      }, null, 2);
      const rootNativeStopState = JSON.stringify({
        sessions: { [sessionId]: { last_signature: 'team-stop|pending' } },
      }, null, 2);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));

      await writeFile(ralplanPath, ralplanState);
      await writeFile(teamPath, rootTeamState);
      await writeFile(skillActivePath, rootSkillActiveState);
      await writeFile(nativeStopPath, rootNativeStopState);

      const cancelResult = runOmx(wd, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: ralplan/);
      assert.doesNotMatch(cancelResult.stdout, /Cancelled: team/);
      assert.equal(JSON.parse(await readFile(ralplanPath, 'utf-8')).active, false);
      assert.equal(await readFile(teamPath, 'utf-8'), rootTeamState);
      assert.equal(await readFile(skillActivePath, 'utf-8'), rootSkillActiveState);
      assert.equal(await readFile(nativeStopPath, 'utf-8'), rootNativeStopState);

      await writeFile(ralplanPath, ralplanState);
      const forceResult = runOmx(wd, 'cancel', '--force');
      assert.equal(forceResult.status, 0, forceResult.stderr || forceResult.stdout);
      assert.match(forceResult.stdout, /Cancelled: ralplan/);
      assert.doesNotMatch(forceResult.stdout, /Cancelled: team/);
      assert.equal(JSON.parse(await readFile(ralplanPath, 'utf-8')).active, false);
      assert.equal(await readFile(teamPath, 'utf-8'), rootTeamState);
      assert.equal(await readFile(skillActivePath, 'utf-8'), rootSkillActiveState);
      assert.equal(await readFile(nativeStopPath, 'utf-8'), rootNativeStopState);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('fails Ralplan preflight without mutating unproven session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralplan-preflight-scope-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-unproven-owner';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ralplanPath = join(sessionDir, 'ralplan-state.json');
      const ralplanState = JSON.stringify({
        active: true,
        mode: 'ralplan',
        current_phase: 'starting',
      }, null, 2);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));

      await writeFile(ralplanPath, ralplanState);

      const preflightResult = runOmx(wd, 'ralplan', 'preflight', '--json');
      assert.equal(preflightResult.status, 1, preflightResult.stderr || preflightResult.stdout);
      assert.deepEqual(JSON.parse(preflightResult.stdout), {
        ok: false,
        reason: 'unsupported_documented_leader_proof',
      });
      assert.equal(await readFile(ralplanPath, 'utf-8'), ralplanState);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('neutralizes exact-owner routing-only Ralplan before preflight denial', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralplan-preflight-owner-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-proven-owner';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ralplanPath = join(sessionDir, 'ralplan-state.json');
      const rootTeamPath = join(stateDir, 'team-state.json');
      const rootSkillPath = join(stateDir, 'skill-active-state.json');
      const rootStopPath = join(stateDir, 'native-stop-state.json');
      const rootTeam = JSON.stringify({ active: true, mode: 'team', current_phase: 'team-exec' }, null, 2);
      const rootSkill = JSON.stringify({ active: true, skill: 'team', phase: 'team-exec' }, null, 2);
      const rootStop = JSON.stringify({ sessions: { foreign: { pending: true } } }, null, 2);

      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(ralplanPath, JSON.stringify({
        active: true,
        mode: 'ralplan',
        session_id: sessionId,
        current_phase: 'planning',
      }, null, 2));
      await writeFile(rootTeamPath, rootTeam);
      await writeFile(rootSkillPath, rootSkill);
      await writeFile(rootStopPath, rootStop);


      const preflightResult = runOmxWithEnv(wd, { OMX_SESSION_ID: sessionId }, 'ralplan', 'preflight', '--json');
      assert.equal(preflightResult.status, 1, preflightResult.stderr || preflightResult.stdout);
      assert.deepEqual(JSON.parse(preflightResult.stdout), {
        ok: false,
        reason: 'unsupported_documented_leader_proof',
      });
      const state = JSON.parse(await readFile(ralplanPath, 'utf-8'));
      assert.equal(state.active, false);
      assert.equal(state.current_phase, 'cancelled');
      assert.equal(await readFile(rootTeamPath, 'utf-8'), rootTeam);
      assert.equal(await readFile(rootSkillPath, 'utf-8'), rootSkill);
      assert.equal(await readFile(rootStopPath, 'utf-8'), rootStop);
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
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
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

  it('does not cancel a foreign hook-visible run-dir from session-owned scope', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-foreign-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-foreign-runs-'));
    try {
      const ownerSessionId = 'sess-canonical-owner';
      const foreignSessionId = 'sess-foreign-run';
      const stateDir = join(wd, '.omx', 'state');
      const runDir = join(runsRoot, 'run-foreign-session');
      const runStateDir = join(runDir, '.omx', 'state');
      const foreignSessionDir = join(runStateDir, 'sessions', foreignSessionId);
      const foreignStatePath = join(foreignSessionDir, 'autopilot-state.json');
      const foreignState = JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2);
      await mkdir(join(stateDir, 'sessions', ownerSessionId), { recursive: true });
      await mkdir(foreignSessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: ownerSessionId }));
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: foreignSessionId }));
      await writeFile(foreignStatePath, foreignState);
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({
        source_cwd: wd,
        run_dir: runDir,
      })}\n`);

      const cancelResult = runOmxWithEnv(wd, { OMX_RUNS_DIR: runsRoot }, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /session\.json is present but unusable/);
      assert.doesNotMatch(cancelResult.stdout, /Cancelled: autopilot/);
      assert.equal(await readFile(foreignStatePath, 'utf-8'), foreignState);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('keeps stale registry-only run state read-only during root cancellation', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-stale-registry-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-stale-runs-'));
    try {
      const sessionId = 'sess-stale-registry';
      const runDir = join(runsRoot, 'run-stale-registry');
      const runStateDir = join(runDir, '.omx', 'state');
      const statePath = join(runStateDir, 'sessions', sessionId, 'autopilot-state.json');
      const state = JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'deep-interview' }, null, 2);
      await mkdir(dirname(statePath), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(statePath, state);
      await writeFile(join(runsRoot, 'registry.jsonl'), `${JSON.stringify({ source_cwd: wd, run_dir: runDir })}\n`);

      const cancelResult = runOmxWithEnv(wd, { OMX_RUNS_DIR: runsRoot }, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /No active modes to cancel\./);
      assert.equal(await readFile(statePath, 'utf-8'), state);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('rejects a live run record whose run directory escapes through a symlink', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-symlink-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-symlink-runs-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-symlink-outside-'));
    try {
      const sessionId = 'sess-symlink-escape';
      const tmuxSessionName = 'omx-symlink-run';
      const linkRunDir = join(runsRoot, 'linked-run');
      const outsideStateDir = join(outsideRoot, '.omx', 'state');
      const statePath = join(outsideStateDir, 'sessions', sessionId, 'autopilot-state.json');
      const state = JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'deep-interview' }, null, 2);
      const fakeBin = await createFakeTmuxBin(wd);
      await mkdir(dirname(statePath), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(outsideStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(statePath, state);
      await symlink(outsideRoot, linkRunDir, 'dir');
      await writeActiveRunRecord({
        runsRoot,
        contextKey: 'symlink-run-context',
        sourceCwd: wd,
        runDir: linkRunDir,
        sessionId,
        tmuxSessionName,
      });

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
      }, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /detached run authority is invalid/);
      assert.equal(await readFile(statePath, 'utf-8'), state);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('rejects nested session-directory and state-file symlink escapes', async () => {
    if (process.platform === 'win32') return;
    for (const kind of ['session-dir', 'state-file'] as const) {
      const wd = await mkdtemp(join(tmpdir(), `omx-cli-nested-${kind}-owner-`));
      const runsRoot = await mkdtemp(join(tmpdir(), `omx-cli-nested-${kind}-runs-`));
      const outsideRoot = await mkdtemp(join(tmpdir(), `omx-cli-nested-${kind}-outside-`));
      try {
        const sessionId = `sess-nested-${kind}`;
        const tmuxSessionName = `omx-nested-${kind}`;
        const runDir = join(runsRoot, `run-nested-${kind}`);
        const stateDir = join(runDir, '.omx', 'state');
        const sessionDir = join(stateDir, 'sessions', sessionId);
        const outsideStatePath = join(outsideRoot, 'autopilot-state.json');
        const state = JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'executing' }, null, 2);
        const fakeBin = await createFakeTmuxBin(wd);
        await mkdir(join(stateDir, 'sessions'), { recursive: true });
        await mkdir(join(wd, '.omx', 'state'), { recursive: true });
        await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
        await writeFile(outsideStatePath, state);
        if (kind === 'session-dir') {
          await symlink(outsideRoot, sessionDir, 'dir');
        } else {
          await mkdir(sessionDir, { recursive: true });
          await symlink(outsideStatePath, join(sessionDir, 'autopilot-state.json'));
        }
        await writeActiveRunRecord({ runsRoot, contextKey: `nested-${kind}`, sourceCwd: wd, runDir, sessionId, tmuxSessionName });

        const cancelResult = runOmxWithEnv(wd, {
          OMX_RUNS_DIR: runsRoot,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          FAKE_OMX_SESSION_ID: sessionId,
          FAKE_TMUX_SESSION_NAME: tmuxSessionName,
        }, 'cancel');
        assert.notEqual(cancelResult.status, 0);
        assert.match(cancelResult.stderr, /detached run (?:state )?authority is invalid/);
        assert.equal(await readFile(outsideStatePath, 'utf-8'), state);
      } finally {
        await rm(wd, { recursive: true, force: true });
        await rm(runsRoot, { recursive: true, force: true });
        await rm(outsideRoot, { recursive: true, force: true });
      }
    }
  });

  it('revalidates frozen tmux incarnation immediately before mutation', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-toctou-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-toctou-runs-'));
    try {
      const sessionId = 'sess-run-toctou';
      const tmuxSessionName = 'omx-run-toctou';
      const runDir = join(runsRoot, 'run-toctou');
      const stateDir = join(runDir, '.omx', 'state');
      const statePath = join(stateDir, 'sessions', sessionId, 'autopilot-state.json');
      const state = JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'executing' }, null, 2);
      const counterPath = join(wd, 'tmux-count');
      const fakeBin = await createFakeTmuxBin(wd);
      await mkdir(dirname(statePath), { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(statePath, state);
      await writeActiveRunRecord({ runsRoot, contextKey: 'toctou-run', sourceCwd: wd, runDir, sessionId, tmuxSessionName });

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
        FAKE_TMUX_COUNTER_FILE: counterPath,
        FAKE_TMUX_REPLACE_AFTER_FIRST: '1',
      }, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /detached run authority changed/);
      assert.equal(await readFile(statePath, 'utf-8'), state);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('denies the entire run transaction when one candidate state is malformed', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-malformed-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-malformed-runs-'));
    try {
      const sessionId = 'sess-run-malformed';
      const tmuxSessionName = 'omx-run-malformed';
      const runDir = join(runsRoot, 'run-malformed');
      const stateDir = join(runDir, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const validPath = join(sessionDir, 'ralplan-state.json');
      const malformedPath = join(sessionDir, 'autopilot-state.json');
      const validState = JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'executing' }, null, 2);
      const malformedState = '{"active":true';
      const fakeBin = await createFakeTmuxBin(wd);
      await mkdir(sessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(validPath, validState);
      await writeFile(malformedPath, malformedState);
      await writeActiveRunRecord({ runsRoot, contextKey: 'malformed-run', sourceCwd: wd, runDir, sessionId, tmuxSessionName });

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
      }, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /Refusing partial cancellation/);
      assert.equal(await readFile(validPath, 'utf-8'), validState);
      assert.equal(await readFile(malformedPath, 'utf-8'), malformedState);
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('uses the authorized run session for force native-stop cleanup', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-force-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-force-runs-'));
    try {
      const sessionId = 'sess-run-force';
      const tmuxSessionName = 'omx-run-force';
      const runDir = join(runsRoot, 'run-force');
      const stateDir = join(runDir, '.omx', 'state');
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const modePath = join(sessionDir, 'autopilot-state.json');
      const stopPath = join(sessionDir, 'native-stop-state.json');
      const fakeBin = await createFakeTmuxBin(wd);
      await mkdir(sessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(modePath, JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'executing' }));
      await writeFile(stopPath, JSON.stringify({ sessions: { [sessionId]: { pending: true }, foreign: { pending: true } } }, null, 2));
      await writeActiveRunRecord({ runsRoot, contextKey: 'force-run', sourceCwd: wd, runDir, sessionId, tmuxSessionName });

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
      }, 'cancel', '--force');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: autopilot/);
      const stopState = JSON.parse(await readFile(stopPath, 'utf-8'));
      assert.deepEqual(stopState.sessions, { foreign: { pending: true } });
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when multiple live run records match the same root', async () => {
    if (process.platform === 'win32') return;
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-duplicate-owner-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-duplicate-runs-'));
    try {
      const sessionId = 'sess-duplicate-live';
      const tmuxSessionName = 'omx-duplicate-run';
      const fakeBin = await createFakeTmuxBin(wd);
      const states: Array<{ path: string; content: string }> = [];
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      for (const [index, mode] of ['autopilot', 'ralplan'].entries()) {
        const runDir = join(runsRoot, `run-duplicate-${index}`);
        const runStateDir = join(runDir, '.omx', 'state');
        const statePath = join(runStateDir, 'sessions', sessionId, `${mode}-state.json`);
        const content = JSON.stringify({ active: true, mode, current_phase: 'executing' }, null, 2);
        await mkdir(dirname(statePath), { recursive: true });
        await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
        await writeFile(statePath, content);
        await writeActiveRunRecord({
          runsRoot,
          contextKey: `duplicate-run-context-${index}`,
          sourceCwd: wd,
          runDir,
          sessionId,
          tmuxSessionName,
        });
        states.push({ path: statePath, content });
      }

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
      }, 'cancel');
      assert.notEqual(cancelResult.status, 0);
      assert.match(cancelResult.stderr, /No active modes|multiple|authority/i);
      for (const state of states) {
        assert.equal(await readFile(state.path, 'utf-8'), state.content);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('cancels hook-visible run-dir session state when worktree state list-active is empty', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-worktree-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-cancel-runs-'));
    try {
      if (process.platform === 'win32') return;
      const sessionId = 'sess-run-dir-cancel';
      const tmuxSessionName = 'omx-live-run';
      const runDir = join(runsRoot, 'run-20260610121751-b6c4');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      const fakeBin = await createFakeTmuxBin(wd);
      const rootAutopilotPath = join(runStateDir, 'autopilot-state.json');
      const rootAutopilotState = JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'stale-root-copy',
      }, null, 2);

      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(wd, '.omx', 'state'), { recursive: true });
      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(rootAutopilotPath, rootAutopilotState);

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
      await writeActiveRunRecord({
        runsRoot,
        contextKey: 'live-run-context',
        sourceCwd: wd,
        runDir,
        sessionId,
        tmuxSessionName,
      });


      const listResult = runOmx(wd, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });

      const cancelResult = runOmxWithEnv(wd, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: tmuxSessionName,
      }, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: autopilot/);
      assert.doesNotMatch(cancelResult.stdout, /No active modes to cancel/);

      const autopilot = JSON.parse(await readFile(join(runSessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, 'cancelled');
      assert.ok(typeof autopilot.completed_at === 'string' && autopilot.completed_at.length > 0);
      assert.equal(await readFile(rootAutopilotPath, 'utf-8'), rootAutopilotState);

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

  it('finds hook-visible run-dir session state from an explicit worktree_cwd alias', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-source-'));
    const worktree = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-wt-'));
    const runsRoot = await mkdtemp(join(tmpdir(), 'omx-cli-run-dir-worktree-alias-runs-'));
    try {
      if (process.platform === 'win32') return;

      const sessionId = 'sess-run-dir-worktree-alias';
      const runDir = join(runsRoot, 'run-20260610121751-a11a');
      const runStateDir = join(runDir, '.omx', 'state');
      const runSessionDir = join(runStateDir, 'sessions', sessionId);
      const fakeBin = await createFakeTmuxBin(worktree);

      await mkdir(runSessionDir, { recursive: true });
      await mkdir(join(worktree, '.omx', 'state'), { recursive: true });

      await writeFile(join(runStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(runSessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'deep-interview',
      }, null, 2));
      await writeActiveRunRecord({
        runsRoot,
        contextKey: 'ctx-worktree-alias',
        sourceCwd: wd,
        worktreeCwd: worktree,
        runDir,
        sessionId,
        tmuxSessionName: 'omx-detached',
      });

      const statusResult = runOmxWithEnv(worktree, { OMX_RUNS_DIR: runsRoot }, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: ACTIVE \(phase: deep-interview\)/);

      const cancelResult = runOmxWithEnv(worktree, {
        OMX_RUNS_DIR: runsRoot,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        FAKE_OMX_SESSION_ID: sessionId,
        FAKE_TMUX_SESSION_NAME: 'omx-detached',
      }, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /Cancelled: autopilot/);

      const autopilot = JSON.parse(await readFile(join(runSessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it('reports stale current-autopilot in status when no authoritative active modes exist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-stale-current-autopilot-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sess-stale-autopilot' }, null, 2));
      const currentAutopilotPath = join(stateDir, 'current-autopilot.json');
      const currentAutopilot = {
        active: true,
        current_phase: 'complete',
        session_id: 'sess-stale-autopilot',
        tmux_pane_id: '%42',
      };
      await writeFile(currentAutopilotPath, JSON.stringify(currentAutopilot, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: STALE \(phase: complete\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);

      const listResult = runOmx(wd, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });
      assert.deepEqual(JSON.parse(await readFile(currentAutopilotPath, 'utf-8')), currentAutopilot);
      assert.equal(statusResult.stdout.trim(), 'autopilot: STALE (phase: complete)');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports stale current-autopilot alongside inactive authoritative modes only', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-stale-current-autopilot-with-inactive-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-stale-autopilot-inactive';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      const currentAutopilotPath = join(stateDir, 'current-autopilot.json');
      const currentAutopilot = {
        active: true,
        current_phase: 'complete',
        session_id: sessionId,
        tmux_pane_id: '%43',
      };
      await writeFile(currentAutopilotPath, JSON.stringify(currentAutopilot, null, 2));
      await writeFile(join(sessionDir, 'deep-interview-state.json'), JSON.stringify({
        active: false,
        mode: 'deep-interview',
        current_phase: 'cleared',
      }, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /deep-interview: inactive \(phase: cleared\)/);
      assert.match(statusResult.stdout, /autopilot: STALE \(phase: complete\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
      assert.deepEqual(JSON.parse(await readFile(currentAutopilotPath, 'utf-8')), currentAutopilot);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('prefers authoritative active autopilot over stale current-autopilot in status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-active-autopilot-precedence-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-active-autopilot';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
      await writeFile(join(stateDir, 'current-autopilot.json'), JSON.stringify({
        active: true,
        current_phase: 'complete',
        session_id: 'stale-session',
        tmux_pane_id: '%99',
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ralplan',
      }, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /autopilot: ACTIVE \(phase: ralplan\)/);
      assert.doesNotMatch(statusResult.stdout, /STALE/);
      assert.doesNotMatch(statusResult.stdout, /phase: complete/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores unreportable current-autopilot in status', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-unreportable-current-autopilot-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'current-autopilot.json'), JSON.stringify({ active: true }, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /No active modes\./);
      assert.doesNotMatch(statusResult.stdout, /STALE/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('reports durable failed Ultragoal artifacts without advertising a cancellable active mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-failed-ultragoal-'));
    try {
      const ultragoalDir = join(wd, '.omx', 'ultragoal');
      await mkdir(ultragoalDir, { recursive: true });
      await writeFile(join(ultragoalDir, 'goals.json'), JSON.stringify({
        version: 1,
        activeGoalId: 'G001-failed',
        goals: [
          {
            id: 'G001-failed',
            title: 'Failed story',
            objective: 'Preserve failed evidence for retry.',
            status: 'failed',
          },
        ],
      }, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /ultragoal: FAILED \(phase: failed\)/);
      assert.doesNotMatch(statusResult.stdout, /ultragoal: ACTIVE \(phase: failed\)/);

      const cancelResult = runOmx(wd, 'cancel');
      assert.equal(cancelResult.status, 0, cancelResult.stderr || cancelResult.stdout);
      assert.match(cancelResult.stdout, /No active modes to cancel\./);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves active Ultragoal mode status when durable failed artifacts coexist', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-status-active-ultragoal-failed-artifact-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-active-ultragoal-failed-artifact';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      const ultragoalDir = join(wd, '.omx', 'ultragoal');
      await mkdir(sessionDir, { recursive: true });
      await mkdir(ultragoalDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(join(sessionDir, 'ultragoal-state.json'), JSON.stringify({
        active: true,
        mode: 'ultragoal',
        current_phase: 'executing',
        session_id: sessionId,
      }, null, 2));
      await writeFile(join(ultragoalDir, 'goals.json'), JSON.stringify({
        version: 1,
        activeGoalId: 'G001-failed',
        goals: [
          {
            id: 'G001-failed',
            title: 'Failed story',
            objective: 'Preserve failed evidence for retry.',
            status: 'failed',
          },
        ],
      }, null, 2));

      const statusResult = runOmx(wd, 'status');
      assert.equal(statusResult.status, 0, statusResult.stderr || statusResult.stdout);
      assert.match(statusResult.stdout, /ultragoal: ACTIVE \(phase: executing\)/);
      assert.doesNotMatch(statusResult.stdout, /ultragoal: FAILED \(phase: failed\)/);
      assert.doesNotMatch(statusResult.stdout, /No active modes\./);
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
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));

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

  it('cancels linked ecomode before Ralph', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-ralph-ecomode-link-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-ecomode-link';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({ active: true, mode: 'ralph', session_id: sessionId, current_phase: 'executing', linked_ecomode: true }));
      await writeFile(join(sessionDir, 'ecomode-state.json'), JSON.stringify({ active: true, mode: 'ecomode', session_id: sessionId, current_phase: 'executing' }));
      const result = runOmx(wd, 'cancel');
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /Cancelled: ecomode/);
      assert.match(result.stdout, /Cancelled: ralph/);
      assert.equal(JSON.parse(await readFile(join(sessionDir, 'ecomode-state.json'), 'utf-8')).active, false);
      assert.equal(JSON.parse(await readFile(join(sessionDir, 'ralph-state.json'), 'utf-8')).active, false);
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
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: 'sessA', cwd: wd, state_root: stateDir }));

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
  it('clears current-session autopilot and skill mirrors even when canonical root is inactive', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-cli-clear-stale-autopilot-mirror-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = 'sess-stale-autopilot-mirror';
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId, cwd: wd, state_root: stateDir }, null, 2));
      await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify({
        active: false,
        mode: 'autopilot',
        current_phase: 'cancelled',
      }, null, 2));
      await writeFile(join(stateDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: false,
        skill: '',
        phase: 'cancelled',
        active_skills: [],
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        active: true,
        mode: 'autopilot',
        current_phase: 'ultragoal',
      }, null, 2));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        version: 1,
        active: true,
        skill: 'autopilot',
        phase: 'ultragoal',
        session_id: sessionId,
        active_skills: [{ skill: 'autopilot', phase: 'ultragoal', active: true, session_id: sessionId }],
      }, null, 2));
      await writeFile(join(sessionDir, 'native-stop-state.json'), JSON.stringify({
        sessions: { [sessionId]: { last_signature: 'autopilot-stop|stale' } },
      }, null, 2));

      const clearAutopilot = runOmx(wd, 'state', 'clear', '--input', `{"mode":"autopilot","session_id":"${sessionId}"}`, '--json');
      assert.equal(clearAutopilot.status, 0, clearAutopilot.stderr || clearAutopilot.stdout);
      const clearSkill = runOmx(wd, 'state', 'clear', '--input', `{"mode":"skill-active","session_id":"${sessionId}"}`, '--json');
      assert.equal(clearSkill.status, 0, clearSkill.stderr || clearSkill.stdout);
      const cancelForce = runOmx(wd, 'cancel', '--force');
      assert.equal(cancelForce.status, 0, cancelForce.stderr || cancelForce.stdout);

      const autopilot = JSON.parse(await readFile(join(sessionDir, 'autopilot-state.json'), 'utf-8'));
      assert.equal(autopilot.active, false);
      assert.equal(autopilot.current_phase, 'cleared');
      assert.equal(existsSync(join(sessionDir, 'skill-active-state.json')), false);
      const nativeStop = JSON.parse(await readFile(join(sessionDir, 'native-stop-state.json'), 'utf-8'));
      assert.deepEqual(nativeStop.sessions, {});
      const listResult = runOmx(wd, 'state', 'list-active', '--json');
      assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
      assert.deepEqual(JSON.parse(listResult.stdout), { active_modes: [] });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
