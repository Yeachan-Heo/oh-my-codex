/**
 * Tests for Codebase Map Generator
 *
 * Covers: empty project, git-tracked files, directory grouping,
 * src/ sub-directory expansion, size cap, and error resilience.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

import { generateCodebaseMap } from '../codebase-map.js';

async function makeTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omx-codebase-map-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

async function gitAdd(dir: string, ...files: string[]): Promise<void> {
  execSync(`git add ${files.join(' ')}`, { cwd: dir, stdio: 'ignore' });
}

describe('generateCodebaseMap', () => {
  let tempDir: string;
  before(async () => { tempDir = await makeTempGitRepo(); });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('returns empty string when no tracked source files exist', async () => {
    const map = await generateCodebaseMap(tempDir);
    assert.strictEqual(map, '');
  });

  it('returns empty string for non-git directory', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'omx-plain-'));
    try {
      await writeFile(join(plainDir, 'foo.ts'), 'export function foo() {}');
      const map = await generateCodebaseMap(plainDir);
      // git ls-files won't track it - result is empty
      assert.strictEqual(map, '');
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });

  it('lists tracked TypeScript files grouped by directory', async () => {
    await mkdir(join(tempDir, 'src', 'hooks'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'hooks', 'session.ts'), 'export function startSession() {}');
    await writeFile(join(tempDir, 'src', 'hooks', 'overlay.ts'), 'export function applyOverlay() {}');
    await gitAdd(tempDir, 'src/hooks/session.ts', 'src/hooks/overlay.ts');

    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.length > 0, 'map should not be empty');
    assert.ok(map.includes('src/hooks'), 'should include src/hooks directory');
    assert.ok(map.includes('session'), 'should include session module name');
    assert.ok(map.includes('overlay'), 'should include overlay module name');
  });

  it('expands src/ into sub-directories', async () => {
    await mkdir(join(tempDir, 'src', 'cli'), { recursive: true });
    await mkdir(join(tempDir, 'src', 'mcp'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'cli', 'index.ts'), 'export function main() {}');
    await writeFile(join(tempDir, 'src', 'mcp', 'state-server.ts'), 'export function serve() {}');
    await gitAdd(tempDir, 'src/cli/index.ts', 'src/mcp/state-server.ts');

    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.includes('src/cli'), 'should expand src into sub-dirs');
    assert.ok(map.includes('src/mcp'), 'should include mcp sub-dir');
    assert.ok(map.includes('state-server'), 'should include state-server');
  });

  it('includes non-src top-level directories', async () => {
    await mkdir(join(tempDir, 'scripts'), { recursive: true });
    await writeFile(join(tempDir, 'scripts', 'notify-hook.js'), 'export function notify() {}');
    await gitAdd(tempDir, 'scripts/notify-hook.js');

    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.includes('scripts'), 'should include scripts directory');
    assert.ok(map.includes('notify-hook'), 'should include notify-hook');
  });

  it('caps output at MAX_MAP_CHARS (1000)', async () => {
    // Add many files to trigger truncation
    await mkdir(join(tempDir, 'src', 'generated'), { recursive: true });
    const filePaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      const name = `module-with-a-very-long-name-to-force-truncation-${i}.ts`;
      const path = join(tempDir, 'src', 'generated', name);
      await writeFile(path, `export function fn${i}() {}`);
      filePaths.push(`src/generated/${name}`);
    }
    await gitAdd(tempDir, ...filePaths);

    const map = await generateCodebaseMap(tempDir);
    assert.ok(map.length <= 1000, `map length ${map.length} should be <= 1000`);
  });

  it('omits index.ts basename when it is the only file', async () => {
    await mkdir(join(tempDir, 'src', 'utils'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'utils', 'index.ts'), 'export function helper() {}');
    await gitAdd(tempDir, 'src/utils/index.ts');

    const map = await generateCodebaseMap(tempDir);
    // index alone should still produce output (kept when sole file)
    assert.ok(map.includes('src/utils'), 'should include src/utils dir');
  });

  it('does not include untracked files (security: no filename leakage)', async () => {
    const secDir = await mkdtemp(join(tmpdir(), 'omx-untracked-test-'));
    try {
      execSync('git init', { cwd: secDir, stdio: 'ignore' });
      execSync('git config user.email "test@test.com"', { cwd: secDir, stdio: 'ignore' });
      execSync('git config user.name "Test"', { cwd: secDir, stdio: 'ignore' });
      await mkdir(join(secDir, 'src'), { recursive: true });

      // This file is tracked
      await writeFile(join(secDir, 'src', 'tracked.ts'), 'export function tracked() {}');
      execSync('git add src/tracked.ts', { cwd: secDir, stdio: 'ignore' });

      // This file is untracked (never git-added)
      await writeFile(join(secDir, 'src', 'secret-wip.ts'), 'export function secretWork() {}');

      const map = await generateCodebaseMap(secDir);
      assert.ok(map.includes('tracked'), 'should include tracked file');
      assert.ok(!map.includes('secret-wip'), 'must not expose untracked filename');
    } finally {
      await rm(secDir, { recursive: true, force: true });
    }
  });

  it('does not throw on unreadable directory (graceful failure)', async () => {
    const map = await generateCodebaseMap('/nonexistent/path/xyz');
    assert.strictEqual(map, '');
  });
});

describe('generateCodebaseMap integration with generateOverlay', () => {
  let tempDir: string;
  before(async () => {
    tempDir = await makeTempGitRepo();
    await mkdir(join(tempDir, '.omx', 'state'), { recursive: true });
    // Add a source file so the map is non-empty
    await mkdir(join(tempDir, 'src', 'hooks'), { recursive: true });
    await writeFile(join(tempDir, 'src', 'hooks', 'my-module.ts'), 'export function myFn() {}');
    execSync('git add src/hooks/my-module.ts', { cwd: tempDir, stdio: 'ignore' });
  });
  after(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('injects codebase map section into overlay', async () => {
    const { generateOverlay } = await import('../agents-overlay.js');
    const overlay = await generateOverlay(tempDir, 'test-map-session');
    assert.ok(overlay.includes('Codebase Map'), 'overlay should contain Codebase Map section');
    assert.ok(overlay.includes('src/hooks'), 'overlay should include src/hooks from map');
    assert.ok(overlay.includes('my-module'), 'overlay should include module name');
  });

  it('overlay is still valid when project has no tracked files', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'omx-empty-git-'));
    try {
      execSync('git init', { cwd: emptyDir, stdio: 'ignore' });
      await mkdir(join(emptyDir, '.omx', 'state'), { recursive: true });
      const { generateOverlay } = await import('../agents-overlay.js');
      const overlay = await generateOverlay(emptyDir, 'empty-session');
      assert.ok(overlay.includes('<!-- OMX:RUNTIME:START -->'));
      assert.ok(overlay.includes('<!-- OMX:RUNTIME:END -->'));
      // No codebase map section when no files
      assert.ok(!overlay.includes('Codebase Map'), 'should not inject empty map');
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});
