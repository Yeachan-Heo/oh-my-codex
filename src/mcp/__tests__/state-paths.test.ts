import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve as resolvePath } from 'path';
import {
  getAllScopedStateDirs,
  getAllScopedStatePaths,
  getBaseStateDir,
  getAllSessionScopedStateDirs,
  getAllSessionScopedStatePaths,
  resolveWorkingDirectoryForState,
  getStateDir,
  getStatePath,
  validateStateModeSegment,
  validateSessionId,
} from '../state-paths.js';

describe('validateSessionId', () => {
  it('accepts undefined and valid ids', () => {
    assert.equal(validateSessionId(undefined), undefined);
    assert.equal(validateSessionId('abc_123-XYZ'), 'abc_123-XYZ');
  });

  it('rejects invalid ids', () => {
    assert.throws(() => validateSessionId(''), /session_id must match/);
    assert.throws(() => validateSessionId('bad/id'), /session_id must match/);
    assert.throws(() => validateSessionId(123), /session_id must be a string/);
  });
});

describe('validateStateModeSegment', () => {
  it('accepts safe mode names', () => {
    assert.equal(validateStateModeSegment('ralph'), 'ralph');
    assert.equal(validateStateModeSegment('ultraqa'), 'ultraqa');
  });

  it('rejects traversal and path separators', () => {
    assert.throws(() => validateStateModeSegment('../evil'), /must not contain "\.\."/);
    assert.throws(() => validateStateModeSegment('foo/bar'), /path separators/);
    assert.throws(() => validateStateModeSegment('foo\\bar'), /path separators/);
  });
});

describe('state paths', () => {
  it('resolveWorkingDirectoryForState defaults to process.cwd()', () => {
    assert.equal(resolveWorkingDirectoryForState(undefined), process.cwd());
    assert.equal(resolveWorkingDirectoryForState(''), process.cwd());
    assert.equal(resolveWorkingDirectoryForState('   '), process.cwd());
  });

  it('resolveWorkingDirectoryForState normalizes Windows path on WSL/Linux when mount exists', () => {
    const raw = 'D:\\SIYUAN\\external\\repo';
    if (process.platform === 'win32') {
      assert.equal(resolveWorkingDirectoryForState(raw), resolvePath(raw));
      return;
    }
    if (existsSync('/mnt/d')) {
      assert.equal(resolveWorkingDirectoryForState(raw), '/mnt/d/SIYUAN/external/repo');
    } else {
      assert.throws(() => resolveWorkingDirectoryForState(raw), /not available on this host/);
    }
  });

  it('resolveWorkingDirectoryForState returns absolute normalized paths', () => {
    assert.equal(resolveWorkingDirectoryForState('.'), process.cwd());
  });

  it('rejects NUL bytes in workingDirectory', () => {
    assert.throws(() => resolveWorkingDirectoryForState('bad\0path'), /NUL byte/);
  });

  it('enforces OMX_MCP_WORKDIR_ROOTS allowlist when configured', async () => {
    const allowedRoot = await mkdtemp(join(tmpdir(), 'omx-allowed-root-'));
    const disallowedRoot = await mkdtemp(join(tmpdir(), 'omx-disallowed-root-'));
    const prev = process.env.OMX_MCP_WORKDIR_ROOTS;
    process.env.OMX_MCP_WORKDIR_ROOTS = allowedRoot;
    try {
      assert.equal(
        resolveWorkingDirectoryForState(join(allowedRoot, 'nested')),
        join(allowedRoot, 'nested'),
      );
      assert.throws(
        () => resolveWorkingDirectoryForState(disallowedRoot),
        /outside allowed roots \(OMX_MCP_WORKDIR_ROOTS\)/,
      );
    } finally {
      if (typeof prev === 'string') process.env.OMX_MCP_WORKDIR_ROOTS = prev;
      else delete process.env.OMX_MCP_WORKDIR_ROOTS;
      await rm(allowedRoot, { recursive: true, force: true });
      await rm(disallowedRoot, { recursive: true, force: true });
    }
  });

  it('builds global state paths', () => {
    const base = getBaseStateDir('/repo');
    assert.equal(base, '/repo/.omx/state');
    assert.equal(getStateDir('/repo'), '/repo/.omx/state');
    assert.equal(getStatePath('team', '/repo'), '/repo/.omx/state/team-state.json');
  });

  it('builds session state paths', () => {
    assert.equal(getStateDir('/repo', 'sess1'), '/repo/.omx/state/sessions/sess1');
    assert.equal(
      getStatePath('ralph', '/repo', 'sess1'),
      '/repo/.omx/state/sessions/sess1/ralph-state.json'
    );
  });

  it('throws when mode contains traversal tokens', () => {
    assert.throws(() => getStatePath('../../etc/passwd', '/repo'), /must not contain "\.\."/);
  });

  it('enumerates global-only path', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-paths-'));
    try {
      const paths = await getAllScopedStatePaths('team', wd);
      assert.deepEqual(paths, [getStatePath('team', wd)]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('enumerates session-scoped paths', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-paths-'));
    try {
      const sessionsRoot = join(getBaseStateDir(wd), 'sessions');
      await mkdir(join(sessionsRoot, 'sess1'), { recursive: true });
      await mkdir(join(sessionsRoot, 'sess_2'), { recursive: true });

      const paths = await getAllSessionScopedStatePaths('team', wd);
      assert.deepEqual(paths.sort(), [
        getStatePath('team', wd, 'sess1'),
        getStatePath('team', wd, 'sess_2'),
      ].sort());
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('enumerates state directories across all scopes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-paths-'));
    try {
      const sessionsRoot = join(getBaseStateDir(wd), 'sessions');
      await mkdir(join(sessionsRoot, 'sess1'), { recursive: true });
      await mkdir(join(sessionsRoot, 'bad.name'), { recursive: true });

      const sessionDirs = await getAllSessionScopedStateDirs(wd);
      assert.deepEqual(sessionDirs, [join(sessionsRoot, 'sess1')]);

      const dirs = await getAllScopedStateDirs(wd);
      assert.deepEqual(dirs, [getBaseStateDir(wd), join(sessionsRoot, 'sess1')]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('enumerates global and session-scoped paths together', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-paths-'));
    try {
      const sessionsRoot = join(getBaseStateDir(wd), 'sessions');
      await mkdir(join(sessionsRoot, 'sess1'), { recursive: true });
      await mkdir(join(sessionsRoot, 'sess2'), { recursive: true });

      const paths = await getAllScopedStatePaths('ralph', wd);
      assert.deepEqual(paths.sort(), [
        getStatePath('ralph', wd),
        getStatePath('ralph', wd, 'sess1'),
        getStatePath('ralph', wd, 'sess2'),
      ].sort());
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('ignores invalid session directory names', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-paths-'));
    try {
      const sessionsRoot = join(getBaseStateDir(wd), 'sessions');
      await mkdir(join(sessionsRoot, 'valid-session'), { recursive: true });
      await mkdir(join(sessionsRoot, 'bad.name'), { recursive: true });
      await mkdir(join(sessionsRoot, 'bad name'), { recursive: true });

      const paths = await getAllSessionScopedStatePaths('team', wd);
      assert.deepEqual(paths, [getStatePath('team', wd, 'valid-session')]);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
