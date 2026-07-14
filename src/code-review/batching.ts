import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import type { ReviewBatch, ScopeFile } from './contract.js';

const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_CHANGED_LINES = 20_000;

export interface BatchConfig {
  maxFiles: number;
  maxChangedLines: number;
}

export interface RequiredReviewLane {
  lane_id: string;
  role: 'code-reviewer' | 'architect';
  batch_id: string | 'global';
}

export interface BatchPlan {
  review_flags: 'BATCHED_REVIEW'[];
  batches: ReviewBatch[];
  required_lanes: RequiredReviewLane[];
}

export type BatchingErrorCode = 'INVALID_CONFIGURATION' | 'INVALID_SCOPE' | 'BATCHING_IO_FAILED';

export class BatchingError extends Error {
  readonly code: BatchingErrorCode;

  constructor(code: BatchingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BatchingError';
    this.code = code;
  }
}

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BatchingError('INVALID_CONFIGURATION', `${name} must be a positive integer`);
  }
  return value;
}

function environmentInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new BatchingError('INVALID_CONFIGURATION', `${name} must be a positive integer`);
  }
  return positiveInteger(Number(value), name);
}

export function resolveBatchingConfig(env: NodeJS.ProcessEnv = process.env): BatchConfig {
  return {
    maxFiles: environmentInteger(
      env.OMX_CODE_REVIEW_MAX_FILES,
      DEFAULT_MAX_FILES,
      'OMX_CODE_REVIEW_MAX_FILES',
    ),
    maxChangedLines: environmentInteger(
      env.OMX_CODE_REVIEW_MAX_CHANGED_LINES,
      DEFAULT_MAX_CHANGED_LINES,
      'OMX_CODE_REVIEW_MAX_CHANGED_LINES',
    ),
  };
}

function validateConfig(config: BatchConfig): BatchConfig {
  return {
    maxFiles: positiveInteger(config.maxFiles, 'maxFiles'),
    maxChangedLines: positiveInteger(config.maxChangedLines, 'maxChangedLines'),
  };
}

function validateScopePath(path: string): string {
  if (
    path.length === 0
    || path === '.'
    || path.includes('\0')
    || path.includes('\\')
    || isAbsolute(path)
    || win32.isAbsolute(path)
  ) {
    throw new BatchingError('INVALID_SCOPE', `invalid scope path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized === '..' || normalized.startsWith('../')) {
    throw new BatchingError('INVALID_SCOPE', `invalid scope path: ${path}`);
  }
  return path;
}

function changedLines(file: ScopeFile): number {
  if (file.binary || file.change === 'SYMLINK' || file.change === 'SUBMODULE') return 0;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  if (
    !Number.isSafeInteger(additions)
    || additions < 0
    || !Number.isSafeInteger(deletions)
    || deletions < 0
    || !Number.isSafeInteger(additions + deletions)
  ) {
    throw new BatchingError('INVALID_SCOPE', `invalid changed-line count for ${file.path}`);
  }
  return additions + deletions;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moduleRoot(repositoryRoot: string, path: string): Promise<string> {
  const segments = path.split('/');
  let candidate = dirname(path);
  while (true) {
    const relativeCandidate = candidate === '.' ? '' : candidate;
    const absoluteCandidate = resolve(repositoryRoot, relativeCandidate);
    try {
      const [hasPackage, hasCargo] = await Promise.all([
        isRegularFile(join(absoluteCandidate, 'package.json')),
        isRegularFile(join(absoluteCandidate, 'Cargo.toml')),
      ]);
      if (hasPackage || hasCargo) return relativeCandidate || '.';
    } catch (error) {
      throw new BatchingError(
        'BATCHING_IO_FAILED',
        `could not inspect module manifests for ${path}`,
        { cause: error },
      );
    }
    if (candidate === '.') break;
    candidate = dirname(candidate);
  }
  return segments.length === 1 ? '.' : (segments[0] as string);
}

function assertExactCoverage(files: readonly ScopeFile[], batches: readonly ReviewBatch[]): void {
  const expected = files.map((file) => file.path).sort(byteCompare);
  const actual = batches.flatMap((batch) => batch.files).sort(byteCompare);
  if (
    expected.length !== actual.length
    || expected.some((path, index) => path !== actual[index])
    || new Set(actual).size !== actual.length
  ) {
    throw new BatchingError('INVALID_SCOPE', 'batch plan does not exactly cover the frozen scope');
  }
}

export async function createBatchPlan(options: {
  repositoryRoot: string;
  files: readonly ScopeFile[];
  config?: BatchConfig;
}): Promise<BatchPlan> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const config = validateConfig(options.config ?? resolveBatchingConfig());
  const files = [...options.files]
    .map((file) => ({ ...file, path: validateScopePath(file.path) }))
    .sort((left, right) => byteCompare(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new BatchingError('INVALID_SCOPE', 'frozen scope contains duplicate paths');
  }

  const roots = await Promise.all(files.map((file) => moduleRoot(repositoryRoot, file.path)));
  const groups = new Map<string, ScopeFile[]>();
  for (let index = 0; index < files.length; index += 1) {
    const root = roots[index] as string;
    const group = groups.get(root) ?? [];
    group.push(files[index] as ScopeFile);
    groups.set(root, group);
  }

  const batches: ReviewBatch[] = [];
  for (const root of [...groups.keys()].sort(byteCompare)) {
    const group = groups.get(root) as ScopeFile[];
    let pending: ScopeFile[] = [];
    let pendingLines = 0;
    const flush = (): void => {
      if (pending.length === 0) return;
      batches.push({
        batch_id: `batch-${batches.length + 1}`,
        module_root: root,
        files: pending.map((file) => file.path),
        changed_lines: pendingLines,
        oversized_single_file: pending.length === 1 && pendingLines > config.maxChangedLines,
      });
      pending = [];
      pendingLines = 0;
    };

    for (const file of group) {
      const fileLines = changedLines(file);
      if (
        pending.length > 0
        && (pending.length + 1 > config.maxFiles
          || pendingLines + fileLines > config.maxChangedLines)
      ) flush();
      pending.push(file);
      pendingLines += fileLines;
      if (fileLines > config.maxChangedLines) flush();
    }
    flush();
  }

  assertExactCoverage(files, batches);
  const totalLines = files.reduce((total, file) => total + changedLines(file), 0);
  const reviewFlags: 'BATCHED_REVIEW'[] =
    files.length > config.maxFiles || totalLines > config.maxChangedLines
      ? ['BATCHED_REVIEW']
      : [];
  const requiredLanes: RequiredReviewLane[] = [
    ...batches.map((batch) => ({
      lane_id: `reviewer-${batch.batch_id}`,
      role: 'code-reviewer' as const,
      batch_id: batch.batch_id,
    })),
    { lane_id: 'architect-global', role: 'architect', batch_id: 'global' },
  ];
  return { review_flags: reviewFlags, batches, required_lanes: requiredLanes };
}
