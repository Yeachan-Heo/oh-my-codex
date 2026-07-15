#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type MetricName = 'lines' | 'statements' | 'functions' | 'branches';

export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export type CoverageMetrics = Record<MetricName, CoverageMetric>;
export type CoverageSummary = Record<string, CoverageMetrics> & { total: CoverageMetrics };

interface StatementLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface CoverageFile {
  statementMap: Record<string, StatementLocation>;
  s: Record<string, number>;
}

export type CoverageFileMap = Record<string, CoverageFile>;

export interface CoverageFloors {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
}

export interface CoveragePolicy {
  critical: CoverageFloors;
  otherTouched: CoverageFloors;
  repository: CoverageFloors;
  changedLines: number;
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  critical: { lines: 90, statements: 90, functions: 95, branches: 85 },
  otherTouched: { lines: 85, statements: 85, functions: 90, branches: 75 },
  repository: { lines: 78, statements: 78, functions: 90, branches: 70 },
  changedLines: 100,
};

export interface CoverageFailure {
  code: string;
  message: string;
}

export interface CoverageGateInput {
  summary: CoverageSummary;
  coverage: CoverageFileMap;
  criticalFiles: readonly string[];
  touchedFiles: readonly string[];
  changedLines: Readonly<Record<string, readonly number[]>>;
  baselineTotal?: CoverageMetrics;
  policy?: CoveragePolicy;
  justifiedUnreachableLines?: ReadonlySet<string>;
}

export interface CoverageGateResult {
  exitCode: 0 | 1;
  failures: CoverageFailure[];
  observed: {
    critical: CoverageMetrics | null;
    otherTouched: CoverageMetrics | null;
    repository: CoverageMetrics;
    changedLines: {
      total: number;
      covered: number;
      pct: number;
      uncovered: string[];
      justifiedUnreachable: string[];
    };
  };
}

const METRICS: readonly MetricName[] = ['lines', 'statements', 'functions', 'branches'];

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function emptyMetrics(): CoverageMetrics {
  return Object.fromEntries(METRICS.map((name) => [name, {
    total: 0,
    covered: 0,
    skipped: 0,
    pct: 100,
  }])) as CoverageMetrics;
}

function aggregateFiles(summary: CoverageSummary, requestedFiles: readonly string[]): CoverageMetrics | null {
  const wanted = new Set(requestedFiles.map(normalizedPath));
  const selected = Object.entries(summary).filter(([path]) => path !== 'total' && wanted.has(normalizedPath(path)));
  if (selected.length === 0) return null;
  const aggregate = emptyMetrics();
  for (const [, metrics] of selected) {
    for (const name of METRICS) {
      aggregate[name].total += metrics[name].total;
      aggregate[name].covered += metrics[name].covered;
      aggregate[name].skipped += metrics[name].skipped;
    }
  }
  for (const name of METRICS) {
    const value = aggregate[name];
    value.pct = value.total === 0 ? 100 : (value.covered / value.total) * 100;
  }
  return aggregate;
}

function missingMeasuredFiles(summary: CoverageSummary, requestedFiles: readonly string[]): string[] {
  const measured = new Set(Object.keys(summary).filter((path) => path !== 'total').map(normalizedPath));
  return [...new Set(requestedFiles.map(normalizedPath))].filter((path) => !measured.has(path));
}

function checkFloors(
  label: string,
  metrics: CoverageMetrics | null,
  floors: CoverageFloors,
  failures: CoverageFailure[],
): void {
  if (metrics === null) {
    failures.push({ code: `${label}-missing`, message: `${label} coverage has no measured files` });
    return;
  }
  for (const name of METRICS) {
    if (metrics[name].pct + Number.EPSILON < floors[name]) {
      failures.push({
        code: `${label}-${name}`,
        message: `${label} ${name} ${metrics[name].pct.toFixed(2)}% is below ${floors[name]}%`,
      });
    }
  }
}

