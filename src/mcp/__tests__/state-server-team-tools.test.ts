import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'fs/promises';
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

  it('team_claim_task rejects in-progress takeover when expected_version is omitted (issue-172)', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('claim-takeover-team', 'takeover test', 'executor', 2, wd);

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'claim-takeover-team',
            subject: 'Contested task',
            description: 'two workers race for this',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string; version?: number } };
      assert.equal(createJson.ok, true);

      // worker-1 claims the task successfully
      const claimResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'claim-takeover-team',
            task_id: createJson.task?.id ?? '1',
            worker: 'worker-1',
            expected_version: createJson.task?.version ?? 1,
            workingDirectory: wd,
          },
        },
      });
      const claimJson = JSON.parse(claimResp.content[0]?.text || '{}') as { ok?: boolean; claimToken?: string };
      assert.equal(claimJson.ok, true);

      // worker-2 tries to steal with no expected_version — must fail with claim_conflict
      const stealResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'claim-takeover-team',
            task_id: createJson.task?.id ?? '1',
            worker: 'worker-2',
            workingDirectory: wd,
            // expected_version intentionally omitted
          },
        },
      });
      const stealJson = JSON.parse(stealResp.content[0]?.text || '{}') as { ok?: boolean; error?: string };
      assert.equal(stealJson.ok, false);
      assert.equal(stealJson.error, 'claim_conflict');

      // Confirm worker-1 still owns the task
      const readResp = await handleStateToolCall({
        params: {
          name: 'team_read_task',
          arguments: {
            team_name: 'claim-takeover-team',
            task_id: createJson.task?.id ?? '1',
            workingDirectory: wd,
          },
        },
      });
      const readJson = JSON.parse(readResp.content[0]?.text || '{}') as { ok?: boolean; task?: { owner?: string; status?: string } };
      assert.equal(readJson.ok, true);
      assert.equal(readJson.task?.owner, 'worker-1');
      assert.equal(readJson.task?.status, 'in_progress');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_transition_task_status performs claim-safe terminal transition', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('delta-team', 'transition test', 'executor', 1, wd);

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'delta-team',
            subject: 'Transition task',
            description: 'claim and transition',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string; version?: number } };
      assert.equal(createJson.ok, true);
      assert.equal(createJson.task?.id, '1');

      const claimResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'delta-team',
            task_id: '1',
            worker: 'worker-1',
            expected_version: createJson.task?.version ?? 1,
            workingDirectory: wd,
          },
        },
      });
      const claimJson = JSON.parse(claimResp.content[0]?.text || '{}') as { ok?: boolean; claimToken?: string };
      assert.equal(claimJson.ok, true);
      assert.equal(typeof claimJson.claimToken, 'string');

      const transitionResp = await handleStateToolCall({
        params: {
          name: 'team_transition_task_status',
          arguments: {
            team_name: 'delta-team',
            task_id: '1',
            from: 'in_progress',
            to: 'completed',
            claim_token: claimJson.claimToken,
            workingDirectory: wd,
          },
        },
      });
      const transitionJson = JSON.parse(transitionResp.content[0]?.text || '{}') as { ok?: boolean; task?: { status?: string; completed_at?: string } };
      assert.equal(transitionJson.ok, true);
      assert.equal(transitionJson.task?.status, 'completed');
      assert.equal(typeof transitionJson.task?.completed_at, 'string');

      // Attempting to claim an already-completed task must be rejected
      const reclaimResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'delta-team',
            task_id: '1',
            worker: 'worker-2',
            workingDirectory: wd,
          },
        },
      });
      const reclaimJson = JSON.parse(reclaimResp.content[0]?.text || '{}') as { ok?: boolean; error?: string };
      assert.equal(reclaimJson.ok, false);
      assert.equal(reclaimJson.error, 'already_terminal');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_update_task rejects lifecycle field mutations without a claim token', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('epsilon-team', 'lifecycle guard test', 'executor', 1, wd);

      // Create a task to operate on
      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'epsilon-team',
            subject: 'Guard test task',
            description: 'must not be mutated directly',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string; status?: string } };
      assert.equal(createJson.ok, true);

      // Attempting to set status directly must be rejected
      const statusResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'epsilon-team',
            task_id: '1',
            status: 'completed',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(statusResp.isError, true);
      const statusJson = JSON.parse(statusResp.content[0]?.text || '{}') as { error?: string };
      assert.ok(statusJson.error?.includes('status'), `expected error mentioning "status", got: ${statusJson.error}`);

      // Attempting to set owner directly must be rejected
      const ownerResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'epsilon-team',
            task_id: '1',
            owner: 'worker-1',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(ownerResp.isError, true);
      const ownerJson = JSON.parse(ownerResp.content[0]?.text || '{}') as { error?: string };
      assert.ok(ownerJson.error?.includes('owner'), `expected error mentioning "owner", got: ${ownerJson.error}`);

      // Attempting to set result directly must be rejected
      const resultResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'epsilon-team',
            task_id: '1',
            result: 'done',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resultResp.isError, true);
      const resultJson = JSON.parse(resultResp.content[0]?.text || '{}') as { error?: string };
      assert.ok(resultJson.error?.includes('result'), `expected error mentioning "result", got: ${resultJson.error}`);

      // Attempting to set error directly must be rejected
      const errorResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'epsilon-team',
            task_id: '1',
            error: 'oops',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(errorResp.isError, true);
      const errorJson = JSON.parse(errorResp.content[0]?.text || '{}') as { error?: string };
      assert.ok(errorJson.error?.includes('error'), `expected error mentioning "error", got: ${errorJson.error}`);

      // Non-lifecycle metadata updates must still work
      const metaResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'epsilon-team',
            task_id: '1',
            subject: 'Updated subject',
            description: 'Updated description',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(metaResp.isError, undefined);
      const metaJson = JSON.parse(metaResp.content[0]?.text || '{}') as { ok?: boolean; task?: { subject?: string; status?: string } };
      assert.equal(metaJson.ok, true);
      assert.equal(metaJson.task?.subject, 'Updated subject');
      // Status must remain unchanged (pending)
      assert.equal(metaJson.task?.status, 'pending');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
