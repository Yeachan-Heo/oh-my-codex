import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { type FileHandle, lstat, open, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  ScopeFile,
  ScopeFileChange,
  ScopeFileSource,
  ScopeManifest,
  ScopeSelector,
} from './contract.js';

export type ScopeResolutionErrorCode =
  | 'NOT_GIT_REPOSITORY'
  | 'INVALID_BASE'
  | 'INVALID_PATH'
  | 'UNMERGED'
  | 'SCOPE_DRIFT'
  | 'GIT_COMMAND_FAILED';

export class ScopeResolutionError extends Error {
  readonly code: ScopeResolutionErrorCode;

  constructor(code: ScopeResolutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScopeResolutionError';
    this.code = code;
  }
}

export type GitExecutor = (workingDirectory: string, args: readonly string[]) => Promise<Buffer>;

export interface ResolveGitScopeOptions {
  workingDirectory: string;
  selector?: ScopeSelector;
  effectiveConfig?: Readonly<Record<string, unknown>>;
  gitExecutor?: GitExecutor;
  fileSystem?: ScopeFileSystem;
}

export interface ScopeFileSystem {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<FileHandle>;
  readlink(path: string): Promise<Buffer>;
}

export interface ScopeDriftResult {
  matches: boolean;
  current_scope_hash: string;
}

export interface ParsedNameStatus {
  change: ScopeFileChange;
  path: string;
  previous_path?: string;
  source: ScopeFileSource;
}

export interface ParsedNumStat {
  path: string;
  previous_path?: string;
  binary: boolean;
  additions: number;
  deletions: number;
}

interface MutableScopeFile {
  path: string;
  previous_path?: string;
  change: ScopeFileChange;
  sources: Set<ScopeFileSource>;
}

interface GitTreeEntry {
  mode: string;
  objectId: string;
}

interface ScopeHashMaterial {
  path: string;
  index_mode?: string;
  index_object_id?: string;
  base_mode?: string;
  base_object_id?: string;
  head_mode?: string;
  head_object_id?: string;
  worktree_digest?: string;
}

const SOURCE_ORDER: ScopeFileSource[] = ['BASE', 'INDEX', 'WORKTREE', 'UNTRACKED'];
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_SCOPE_FILE_SYSTEM: ScopeFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open: (path, flags) => open(path, flags),
  readlink: (path) => readlink(path, { encoding: 'buffer' }),
};

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function decodeUtf8Strict(output: Buffer, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  } catch (error) {
    throw new ScopeResolutionError(
      'GIT_COMMAND_FAILED',
      `Git returned invalid UTF-8 for ${context}`,
      { cause: error },
    );
  }
}

function decodeNulSegments(output: Buffer, context: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) continue;
    if (index > start) {
      segments.push(decodeUtf8Strict(output.subarray(start, index), context));
    }
    start = index + 1;
  }
  return segments;
}

function trimTextOutput(output: Buffer, context: string): string {
  return decodeUtf8Strict(output, context).trim();
}

function decodePathLine(output: Buffer, context: string): string {
  const decoded = decodeUtf8Strict(output, context);
  if (decoded.endsWith('\r\n')) return decoded.slice(0, -2);
  if (decoded.endsWith('\n')) return decoded.slice(0, -1);
  return decoded;
}

function errorExitCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

function isScopeError(error: unknown): error is ScopeResolutionError {
  return error instanceof ScopeResolutionError;
}

export function runGitCommand(
  workingDirectory: string,
  args: readonly string[],
): Promise<Buffer> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      [...args],
      {
        cwd: workingDirectory,
        encoding: 'buffer',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          rejectCommand(error);
          return;
        }
        resolveCommand(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

async function requiredGit(
  git: GitExecutor,
  workingDirectory: string,
  args: readonly string[],
): Promise<Buffer> {
  try {
    return await git(workingDirectory, args);
  } catch (error) {
    if (isScopeError(error)) throw error;
    throw new ScopeResolutionError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      { cause: error },
    );
  }
}

async function gitAllowingExitCodes(
  git: GitExecutor,
  workingDirectory: string,
  args: readonly string[],
  allowedExitCodes: readonly number[],
): Promise<Buffer | undefined> {
  try {
    return await git(workingDirectory, args);
  } catch (error) {
    const exitCode = errorExitCode(error);
    if (exitCode !== undefined && allowedExitCodes.includes(exitCode)) return undefined;
    if (isScopeError(error)) throw error;
    throw new ScopeResolutionError(
      'GIT_COMMAND_FAILED',
      `Git command failed: git ${args.join(' ')}`,
      { cause: error },
    );
  }
}