function changedLineCoverage(
  coverage: CoverageFileMap,
  changedLines: Readonly<Record<string, readonly number[]>>,
  justifiedUnreachableLines: ReadonlySet<string>,
): {
  total: number;
  covered: number;
  pct: number;
  uncovered: string[];
  justifiedUnreachable: string[];
} {
  const coverageByPath = new Map(Object.entries(coverage).map(([path, value]) => [normalizedPath(path), value]));
  let total = 0;
  let covered = 0;
  const uncovered: string[] = [];
  const justifiedUnreachable: string[] = [];
  for (const [path, lines] of Object.entries(changedLines)) {
    const file = coverageByPath.get(normalizedPath(path));
    if (!file) continue;
    for (const line of new Set(lines)) {
      const statementIds = Object.entries(file.statementMap)
        .filter(([, location]) => location.start.line <= line && location.end.line >= line)
        .map(([id]) => id);
      if (statementIds.length === 0) continue;
      total += 1;
      if (statementIds.some((id) => (file.s[id] ?? 0) > 0)) covered += 1;
      else {
        const identity = `${normalizedPath(path)}:${line}`;
        if (justifiedUnreachableLines.has(identity)) {
          covered += 1;
          justifiedUnreachable.push(identity);
        } else {
          uncovered.push(identity);
        }
      }
    }
  }
  return {
    total,
    covered,
    pct: total === 0 ? 100 : (covered / total) * 100,
    uncovered,
    justifiedUnreachable,
  };
}

export function evaluateCoverageGate(input: CoverageGateInput): CoverageGateResult {
  const policy = input.policy ?? DEFAULT_COVERAGE_POLICY;
  const criticalSet = new Set(input.criticalFiles.map(normalizedPath));
  const otherTouchedFiles = [...new Set(input.touchedFiles.map(normalizedPath))]
    .filter((path) => !criticalSet.has(path));
  const critical = aggregateFiles(input.summary, input.criticalFiles);
  const otherTouched = otherTouchedFiles.length === 0 ? null : aggregateFiles(input.summary, otherTouchedFiles);
  const repository = input.summary.total;
  const criticalChangedLines = Object.fromEntries(
    Object.entries(input.changedLines)
      .filter(([path]) => criticalSet.has(normalizedPath(path))),
  );
  const changedLines = changedLineCoverage(
    input.coverage,
    criticalChangedLines,
    input.justifiedUnreachableLines ?? new Set(),
  );
  const failures: CoverageFailure[] = [];

  checkFloors('critical', critical, policy.critical, failures);
  for (const path of missingMeasuredFiles(input.summary, input.criticalFiles)) {
    failures.push({ code: 'critical-file-missing', message: `critical coverage is missing ${path}` });
  }
  if (otherTouchedFiles.length > 0) checkFloors('other-touched', otherTouched, policy.otherTouched, failures);
  for (const path of missingMeasuredFiles(input.summary, otherTouchedFiles)) {
    failures.push({ code: 'other-touched-file-missing', message: `other-touched coverage is missing ${path}` });
  }
  checkFloors('repository', repository, policy.repository, failures);
  if (changedLines.pct + Number.EPSILON < policy.changedLines) {
    failures.push({
      code: 'changed-lines',
      message: `changed executable lines ${changedLines.pct.toFixed(2)}% is below ${policy.changedLines}%: ${changedLines.uncovered.slice(0, 20).join(', ')}`,
    });
  }
  if (input.baselineTotal !== undefined) {
    for (const name of METRICS) {
      if (repository[name].pct + Number.EPSILON < input.baselineTotal[name].pct) {
        failures.push({
          code: `merge-base-${name}`,
          message: `repository ${name} ${repository[name].pct.toFixed(2)}% regressed from merge-base ${input.baselineTotal[name].pct.toFixed(2)}%`,
        });
      }
    }
  }

  return {
    exitCode: failures.length === 0 ? 0 : 1,
    failures,
    observed: { critical, otherTouched, repository, changedLines },
  };
}

function isCoverableTypeScriptPath(path: string): boolean {
  const normalized = normalizedPath(path);
  return normalized.startsWith('src/')
    && normalized.endsWith('.ts')
    && !normalized.endsWith('.d.ts')
    && !normalized.includes('/__tests__/')
    && !normalized.endsWith('.test.ts');
}

