import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import {
  buildGitBranchLabel,
  readGitBranch,
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

  it('falls back to root Ralph state when current session has no Ralph state file', async () => {
    await withTempRepo('omx-hud-ralph-fallback-', async (cwd) => {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-fallback';
      await mkdir(join(rootStateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
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
});
