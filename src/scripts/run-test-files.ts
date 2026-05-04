import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_TEST_TIMEOUT_MS = 0;
const DEFAULT_RUNNER_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_CI_TEST_CONCURRENCY = 1;

function collectTests(path: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      collectTests(join(path, entry), out);
    }
    return;
  }

  if (stats.isFile() && path.endsWith('.test.js')) {
    out.push(path);
  }
}

function parseTimeoutMs(value: string | undefined, defaultTimeoutMs: number): number {
  if (!value) return defaultTimeoutMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultTimeoutMs;
  return Math.floor(parsed);
}

function parseTestConcurrency(env: NodeJS.ProcessEnv): number | undefined {
  const rawValue = env.OMX_NODE_TEST_CONCURRENCY;
  if (rawValue) {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed);
    return undefined;
  }

  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true' ? DEFAULT_CI_TEST_CONCURRENCY : undefined;
}

const roots = process.argv.slice(2);
const targets = roots.length > 0 ? roots : ['dist'];
const files: string[] = [];
for (const target of targets) {
  collectTests(resolve(target), files);
}

files.sort();

if (files.length === 0) {
  console.error(`No test files found under: ${targets.join(', ')}`);
  process.exit(1);
}

const testTimeoutMs = parseTimeoutMs(process.env.OMX_NODE_TEST_TIMEOUT_MS, DEFAULT_TEST_TIMEOUT_MS);
const runnerTimeoutMs = parseTimeoutMs(process.env.OMX_NODE_TEST_RUNNER_TIMEOUT_MS, DEFAULT_RUNNER_TIMEOUT_MS);
const testConcurrency = parseTestConcurrency(process.env);
const testArgs = ['--test'];
if (testTimeoutMs > 0) {
  testArgs.push(`--test-timeout=${testTimeoutMs}`);
}
if (testConcurrency) {
  testArgs.push(`--test-concurrency=${testConcurrency}`);
}
testArgs.push(...files);

console.error(
  `[run-test-files] running ${files.length} test file(s) from ${targets.join(', ')}${
    testTimeoutMs > 0 ? ` with per-test timeout ${testTimeoutMs}ms` : ' with per-test timeout disabled'
  }${testConcurrency ? `, test concurrency ${testConcurrency}` : ', default test concurrency'}${
    runnerTimeoutMs > 0 ? `, and runner timeout ${runnerTimeoutMs}ms` : ', and runner timeout disabled'
  }`,
);

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
childEnv.OMX_TEST_RELAX_TMUX_TIMEOUT = '1';

const result = spawnSync(process.execPath, testArgs, {
  stdio: 'inherit',
  env: childEnv,
  timeout: runnerTimeoutMs > 0 ? runnerTimeoutMs : undefined,
  killSignal: 'SIGTERM',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.error) {
  console.error(`[run-test-files] node --test error: ${result.error.message}`);
}
console.error(
  `[run-test-files] node --test did not exit normally${result.signal ? ` (signal: ${result.signal})` : ''}. `
    + `Roots: ${targets.join(', ')}. Test files: ${files.length}. `
    + `Per-test timeout: ${testTimeoutMs > 0 ? `${testTimeoutMs}ms` : 'disabled'}. `
    + `Test concurrency: ${testConcurrency ?? 'default'}. `
    + `Runner timeout: ${runnerTimeoutMs > 0 ? `${runnerTimeoutMs}ms` : 'disabled'}.`,
);
process.exit(1);