export function normalizeExplicitPaths(
  repositoryRoot: string,
  paths: readonly string[],
): string[] {
  const root = resolve(repositoryRoot);
  const normalized = new Set<string>();

  for (const input of paths) {
    if (input.length === 0 || input.includes('\0')) {
      throw new ScopeResolutionError('INVALID_PATH', 'Review paths must be non-empty');
    }
    const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
    const rootRelative = relative(root, absolute);
    if (rootRelative === '..' || rootRelative.startsWith(`..${sep}`) || isAbsolute(rootRelative)) {
      throw new ScopeResolutionError(
        'INVALID_PATH',
        `Review path escapes the repository root: ${input}`,
      );
    }
    normalized.add(posixPath(rootRelative));
  }

  return [...normalized].sort(byteCompare);
}

export function pathMatchesExplicitScope(
  path: string,
  explicitPaths: readonly string[],
): boolean {
  if (explicitPaths.length === 0) return true;
  return explicitPaths.some((candidate) =>
    candidate === '' ? true : path === candidate || path.startsWith(`${candidate}/`),
  );
}

export function filterManifestFiles(
  files: readonly ScopeFile[],
  explicitPaths: readonly string[],
): ScopeFile[] {
  return files
    .filter(
      (file) =>
        pathMatchesExplicitScope(file.path, explicitPaths) ||
        (file.previous_path !== undefined &&
          pathMatchesExplicitScope(file.previous_path, explicitPaths)),
    )
    .sort((left, right) => byteCompare(left.path, right.path));
}

function statusChange(status: string): ScopeFileChange {
  switch (status[0]) {
    case 'A':
      return 'ADDED';
    case 'M':
      return 'MODIFIED';
    case 'D':
      return 'DELETED';
    case 'R':
      return 'RENAMED';
    case 'C':
      return 'COPIED';
    case 'T':
      return 'TYPE_CHANGED';
    case 'U':
      return 'UNMERGED';
    default:
      throw new ScopeResolutionError(
        'GIT_COMMAND_FAILED',
        `Unsupported Git change status: ${status}`,
      );
  }
}

export function parseNameStatus(
  output: Buffer | string,
  source: ScopeFileSource,
): ParsedNameStatus[] {
  const values = Buffer.isBuffer(output)
    ? decodeNulSegments(output, 'name-status path')
    : output.split('\0').filter((value) => value.length > 0);
  const records: ParsedNameStatus[] = [];

  for (let index = 0; index < values.length; ) {
    const status = values[index++] as string;
    const change = statusChange(status);
    if (change === 'RENAMED' || change === 'COPIED') {
      const previousPath = values[index++];
      const path = values[index++];
      if (previousPath === undefined || path === undefined) {
        throw new ScopeResolutionError('GIT_COMMAND_FAILED', 'Malformed Git rename status');
      }
      records.push({ change, path: posixPath(path), previous_path: posixPath(previousPath), source });
      continue;
    }
    const path = values[index++];
    if (path === undefined) {
      throw new ScopeResolutionError('GIT_COMMAND_FAILED', 'Malformed Git name-status output');
    }
    records.push({ change, path: posixPath(path), source });
  }

  return records;
}

export function parseNumStat(output: Buffer | string): ParsedNumStat[] {
  const values = Buffer.isBuffer(output)
    ? decodeNulSegments(output, 'numstat path')
    : output.split('\0');
  const records: ParsedNumStat[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const header = values[index];
    if (!header) continue;
    const firstTab = header.indexOf('\t');
    const secondTab = header.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new ScopeResolutionError('GIT_COMMAND_FAILED', 'Malformed Git numstat output');
    }
    const additionsText = header.slice(0, firstTab).replace(/^\n+/, '');
    const deletionsText = header.slice(firstTab + 1, secondTab);
    const inlinePath = header.slice(secondTab + 1);
    const binary = additionsText === '-' || deletionsText === '-';
    const additions = binary ? 0 : Number.parseInt(additionsText, 10);
    const deletions = binary ? 0 : Number.parseInt(deletionsText, 10);
    if (!binary && (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions))) {
      throw new ScopeResolutionError('GIT_COMMAND_FAILED', 'Malformed Git line counts');
    }

    if (inlinePath.length > 0) {
      records.push({
        path: posixPath(inlinePath),
        binary,
        additions,
        deletions,
      });
      continue;
    }

    const previousPath = values[++index];
    const path = values[++index];
    if (!previousPath || !path) {
      throw new ScopeResolutionError('GIT_COMMAND_FAILED', 'Malformed Git rename numstat output');
    }
    records.push({
      path: posixPath(path),
      previous_path: posixPath(previousPath),
      binary,
      additions,
      deletions,
    });
  }

  return records;
}

