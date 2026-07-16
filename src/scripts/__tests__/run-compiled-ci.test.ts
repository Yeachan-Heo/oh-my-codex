import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyCompiledCiRoot,
  compiledCiCommands,
  INSTALLED_PACKAGE_TEST_FILES,
} from '../run-compiled-ci.js';

async function write(root: string, path: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, '{}\n');
}

describe('compiled CI root contract', () => {
  it('classifies source and installed roots by their own legal inputs only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-compiled-ci-root-'));
    try {
      const source = join(root, 'source');
      const installed = join(root, 'installed');
      for (const path of [
        'src/catalog/manifest.json',
        'docs/troubleshooting.md',
        '.github/workflows/ci.yml',
        'package.json',
        'dist/cli/omx.js',
        'dist/scripts/run-test-files.js',
      ]) await write(source, path);
      for (const path of ['package.json', 'dist/cli/omx.js', 'dist/scripts/run-test-files.js']) {
        await write(installed, path);
      }

      assert.equal(classifyCompiledCiRoot(source), 'source');
      assert.equal(classifyCompiledCiRoot(installed), 'installed');
      assert.equal(classifyCompiledCiRoot(installed), 'installed', 'must not borrow sibling source sentinels');
      assert.throws(() => classifyCompiledCiRoot(join(root, 'missing')), /COMPILED_CI_ROOT_INVALID/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs only declared shipped tests from an isolated cwd for installed packages', () => {
    const commands = compiledCiCommands('installed');
    const testCommand = commands.find((command) => command.isolatedTests);
    assert.ok(testCommand);
    assert.deepEqual(testCommand.args, ['dist/scripts/run-test-files.js', ...INSTALLED_PACKAGE_TEST_FILES]);
    assert.deepEqual(INSTALLED_PACKAGE_TEST_FILES, [
      'dist/scripts/__tests__/smoke-packed-install.test.js',
      'dist/scripts/__tests__/code-review-installed-contract.test.js',
      'dist/cli/__tests__/nested-help-routing.test.js',
      'dist/cli/__tests__/mcp-parity.test.js',
    ]);
    assert.equal(commands.some((command) => command.args.includes('test:node')), false);
  });
});
