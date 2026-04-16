import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  buildGitBranchLabel,
  readGitBranch,
  readAllState,
  readHudNotifyState,
  readRalphState,
  readRalplanState,
  readDeepInterviewState,
  readAutoresearchState,
  readUltraqaState,
} from '../state.js';

function gitRunnerFromMap(map: Record<string, string | Error>) {
  return (_cwd: string, args: string[]) => {
    const command = 'git ' + args.join(' ');
    const value = map[command];
    if (value instanceof Error) return null;
    if (value === undefined) throw new Error('Unexpected command: ' + command);
    return value;
  };
}

async function withWindowsPlatform(run: () => Promise<void> | void): Promise<void> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await run();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  }
}

async function withTempRepo(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeModeState(cwd: string, mode: string, state: unknown): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, mode + '-state.json'), JSON.stringify(state));
}

async function createWorktreePointerFixture(cwd: string, options: { withOrigin?: boolean } = {}): Promise<void> {
  const gitDir = join(cwd, '.git-admin', 'worktrees', 'feature');
  const commonDir = join(cwd, '.git-admin');
  await mkdir(commonDir, { recursive: true });
  await mkdir(join(gitDir, 'logs', 'refs', 'heads'), { recursive: true });
  await writeFile(join(cwd, '.git'), `gitdir: ${relative(cwd, gitDir)}\n`);
  await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/worktree-branch\n');
  await writeFile(join(gitDir, 'commondir'), '../..\n');
  if (options.withOrigin !== false) {
    await writeFile(join(commonDir, 'config'), [
      '[remote "origin"]',
      '  url = git@github.com:acme/worktree-repo.git',
      '',
    ].join('\n'));
  }
}

describe('readGitBranch', () => {
  it('returns null in a non-git directory without printing git fatal noise', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-state-'));
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);

    const patchedWrite = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      stderrChunks.push(text);
      if (typeof encodingOrCallback === 'function') encodingOrCallback(null);
      if (typeof callback === 'function') callback(null);
      return true;
    }) as typeof process.stderr.write;

    process.stderr.write = patchedWrite;

    try {
      assert.equal(readGitBranch(cwd), null);
    } finally {
      process.stderr.write = originalWrite;
      await rm(cwd, { recursive: true, force: true });
    }

    assert.equal(stderrChunks.join('').includes('not a git repository'), false);
  });

  it('uses the Windows fast path for worktree .git file pointers', async () => {
    await withTempRepo('omx-hud-worktree-branch-', async (cwd) => {
      await createWorktreePointerFixture(cwd);
      await withWindowsPlatform(() => {
        assert.equal(readGitBranch(cwd), 'worktree-branch');
      });
    });
  });
});

describe('buildGitBranchLabel', () => {
  it('keeps the branch when origin lookup fails', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'fix/hud-regression',
      'git remote get-url origin': new Error('missing origin'),
      'git remote': '',
      'git rev-parse --show-toplevel': new Error('no top-level'),
    });

    assert.equal(buildGitBranchLabel('/repo', undefined, gitRunner), 'fix/hud-regression');
  });

  it('prefers configured remoteName over origin', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
      'git remote get-url upstream': 'git@github.com:acme/upstream-repo.git',
      'git remote get-url origin': 'git@github.com:acme/origin-repo.git',
    });

    assert.equal(buildGitBranchLabel('/repo', {
      preset: 'focused',
      git: { display: 'repo-branch', remoteName: 'upstream' },
    }, gitRunner), 'upstream-repo/feature/test');
  });

  it('prefers origin over first-remote fallback', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
      'git remote get-url origin': 'https://github.com/acme/origin-repo.git',
    });

    assert.equal(buildGitBranchLabel('/repo', undefined, gitRunner), 'origin-repo/feature/test');
  });

  it('falls back to the first resolvable remote when origin is absent', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
      'git remote get-url origin': new Error('missing origin'),
      'git remote': 'upstream\nbackup',
      'git remote get-url upstream': 'https://github.com/acme/upstream-repo.git',
    });

    assert.equal(buildGitBranchLabel('/repo', undefined, gitRunner), 'upstream-repo/feature/test');
  });

  it('falls back to repo basename when no remote resolves', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
      'git remote get-url origin': new Error('missing origin'),
      'git remote': 'upstream',
      'git remote get-url upstream': new Error('missing upstream'),
      'git rev-parse --show-toplevel': '/tmp/project-repo',
    });

    assert.equal(buildGitBranchLabel('/repo', undefined, gitRunner), 'project-repo/feature/test');
  });

  it('omits repo prefix in branch display mode', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
    });

    assert.equal(buildGitBranchLabel('/repo', {
      preset: 'focused',
      git: { display: 'branch' },
    }, gitRunner), 'feature/test');
  });

  it('uses explicit repoLabel before any git remote lookup', () => {
    const gitRunner = gitRunnerFromMap({
      'git rev-parse --abbrev-ref HEAD': 'feature/test',
    });

    assert.equal(buildGitBranchLabel('/repo', {
      preset: 'focused',
      git: { display: 'repo-branch', repoLabel: 'manual' },
    }, gitRunner), 'manual/feature/test');
  });

  it('resolves remote config from the git common dir for worktree pointers on Windows', async () => {
    await withTempRepo('omx-hud-worktree-remote-', async (cwd) => {
      await createWorktreePointerFixture(cwd);
      await withWindowsPlatform(() => {
        assert.equal(buildGitBranchLabel(cwd), 'worktree-repo/worktree-branch');
      });
    });
  });

  it('keeps the worktree root for --show-toplevel fallback on Windows worktrees', async () => {
    await withTempRepo('omx-hud-worktree-top-', async (cwd) => {
      await createWorktreePointerFixture(cwd, { withOrigin: false });
      await withWindowsPlatform(() => {
        assert.equal(buildGitBranchLabel(cwd), `${basename(cwd)}/worktree-branch`);
      });
    });
  });
});

