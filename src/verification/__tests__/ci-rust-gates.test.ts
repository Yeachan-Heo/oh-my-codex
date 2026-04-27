import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readCiWorkflow(): string {
  const workflowPath = join(process.cwd(), '.github', 'workflows', 'ci.yml');
  assert.equal(existsSync(workflowPath), true, `missing workflow: ${workflowPath}`);
  return readFileSync(workflowPath, 'utf-8');
}

function jobBlock(workflow: string, jobName: string): string {
  const match = workflow.match(new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|\\Z)`, 'm'));
  assert.ok(match?.[0], `missing CI job block for ${jobName}`);
  return match[0];
}

describe('CI Rust gates', () => {
  it('requires rustfmt and clippy gates plus an explicit Rust toolchain setup for the final native build lane', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /rustfmt:/);
    assert.match(workflow, /components:\s*rustfmt/);
    assert.match(workflow, /cargo fmt --all --check/);

    assert.match(workflow, /clippy:/);
    assert.match(workflow, /components:\s*clippy/);
    assert.match(workflow, /cargo clippy --workspace --all-targets -- -D warnings/);

    assert.match(
      workflow,
      /build:\s*\n(?:.*\n)*?\s+- name: Setup Rust\s*\n\s+uses: dtolnay\/rust-toolchain@v1\s*\n\s+with:\s*\n\s+toolchain: stable(?:.*\n)*?\s+- name: Download prebuilt dist artifact\s*\n\s+uses: actions\/download-artifact@v8(?:.*\n)*?\s+- run: npm run build:explore:release(?:.*\n)*?\s+- run: npm run build:sparkshell/m,
    );
  });

  it('reuses a prebuilt dist artifact only on the gated lanes that can overlap prerequisite work', () => {
    const workflow = readCiWorkflow();
    const testJob = jobBlock(workflow, 'test');

    assert.match(workflow, /build-dist:/);
    assert.match(workflow, /name:\s*Build dist artifact/);
    assert.match(workflow, /name:\s*Upload prebuilt dist artifact/);
    assert.match(workflow, /name:\s*ci-dist-node20/);
    assert.match(workflow, /^  coverage-team-critical:\s*\n(?:.*\n)*?^\s+needs:\s*\[typecheck, build-dist\]/m);
    assert.match(workflow, /^  coverage-ts-full:\s*\n(?:.*\n)*?^\s+needs:\s*\[typecheck, build-dist\]/m);
    assert.match(workflow, /^  ralph-persistence-gate:\s*\n(?:.*\n)*?^\s+needs:\s*\[typecheck, build-dist\]/m);
    assert.match(workflow, /^  build:\s*\n(?:.*\n)*?^\s+needs:\s*\[rustfmt, clippy, lint, typecheck, build-dist, test, ralph-persistence-gate\]/m);

    for (const jobName of ['test', 'coverage-team-critical', 'coverage-ts-full', 'ralph-persistence-gate', 'build']) {
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

  it('avoids path-filtered CI triggers so required checks cannot be skipped into a pending state', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /^on:\n  push:\n    branches: \[main, dev, experimental\/dev\]\n  pull_request:\n    branches: \[main, dev, experimental\/dev\]/m);
    assert.doesNotMatch(workflow, /^\s+paths:\s*/m);
    assert.doesNotMatch(workflow, /^\s+paths-ignore:\s*/m);
  });


  it('uses the current crates/omx-sparkshell manifest for Rust coverage', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /crates\/omx-sparkshell\/Cargo\.toml/);
    assert.doesNotMatch(workflow, /native\/omx-sparkshell\/Cargo\.toml/);
  });

  it('marks rustfmt and clippy as required in the CI status gate', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /needs:\s*\[rustfmt, clippy, lint, typecheck, test, coverage-team-critical, coverage-ts-full, coverage-rust, ralph-persistence-gate, build\]/);
    assert.match(workflow, /needs\.rustfmt\.result/);
    assert.match(workflow, /needs\.clippy\.result/);
    assert.match(workflow, /echo "  rustfmt: \$\{\{ needs\.rustfmt\.result \}\}"/);
    assert.match(workflow, /echo "  clippy: \$\{\{ needs\.clippy\.result \}\}"/);
  });

  it('adds timeout-minutes to every CI job so stalled Actions runs fail instead of hanging indefinitely', () => {
    const workflow = readCiWorkflow();

    for (const jobName of [
      'rustfmt',
      'clippy',
      'lint',
      'typecheck',
      'build-dist',
      'test',
      'coverage-team-critical',
      'coverage-ts-full',
      'coverage-rust',
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

  it('uses the current sparkshell crate manifest in the Rust coverage lane', () => {
    const workflow = readCiWorkflow();

    assert.match(workflow, /cargo llvm-cov --manifest-path crates\/omx-sparkshell\/Cargo\.toml --summary-only/);
    assert.match(workflow, /cargo llvm-cov --manifest-path crates\/omx-sparkshell\/Cargo\.toml --lcov --output-path coverage\/rust\/omx-sparkshell\.lcov/);
    assert.doesNotMatch(workflow, /native\/omx-sparkshell\/Cargo\.toml/);
  });
});
