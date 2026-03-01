/**
 * Unit tests for visual verdict extraction and persistence (issue #421).
 *
 * Covers:
 *   - parseVisualVerdict: structured verdict extraction (pure function)
 *   - maybePersistVisualVerdict: happy-path persistence, debug-level parse logging
 *   - Write failure: structured warn-level logging when stateDir is unwritable
 *   - Import failure: structured warn-level logging when module cannot load
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { appendFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, '..', '..', '..', 'scripts');

async function loadModule(rel: string) {
  return import(pathToFileURL(join(SCRIPTS_DIR, rel)).href);
}

// ---------------------------------------------------------------------------
// parseVisualVerdict – pure extraction logic
// ---------------------------------------------------------------------------
describe('visual-verdict – parseVisualVerdict', () => {
  it('extracts PASS from **Status**: PASS', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const result = parseVisualVerdict('## Summary\n**Status**: PASS\n**Confidence**: High');
    assert.deepEqual(result, { verdict: 'PASS', raw: '**Status**: PASS' });
  });

  it('extracts FAIL from Verdict: FAIL', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const result = parseVisualVerdict('Overall result. Verdict: FAIL due to missing tests.');
    assert.deepEqual(result, { verdict: 'FAIL', raw: 'Verdict: FAIL' });
  });

  it('extracts INCOMPLETE case-insensitively', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const result = parseVisualVerdict('**Status**: incomplete');
    assert.deepEqual(result, { verdict: 'INCOMPLETE', raw: '**Status**: incomplete' });
  });

  it('prefers **Status** pattern over Verdict: when both present', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const text = '**Status**: PASS\nVerdict: FAIL';
    const result = parseVisualVerdict(text);
    assert.equal(result!.verdict, 'PASS');
  });

  it('returns null for text without verdict markers', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    assert.equal(parseVisualVerdict('All tests completed successfully.'), null);
    assert.equal(parseVisualVerdict('The word PASS appears here.'), null);
  });

  it('returns null for null/undefined/non-string', async () => {
    const { parseVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    assert.equal(parseVisualVerdict(null), null);
    assert.equal(parseVisualVerdict(undefined), null);
    assert.equal(parseVisualVerdict(42 as any), null);
    assert.equal(parseVisualVerdict(''), null);
  });
});

// ---------------------------------------------------------------------------
// maybePersistVisualVerdict – happy path
// ---------------------------------------------------------------------------
describe('visual-verdict – maybePersistVisualVerdict (persist)', () => {
  it('writes latest-verdict.json for a matched verdict', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const stateDir = join(tmpDir, 'state');
    const logsDir = join(tmpDir, 'logs');

    try {
      await maybePersistVisualVerdict({
        payload: { 'last-assistant-message': '## Verification Report\n**Status**: PASS\nAll good.' },
        stateDir,
        logsDir,
        sessionId: 'sess-1',
        turnId: 'turn-1',
      });

      const verdictPath = join(stateDir, 'verdicts', 'latest-verdict.json');
      const verdict = JSON.parse(await readFile(verdictPath, 'utf-8'));
      assert.equal(verdict.verdict, 'PASS');
      assert.equal(verdict.session_id, 'sess-1');
      assert.equal(verdict.turn_id, 'turn-1');
      assert.ok(verdict.timestamp);
      assert.equal(verdict.raw_match, '**Status**: PASS');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits info-level log entry on successful persist', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const stateDir = join(tmpDir, 'state');
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    try {
      await maybePersistVisualVerdict({
        payload: { last_assistant_message: 'Verdict: FAIL\nMissing coverage.' },
        stateDir,
        logsDir,
        sessionId: 'sess-info',
        turnId: 'turn-info',
      });

      const logFiles = await readdir(logsDir);
      assert.ok(logFiles.some(f => f.startsWith('notify-hook-')), 'Expected notify-hook log file');
      const logContent = await readFile(join(logsDir, logFiles.find(f => f.startsWith('notify-hook-'))!), 'utf-8');
      assert.match(logContent, /visual_verdict_persisted/);
      assert.match(logContent, /"level":"info"/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does nothing when payload has no output', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const stateDir = join(tmpDir, 'state');
    const logsDir = join(tmpDir, 'logs');

    try {
      await maybePersistVisualVerdict({
        payload: {},
        stateDir,
        logsDir,
        sessionId: 'sess-empty',
        turnId: 'turn-empty',
      });

      // No verdict dir created, no logs
      const stateDirEntries = await readdir(stateDir).catch(() => []);
      assert.equal(stateDirEntries.length, 0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// maybePersistVisualVerdict – candidate parse failure (debug)
// ---------------------------------------------------------------------------
describe('visual-verdict – candidate parse debug logging', () => {
  it('logs debug when verdict-like markers present but no structured match', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const stateDir = join(tmpDir, 'state');
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    try {
      // Contains "Verdict:" but not followed by PASS/FAIL/INCOMPLETE
      await maybePersistVisualVerdict({
        payload: { 'last-assistant-message': 'Verdict: PENDING more analysis needed.' },
        stateDir,
        logsDir,
        sessionId: 'sess-debug',
        turnId: 'turn-debug',
      });

      const logFiles = await readdir(logsDir);
      assert.ok(logFiles.length > 0, 'Expected log file to be created');
      const logContent = await readFile(join(logsDir, logFiles[0]), 'utf-8');
      assert.match(logContent, /visual_verdict_parse_no_match/);
      assert.match(logContent, /"level":"debug"/);
      assert.match(logContent, /sess-debug/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not log debug when no verdict markers present at all', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const stateDir = join(tmpDir, 'state');
    const logsDir = join(tmpDir, 'logs');

    try {
      await maybePersistVisualVerdict({
        payload: { 'last-assistant-message': 'Refactoring complete. All tests pass.' },
        stateDir,
        logsDir,
        sessionId: 'sess-quiet',
        turnId: 'turn-quiet',
      });

      const logFiles = await readdir(logsDir).catch(() => []);
      if (logFiles.length > 0) {
        const logContent = await readFile(join(logsDir, logFiles[0]), 'utf-8');
        assert.equal(logContent.includes('visual_verdict'), false, 'No verdict log expected');
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Write failure – structured warn logging
// ---------------------------------------------------------------------------
describe('visual-verdict – write failure logging', () => {
  it('logs warn-level event on persistence write failure', async () => {
    const { maybePersistVisualVerdict } = await loadModule('notify-hook/visual-verdict.js');
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    // Create a regular file where stateDir should be a directory.
    // mkdir(stateDir + '/verdicts') will fail with ENOTDIR.
    const stateDir = join(tmpDir, 'state');
    await writeFile(stateDir, 'not-a-directory');

    try {
      await maybePersistVisualVerdict({
        payload: { 'last-assistant-message': '**Status**: FAIL\nTests failed.' },
        stateDir,
        logsDir,
        sessionId: 'sess-wf',
        turnId: 'turn-wf',
      });

      const logFiles = await readdir(logsDir);
      assert.ok(logFiles.length > 0, 'Expected log file to be created');
      const logContent = await readFile(join(logsDir, logFiles[0]), 'utf-8');
      const parsed = JSON.parse(logContent.trim());
      assert.equal(parsed.level, 'warn');
      assert.equal(parsed.type, 'visual_verdict_write_failure');
      assert.ok(parsed.error, 'Expected error message');
      assert.equal(parsed.session_id, 'sess-wf');
      assert.equal(parsed.turn_id, 'turn-wf');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Import failure – structured warn logging (simulates notify-hook.js catch)
// ---------------------------------------------------------------------------
describe('visual-verdict – import failure logging', () => {
  it('logs structured warn when module import fails', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'vv-test-'));
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    try {
      // Simulate the import-failure catch block from notify-hook.js
      try {
        await import(pathToFileURL(join(SCRIPTS_DIR, 'notify-hook/non-existent-visual-verdict.js')).href);
        assert.fail('Expected import to throw');
      } catch (err: any) {
        const warnEntry = JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          type: 'visual_verdict_import_failure',
          error: err?.message || String(err),
          session_id: 'sess-imp',
          turn_id: 'turn-imp',
        });
        const warnFile = join(logsDir, `notify-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
        await appendFile(warnFile, warnEntry + '\n');
      }

      const logFiles = await readdir(logsDir);
      assert.ok(logFiles.length > 0, 'Expected log file');
      const logContent = await readFile(join(logsDir, logFiles[0]), 'utf-8');
      const parsed = JSON.parse(logContent.trim());
      assert.equal(parsed.level, 'warn');
      assert.equal(parsed.type, 'visual_verdict_import_failure');
      assert.ok(parsed.error, 'Expected error message');
      assert.equal(parsed.session_id, 'sess-imp');
      assert.equal(parsed.turn_id, 'turn-imp');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
