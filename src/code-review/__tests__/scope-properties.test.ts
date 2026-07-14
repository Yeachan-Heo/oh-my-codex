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
type GitExecutor = (workingDirectory: string, args: readonly string[]) => Promise<Buffer>;

interface ScopeApi {
  resolveGitScope(options: {
    workingDirectory: string;
    selector?: { requested_base?: string; explicit_paths: string[] };
    gitExecutor?: GitExecutor;
  }): Promise<ScopeManifest>;
  runGitCommand(workingDirectory: string, args: readonly string[]): Promise<Buffer>;
}

interface ExpectedScopeEntry {
  change: 'ADDED' | 'MODIFIED' | 'RENAMED';
  previous_path?: string;
  sources: ScopeFileSource[];
}

interface DiscoveryMutationStats {
  atomicRenameRecords: number;
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

function reverseAndDuplicateDiscoveryRecords(
  args: readonly string[],
  output: Buffer,
  stats: DiscoveryMutationStats,
): Buffer {
  const values = output.toString('utf8').split('\0').filter((value) => value.length > 0);
  if (values.length === 0) return output;

  if (args.includes('--name-status')) {
    const records: string[][] = [];
    for (let index = 0; index < values.length; ) {
      const status = values[index++] as string;
      const width = status.startsWith('R') || status.startsWith('C') ? 2 : 1;
      if (status.startsWith('R')) stats.atomicRenameRecords += 1;
      records.push([status, ...values.slice(index, index + width)]);
      index += width;
    }
    const reordered = records.reverse();
    return Buffer.from([...reordered, reordered[0] as string[]].flat().join('\0') + '\0');
  }

  if (args[0] === 'ls-files' && args.includes('--others') && !args.includes('--ignored')) {
    const reordered = values.reverse();
    return Buffer.from([...reordered, reordered[0] as string].join('\0') + '\0');
  }

  return output;
}

describe('scope union properties', () => {
  it('equals an independently assembled fixed-seed union with stable order and deduplication', async () => {
    const api = await loadScopeApi();
    const repository = await mkdtemp(join(tmpdir(), 'omx-code-review-scope-property-'));
    const fileCount = 36;
    const expected = new Map<string, ExpectedScopeEntry>();
    const mutationStats: DiscoveryMutationStats = { atomicRenameRecords: 0 };

    try {
      await git(repository, 'init', '-q');
      await git(repository, 'config', 'user.email', 'scope-property@example.invalid');
      await git(repository, 'config', 'user.name', 'Scope Property Test');
      await mkdir(join(repository, 'generated'));
      await writeFile(join(repository, 'generated', 'rename-source.txt'), 'rename fixture\n');

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
            expected.set(relativePath, { change: 'MODIFIED', sources: ['INDEX'] });
            break;
          case 1:
            await writeFile(absolutePath, `worktree ${index}\n`);
            expected.set(relativePath, { change: 'MODIFIED', sources: ['WORKTREE'] });
            break;
          case 2:
            await writeFile(absolutePath, `index ${index}\n`);
            await git(repository, 'add', '--', relativePath);
            await writeFile(absolutePath, `worktree ${index}\n`);
            expected.set(relativePath, {
              change: 'MODIFIED',
              sources: ['INDEX', 'WORKTREE'],
            });
            break;
          case 3:
            await writeFile(absolutePath, `untracked ${index}\n`);
            expected.set(relativePath, { change: 'ADDED', sources: ['UNTRACKED'] });
            break;
        }
      }
      await git(
        repository,
        'mv',
        '--',
        'generated/rename-source.txt',
        'generated/rename-target.txt',
      );
      expected.set('generated/rename-target.txt', {
        change: 'RENAMED',
        previous_path: 'generated/rename-source.txt',
        sources: ['INDEX'],
      });

      const first = await api.resolveGitScope({ workingDirectory: repository });
      const perturbed = await api.resolveGitScope({
        workingDirectory: repository,
        gitExecutor: async (workingDirectory, args) =>
          reverseAndDuplicateDiscoveryRecords(
            args,
            await api.runGitCommand(workingDirectory, args),
            mutationStats,
          ),
      });
      const second = await api.resolveGitScope({
        workingDirectory: repository,
        selector: { explicit_paths: ['generated'] },
      });
      const expectedPaths = [...expected.keys()].sort((left, right) =>
        Buffer.from(left).compare(Buffer.from(right)),
      );

      assert.deepEqual(first.files.map((entry) => entry.path), expectedPaths, `seed=${PROPERTY_SEED}`);
      assert.deepEqual(perturbed, first, `seed=${PROPERTY_SEED} reordered discovery`);
      assert.deepEqual(second.files.map((entry) => entry.path), expectedPaths, `seed=${PROPERTY_SEED}`);
      assert.equal(new Set(first.files.map((entry) => entry.path)).size, expected.size);
      assert.equal(expected.size, fileCount + 1);
      assert.ok(
        mutationStats.atomicRenameRecords > 0,
        `seed=${PROPERTY_SEED} expected the wrapper to transform an atomic rename record`,
      );
      for (const entry of first.files) {
        const expectedEntry = expected.get(entry.path);
        assert.ok(expectedEntry, `seed=${PROPERTY_SEED} unexpected path=${entry.path}`);
        assert.deepEqual(
          {
            change: entry.change,
            sources: entry.sources,
            ...(entry.previous_path === undefined
              ? {}
              : { previous_path: entry.previous_path }),
          },
          expectedEntry,
          `seed=${PROPERTY_SEED} path=${entry.path}`,
        );
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
