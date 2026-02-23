import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
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

      const notifyResp = await handleStateToolCall({
        params: {
          name: 'team_mailbox_mark_notified',
          arguments: {
            team_name: 'alpha-team',
            worker: 'leader-fixed',
            message_id: msgId,
            workingDirectory: wd,
          },
        },
      });
      const notifyJson = JSON.parse(notifyResp.content[0]?.text || '{}') as { ok?: boolean; notified?: boolean };
      assert.equal(notifyJson.ok, true);
      assert.equal(notifyJson.notified, true);

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

  it('team_read_task/team_list_tasks resolve team root from nested workingDirectory', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    const nestedWd = join(wd, 'nested', 'deep');
    try {
      await mkdir(nestedWd, { recursive: true });
      await initTeamState('gamma-team', 'nested cwd test', 'executor', 1, wd);

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'gamma-team',
            subject: 'Task from root',
            description: 'Created from root wd',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(createJson.ok, true);
      assert.equal(createJson.task?.id, '1');

      const listResp = await handleStateToolCall({
        params: {
          name: 'team_list_tasks',
          arguments: {
            team_name: 'gamma-team',
            workingDirectory: nestedWd,
          },
        },
      });
      const listJson = JSON.parse(listResp.content[0]?.text || '{}') as { ok?: boolean; count?: number };
      assert.equal(listJson.ok, true);
      assert.equal(listJson.count, 1);

      const readResp = await handleStateToolCall({
        params: {
          name: 'team_read_task',
          arguments: {
            team_name: 'gamma-team',
            task_id: '1',
            workingDirectory: nestedWd,
          },
        },
      });
      const readJson = JSON.parse(readResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(readJson.ok, true);
      assert.equal(readJson.task?.id, '1');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_write_worker_identity persists workspace metadata fields', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('identity-team', 'identity test', 'executor', 1, wd);
      const identityResp = await handleStateToolCall({
        params: {
          name: 'team_write_worker_identity',
          arguments: {
            team_name: 'identity-team',
            worker: 'worker-1',
            index: 1,
            role: 'executor',
            assigned_tasks: ['1'],
            working_dir: '/tmp/worktree/worker-1',
            worktree_path: '/tmp/worktree/worker-1',
            worktree_branch: 'feature/worker-1',
            worktree_detached: false,
            team_state_root: '/tmp/leader/.omx/state',
            workingDirectory: wd,
          },
        },
      });
      const identityJson = JSON.parse(identityResp.content[0]?.text || '{}') as { ok?: boolean };
      assert.equal(identityJson.ok, true);

      const identityPath = join(
        wd,
        '.omx',
        'state',
        'team',
        'identity-team',
        'workers',
        'worker-1',
        'identity.json',
      );
      const persisted = JSON.parse(await readFile(identityPath, 'utf8')) as {
        working_dir?: string;
        worktree_path?: string;
        worktree_branch?: string;
        worktree_detached?: boolean;
        team_state_root?: string;
      };
      assert.equal(persisted.working_dir, '/tmp/worktree/worker-1');
      assert.equal(persisted.worktree_path, '/tmp/worktree/worker-1');
      assert.equal(persisted.worktree_branch, 'feature/worker-1');
      assert.equal(persisted.worktree_detached, false);
      assert.equal(persisted.team_state_root, '/tmp/leader/.omx/state');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team tool resolution prefers OMX_TEAM_STATE_ROOT when workingDirectory is omitted', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    const prevRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('env-root-team', 'env root test', 'executor', 1, wd);
      process.env.OMX_TEAM_STATE_ROOT = join(wd, '.omx', 'state');

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'env-root-team',
            subject: 'Created via env root',
            description: 'should resolve without workingDirectory',
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(createJson.ok, true);
      assert.equal(createJson.task?.id, '1');
    } finally {
      if (typeof prevRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(wd, { recursive: true, force: true });
    }
  });
});
