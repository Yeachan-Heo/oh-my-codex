import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initTeamState } from '../../team/state.js';

describe('state-server team comm tools', () => {
  it('team_send_message + team_mailbox_list + team_mailbox_mark_delivered', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('alpha-team', 'msg test', 'executor', 2, wd);

      const sendResp = await handleStateToolCall({
        params: {
          name: 'team_send_message',
          arguments: {
            team_name: 'alpha-team',
            from_worker: 'worker-1',
            to_worker: 'leader-fixed',
            body: 'ack from worker-1',
            workingDirectory: wd,
          },
        },
      });
      const sendJson = JSON.parse(sendResp.content[0]?.text || '{}') as { ok?: boolean; message?: { message_id?: string } };
      assert.equal(sendJson.ok, true);
      assert.equal(typeof sendJson.message?.message_id, 'string');

      const listResp = await handleStateToolCall({
        params: {
          name: 'team_mailbox_list',
          arguments: {
            team_name: 'alpha-team',
            worker: 'leader-fixed',
            include_delivered: false,
            workingDirectory: wd,
          },
        },
      });
      const listJson = JSON.parse(listResp.content[0]?.text || '{}') as { ok?: boolean; count?: number; messages?: Array<{ message_id: string; delivered_at?: string }> };
      assert.equal(listJson.ok, true);
      assert.equal(listJson.count, 1);
      const msgId = listJson.messages?.[0]?.message_id;
      assert.ok(msgId);

      const markResp = await handleStateToolCall({
        params: {
          name: 'team_mailbox_mark_delivered',
          arguments: {
            team_name: 'alpha-team',
            worker: 'leader-fixed',
            message_id: msgId,
            workingDirectory: wd,
          },
        },
      });
      const markJson = JSON.parse(markResp.content[0]?.text || '{}') as { ok?: boolean; updated?: boolean };
      assert.equal(markJson.ok, true);
      assert.equal(markJson.updated, true);

      const listAfterResp = await handleStateToolCall({
        params: {
          name: 'team_mailbox_list',
          arguments: {
            team_name: 'alpha-team',
            worker: 'leader-fixed',
            include_delivered: false,
            workingDirectory: wd,
          },
        },
      });
      const listAfterJson = JSON.parse(listAfterResp.content[0]?.text || '{}') as { ok?: boolean; count?: number };
      assert.equal(listAfterJson.ok, true);
      assert.equal(listAfterJson.count, 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_broadcast sends to all workers except sender', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('beta-team', 'broadcast test', 'executor', 3, wd);

      const resp = await handleStateToolCall({
        params: {
          name: 'team_broadcast',
          arguments: {
            team_name: 'beta-team',
            from_worker: 'worker-1',
            body: 'hello team',
            workingDirectory: wd,
          },
        },
      });
      const json = JSON.parse(resp.content[0]?.text || '{}') as { ok?: boolean; count?: number };
      assert.equal(json.ok, true);
      assert.equal(json.count, 2);

      const w2 = await handleStateToolCall({
        params: {
          name: 'team_mailbox_list',
          arguments: {
            team_name: 'beta-team',
            worker: 'worker-2',
            workingDirectory: wd,
          },
        },
      });
      const w3 = await handleStateToolCall({
        params: {
          name: 'team_mailbox_list',
          arguments: {
            team_name: 'beta-team',
            worker: 'worker-3',
            workingDirectory: wd,
          },
        },
      });
      const w2Json = JSON.parse(w2.content[0]?.text || '{}') as { count?: number };
      const w3Json = JSON.parse(w3.content[0]?.text || '{}') as { count?: number };
      assert.equal(w2Json.count, 1);
      assert.equal(w3Json.count, 1);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

