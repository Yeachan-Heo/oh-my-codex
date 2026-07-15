import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

interface CapturedEnvironment {
  sandbox: string;
  cwd: string;
  values: Record<string, string | undefined>;
}

function runEnvironmentFixture(root: string, shouldFail: boolean): ReturnType<typeof spawnSync> {
  const poisonCwd = join(root, 'poison-cwd');
  const testPath = join(root, shouldFail ? 'failure.test.js' : 'success.test.js');
  const capture = join(root, shouldFail ? 'failure.json' : 'success.json');
  const runner = join(process.cwd(), 'dist', 'scripts', 'run-test-files.js');
  const packageRoot = process.cwd();
  const source = [
    "import assert from 'node:assert/strict';",
    "import { writeFileSync } from 'node:fs';",
    "import { test } from 'node:test';",
    "test('observes only the hermetic child environment', () => {",
    "  const values = Object.fromEntries(['HOME','USERPROFILE','XDG_CONFIG_HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','LANG','LC_ALL','TZ','OPENAI_MODEL','ANTHROPIC_MODEL','CLAUDE_MODEL','npm_config_cache','npm_config_userconfig','npm_config_registry'].map((key) => [key, process.env[key]]));",
    "  writeFileSync(process.env.TEST_ENV_CAPTURE, JSON.stringify({ sandbox: process.env.OMX_TEST_SANDBOX, cwd: process.cwd(), values }));",
    "  assert.equal(process.cwd(), process.env.OMX_TEST_CWD);",
    "  assert.equal(process.env.OPENAI_MODEL, undefined);",
    "  assert.equal(process.env.npm_config_registry, undefined);",
    shouldFail ? "  assert.fail('intentional fixture failure');" : "  assert.equal(process.env.TZ, 'UTC');",
    '});',
    '',
  ].join('\n');
  writeFileSync(testPath, source);
  return spawnSync(process.execPath, [runner, testPath], {
    cwd: poisonCwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(root, 'poison-home'),
      USERPROFILE: join(root, 'poison-userprofile'),
      XDG_CONFIG_HOME: join(root, 'poison-xdg'),
      CODEX_HOME: join(root, 'poison-codex'),
      CLAUDE_CONFIG_DIR: join(root, 'poison-claude'),
      OPENAI_MODEL: 'poison-openai-model',
      ANTHROPIC_MODEL: 'poison-anthropic-model',
      CLAUDE_MODEL: 'poison-claude-model',
      npm_config_cache: join(root, 'poison-npm-cache'),
      npm_config_userconfig: join(root, 'poison-npmrc'),
      npm_config_registry: 'https://poison.invalid/',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      TZ: 'Asia/Shanghai',
      TEST_ENV_CAPTURE: capture,
      OMX_NODE_TEST_ISOLATE_CWD: '1',
      OMX_NODE_TEST_PACKAGE_ROOT: packageRoot,
    },
    timeout: 10_000,
  });
}

describe('per-file test environment isolation', () => {
  for (const shouldFail of [false, true]) {
    it(`isolates poisoned config and cleans the sandbox after ${shouldFail ? 'failure' : 'success'}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-test-environment-'));
      try {
        await mkdir(join(root, 'poison-cwd'), { recursive: true });
        const result = runEnvironmentFixture(root, shouldFail);
        assert.equal(result.status === 0, !shouldFail, String(result.stderr || result.stdout));
        const capturePath = join(root, shouldFail ? 'failure.json' : 'success.json');
        const captured = JSON.parse(await readFile(capturePath, 'utf8')) as CapturedEnvironment;
        assert.equal(captured.cwd.startsWith(captured.sandbox), true);
        for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'npm_config_cache', 'npm_config_userconfig']) {
          assert.equal(captured.values[key]?.startsWith(captured.sandbox), true, key);
        }
        assert.deepEqual(
          [captured.values.LANG, captured.values.LC_ALL, captured.values.TZ],
          ['C', 'C', 'UTC'],
        );
        assert.equal(captured.values.OPENAI_MODEL, undefined);
        assert.equal(captured.values.ANTHROPIC_MODEL, undefined);
        assert.equal(captured.values.CLAUDE_MODEL, undefined);
        assert.equal(captured.values.npm_config_registry, undefined);
        assert.equal(existsSync(captured.sandbox), false, 'runner must clean per-file sandbox');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
