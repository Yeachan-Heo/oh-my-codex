import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendTeamDeliveryLogForCwd } from '../delivery-log.js';

describe('appendTeamDeliveryLogForCwd', () => {
  it('writes runtime delivery logs under boxed OMX_ROOT instead of source cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-delivery-cwd-'));
    const box = await mkdtemp(join(tmpdir(), 'omx-delivery-box-'));
    const previousRoot = process.env.OMX_ROOT;
    const previousStateRoot = process.env.OMX_STATE_ROOT;
    try {
      process.env.OMX_ROOT = box;
      delete process.env.OMX_STATE_ROOT;

      await appendTeamDeliveryLogForCwd(cwd, {
        event: 'dispatch_result',
        source: 'test',
        team: 'boxed-log-team',
        result: 'ok',
      });

      const date = new Date().toISOString().slice(0, 10);
      const boxedLog = join(box, '.omx', 'logs', `team-delivery-${date}.jsonl`);
      const cwdLog = join(cwd, '.omx', 'logs', `team-delivery-${date}.jsonl`);
      assert.equal(existsSync(cwdLog), false);
      const raw = await readFile(boxedLog, 'utf-8');
      assert.match(raw, /"team":"boxed-log-team"/);
    } finally {
      if (typeof previousRoot === 'string') process.env.OMX_ROOT = previousRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousStateRoot === 'string') process.env.OMX_STATE_ROOT = previousStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(box, { recursive: true, force: true });
    }
  });

  it('accepts steered nudge delivery results in the shared contract', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-delivery-steered-'));
    try {
      await appendTeamDeliveryLogForCwd(cwd, {
        event: 'nudge_triggered',
        source: 'worker_stop',
        team: 'steered-log-team',
        transport: 'send-keys',
        result: 'steered',
      });

      const date = new Date().toISOString().slice(0, 10);
      const raw = await readFile(join(cwd, '.omx', 'logs', `team-delivery-${date}.jsonl`), 'utf-8');
      assert.match(raw, /"result":"steered"/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
