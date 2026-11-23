import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { computeOmxPluginCacheClaimDigest } from '../../cli/plugin-marketplace.js';

function runCompiledRunner(root: string, envOverrides: Record<string, string> = {}, timeoutMs = 15_000) {
  return spawnSync(process.execPath, ['dist/scripts/run-test-files.js', root], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...envOverrides,
    },
    timeout: timeoutMs,
  });
}

describe('run-test-files diagnostics', () => {
  it('isolates personal config and plugin caches per file without changing protected inputs or tool access', async () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const personalHome = realpathSync(mkdtempSync(join(wd, 'personal-home-')));
      const codexHome = join(personalHome, '.codex');
      const pluginCache = join(codexHome, 'plugins', 'cache', 'test-marketplace', 'oh-my-codex', '1.0.0');
      mkdirSync(join(pluginCache, '.codex-plugin'), { recursive: true });
      const protectedFiles = new Map([
        [join(codexHome, '.omx-config.json'), JSON.stringify({ agentReasoning: { explore: 'high' }, agentModels: { explore: 'personal-model' } })],
        [join(pluginCache, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-codex', version: '1.0.0' })],
      ]);
      for (const [path, content] of protectedFiles) writeFileSync(path, content);
      const markerPath = join(pluginCache, '.omx-complete');
      const marker = `${JSON.stringify({ version: '1.0.0', claimDigest: await computeOmxPluginCacheClaimDigest(pluginCache) })}\n`;
      writeFileSync(markerPath, marker);
      protectedFiles.set(markerPath, marker);

      const modelsUrl = pathToFileURL(resolve('dist/config/models.js')).href;
      const pathsUrl = pathToFileURL(resolve('dist/utils/paths.js')).href;
      const pluginUrl = pathToFileURL(resolve('dist/cli/plugin-marketplace.js')).href;
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir);
      for (const name of ['a', 'b']) {
        writeFileSync(join(testsDir, `${name}.test.js`), [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import { writeFileSync, mkdirSync } from 'node:fs';",
          "import { homedir } from 'node:os';",
          "import { join } from 'node:path';",
          "import { spawnSync } from 'node:child_process';",
          `import { getAgentReasoningOverride, getAgentModelOverride } from ${JSON.stringify(modelsUrl)};`,
          `import { codexHome } from ${JSON.stringify(pathsUrl)};`,
          `import { discoverOmxPluginCacheDirs } from ${JSON.stringify(pluginUrl)};`,
          "test('home is isolated before imports and remains overridable by fixtures', async () => {",
          `  const personalCodexHome = ${JSON.stringify(codexHome)};`,
          "  assert.equal(getAgentReasoningOverride('explore', personalCodexHome), 'high');",
          "  assert.equal(getAgentModelOverride('explore', personalCodexHome), 'personal-model');",
          `  assert.deepEqual(await discoverOmxPluginCacheDirs(personalCodexHome), [${JSON.stringify(pluginCache)}]);`,
          `  assert.notEqual(homedir(), ${JSON.stringify(personalHome)});`,
          "  assert.equal(process.env.HOME, homedir());",
          "  assert.equal(process.env.USERPROFILE, homedir());",
          "  assert.equal(getAgentReasoningOverride('explore'), undefined);",
          "  assert.equal(getAgentModelOverride('explore'), undefined);",
          "  assert.deepEqual(await discoverOmxPluginCacheDirs(codexHome()), []);",
          `  assert.equal(process.env.PATH, ${JSON.stringify(process.env.PATH)});`,
          `  assert.equal(process.env.TMPDIR, ${JSON.stringify(process.env.TMPDIR)});`,
          `  const tool = spawnSync(process.execPath, ['-e', ${JSON.stringify("process.stdout.write('tool reachable')")}], { encoding: 'utf8' });`,
          "  assert.equal(tool.status, 0, tool.stderr);",
          "  assert.equal(tool.stdout, 'tool reachable');",
          `  writeFileSync(${JSON.stringify(join(wd, `${name}-home.txt`))}, homedir());`,
          "  mkdirSync(codexHome(), { recursive: true });",
          "  writeFileSync(join(codexHome(), '.omx-config.json'), JSON.stringify({ agentReasoning: { explore: 'low' } }));",
          "  assert.equal(getAgentReasoningOverride('explore'), 'low');",
          `  process.env.HOME = ${JSON.stringify(personalHome)};`,
          `  process.env.USERPROFILE = ${JSON.stringify(personalHome)};`,
          "  assert.equal(getAgentReasoningOverride('explore'), 'high');",
          "});",
          '',
        ].join('\n'));
      }

      for (const forceExit of ['0', '1']) {
        const result = runCompiledRunner(testsDir, { HOME: personalHome, USERPROFILE: personalHome, OMX_NODE_TEST_FORCE_EXIT: forceExit });
        assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
        const homes = ['a', 'b'].map((name) => readFileSync(join(wd, `${name}-home.txt`), 'utf8'));
        assert.notEqual(homes[0], homes[1]);
        for (const home of homes) assert.equal(existsSync(home), false, 'completed test homes must be removed');
        for (const [path, content] of protectedFiles) assert.equal(readFileSync(path, 'utf8'), content);
      }
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('removes isolated homes after failing test files in both runner modes', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testPath = join(wd, 'failure.test.js');
      const homeRecord = join(wd, 'home.txt');
      writeFileSync(testPath, [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { writeFileSync } from 'node:fs';",
        "import { homedir } from 'node:os';",
        `writeFileSync(${JSON.stringify(homeRecord)}, homedir());`,
        "test('fails', () => assert.fail('expected fixture failure'));",
        '',
      ].join('\n'));
      for (const forceExit of ['0', '1']) {
        const result = runCompiledRunner(testPath, { OMX_NODE_TEST_FORCE_EXIT: forceExit });
        assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
        assert.match(result.stdout, /expected fixture failure/);
        assert.equal(existsSync(readFileSync(homeRecord, 'utf8')), false);
      }
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('keeps the isolated home until a force-terminated child closes', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const recordPath = join(wd, 'child-close.json');
      const preloadPath = join(wd, 'observe-close.mjs');
      writeFileSync(preloadPath, [
        "import childProcess from 'node:child_process';",
        "import { existsSync, writeFileSync } from 'node:fs';",
        "import { syncBuiltinESMExports } from 'node:module';",
        'const originalSpawn = childProcess.spawn;',
        'childProcess.spawn = (...args) => {',
        '  const child = originalSpawn(...args);',
        '  const home = args[2].env.HOME;',
        '  child.once(\'close\', () => {',
        `    writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ home, exists: existsSync(home) }));`,
        '  });',
        '  return child;',
        '};',
        'syncBuiltinESMExports();',
        '',
      ].join('\n'));
      const testPath = join(wd, 'exit-block.test.js');
      writeFileSync(testPath, [
        "import { test } from 'node:test';",
        "test('passes but cannot exit normally', () => {",
        "  process.on('SIGTERM', () => {});",
        "  process.on('exit', () => { while (true) {} });",
        '});',
        '',
      ].join('\n'));
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preloadPath).href, 'dist/scripts/run-test-files.js', testPath], {
        encoding: 'utf8',
        env: {
          ...process.env,
          OMX_NODE_TEST_FORCE_EXIT: '1',
          OMX_NODE_TEST_FORCE_EXIT_GRACE_MS: '100',
          OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '2000',
        },
        timeout: 5_000,
      });

      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /force-exit completion grace elapsed/);
      assert.equal(existsSync(recordPath), true, 'runner must observe child close before exiting');
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { home: string; exists: boolean };
      assert.equal(record.exists, true, 'isolated home must remain available until child close');
      assert.equal(existsSync(record.home), false, 'isolated home must be removed after child close');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('can preserve the caller home for explicit diagnostics independently of runtime env', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const home = join(wd, 'personal-home');
      mkdirSync(home);
      const markerPath = join(home, 'protected-input.txt');
      writeFileSync(markerPath, 'unchanged input\n');
      const testPath = join(wd, 'home-preserve.test.js');
      writeFileSync(testPath, [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { homedir } from 'node:os';",
        "test('home diagnostic opt-in does not preserve runtime env', () => {",
        `  assert.equal(homedir(), ${JSON.stringify(home)});`,
        `  assert.equal(process.env.HOME, ${JSON.stringify(home)});`,
        `  assert.equal(process.env.USERPROFILE, ${JSON.stringify(home)});`,
        "  assert.equal(process.env.CODEX_HOME, undefined);",
        "  assert.equal(process.env.OMX_ROOT, undefined);",
        "});",
        '',
      ].join('\n'));

      const result = runCompiledRunner(testPath, {
        HOME: home,
        USERPROFILE: home,
        OMX_NODE_TEST_PRESERVE_HOME: '1',
        CODEX_HOME: '/tmp/live-codex-home',
        OMX_ROOT: '/tmp/live-omx-root',
      });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(readFileSync(markerPath, 'utf8'), 'unchanged input\n');
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('applies a bounded node --test timeout so hanging tests fail with file context', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      const testPath = join(testsDir, 'hang.test.js');
      writeFileSync(
        testPath,
        [
          "import { test } from 'node:test';",
          "test('never resolves', async () => { await new Promise(() => setInterval(() => {}, 1_000)); });",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, {
        OMX_NODE_TEST_TIMEOUT_MS: '250',
        OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '750',
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /per-test timeout 250ms/);
      assert.match(result.stderr, /node --test did not exit normally|runner timeout 750ms/);
      assert.match(`${result.stdout}\n${result.stderr}`, /hang\.test\.js|never resolves|cancelled/i);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });


  it('can force-exit Node test runner after successful CI tests to avoid leaked-handle hangs', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'leaky-pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes but leaves an interval', () => { setInterval(() => {}, 1_000); });",
          '',
        ].join('\n'),
      );

      const withoutForceExit = runCompiledRunner(wd, { OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '750' }, 2_000);
      assert.notEqual(withoutForceExit.status, 0);
      assert.match(withoutForceExit.stderr, /force exit disabled/);
      assert.match(withoutForceExit.stderr, /did not exit normally|runner timeout 750ms/);

      const withForceExit = runCompiledRunner(
        wd,
        { OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '750', OMX_NODE_TEST_FORCE_EXIT: '1' },
        2_000,
      );
      assert.equal(withForceExit.status, 0, withForceExit.stderr || withForceExit.stdout);
      assert.match(withForceExit.stderr, /force exit enabled/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('script-level force exit terminates a completed test child that blocks process exit', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      const testPath = join(testsDir, 'exit-block.test.js');
      writeFileSync(
        testPath,
        [
          "import { test } from 'node:test';",
          `test(${JSON.stringify(testPath)}, () => { process.on('exit', () => { while (true) {} }); });`,
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(
        wd,
        {
          OMX_NODE_TEST_FORCE_EXIT: '1',
          OMX_NODE_TEST_FORCE_EXIT_GRACE_MS: '100',
          OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '2000',
        },
        4_000,
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /ok 1 - .*exit-block\.test\.js/);
      assert.match(result.stderr, /TAP ok 1 with no later failures/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('cancels script-level force exit when a later TAP failure appears', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'late-fail.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('passes first', () => {});",
          "test('fails shortly after the first ok line', async () => {",
          "  await new Promise((resolve) => setTimeout(resolve, 25));",
          "  assert.equal(1, 2);",
          "});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(
        wd,
        {
          OMX_NODE_TEST_FORCE_EXIT: '1',
          OMX_NODE_TEST_FORCE_EXIT_GRACE_MS: '200',
          OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '2000',
        },
        4_000,
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not ok|# fail [1-9]/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('preserves failing test status when script-level force exit is enabled', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'fail.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('fails', () => { assert.equal(1, 2); });",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(
        wd,
        {
          OMX_NODE_TEST_FORCE_EXIT: '1',
          OMX_NODE_TEST_FORCE_EXIT_GRACE_MS: '100',
          OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '2000',
        },
        4_000,
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /not ok|# fail [1-9]/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('applies the runner timeout per test file instead of skipping later files after cumulative runtime', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      for (const name of ['a-slow-pass.test.js', 'b-slow-pass.test.js']) {
        writeFileSync(
          join(testsDir, name),
          [
            "import { test } from 'node:test';",
            "test('passes after a short delay', async () => {",
            "  await new Promise((resolve) => setTimeout(resolve, 450));",
            "});",
            '',
          ].join('\n'),
        );
      }

      const result = runCompiledRunner(wd, { OMX_NODE_TEST_RUNNER_TIMEOUT_MS: '750' }, 3_000);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.doesNotMatch(result.stderr, /timeout before/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('logs that per-test timeout is disabled by default', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /per-test timeout disabled/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('serializes local test files by default to avoid runaway full-suite fan-out', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, { CI: 'false', GITHUB_ACTIONS: 'false' });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /test concurrency 1/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('serializes test files by default in CI to avoid cross-file child-process leaks', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, { CI: 'true' });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /test concurrency 1/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('honors an explicit test concurrency override in CI', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'pass.test.js'),
        [
          "import { test } from 'node:test';",
          "test('passes', () => {});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, { CI: 'true', OMX_NODE_TEST_CONCURRENCY: '2' });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /test concurrency 2/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('isolates process env mutations between test files', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'a-mutate-env.test.js'),
        [
          "import { test } from 'node:test';",
          "test('mutates process env', () => { process.env.OMX_TEST_FILE_LEAK = 'leaked'; });",
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(testsDir, 'b-observe-env.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('does not inherit prior file env mutation', () => {",
          "  assert.equal(process.env.OMX_TEST_FILE_LEAK, undefined);",
          "});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stderr, /per-file process isolation/);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('sanitizes live OMX runtime state env from child test processes by default', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'env-clean.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('runtime env is clean', () => {",
          "  assert.equal(process.env.OMX_ROOT, undefined);",
          "  assert.equal(process.env.OMX_STATE_ROOT, undefined);",
          "  assert.equal(process.env.OMX_TEAM_STATE_ROOT, undefined);",
          "  assert.equal(process.env.OMX_SESSION_ID, undefined);",
          "  assert.equal(process.env.OMX_RUNS_DIR, undefined);",
          "  assert.equal(process.env.OMXBOX_ACTIVE, undefined);",
          "  assert.equal(process.env.OMX_MADMAX_DETACHED_CONTEXT, undefined);",
          "  assert.equal(process.env.OMX_DEFAULT_STANDARD_MODEL, undefined);",
          "  assert.equal(process.env.USE_OMX_EXPLORE_CMD, undefined);",
          "  assert.equal(process.env.CODEX_SESSION_ID, undefined);",
          "  assert.equal(process.env.CODEX_HOME, undefined);",
          "  assert.equal(process.env.SESSION_ID, undefined);",
          "  assert.equal(process.env.TMUX, undefined);",
          "  assert.equal(process.env.TMUX_PANE, undefined);",
          "});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, {
        OMX_ROOT: '/tmp/live-omx-root',
        OMX_STATE_ROOT: '/tmp/live-omx-state-root',
        OMX_TEAM_STATE_ROOT: '/tmp/live-team-state-root',
        OMX_SESSION_ID: 'live-omx-session',
        OMX_RUNS_DIR: '/tmp/live-omx-runs',
        OMXBOX_ACTIVE: '1',
        OMX_MADMAX_DETACHED_CONTEXT: 'live-context',
        OMX_DEFAULT_STANDARD_MODEL: 'ambient-model',
        USE_OMX_EXPLORE_CMD: '1',
        CODEX_SESSION_ID: 'live-codex-session',
        CODEX_HOME: '/tmp/live-codex-home',
        SESSION_ID: 'live-shell-session',
        TMUX: '/tmp/live-tmux,1,2',
        TMUX_PANE: '%live',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('preserves explicit test-runner controls and explore harness override while scrubbing live runtime env', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'env-allowlist.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('runner env allowlist is narrow', () => {",
          "  assert.equal(process.env.OMX_EXPLORE_BIN, '/tmp/fake-explore');",
          "  assert.equal(process.env.OMX_RUNTIME_BINARY, '/tmp/fake-runtime');",
          "  assert.equal(process.env.OMX_NODE_TEST_CONCURRENCY, '1');",
          "  assert.equal(process.env.OMX_ROOT, undefined);",
          "  assert.equal(process.env.CODEX_HOME, undefined);",
          "});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, {
        OMX_EXPLORE_BIN: '/tmp/fake-explore',
        OMX_RUNTIME_BINARY: '/tmp/fake-runtime',
        OMX_NODE_TEST_CONCURRENCY: '1',
        OMX_ROOT: '/tmp/live-omx-root',
        CODEX_HOME: '/tmp/live-codex-home',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });

  it('can preserve live OMX runtime state env for explicit diagnostics', () => {
    const wd = mkdtempSync(join(tmpdir(), 'omx-run-test-files-'));
    try {
      const testsDir = join(wd, '__tests__');
      mkdirSync(testsDir, { recursive: true });
      writeFileSync(
        join(testsDir, 'env-preserve.test.js'),
        [
          "import { test } from 'node:test';",
          "import assert from 'node:assert/strict';",
          "test('runtime env is preserved', () => {",
          "  assert.equal(process.env.OMX_ROOT, '/tmp/live-omx-root');",
          "  assert.equal(process.env.OMX_SESSION_ID, 'live-omx-session');",
          "  assert.equal(process.env.USE_OMX_EXPLORE_CMD, '1');",
          "  assert.equal(process.env.CODEX_HOME, '/tmp/live-codex-home');",
          "});",
          '',
        ].join('\n'),
      );

      const result = runCompiledRunner(wd, {
        OMX_NODE_TEST_PRESERVE_RUNTIME_ENV: '1',
        OMX_ROOT: '/tmp/live-omx-root',
        OMX_SESSION_ID: 'live-omx-session',
        USE_OMX_EXPLORE_CMD: '1',
        CODEX_HOME: '/tmp/live-codex-home',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});