export function parseChangedLines(diff: string, cwd: string): Record<string, number[]> {
  const changed: Record<string, number[]> = {};
  let currentFile: string | undefined;
  for (const line of diff.split('\n')) {
    if (line === '+++ /dev/null') {
      currentFile = undefined;
      continue;
    }
    if (line.startsWith('+++ b/')) {
      const sourcePath = line.slice(6);
      if (!isCoverableTypeScriptPath(sourcePath)) {
        currentFile = undefined;
        continue;
      }
      currentFile = normalizedPath(resolve(cwd, sourcePath));
      changed[currentFile] ??= [];
      continue;
    }
    if (line.startsWith('+++ ')) {
      throw new Error(`unsupported quoted or malformed Git path header: ${line}`);
    }
    if (!currentFile || !line.startsWith('@@')) continue;
    const match = /\+(\d+)(?:,(\d+))?/u.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) changed[currentFile]!.push(start + offset);
  }
  return changed;
}

export function addUntrackedChangedLines(
  changed: Readonly<Record<string, readonly number[]>>,
  untrackedOutput: Buffer | string,
  cwd: string,
  coverage: CoverageFileMap,
): Record<string, number[]> {
  const output = Buffer.isBuffer(untrackedOutput) ? untrackedOutput : Buffer.from(untrackedOutput);
  const result = Object.fromEntries(
    Object.entries(changed).map(([path, lines]) => [normalizedPath(path), [...lines]]),
  );
  const coverageByPath = new Map(Object.entries(coverage).map(([path, file]) => [normalizedPath(path), file]));
  for (const rawPath of output.toString('utf8').split('\0')) {
    if (!rawPath || !isCoverableTypeScriptPath(rawPath)) continue;
    const path = normalizedPath(resolve(cwd, rawPath));
    const file = coverageByPath.get(path);
    if (!file) {
      result[path] = [1];
      continue;
    }
    const executableLines = new Set<number>();
    for (const location of Object.values(file.statementMap)) {
      for (let line = location.start.line; line <= location.end.line; line += 1) executableLines.add(line);
    }
    result[path] = [...executableLines].sort((left, right) => left - right);
  }
  return result;
}

function resolveMergeBase(cwd: string, requested?: string): string {
  const candidates = requested === undefined ? ['origin/main', 'origin/master', 'main', 'master', 'HEAD^'] : [requested];
  for (const candidate of candidates) {
    try {
      return execFileSync('git', ['merge-base', 'HEAD', candidate], { cwd, encoding: 'utf8' }).trim();
    } catch {
      // Try the next deterministic base candidate.
    }
  }
  throw new Error('unable to resolve merge base; pass --base-ref');
}

interface CliOptions {
  summaryPath: string;
  coveragePath: string;
  baselineSummaryPath?: string;
  baseRef?: string;
  criticalPrefixes: string[];
  unreachableExceptionsPath?: string;
  requireMergeBase: boolean;
}

function parseCli(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    summaryPath: 'coverage/ts-full/coverage-summary.json',
    coveragePath: 'coverage/ts-full/coverage-final.json',
    criticalPrefixes: [],
    requireMergeBase: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--require-merge-base') {
      options.requireMergeBase = true;
      continue;
    }
    if (flag === '--summary' && value) options.summaryPath = value;
    else if (flag === '--coverage' && value) options.coveragePath = value;
    else if (flag === '--baseline-summary' && value) options.baselineSummaryPath = value;
    else if (flag === '--base-ref' && value) options.baseRef = value;
    else if (flag === '--critical-prefix' && value) options.criticalPrefixes.push(value);
    else if (flag === '--unreachable-exceptions' && value) options.unreachableExceptionsPath = value;
    else throw new Error(`unknown or incomplete coverage option: ${flag ?? ''}`);
    index += 1;
  }
  return options;
}