describe('readRalphState scope precedence', () => {
  it('prefers session-scoped Ralph state when session.json points to a session', async () => {
    await withTempRepo('omx-hud-ralph-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-hud';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 9, max_iterations: 10 }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 2, max_iterations: 10 }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 2);
    });
  });

  it('does not fall back to root Ralph state when current session has no Ralph state file', async () => {
    await withTempRepo('omx-hud-ralph-fallback-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-fallback';
      await mkdir(join(rootStateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 4, max_iterations: 10 }));

      const state = await readRalphState(cwd);
      assert.equal(state, null);
    });
  });

  it('ignores session.json authority when it points at another worktree cwd', async () => {
    await withTempRepo('omx-hud-ralph-cwd-mismatch-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-mismatch';
      await mkdir(join(rootStateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        cwd: join(cwd, '..', 'other-worktree'),
      }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 4, max_iterations: 10 }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 4);
    });
  });

  it('treats session-scoped inactive Ralph state as authoritative over active root fallback', async () => {
    await withTempRepo('omx-hud-ralph-authority-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-authority';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({ active: true, iteration: 8, max_iterations: 10 }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({ active: false, current_phase: 'cancelled' }));

      const state = await readRalphState(cwd);
      assert.equal(state, null);
    });
  });

  it('does not treat another session-scoped Ralph state as active for the current session', async () => {
    await withTempRepo('omx-hud-ralph-other-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const currentSessionId = 'sess-current';
      const otherSessionId = 'sess-other';
      await mkdir(join(rootStateDir, 'sessions', currentSessionId), { recursive: true });
      await mkdir(join(rootStateDir, 'sessions', otherSessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: currentSessionId }));
      await writeFile(join(rootStateDir, 'sessions', otherSessionId, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 7,
        max_iterations: 10,
      }));

      const state = await readRalphState(cwd);
      assert.equal(state, null);
    });
  });
});

