import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { initTeamState, appendTeamEvent } from '../../team/state.js';

const OMX_JOBS_DIR = join(homedir(), '.omx', 'team-jobs');

async function writeJobFiles(
  jobId: string,
  job: Record<string, unknown>,
  panes: { paneIds: string[]; leaderPaneId: string },
): Promise<void> {
  await mkdir(OMX_JOBS_DIR, { recursive: true });
  await writeFile(join(OMX_JOBS_DIR, `${jobId}.json`), JSON.stringify(job));
  await writeFile(join(OMX_JOBS_DIR, `${jobId}-panes.json`), JSON.stringify(panes));
}

async function cleanupJobFiles(jobId: string): Promise<void> {
  await rm(join(OMX_JOBS_DIR, `${jobId}.json`), { force: true });
  await rm(join(OMX_JOBS_DIR, `${jobId}-panes.json`), { force: true });
}

async function loadTeamServer() {
  process.env.OMX_TEAM_SERVER_DISABLE_AUTO_START = '1';
  return await import('../team-server.js');
}

describe('team-server wait semantics', () => {
  it('keeps default terminal semantics unchanged when wake_on is omitted', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-wait-default-'));
    const jobId = `omx-${Date.now().toString(36)}`;
    try {
      await initTeamState('wait-default', 'task', 'executor', 1, cwd);
      await writeJobFiles(jobId, {
        status: 'completed',
        startedAt: Date.now() - 1000,
        teamName: 'wait-default',
        cwd,
        result: JSON.stringify({ status: 'completed', ok: true }),
      }, {
        paneIds: ['%2'],
        leaderPaneId: '%1',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_wait',
          arguments: { job_id: jobId, timeout_ms: 50 },
        },
      });

      const payload = JSON.parse(response.content[0]?.text ?? '{}') as { status?: string; result?: { ok?: boolean } };
      assert.equal(payload.status, 'completed');
      assert.equal(payload.result?.ok, true);
    } finally {
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns next event with cursor in wake_on=event mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-wait-event-'));
    const jobId = `omx-${Date.now().toString(36)}`;
    try {
      await initTeamState('wait-event', 'task', 'executor', 1, cwd);
      const baseline = await appendTeamEvent('wait-event', {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: 'baseline',
      }, cwd);
      const next = await appendTeamEvent('wait-event', {
        type: 'worker_state_changed',
        worker: 'worker-1',
        state: 'blocked',
        prev_state: 'working',
        reason: 'needs_follow_up',
      }, cwd);

      await writeJobFiles(jobId, {
        status: 'running',
        startedAt: Date.now() - 1000,
        teamName: 'wait-event',
        cwd,
      }, {
        paneIds: [],
        leaderPaneId: '%1',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_wait',
          arguments: {
            job_id: jobId,
            timeout_ms: 100,
            wake_on: 'event',
            after_event_id: baseline.event_id,
          },
        },
      });

      const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
        status?: string;
        wake_on?: string;
        cursor?: string;
        event?: { event_id?: string; type?: string; state?: string; prev_state?: string };
      };
      assert.equal(payload.status, 'running');
      assert.equal(payload.wake_on, 'event');
      assert.equal(payload.cursor, next.event_id);
      assert.equal(payload.event?.event_id, next.event_id);
      assert.equal(payload.event?.type, 'worker_state_changed');
      assert.equal(payload.event?.state, 'blocked');
      assert.equal(payload.event?.prev_state, 'working');
    } finally {
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('normalizes legacy worker_idle events in wake_on=event mode', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-wait-legacy-'));
    const jobId = `omx-${Date.now().toString(36)}`;
    try {
      await initTeamState('wait-legacy', 'task', 'executor', 1, cwd);
      const baseline = await appendTeamEvent('wait-legacy', {
        type: 'team_leader_nudge',
        worker: 'leader-fixed',
        reason: 'baseline',
      }, cwd);
      const idleEvent = await appendTeamEvent('wait-legacy', {
        type: 'worker_idle',
        worker: 'worker-1',
        prev_state: 'working',
        task_id: '1',
      }, cwd);

      await writeJobFiles(jobId, {
        status: 'running',
        startedAt: Date.now() - 1000,
        teamName: 'wait-legacy',
        cwd,
      }, {
        paneIds: [],
        leaderPaneId: '%1',
      });

      const { handleTeamToolCall } = await loadTeamServer();
      const response = await handleTeamToolCall({
        params: {
          name: 'omx_run_team_wait',
          arguments: {
            job_id: jobId,
            timeout_ms: 100,
            wake_on: 'event',
            after_event_id: baseline.event_id,
          },
        },
      });

      const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
        event?: { event_id?: string; type?: string; source_type?: string; state?: string; prev_state?: string };
        cursor?: string;
      };
      assert.equal(payload.cursor, idleEvent.event_id);
      assert.equal(payload.event?.type, 'worker_state_changed');
      assert.equal(payload.event?.source_type, 'worker_idle');
      assert.equal(payload.event?.state, 'idle');
      assert.equal(payload.event?.prev_state, 'working');
    } finally {
      await cleanupJobFiles(jobId);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
