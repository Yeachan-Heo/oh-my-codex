import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  addUntrackedChangedLines,
  loadCoverageLineExceptions,
  DEFAULT_COVERAGE_POLICY,
  evaluateCoverageGate,
  main,
  measureMergeBaseCoverage,
  parseChangedLines,
  runCoverageCli,
  type CoverageFileMap,
  type CoverageSummary,
  type MetricName,
} from '../check-coverage.js';

function metric(pct: number) {
  return { total: 100, covered: pct, skipped: 0, pct };
}

function metrics(overrides: Partial<Record<MetricName, number>> = {}) {
  return {
    lines: metric(overrides.lines ?? 100),
    statements: metric(overrides.statements ?? 100),
    functions: metric(overrides.functions ?? 100),
    branches: metric(overrides.branches ?? 100),
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function createCoverageRepository(options: {
  baselineExitCode?: number;
  removeWorktreeGitFile?: boolean;
  writeBaseline?: boolean;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'omx-coverage-test-'));
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  writeFileSync(join(cwd, 'src/gate.ts'), 'export const gate = 1;\n');
  const baseline = { total: metrics({ lines: 80, statements: 80, functions: 90, branches: 70 }) };
  writeFileSync(join(cwd, 'write-coverage.cjs'), [
    "const fs = require('node:fs');",
    options.removeWorktreeGitFile ? "fs.rmSync('.git', { force: true });" : '',
    ...(options.writeBaseline === false ? [] : [
      "fs.mkdirSync('coverage/ts-full', { recursive: true });",
      `fs.writeFileSync('coverage/ts-full/coverage-summary.json', ${JSON.stringify(JSON.stringify(baseline))});`,
    ]),
    `process.exitCode = ${options.baselineExitCode ?? 0};`,
  ].filter(Boolean).join('\n'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e ""',
      'coverage:ts:full:compiled': 'node write-coverage.cjs',
    },
  }));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);
  git(cwd, ['add', 'src/gate.ts', 'write-coverage.cjs', 'package.json']);
  git(cwd, ['commit', '-m', 'baseline']);
  const base = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(join(cwd, 'src/gate.ts'), 'export const gate = 2;\n');
  mkdirSync(join(cwd, 'coverage/current'), { recursive: true });
  const sourcePath = resolve(cwd, 'src/gate.ts');
  const currentSummary: CoverageSummary = {
    total: metrics({ lines: 90, statements: 90, functions: 95, branches: 85 }),
    [sourcePath]: metrics(),
  };
  const currentCoverage: CoverageFileMap = {
    [sourcePath]: {
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 22 } } },
      s: { '0': 1 },
    },
  };
  writeFileSync(join(cwd, 'coverage/current/summary.json'), JSON.stringify(currentSummary));
  writeFileSync(join(cwd, 'coverage/current/final.json'), JSON.stringify(currentCoverage));
  writeFileSync(join(cwd, 'coverage/current/baseline.json'), JSON.stringify(baseline));
  return { cwd, base };
}

function fixture(overrides: {
  critical?: Partial<Record<MetricName, number>>;
  other?: Partial<Record<MetricName, number>>;
  total?: Partial<Record<MetricName, number>>;
  baseline?: Partial<Record<MetricName, number>>;
  uncoveredChangedLine?: boolean;
  changedCategory?: 'critical' | 'other';
  omitCritical?: boolean;
  omitOther?: boolean;
} = {}) {
  const criticalPath = '/repo/dist/critical.js';
  const otherPath = '/repo/dist/other.js';
  const summary: CoverageSummary = {
    total: metrics(overrides.total),
    ...(overrides.omitCritical ? {} : { [criticalPath]: metrics(overrides.critical) }),
    ...(overrides.omitOther ? {} : { [otherPath]: metrics(overrides.other) }),
  };
  const coverage: CoverageFileMap = {
    [criticalPath]: {
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
      },
      s: { '0': 1, '1': overrides.uncoveredChangedLine ? 0 : 1 },
    },
    [otherPath]: {
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
      },
      s: { '0': 1, '1': overrides.uncoveredChangedLine ? 0 : 1 },
    },
  };
  const changedPath = overrides.changedCategory === 'other' ? otherPath : criticalPath;
  return evaluateCoverageGate({
    summary,
    coverage,
    criticalFiles: [criticalPath],
    touchedFiles: [criticalPath, otherPath],
    changedLines: { [changedPath]: [2] },
    baselineTotal: overrides.baseline === undefined ? undefined : metrics(overrides.baseline),
    policy: DEFAULT_COVERAGE_POLICY,
  });
}