describe('additional HUD mode state readers', () => {
  it('reads active ralplan state', async () => {
    await withTempRepo('omx-hud-ralplan-', async (cwd) => {
      await writeModeState(cwd, 'ralplan', { active: true, current_phase: 'review', iteration: 2, planning_complete: false });
      const state = await readRalplanState(cwd);
      assert.deepEqual(state, { active: true, current_phase: 'review', iteration: 2, planning_complete: false });
    });
  });

  it('returns null for inactive ralplan state', async () => {
    await withTempRepo('omx-hud-ralplan-inactive-', async (cwd) => {
      await writeModeState(cwd, 'ralplan', { active: false, current_phase: 'complete' });
      assert.equal(await readRalplanState(cwd), null);
    });
  });

  it('prefers session-scoped ralplan state over root fallback', async () => {
    await withTempRepo('omx-hud-ralplan-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-ralplan-authority';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralplan-state.json'), JSON.stringify({ active: true, current_phase: 'draft', iteration: 9 }));
      await writeFile(join(sessionStateDir, 'ralplan-state.json'), JSON.stringify({ active: true, current_phase: 'critic-review', iteration: 2, planning_complete: false }));

      const state = await readRalplanState(cwd);
      assert.deepEqual(state, { active: true, current_phase: 'critic-review', iteration: 2, planning_complete: false });
    });
  });

  it('reads deep-interview input lock from nested state payload', async () => {
    await withTempRepo('omx-hud-interview-', async (cwd) => {
      await writeModeState(cwd, 'deep-interview', { active: true, current_phase: 'intent-first', input_lock: { active: true } });
      const state = await readDeepInterviewState(cwd);
      assert.deepEqual(state, { active: true, current_phase: 'intent-first', input_lock: { active: true }, input_lock_active: true });
    });
  });

  it('reads active autoresearch state', async () => {
    await withTempRepo('omx-hud-autoresearch-', async (cwd) => {
      await writeModeState(cwd, 'autoresearch', { active: true, current_phase: 'running' });
      assert.deepEqual(await readAutoresearchState(cwd), { active: true, current_phase: 'running' });
    });
  });

  it('reads active ultraqa state', async () => {
    await withTempRepo('omx-hud-ultraqa-', async (cwd) => {
      await writeModeState(cwd, 'ultraqa', { active: true, current_phase: 'diagnose' });
      assert.deepEqual(await readUltraqaState(cwd), { active: true, current_phase: 'diagnose' });
    });
  });

  it('reads hud notify state from the current session scope', async () => {
    await withTempRepo('omx-hud-notify-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-hud-notify';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'root', turn_count: 99 }));
      await writeFile(join(sessionStateDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'session', turn_count: 2 }));

      const state = await readHudNotifyState(cwd);
      assert.deepEqual(state, { last_turn_at: 'session', turn_count: 2 });
    });
  });

  it('keeps hud notify pinned to the canonical OMX session when session metadata also carries a native session id', async () => {
    await withTempRepo('omx-hud-notify-native-meta-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const canonicalSessionId = 'omx-canonical-session';
      const nativeSessionId = 'codex-native-session';
      const canonicalDir = join(rootStateDir, 'sessions', canonicalSessionId);
      const nativeDir = join(rootStateDir, 'sessions', nativeSessionId);
      await mkdir(canonicalDir, { recursive: true });
      await mkdir(nativeDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({
        session_id: canonicalSessionId,
        native_session_id: nativeSessionId,
      }));
      await writeFile(join(canonicalDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'canonical', turn_count: 3 }));
      await writeFile(join(nativeDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'native', turn_count: 99 }));

      const state = await readHudNotifyState(cwd);
      assert.deepEqual(state, { last_turn_at: 'canonical', turn_count: 3 });
    });
  });

  it('prefers OMX_SESSION_ID over stale session.json for hud notify state', async () => {
    await withTempRepo('omx-hud-notify-env-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const activeSessionId = 'sess-active';
      const staleSessionId = 'sess-stale';
      const activeDir = join(rootStateDir, 'sessions', activeSessionId);
      const staleDir = join(rootStateDir, 'sessions', staleSessionId);
      await mkdir(activeDir, { recursive: true });
      await mkdir(staleDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({
        session_id: staleSessionId,
        cwd: join(cwd, '..', 'other-worktree'),
      }));
      await writeFile(join(rootStateDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'root', turn_count: 99 }));
      await writeFile(join(activeDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'active', turn_count: 5 }));
      await writeFile(join(staleDir, 'hud-state.json'), JSON.stringify({ last_turn_at: 'stale', turn_count: 1 }));

      const previousSessionId = process.env.OMX_SESSION_ID;
      process.env.OMX_SESSION_ID = activeSessionId;
      try {
        const state = await readHudNotifyState(cwd);
        assert.deepEqual(state, { last_turn_at: 'active', turn_count: 5 });
      } finally {
        if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
        else delete process.env.OMX_SESSION_ID;
      }
    });
  });
});

