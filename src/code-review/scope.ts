import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function trimOutput(output: Buffer): string {
  return output.toString('utf8').trim();
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

async function optionalGit(
  git: GitExecutor,
  workingDirectory: string,
  args: readonly string[],
): Promise<Buffer | undefined> {
  try {
    return await git(workingDirectory, args);
  } catch (error) {
    const exitCode = errorExitCode(error);
    if (exitCode === 1 || exitCode === 128) return undefined;
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
  const values = (Buffer.isBuffer(output) ? output.toString('utf8') : output)
    .split('\0')
    .filter((value) => value.length > 0);
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
  const values = (Buffer.isBuffer(output) ? output.toString('utf8') : output).split('\0');
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
    if (previousPath === undefined || path === undefined) {
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
  const first = output.toString('utf8').split('\0').find((value) => value.length > 0);
  if (!first) return undefined;
  const match = /^(\d{6}) ([0-9a-f]+) [0-3]\t/.exec(first);
  return match ? { mode: match[1] as string, objectId: match[2] as string } : undefined;
}

function parseTreeEntry(output: Buffer): GitTreeEntry | undefined {
  const first = output.toString('utf8').split('\0').find((value) => value.length > 0);
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
  repositoryRoot: string,
  path: string,
): Promise<InspectedWorktreeValue> {
  const absolutePath = resolve(repositoryRoot, path);
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolutePath));
      return { kind: 'SYMLINK', digest: sha256(target), binary: false, lines: 0 };
    }
    if (stat.isFile()) {
      const hash = createHash('sha256');
      let containsNull = false;
      let inspectedBytes = 0;
      let lineBreaks = 0;
      let totalBytes = 0;
      let lastByte: number | undefined;
      for await (const value of createReadStream(absolutePath)) {
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
    }
    return { kind: 'MISSING' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'MISSING' };
    throw error;
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
    const verified = await optionalGit(git, repositoryRoot, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${requestedBase}^{commit}`,
    ]);
    if (!verified) {
      throw new ScopeResolutionError('INVALID_BASE', `Invalid explicit base: ${requestedBase}`);
    }
    const mergeBase = await optionalGit(git, repositoryRoot, [
      'merge-base',
      requestedBase,
      headSha,
    ]);
    if (!mergeBase || trimOutput(mergeBase).length === 0) {
      throw new ScopeResolutionError('INVALID_BASE', `Explicit base has no merge-base: ${requestedBase}`);
    }
    return { baseRef: requestedBase, baseSha: trimOutput(mergeBase), resolved: true };
  }

  const upstream = await optionalGit(git, repositoryRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  const upstreamRef = upstream ? trimOutput(upstream) : '';
  if (upstreamRef.length > 0) {
    const mergeBase = await optionalGit(git, repositoryRoot, [
      'merge-base',
      upstreamRef,
      headSha,
    ]);
    if (mergeBase && trimOutput(mergeBase).length > 0) {
      return { baseRef: upstreamRef, baseSha: trimOutput(mergeBase), resolved: true };
    }
  }

  const remoteHeads = await requiredGit(git, repositoryRoot, [
    'for-each-ref',
    '--format=%(symref)',
    'refs/remotes/*/HEAD',
  ]);
  const targets = [
    ...new Set(
      remoteHeads
        .toString('utf8')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ].sort(byteCompare);
  if (targets.length === 1) {
    const target = targets[0] as string;
    const mergeBase = await optionalGit(git, repositoryRoot, ['merge-base', target, headSha]);
    if (mergeBase && trimOutput(mergeBase).length > 0) {
      return { baseRef: target, baseSha: trimOutput(mergeBase), resolved: true };
    }
  }

  return { resolved: false };
}

async function isIgnoredExplicitPath(
  git: GitExecutor,
  repositoryRoot: string,
  path: string,
): Promise<boolean> {
  try {
    await git(repositoryRoot, ['check-ignore', '-q', '--', path]);
    return true;
  } catch (error) {
    if (errorExitCode(error) === 1) return false;
    throw new ScopeResolutionError(
      'GIT_COMMAND_FAILED',
      `Git check-ignore failed for ${path}`,
      { cause: error },
    );
  }
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
  repositoryRoot: string,
  mutable: MutableScopeFile,
  baseSha: string | undefined,
  headSha: string,
  stat: ParsedNumStat | undefined,
): Promise<{ file: ScopeFile; material: ScopeHashMaterial }> {
  const [indexOutput, headOutput, baseOutput, worktree] = await Promise.all([
    requiredGit(git, repositoryRoot, ['ls-files', '--stage', '-z', '--', mutable.path]),
    requiredGit(git, repositoryRoot, ['ls-tree', '-z', headSha, '--', mutable.path]),
    baseSha
      ? requiredGit(git, repositoryRoot, ['ls-tree', '-z', baseSha, '--', mutable.path])
      : Promise.resolve(Buffer.alloc(0)),
    inspectChangedWorktreeValue(repositoryRoot, mutable.path),
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
  const repositoryRoot = trimOutput(repositoryRootOutput);
  if (repositoryRoot.length === 0) {
    throw new ScopeResolutionError('NOT_GIT_REPOSITORY', 'Git returned an empty repository root');
  }

  const selector: ScopeSelector = {
    ...(options.selector?.requested_base === undefined
      ? {}
      : { requested_base: options.selector.requested_base }),
    explicit_paths: normalizeExplicitPaths(repositoryRoot, options.selector?.explicit_paths ?? []),
  };
  const headSha = trimOutput(
    await requiredGit(git, repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
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
    const path = unmerged.toString('utf8').split('\0').find((value) => value.length > 0) ?? 'unknown';
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
  for (const path of untracked.toString('utf8').split('\0').filter((value) => value.length > 0)) {
    mergeDiscovery(discovered, [
      { path: posixPath(path), change: 'ADDED', source: 'UNTRACKED' },
    ]);
  }

  const ignoredPaths = new Set<string>();
  for (const explicitPath of selector.explicit_paths) {
    if (explicitPath !== '' && (await isIgnoredExplicitPath(git, repositoryRoot, explicitPath))) {
      ignoredPaths.add(explicitPath);
    }
  }
  if (ignoredPaths.size > 0) reasons.push('IGNORED_PATH_EXCLUDED');
  const effectiveExplicitPaths = selector.explicit_paths.filter((path) => !ignoredPaths.has(path));
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
            ...statPathspecs,
          ]),
        );
  const statsByPath = new Map(stats.map((stat) => [stat.path, stat]));
  const frozen: Array<{ file: ScopeFile; material: ScopeHashMaterial }> = [];
  for (const entry of selected) {
    frozen.push(
      await buildFrozenFile(
        git,
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
  const scopeHash = sha256(
    JSON.stringify(
      canonicalize({
        selector,
        effective_config: options.effectiveConfig ?? {},
        base_ref: base.baseRef,
        base_sha: base.baseSha,
        head_sha: headSha,
        files,
        materials: frozen.map((entry) => entry.material),
      }),
    ),
  );

  return {
    selector,
    status: reasons.length === 0 ? 'FULL_SCOPE' : 'PARTIAL_SCOPE',
    ...(base.baseRef === undefined ? {} : { base_ref: base.baseRef }),
    ...(base.baseSha === undefined ? {} : { base_sha: base.baseSha }),
    head_sha: headSha,
    scope_hash: scopeHash,
    files,
    changed_lines: changedLines,
    reasons,
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