export function classifyGitMode(mode: string | undefined): 'REGULAR' | 'SYMLINK' | 'GITLINK' {
  if (mode === '120000') return 'SYMLINK';
  if (mode === '160000') return 'GITLINK';
  return 'REGULAR';
}

function mergeDiscovery(
  target: Map<string, MutableScopeFile>,
  records: readonly ParsedNameStatus[],
): void {
  for (const record of records) {
    if (record.change === 'UNMERGED') {
      throw new ScopeResolutionError('UNMERGED', `Unmerged path prevents review: ${record.path}`);
    }
    const existing = target.get(record.path);
    if (existing) {
      existing.sources.add(record.source);
      if (record.change === 'DELETED') {
        existing.change = 'DELETED';
      } else if (
        existing.change !== 'ADDED' &&
        existing.change !== 'RENAMED' &&
        existing.change !== 'COPIED' &&
        record.change !== 'MODIFIED'
      ) {
        existing.change = record.change;
      }
      if (record.previous_path !== undefined) existing.previous_path = record.previous_path;
      continue;
    }
    target.set(record.path, {
      path: record.path,
      previous_path: record.previous_path,
      change: record.change,
      sources: new Set([record.source]),
    });
  }
}

function parseIndexEntry(output: Buffer): GitTreeEntry | undefined {
  const first = decodeNulSegments(output, 'index path')[0];
  if (!first) return undefined;
  const match = /^(\d{6}) ([0-9a-f]+) [0-3]\t/.exec(first);
  return match ? { mode: match[1] as string, objectId: match[2] as string } : undefined;
}

function parseTreeEntry(output: Buffer): GitTreeEntry | undefined {
  const first = decodeNulSegments(output, 'tree path')[0];
  if (!first) return undefined;
  const match = /^(\d{6}) \S+ ([0-9a-f]+)\t/.exec(first);
  return match ? { mode: match[1] as string, objectId: match[2] as string } : undefined;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface InspectedWorktreeValue {
  kind: 'REGULAR' | 'SYMLINK' | 'MISSING';
  digest?: string;
  binary?: boolean;
  lines?: number;
}

async function inspectChangedWorktreeValue(
  fileSystem: ScopeFileSystem,
  repositoryRoot: string,
  path: string,
): Promise<InspectedWorktreeValue> {
  const absolutePath = resolve(repositoryRoot, path);
  let initial: BigIntStats;
  try {
    initial = await fileSystem.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'MISSING' };
    throw new ScopeResolutionError('SCOPE_DRIFT', `Unable to inspect changed path: ${path}`, {
      cause: error,
    });
  }

  if (initial.isSymbolicLink()) {
    try {
      const target = await fileSystem.readlink(absolutePath);
      return { kind: 'SYMLINK', digest: sha256(target), binary: false, lines: 0 };
    } catch (error) {
      throw new ScopeResolutionError('SCOPE_DRIFT', `Symlink changed while freezing: ${path}`, {
        cause: error,
      });
    }
  }
  if (!initial.isFile()) return { kind: 'MISSING' };

  let handle: FileHandle;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await fileSystem.open(absolutePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new ScopeResolutionError('SCOPE_DRIFT', `File changed before it could be opened: ${path}`, {
      cause: error,
    });
  }

  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino) {
      throw new ScopeResolutionError('SCOPE_DRIFT', `File identity changed while freezing: ${path}`);
    }

    const hash = createHash('sha256');
    let containsNull = false;
    let inspectedBytes = 0;
    let lineBreaks = 0;
    let totalBytes = 0;
    let lastByte: number | undefined;
    for await (const value of handle.createReadStream({ autoClose: false })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk);
      totalBytes += chunk.length;
      for (const byte of chunk) {
        if (inspectedBytes < 8_000 && byte === 0) containsNull = true;
        if (byte === 10) lineBreaks += 1;
        inspectedBytes += 1;
        lastByte = byte;
      }
    }
    return {
      kind: 'REGULAR',
      digest: hash.digest('hex'),
      binary: containsNull,
      lines: totalBytes === 0 ? 0 : lineBreaks + (lastByte === 10 ? 0 : 1),
    };
  } finally {
    await handle.close();
  }
}

