import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_NOTIFY_ARGV_JSON_BYTES,
  extractOversizedNotifyLogSummary,
} from '../../hook-payload-guard.js';

function notifyHookScriptPath(): string {
  return join(process.cwd(), 'dist', 'scripts', 'notify-hook.js');
}

describe('notify-hook raw payload guard', () => {
  it('extracts an oversized notify log summary without retaining the full array', () => {
    const raw = JSON.stringify({
      cwd: '/tmp/project',
      type: 'agent-turn-complete',
      'thread-id': 'thread-1',
      'turn-id': 'turn-1',
      input_messages: ['first', 'middle'.repeat(20000), 'latest compact input'],
      last_assistant_message: 'assistant'.repeat(20000),
    });

    const view = extractOversizedNotifyLogSummary(raw);
    assert.equal(view.cwd, '/tmp/project');
    assert.equal(view.threadId, 'thread-1');
    assert.equal(view.turnId, 'turn-1');
    assert.equal(view.latestInputText, 'latest compact input');
    assert.equal(view.inputMessageCount, 3);
    assert.equal(view.inputMessagesTruncated, true);
    assert.equal('client' in view, false);
    assert.equal('mode' in view, false);
    assert.equal('producerSource' in view, false);
    assert.equal('projectName' in view, false);
    assert.equal('input_messages' in view, false);
  });

  it('logs a compact oversized managed payload summary without writing hook state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-hook-oversized-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), '{}', 'utf-8');
      const payload = JSON.stringify({
        cwd,
        type: 'agent-turn-complete',
        session_id: 'sess-notify-oversized',
        turn_id: 'turn-notify-oversized',
        client: 'codex-tui',
        mode: 'autopilot',
        source: 'notify-fallback-watcher',
        project_name: 'secret-project',
        input_messages: ['hello', 'latest oversized input'.repeat(30)],
        last_assistant_message: 'y'.repeat(500),
        padding: 'z'.repeat(MAX_NOTIFY_ARGV_JSON_BYTES + 1),
      });

      execFileSync(process.execPath, [notifyHookScriptPath(), payload], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      const logPath = join(cwd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      assert.equal(existsSync(logPath), true);
      const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());
      assert.equal(entry.payload_compacted, true);
      assert.equal(entry.turn_id, 'turn-notify-oversized');
      assert.equal(entry.input_preview.length, 200);
      assert.equal(entry.output_preview.length, 200);
      assert.equal(entry.input_message_count, 2);
      assert.equal(entry.input_messages_truncated, true);
      assert.equal('client' in entry, false);
      assert.equal('mode' in entry, false);
      assert.equal('source' in entry, false);
      assert.equal('project_name' in entry, false);
      assert.equal('session_id' in entry, false);
      assert.equal('input_messages' in entry, false);
      assert.equal('raw_payload_bytes_scanned' in entry, false);
      assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores oversized payloads when cwd is missing without creating local state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-hook-oversized-missing-cwd-'));
    try {
      const payload = JSON.stringify({
        type: 'agent-turn-complete',
        input_messages: ['hello'],
        last_assistant_message: 'x'.repeat(MAX_NOTIFY_ARGV_JSON_BYTES + 1),
      });

      execFileSync(process.execPath, [notifyHookScriptPath(), payload], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      assert.equal(existsSync(join(cwd, '.omx')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
