import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hookLogPath, appendHookPluginLog } from '../logging.js';

describe('hookLogPath', () => {
  it('returns .omx/logs/hooks-<date>.jsonl path', () => {
    const result = hookLogPath('/project', new Date('2026-03-15T12:00:00Z'));
    assert.equal(result, join('/project', '.omx', 'logs', 'hooks-2026-03-15.jsonl'));
  });

  it('uses current date when no timestamp provided', () => {
    const result = hookLogPath('/project');
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(result, join('/project', '.omx', 'logs', `hooks-${today}.jsonl`));
  });
});

describe('appendHookPluginLog', () => {
  it('creates log directory and appends JSONL entry', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-log-'));
    try {
      const entry = {
        timestamp: '2026-01-15T10:00:00.000Z',
        event: 'session-start',
        plugin_id: 'my-plugin',
        status: 'ok',
      };

      await appendHookPluginLog(cwd, entry);

      const logFile = hookLogPath(cwd, new Date('2026-01-15T10:00:00.000Z'));
      const content = await readFile(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.timestamp, '2026-01-15T10:00:00.000Z');
      assert.equal(parsed.event, 'session-start');
      assert.equal(parsed.plugin_id, 'my-plugin');
      assert.equal(parsed.status, 'ok');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('appends multiple entries as separate lines', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-log-'));
    try {
      const ts = '2026-02-01T00:00:00.000Z';
      await appendHookPluginLog(cwd, { timestamp: ts, event: 'e1' });
      await appendHookPluginLog(cwd, { timestamp: ts, event: 'e2' });

      const logFile = hookLogPath(cwd, new Date(ts));
      const lines = (await readFile(logFile, 'utf-8')).trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).event, 'e1');
      assert.equal(JSON.parse(lines[1]).event, 'e2');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('uses current timestamp when entry has no timestamp', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-log-'));
    try {
      const before = new Date().toISOString();
      await appendHookPluginLog(cwd, { event: 'test-event' });

      const today = new Date().toISOString().slice(0, 10);
      const logFile = join(cwd, '.omx', 'logs', `hooks-${today}.jsonl`);
      const content = await readFile(logFile, 'utf-8');
      const parsed = JSON.parse(content.trim());
      assert.ok(parsed.timestamp >= before);
      assert.equal(parsed.event, 'test-event');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
