#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export type MutationOperator =
  | 'boolean-negation'
  | 'comparison-boundary'
  | 'branch-removal'
  | 'return-replacement'
  | 'collection-update-removal';

export type MutationClassification = 'critical' | 'core' | 'other';
export type MutationStatus = 'killed' | 'survived' | 'timeout' | 'build-failure';

export interface Mutant {
  id: string;
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  operator: MutationOperator;
  original: string;
  replacement: string;
  functionName?: string;
}

export interface MutationResult {
  id: string;
  classification: MutationClassification;
  status: MutationStatus;
}

export interface MutationGateResult {
  exitCode: 0 | 1;
  failures: string[];
  scores: Record<MutationClassification, number>;
  totals: Record<MutationClassification, MutationTotals>;
}

export interface MutationTotals {
  total: number;
  killed: number;
  survived: number;
  timeout: number;
  buildFailure: number;
}

export interface CompileMutationResult {
  status: 'compiled' | 'build-failure';
  code?: string;
  diagnostics: string[];
}

export interface MutationProcessResult {
  status: 'killed' | 'survived' | 'timeout';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function enclosingFunctionName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isFunctionExpression(current)) {
      return current.name && ts.isIdentifier(current.name) ? current.name.text : undefined;
    }
    if (ts.isArrowFunction(current) && ts.isVariableDeclaration(current.parent.parent) && ts.isIdentifier(current.parent.parent.name)) {
      return current.parent.parent.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function mutantFor(
  sourceFile: ts.SourceFile,
  file: string,
  node: ts.Node,
  operator: MutationOperator,
  replacement: string,
): Mutant {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const location = sourceFile.getLineAndCharacterOfPosition(start);
  const endLocation = sourceFile.getLineAndCharacterOfPosition(end);
  const original = sourceFile.text.slice(start, end);
  const id = createHash('sha256')
    .update(`${file}:${start}:${end}:${operator}:${replacement}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    file,
    start,
    end,
    line: location.line + 1,
    column: location.character + 1,
    endLine: endLocation.line + 1,
    endColumn: endLocation.character + 1,
    operator,
    original,
    replacement,
    functionName: enclosingFunctionName(node),
  };
}

function comparisonReplacement(kind: ts.SyntaxKind): string | undefined {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return '<=';
    case ts.SyntaxKind.LessThanEqualsToken: return '<';
    case ts.SyntaxKind.GreaterThanToken: return '>=';
    case ts.SyntaxKind.GreaterThanEqualsToken: return '>';
    default: return undefined;
  }
}

function returnReplacement(expression: ts.Expression): string | undefined {
  if (expression.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(expression) && expression.text === 'undefined')) return undefined;
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return 'false';
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return 'true';
  if (ts.isNumericLiteral(expression)) return expression.text === '0' ? '1' : '0';
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return "''";
  if (ts.isArrayLiteralExpression(expression)) return '[]';
  return 'undefined';
}

export function discoverMutants(source: string, file: string): Mutant[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const mutants: Mutant[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      mutants.push(mutantFor(sourceFile, file, node, 'boolean-negation', 'false'));
    } else if (node.kind === ts.SyntaxKind.FalseKeyword) {
      mutants.push(mutantFor(sourceFile, file, node, 'boolean-negation', 'true'));
    }

    if (ts.isBinaryExpression(node)) {
      const replacement = comparisonReplacement(node.operatorToken.kind);
      if (replacement !== undefined) {
        mutants.push(mutantFor(sourceFile, file, node.operatorToken, 'comparison-boundary', replacement));
      }
    }

    if (ts.isIfStatement(node) && node.expression.kind !== ts.SyntaxKind.FalseKeyword) {
      mutants.push(mutantFor(sourceFile, file, node.expression, 'branch-removal', 'false'));
    }

    if (ts.isReturnStatement(node) && node.expression) {
      const replacement = returnReplacement(node.expression);
      if (replacement !== undefined) {
        mutants.push(mutantFor(sourceFile, file, node.expression, 'return-replacement', replacement));
      }
    }

    if (ts.isExpressionStatement(node)
      && ts.isCallExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && ['push', 'add', 'set', 'delete'].includes(node.expression.expression.name.text)) {
      mutants.push(mutantFor(sourceFile, file, node, 'collection-update-removal', 'void 0;'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mutants;
}

export function applyMutant(source: string, mutant: Mutant): string {
  if (source.slice(mutant.start, mutant.end) !== mutant.original) {
    throw new Error(`mutant ${mutant.id} source span no longer matches`);
  }
  return `${source.slice(0, mutant.start)}${mutant.replacement}${source.slice(mutant.end)}`;
}

export function compileMutatedTypeScript(source: string, fileName: string): CompileMutationResult {
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      // The package is ESM, but transpileModule cannot discover package.json when given an in-memory .ts file.
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      sourceMap: true,
      esModuleInterop: true,
    },
  });
  const diagnostics = (output.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  if (diagnostics.length > 0) return { status: 'build-failure', diagnostics };
  return { status: 'compiled', code: output.outputText, diagnostics: [] };
}

export async function runMutationTestProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  cwd = process.cwd(),
): Promise<MutationProcessResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('mutation timeout must be a positive integer');
  return await new Promise((resolveResult, reject) => {
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(command, [...args], {
      cwd,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolveResult({
        status: timedOut ? 'timeout' : exitCode === 0 ? 'survived' : 'killed',
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export function evaluateMutationGate(results: readonly MutationResult[]): MutationGateResult {
  const scores = { critical: 100, core: 100, other: 100 } satisfies Record<MutationClassification, number>;
  const totals = Object.fromEntries(
    (['critical', 'core', 'other'] as const).map((classification) => [classification, {
      total: 0,
      killed: 0,
      survived: 0,
      timeout: 0,
      buildFailure: 0,
    }]),
  ) as Record<MutationClassification, MutationTotals>;
  const failures: string[] = [];
  for (const classification of ['critical', 'core', 'other'] as const) {
    const classified = results.filter((result) => result.classification === classification);
    const observed = totals[classification];
    observed.total = classified.length;
    observed.killed = classified.filter((result) => result.status === 'killed').length;
    observed.survived = classified.filter((result) => result.status === 'survived').length;
    observed.timeout = classified.filter((result) => result.status === 'timeout').length;
    observed.buildFailure = classified.filter((result) => result.status === 'build-failure').length;
    if (classified.length === 0) failures.push(`${classification} mutation manifest produced no mutants`);
    else scores[classification] = (observed.killed / classified.length) * 100;
  }
  for (const result of results) {
    if (result.classification === 'critical' && result.status !== 'killed') {
      failures.push(`critical mutant ${result.id} was ${result.status}`);
    }
  }
  if (scores.core + Number.EPSILON < 80) failures.push(`core mutation score ${scores.core.toFixed(2)}% is below 80%`);
  if (scores.other + Number.EPSILON < 70) failures.push(`other mutation score ${scores.other.toFixed(2)}% is below 70%`);
  return { exitCode: failures.length === 0 ? 0 : 1, failures, scores, totals };
}

export interface MutationTarget {
  file: string;
  classification: MutationClassification;
  functions: readonly string[];
  operators?: readonly MutationOperator[];
  testFiles: readonly string[];
  testNamePattern?: string;
}

export const PRODUCTION_MUTATION_TARGETS: readonly MutationTarget[] = [
  {
    file: 'src/code-review/verdict.ts',
    classification: 'critical',
    functions: ['reviewerTopologyFailures', 'synthesizeVerdict'],
    testFiles: ['dist/code-review/__tests__/verdict.test.js'],
  },
  {
    file: 'src/code-review/scope.ts',
    classification: 'critical',
    functions: ['pathMatchesExplicitScope', 'filterManifestFiles'],
    operators: ['boolean-negation', 'comparison-boundary', 'branch-removal', 'return-replacement'],
    testFiles: ['dist/code-review/__tests__/scope.test.js', 'dist/code-review/__tests__/scope-properties.test.js'],
  },
  {
    file: 'src/code-review/capabilities.ts',
    classification: 'critical',
    functions: ['evaluateCapabilityEvidence'],
    testFiles: ['dist/code-review/__tests__/capabilities.test.js'],
  },
  {
    file: 'src/state/skill-active.ts',
    classification: 'critical',
    functions: ['mergeSessionAwareSkillOverlay'],
    testFiles: [
      'dist/state/__tests__/code-review-overlay-properties.test.js',
      'dist/state/__tests__/code-review-overlay-failures.test.js',
    ],
  },
  {
    file: 'src/state/workflow-transition.ts',
    classification: 'critical',
    functions: ['evaluatePreToolUseGate', 'evaluateWorkflowTransition'],
    testFiles: [
      'dist/state/__tests__/planning-gate.test.js',
      'dist/state/__tests__/workflow-transition.test.js',
    ],
  },
  {
    file: 'src/scripts/codex-native-hook.ts',
    classification: 'critical',
    functions: [
      'buildCodeReviewStopOutput',
      'parseCodeReviewTerminalBriefFooter',
      'readCodeReviewFinalArtifact',
    ],
    testFiles: ['dist/scripts/__tests__/codex-native-hook.test.js'],
    testNamePattern: 'code-review terminal brief|fails closed for missing artifacts|fails closed on Stop when only a code-review overlay',
  },
  {
    file: 'src/scripts/check-coverage.ts',
    classification: 'critical',
    functions: ['evaluateCoverageGate'],
    testFiles: ['dist/scripts/__tests__/check-coverage.test.js'],
  },
  {
    file: 'src/scripts/run-core-mutation.ts',
    classification: 'critical',
    functions: ['evaluateMutationGate'],
    testFiles: ['dist/scripts/__tests__/run-core-mutation.test.js'],
  },
  {
    file: 'src/code-review/batching.ts',
    classification: 'core',
    functions: ['createBatchPlan', 'resolveBatchingConfig'],
    testFiles: ['dist/code-review/__tests__/batching.test.js'],
  },
  {
    file: 'src/pipeline/review-verdict.ts',
    classification: 'other',
    functions: ['isNonCleanReviewVerdict'],
    operators: ['boolean-negation', 'branch-removal', 'return-replacement'],
    testFiles: ['dist/pipeline/__tests__/review-verdict.test.js'],
  },
];

export async function collectProductionMutationManifest(
  repositoryRoot = process.cwd(),
): Promise<Array<{ target: MutationTarget; source: string; mutants: Mutant[] }>> {
  const manifest: Array<{ target: MutationTarget; source: string; mutants: Mutant[] }> = [];
  for (const target of PRODUCTION_MUTATION_TARGETS) {
    const source = await readFile(resolve(repositoryRoot, target.file), 'utf8');
    const mutants = discoverMutants(source, target.file).filter((mutant) =>
      mutant.functionName !== undefined
      && target.functions.includes(mutant.functionName)
      && (target.operators === undefined || target.operators.includes(mutant.operator)));
    if (mutants.length === 0) throw new Error(`mutation target ${target.file} produced no mutants`);
    manifest.push({ target, source, mutants });
  }
  const observedOperators = new Set(manifest.flatMap((entry) => entry.mutants.map((mutant) => mutant.operator)));
  for (const operator of [
    'boolean-negation',
    'comparison-boundary',
    'branch-removal',
    'return-replacement',
    'collection-update-removal',
  ] as const) {
    if (!observedOperators.has(operator)) throw new Error(`production mutation manifest produced no ${operator} mutant`);
  }
  return manifest;
}

export async function runOneMutant(
  repositoryRoot: string,
  target: MutationTarget,
  source: string,
  mutant: Mutant,
  timeoutMs: number,
): Promise<MutationResult> {
  const compiled = compileMutatedTypeScript(applyMutant(source, mutant), target.file);
  if (compiled.status === 'build-failure' || compiled.code === undefined) {
    return { id: mutant.id, classification: target.classification, status: 'build-failure' };
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'omx-mutation-'));
  try {
    await cp(resolve(repositoryRoot, 'dist'), join(temporaryRoot, 'dist'), { recursive: true });
    await cp(resolve(repositoryRoot, 'package.json'), join(temporaryRoot, 'package.json'));
    await symlink(resolve(repositoryRoot, 'node_modules'), join(temporaryRoot, 'node_modules'), 'dir');
    const relativeSource = relative('src', target.file).replace(/\.ts$/u, '.js');
    const compiledPath = join(temporaryRoot, 'dist', relativeSource);
    await mkdir(dirname(compiledPath), { recursive: true });
    await writeFile(compiledPath, compiled.code, 'utf8');
    const testFiles = target.testFiles.map((path) => join(temporaryRoot, path));
    const testArgs = target.testNamePattern === undefined
      ? [join(temporaryRoot, 'dist/scripts/run-test-files.js'), ...testFiles]
      : ['--test', '--test-name-pattern', target.testNamePattern, ...testFiles];
    const processResult = await runMutationTestProcess(
      process.execPath,
      testArgs,
      timeoutMs,
      temporaryRoot,
    );
    return { id: mutant.id, classification: target.classification, status: processResult.status };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runCoreMutationGate(
  repositoryRoot = process.cwd(),
  timeoutMs = Number(process.env.OMX_MUTATION_TIMEOUT_MS ?? 30_000),
  dependencies: {
    runMutant?: typeof runOneMutant;
    write?: (message: string) => unknown;
  } = {},
): Promise<MutationGateResult> {
  const executeMutant = dependencies.runMutant ?? runOneMutant;
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  const results: MutationResult[] = [];
  for (const { target, source, mutants } of await collectProductionMutationManifest(repositoryRoot)) {
    for (const mutant of mutants) {
      const command = target.testNamePattern === undefined
        ? `${process.execPath} dist/scripts/run-test-files.js ${target.testFiles.join(' ')}`
        : `${process.execPath} --test --test-name-pattern ${JSON.stringify(target.testNamePattern)} ${target.testFiles.join(' ')}`;
      const result = await executeMutant(repositoryRoot, target, source, mutant, timeoutMs);
      results.push(result);
      write(`${JSON.stringify({
        file: mutant.file,
        span: `${mutant.line}:${mutant.column}-${mutant.endLine}:${mutant.endColumn}`,
        operator: mutant.operator,
        command,
        status: result.status,
        classification: result.classification,
        id: mutant.id,
      })}\n`);
    }
  }
  return evaluateMutationGate(results);
}

export async function main(
  runGate: () => Promise<MutationGateResult> = () => runCoreMutationGate(),
  writeOutput: (message: string) => unknown = (message) => process.stdout.write(message),
  writeError: (message: string) => unknown = (message) => process.stderr.write(message),
): Promise<void> {
  try {
    const result = await runGate();
    for (const failure of result.failures) writeError(`[mutation] ${failure}\n`);
    const thresholds = { critical: 100, core: 80, other: 70 } as const;
    for (const classification of ['critical', 'core', 'other'] as const) {
      const observed = result.totals[classification];
      writeOutput(
        `[mutation] ${classification} total=${observed.total} killed=${observed.killed} survived=${observed.survived} timeout=${observed.timeout} build-failure=${observed.buildFailure} score=${result.scores[classification].toFixed(2)} threshold=${thresholds[classification]}\n`,
      );
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    writeError(`[mutation] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
