import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ScopeFile, ScopeFileSource } from '../contract.js';

interface ParsedNameStatus {
  change: string;
  path: string;
  previous_path?: string;
  source: ScopeFileSource;
}

interface ParsedNumStat {
  path: string;
  previous_path?: string;
  binary: boolean;
  additions: number;
  deletions: number;
}

interface ScopeApi {
  normalizeExplicitPaths(repositoryRoot: string, paths: readonly string[]): string[];
  pathMatchesExplicitScope(path: string, explicitPaths: readonly string[]): boolean;
  parseNameStatus(output: Buffer | string, source: ScopeFileSource): ParsedNameStatus[];
  parseNumStat(output: Buffer | string): ParsedNumStat[];
  classifyGitMode(mode: string | undefined): 'REGULAR' | 'SYMLINK' | 'GITLINK';
  filterManifestFiles(files: readonly ScopeFile[], explicitPaths: readonly string[]): ScopeFile[];
}

async function loadScopeApi(): Promise<ScopeApi> {
  const modulePath: string = '../scope.js';
  const loaded = (await import(modulePath).catch(() => null)) as Partial<ScopeApi> | null;
  assert.equal(
    typeof loaded?.normalizeExplicitPaths,
    'function',
    'expected complete Git scope normalization to be implemented',
  );
  return loaded as ScopeApi;
}

function file(path: string): ScopeFile {
  return { path, change: 'MODIFIED', sources: ['WORKTREE'], binary: false };
}

describe('scope normalization and parsing', () => {
  it('normalizes safe root-relative paths with byte-stable deduplication', async () => {
    const api = await loadScopeApi();
    assert.deepEqual(
      api.normalizeExplicitPaths('/repo', [
        'src/../src/z.ts',
        './src/a.ts',
        '/repo/src/a.ts',
        'docs',
        'src/z.ts',
      ]),
      ['docs', 'src/a.ts', 'src/z.ts'],
    );
  });

  it('rejects traversal and absolute paths outside the repository', async () => {
    const api = await loadScopeApi();
    for (const path of ['../secret', 'src/../../secret', '/other/secret']) {
      assert.throws(
        () => api.normalizeExplicitPaths('/repo', [path]),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_PATH',
        path,
      );
    }
  });

  it('treats missing paths as filters and never widens them to unchanged content', async () => {
    const api = await loadScopeApi();
    const normalized = api.normalizeExplicitPaths('/repo', ['missing.ts']);
    assert.deepEqual(normalized, ['missing.ts']);
    assert.deepEqual(api.filterManifestFiles([file('src/changed.ts')], normalized), []);
  });

  it('matches exact files and directory descendants only', async () => {
    const api = await loadScopeApi();
    assert.equal(api.pathMatchesExplicitScope('src/a.ts', ['src']), true);
    assert.equal(api.pathMatchesExplicitScope('src', ['src']), true);
    assert.equal(api.pathMatchesExplicitScope('src-other/a.ts', ['src']), false);
    assert.equal(api.pathMatchesExplicitScope('docs/a.md', ['src']), false);
  });

  it('parses binary, rename, deletion, type change, copy, and unmerged status records', async () => {
    const api = await loadScopeApi();
    const statuses = api.parseNameStatus(
      Buffer.from(
        'R100\0old.ts\0new.ts\0D\0gone.ts\0T\0kind.ts\0C087\0source.ts\0copy.ts\0U\0conflict.ts\0',
      ),
      'INDEX',
    );
    assert.deepEqual(statuses, [
      { change: 'RENAMED', previous_path: 'old.ts', path: 'new.ts', source: 'INDEX' },
      { change: 'DELETED', path: 'gone.ts', source: 'INDEX' },
      { change: 'TYPE_CHANGED', path: 'kind.ts', source: 'INDEX' },
      { change: 'COPIED', previous_path: 'source.ts', path: 'copy.ts', source: 'INDEX' },
      { change: 'UNMERGED', path: 'conflict.ts', source: 'INDEX' },
    ]);

    assert.deepEqual(api.parseNumStat(Buffer.from('-\t-\tasset.bin\0')), [
      {
        additions: 0,
        binary: true,
        deletions: 0,
        path: 'asset.bin',
      },
    ]);
  });

  it('parses rename numstat records without brace-expansion assumptions', async () => {
    const api = await loadScopeApi();
    assert.deepEqual(api.parseNumStat(Buffer.from('2\t1\t\0old name.ts\0new name.ts\0')), [
      {
        additions: 2,
        binary: false,
        deletions: 1,
        previous_path: 'old name.ts',
        path: 'new name.ts',
      },
    ]);
  });

  it('fails closed before invalid UTF-8 path bytes can collapse to replacement characters', async () => {
    const api = await loadScopeApi();
    const invalidNameStatus = Buffer.concat([
      Buffer.from('A\0'),
      Buffer.from([0x80]),
      Buffer.from('\0A\0'),
      Buffer.from([0x81]),
      Buffer.from('\0'),
    ]);
    const invalidNumStat = Buffer.concat([
      Buffer.from('1\t0\t'),
      Buffer.from([0x80]),
      Buffer.from([0]),
      Buffer.from('1\t0\t'),
      Buffer.from([0x81]),
      Buffer.from('\0'),
    ]);

    for (const run of [
      () => api.parseNameStatus(invalidNameStatus, 'INDEX'),
      () => api.parseNumStat(invalidNumStat),
    ]) {
      assert.throws(
        run,
        (error: unknown) => (error as { code?: unknown }).code === 'GIT_COMMAND_FAILED',
      );
    }
  });

  it('preserves a leading UTF-8 BOM as path identity instead of collapsing it', async () => {
    const api = await loadScopeApi();
    const bomPath = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a')]);
    const nameStatus = Buffer.concat([
      Buffer.from('A\0a\0A\0'),
      bomPath,
      Buffer.from('\0'),
    ]);
    const numStat = Buffer.concat([
      Buffer.from('1\t0\ta\0' + '1\t0\t'),
      bomPath,
      Buffer.from('\0'),
    ]);

    assert.deepEqual(
      api.parseNameStatus(nameStatus, 'UNTRACKED').map((entry) => entry.path),
      ['a', '\uFEFFa'],
    );
    assert.deepEqual(
      api.parseNumStat(numStat).map((entry) => entry.path),
      ['a', '\uFEFFa'],
    );
  });

  it('classifies symlink and submodule modes without following their targets', async () => {
    const api = await loadScopeApi();
    assert.equal(api.classifyGitMode('120000'), 'SYMLINK');
    assert.equal(api.classifyGitMode('160000'), 'GITLINK');
    assert.equal(api.classifyGitMode('100644'), 'REGULAR');
    assert.equal(api.classifyGitMode(undefined), 'REGULAR');
  });

  it('filters the complete union after discovery and preserves stable order', async () => {
    const api = await loadScopeApi();
    const renamed: ScopeFile = {
      ...file('src/new.ts'),
      change: 'RENAMED',
      previous_path: 'legacy/old.ts',
    };
    assert.deepEqual(
      api.filterManifestFiles(
        [file('z.ts'), file('src/z.ts'), file('src/a.ts'), file('docs/a.md'), renamed],
        ['src'],
      ).map((entry) => entry.path),
      ['src/a.ts', 'src/new.ts', 'src/z.ts'],
    );
    assert.deepEqual(api.filterManifestFiles([renamed], ['legacy']).map((entry) => entry.path), [
      'src/new.ts',
    ]);
  });
});
