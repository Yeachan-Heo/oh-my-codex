import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_TEST_TIMEOUT_MS = 0;
const DEFAULT_RUNNER_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_FORCE_EXIT_GRACE_MS = 30_000;
const DEFAULT_CI_TEST_CONCURRENCY = 1;
const RUNTIME_STATE_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
] as const;

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

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

function isWindows(): boolean {
  return process.platform === 'win32';
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
const forceExitGraceMs = parseTimeoutMs(process.env.OMX_NODE_TEST_FORCE_EXIT_GRACE_MS, DEFAULT_FORCE_EXIT_GRACE_MS);
const testConcurrency = parseTestConcurrency(process.env);
const forceExit = parseBooleanEnv(process.env.OMX_NODE_TEST_FORCE_EXIT);
const testArgs = ['--test'];
if (testTimeoutMs > 0) {
  testArgs.push(`--test-timeout=${testTimeoutMs}`);
}
if (testConcurrency) {
  testArgs.push(`--test-concurrency=${testConcurrency}`);
}
if (forceExit) {
  testArgs.push('--test-force-exit', '--test-reporter=tap');
}
testArgs.push(...files);

console.error(
  `[run-test-files] running ${files.length} test file(s) from ${targets.join(', ')}${
    testTimeoutMs > 0 ? ` with per-test timeout ${testTimeoutMs}ms` : ' with per-test timeout disabled'
  }${testConcurrency ? `, test concurrency ${testConcurrency}` : ', default test concurrency'}${
    forceExit ? `, force exit enabled with ${forceExitGraceMs}ms completion grace` : ', force exit disabled'
  }${runnerTimeoutMs > 0 ? `, and runner timeout ${runnerTimeoutMs}ms` : ', and runner timeout disabled'}`,
);

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
childEnv.OMX_TEST_RELAX_TMUX_TIMEOUT = '1';
if (!parseBooleanEnv(process.env.OMX_NODE_TEST_PRESERVE_RUNTIME_ENV)) {
  for (const key of RUNTIME_STATE_ENV_KEYS) {
    delete childEnv[key];
  }
}

function reportAbnormalExit(signal: NodeJS.Signals | null, errorMessage?: string): void {
  if (errorMessage) {
    console.error(`[run-test-files] node --test error: ${errorMessage}`);
  }
  console.error(
    `[run-test-files] node --test did not exit normally${signal ? ` (signal: ${signal})` : ''}. `
      + `Roots: ${targets.join(', ')}. Test files: ${files.length}. `
      + `Per-test timeout: ${testTimeoutMs > 0 ? `${testTimeoutMs}ms` : 'disabled'}. `
      + `Test concurrency: ${testConcurrency ?? 'default'}. `
      + `Force exit: ${forceExit ? 'enabled' : 'disabled'}. `
      + `Runner timeout: ${runnerTimeoutMs > 0 ? `${runnerTimeoutMs}ms` : 'disabled'}.`,
  );
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (!isWindows() && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore kill races. The child might have exited between detection and termination.
    }
  }
}

function terminateChild(child: ChildProcess): void {
  signalChild(child, 'SIGTERM');
  signalChild(child, 'SIGKILL');
}