interface CoverageLineException {
  file: string;
  lines: number[];
  source_sha256: string;
  rationale: string;
  invariant: string;
  reviewer: string;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function exceptionError(index: number, message: string): never {
  throw new Error(`coverage unreachable exception ${index}: ${message}`);
}

export function loadCoverageLineExceptions(input: {
  path: string;
  cwd: string;
  criticalFiles: readonly string[];
  changedLines: Readonly<Record<string, readonly number[]>>;
  coverage: CoverageFileMap;
}): Set<string> {
  const value = JSON.parse(readFileSync(input.path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !exactObjectKeys(value as Record<string, unknown>, ['schema_version', 'exceptions'])
    || (value as { schema_version?: unknown }).schema_version !== 1
    || !Array.isArray((value as { exceptions?: unknown }).exceptions)) {
    throw new Error('coverage unreachable exception manifest is malformed');
  }
  const entries = (value as { exceptions: unknown[] }).exceptions;
  if (entries.length > 64) throw new Error('coverage unreachable exception manifest exceeds 64 entries');
  const critical = new Set(input.criticalFiles.map(normalizedPath));
  const coverageByPath = new Map(Object.entries(input.coverage).map(([path, file]) => [normalizedPath(path), file]));
  const accepted = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
      || !exactObjectKeys(raw as Record<string, unknown>, [
        'file', 'lines', 'source_sha256', 'rationale', 'invariant', 'reviewer',
      ])) {
      exceptionError(index, 'entry is malformed');
    }
    const entry = raw as CoverageLineException;
    if (typeof entry.file !== 'string' || !entry.file.startsWith('src/')
      || entry.file.includes('..') || !entry.file.endsWith('.ts')) {
      exceptionError(index, 'file must be an exact relative production TypeScript path');
    }
    if (!Array.isArray(entry.lines) || entry.lines.length < 1 || entry.lines.length > 2
      || entry.lines.some((line) => !Number.isSafeInteger(line) || line < 1)
      || new Set(entry.lines).size !== entry.lines.length) {
      exceptionError(index, 'lines must contain one or two exact lines');
    }
    if (typeof entry.source_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.source_sha256)) {
      exceptionError(index, 'source_sha256 must be a lowercase SHA-256 digest');
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length < 40
      || typeof entry.invariant !== 'string' || entry.invariant.trim().length < 40
      || typeof entry.reviewer !== 'string' || entry.reviewer.trim().length < 10) {
      exceptionError(index, 'rationale, invariant, and reviewer evidence are required');
    }
    const sourcePath = normalizedPath(resolve(input.cwd, entry.file));
    if (!critical.has(sourcePath)) exceptionError(index, 'file is not in the critical coverage set');
    const measured = coverageByPath.get(sourcePath);
    if (measured === undefined) exceptionError(index, 'file is not present in measured coverage');
    const changed = new Set(input.changedLines[sourcePath] ?? []);
    const sourceLines = readFileSync(sourcePath, 'utf8').split(/\r?\n/u);
    for (const line of entry.lines) {
      if (!changed.has(line)) exceptionError(index, `line ${line} is not a changed line`);
      const statementIds = Object.entries(measured.statementMap)
        .filter(([, location]) => location.start.line <= line && location.end.line >= line)
        .map(([id]) => id);
      if (statementIds.length === 0) exceptionError(index, `line ${line} is not executable`);
      if (statementIds.some((id) => (measured.s[id] ?? 0) > 0)) {
        exceptionError(index, `line ${line} is already covered`);
      }
      const identity = `${sourcePath}:${line}`;
      if (accepted.has(identity)) exceptionError(index, `line ${line} is duplicated`);
      accepted.add(identity);
    }
    if (entry.lines.length === 2 && entry.lines[1] !== entry.lines[0]! + 1) {
      exceptionError(index, 'two-line exception must use adjacent executable lines');
    }
    const digest = createHash('sha256')
      .update(entry.lines.map((line) => `${line}:${sourceLines[line - 1] ?? ''}`).join('\n'))
      .digest('hex');
    if (digest !== entry.source_sha256) exceptionError(index, 'source hash does not match current lines');
  }
  return accepted;
}

