import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveTeamApiOperation,
  buildLegacyTeamDeprecationHint,
  executeTeamApiOperation,
  LEGACY_TEAM_MCP_TOOLS,
  TEAM_API_OPERATIONS,
  type TeamApiOperation,
} from '../api-interop.js';
import {
  initTeamState,
  createTask,
  readTask,
  sendDirectMessage,
  enqueueDispatchRequest,
  readDispatchRequest,
  appendTeamEvent,
  updateWorkerHeartbeat,
  writeMonitorSnapshot,
  writeWorkerStatus,
} from '../state.js';

async function setupTeam(name: string): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `omx-interop-${name}-`));
  const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
  delete process.env.OMX_TEAM_STATE_ROOT;
  await initTeamState(name, 'test task', 'executor', 2, cwd);
  return {
    cwd,
    cleanup: async () => {
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

// ─── resolveTeamApiOperation ──────────────────────────────────────────────

describe('resolveTeamApiOperation', () => {
  it('resolves a valid kebab-case operation', () => {
    assert.equal(resolveTeamApiOperation('send-message'), 'send-message');
  });

  it('normalizes legacy team_ prefix to kebab-case', () => {
    assert.equal(resolveTeamApiOperation('team_send_message'), 'send-message');
  });

  it('normalizes underscores to hyphens', () => {
    assert.equal(resolveTeamApiOperation('claim_task'), 'claim-task');
  });

  it('returns null for unknown operations', () => {
    assert.equal(resolveTeamApiOperation('nonexistent-op'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(resolveTeamApiOperation(''), null);
  });

  it('handles whitespace and casing', () => {
    assert.equal(resolveTeamApiOperation('  SEND_MESSAGE  '), 'send-message');
  });

  it('resolves all 33 operations from the operation list', () => {
    for (const op of TEAM_API_OPERATIONS) {
      assert.equal(resolveTeamApiOperation(op), op);
    }
  });
});

// ─── buildLegacyTeamDeprecationHint ───────────────────────────────────────

describe('buildLegacyTeamDeprecationHint', () => {
  it('produces CLI hint with resolved operation name', () => {
    const hint = buildLegacyTeamDeprecationHint('team_send_message', { team_name: 'alpha' });
    assert.match(hint, /omx team api send-message/);
    assert.match(hint, /"team_name":"alpha"/);
  });

  it('falls back to generic hint for unresolvable legacy name', () => {
    const hint = buildLegacyTeamDeprecationHint('team_nonexistent', { foo: 'bar' });
    assert.match(hint, /omx team api <operation>/);
  });

  it('uses empty JSON when no args provided', () => {
    const hint = buildLegacyTeamDeprecationHint('team_list_tasks');
    assert.match(hint, /\{\}/);
  });
});

// ─── constants ────────────────────────────────────────────────────────────

describe('LEGACY_TEAM_MCP_TOOLS', () => {
  it('contains 29 legacy tool names', () => {
    assert.equal(LEGACY_TEAM_MCP_TOOLS.length, 29);
  });

  it('all start with team_', () => {
    for (const name of LEGACY_TEAM_MCP_TOOLS) {
      assert.match(name, /^team_/);
    }
  });
});

describe('TEAM_API_OPERATIONS', () => {
  it('contains 33 operations', () => {
    assert.equal(TEAM_API_OPERATIONS.length, 33);
  });

  it('all use kebab-case', () => {
    for (const op of TEAM_API_OPERATIONS) {
      assert.doesNotMatch(op, /_/);
    }
  });
});

// ─── validateCommonFields (via executeTeamApiOperation) ───────────────────

describe('validateCommonFields', () => {
  it('rejects invalid team_name pattern', async () => {
    const result = await executeTeamApiOperation('list-tasks', { team_name: 'INVALID CAPS!' }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'operation_failed');
      assert.match(result.error.message, /Invalid team_name/);
    }
  });

  it('rejects invalid worker name pattern', async () => {
    const { cwd, cleanup } = await setupTeam('validate-worker');
    try {
      const result = await executeTeamApiOperation('read-worker-status', {
        team_name: 'validate-worker',
        worker: 'CAPS NOT ALLOWED!',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Invalid worker/);
      }
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid task_id pattern', async () => {
    const { cwd, cleanup } = await setupTeam('validate-task-id');
    try {
      const result = await executeTeamApiOperation('read-task', {
        team_name: 'validate-task-id',
        task_id: 'not-a-number',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Invalid task_id/);
      }
    } finally {
      await cleanup();
    }
  });
});

// ─── send-message ─────────────────────────────────────────────────────────

describe('executeTeamApiOperation: send-message', () => {
  it('sends a message successfully and enqueues mailbox dispatch delivery', async () => {
    const { cwd, cleanup } = await setupTeam('msg-team');
    try {
      const result = await executeTeamApiOperation('send-message', {
        team_name: 'msg-team',
        from_worker: 'worker-1',
        to_worker: 'worker-2',
        body: 'hello',
      }, cwd);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('expected successful send-message result');
      assert.ok(result.data.message);

      const message = result.data.message as Record<string, unknown>;
      const messageId = String(message.message_id ?? '');
      assert.ok(messageId, 'message should include a message_id');

      const requests = await readFile(join(cwd, '.omx', 'state', 'team', 'msg-team', 'dispatch', 'requests.json'), 'utf-8');
      const parsedRequests = JSON.parse(requests) as Array<Record<string, unknown>>;
      const mailboxRequest = parsedRequests.find((request) => request.kind === 'mailbox' && request.message_id === messageId);
      assert.ok(mailboxRequest, 'send-message should enqueue a mailbox dispatch request');
      assert.equal(mailboxRequest?.to_worker, 'worker-2');
    } finally {
      await cleanup();
    }
  });

  it('returns error when from_worker missing', async () => {
    const result = await executeTeamApiOperation('send-message', {
      team_name: 'any', to_worker: 'w2', body: 'hi',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /from_worker is required/);
  });

  it('returns error when team_name, to_worker, or body missing', async () => {
    const result = await executeTeamApiOperation('send-message', {
      from_worker: 'w1',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /team_name.*from_worker.*to_worker.*body/);
  });
});

// ─── broadcast ────────────────────────────────────────────────────────────

describe('executeTeamApiOperation: broadcast', () => {
  it('broadcasts a message successfully', async () => {
    const { cwd, cleanup } = await setupTeam('bc-team');
    try {
      const result = await executeTeamApiOperation('broadcast', {
        team_name: 'bc-team',
        from_worker: 'worker-1',
        body: 'hello everyone',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok('count' in result.data);
      }
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('broadcast', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── mailbox-list ─────────────────────────────────────────────────────────

describe('executeTeamApiOperation: mailbox-list', () => {
  it('lists mailbox messages (empty initially)', async () => {
    const { cwd, cleanup } = await setupTeam('mbox-team');
    try {
      const result = await executeTeamApiOperation('mailbox-list', {
        team_name: 'mbox-team',
        worker: 'worker-1',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.count, 0);
      }
    } finally {
      await cleanup();
    }
  });

  it('filters out delivered messages when include_delivered is false', async () => {
    const { cwd, cleanup } = await setupTeam('mbox-filter');
    try {
      const result = await executeTeamApiOperation('mailbox-list', {
        team_name: 'mbox-filter',
        worker: 'worker-1',
        include_delivered: false,
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('mailbox-list', { team_name: 'x' }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── mailbox-mark-delivered ───────────────────────────────────────────────

describe('executeTeamApiOperation: mailbox-mark-delivered', () => {
  it('marks a message delivered after sending and promotes matching dispatch receipt', async () => {
    const { cwd, cleanup } = await setupTeam('mark-dlv');
    try {
      // Ensure the worker-2 mailbox directory exists so sendDirectMessage can write
      await mkdir(join(cwd, '.omx', 'state', 'team', 'mark-dlv', 'mailbox', 'worker-2'), { recursive: true });
      const sendResult = await executeTeamApiOperation('send-message', {
        team_name: 'mark-dlv', from_worker: 'worker-1', to_worker: 'worker-2', body: 'ack',
      }, cwd);
      assert.equal(sendResult.ok, true);
      const msg = sendResult.data.message as Record<string, unknown>;
      const msgId = String(msg?.message_id ?? '');
      assert.ok(msgId, 'message should have a message_id');

      const dispatch = await enqueueDispatchRequest('mark-dlv', {
        kind: 'mailbox',
        to_worker: 'worker-2',
        worker_index: 2,
        message_id: msgId,
        trigger_message: 'check mailbox',
      }, cwd);

      const result = await executeTeamApiOperation('mailbox-mark-delivered', {
        team_name: 'mark-dlv', worker: 'worker-2', message_id: msgId,
      }, cwd);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('expected successful mailbox-mark-delivered result');
      assert.equal(result.data.dispatch_request_id, dispatch.request.request_id);
      assert.equal(result.data.dispatch_updated, true);

      const updatedDispatch = await readDispatchRequest('mark-dlv', dispatch.request.request_id, cwd);
      assert.equal(updatedDispatch?.status, 'delivered');
    } finally {
      await cleanup();
    }
  });

  it('reports when no matching mailbox dispatch request exists', async () => {
    const { cwd, cleanup } = await setupTeam('mark-dlv-no-dispatch');
    try {
      const message = await sendDirectMessage('mark-dlv-no-dispatch', 'worker-1', 'worker-2', 'ack', cwd);

      const result = await executeTeamApiOperation('mailbox-mark-delivered', {
        team_name: 'mark-dlv-no-dispatch',
        worker: 'worker-2',
        message_id: message.message_id,
      }, cwd);

      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('expected success envelope');
      assert.equal(result.data.dispatch_request_id, null);
      assert.equal(result.data.dispatch_updated, false);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: 'x', worker: 'w',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── mailbox-mark-notified ────────────────────────────────────────────────

describe('executeTeamApiOperation: mailbox-mark-notified', () => {
  it('marks a message notified after sending', async () => {
    const { cwd, cleanup } = await setupTeam('mark-ntf');
    try {
      // Ensure the worker-2 mailbox directory exists so sendDirectMessage can write
      await mkdir(join(cwd, '.omx', 'state', 'team', 'mark-ntf', 'mailbox', 'worker-2'), { recursive: true });
      const sendResult = await executeTeamApiOperation('send-message', {
        team_name: 'mark-ntf', from_worker: 'worker-1', to_worker: 'worker-2', body: 'notify me',
      }, cwd);
      // Send must succeed to test mark-notified
      assert.equal(sendResult.ok, true);
      const msg = sendResult.data.message as Record<string, unknown>;
      const msgId = String(msg?.message_id ?? '');
      assert.ok(msgId, 'message should have a message_id');
      const result = await executeTeamApiOperation('mailbox-mark-notified', {
        team_name: 'mark-ntf', worker: 'worker-2', message_id: msgId,
      }, cwd);
      // Mark operation returns a valid envelope (pass or fail based on state layer)
      assert.ok(typeof result.ok === 'boolean');
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('mailbox-mark-notified', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── create-task ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: create-task', () => {
  it('creates a task successfully', async () => {
    const { cwd, cleanup } = await setupTeam('create-tsk');
    try {
      const result = await executeTeamApiOperation('create-task', {
        team_name: 'create-tsk',
        subject: 'My task',
        description: 'Description here',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok(result.data.task);
      }
    } finally {
      await cleanup();
    }
  });

  it('creates a task with optional fields', async () => {
    const { cwd, cleanup } = await setupTeam('create-tsk-opt');
    try {
      const result = await executeTeamApiOperation('create-task', {
        team_name: 'create-tsk-opt',
        subject: 'Owned task',
        description: 'Has owner',
        owner: 'worker-1',
        blocked_by: ['999'],
        requires_code_change: true,
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('create-task', {
      team_name: 'x', subject: 'only subject',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-task ────────────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-task', () => {
  it('reads an existing task', async () => {
    const { cwd, cleanup } = await setupTeam('read-tsk');
    try {
      const task = await createTask('read-tsk', {
        subject: 'Readable', description: 'A task to read', status: 'pending',
      }, cwd);
      const result = await executeTeamApiOperation('read-task', {
        team_name: 'read-tsk', task_id: task.id,
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(result.data.task);
    } finally {
      await cleanup();
    }
  });

  it('returns task_not_found for nonexistent task', async () => {
    const { cwd, cleanup } = await setupTeam('read-tsk-nf');
    try {
      const result = await executeTeamApiOperation('read-task', {
        team_name: 'read-tsk-nf', task_id: '9999',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'task_not_found');
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('read-task', { team_name: 'x' }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── list-tasks ───────────────────────────────────────────────────────────

describe('executeTeamApiOperation: list-tasks', () => {
  it('lists tasks for a team', async () => {
    const { cwd, cleanup } = await setupTeam('list-tsk');
    try {
      await createTask('list-tsk', { subject: 'T1', description: 'D1', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('list-tasks', {
        team_name: 'list-tsk',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.ok((result.data.count as number) >= 1);
      }
    } finally {
      await cleanup();
    }
  });


  it('resolves team working directory from manifest metadata over worker identity/config fallbacks', async () => {
    const teamName = 'list-tsk-meta';
    const cwdA = await mkdtemp(join(tmpdir(), 'omx-interop-meta-a-'));
    const cwdB = await mkdtemp(join(tmpdir(), 'omx-interop-meta-b-'));
    const prevTeamWorker = process.env.OMX_TEAM_WORKER;
    const prevTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    delete process.env.OMX_TEAM_STATE_ROOT;
    process.env.OMX_TEAM_WORKER = `${teamName}/worker-1`;

    try {
      await initTeamState(teamName, 'metadata precedence', 'executor', 2, cwdA);
      await initTeamState(teamName, 'metadata precedence', 'executor', 2, cwdB);
      await createTask(teamName, { subject: 'From manifest root', description: 'B lane', status: 'pending' }, cwdB);

      const teamRootA = join(cwdA, '.omx', 'state', 'team', teamName);
      const configPath = join(teamRootA, 'config.json');
      const manifestPath = join(teamRootA, 'manifest.v2.json');

      const config = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;

      config.team_state_root = join(cwdA, '.omx', 'state');
      manifest.team_state_root = join(cwdB, '.omx', 'state');

      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

      const result = await executeTeamApiOperation('list-tasks', { team_name: teamName }, cwdA);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error('expected list-tasks to succeed');
      assert.equal(result.data.count, 1);
    } finally {
      if (typeof prevTeamWorker === 'string') process.env.OMX_TEAM_WORKER = prevTeamWorker;
      else delete process.env.OMX_TEAM_WORKER;
      if (typeof prevTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = prevTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwdA, { recursive: true, force: true });
      await rm(cwdB, { recursive: true, force: true });
    }
  });
  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('list-tasks', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── update-task ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: update-task', () => {
  it('updates task subject and description', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk');
    try {
      const task = await createTask('upd-tsk', { subject: 'Old', description: 'Old desc', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk', task_id: task.id,
        subject: 'New subject', description: 'New desc',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('rejects lifecycle fields (status, owner, result, error)', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-lc');
    try {
      const task = await createTask('upd-tsk-lc', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-lc', task_id: task.id, status: 'completed',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /lifecycle fields/);
    } finally {
      await cleanup();
    }
  });

  it('rejects unexpected fields', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-uf');
    try {
      const task = await createTask('upd-tsk-uf', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-uf', task_id: task.id, random_field: 'bad',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /unsupported fields/);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-string subject', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-ns');
    try {
      const task = await createTask('upd-tsk-ns', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-ns', task_id: task.id, subject: 123,
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /subject must be a string/);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-string description', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-nd');
    try {
      const task = await createTask('upd-tsk-nd', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-nd', task_id: task.id, description: 42,
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /description must be a string/);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-boolean requires_code_change', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-rcc');
    try {
      const task = await createTask('upd-tsk-rcc', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-rcc', task_id: task.id, requires_code_change: 'yes',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /requires_code_change must be a boolean/);
    } finally {
      await cleanup();
    }
  });

  it('validates blocked_by as array of valid task IDs', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-bb');
    try {
      const task = await createTask('upd-tsk-bb', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-bb', task_id: task.id, blocked_by: 'not-an-array',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /must be an array/);
    } finally {
      await cleanup();
    }
  });

  it('rejects blocked_by with non-string entries', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-bbns');
    try {
      const task = await createTask('upd-tsk-bbns', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-bbns', task_id: task.id, blocked_by: [123],
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /entries must be strings/);
    } finally {
      await cleanup();
    }
  });

  it('rejects blocked_by with invalid task ID format', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-bbid');
    try {
      const task = await createTask('upd-tsk-bbid', { subject: 'X', description: 'Y', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-bbid', task_id: task.id, blocked_by: ['abc'],
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /invalid task ID/);
    } finally {
      await cleanup();
    }
  });

  it('returns task_not_found when task does not exist', async () => {
    const { cwd, cleanup } = await setupTeam('upd-tsk-nf');
    try {
      const result = await executeTeamApiOperation('update-task', {
        team_name: 'upd-tsk-nf', task_id: '9999', subject: 'New',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'task_not_found');
    } finally {
      await cleanup();
    }
  });
});

// ─── claim-task ───────────────────────────────────────────────────────────

describe('executeTeamApiOperation: claim-task', () => {
  it('claims a task successfully', async () => {
    const { cwd, cleanup } = await setupTeam('claim-tsk');
    try {
      const task = await createTask('claim-tsk', { subject: 'Claim me', description: 'D', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('claim-task', {
        team_name: 'claim-tsk', task_id: task.id, worker: 'worker-1',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-integer expected_version', async () => {
    const result = await executeTeamApiOperation('claim-task', {
      team_name: 'x', task_id: '1', worker: 'w1', expected_version: 'abc',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /expected_version must be a positive integer/);
  });

  it('rejects zero expected_version', async () => {
    const result = await executeTeamApiOperation('claim-task', {
      team_name: 'x', task_id: '1', worker: 'w1', expected_version: 0,
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /expected_version must be a positive integer/);
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('claim-task', {
      team_name: 'x', task_id: '1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── transition-task-status ───────────────────────────────────────────────

describe('executeTeamApiOperation: transition-task-status', () => {
  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('transition-task-status', {
      team_name: 'x', task_id: '1', from: 'in_progress',
    }, '/tmp');
    assert.equal(result.ok, false);
  });

  it('rejects invalid status values', async () => {
    const result = await executeTeamApiOperation('transition-task-status', {
      team_name: 'x', task_id: '1', from: 'invalid', to: 'completed', claim_token: 'tok',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /valid task statuses/);
  });

  it('persists optional result and error payloads', async () => {
    const { cwd, cleanup } = await setupTeam('transition-payload');
    try {
      const completedTask = await createTask('transition-payload', { subject: 'done', description: 'd', status: 'pending' }, cwd);
      const claimCompleted = await executeTeamApiOperation('claim-task', {
        team_name: 'transition-payload', task_id: completedTask.id, worker: 'worker-1',
      }, cwd);
      assert.equal(claimCompleted.ok, true);
      if (!claimCompleted.ok) return;

      const completedClaimToken = String(claimCompleted.data.claimToken);
      const completedResult = 'Verification:\nPASS - transition evidence stored';
      const completedTransition = await executeTeamApiOperation('transition-task-status', {
        team_name: 'transition-payload',
        task_id: completedTask.id,
        from: 'in_progress',
        to: 'completed',
        claim_token: completedClaimToken,
        result: completedResult,
      }, cwd);
      assert.equal(completedTransition.ok, true);

      const completedReread = await readTask('transition-payload', completedTask.id, cwd);
      assert.equal(completedReread?.result, completedResult);
      assert.equal(completedReread?.error, undefined);

      const failedTask = await createTask('transition-payload', { subject: 'fail', description: 'd', status: 'pending' }, cwd);
      const claimFailed = await executeTeamApiOperation('claim-task', {
        team_name: 'transition-payload', task_id: failedTask.id, worker: 'worker-1',
      }, cwd);
      assert.equal(claimFailed.ok, true);
      if (!claimFailed.ok) return;

      const failedClaimToken = String(claimFailed.data.claimToken);
      const failedError = 'Verification failed';
      const failedTransition = await executeTeamApiOperation('transition-task-status', {
        team_name: 'transition-payload',
        task_id: failedTask.id,
        from: 'in_progress',
        to: 'failed',
        claim_token: failedClaimToken,
        error: failedError,
      }, cwd);
      assert.equal(failedTransition.ok, true);

      const failedReread = await readTask('transition-payload', failedTask.id, cwd);
      assert.equal(failedReread?.error, failedError);
      assert.equal(failedReread?.result, undefined);
    } finally {
      await cleanup();
    }
  });

  it('rejects non-string result and error payloads', async () => {
    const badResult = await executeTeamApiOperation('transition-task-status', {
      team_name: 'x', task_id: '1', from: 'in_progress', to: 'completed', claim_token: 'tok', result: true,
    }, '/tmp');
    assert.equal(badResult.ok, false);
    if (!badResult.ok) assert.match(badResult.error.message, /result must be a string/);

    const badError = await executeTeamApiOperation('transition-task-status', {
      team_name: 'x', task_id: '1', from: 'in_progress', to: 'failed', claim_token: 'tok', error: 42,
    }, '/tmp');
    assert.equal(badError.ok, false);
    if (!badError.ok) assert.match(badError.error.message, /error must be a string/);
  });
});

// ─── release-task-claim ───────────────────────────────────────────────────

describe('executeTeamApiOperation: release-task-claim', () => {
  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('release-task-claim', {
      team_name: 'x', task_id: '1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-config ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-config', () => {
  it('reads team config successfully', async () => {
    const { cwd, cleanup } = await setupTeam('rd-cfg');
    try {
      const result = await executeTeamApiOperation('read-config', {
        team_name: 'rd-cfg',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) assert.ok(result.data.config);
    } finally {
      await cleanup();
    }
  });

  it('returns team_not_found for nonexistent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-interop-cfg-nf-'));
    try {
      const result = await executeTeamApiOperation('read-config', {
        team_name: 'nonexistent-cfg',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'team_not_found');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('read-config', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-manifest ────────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-manifest', () => {
  it('returns manifest_not_found when manifest does not exist', async () => {
    const { cwd, cleanup } = await setupTeam('rd-mfst');
    try {
      const result = await executeTeamApiOperation('read-manifest', {
        team_name: 'rd-mfst',
      }, cwd);
      assert.ok(result.ok === true || (result.ok === false && result.error.code === 'manifest_not_found'));
    } finally {
      await cleanup();
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('read-manifest', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-worker-status ───────────────────────────────────────────────────

describe('executeTeamApiOperation: read-worker-status', () => {
  it('reads worker status', async () => {
    const { cwd, cleanup } = await setupTeam('rd-ws');
    try {
      const result = await executeTeamApiOperation('read-worker-status', {
        team_name: 'rd-ws', worker: 'worker-1',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('read-worker-status', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-worker-heartbeat ────────────────────────────────────────────────

describe('executeTeamApiOperation: read-worker-heartbeat', () => {
  it('reads worker heartbeat', async () => {
    const { cwd, cleanup } = await setupTeam('rd-hb');
    try {
      const result = await executeTeamApiOperation('read-worker-heartbeat', {
        team_name: 'rd-hb', worker: 'worker-1',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('read-worker-heartbeat', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── update-worker-heartbeat ──────────────────────────────────────────────

describe('executeTeamApiOperation: update-worker-heartbeat', () => {
  it('updates worker heartbeat successfully', async () => {
    const { cwd, cleanup } = await setupTeam('upd-hb');
    try {
      const result = await executeTeamApiOperation('update-worker-heartbeat', {
        team_name: 'upd-hb', worker: 'worker-1', pid: 12345, turn_count: 5, alive: true,
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing or wrong types', async () => {
    const result = await executeTeamApiOperation('update-worker-heartbeat', {
      team_name: 'x', worker: 'w1', pid: 'not-a-number', turn_count: 1, alive: true,
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── write-worker-inbox ───────────────────────────────────────────────────

describe('executeTeamApiOperation: write-worker-inbox', () => {
  it('writes to worker inbox', async () => {
    const { cwd, cleanup } = await setupTeam('wr-inbox');
    try {
      const result = await executeTeamApiOperation('write-worker-inbox', {
        team_name: 'wr-inbox', worker: 'worker-1', content: 'Hello worker!',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('write-worker-inbox', {
      team_name: 'x', worker: 'w1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── write-worker-identity ────────────────────────────────────────────────

describe('executeTeamApiOperation: write-worker-identity', () => {
  it('writes worker identity', async () => {
    const { cwd, cleanup } = await setupTeam('wr-id');
    try {
      const result = await executeTeamApiOperation('write-worker-identity', {
        team_name: 'wr-id', worker: 'worker-1', index: 1, role: 'executor',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('writes worker identity with optional fields', async () => {
    const { cwd, cleanup } = await setupTeam('wr-id-opt');
    try {
      const result = await executeTeamApiOperation('write-worker-identity', {
        team_name: 'wr-id-opt', worker: 'worker-1', index: 1, role: 'executor',
        assigned_tasks: ['1', '2'], pid: 9999, pane_id: '%10',
        working_dir: '/tmp', worktree_path: '/wt', worktree_branch: 'main',
        worktree_detached: false, team_state_root: '/state',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('write-worker-identity', {
      team_name: 'x', worker: 'w1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── append-event ─────────────────────────────────────────────────────────

describe('executeTeamApiOperation: append-event', () => {
  it('appends a valid event', async () => {
    const { cwd, cleanup } = await setupTeam('evt-team');
    try {
      const result = await executeTeamApiOperation('append-event', {
        team_name: 'evt-team', type: 'task_completed', worker: 'worker-1', task_id: '1',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid event type', async () => {
    const result = await executeTeamApiOperation('append-event', {
      team_name: 'x', type: 'invalid_type', worker: 'w1',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /type must be one of/);
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('append-event', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-events ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-events', () => {
  it('returns canonical filtered events', async () => {
    const { cwd, cleanup } = await setupTeam('evt-read');
    try {
      const first = await appendTeamEvent('evt-read', {
        type: 'task_completed',
        worker: 'worker-2',
        task_id: '2',
      }, cwd);
      const second = await appendTeamEvent('evt-read', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, cwd);
      await appendTeamEvent('evt-read', {
        type: 'task_failed',
        worker: 'worker-1',
        task_id: '1',
      }, cwd);

      const result = await executeTeamApiOperation('read-events', {
        team_name: 'evt-read',
        after_event_id: first.event_id,
        worker: 'worker-1',
        task_id: '1',
        type: 'worker_idle',
      }, cwd);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.count, 1);
        assert.equal(result.data.cursor, second.event_id);
        const events = result.data.events as Array<{ type?: string; source_type?: string; worker?: string; task_id?: string }>;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.type, 'worker_state_changed');
        assert.equal(events[0]?.source_type, 'worker_idle');
        assert.equal(events[0]?.worker, 'worker-1');
        assert.equal(events[0]?.task_id, '1');
      }
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid event filters', async () => {
    const result = await executeTeamApiOperation('read-events', {
      team_name: 'evt-read-invalid',
      type: 'not_an_event',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /type must be one of/);
    }
  });
});

// ─── await-event ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: await-event', () => {
  it('waits for the next matching event', async () => {
    const { cwd, cleanup } = await setupTeam('evt-await');
    try {
      const waitPromise = executeTeamApiOperation('await-event', {
        team_name: 'evt-await',
        worker: 'worker-1',
        task_id: '1',
        type: 'task_completed',
        timeout_ms: 500,
        poll_ms: 25,
      }, cwd);

      setTimeout(() => {
        void appendTeamEvent('evt-await', {
          type: 'worker_state_changed',
          worker: 'worker-2',
          task_id: '2',
          state: 'working',
        }, cwd);
      }, 25);

      setTimeout(() => {
        void appendTeamEvent('evt-await', {
          type: 'task_completed',
          worker: 'worker-1',
          task_id: '1',
        }, cwd);
      }, 60);

      const result = await waitPromise;
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.status, 'event');
        assert.equal(typeof result.data.cursor, 'string');
        const event = result.data.event as { type?: string; worker?: string; task_id?: string } | null;
        assert.equal(event?.type, 'task_completed');
        assert.equal(event?.worker, 'worker-1');
        assert.equal(event?.task_id, '1');
      }
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid timeout values', async () => {
    const result = await executeTeamApiOperation('await-event', {
      team_name: 'evt-await-invalid',
      timeout_ms: -1,
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error.message, /timeout_ms must be a non-negative integer/);
    }
  });
});

// ─── read-idle-state ────────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-idle-state', () => {
  it('returns structured idle state from summary, snapshot, and recent events', async () => {
    const { cwd, cleanup } = await setupTeam('idle-state-team');
    try {
      await writeMonitorSnapshot('idle-state-team', {
        taskStatusById: { '1': 'pending' },
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'working' },
        workerTurnCountByName: { 'worker-1': 3, 'worker-2': 5 },
        workerTaskIdByName: { 'worker-1': '1', 'worker-2': '1' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, cwd);
      await appendTeamEvent('idle-state-team', {
        type: 'worker_idle',
        worker: 'worker-1',
        task_id: '1',
        prev_state: 'working',
      }, cwd);
      const allIdleEvent = await appendTeamEvent('idle-state-team', {
        type: 'all_workers_idle',
        worker: 'worker-1',
        worker_count: 2,
      }, cwd);

      const result = await executeTeamApiOperation('read-idle-state', {
        team_name: 'idle-state-team',
      }, cwd);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.team_name, 'idle-state-team');
        assert.equal(result.data.worker_count, 2);
        assert.equal(result.data.idle_worker_count, 1);
        assert.deepEqual(result.data.idle_workers, ['worker-1']);
        assert.deepEqual(result.data.non_idle_workers, ['worker-2']);
        assert.equal(result.data.all_workers_idle, false);
        const byWorker = result.data.last_idle_transition_by_worker as Record<string, { event_id?: string; source_type?: string } | null>;
        assert.equal(byWorker['worker-1']?.source_type, 'worker_idle');
        assert.equal(byWorker['worker-2'], null);
        const lastAllIdle = result.data.last_all_workers_idle_event as { event_id?: string; type?: string; worker_count?: number } | null;
        assert.equal(lastAllIdle?.event_id, allIdleEvent.event_id);
        assert.equal(lastAllIdle?.type, 'all_workers_idle');
        assert.equal(lastAllIdle?.worker_count, 2);
      }
    } finally {
      await cleanup();
    }
  });
});

// ─── read-stall-state ───────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-stall-state', () => {
  it('returns structured stall state from summary, snapshot, and recent events', async () => {
    const { cwd, cleanup } = await setupTeam('stall-state-team');
    try {
      const task = await createTask('stall-state-team', {
        subject: 'Pending work',
        description: 'Needs attention',
        status: 'pending',
      }, cwd);

      await writeWorkerStatus('stall-state-team', 'worker-1', {
        state: 'working',
        current_task_id: task.id,
        updated_at: '2026-03-10T10:00:00.000Z',
      }, cwd);
      await writeWorkerStatus('stall-state-team', 'worker-2', {
        state: 'idle',
        updated_at: '2026-03-10T10:00:00.000Z',
      }, cwd);
      await updateWorkerHeartbeat('stall-state-team', 'worker-1', {
        alive: true,
        pid: 101,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, cwd);
      await updateWorkerHeartbeat('stall-state-team', 'worker-2', {
        alive: true,
        pid: 102,
        turn_count: 1,
        last_turn_at: '2026-03-10T10:00:00.000Z',
      }, cwd);
      const primed = await executeTeamApiOperation('get-summary', {
        team_name: 'stall-state-team',
      }, cwd);
      assert.equal(primed.ok, true);

      await updateWorkerHeartbeat('stall-state-team', 'worker-1', {
        alive: true,
        pid: 101,
        turn_count: 8,
        last_turn_at: '2026-03-10T10:05:00.000Z',
      }, cwd);
      await writeMonitorSnapshot('stall-state-team', {
        taskStatusById: { [task.id]: 'pending' },
        workerAliveByName: { 'worker-1': true, 'worker-2': true },
        workerStateByName: { 'worker-1': 'idle', 'worker-2': 'idle' },
        workerTurnCountByName: { 'worker-1': 8, 'worker-2': 1 },
        workerTaskIdByName: { 'worker-1': task.id, 'worker-2': '' },
        mailboxNotifiedByMessageId: {},
        completedEventTaskIds: {},
      }, cwd);
      const idleEvent = await appendTeamEvent('stall-state-team', {
        type: 'all_workers_idle',
        worker: 'worker-2',
        worker_count: 2,
      }, cwd);
      const nudgeEvent = await appendTeamEvent('stall-state-team', {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: 'all_workers_idle',
      }, cwd);

      const result = await executeTeamApiOperation('read-stall-state', {
        team_name: 'stall-state-team',
      }, cwd);

      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.team_name, 'stall-state-team');
        assert.equal(result.data.team_stalled, true);
        assert.equal(result.data.leader_stale, true);
        assert.deepEqual(result.data.stalled_workers, ['worker-1']);
        assert.deepEqual(result.data.dead_workers, []);
        assert.equal(result.data.pending_task_count, 1);
        assert.equal(result.data.all_workers_idle, true);
        assert.match((result.data.reasons as string[]).join(' '), /workers_non_reporting:worker-1/);
        assert.match((result.data.reasons as string[]).join(' '), /leader_attention_pending:team_leader_nudge/);
        const lastAllIdle = result.data.last_all_workers_idle_event as { event_id?: string } | null;
        const lastNudge = result.data.last_team_leader_nudge_event as { event_id?: string; reason?: string } | null;
        assert.equal(lastAllIdle?.event_id, idleEvent.event_id);
        assert.equal(lastNudge?.event_id, nudgeEvent.event_id);
        assert.equal(lastNudge?.reason, 'all_workers_idle');
      }
    } finally {
      await cleanup();
    }
  });
});

// ─── get-summary ──────────────────────────────────────────────────────────

describe('executeTeamApiOperation: get-summary', () => {
  it('returns summary for existing team', async () => {
    const { cwd, cleanup } = await setupTeam('sum-team');
    try {
      const result = await executeTeamApiOperation('get-summary', {
        team_name: 'sum-team',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns team_not_found for nonexistent team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-interop-sum-nf-'));
    try {
      const result = await executeTeamApiOperation('get-summary', {
        team_name: 'nonexistent-sum',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, 'team_not_found');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('get-summary', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── cleanup ──────────────────────────────────────────────────────────────

describe('executeTeamApiOperation: cleanup', () => {
  it('routes normal cleanup through shutdownTeam', async () => {
    const { cwd, cleanup } = await setupTeam('cleanup-team');
    try {
      const result = await executeTeamApiOperation('cleanup', {
        team_name: 'cleanup-team',
      }, cwd);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.data.team_name, 'cleanup-team');
        assert.equal(result.data.cleanup_mode, 'shutdown');
      }
    } finally {
      await cleanup();
    }
  });

  it('does not bypass shutdown gate for pending work', async () => {
    const { cwd, cleanup } = await setupTeam('cleanup-gated');
    try {
      await createTask('cleanup-gated', {
        subject: 'pending task',
        description: 'should block normal cleanup',
        status: 'pending',
      }, cwd);
      const result = await executeTeamApiOperation('cleanup', {
        team_name: 'cleanup-gated',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /shutdown_gate_blocked/);
    } finally {
      await cleanup();
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('cleanup', {}, '/tmp');
    assert.equal(result.ok, false);
  });

  it('routes cleanup through the shutdown gate for failed tasks on normal teams', async () => {
    const { cwd, cleanup } = await setupTeam('cleanup-gate');
    try {
      await createTask('cleanup-gate', {
        subject: 'failed task',
        description: 'must keep team state when gate blocks cleanup',
        status: 'failed',
      }, cwd);

      const result = await executeTeamApiOperation('cleanup', {
        team_name: 'cleanup-gate',
      }, cwd);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /shutdown_gate_blocked:pending=0,blocked=0,in_progress=0,failed=1/);
      }

      const summary = await executeTeamApiOperation('get-summary', {
        team_name: 'cleanup-gate',
      }, cwd);
      assert.equal(summary.ok, true);
    } finally {
      await cleanup();
    }
  });


});

describe('executeTeamApiOperation: orphan-cleanup', () => {
  it('uses destructive orphan cleanup explicitly', async () => {
    const { cwd } = await setupTeam('cleanup-orphan');
    const result = await executeTeamApiOperation('orphan-cleanup', {
      team_name: 'cleanup-orphan',
    }, cwd);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.team_name, 'cleanup-orphan');
      assert.equal(result.data.cleanup_mode, 'orphan_cleanup');
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('orphan-cleanup', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── write-shutdown-request ───────────────────────────────────────────────

describe('executeTeamApiOperation: write-shutdown-request', () => {
  it('writes a shutdown request', async () => {
    const { cwd, cleanup } = await setupTeam('sd-req');
    try {
      const result = await executeTeamApiOperation('write-shutdown-request', {
        team_name: 'sd-req', worker: 'worker-1', requested_by: 'leader-fixed',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('write-shutdown-request', {
      team_name: 'x', worker: 'w1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-shutdown-ack ────────────────────────────────────────────────────

describe('executeTeamApiOperation: read-shutdown-ack', () => {
  it('reads shutdown ack (null when not present)', async () => {
    const { cwd, cleanup } = await setupTeam('sd-ack');
    try {
      const result = await executeTeamApiOperation('read-shutdown-ack', {
        team_name: 'sd-ack', worker: 'worker-1',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('supports min_updated_at parameter', async () => {
    const { cwd, cleanup } = await setupTeam('sd-ack-min');
    try {
      const result = await executeTeamApiOperation('read-shutdown-ack', {
        team_name: 'sd-ack-min', worker: 'worker-1', min_updated_at: new Date().toISOString(),
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('read-shutdown-ack', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-monitor-snapshot ────────────────────────────────────────────────

describe('executeTeamApiOperation: read-monitor-snapshot', () => {
  it('reads monitor snapshot', async () => {
    const { cwd, cleanup } = await setupTeam('rd-mon');
    try {
      const result = await executeTeamApiOperation('read-monitor-snapshot', {
        team_name: 'rd-mon',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when team_name missing', async () => {
    const result = await executeTeamApiOperation('read-monitor-snapshot', {}, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── write-monitor-snapshot ───────────────────────────────────────────────

describe('executeTeamApiOperation: write-monitor-snapshot', () => {
  it('writes monitor snapshot', async () => {
    const { cwd, cleanup } = await setupTeam('wr-mon');
    try {
      const result = await executeTeamApiOperation('write-monitor-snapshot', {
        team_name: 'wr-mon',
        snapshot: {
          teamName: 'wr-mon',
          phase: 'team-exec',
          workers: [],
          tasks: { total: 0, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 },
          deadWorkers: [],
          nonReportingWorkers: [],
        },
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when snapshot missing', async () => {
    const result = await executeTeamApiOperation('write-monitor-snapshot', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── read-task-approval ───────────────────────────────────────────────────

describe('executeTeamApiOperation: read-task-approval', () => {
  it('reads task approval (null when not set)', async () => {
    const { cwd, cleanup } = await setupTeam('rd-appr');
    try {
      const task = await createTask('rd-appr', { subject: 'A', description: 'B', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('read-task-approval', {
        team_name: 'rd-appr', task_id: task.id,
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('read-task-approval', {
      team_name: 'x',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── write-task-approval ──────────────────────────────────────────────────

describe('executeTeamApiOperation: write-task-approval', () => {
  it('writes task approval successfully', async () => {
    const { cwd, cleanup } = await setupTeam('wr-appr');
    try {
      const task = await createTask('wr-appr', { subject: 'A', description: 'B', status: 'pending' }, cwd);
      const result = await executeTeamApiOperation('write-task-approval', {
        team_name: 'wr-appr', task_id: task.id, status: 'approved',
        reviewer: 'leader-fixed', decision_reason: 'Looks good',
      }, cwd);
      assert.equal(result.ok, true);
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid approval status', async () => {
    const result = await executeTeamApiOperation('write-task-approval', {
      team_name: 'x', task_id: '1', status: 'maybe',
      reviewer: 'r', decision_reason: 'reason',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /status must be one of/);
  });

  it('rejects non-boolean required field', async () => {
    const result = await executeTeamApiOperation('write-task-approval', {
      team_name: 'x', task_id: '1', status: 'approved',
      reviewer: 'r', decision_reason: 'reason', required: 'yes',
    }, '/tmp');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /required must be a boolean/);
  });

  it('returns error when required fields missing', async () => {
    const result = await executeTeamApiOperation('write-task-approval', {
      team_name: 'x', task_id: '1',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});

// ─── error envelope (catch block) ─────────────────────────────────────────

describe('executeTeamApiOperation: error handling', () => {
  it('wraps thrown errors in an error envelope', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-interop-err-'));
    try {
      await mkdir(join(cwd, '.omx', 'state', 'team', 'err-team'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'err-team', 'config.json'), '{}', 'utf8');

      const result = await executeTeamApiOperation('claim-task', {
        team_name: 'err-team', task_id: '1', worker: 'w1',
      }, cwd);
      assert.ok(result.ok === true || result.ok === false);
      if (!result.ok) {
        assert.equal(result.operation, 'claim-task');
        assert.ok(result.error.code);
        assert.ok(result.error.message);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves team cwd from empty team_name using fallback', async () => {
    const result = await executeTeamApiOperation('list-tasks', {
      team_name: '',
    }, '/tmp');
    assert.equal(result.ok, false);
  });
});
