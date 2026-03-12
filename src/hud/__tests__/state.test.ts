import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitBranchLabel, readGitBranch, readRalphState } from '../state.js';

function gitRunnerFromMap(map: Record<string, string | Error>) {
  return (_cwd: string, args: string[]) => {
    const command = `git ${args.join(' ')}`;
    const value = map[command];
    if (value instanceof Error) return null;
    if (value === undefined) throw new Error(`Unexpected command: ${command}`);
    return value;
  };
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
});

describe('readRalphState scope precedence', () => {
  it('prefers session-scoped Ralph state when session.json points to a session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-session-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-hud';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 9,
        max_iterations: 10,
      }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 2,
        max_iterations: 10,
      }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('falls back to root Ralph state when current session has no Ralph state file', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-fallback-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-fallback';
      await mkdir(join(rootStateDir, 'sessions', sessionId), { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 4,
        max_iterations: 10,
      }));

      const state = await readRalphState(cwd);
      assert.ok(state);
      assert.equal(state?.iteration, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('treats session-scoped inactive Ralph state as authoritative over active root fallback', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-hud-ralph-authority-'));
    try {
      const rootStateDir = join(cwd, '.omx', 'state');
      const sessionId = 'sess-authority';
      const sessionStateDir = join(rootStateDir, 'sessions', sessionId);
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(rootStateDir, 'session.json'), JSON.stringify({ session_id: sessionId }));
      await writeFile(join(rootStateDir, 'ralph-state.json'), JSON.stringify({
        active: true,
        iteration: 8,
        max_iterations: 10,
      }));
      await writeFile(join(sessionStateDir, 'ralph-state.json'), JSON.stringify({
        active: false,
        current_phase: 'cancelled',
      }));

      const state = await readRalphState(cwd);
      assert.equal(state, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