async function resolveBase(
  git: GitExecutor,
  repositoryRoot: string,
  requestedBase: string | undefined,
  headSha: string,
): Promise<{ baseRef?: string; baseSha?: string; resolved: boolean }> {
  if (requestedBase !== undefined) {
    if (requestedBase.startsWith('-') || requestedBase.includes('\0')) {
      throw new ScopeResolutionError('INVALID_BASE', `Invalid explicit base: ${requestedBase}`);
    }
    const verified = await gitAllowingExitCodes(
      git,
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', `${requestedBase}^{commit}`],
      [1, 128],
    );
    if (!verified) {
      throw new ScopeResolutionError('INVALID_BASE', `Invalid explicit base: ${requestedBase}`);
    }
    const mergeBase = await gitAllowingExitCodes(
      git,
      repositoryRoot,
      ['merge-base', requestedBase, headSha],
      [1],
    );
    if (!mergeBase || trimTextOutput(mergeBase, 'explicit merge-base').length === 0) {
      throw new ScopeResolutionError('INVALID_BASE', `Explicit base has no merge-base: ${requestedBase}`);
    }
    return {
      baseRef: requestedBase,
      baseSha: trimTextOutput(mergeBase, 'explicit merge-base'),
      resolved: true,
    };
  }

  const branch = await gitAllowingExitCodes(
    git,
    repositoryRoot,
    ['symbolic-ref', '-q', '--short', 'HEAD'],
    [1],
  );
  const branchName = branch ? trimTextOutput(branch, 'current branch') : '';
  const upstream =
    branchName.length === 0
      ? undefined
      : await requiredGit(git, repositoryRoot, [
          'for-each-ref',
          '--format=%(upstream)',
          `refs/heads/${branchName}`,
        ]);
  const upstreamRef = upstream ? trimTextOutput(upstream, 'configured upstream') : '';
  if (upstreamRef.length > 0) {
    const mergeBase = await gitAllowingExitCodes(
      git,
      repositoryRoot,
      ['merge-base', upstreamRef, headSha],
      [1],
    );
    if (mergeBase && trimTextOutput(mergeBase, 'upstream merge-base').length > 0) {
      return {
        baseRef: upstreamRef,
        baseSha: trimTextOutput(mergeBase, 'upstream merge-base'),
        resolved: true,
      };
    }
  }

  const remoteHeads = await requiredGit(git, repositoryRoot, [
    'for-each-ref',
    '--format=%(symref)',
    'refs/remotes/*/HEAD',
  ]);
  const targets = [
    ...new Set(
      decodeUtf8Strict(remoteHeads, 'remote default refs')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort(byteCompare);
  if (targets.length === 1) {
    const target = targets[0] as string;
    const mergeBase = await gitAllowingExitCodes(
      git,
      repositoryRoot,
      ['merge-base', target, headSha],
      [1],
    );
    if (mergeBase && trimTextOutput(mergeBase, 'remote merge-base').length > 0) {
      return {
        baseRef: target,
        baseSha: trimTextOutput(mergeBase, 'remote merge-base'),
        resolved: true,
      };
    }
  }

  return { resolved: false };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => byteCompare(left, right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

async function buildFrozenFile(
  git: GitExecutor,
  fileSystem: ScopeFileSystem,
  repositoryRoot: string,
  mutable: MutableScopeFile,
  baseSha: string | undefined,
  headSha: string,
  stat: ParsedNumStat | undefined,
): Promise<{ file: ScopeFile; material: ScopeHashMaterial }> {
  const [indexOutput, headOutput, baseOutput, worktree] = await Promise.all([
    requiredGit(git, repositoryRoot, [
      'ls-files',
      '--stage',
      '-z',
      '--',
      literalPathspec(mutable.path),
    ]),
    requiredGit(git, repositoryRoot, [
      'ls-tree',
      '-z',
      headSha,
      '--',
      literalPathspec(mutable.path),
    ]),
    baseSha
      ? requiredGit(git, repositoryRoot, [
          'ls-tree',
          '-z',
          baseSha,
          '--',
          literalPathspec(mutable.path),
        ])
      : Promise.resolve(Buffer.alloc(0)),
    inspectChangedWorktreeValue(fileSystem, repositoryRoot, mutable.path),
  ]);
  const indexEntry = parseIndexEntry(indexOutput);
  const headEntry = parseTreeEntry(headOutput);
  const baseEntry = parseTreeEntry(baseOutput);
  const modeKind =
    indexEntry?.mode === '160000'
      ? 'GITLINK'
      : worktree.kind === 'SYMLINK'
        ? 'SYMLINK'
        : classifyGitMode(indexEntry?.mode ?? headEntry?.mode ?? baseEntry?.mode);
  const binary = modeKind === 'REGULAR' && (stat?.binary ?? worktree.binary ?? false);
  const sources = SOURCE_ORDER.filter((source) => mutable.sources.has(source));
  const file: ScopeFile = {
    path: mutable.path,
    ...(mutable.previous_path === undefined ? {} : { previous_path: mutable.previous_path }),
    change:
      modeKind === 'SYMLINK'
        ? 'SYMLINK'
        : modeKind === 'GITLINK'
          ? 'SUBMODULE'
          : mutable.change,
    sources,
    binary,
  };

  if (modeKind === 'REGULAR' && !binary) {
    if (mutable.sources.has('UNTRACKED') && worktree.lines !== undefined) {
      file.additions = worktree.lines;
      file.deletions = 0;
    } else if (stat) {
      file.additions = stat.additions;
      file.deletions = stat.deletions;
    }
  }

  const shouldHashWorktree =
    worktree.digest !== undefined &&
    (modeKind === 'SYMLINK' ||
      mutable.sources.has('WORKTREE') ||
      mutable.sources.has('UNTRACKED'));
  return {
    file,
    material: {
      path: mutable.path,
      ...(indexEntry ? { index_mode: indexEntry.mode, index_object_id: indexEntry.objectId } : {}),
      ...(baseEntry ? { base_mode: baseEntry.mode, base_object_id: baseEntry.objectId } : {}),
      ...(headEntry ? { head_mode: headEntry.mode, head_object_id: headEntry.objectId } : {}),
      ...(shouldHashWorktree ? { worktree_digest: worktree.digest } : {}),
    },
  };
}

export async function resolveGitScope(options: ResolveGitScopeOptions): Promise<ScopeManifest> {
  const git = options.gitExecutor ?? runGitCommand;
  const fileSystem = options.fileSystem ?? DEFAULT_SCOPE_FILE_SYSTEM;
  let repositoryRootOutput: Buffer;
  try {
    repositoryRootOutput = await git(options.workingDirectory, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    throw new ScopeResolutionError(
      'NOT_GIT_REPOSITORY',
      `Not a Git repository: ${options.workingDirectory}`,
      { cause: error },
    );
  }
  const repositoryRoot = decodePathLine(repositoryRootOutput, 'repository root');
  if (repositoryRoot.length === 0) {
    throw new ScopeResolutionError('NOT_GIT_REPOSITORY', 'Git returned an empty repository root');
  }

  const selector: ScopeSelector = {
    ...(options.selector?.requested_base === undefined
      ? {}
      : { requested_base: options.selector.requested_base }),
    explicit_paths: normalizeExplicitPaths(repositoryRoot, options.selector?.explicit_paths ?? []),
  };
  const headSha = trimTextOutput(
    await requiredGit(git, repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    'HEAD commit',
  );
  const base = await resolveBase(git, repositoryRoot, selector.requested_base, headSha);
  const reasons: string[] = base.resolved ? [] : ['BASE_UNRESOLVED'];

  const unmerged = await requiredGit(git, repositoryRoot, [
    'diff',
    '--name-only',
    '--diff-filter=U',
    '-z',
    '--',
  ]);
  if (unmerged.length > 0) {
    const path = decodeNulSegments(unmerged, 'unmerged path')[0] ?? 'unknown';
    throw new ScopeResolutionError('UNMERGED', `Unmerged path prevents review: ${path}`);
  }

  const discovered = new Map<string, MutableScopeFile>();
  if (base.baseSha) {
    mergeDiscovery(
      discovered,
      parseNameStatus(
        await requiredGit(git, repositoryRoot, [
          'diff',
          '--name-status',
          '-z',
          '--find-renames',
          `${base.baseSha}..${headSha}`,
          '--',
        ]),
        'BASE',
      ),
    );
  }
  mergeDiscovery(
    discovered,
    parseNameStatus(
      await requiredGit(git, repositoryRoot, [
        'diff',
        '--cached',
        '--name-status',
        '-z',
        '--find-renames',
        headSha,
        '--',
      ]),
      'INDEX',
    ),
  );
  mergeDiscovery(
    discovered,
    parseNameStatus(
      await requiredGit(git, repositoryRoot, [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--',
      ]),
      'WORKTREE',
    ),
  );
  const untracked = await requiredGit(git, repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
  ]);
  for (const path of decodeNulSegments(untracked, 'untracked path')) {
    mergeDiscovery(discovered, [
      { path: posixPath(path), change: 'ADDED', source: 'UNTRACKED' },
    ]);
  }

  let hasIgnoredDescendant = false;
  if (selector.explicit_paths.length > 0) {
    const ignoredInventory = await requiredGit(git, repositoryRoot, [
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '-z',
      '--',
      ...selector.explicit_paths
        .filter((path) => path.length > 0)
        .map(literalPathspec),
    ]);
    hasIgnoredDescendant =
      decodeNulSegments(ignoredInventory, 'ignored path inventory').length > 0;
  }
  if (hasIgnoredDescendant) {
    reasons.push('IGNORED_PATH_EXCLUDED');
  }
  const effectiveExplicitPaths = selector.explicit_paths;
  const selected = [...discovered.values()]
    .filter(
      (entry) =>
        selector.explicit_paths.length === 0 ||
        (effectiveExplicitPaths.length > 0 &&
          (pathMatchesExplicitScope(entry.path, effectiveExplicitPaths) ||
            (entry.previous_path !== undefined &&
              pathMatchesExplicitScope(entry.previous_path, effectiveExplicitPaths)))),
    )
    .sort((left, right) => byteCompare(left.path, right.path));

  const diffReference = base.baseSha ?? headSha;
  const selectedTrackedFiles = selected.filter((entry) => !entry.sources.has('UNTRACKED'));
  const statPathspecs =
    selector.explicit_paths.length === 0
      ? []
      : [
          ...effectiveExplicitPaths.filter((path) => path.length > 0),
          ...selected
            .filter(
              (entry) => !pathMatchesExplicitScope(entry.path, effectiveExplicitPaths),
            )
            .map((entry) => entry.path),
        ];
  const stats =
    selectedTrackedFiles.length === 0
      ? []
      : parseNumStat(
          await requiredGit(git, repositoryRoot, [
            'diff',
            '--numstat',
            '-z',
            '--find-renames',
            diffReference,
            '--',
            ...statPathspecs.map(literalPathspec),
          ]),
        );
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  const frozen: Array<{ file: ScopeFile; material: ScopeHashMaterial }> = [];
  for (const entry of selected) {
    frozen.push(
      await buildFrozenFile(
        git,
        fileSystem,
        repositoryRoot,
        entry,
        base.baseSha,
        headSha,
        statsByPath.get(entry.path),
      ),
    );
  }
  const files = frozen.map((entry) => entry.file).sort((left, right) => byteCompare(left.path, right.path));
  const changedLines = files.reduce(
    (total, file) => total + (file.additions ?? 0) + (file.deletions ?? 0),
    0,
  );
  const scopeReasons = [...new Set(reasons)].sort(byteCompare);
  const scopeStatus = scopeReasons.length === 0 ? 'FULL_SCOPE' : 'PARTIAL_SCOPE';
  const scopeHash = sha256(
    JSON.stringify(
      canonicalize({
        selector,
        effective_config: options.effectiveConfig ?? {},
        base_ref: base.baseRef,
        base_sha: base.baseSha,
        head_sha: headSha,
        scope_status: scopeStatus,
        reasons: scopeReasons,
        files,
        materials: frozen.map((entry) => entry.material),
      }),
    ),
  );

  return {
    selector,
    status: scopeStatus,
    ...(base.baseRef === undefined ? {} : { base_ref: base.baseRef }),
    ...(base.baseSha === undefined ? {} : { base_sha: base.baseSha }),
    head_sha: headSha,
    scope_hash: scopeHash,
    files,
    changed_lines: changedLines,
    reasons: scopeReasons,
  };
}

export async function verifyScopeDrift(
  manifest: ScopeManifest,
  options: Omit<ResolveGitScopeOptions, 'selector'>,
): Promise<ScopeDriftResult> {
  const current = await resolveGitScope({ ...options, selector: manifest.selector });
  return {
    matches: current.scope_hash === manifest.scope_hash,
    current_scope_hash: current.scope_hash,
  };
}
