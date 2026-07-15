import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ReviewRecordLaneEvent } from '../contract.js';
// @ts-expect-error Final persistence projections are intentionally not part of the public barrel.
import type { FinalReviewArtifact as ForbiddenFinalReviewArtifact } from '../index.js';

void (null as unknown as ForbiddenFinalReviewArtifact);

const compileTimeLaneStart: ReviewRecordLaneEvent = {
  event: 'START',
  review_id: '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2',
  attempt: 1,
  lane_id: 'reviewer-1',
  thread_id: 'thread-1',
  idempotency_key: '0f81b54a-b046-4562-9b8b-1c6bccd326f8',
};

void compileTimeLaneStart;

interface ParsedStartInvocation {
  operation: 'start';
  format: 'markdown' | 'json';
  selector: {
    requested_base?: string;
    explicit_paths: string[];
  };
}

interface ParsedResumeInvocation {
  operation: 'resume';
  format: 'markdown' | 'json';
  review_id: string;
}

type ParsedInvocation = ParsedStartInvocation | ParsedResumeInvocation;

interface ArgumentsApi {
  parseCodeReviewArguments(
    args: readonly string[],
    options: {
      workingDirectory: string;
      validateRef?: (ref: string) => boolean | Promise<boolean>;
    },
  ): Promise<ParsedInvocation>;
}

async function loadArgumentsApi(): Promise<ArgumentsApi> {
  const modulePath: string = '../arguments.js';
  const loaded = await import(modulePath).catch(() => null) as Partial<ArgumentsApi> | null;
  assert.equal(
    typeof loaded?.parseCodeReviewArguments,
    'function',
    'expected the code-review invocation parser to be implemented',
  );
  return loaded as ArgumentsApi;
}

async function withRepository(
  run: (workingDirectory: string, api: ArgumentsApi) => Promise<void>,
): Promise<void> {
  const workingDirectory = await mkdtemp(join(tmpdir(), 'omx-code-review-arguments-'));
  try {
    await run(workingDirectory, await loadArgumentsApi());
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function assertInvalidInvocation(
  api: ArgumentsApi,
  workingDirectory: string,
  args: readonly string[],
  validateRef: (ref: string) => boolean | Promise<boolean> = () => true,
): Promise<void> {
  await assert.rejects(
    api.parseCodeReviewArguments(args, { workingDirectory, validateRef }),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'INVALID_INVOCATION');
      return true;
    },
  );
}

describe('parseCodeReviewArguments', () => {
  it('supports only the four documented invocation forms', async () => {
    await withRepository(async (workingDirectory, api) => {
      const reviewId = '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2';
      const cases: Array<{ args: string[]; expected: ParsedInvocation }> = [
        {
          args: ['$code-review', 'src', 'README.md'],
          expected: {
            operation: 'start',
            format: 'markdown',
            selector: { explicit_paths: ['src', 'README.md'] },
          },
        },
        {
          args: ['--base', 'main', '--format', 'json', 'src'],
          expected: {
            operation: 'start',
            format: 'json',
            selector: { requested_base: 'main', explicit_paths: ['src'] },
          },
        },
        {
          args: ['--resume', reviewId, '--format', 'json'],
          expected: { operation: 'resume', review_id: reviewId, format: 'json' },
        },
        {
          args: ['--format', 'markdown', 'src'],
          expected: {
            operation: 'start',
            format: 'markdown',
            selector: { explicit_paths: ['src'] },
          },
        },
      ];

      for (const testCase of cases) {
        const actual = await api.parseCodeReviewArguments(testCase.args, {
          workingDirectory,
          validateRef: (ref) => ref === 'main',
        });
        assert.deepEqual(actual, testCase.expected, testCase.args.join(' '));
      }
    });
  });

  it('defaults a plain invocation to markdown with no explicit paths', async () => {
    await withRepository(async (workingDirectory, api) => {
      assert.deepEqual(
        await api.parseCodeReviewArguments([], { workingDirectory }),
        { operation: 'start', format: 'markdown', selector: { explicit_paths: [] } },
      );
    });
  });

  it('rejects the unprefixed bare code-review alias', async () => {
    await withRepository(async (workingDirectory, api) => {
      await assertInvalidInvocation(api, workingDirectory, ['code-review']);
    });
  });

  it('rejects unknown, removed, repeated, and missing-value flags', async () => {
    await withRepository(async (workingDirectory, api) => {
      const cases = [
        ['--unknown'],
        ['--fix'],
        ['--provider', 'openai'],
        ['--model', 'gpt'],
        ['--base'],
        ['--base', '--format', 'json'],
        ['--format'],
        ['--format', '--base', 'main'],
        ['--resume'],
        ['--resume', '--format', 'json'],
        ['--format', 'yaml'],
        ['--format', 'json', '--format', 'markdown'],
        ['--base', 'main', '--base', 'HEAD'],
        ['--resume', '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2', '--resume', '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2'],
      ];

      for (const args of cases) {
        await assertInvalidInvocation(api, workingDirectory, args);
      }

      for (const args of [
        ['--base', ''],
        ['--base', 'x'.repeat(1_025)],
        ['--format', 'json\n'],
        [''],
        ['path\0name'],
        ['path\nname'],
        ['--resume', 'not-a-uuid'],
      ]) {
        await assertInvalidInvocation(api, workingDirectory, args);
      }
    });
  });

  it('allows --base with paths and format but isolates --resume from both', async () => {
    await withRepository(async (workingDirectory, api) => {
      const reviewId = '6e6ea9c8-f4c0-4eec-9084-e7185abcbce2';
      assert.deepEqual(
        await api.parseCodeReviewArguments(['--base', 'HEAD', 'src', '--format', 'json'], {
          workingDirectory,
          validateRef: (ref) => ref === 'HEAD',
        }),
        {
          operation: 'start',
          format: 'json',
          selector: { requested_base: 'HEAD', explicit_paths: ['src'] },
        },
      );

      await assertInvalidInvocation(api, workingDirectory, ['--resume', reviewId, 'src']);
      await assertInvalidInvocation(api, workingDirectory, ['--resume', reviewId, '--base', 'main']);
    });
  });

  it('rejects paths outside the repository root and normalizes paths inside it', async () => {
    await withRepository(async (workingDirectory, api) => {
      await assertInvalidInvocation(api, workingDirectory, ['../outside']);
      await assertInvalidInvocation(api, workingDirectory, [join(workingDirectory, '..', 'outside')]);

      const actual = await api.parseCodeReviewArguments(
        [join(workingDirectory, 'src', '..', 'README.md')],
        { workingDirectory },
      );
      assert.deepEqual(actual, {
        operation: 'start',
        format: 'markdown',
        selector: { explicit_paths: ['README.md'] },
      });

      const unicodePath = `${'🧭'.repeat(600)}.ts`;
      assert.deepEqual(
        await api.parseCodeReviewArguments([unicodePath], { workingDirectory }),
        {
          operation: 'start',
          format: 'markdown',
          selector: { explicit_paths: [unicodePath] },
        },
      );
    });
  });

  it('rejects an explicit base when the authoritative ref validator rejects it', async () => {
    await withRepository(async (workingDirectory, api) => {
      let observedRef: string | undefined;
      await assertInvalidInvocation(api, workingDirectory, ['--base', 'missing-ref'], (ref) => {
        observedRef = ref;
        return false;
      });
      assert.equal(observedRef, 'missing-ref');

      await assertInvalidInvocation(api, workingDirectory, ['--base', 'validator-error'], () => {
        throw new Error('ref backend unavailable');
      });
    });
  });
});
