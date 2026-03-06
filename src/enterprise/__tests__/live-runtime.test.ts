import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('enterprise live runtime', () => {
  it('persists live tmux metadata and subordinate pane records', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-live-'));
    const previousTmux = process.env.TMUX;
    process.env.TMUX = 'leader-session';
    try {
      const tmuxSession = await import('../tmux-adapter.js');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1',
        workerCount: 1,
        cwd,
        workerPaneIds: ['%101'],
        leaderPaneId: '%100',
        hudPaneId: null,
        resizeHookName: null,
        resizeHookTarget: null,
      }));
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');

      const runtime = await import('../runtime.js');
      await runtime.startEnterpriseRuntime('issue 590', {}, cwd);
      const liveRuntime = await import('../live-runtime.js');
      const handle = await liveRuntime.startEnterpriseLiveRuntime(cwd);

      assert.equal(handle.live.tmuxSessionName, 'leader:1');
      assert.equal(handle.live.workers.some((worker) => worker.role === 'division_lead'), true);
      assert.equal(handle.live.workers.some((worker) => worker.role === 'subordinate'), true);
      assert.equal(handle.live.workers.find((worker) => worker.nodeId === 'subordinate-1')?.ownerLeadId, 'division-1');
      const workerIdentity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'enterprise', 'workers', 'subordinate-1.json'), 'utf-8')) as { nodeId: string; role: string };
      const workerState = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'enterprise', 'worker-state', 'subordinate-1.json'), 'utf-8')) as { nodeId: string; state: string };
      const workerHeartbeat = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'enterprise', 'worker-heartbeat', 'subordinate-1.json'), 'utf-8')) as { nodeId: string; alive: boolean };
      assert.equal(workerIdentity.nodeId, 'subordinate-1');
      assert.equal(workerIdentity.role, 'subordinate');
      assert.equal(workerState.nodeId, 'subordinate-1');
      assert.equal(workerState.state, 'active');
      assert.equal(workerHeartbeat.nodeId, 'subordinate-1');
      assert.equal(workerHeartbeat.alive, true);
      const reread = await runtime.readEnterpriseRuntime(cwd);
      assert.equal(reread?.modeState.live_subordinate_count, 1);
      const monitor = await liveRuntime.readEnterpriseMonitorSnapshot(cwd);
      assert.ok(monitor);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'enterprise-live-runtime.json')), true);
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('spawns a subordinate pane when a new subordinate is assigned during live runtime', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-live-'));
    const previousTmux = process.env.TMUX;
    process.env.TMUX = 'leader-session';
    try {
      const tmuxSession = await import('../tmux-adapter.js');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      const spawned: string[] = [];
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'spawnPane', async () => {
        const id = `%10${spawned.length + 2}`;
        spawned.push(id);
        return id;
      });

      const runtime = await import('../runtime.js');
      const liveRuntime = await import('../live-runtime.js');
      await runtime.startEnterpriseRuntime('issue 590', {}, cwd);
      await liveRuntime.startEnterpriseLiveRuntime(cwd);
      const assigned = await runtime.assignEnterpriseSubordinate('division-1', 'Verifier', 'verify runtime shell', cwd);
      const live = await liveRuntime.spawnEnterpriseSubordinateWorker(assigned.subordinateId, cwd);

      assert.equal(live.workers.some((worker) => worker.nodeId === assigned.subordinateId), true);
      assert.equal(spawned.length >= 2, true);
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shuts down live runtime and clears persisted live state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-live-'));
    const previousTmux = process.env.TMUX;
    process.env.TMUX = 'leader-session';
    try {
      const tmuxSession = await import('../tmux-adapter.js');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async () => 'codex --yolo');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'destroyTmuxSession', async () => {});

      const runtime = await import('../runtime.js');
      await runtime.startEnterpriseRuntime('issue 590', {}, cwd);
      const liveRuntime = await import('../live-runtime.js');
      await liveRuntime.startEnterpriseLiveRuntime(cwd);
      await liveRuntime.shutdownEnterpriseLiveRuntime(cwd);

      assert.equal(existsSync(join(cwd, '.omx', 'state', 'enterprise-live-runtime.json')), false);
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'enterprise-monitor-snapshot.json')), false);
      const reread = await runtime.readEnterpriseRuntime(cwd);
      assert.equal(reread?.modeState.live_tmux_session, null);
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('shuts down a single live subordinate node', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-live-'));
    const previousTmux = process.env.TMUX;
    process.env.TMUX = 'leader-session';
    try {
      const tmuxSession = await import('../tmux-adapter.js');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'killPane', async () => {});

      const runtime = await import('../runtime.js');
      await runtime.startEnterpriseRuntime('issue 590', {}, cwd);
      const liveRuntime = await import('../live-runtime.js');
      await liveRuntime.startEnterpriseLiveRuntime(cwd);
      const updated = await liveRuntime.shutdownEnterpriseLiveNode('subordinate-1', cwd);

      assert.equal(updated.workers.some((worker) => worker.nodeId === 'subordinate-1'), false);
      const reread = await runtime.readEnterpriseRuntime(cwd);
      assert.equal(reread?.modeState.live_subordinate_count, 0);
      const workerState = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'enterprise', 'worker-state', 'subordinate-1.json'), 'utf-8')) as { state: string };
      const workerHeartbeat = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'enterprise', 'worker-heartbeat', 'subordinate-1.json'), 'utf-8')) as { alive: boolean };
      assert.equal(workerState.state, 'stopped');
      assert.equal(workerHeartbeat.alive, false);
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cascades shutdown from a division lead to its owned subordinates', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-enterprise-live-'));
    const previousTmux = process.env.TMUX;
    process.env.TMUX = 'leader-session';
    try {
      const tmuxSession = await import('../tmux-adapter.js');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'isTmuxAvailable', async () => true);
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'createTmuxSession', async () => ({
        name: 'leader:1', workerCount: 1, cwd, workerPaneIds: ['%101'], leaderPaneId: '%100', hudPaneId: null, resizeHookName: null, resizeHookTarget: null,
      }));
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'buildWorkerStartupCommand', async (_team: string, idx: number) => `codex --worker ${idx}`);
      const killed: string[] = [];
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'spawnPane', async () => '%102');
      mock.method(tmuxSession.enterpriseTmuxAdapter, 'killPane', async (paneId: string) => { killed.push(paneId); });

      const runtime = await import('../runtime.js');
      await runtime.startEnterpriseRuntime('issue 590', {}, cwd);
      const liveRuntime = await import('../live-runtime.js');
      await liveRuntime.startEnterpriseLiveRuntime(cwd);
      const updated = await liveRuntime.shutdownEnterpriseLiveNode('division-1', cwd);

      assert.equal(updated.workers.length, 0);
      assert.deepEqual(killed.sort(), ['%101', '%102']);
    } finally {
      if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
      else delete process.env.TMUX;
      mock.restoreAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