function runWithCompletionForceExit(): void {
  let finished = false;
  let sawFailure = false;
  let lastTapOk = 0;
  let tapTests: number | undefined;
  let tapPass: number | undefined;
  let tapFail = 0;
  let tapCancelled = 0;
  let completedFromSummary = false;
  let completionTimer: NodeJS.Timeout | undefined;
  let runnerTimer: NodeJS.Timeout | undefined;
  let stdoutRemainder = '';
  let stderrRemainder = '';

  const child = spawn(process.execPath, testArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
    detached: !isWindows(),
  });

  function finish(exitCode: number, reason: string): void {
    if (finished) return;
    finished = true;
    if (completionTimer) clearTimeout(completionTimer);
    if (runnerTimer) clearTimeout(runnerTimer);
    console.error(`[run-test-files] ${reason}; exiting with status ${exitCode}`);
    terminateChild(child);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    process.exit(exitCode);
  }

  function markFailure(): void {
    sawFailure = true;
    if (completionTimer) {
      clearTimeout(completionTimer);
      completionTimer = undefined;
    }
  }

  function armCompletionTimer(reason: string): void {
    if (sawFailure) return;
    if (completionTimer) clearTimeout(completionTimer);
    completionTimer = setTimeout(() => {
      if (sawFailure) return;
      finish(0, reason);
    }, forceExitGraceMs);
  }

  function sawCleanTapSummary(): boolean {
    if (tapTests === undefined || tapPass === undefined) return false;
    return tapTests === tapPass && tapFail === 0 && tapCancelled === 0;
  }

  function parseTapLine(line: string): void {
    if (/^(?:not ok|Bail out!)/.test(line)) {
      markFailure();
      return;
    }

    const summary = line.match(/^# (tests|pass|fail|cancelled) (\d+)$/);
    if (summary) {
      const count = Number(summary[2]);
      if (summary[1] === 'tests') tapTests = count;
      if (summary[1] === 'pass') tapPass = count;
      if (summary[1] === 'fail') tapFail = count;
      if (summary[1] === 'cancelled') tapCancelled = count;
      if ((summary[1] === 'fail' || summary[1] === 'cancelled') && count > 0) markFailure();
      return;
    }

    const ok = line.match(/^ok (\d+)\b/);
    if (ok) {
      lastTapOk = Number(ok[1]);
      if (lastTapOk >= files.length) {
        armCompletionTimer(`force-exit completion grace elapsed after TAP ok ${lastTapOk} with no later failures`);
      }
      return;
    }

    const plan = line.match(/^1\.\.(\d+)$/);
    if (plan && Number(plan[1]) === lastTapOk && !sawFailure) {
      armCompletionTimer(`force-exit completion grace elapsed after TAP plan ${line}`);
      return;
    }

    if (/^# duration_ms /.test(line) && sawCleanTapSummary()) {
      completedFromSummary = true;
      armCompletionTimer('force-exit completion grace elapsed after clean TAP summary');
    }
  }

  function handleOutput(chunk: Buffer, stream: NodeJS.WriteStream, isStdout: boolean): void {
    stream.write(chunk);
    const text = chunk.toString('utf8');
    let combined = (isStdout ? stdoutRemainder : stderrRemainder) + text;
    const lines = combined.split(/\r?\n/);
    combined = lines.pop() ?? '';
    if (isStdout) {
      stdoutRemainder = combined;
    } else {
      stderrRemainder = combined;
    }
    for (const line of lines) parseTapLine(line);
  }

  child.stdout?.on('data', (chunk: Buffer) => handleOutput(chunk, process.stdout, true));
  child.stderr?.on('data', (chunk: Buffer) => handleOutput(chunk, process.stderr, false));

  child.on('error', (error) => {
    reportAbnormalExit(null, error.message);
    finish(1, 'node --test failed to spawn');
  });

  child.on('exit', (status, signal) => {
    if (finished) return;
    if (stdoutRemainder) parseTapLine(stdoutRemainder);
    if (stderrRemainder) parseTapLine(stderrRemainder);
    if (typeof status === 'number') {
      finish(status, `node --test exited normally${completedFromSummary ? ' after clean TAP summary' : ''}`);
      return;
    }
    reportAbnormalExit(signal);
    finish(1, 'node --test exited without a numeric status');
  });

  if (runnerTimeoutMs > 0) {
    runnerTimer = setTimeout(() => {
      reportAbnormalExit(null);
      finish(1, `runner timeout ${runnerTimeoutMs}ms elapsed`);
    }, runnerTimeoutMs);
  }
}

if (forceExit) {
  runWithCompletionForceExit();
} else {
  const result = spawnSync(process.execPath, testArgs, {
    stdio: 'inherit',
    env: childEnv,
    timeout: runnerTimeoutMs > 0 ? runnerTimeoutMs : undefined,
    killSignal: 'SIGTERM',
  });

  if (typeof result.status === 'number') {
    process.exit(result.status);
  }

  reportAbnormalExit(result.signal, result.error?.message);
  process.exit(1);
}
