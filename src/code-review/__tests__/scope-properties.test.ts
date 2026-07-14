import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import type { ScopeFileSource, ScopeManifest } from '../contract.js';

const execFile = promisify(execFileCallback);
const PROPERTY_SEED = 0x5c0f_2026;

interface ScopeApi {
  resolveGitScope(options: {
    workingDirectory: string;
    selector?: { requested_base?: string; explicit_paths: string[] };
  }): Promise<ScopeManifest>;
}

async function loadScopeApi(): Promise<ScopeApi> {
  const modulePath: string = '../scope.js';
  const loaded = (await import(modulePath).catch(() => null)) as Partial<ScopeApi> | null;
  assert.equal(
    typeof loaded?.resolveGitScope,
    'function',
    `expected deterministic union discovery to be implemented (seed=${PROPERTY_SEED})`,
  );
  return loaded as ScopeApi;
}

async function git(repository: string, ...args: string[]): Promise<void> {
  await execFile('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
}

function shuffledIndices(length: number, seed: number): number[] {
  let state = seed >>> 0;
  const result = Array.from({ length }, (_, index) => index);
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swap = state % (index + 1);
    [result[index], result[swap]] = [result[swap] as number, result[index] as number];
  }
  return result;
}

describe('scope union properties', () => {
  it('equals an independently assembled fixed-seed union with stable order and deduplication', async () => {
    const api = await loadScopeApi();
    const repository = await mkdtemp(join(tmpdir(), 'omx-code-review-scope-property-'));
    const fileCount = 36;
    const expected = new Map<string, ScopeFileSource[]>();

    try {
      await git(repository, 'init', '-q');
      await git(repository, 'config', 'user.email', 'scope-property@example.invalid');
      await git(repository, 'config', 'user.name', 'Scope Property Test');
      await mkdir(join(repository, 'generated'));

      for (let index = 0; index < fileCount; index += 1) {
        if (index % 4 !== 3) {
          await writeFile(join(repository, 'generated', `file-${index.toString().padStart(2, '0')}.txt`), 'base\n');
        }
      }
      await git(repository, 'add', '--', 'generated');
      await git(repository, 'commit', '-qm', 'property base');

      for (const index of shuffledIndices(fileCount, PROPERTY_SEED)) {
        const relativePath = `generated/file-${index.toString().padStart(2, '0')}.txt`;
        const absolutePath = join(repository, relativePath);
        switch (index % 4) {
          case 0:
            await writeFile(absolutePath, `staged ${index}\n`);
            await git(repository, 'add', '--', relativePath);
            expected.set(relativePath, ['INDEX']);
            break;
          case 1:
            await writeFile(absolutePath, `worktree ${index}\n`);
            expected.set(relativePath, ['WORKTREE']);
            break;
          case 2:
            await writeFile(absolutePath, `index ${index}\n`);
            await git(repository, 'add', '--', relativePath);
            await writeFile(absolutePath, `worktree ${index}\n`);
            expected.set(relativePath, ['INDEX', 'WORKTREE']);
            break;
          case 3:
            await writeFile(absolutePath, `untracked ${index}\n`);
            expected.set(relativePath, ['UNTRACKED']);
            break;
        }
      }

      const first = await api.resolveGitScope({ workingDirectory: repository });
      const second = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { explicit_paths: ['generated'] },
      });
      const expectedPaths = [...expected.keys()].sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      );

      assert.deepEqual(first.files.map((entry) => entry.path), expectedPaths, `seed=${PROPERTY_SEED}`);
      assert.deepEqual(second.files.map((entry) => entry.path), expectedPaths, `seed=${PROPERTY_SEED}`);
      assert.equal(new Set(first.files.map((entry) => entry.path)).size, fileCount);
      for (const entry of first.files) {
        assert.deepEqual(entry.sources, expected.get(entry.path), `seed=${PROPERTY_SEED} path=${entry.path}`);
      }
      assert.deepEqual(
        first.files.map((entry) => ({ path: entry.path, sources: entry.sources })),
        second.files.map((entry) => ({ path: entry.path, sources: entry.sources })),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