describe('checked coverage gate', () => {
  for (const metricName of ['lines', 'statements', 'functions', 'branches'] as const) {
    it(`exits non-zero when critical ${metricName} misses its floor`, () => {
      const result = fixture({ critical: { [metricName]: 0 } });
      assert.equal(result.exitCode, 1);
      assert.ok(result.failures.some((failure) => failure.code === `critical-${metricName}`));
    });
  }

  for (const metricName of ['lines', 'statements', 'functions', 'branches'] as const) {
    it(`exits non-zero when other-touched ${metricName} misses its floor`, () => {
      const result = fixture({ other: { [metricName]: 0 } });
      assert.equal(result.exitCode, 1);
      assert.ok(result.failures.some((failure) => failure.code === `other-touched-${metricName}`));
    });

    it(`exits non-zero when repository ${metricName} misses its floor`, () => {
      const result = fixture({ total: { [metricName]: 0 } });
      assert.equal(result.exitCode, 1);
      assert.ok(result.failures.some((failure) => failure.code === `repository-${metricName}`));
    });

    it(`exits non-zero when repository ${metricName} regresses from merge base`, () => {
      const result = fixture({ total: { [metricName]: 90 }, baseline: { [metricName]: 91 } });
      assert.equal(result.exitCode, 1);
      assert.ok(result.failures.some((failure) => failure.code === `merge-base-${metricName}`));
    });
  }

  it('exits non-zero when one changed executable line is uncovered', () => {
    const result = fixture({ uncoveredChangedLine: true });
    assert.equal(result.exitCode, 1);
    assert.ok(result.failures.some((failure) => failure.code === 'changed-lines'));
  });

  it('applies the changed-line requirement only to critical files while retaining touched-file floors', () => {
    // ASSERTION-CHANGE-JUSTIFIED: TESTING_CONSTRAINTS.md assigns 100% changed-line
    // coverage to critical workflow/state/hook modules; other touched modules are
    // governed by their independent 85/85/90/75 floors.
    const result = fixture({ uncoveredChangedLine: true, changedCategory: 'other' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.failures.some((failure) => failure.code === 'changed-lines'), false);
    assert.deepEqual(result.observed.changedLines, {
      total: 0,
      covered: 0,
      pct: 100,
      uncovered: [],
      // ASSERTION-CHANGE-JUSTIFIED: the gate now reports reviewed exact-line
      // exceptions separately so they cannot be confused with executed lines.
      justifiedUnreachable: [],
    });
  });

  it('attributes a changed line inside a multiline executable statement', () => {
    const criticalPath = '/repo/dist/critical.js';
    const result = evaluateCoverageGate({
      summary: { total: metrics(), [criticalPath]: metrics() },
      coverage: {
        [criticalPath]: {
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
          },
          s: { '0': 0 },
        },
      },
      criticalFiles: [criticalPath],
      touchedFiles: [criticalPath],
      changedLines: { [criticalPath]: [2] },
    });
    assert.ok(result.failures.some((failure) => failure.code === 'changed-lines'));
  });

  it('accepts only exact source-bound unreachable-line justifications', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-coverage-exceptions-'));
    try {
      mkdirSync(join(cwd, 'src'), { recursive: true });
      const sourcePath = resolve(cwd, 'src/critical.ts');
      const source = [
        'export function guarded(): never {',
        "  throw new Error('unreachable after validation');",
        '}',
      ].join('\n');
      writeFileSync(sourcePath, `${source}\n`);
      const selected = [2];
      const sourceSha256 = createHash('sha256')
        .update(selected.map((line) => `${line}:${source.split('\n')[line - 1]}`).join('\n'))
        .digest('hex');
      const manifestPath = join(cwd, 'coverage-unreachable-lines.json');
      const valid = {
        schema_version: 1,
        exceptions: [{
          file: 'src/critical.ts',
          lines: selected,
          source_sha256: sourceSha256,
          rationale: 'This defensive throw is downstream of the strict public parser.',
          invariant: 'Every caller supplies the already validated closed union payload.',
          reviewer: 'approved-remediation-plan/current-task',
        }],
      };
      writeFileSync(manifestPath, JSON.stringify(valid));
      const coverage: CoverageFileMap = {
        [sourcePath]: {
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 41 } },
            '1': { start: { line: 2, column: 2 }, end: { line: 2, column: 50 } },
            '2': { start: { line: 3, column: 0 }, end: { line: 3, column: 1 } },
          },
          s: { '0': 0, '1': 0, '2': 0 },
        },
      };
      const input = {
        path: manifestPath,
        cwd,
        criticalFiles: [sourcePath],
        changedLines: { [sourcePath]: [1, 2, 3] },
        coverage,
      };
      assert.deepEqual([...loadCoverageLineExceptions(input)], [`${sourcePath}:2`]);

      writeFileSync(manifestPath, '{}');
      assert.throws(() => loadCoverageLineExceptions(input), /manifest is malformed/i);

      writeFileSync(manifestPath, JSON.stringify({ ...valid, exceptions: [null] }));
      assert.throws(() => loadCoverageLineExceptions(input), /entry is malformed/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], file: '../critical.ts' }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /production TypeScript path/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], source_sha256: 'invalid' }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /lowercase SHA-256/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], rationale: 'too short' }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /reviewer evidence/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], source_sha256: '0'.repeat(64) }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /source hash/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], lines: [1, 2, 3] }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /one or two exact lines/i);

      writeFileSync(manifestPath, JSON.stringify({
        ...valid,
        exceptions: [{ ...valid.exceptions[0], lines: [1, 3] }],
      }));
      assert.throws(() => loadCoverageLineExceptions(input), /adjacent executable lines/i);

      writeFileSync(manifestPath, JSON.stringify(valid));
      coverage[sourcePath]!.s['1'] = 1;
      assert.throws(() => loadCoverageLineExceptions(input), /already covered/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('counts a validated unreachable critical line without hiding ordinary misses', () => {
    const criticalPath = '/repo/src/critical.ts';
    const result = evaluateCoverageGate({
      summary: { total: metrics(), [criticalPath]: metrics() },
      coverage: {
        [criticalPath]: {
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
            '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
          },
          s: { '0': 0, '1': 0 },
        },
      },
      criticalFiles: [criticalPath],
      touchedFiles: [criticalPath],
      changedLines: { [criticalPath]: [1, 2] },
      justifiedUnreachableLines: new Set([`${criticalPath}:1`]),
    });
    assert.equal(result.observed.changedLines.pct, 50);
    assert.deepEqual(result.observed.changedLines.justifiedUnreachable, [`${criticalPath}:1`]);
    assert.deepEqual(result.observed.changedLines.uncovered, [`${criticalPath}:2`]);
  });

  it('fails closed when a required critical or touched file is absent from coverage', () => {
    const critical = fixture({ omitCritical: true });
    assert.ok(critical.failures.some((failure) => failure.code === 'critical-file-missing'));
    const other = fixture({ omitOther: true });
    assert.ok(other.failures.some((failure) => failure.code === 'other-touched-file-missing'));
  });

  it('collects tracked hunk ranges and every executable line of untracked production TypeScript', () => {
    const tracked = parseChangedLines([
      '+++ b/src/tracked.ts',
      '@@ -1,0 +2,2 @@',
      '+++ b/src/ignored.test.ts',
      '@@ -1,0 +1 @@',
    ].join('\n'), '/repo');
    assert.deepEqual(tracked, { '/repo/src/tracked.ts': [2, 3] });

    const untrackedPath = '/repo/src/untracked.ts';
    const changed = addUntrackedChangedLines(
      tracked,
      Buffer.from('src/untracked.ts\0src/scripts/__tests__/ignored.ts\0src/types.d.ts\0'),
      '/repo',
      {
        [untrackedPath]: {
          statementMap: {
            '0': { start: { line: 2, column: 0 }, end: { line: 4, column: 1 } },
            '1': { start: { line: 7, column: 0 }, end: { line: 7, column: 10 } },
          },
          s: { '0': 1, '1': 1 },
        },
      },
    );
    assert.deepEqual(changed[untrackedPath], [2, 3, 4, 7]);
    assert.equal(changed['/repo/src/scripts/__tests__/ignored.ts'], undefined);
    assert.equal(changed['/repo/src/types.d.ts'], undefined);
  });

  it('resets the current file for deletions instead of attributing deleted hunks to the prior file', () => {
    const changed = parseChangedLines([
      '+++ b/src/kept.ts',
      '@@ -1 +1 @@',
      '+++ /dev/null',
      '@@ -4,2 +0,0 @@',
    ].join('\n'), '/repo');
    assert.deepEqual(changed, { '/repo/src/kept.ts': [1] });
    assert.throws(() => parseChangedLines('+++ "b/src/quoted.ts"', '/repo'), /malformed Git path header/);
  });

  it('retains an untracked production file missing from the coverage map so the gate fails closed', () => {
    const changed = addUntrackedChangedLines({}, 'src/unmeasured.ts\0', '/repo', {});
    assert.deepEqual(changed, { '/repo/src/unmeasured.ts': [1] });
  });

  it('passes only when every checked dimension is satisfied', () => {
    const result = fixture({ baseline: { lines: 99, statements: 99, functions: 99, branches: 99 } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failures, []);
  });

  it('does not report a regression when repository and baseline percentages are exactly equal', () => {
    const result = fixture({ baseline: { lines: 100, statements: 100, functions: 100, branches: 100 } });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.failures, []);
  });

  it('runs every CLI option against a real temporary Git repository', () => {
    const fixture = createCoverageRepository();
    try {
      const sourcePath = resolve(fixture.cwd, 'src/gate.ts');
      const coveragePath = join(fixture.cwd, 'coverage/current/final.json');
      const coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as CoverageFileMap;
      coverage[sourcePath]!.s['0'] = 0;
      writeFileSync(coveragePath, JSON.stringify(coverage));
      const sourceLine = readFileSync(sourcePath, 'utf8').trimEnd();
      writeFileSync(join(fixture.cwd, 'coverage-unreachable-lines.json'), JSON.stringify({
        schema_version: 1,
        exceptions: [{
          file: 'src/gate.ts',
          lines: [1],
          source_sha256: createHash('sha256').update(`1:${sourceLine}`).digest('hex'),
          rationale: 'The fixture records one reviewed defensive line for the CLI contract.',
          invariant: 'This synthetic fixture has no runtime path capable of executing the line.',
          reviewer: 'checked-coverage-test-reviewer',
        }],
      }));
      const args = [
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
        '--unreachable-exceptions', 'coverage-unreachable-lines.json',
        '--baseline-summary', 'coverage/current/baseline.json',
        '--base-ref', fixture.base,
        '--critical-prefix', 'src/gate.ts',
      ];
      const result = runCoverageCli(args, fixture.cwd);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.observed.changedLines, {
        total: 1,
        covered: 1,
        pct: 100,
        uncovered: [],
        // ASSERTION-CHANGE-JUSTIFIED: the CLI result exposes the exact reviewed
        // exceptions even when this fixture has none.
        justifiedUnreachable: [`${sourcePath}:1`],
      });
      assert.equal(runCoverageCli(args.filter((value, index) => !['--base-ref', fixture.base].includes(value)
        || (value === fixture.base && args[index - 1] !== '--base-ref')), fixture.cwd).exitCode, 0);
      assert.throws(() => runCoverageCli(['--unknown'], fixture.cwd), /unknown or incomplete coverage option/);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('keeps pipeline orchestrator and rework in the package critical coverage prefixes', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const scriptName of [
      'coverage:workflow-critical:compiled',
      'coverage:ts:full:checked:compiled',
    ]) {
      const script = packageJson.scripts?.[scriptName] ?? '';
      for (const prefix of [
        'src/pipeline/orchestrator.ts',
        'src/pipeline/stages/rework.ts',
      ]) {
        assert.match(
          script,
          new RegExp(`--critical-prefix ${prefix.replaceAll('/', '\\/')}`),
          `${scriptName} missing ${prefix}`,
        );
      }
    }
  });

  it('verifies an explicit base ref to a commit SHA before passing it to merge-base', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omx-coverage-base-sha-'));
    const oldPath = process.env.PATH;
    const oldGitArgLog = process.env.GIT_ARG_LOG;
    try {
      mkdirSync(join(cwd, 'bin'), { recursive: true });
      mkdirSync(join(cwd, 'coverage/current'), { recursive: true });
      mkdirSync(join(cwd, 'src'), { recursive: true });
      const sourcePath = resolve(cwd, 'src/gate.ts');
      const summary: CoverageSummary = {
        total: metrics({ lines: 90, statements: 90, functions: 95, branches: 85 }),
        [sourcePath]: metrics(),
      };
      const coverage: CoverageFileMap = {
        [sourcePath]: {
          statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 22 } } },
          s: { '0': 1 },
        },
      };
      writeFileSync(join(cwd, 'src/gate.ts'), 'export const gate = 2;\n');
      writeFileSync(join(cwd, 'coverage/current/summary.json'), JSON.stringify(summary));
      writeFileSync(join(cwd, 'coverage/current/final.json'), JSON.stringify(coverage));
      writeFileSync(join(cwd, 'coverage/current/baseline.json'), JSON.stringify({ total: summary.total }));
      const logPath = join(cwd, 'git-args.log');
      const verifiedSha = 'a'.repeat(40);
      const fakeGit = join(cwd, 'bin/git');
      writeFileSync(fakeGit, [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        'fs.appendFileSync(process.env.GIT_ARG_LOG, `${JSON.stringify(args)}\\n`);',
        `const verifiedSha = ${JSON.stringify(verifiedSha)};`,
        "if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'refs/heads/main^{commit}') {",
        '  console.log(verifiedSha);',
        '  process.exit(0);',
        '}',
        "if (args[0] === 'merge-base' && args[1] === 'HEAD' && args[2] === verifiedSha) {",
        '  console.log(verifiedSha);',
        '  process.exit(0);',
        '}',
        "if (args[0] === '-c' && args[1] === 'core.quotePath=false' && args[2] === 'diff') {",
        "  process.stdout.write('+++ b/src/gate.ts\\n@@ -1 +1 @@\\n');",
        '  process.exit(0);',
        '}',
        "if (args[0] === 'ls-files') process.exit(0);",
        "console.error(`unexpected git args ${JSON.stringify(args)}`);",
        'process.exit(7);',
      ].join('\n'));
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${join(cwd, 'bin')}:${oldPath ?? ''}`;
      process.env.GIT_ARG_LOG = logPath;

      const result = runCoverageCli([
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
        '--baseline-summary', 'coverage/current/baseline.json',
        '--base-ref', 'refs/heads/main',
        '--critical-prefix', 'src/gate.ts',
      ], cwd);
      assert.equal(result.exitCode, 0);
      const calls = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls[0], ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
      assert.deepEqual(calls[1], ['merge-base', 'HEAD', verifiedSha]);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldGitArgLog === undefined) delete process.env.GIT_ARG_LOG;
      else process.env.GIT_ARG_LOG = oldGitArgLog;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('measures a real detached merge base even when its historical tests report failure', () => {
    const fixture = createCoverageRepository({ baselineExitCode: 1 });
    const stderr: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = runCoverageCli([
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
        '--base-ref', fixture.base,
        '--critical-prefix', 'src/gate.ts',
        '--require-merge-base',
      ], fixture.cwd);
      assert.equal(result.exitCode, 0);
      assert.match(stderr.join(''), /merge-base tests reported failures/);
    } finally {
      process.stderr.write = originalWrite;
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when merge-base subprocess output is unavailable and still cleans temporary state', () => {
    const fixture = createCoverageRepository();
    let baselineEnvironment: NodeJS.ProcessEnv | undefined;
    try {
      assert.throws(() => measureMergeBaseCoverage(fixture.cwd, fixture.base, (_command, _args, options) => {
        baselineEnvironment = options.env;
        return {
          error: new Error('spawn unavailable'),
          status: null,
        };
      }), /spawn unavailable/);
      const canonicalTemporaryDirectory = realpathSync(tmpdir());
      assert.equal(baselineEnvironment?.TMPDIR, canonicalTemporaryDirectory);
      assert.equal(baselineEnvironment?.TMP, canonicalTemporaryDirectory);
      assert.equal(baselineEnvironment?.TEMP, canonicalTemporaryDirectory);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }

    const notARepository = mkdtempSync(join(tmpdir(), 'omx-coverage-nonrepo-'));
    try {
      assert.throws(() => measureMergeBaseCoverage(notARepository, 'missing'), /Command failed/);
    } finally {
      rmSync(notARepository, { recursive: true, force: true });
    }
  });

  it('fails closed when no merge base or baseline coverage summary can be resolved', () => {
    const fixture = createCoverageRepository({ writeBaseline: false });
    try {
      assert.throws(() => runCoverageCli([
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
        '--base-ref', 'definitely-missing',
      ], fixture.cwd), /unable to resolve merge base/);
      assert.throws(() => measureMergeBaseCoverage(fixture.cwd, fixture.base), /did not emit a summary/);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('fails closed after exhausting every default merge-base candidate', () => {
    const fixture = createCoverageRepository();
    try {
      const branch = git(fixture.cwd, ['branch', '--show-current']);
      git(fixture.cwd, ['checkout', '--detach']);
      git(fixture.cwd, ['branch', '-D', branch]);
      assert.throws(() => runCoverageCli([
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
      ], fixture.cwd), /unable to resolve merge base/);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('treats detached-worktree metadata cleanup as best effort after baseline measurement', () => {
    const fixture = createCoverageRepository({ removeWorktreeGitFile: true });
    try {
      assert.equal(measureMergeBaseCoverage(fixture.cwd, fixture.base).lines.pct, 80);
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });

  it('reports gate failures and thrown CLI errors through the executable entry point', () => {
    const fixture = createCoverageRepository();
    const stderr: string[] = [];
    const originalExitCode = process.exitCode;
    try {
      main(['--summary', 'missing.json'], fixture.cwd, (message) => stderr.push(message));
      assert.equal(process.exitCode, 1);
      assert.match(stderr.join(''), /coverage.*ENOENT/);

      stderr.length = 0;
      main([
        '--summary', 'coverage/current/summary.json',
        '--coverage', 'coverage/current/final.json',
        '--baseline-summary', 'coverage/current/baseline.json',
        '--base-ref', fixture.base,
      ], fixture.cwd, (message) => stderr.push(message));
      assert.equal(process.exitCode, 1);
      assert.match(stderr.join(''), /critical coverage has no measured files/);
    } finally {
      process.exitCode = originalExitCode;
      rmSync(fixture.cwd, { recursive: true, force: true });
    }
  });
});
