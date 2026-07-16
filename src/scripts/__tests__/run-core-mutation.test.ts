import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyMutant,
  collectProductionMutationManifest,
  compileMutatedTypeScript,
  discoverMutants,
  evaluateMutationGate,
  main,
  PRODUCTION_MUTATION_TARGETS,
  runCoreMutationGate,
  runOneMutant,
  runMutationTestProcess,
  type Mutant,
  type MutationTarget,
  type MutationOperator,
} from '../run-core-mutation.js';

const SOURCE = `
export function decide(flag: boolean, count: number, items: string[]): boolean {
  if (flag === true && count < 3) {
    items.push('accepted');
    return true;
  }
  return false;
}
`;

describe('project-owned mutation runner', () => {
  it('discovers every required decision mutation operator', () => {
    const operators = new Set(discoverMutants(SOURCE, 'src/fixture.ts').map((mutant) => mutant.operator));
    const expected: MutationOperator[] = [
      'boolean-negation',
      'comparison-boundary',
      'branch-removal',
      'return-replacement',
      'collection-update-removal',
    ];
    for (const operator of expected) assert.ok(operators.has(operator), `missing ${operator}`);
  });

  it('does not emit observably empty null-to-undefined return replacements', () => {
    const mutants = discoverMutants('export function empty() { return null; }', 'src/empty.ts');
    assert.equal(mutants.some((mutant) => mutant.operator === 'return-replacement'), false);
  });

  it('keeps every required operator and classification in the real production manifest', async () => {
    const manifest = await collectProductionMutationManifest();
    assert.equal(manifest.length, PRODUCTION_MUTATION_TARGETS.length);
    const operators = new Set(manifest.flatMap((entry) => entry.mutants.map((mutant) => mutant.operator)));
    const classifications = new Set(manifest.map((entry) => entry.target.classification));
    assert.deepEqual([...classifications].sort(), ['core', 'critical', 'other']);
    for (const operator of [
      'boolean-negation',
      'comparison-boundary',
      'branch-removal',
      'return-replacement',
      'collection-update-removal',
    ] satisfies MutationOperator[]) {
      assert.ok(operators.has(operator), `production manifest is missing ${operator}`);
    }
    for (const file of [
      'src/code-review/verdict.ts',
      'src/code-review/scope.ts',
      'src/code-review/coordinator.ts',
      'src/code-review/evidence.ts',
      'src/code-review/capabilities.ts',
      'src/code-review/persistence.ts',
      'src/pipeline/orchestrator.ts',
      'src/pipeline/stages/code-review.ts',
      'src/pipeline/stages/rework.ts',
      'src/pipeline/review-verdict.ts',
      'src/state/skill-active.ts',
      'src/state/workflow-transition.ts',
      'src/scripts/check-coverage.ts',
      'src/scripts/run-core-mutation.ts',
    ]) {
      assert.ok(manifest.some((entry) => entry.target.file === file), `production manifest is missing ${file}`);
    }
    for (const [file, functionName] of [
      ['src/code-review/coordinator.ts', 'reconcileResultPublicationsTrusted'],
      ['src/code-review/coordinator.ts', 'finalizeReview'],
      ['src/code-review/evidence.ts', 'validateLaneResultEvidence'],
      ['src/code-review/scope.ts', 'resolveBase'],
      ['src/code-review/scope.ts', 'resolveFrozenCapabilityConfig'],
      ['src/code-review/capabilities.ts', 'resolveTrustedEquivalents'],
      ['src/code-review/capabilities.ts', 'deriveFrozenCapabilityConfigFromBaseFiles'],
      ['src/code-review/persistence.ts', 'runDurableTransaction'],
      ['src/code-review/persistence.ts', 'executePrepared'],
      ['src/code-review/persistence.ts', 'recoverDurableTransactions'],
      ['src/code-review/persistence.ts', 'recoverPendingReviewTransactions'],
      ['src/pipeline/orchestrator.ts', 'runPipeline'],
      ['src/pipeline/stages/code-review.ts', 'loadPersistedRuntimeArtifact'],
      ['src/pipeline/stages/code-review.ts', 'validateCodeReviewStageArtifacts'],
      ['src/pipeline/stages/code-review.ts', 'findSuccessorRuntimeArtifact'],
      ['src/pipeline/stages/code-review.ts', 'suggestedNextPhase'],
      ['src/pipeline/stages/rework.ts', 'isFreshReworkEvidence'],
      ['src/pipeline/stages/rework.ts', 'validateFreshReworkEvidence'],
      ['src/pipeline/review-verdict.ts', 'isCleanReviewVerdict'],
    ] as const) {
      assert.ok(
        manifest.some((entry) => entry.target.file === file
          && entry.target.functions.includes(functionName)),
        `production manifest is missing ${file}#${functionName}`,
      );
    }
  });

  it('binds convergence and persistence mutation targets to their compiled regression suites', () => {
    const orchestratorTarget = PRODUCTION_MUTATION_TARGETS.find((target) =>
      target.file === 'src/pipeline/orchestrator.ts'
      && target.classification === 'critical');
    assert.ok(orchestratorTarget, 'pipeline orchestrator must be a critical mutation target');
    assert.ok(orchestratorTarget.functions.includes('runPipeline'));
    assert.ok(orchestratorTarget.operators?.includes('branch-removal'));
    assert.ok(orchestratorTarget.operators?.includes('comparison-boundary'));
    assert.deepEqual(orchestratorTarget.testFiles, ['dist/pipeline/__tests__/orchestrator.test.js']);

    const persistenceTarget = PRODUCTION_MUTATION_TARGETS.find((target) =>
      target.file === 'src/code-review/persistence.ts'
      && target.classification === 'critical');
    assert.ok(persistenceTarget, 'persistence transaction/recovery must be a critical mutation target');
    for (const functionName of [
      'runDurableTransaction',
      'executePrepared',
      'recoverDurableTransactions',
      'recoverPendingReviewTransactions',
    ]) {
      assert.ok(persistenceTarget.functions.includes(functionName), `missing persistence target ${functionName}`);
    }
    assert.ok(persistenceTarget.operators?.includes('branch-removal'));
    assert.ok(persistenceTarget.operators?.includes('return-replacement'));
    assert.match(persistenceTarget.testNamePattern ?? '', /COMMITTED/);
    assert.match(persistenceTarget.testNamePattern ?? '', /crash boundary/);
    assert.deepEqual(persistenceTarget.testFiles, [
      'dist/code-review/__tests__/persistence.test.js',
      'dist/code-review/__tests__/persistence-edges.test.js',
    ]);
  });

  it('applies each mutant to only its bounded source span', () => {
    for (const mutant of discoverMutants(SOURCE, 'src/fixture.ts')) {
      const output = applyMutant(SOURCE, mutant);
      assert.notEqual(output, SOURCE);
      assert.equal(output.length, SOURCE.length - mutant.original.length + mutant.replacement.length);
      assert.ok(mutant.endLine > mutant.line || mutant.endColumn > mutant.column);
    }
  });

  it('classifies invalid mutated TypeScript as a build failure', () => {
    const result = compileMutatedTypeScript('export const broken = ;', 'src/broken.ts');
    assert.equal(result.status, 'build-failure');
    assert.ok(result.diagnostics.length > 0);
  });

  it('emits valid TypeScript and rejects a stale source span', () => {
    const compiled = compileMutatedTypeScript('export const value = true;', 'src/value.ts');
    assert.equal(compiled.status, 'compiled');
    assert.match(compiled.code ?? '', /value = true/);
    const mutant = discoverMutants(SOURCE, 'src/fixture.ts')[0]!;
    assert.throws(() => applyMutant(`changed${SOURCE}`, mutant), /source span no longer matches/);
  });

  it('classifies a failing test process as killed', async () => {
    const result = await runMutationTestProcess(process.execPath, ['-e', 'process.exit(1)'], 1_000);
    assert.equal(result.status, 'killed');
  });

  it('classifies a bounded hanging test process as timeout', async () => {
    const result = await runMutationTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 25);
    assert.equal(result.status, 'timeout');
  });

  it('covers both platform termination paths and the POSIX fallback on every host', async () => {
    const hanging = ['-e', 'setInterval(() => {}, 1000)'];
    const defaultWindowsPath = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'win32',
    });
    assert.equal(defaultWindowsPath.status, 'timeout');

    let windowsTreeKillCalled = false;
    const windowsPath = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'win32',
      killWindowsProcessTree: (pid) => {
        windowsTreeKillCalled = true;
        process.kill(pid, 'SIGKILL');
      },
    });
    assert.equal(windowsPath.status, 'timeout');
    assert.equal(windowsTreeKillCalled, true);

    const windowsFallback = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'win32',
      killWindowsProcessTree: (_pid, fallback) => { fallback(); },
    });
    assert.equal(windowsFallback.status, 'timeout');

    const windowsThrownFallback = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'win32',
      killWindowsProcessTree: () => { throw new Error('simulated taskkill failure'); },
    });
    assert.equal(windowsThrownFallback.status, 'timeout');

    const posixPath = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'linux',
      killProcessGroup: (pid) => { process.kill(pid, 'SIGKILL'); },
    });
    assert.equal(posixPath.status, 'timeout');

    const posixFallback = await runMutationTestProcess(process.execPath, hanging, 25, process.cwd(), {
      platform: 'linux',
      killProcessGroup: () => { throw new Error('simulated process-group failure'); },
    });
    assert.equal(posixFallback.status, 'timeout');
  });

  it('terminates the full spawned process tree on mutation timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-mutation-process-tree-'));
    const marker = join(root, 'orphan-survived');
    const grandchild = [
      "const { writeFileSync } = require('node:fs');",
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'alive'), 250);`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const parent = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');
    try {
      const result = await runMutationTestProcess(process.execPath, ['-e', parent], 50);
      assert.equal(result.status, 'timeout');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      assert.equal(existsSync(marker), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies a passing test process as a surviving mutant', async () => {
    const result = await runMutationTestProcess(process.execPath, ['-e', 'process.exit(0)'], 1_000);
    assert.equal(result.status, 'survived');
  });

  it('rejects invalid timeouts and child spawn failures', async () => {
    await assert.rejects(runMutationTestProcess(process.execPath, ['-e', ''], 0), /positive integer/);
    await assert.rejects(runMutationTestProcess('/definitely/missing/omx-command', [], 1_000));
  });

  it('fails the gate for an intentionally surviving critical mutant', () => {
    const result = evaluateMutationGate([
      { id: 'critical-survivor', classification: 'critical', status: 'survived' },
      { id: 'other-killed', classification: 'other', status: 'killed' },
    ]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.failures.some((failure) => failure.includes('critical-survivor')));
  });

  it('enforces core and other score floors while critical mutants remain 100% killed', () => {
    const result = evaluateMutationGate([
      { id: 'critical-killed', classification: 'critical', status: 'killed' },
      { id: 'core-killed-1', classification: 'core', status: 'killed' },
      { id: 'core-killed-2', classification: 'core', status: 'killed' },
      { id: 'core-killed-3', classification: 'core', status: 'killed' },
      { id: 'core-killed-4', classification: 'core', status: 'killed' },
      { id: 'core-survived', classification: 'core', status: 'survived' },
      { id: 'other-killed', classification: 'other', status: 'killed' },
    ]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.scores.critical, 100);
    assert.equal(result.scores.core, 80);
    assert.equal(result.scores.other, 100);
    assert.deepEqual(result.totals.critical, {
      total: 1,
      killed: 1,
      survived: 0,
      timeout: 0,
      buildFailure: 0,
    });
  });

  it('rejects a vacuous production category instead of reporting an empty 100% score', () => {
    const result = evaluateMutationGate([
      { id: 'critical-killed', classification: 'critical', status: 'killed' },
      { id: 'core-killed', classification: 'core', status: 'killed' },
    ]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.failures.includes('other mutation manifest produced no mutants'));
  });

  it('runs one mutated compiled copy in an isolated temporary package', async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'omx-mutation-test-'));
    const source = 'export function decide(): boolean { return true; }\n';
    const target: MutationTarget = {
      file: 'src/fixture.ts',
      classification: 'critical',
      functions: ['decide'],
      testFiles: ['dist/fixture.test.js'],
      testNamePattern: 'fixture mutant',
    };
    try {
      await mkdir(join(repositoryRoot, 'dist'), { recursive: true });
      await mkdir(join(repositoryRoot, 'node_modules'), { recursive: true });
      await writeFile(join(repositoryRoot, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(join(repositoryRoot, 'dist/fixture.js'), 'export function decide() { return true; }\n');
      await writeFile(join(repositoryRoot, 'dist/fixture.test.js'), [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { decide } from './fixture.js';",
        "test('fixture mutant', () => assert.equal(decide(), true));",
      ].join('\n'));
      const mutant = discoverMutants(source, target.file).find((candidate) =>
        candidate.operator === 'boolean-negation' && candidate.original === 'true');
      assert.ok(mutant);
      const result = await runOneMutant(repositoryRoot, target, source, mutant, 5_000);
      assert.equal(result.status, 'killed');

      const invalid: Mutant = { ...mutant, replacement: ')' };
      assert.equal((await runOneMutant(repositoryRoot, target, source, invalid, 5_000)).status, 'build-failure');
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  it('orchestrates the real manifest through an injected deterministic mutant process boundary', async () => {
    const output: string[] = [];
    const result = await runCoreMutationGate(process.cwd(), 1_000, {
      runMutant: async (_root, target, _source, mutant) => ({
        id: mutant.id,
        classification: target.classification,
        status: 'killed',
      }),
      write: (message) => output.push(message),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(result.totals.critical.total > 0);
    assert.ok(result.totals.core.total > 0);
    assert.ok(result.totals.other.total > 0);
    assert.match(output.join(''), /"span"/);
    assert.match(output.join(''), /--test-name-pattern/);
    assert.match(output.join(''), /run-test-files/);
    assert.match(output.join(''), /src\/pipeline\/orchestrator\.ts/);
    assert.match(output.join(''), /dist\/pipeline\/__tests__\/orchestrator\.test\.js/);
    assert.match(output.join(''), /src\/code-review\/persistence\.ts/);
    assert.match(output.join(''), /dist\/code-review\/__tests__\/persistence\.test\.js/);
    assert.match(output.join(''), /dist\/code-review\/__tests__\/persistence-edges\.test\.js/);
  });

  it('prints mutation summaries and reports execution errors through the executable entry point', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalExitCode = process.exitCode;
    try {
      await main(async () => evaluateMutationGate([
        { id: 'critical-killed', classification: 'critical', status: 'killed' },
        { id: 'core-killed', classification: 'core', status: 'killed' },
        { id: 'other-killed', classification: 'other', status: 'killed' },
      ]), (message) => stdout.push(message), (message) => stderr.push(message));
      assert.equal(process.exitCode, 0);
      assert.equal(stderr.length, 0);
      assert.match(stdout.join(''), /critical total=1/);

      await main(async () => { throw new Error('mutation exploded'); },
        (message) => stdout.push(message), (message) => stderr.push(message));
      assert.equal(process.exitCode, 1);
      assert.match(stderr.join(''), /mutation exploded/);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});
