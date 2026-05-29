import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MAX_NOTIFY_ARGV_JSON_BYTES } from '../../hook-payload-guard.js';

function notifyHookScriptPath(): string {
  return join(process.cwd(), 'dist', 'scripts', 'notify-hook.js');
}

describe('notify-hook raw payload guard', () => {
  it('ignores oversized argv JSON before parsing or writing hook state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-hook-oversized-'));
    try {
      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), '{}', 'utf-8');
      const payload = JSON.stringify({
        cwd,
        type: 'agent-turn-complete',
        session_id: 'sess-notify-oversized',
        turn_id: 'turn-notify-oversized',
        input_messages: ['hello'],
        last_assistant_message: 'x'.repeat(MAX_NOTIFY_ARGV_JSON_BYTES + 1),
      });

      execFileSync(process.execPath, [notifyHookScriptPath(), payload], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });

      assert.equal(existsSync(join(cwd, '.omx', 'logs')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'state')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
