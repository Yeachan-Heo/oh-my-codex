import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

function readCiWorkflow(): string {
  const workflowPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
  assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);
  return readFileSync(workflowPath, 'utf-8');
}

function jobBlock(workflow: string, jobName: string): string {
  const startMatch = workflow.match(new RegExp(`(^|\n)  ${jobName}:\n`));
  assert.ok(startMatch?.index !== undefined, `missing CI job block for ${jobName}`);

  const start = startMatch.index + startMatch[1].length;
  const afterJobHeader = start + `  ${jobName}:\n`.length;
  const nextJobOffset = workflow.slice(afterJobHeader).search(/\n  [a-z0-9-]+:\n/);
  const end = nextJobOffset === -1 ? workflow.length : afterJobHeader + nextJobOffset;
  return workflow.slice(start, end);
}

function assertJobIf(workflow: string, jobName: string, expected: RegExp): void {
  assert.match(jobBlock(workflow, jobName), expected, `${jobName} should have the expected lane predicate`);
}

function classifyChangedPaths(paths: string[]): Record<string, string> {
  const workflow = readCiWorkflow();
  const changesJob = jobBlock(workflow, 'changes');
  const match = changesJob.match(/node <<'NODE'\n(?<script>[\s\S]*?)\n\s+NODE/);
  assert.ok(match?.groups?.script, 'missing inline changed-path classifier script');

  const cwd = mkdtempSync(join(tmpdir(), 'omx-ci-classifier-'));
  const outputPath = join(cwd, 'github-output.txt');
  try {
    writeFileSync(
      join(cwd, 'changed-files.tsv'),
      paths.map((path) => `M\t${path}`).join('\n'),
    );
    execFileSync(process.execPath, ['-e', match.groups.script], {
      cwd,
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        full_suite: 'false',
        reason: 'targeted',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return Object.fromEntries(
      readFileSync(outputPath, 'utf-8')
        .trim()
        .split(/\n/)
        .filter(Boolean)
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('CI Rust gates', () => {

  it('runs fork pull-request CI on GitHub-hosted runners instead of skipping lane detection', () => {
    const workflow = readCiWorkflow();
    const changesJob = jobBlock(workflow, 'changes');
    const ciStatusJob = jobBlock(workflow, 'ci-status');

    assert.doesNotMatch(changesJob, /head\.repo\.full_name == github\.repository/);
    assert.doesNotMatch(changesJob, /^\s+if:\s*github\.event_name != 'pull_request'/m);
    assert.match(changesJob, /^\s+runs-on:\s*ubuntu-latest$/m);
    assert.match(ciStatusJob, /^\s+runs-on:\s*ubuntu-latest$/m);
    assert.doesNotMatch(workflow, /runs-on:.*(?:self-hosted|gajae-layofflabs|gajae-code-heavy)/);
  });

  it('detects changed-file lanes once and exposes fail-closed outputs for targeted CI', () => {
    const workflow = readCiWorkflow();
    const changesJob = jobBlock(workflow, 'changes');

    assert.match(workflow, /changes:\s*\n\s+name:\s*Detect CI lanes/);
    for (const outputName of [
      'full_suite',
      'docs_changed',
      'docs_only',
      'ts_changed',
      'rust_changed',
      'native_changed',
      'shared_config_changed',
      'reason',
    ]) {
      assert.equal(changesJob.includes(`${outputName}: $` + `{{ steps.classify.outputs.${outputName} }}`), true);
    }

    assert.match(changesJob, /fetch-depth:\s*0/);
    assert.match(changesJob, /pull request targets main/);
    assert.match(changesJob, /push to main/);
    assert.match(changesJob, /missing or first-push base sha/);
    assert.match(changesJob, /unable to resolve diff commits/);
    assert.match(changesJob, /empty diff or classifier uncertainty/);
    assert.match(changesJob, /shared config, workflow, manifest, lockfile, or packaging change/);
  });

  it('classifies docs, TypeScript, Rust/native, shared config, renames, and unknown paths explicitly', () => {
    const workflow = readCiWorkflow();
    const changesJob = jobBlock(workflow, 'changes');

    assert.match(changesJob, /function pathsFromNameStatus/);
    assert.match(changesJob, /if \(\/\^\[RC\]\/\.test\(status\)\) return parts\.slice\(1, 3\)/);
    assert.match(changesJob, /function isDocs\(path\)/);
    assert.match(changesJob, /\^docs\\\//);
    assert.match(changesJob, /README\|CHANGELOG\|CONTRIBUTING\|COVERAGE\|DEMO\|RELEASE_BODY\|RELEASE_PROTOCOL/);
    assert.match(changesJob, /function isTs\(path\)/);
    assert.match(changesJob, /\^src\\\/\.\*\\\.\(ts\|tsx\|mts\|cts\)\$/);
    assert.match(changesJob, /function isRust\(path\)/);
    assert.match(changesJob, /Cargo\.lock/);
    assert.match(changesJob, /function isNative\(path\)/);
    assert.match(changesJob, /dist-workspace\.toml/);
    assert.match(changesJob, /function isSharedConfig\(path\)/);
    assert.match(changesJob, /\^\\\.github\\\//);
    assert.match(changesJob, /package\(-lock\)\?\\\.json/);
    assert.match(changesJob, /function isGjcPlanningEvidence\(path\)/);
    assert.match(changesJob, /function isGjcRuntimeAffecting\(path\)/);
    assert.match(changesJob, /const unknown = paths\.filter/);
  });

  it('keeps benign .gjc planning and quality evidence artifacts out of full-suite CI', () => {
    const result = classifyChangedPaths([
      '.gjc/plans/prd-issue-2663.md',
      '.gjc/ultragoal/ledger.jsonl',
      '.gjc/quality-gates/final-quality-gate.json',
      '.gjc/session-1/planning-evidence/test-spec.json',
    ]);

    assert.equal(result.full_suite, 'false');
    assert.equal(result.ts_changed, 'false');
    assert.equal(result.shared_config_changed, 'false');
    assert.equal(result.reason, 'gjc planning/evidence artifacts only');
  });

  it('routes runtime-affecting .gjc artifacts to the focused TypeScript/runtime gate without full-suite fallback', () => {
    const result = classifyChangedPaths(['.gjc/runtime/session-state.json']);

    assert.equal(result.full_suite, 'false');
    assert.equal(result.ts_changed, 'true');
    assert.equal(result.shared_config_changed, 'false');
    assert.match(result.reason, /gjc runtime-affecting artifact/);
  });

  it('keeps unknown .gjc paths fail-closed while preserving normal TS/config behavior', () => {
    const unknownGjc = classifyChangedPaths(['.gjc/random/output.bin']);
    assert.deepEqual(
      {
        full_suite: unknownGjc.full_suite,
        reason: unknownGjc.reason,
      },
      {
        full_suite: 'true',
        reason: 'unclassified path(s): .gjc/random/output.bin',
      },
    );

    const sourceChange = classifyChangedPaths(['src/verification/ci-status.ts']);
    assert.equal(sourceChange.full_suite, 'false');
    assert.equal(sourceChange.ts_changed, 'true');

    const compatFixtureChange = classifyChangedPaths(['src/compat/fixtures/doctor/install-onboarding.stdout.txt']);
    assert.equal(compatFixtureChange.full_suite, 'false');
    assert.equal(compatFixtureChange.ts_changed, 'true');
    assert.equal(compatFixtureChange.reason, 'targeted');

    const workflowChange = classifyChangedPaths(['.github/workflows/ci.yml']);
    assert.equal(workflowChange.full_suite, 'true');
    assert.equal(workflowChange.shared_config_changed, 'true');
    assert.equal(workflowChange.reason, 'shared config, workflow, manifest, lockfile, or packaging change');
  });

  it('reports lane-selection reason and actual failing gates in CI status output', () => {
    const statusJob = jobBlock(readCiWorkflow(), 'ci-status');

    assert.match(statusJob, /CI lane reason: \$\{REASON:-unknown\}/);
    assert.match(statusJob, /failing_active_gates=\(\)/);
    assert.match(statusJob, /failing_active_gates\+=\("\$name=\$result"\)/);
    assert.match(statusJob, /Actual failing active CI gate\(s\):/);
    assert.match(statusJob, /Lane-selection reason: \$\{REASON:-unknown\}; full_suite=\$\{FULL_SUITE:-unknown\}/);
  });

  it('gates expensive jobs by lane while preserving full-suite fail-closed behavior', () => {
    const workflow = readCiWorkflow();

    assertJobIf(workflow, 'docs-check', /full_suite == 'true'.*docs_changed == 'true'/s);
    for (const jobName of ['rustfmt', 'clippy', 'rust-tests']) {
      assertJobIf(workflow, jobName, /full_suite == 'true'.*rust_changed == 'true'.*native_changed == 'true'/s);
    }
    for (const jobName of ['lint', 'typecheck', 'test', 'coverage-team-critical', 'ralph-persistence-gate']) {
      assertJobIf(workflow, jobName, /full_suite == 'true'.*ts_changed == 'true'.*shared_config_changed == 'true'/s);
    }
    assertJobIf(
      workflow,
      'build-dist',
      /full_suite == 'true'.*ts_changed == 'true'.*rust_changed == 'true'.*native_changed == 'true'.*shared_config_changed == 'true'/s,
    );
    assertJobIf(workflow, 'build', /full_suite == 'true'.*rust_changed == 'true'.*native_changed == 'true'.*shared_config_changed == 'true'/s);
  });

  it('requires rustfmt, clippy, and Rust test coverage gates plus an explicit Rust toolchain setup for the final native build lane', () => {
    const workflow = readCiWorkflow();
    const rustTestsJob = jobBlock(workflow, 'rust-tests');

    assert.match(workflow, /rustfmt:/);
    assert.match(workflow, /components:\s*rustfmt/);
    assert.match(workflow, /cargo fmt --all --check/);

    assert.match(workflow, /clippy:/);
    assert.match(workflow, /components:\s*clippy/);
    assert.match(workflow, /cargo clippy --workspace --all-targets -- -D warnings/);

    assert.match(workflow, /rust-tests:/);
    assert.match(workflow, /name:\s*Rust Tests \+ Coverage Signal/);
    assert.match(workflow, /components:\s*llvm-tools-preview/);
    assert.match(workflow, /taiki-e\/install-action@cargo-llvm-cov/);
    assert.match(workflow, /cargo llvm-cov --workspace --summary-only/);
    assert.match(workflow, /cargo llvm-cov --manifest-path crates\/omx-sparkshell\/Cargo\.toml --summary-only/);
    assert.match(workflow, /cat coverage\/rust\/omx-sparkshell-summary\.txt/);
    assert.doesNotMatch(rustTestsJob, /--lcov|output-path|Upload Rust coverage artifact/);

    assert.match(
      workflow,
      /build:\s*\n(?:.*\n)*?\s+- name: Setup Rust\s*\n\s+uses: dtolnay\/rust-toolchain@v1\s*\n\s+with:\s*\n\s+toolchain: stable(?:.*\n)*?\s+- name: Download prebuilt dist artifact\s*\n\s+uses: actions\/download-artifact@v8(?:.*\n)*?\s+- run: npm run build:explore:release(?:.*\n)*?\s+- run: npm run build:sparkshell/m,
    );
  });

  it('reuses a prebuilt dist artifact on every compiled lane and also builds it for Rust/native changes', () => {
    const workflow = readCiWorkflow();
    const testJob = jobBlock(workflow, 'test');

    assert.match(workflow, /build-dist:/);
    assert.match(workflow, /name:\s*Build dist artifact/);
    assert.match(workflow, /name:\s*Upload prebuilt dist artifact/);
    assert.match(workflow, /name:\s*ci-dist-node20/);
    assert.match(jobBlock(workflow, 'build-dist'), /rust_changed == 'true'/);
    assert.match(jobBlock(workflow, 'build-dist'), /native_changed == 'true'/);
    assert.match(workflow, /^  coverage-team-critical:\s*\n(?:.*\n)*?^\s+needs:\s*\[changes, build-dist\]/m);
    assert.match(workflow, /^  ralph-persistence-gate:\s*\n(?:.*\n)*?^\s+needs:\s*\[changes, build-dist\]/m);
    assert.match(workflow, /^  build:\s*\n(?:.*\n)*?^\s+needs:\s*\[changes, build-dist\]/m);

    for (const jobName of ['test', 'coverage-team-critical', 'ralph-persistence-gate', 'build']) {
      assert.match(
        workflow,
        new RegExp(`^  ${jobName}:\\s*\\n(?:.*\\n)*?^\\s+- name:\\s*Download prebuilt dist artifact\\s*\\n\\s+uses:\\s*actions/download-artifact@v8`, 'm'),
      );
    }

    assert.match(
      testJob,
      /^\s+- name:\s*Download prebuilt dist artifact\s*\n\s+uses:\s*actions\/download-artifact@v8(?:.*\n)*?\s+path:\s*dist/m,
    );
    assert.match(testJob, /^\s+- name:\s*Run grouped full-suite lane\s*\n(?:.*\n)*?^\s+run:\s*\|\n\s+node dist\/scripts\/run-test-files\.js/m);
    assert.doesNotMatch(testJob, /^\s+npm run build$/m);
  });

  it('uses npm package caching without skipping clean dependency installs', () => {
    const workflow = readCiWorkflow();

    for (const jobName of ['lint', 'typecheck', 'build-dist', 'test', 'coverage-team-critical', 'ralph-persistence-gate', 'build']) {
      const job = jobBlock(workflow, jobName);

      assert.match(job, /uses:\s*actions\/setup-node@v7/);
      assert.match(job, /cache:\s*npm/);
      assert.match(job, /run:\s*npm ci/);
      assert.doesNotMatch(job, /uses:\s*actions\/cache@v4/);
      assert.doesNotMatch(job, /path:\s*node_modules/);
      assert.doesNotMatch(job, /cache-hit != 'true'/);
    }

    for (const jobName of ['clippy', 'rust-tests', 'build']) {
      assert.match(jobBlock(workflow, jobName), /uses:\s*Swatinem\/rust-cache@v2/);
    }

    assert.match(
      workflow,
      /needs:\s*\[changes, docs-check, rustfmt, clippy, rust-tests, lint, typecheck, build-dist, test, coverage-team-critical, ralph-persistence-gate, build\]/,
    );
  });

  it('avoids path-filtered CI triggers so required checks cannot be skipped into a pending state', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /^on:\n  push:\n    branches: \[main, dev, experimental\/dev\]\n  pull_request:\n    branches: \[main, dev, experimental\/dev\]/m);
    assert.doesNotMatch(workflow, /^\s+paths:\s*/m);
    assert.doesNotMatch(workflow, /^\s+paths-ignore:\s*/m);
  });

  it('marks every active CI lane as required and reported in the CI status gate while accepting inactive skipped lanes', () => {
    const workflow = readCiWorkflow();
    const ciStatusJob = jobBlock(workflow, 'ci-status');
    const requiredJobs = [
      'changes',
      'docs-check',
      'rustfmt',
      'clippy',
      'rust-tests',
      'lint',
      'typecheck',
      'build-dist',
      'test',
      'coverage-team-critical',
      'ralph-persistence-gate',
      'build',
    ];

    assert.match(
      ciStatusJob,
      /needs:\s*\[changes, docs-check, rustfmt, clippy, rust-tests, lint, typecheck, build-dist, test, coverage-team-critical, ralph-persistence-gate, build\]/,
    );

    for (const jobName of requiredJobs) {
      const envName = jobName.toUpperCase().replaceAll('-', '_');
      assert.equal(ciStatusJob.includes(`${envName}_RESULT: $` + `{{ needs.${jobName}.result }}`), true, `${jobName} result should be captured`);
      assert.match(ciStatusJob, new RegExp(`echo "  ${jobName}: \\$${envName}_RESULT"`), `${jobName} result should be reported`);
    }

    assert.match(ciStatusJob, /check_job\(\) \{/);
    assert.match(ciStatusJob, /must succeed when active/);
    assert.match(ciStatusJob, /inactive lane should be success or skipped/);
    assert.match(ciStatusJob, /docs_active=false/);
    assert.match(ciStatusJob, /rust_active=false/);
    assert.match(ciStatusJob, /ts_active=false/);
    assert.match(ciStatusJob, /dist_active=false/);
    assert.match(ciStatusJob, /build_active=false/);
    assert.match(ciStatusJob, /All required CI checks passed for active lanes/);
  });

  it('keeps expensive report-only coverage out of the required CI path', () => {
    const workflow = readCiWorkflow();

    assert.doesNotMatch(workflow, /^  coverage-ts-full:/m);
    assert.doesNotMatch(workflow, /needs\.coverage-ts-full\.result/);
  });

  it('runs typecheck once while retaining the Node 22 smoke lane for runtime coverage', () => {
    const workflow = readCiWorkflow();
    const typecheckJob = jobBlock(workflow, 'typecheck');
    const testJob = jobBlock(workflow, 'test');

    assert.doesNotMatch(typecheckJob, /matrix:/);
    assert.match(typecheckJob, /node-version:\s*20/);
    assert.match(testJob, /node-version:\s*22\n\s+lane:\s*smoke/);
  });

  it('adds timeout-minutes to every CI job so stalled Actions runs fail instead of hanging indefinitely', () => {
    const workflow = readCiWorkflow();

    for (const jobName of [
      'changes',
      'docs-check',
      'rustfmt',
      'clippy',
      'rust-tests',
      'lint',
      'typecheck',
      'build-dist',
      'test',
      'coverage-team-critical',
      'ralph-persistence-gate',
      'build',
      'ci-status',
    ]) {
      assert.match(
        workflow,
        new RegExp(`${jobName}:\\s*\\n(?:.*\\n)*?\\s+timeout-minutes:\\s*\\d+`, 'm'),
        `${jobName} should define timeout-minutes`,
      );
    }
  });
});