describe('readAllState canonical skill precedence', () => {
  it('does not surface stale session mode detail when canonical skill state is inactive in legacy shape', async () => {
    await withTempRepo('omx-hud-canonical-inactive-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-canonical-off';
      const sessionDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: false,
        skill: 'ralph',
        phase: 'completing',
        session_id: sessionId,
      }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 5,
        current_phase: 'executing',
      }));

      const state = await readAllState(cwd);
      assert.equal(state.ralph, null);
    });
  });

  it('uses canonical session skill state to suppress stale root fallback while preserving session detail', async () => {
    await withTempRepo('omx-hud-canonical-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-current';
      const sessionDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 9,
        max_iterations: 10,
        current_phase: 'stale-root',
      }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'team',
        phase: 'running',
        session_id: sessionId,
        active_skills: [{ skill: 'team', phase: 'running', active: true, session_id: sessionId }],
      }));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'alpha',
      }));

      const state = await readAllState(cwd);
      assert.equal(state.ralph, null);
      assert.deepEqual(state.team, { active: true, team_name: 'alpha', current_phase: 'running' });
    });
  });

  it('prefers canonical team phase over stale team detail current_phase', async () => {
    await withTempRepo('omx-hud-canonical-team-phase-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-team-phase';
      const sessionDir = join(rootStateDir, 'sessions', sessionId);
      const teamDir = join(rootStateDir, 'team', 'alpha');
      await mkdir(sessionDir, { recursive: true });
      await mkdir(teamDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'team',
        phase: 'starting',
        session_id: sessionId,
        active_skills: [{ skill: 'team', phase: 'starting', active: true, session_id: sessionId }],
      }));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'alpha',
        current_phase: 'starting',
      }));
      await writeFile(join(teamDir, 'phase.json'), JSON.stringify({
        current_phase: 'team-exec',
        max_fix_attempts: 3,
        current_fix_attempt: 0,
        transitions: [],
        updated_at: new Date().toISOString(),
      }));

      const state = await readAllState(cwd);
      assert.deepEqual(state.team, { active: true, team_name: 'alpha', current_phase: 'team-exec' });
    });
  });

  it('surfaces approved combined workflow state from canonical multi-skill data', async () => {
    await withTempRepo('omx-hud-canonical-combined-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-combined';
      const sessionDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'team',
        phase: 'running',
        session_id: sessionId,
        active_skills: [
          { skill: 'team', phase: 'running', active: true, session_id: sessionId },
          { skill: 'ralph', phase: 'executing', active: true, session_id: sessionId },
        ],
      }));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'alpha',
      }));
      await writeFile(join(sessionDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 5,
      }));

      const state = await readAllState(cwd);
      assert.deepEqual(state.team, { active: true, team_name: 'alpha', current_phase: 'running' });
      assert.deepEqual(state.ralph, {
        active: true,
        iteration: 2,
        max_iterations: 5,
        current_phase: 'executing',
      });
    });
  });

  it('suppresses stale autoresearch detail when canonical session skill state excludes it', async () => {
    await withTempRepo('omx-hud-canonical-autoresearch-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-autoresearch-off';
      const sessionDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'autoresearch-state.json'), JSON.stringify({
        active: true,
        current_phase: 'running',
      }));
      await writeFile(join(sessionDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'team',
        phase: 'running',
        session_id: sessionId,
        active_skills: [{ skill: 'team', phase: 'running', active: true, session_id: sessionId }],
      }));
      await writeFile(join(sessionDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'gamma',
      }));

      const state = await readAllState(cwd);
      assert.equal(state.autoresearch, null);
      assert.deepEqual(state.team, { active: true, team_name: 'gamma', current_phase: 'running' });
    });
  });

  it('binds canonical HUD state to OMX_SESSION_ID instead of stale session.json/root fallback', async () => {
    await withTempRepo('omx-hud-canonical-env-session-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const activeSessionId = 'sess-active';
      const staleSessionId = 'sess-stale';
      const activeDir = join(rootStateDir, 'sessions', activeSessionId);
      await mkdir(activeDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({
        session_id: staleSessionId,
        cwd: join(cwd, '..', 'other-worktree'),
      }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 9,
        max_iterations: 10,
        current_phase: 'stale-root',
      }));
      await writeFile(join(activeDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'team',
        phase: 'running',
        session_id: activeSessionId,
        active_skills: [{ skill: 'team', phase: 'running', active: true, session_id: activeSessionId }],
      }));
      await writeFile(join(activeDir, 'team-state.json'), JSON.stringify({
        active: true,
        team_name: 'env-authority',
      }));

      const previousSessionId = process.env.OMX_SESSION_ID;
      process.env.OMX_SESSION_ID = activeSessionId;
      try {
        const state = await readAllState(cwd);
        assert.equal(state.session, null);
        assert.equal(state.ralph, null);
        assert.deepEqual(state.team, {
          active: true,
          team_name: 'env-authority',
          current_phase: 'running',
        });
        assert.equal(state.hudNotify, null);
      } finally {
        if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
        else delete process.env.OMX_SESSION_ID;
      }
    });
  });

  it('preserves root fallback when no usable session or OMX_SESSION_ID exists', async () => {
    await withTempRepo('omx-hud-canonical-root-fallback-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      await mkdir(rootStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({
        session_id: 'sess-stale',
        cwd: join(cwd, '..', 'other-worktree'),
      }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 4,
        max_iterations: 10,
        current_phase: 'executing',
      }));
      await writeFile(join(rootStateDir, 'skill-active-state.json'), JSON.stringify({
        active: true,
        skill: 'ralph',
        phase: 'executing',
        active_skills: [{ skill: 'ralph', phase: 'executing', active: true }],
      }));

      const previousSessionId = process.env.OMX_SESSION_ID;
      delete process.env.OMX_SESSION_ID;
      try {
        const state = await readAllState(cwd);
        assert.deepEqual(state.ralph, {
          active: true,
          iteration: 4,
          max_iterations: 10,
          current_phase: 'executing',
        });
      } finally {
        if (typeof previousSessionId === 'string') process.env.OMX_SESSION_ID = previousSessionId;
      }
    });
  });
});
