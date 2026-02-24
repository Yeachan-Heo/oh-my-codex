import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
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

  it('team tools ignore unrelated OMX_TEAM_STATE_ROOT when workingDirectory is explicit', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    const unrelated = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-unrelated-'));
    const prevRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      await initTeamState('explicit-wd-team', 'explicit cwd test', 'executor', 1, wd);
      process.env.OMX_TEAM_STATE_ROOT = join(unrelated, '.omx', 'state');

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'explicit-wd-team',
            subject: 'Created via explicit wd',
            description: 'must not route to unrelated inherited env root',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(createJson.ok, true);
      assert.equal(createJson.task?.id, '1');

      const localTaskPath = join(wd, '.omx', 'state', 'team', 'explicit-wd-team', 'tasks', 'task-1.json');
      const unrelatedTaskPath = join(unrelated, '.omx', 'state', 'team', 'explicit-wd-team', 'tasks', 'task-1.json');
      assert.equal(existsSync(localTaskPath), true);
      assert.equal(existsSync(unrelatedTaskPath), false);
    } finally {
      if (typeof prevRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(wd, { recursive: true, force: true });
      await rm(unrelated, { recursive: true, force: true });
    }
  });

  it('team_transition_task_status rejects non-terminal transition attempts', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('transition-guard-team', 'transition guard test', 'executor', 1, wd);

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'transition-guard-team',
            subject: 'Task for transition guard',
            description: 'Should only allow terminal transition',
            workingDirectory: wd,
          },
        },
      });
      const created = JSON.parse(createResp.content[0]?.text || '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(created.ok, true);
      const taskId = created.task?.id;
      assert.ok(taskId);

      const claimResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'transition-guard-team',
            task_id: taskId,
            worker: 'worker-1',
            expected_version: 1,
            workingDirectory: wd,
          },
        },
      });
      const claim = JSON.parse(claimResp.content[0]?.text || '{}') as { ok?: boolean; claimToken?: string };
      assert.equal(claim.ok, true);
      assert.equal(typeof claim.claimToken, 'string');

      const transitionResp = await handleStateToolCall({
        params: {
          name: 'team_transition_task_status',
          arguments: {
            team_name: 'transition-guard-team',
            task_id: taskId,
            from: 'in_progress',
            to: 'pending',
            claim_token: claim.claimToken,
            workingDirectory: wd,
          },
        },
      });
      const transition = JSON.parse(transitionResp.content[0]?.text || '{}') as { ok?: boolean; error?: string };
      assert.equal(transition.ok, false);
      assert.equal(transition.error, 'invalid_transition');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_update_task rejects unsupported fields and invalid blocked_by entries', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('update-guard-team', 'update guard test', 'executor', 1, wd);

      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'update-guard-team',
            subject: 'task',
            description: 'task desc',
            workingDirectory: wd,
          },
        },
      });
      const createJson = JSON.parse(createResp.content[0]?.text || '{}') as { task?: { id?: string } };
      const taskId = createJson.task?.id ?? '1';

      const unsupportedResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'update-guard-team',
            task_id: taskId,
            claim: { owner: 'worker-1' },
            workingDirectory: wd,
          },
        },
      });
      assert.equal(unsupportedResp.isError, true);
      const unsupportedJson = JSON.parse(unsupportedResp.content[0]?.text || '{}') as { error?: string };
      assert.match(unsupportedJson.error ?? '', /unsupported fields/i);

      const invalidDepsResp = await handleStateToolCall({
        params: {
          name: 'team_update_task',
          arguments: {
            team_name: 'update-guard-team',
            task_id: taskId,
            blocked_by: ['../oops'],
            workingDirectory: wd,
          },
        },
      });
      assert.equal(invalidDepsResp.isError, true);
      const invalidDepsJson = JSON.parse(invalidDepsResp.content[0]?.text || '{}') as { error?: string };
      assert.match(invalidDepsJson.error ?? '', /blocked_by contains invalid task ID/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_claim_task validates expected_version as a positive integer', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('claim-guard-team', 'claim guard test', 'executor', 1, wd);

      await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'claim-guard-team',
            subject: 'task',
            description: 'task desc',
            workingDirectory: wd,
          },
        },
      });

      const badTypeResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'claim-guard-team',
            task_id: '1',
            worker: 'worker-1',
            expected_version: '1',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(badTypeResp.isError, true);
      const badTypeJson = JSON.parse(badTypeResp.content[0]?.text || '{}') as { error?: string };
      assert.match(badTypeJson.error ?? '', /expected_version must be a positive integer/i);

      const badValueResp = await handleStateToolCall({
        params: {
          name: 'team_claim_task',
          arguments: {
            team_name: 'claim-guard-team',
            task_id: '1',
            worker: 'worker-1',
            expected_version: 0,
            workingDirectory: wd,
          },
        },
      });
      assert.equal(badValueResp.isError, true);
      const badValueJson = JSON.parse(badValueResp.content[0]?.text || '{}') as { error?: string };
      assert.match(badValueJson.error ?? '', /expected_version must be a positive integer/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_append_event rejects unknown event types', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('event-guard-team', 'event guard test', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_append_event',
          arguments: {
            team_name: 'event-guard-team',
            type: 'not-a-real-event',
            worker: 'worker-1',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true);
      const json = JSON.parse(resp.content[0]?.text || '{}') as { error?: string };
      assert.match(json.error ?? '', /type must be one of/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('team_write_task_approval validates status enum and required type', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const { handleStateToolCall } = await import('../state-server.js');

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-team-tools-'));
    try {
      await initTeamState('approval-guard-team', 'approval guard test', 'executor', 1, wd);

      const badStatusResp = await handleStateToolCall({
        params: {
          name: 'team_write_task_approval',
          arguments: {
            team_name: 'approval-guard-team',
            task_id: '1',
            status: 'accepted',
            reviewer: 'reviewer-1',
            decision_reason: 'bad status test',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(badStatusResp.isError, true);
      const badStatusJson = JSON.parse(badStatusResp.content[0]?.text || '{}') as { error?: string };
      assert.match(badStatusJson.error ?? '', /status must be one of/i);

      const badRequiredResp = await handleStateToolCall({
        params: {
          name: 'team_write_task_approval',
          arguments: {
            team_name: 'approval-guard-team',
            task_id: '1',
            status: 'approved',
            reviewer: 'reviewer-1',
            decision_reason: 'bad required type test',
            required: 'true',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(badRequiredResp.isError, true);
      const badRequiredJson = JSON.parse(badRequiredResp.content[0]?.text || '{}') as { error?: string };
      assert.match(badRequiredJson.error ?? '', /required must be a boolean/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
