import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initTeamState } from '../../team/state.js';

describe('MCP state/team tools path traversal prevention', () => {
  // Disable auto-start so tests can import the module directly
  process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';

  it('rejects invalid workingDirectory inputs containing NUL bytes', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const resp = await handleStateToolCall({
      params: {
        name: 'state_read',
        arguments: { mode: 'team', workingDirectory: 'bad\0path' },
      },
    });
    assert.equal(resp.isError, true, 'Expected isError=true for invalid workingDirectory');
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
    assert.match(body.error || '', /NUL byte/);
  });

  it('rejects traversal in team_name for team_read_config', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_config',
          arguments: { team_name: '../../../etc/passwd', workingDirectory: wd },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for team_name traversal');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in mode for state_write', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            mode: '../../outside',
            state: { active: true },
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for mode traversal');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unsupported mode names for state_read', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            mode: 'custom_mode',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for unsupported mode');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.includes('mode must be one of'));
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in team_name for team_list_tasks', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'team_list_tasks',
          arguments: { team_name: '../../../../tmp/evil', workingDirectory: wd },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for team_name traversal');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects deep traversal in team_name (../../../../../../../etc/passwd)', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_config',
          arguments: { team_name: '../../../../../../../etc/passwd', workingDirectory: wd },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for deep team_name traversal');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in worker for team_read_worker_status', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_worker_status',
          arguments: {
            team_name: 'safe-team',
            worker: '../../../etc/passwd',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for worker traversal');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in worker for team_write_worker_inbox', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team2', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_write_worker_inbox',
          arguments: {
            team_name: 'safe-team2',
            worker: '../../evil',
            content: 'malicious content',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for worker traversal in write');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in worker for team_read_worker_heartbeat', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team3', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_worker_heartbeat',
          arguments: {
            team_name: 'safe-team3',
            worker: '../../../home/user/.ssh/id_rsa',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for worker traversal in heartbeat read');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in task_id for team_read_task', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team4', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_task',
          arguments: {
            team_name: 'safe-team4',
            task_id: '../../../etc/passwd',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for task_id traversal');
      const body = JSON.parse(resp.content[0]?.text ?? '{}') as { error?: string };
      assert.ok(typeof body.error === 'string' && body.error.length > 0, 'Expected error message in response');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects non-numeric task_id for team_read_task', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team5', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_task',
          arguments: {
            team_name: 'safe-team5',
            task_id: 'evil-task',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for non-numeric task_id');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects traversal in task_id for team_read_task_approval', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('safe-team6', 'test task', 'executor', 1, wd);
      const resp = await handleStateToolCall({
        params: {
          name: 'team_read_task_approval',
          arguments: {
            team_name: 'safe-team6',
            task_id: '../../secret.json',
            workingDirectory: wd,
          },
        },
      });
      assert.equal(resp.isError, true, 'Expected isError=true for task_id traversal in approval read');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts valid team_name, worker, and task_id', async () => {
    const { handleStateToolCall } = await import('../state-server.js');
    const wd = await mkdtemp(join(tmpdir(), 'omx-traversal-'));
    try {
      await initTeamState('valid-team', 'test task', 'executor', 2, wd);

      // Valid team_name
      const configResp = await handleStateToolCall({
        params: {
          name: 'team_read_config',
          arguments: { team_name: 'valid-team', workingDirectory: wd },
        },
      });
      const configBody = JSON.parse(configResp.content[0]?.text ?? '{}') as { ok?: boolean };
      assert.equal(configBody.ok, true, 'Valid team_name should succeed');

      // Valid worker name
      const workerResp = await handleStateToolCall({
        params: {
          name: 'team_read_worker_status',
          arguments: { team_name: 'valid-team', worker: 'worker-1', workingDirectory: wd },
        },
      });
      const workerBody = JSON.parse(workerResp.content[0]?.text ?? '{}') as { ok?: boolean };
      assert.equal(workerBody.ok, true, 'Valid worker name should succeed');

      // Valid task_id (create a task first, then read it)
      const createResp = await handleStateToolCall({
        params: {
          name: 'team_create_task',
          arguments: {
            team_name: 'valid-team',
            subject: 'Test task',
            description: 'Verify numeric task_id works',
            workingDirectory: wd,
          },
        },
      });
      const createBody = JSON.parse(createResp.content[0]?.text ?? '{}') as { ok?: boolean; task?: { id?: string } };
      assert.equal(createBody.ok, true, 'Task creation should succeed');

      const taskResp = await handleStateToolCall({
        params: {
          name: 'team_read_task',
          arguments: { team_name: 'valid-team', task_id: createBody.task?.id ?? '1', workingDirectory: wd },
        },
      });
      const taskBody = JSON.parse(taskResp.content[0]?.text ?? '{}') as { ok?: boolean };
      assert.equal(taskBody.ok, true, 'Valid numeric task_id should succeed');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
