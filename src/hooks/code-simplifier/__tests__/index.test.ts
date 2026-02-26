import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  isAlreadyTriggered,
  writeTriggerMarker,
  clearTriggerMarker,
  buildSimplifierMessage,
  getModifiedFiles,
  processCodeSimplifier,
  TRIGGER_MARKER_FILENAME,
} from '../index.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `omx-cs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "omx-test@example.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "OMX Test"', { cwd: dir, stdio: 'ignore' });

  writeFileSync(join(dir, 'tracked.ts'), 'export const tracked = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'deleted.ts'), 'export const removed = true;\n', 'utf-8');
  writeFileSync(join(dir, 'rename-old.ts'), 'export const renamed = true;\n', 'utf-8');

  execSync('git add tracked.ts deleted.ts rename-old.ts', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'ignore' });
}

function writeEnabledCodeSimplifierConfig(homeDir: string): void {
  const configDir = join(homeDir, '.omx');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({ codeSimplifier: { enabled: true, maxFiles: 5 } }, null, 2),
    'utf-8',
  );
}
describe('code-simplifier trigger marker', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('reports not triggered when marker absent', () => {
    assert.equal(isAlreadyTriggered(stateDir), false);
  });

  it('writes marker and detects it', () => {
    writeTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), true);
    assert.ok(existsSync(join(stateDir, TRIGGER_MARKER_FILENAME)));
  });

  it('clears marker', () => {
    writeTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), true);

    clearTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), false);
  });

  it('clear is idempotent when no marker exists', () => {
    clearTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), false);
  });

  it('writes marker with ISO timestamp content', () => {
    writeTriggerMarker(stateDir);
    const content = readFileSync(join(stateDir, TRIGGER_MARKER_FILENAME), 'utf-8');
    // ISO 8601 date pattern
    assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('creates state directory if it does not exist', () => {
    const nested = join(stateDir, 'deep', 'nested');
    assert.equal(existsSync(nested), false);

    writeTriggerMarker(nested);
    assert.ok(existsSync(nested));
    assert.ok(existsSync(join(nested, TRIGGER_MARKER_FILENAME)));
  });
});

describe('buildSimplifierMessage', () => {
  it('includes all file paths', () => {
    const msg = buildSimplifierMessage(['src/foo.ts', 'src/bar.tsx']);

    assert.match(msg, /src\/foo\.ts/);
    assert.match(msg, /src\/bar\.tsx/);
  });

  it('includes CODE SIMPLIFIER marker', () => {
    const msg = buildSimplifierMessage(['a.ts']);

    assert.match(msg, /\[CODE SIMPLIFIER\]/);
  });

  it('includes delegation instruction', () => {
    const msg = buildSimplifierMessage(['a.ts']);

    assert.match(msg, /@code-simplifier/);
  });

  it('formats file list with bullet points', () => {
    const msg = buildSimplifierMessage(['src/a.ts', 'src/b.ts']);
    const lines = msg.split('\n');
    const bullets = lines.filter((l) => l.trimStart().startsWith('- '));

    assert.equal(bullets.length, 2);
  });
});

describe('getModifiedFiles', () => {
  it('returns empty array for non-git directory', () => {
    const dir = makeTmpDir();
    try {
      const files = getModifiedFiles(dir);
      assert.deepEqual(files, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters by extension', () => {
    const dir = makeTmpDir();
    try {
      initGitRepo(dir);
      writeFileSync(join(dir, 'tracked.ts'), 'export const tracked = 2;\n', 'utf-8');
      const files = getModifiedFiles(dir, ['.py'], 10);
      assert.deepEqual(files, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects maxFiles limit', () => {
    const dir = makeTmpDir();
    try {
      initGitRepo(dir);
      writeFileSync(join(dir, 'tracked.ts'), 'export const tracked = 2;\n', 'utf-8');
      writeFileSync(join(dir, 'new-a.ts'), 'export const a = 1;\n', 'utf-8');
      writeFileSync(join(dir, 'new-b.ts'), 'export const b = 2;\n', 'utf-8');
      const files = getModifiedFiles(dir, ['.ts'], 2);
      assert.equal(files.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes modified and untracked files, excludes deleted and rename-old paths', () => {
    const dir = makeTmpDir();
    try {
      initGitRepo(dir);

      writeFileSync(join(dir, 'tracked.ts'), 'export const tracked = 2;\n', 'utf-8'); // M
      writeFileSync(join(dir, 'new-file.ts'), 'export const newFile = true;\n', 'utf-8'); // ??
      execSync('git mv rename-old.ts rename-new.ts', { cwd: dir, stdio: 'ignore' }); // R old -> new
      execSync('git rm deleted.ts', { cwd: dir, stdio: 'ignore' }); // D

      const files = getModifiedFiles(dir, ['.ts'], 20);

      assert.ok(files.includes('tracked.ts'));
      assert.ok(files.includes('new-file.ts'));
      assert.ok(files.includes('rename-new.ts'));
      assert.ok(!files.includes('deleted.ts'));
      assert.ok(!files.includes('rename-old.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processCodeSimplifier', () => {
  let stateDir: string;
  let cwd: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    stateDir = makeTmpDir();
    cwd = makeTmpDir();
    homeDir = makeTmpDir();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (typeof originalHome === 'string') {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }

    if (typeof originalUserProfile === 'string') {
      process.env.USERPROFILE = originalUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }

    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('returns not triggered when disabled (no config)', () => {
    // processCodeSimplifier reads ~/.omx/config.json and is disabled by default.
    const result = processCodeSimplifier(cwd, stateDir);

    assert.equal(result.triggered, false);
    assert.equal(result.message, '');
  });

  it('triggers deterministically when enabled config and modified files are present', () => {
    initGitRepo(cwd);
    writeEnabledCodeSimplifierConfig(homeDir);
    writeFileSync(join(cwd, 'tracked.ts'), 'export const changed = 2;\n', 'utf-8');

    const result = processCodeSimplifier(cwd, stateDir, homeDir);

    assert.equal(result.triggered, true);
    assert.match(result.message, /tracked\.ts/);
    assert.equal(isAlreadyTriggered(stateDir), true);
  });

  it('clears marker on second call after a successful trigger (cycle prevention)', () => {
    initGitRepo(cwd);
    writeEnabledCodeSimplifierConfig(homeDir);
    writeFileSync(join(cwd, 'tracked.ts'), 'export const changed = 2;\n', 'utf-8');

    const first = processCodeSimplifier(cwd, stateDir, homeDir);
    assert.equal(first.triggered, true);
    assert.equal(isAlreadyTriggered(stateDir), true);

    const second = processCodeSimplifier(cwd, stateDir, homeDir);
    assert.equal(second.triggered, false);
    assert.equal(isAlreadyTriggered(stateDir), false);
  });
});