export interface CoverageSpawnResult {
  error?: Error;
  status: number | null;
}

export type CoverageSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit' },
) => CoverageSpawnResult;

const defaultCoverageSpawn: CoverageSpawn = (command, args, options) => {
  const result = spawnSync(command, [...args], options);
  return { error: result.error, status: result.status };
};

export function measureMergeBaseCoverage(
  cwd: string,
  mergeBase: string,
  spawnCoverage: CoverageSpawn = defaultCoverageSpawn,
): CoverageMetrics {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'omx-coverage-base-'));
  const worktree = join(temporaryRoot, 'worktree');
  let added = false;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, mergeBase], { cwd, stdio: 'ignore' });
    added = true;
    symlinkSync(resolve(cwd, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    execFileSync('npm', ['run', 'build'], { cwd: worktree, stdio: 'inherit' });
    const summaryPath = join(worktree, 'coverage/ts-full/coverage-summary.json');
    const coverageRun = spawnCoverage('npm', ['run', 'coverage:ts:full:compiled'], {
      cwd: worktree,
      stdio: 'inherit',
    });
    if (coverageRun.error) throw coverageRun.error;
    if (!existsSync(summaryPath)) {
      throw new Error(`merge-base coverage did not emit a summary (exit ${coverageRun.status ?? 'unknown'})`);
    }
    if (coverageRun.status !== 0) {
      process.stderr.write('[coverage] merge-base tests reported failures; comparing the complete emitted coverage snapshot\n');
    }
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8')) as CoverageSummary;
    return summary.total;
  } finally {
    if (added) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd, stdio: 'ignore' });
      } catch {
        // The temporary directory cleanup below is authoritative for this ephemeral worktree.
      }
    }
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'ignore' });
    } catch {
      // Best-effort cleanup for stale metadata after an interrupted temporary worktree removal.
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function runCoverageCli(argv: readonly string[], cwd = process.cwd()): CoverageGateResult {
  const options = parseCli(argv);
  const summary = JSON.parse(readFileSync(resolve(cwd, options.summaryPath), 'utf8')) as CoverageSummary;
  const coverage = JSON.parse(readFileSync(resolve(cwd, options.coveragePath), 'utf8')) as CoverageFileMap;
  const mergeBase = resolveMergeBase(cwd, options.baseRef);
  const diff = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--unified=0', mergeBase, '--', 'src'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src'], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  const summaryFiles = Object.keys(summary).filter((path) => path !== 'total');
  const changedLines = addUntrackedChangedLines(parseChangedLines(diff, cwd), untracked, cwd, coverage);
  const touchedFiles = Object.keys(changedLines);
  const prefixes = options.criticalPrefixes.map((prefix) => normalizedPath(resolve(cwd, prefix)));
  const criticalFiles = [...new Set([...summaryFiles, ...touchedFiles]
    .filter((path) => prefixes.some((prefix) => normalizedPath(path).startsWith(prefix))))];
  const justifiedUnreachableLines = options.unreachableExceptionsPath === undefined
    ? new Set<string>()
    : loadCoverageLineExceptions({
      path: resolve(cwd, options.unreachableExceptionsPath),
      cwd,
      criticalFiles,
      changedLines,
      coverage,
    });
  const baselineTotal = options.baselineSummaryPath === undefined
    ? (options.requireMergeBase ? measureMergeBaseCoverage(cwd, mergeBase) : undefined)
    : (JSON.parse(readFileSync(resolve(cwd, options.baselineSummaryPath), 'utf8')) as CoverageSummary).total;
  return evaluateCoverageGate({
    summary,
    coverage,
    criticalFiles,
    touchedFiles,
    changedLines,
    baselineTotal,
    justifiedUnreachableLines,
  });
}

export function main(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  writeError: (message: string) => unknown = (message) => process.stderr.write(message),
): void {
  try {
    const result = runCoverageCli(argv, cwd);
    for (const failure of result.failures) writeError(`[coverage] ${failure.message}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    writeError(`[coverage] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
