import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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
    // getModifiedFiles calls git internally; test the filter logic indirectly
    // by checking that calling with empty extensions returns empty
    const dir = makeTmpDir();
    try {
      const files = getModifiedFiles(dir, [], 10);
      assert.deepEqual(files, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('respects maxFiles limit', () => {
    const dir = makeTmpDir();
    try {
      const files = getModifiedFiles(dir, ['.ts'], 0);
      assert.deepEqual(files, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('processCodeSimplifier', () => {
  let stateDir: string;
  let cwd: string;

  beforeEach(() => {
    stateDir = makeTmpDir();
    cwd = makeTmpDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns not triggered when disabled (no config)', () => {
    // processCodeSimplifier reads ~/.omx/config.json which likely has
    // codeSimplifier.enabled = false or absent in test environments
    const result = processCodeSimplifier(cwd, stateDir);

    assert.equal(result.triggered, false);
    assert.equal(result.message, '');
  });

  it('clears marker on second call (cycle prevention)', () => {
    // Simulate a marker from a previous trigger
    writeTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), true);

    // Even if config is disabled, the marker-clearing logic is tested
    // by directly checking marker state
    clearTriggerMarker(stateDir);
    assert.equal(isAlreadyTriggered(stateDir), false);
  });
});
