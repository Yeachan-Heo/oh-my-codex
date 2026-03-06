import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { enterpriseTmuxAdapter, type EnterpriseTmuxSession } from './tmux-adapter.js';
import { writeEnterpriseWorkerInstructions } from './worker-bootstrap.js';
import { applyEnterpriseExecutionUpdates, readEnterpriseRuntime, type EnterpriseRuntimeHandle } from './runtime.js';
import { appendEnterpriseEvent, clearEnterpriseLiveState, sendEnterpriseMailboxMessage, writeEnterpriseWorkerHeartbeat, writeEnterpriseWorkerIdentity, writeEnterpriseWorkerState } from './state.js';
import { updateModeState } from '../modes/base.js';
import type { EnterpriseMonitorSnapshot, EnterpriseNode } from './contracts.js';

export interface EnterpriseLiveWorkerIdentity {
  nodeId: string;
  role: 'division_lead' | 'subordinate';
  ownerLeadId: string | null;
  paneId: string;
  cwd: string;
  startupCommand: string;
  instructionPath: string;
}

export interface EnterpriseLiveRuntimeSnapshot {
  tmuxSessionName: string;
  leaderPaneId: string;
  workerPaneIds: string[];
  workers: EnterpriseLiveWorkerIdentity[];
  updated_at: string;
}

export interface EnterpriseLiveRuntimeHandle {
  enterprise: EnterpriseRuntimeHandle;
  live: EnterpriseLiveRuntimeSnapshot;
  session: EnterpriseTmuxSession;
}

function liveRuntimePath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'enterprise-live-runtime.json');
}

function monitorSnapshotPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'enterprise-monitor-snapshot.json');
}

export async function persistEnterpriseMonitorSnapshot(cwd: string, monitor: EnterpriseMonitorSnapshot): Promise<string> {
  const path = monitorSnapshotPath(cwd);
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(path, JSON.stringify(monitor, null, 2));
  return path;
}

export async function readEnterpriseMonitorSnapshot(cwd: string): Promise<EnterpriseMonitorSnapshot | null> {
  const path = monitorSnapshotPath(cwd);
  if (!existsSync(path)) return null;
  return JSON.parse(await (await import('fs/promises')).readFile(path, 'utf-8')) as EnterpriseMonitorSnapshot;
}

async function buildLiveWorker(
  projectRoot: string,
  sessionName: string,
  node: EnterpriseNode & { role: 'division_lead' | 'subordinate' },
  paneId: string,
  workerIndex: number,
  ownerLeadId: string | null,
): Promise<EnterpriseLiveWorkerIdentity> {
  const now = new Date().toISOString();
  await writeEnterpriseWorkerState(projectRoot, {
    nodeId: node.id,
    state: 'starting',
    paneId,
    ownerLeadId,
    updatedAt: now,
  });
  await writeEnterpriseWorkerHeartbeat(projectRoot, {
    nodeId: node.id,
    paneId,
    alive: true,
    lastHeartbeatAt: now,
    ownerLeadId,
  });
  const instructionPath = await writeEnterpriseWorkerInstructions(projectRoot, {
    nodeId: node.id,
    role: node.role,
    scope: node.scope,
    ownerLeadId,
    stateRoot: join(projectRoot, '.omx', 'state'),
  });
  const startupCommand = await enterpriseTmuxAdapter.buildWorkerStartupCommand(
    sessionName,
    workerIndex,
    [],
    projectRoot,
    {
      OMX_ENTERPRISE_NODE_ID: node.id,
      OMX_ENTERPRISE_ROLE: node.role,
      OMX_ENTERPRISE_LEAD_ID: ownerLeadId ?? node.id,
      OMX_ENTERPRISE_PARENT_LEAD_ID: ownerLeadId ?? '',
      OMX_ENTERPRISE_STATE_ROOT: join(projectRoot, '.omx', 'state'),
    },
    'codex',
    `Enterprise ${node.role} ${node.label} owns scope: ${node.scope}. Read instructions at ${instructionPath}.`,
  );
  const record = {
    nodeId: node.id,
    role: node.role,
    ownerLeadId,
    paneId,
    cwd: projectRoot,
    startupCommand,
    instructionPath,
  };
  await writeEnterpriseWorkerIdentity(projectRoot, { ...record, updatedAt: now });
  await writeEnterpriseWorkerState(projectRoot, {
    nodeId: node.id,
    state: 'active',
    paneId,
    ownerLeadId,
    updatedAt: now,
  });
  return record;
}

async function persistLiveRuntimeSnapshot(projectRoot: string, live: EnterpriseLiveRuntimeSnapshot): Promise<void> {
  await mkdir(join(projectRoot, '.omx', 'state'), { recursive: true });
  await writeFile(liveRuntimePath(projectRoot), JSON.stringify(live, null, 2));
}

function subordinateSpawnTarget(workers: EnterpriseLiveWorkerIdentity[], leadId: string): string {
  const candidates = workers.filter((worker) => worker.ownerLeadId === leadId || worker.nodeId === leadId);
  const target = candidates[candidates.length - 1];
  if (!target) throw new Error(`No live enterprise pane found for lead ${leadId}`);
  return target.paneId;
}

export async function startEnterpriseLiveRuntime(cwd: string = process.cwd()): Promise<EnterpriseLiveRuntimeHandle> {
  const projectRoot = resolve(cwd);
  const enterprise = await readEnterpriseRuntime(projectRoot);
  if (!enterprise) throw new Error('Enterprise mode has not been started. Run "omx enterprise <task>" first.');
  if (!process.env.TMUX) throw new Error('enterprise live runtime requires running inside tmux leader pane');
  if (!(await enterpriseTmuxAdapter.isTmuxAvailable())) throw new Error('tmux is not available');

  const divisionLeads = Object.values(enterprise.snapshot.topology.nodes).filter((node): node is EnterpriseNode & { role: 'division_lead' } => node.role === 'division_lead');
  if (divisionLeads.length === 0) throw new Error('enterprise live runtime requires at least one division lead');

  const leadStartups = await Promise.all(divisionLeads.map(async (lead) => ({
    cwd: projectRoot,
    env: {
      OMX_ENTERPRISE_NODE_ID: lead.id,
      OMX_ENTERPRISE_ROLE: lead.role,
      OMX_ENTERPRISE_LEAD_ID: lead.id,
      OMX_ENTERPRISE_STATE_ROOT: join(projectRoot, '.omx', 'state'),
    },
    initialPrompt: `Enterprise division lead ${lead.label} owns scope: ${lead.scope}.`,
  })));

  const session = await enterpriseTmuxAdapter.createTmuxSession(
    `enterprise-${enterprise.snapshot.topology.rootId}`,
    divisionLeads.length,
    projectRoot,
    [],
    leadStartups,
  );

  const leadWorkers = await Promise.all(divisionLeads.map((lead, index) => (
    buildLiveWorker(projectRoot, `enterprise-${enterprise.snapshot.topology.rootId}`, lead as EnterpriseNode & { role: 'division_lead' }, session.workerPaneIds[index] ?? '', index + 1, null)
  )));

  const subordinateNodes = Object.values(enterprise.snapshot.topology.nodes).filter((node): node is EnterpriseNode & { role: 'subordinate' } => node.role === 'subordinate');
  const subordinateWorkers: EnterpriseLiveWorkerIdentity[] = [];
  let workerIndex = leadWorkers.length + 1;

  for (const node of subordinateNodes) {
    const ownerLeadId = node.parentId;
    if (!ownerLeadId) continue;
    const paneId = await enterpriseTmuxAdapter.spawnPane(
      subordinateSpawnTarget([...leadWorkers, ...subordinateWorkers], ownerLeadId),
      projectRoot,
      await enterpriseTmuxAdapter.buildWorkerStartupCommand(
        `enterprise-${enterprise.snapshot.topology.rootId}`,
        workerIndex,
        [],
        projectRoot,
        {
          OMX_ENTERPRISE_NODE_ID: node.id,
          OMX_ENTERPRISE_ROLE: node.role,
          OMX_ENTERPRISE_LEAD_ID: ownerLeadId,
          OMX_ENTERPRISE_PARENT_LEAD_ID: ownerLeadId,
          OMX_ENTERPRISE_STATE_ROOT: join(projectRoot, '.omx', 'state'),
        },
        'codex',
        `Enterprise subordinate ${node.label} is owned by ${ownerLeadId}.`,
      ),
    );
    const worker = await buildLiveWorker(projectRoot, `enterprise-${enterprise.snapshot.topology.rootId}`, node, paneId, workerIndex, ownerLeadId);
    subordinateWorkers.push(worker);
    await sendEnterpriseMailboxMessage(projectRoot, ownerLeadId, node.id, `INITIAL ASSIGNMENT: ${node.scope}`);
    workerIndex += 1;
  }

  const allWorkers = [...leadWorkers, ...subordinateWorkers];
  const live: EnterpriseLiveRuntimeSnapshot = {
    tmuxSessionName: session.name,
    leaderPaneId: session.leaderPaneId,
    workerPaneIds: allWorkers.map((worker) => worker.paneId),
    workers: allWorkers,
    updated_at: new Date().toISOString(),
  };

  await persistLiveRuntimeSnapshot(projectRoot, live);
  await persistEnterpriseMonitorSnapshot(projectRoot, enterprise.snapshot.monitor);
  await appendEnterpriseEvent(projectRoot, {
    type: 'live_runtime_started',
    summary: `Enterprise live runtime started in tmux session ${session.name}`,
    createdAt: live.updated_at,
    payload: {
      workerPaneIds: live.workerPaneIds,
      leaderPaneId: session.leaderPaneId,
      divisionLeadCount: leadWorkers.length,
      subordinateCount: subordinateWorkers.length,
    },
  });
  await updateModeState('enterprise', {
    live_tmux_session: session.name,
    live_worker_count: allWorkers.length,
    live_subordinate_count: subordinateWorkers.length,
    leader_pane_id: session.leaderPaneId,
    last_turn_at: live.updated_at,
  }, projectRoot);

  return { enterprise: (await readEnterpriseRuntime(projectRoot)) ?? enterprise, live, session };
}

export async function readEnterpriseLiveRuntime(cwd: string = process.cwd()): Promise<EnterpriseLiveRuntimeSnapshot | null> {
  const projectRoot = resolve(cwd);
  const path = liveRuntimePath(projectRoot);
  if (!existsSync(path)) return null;
  return JSON.parse(await (await import('fs/promises')).readFile(path, 'utf-8')) as EnterpriseLiveRuntimeSnapshot;
}

export async function spawnEnterpriseSubordinateWorker(subordinateNodeId: string, cwd: string = process.cwd()): Promise<EnterpriseLiveRuntimeSnapshot> {
  const projectRoot = resolve(cwd);
  const enterprise = await readEnterpriseRuntime(projectRoot);
  const live = await readEnterpriseLiveRuntime(projectRoot);
  if (!enterprise || !live) throw new Error('Enterprise live runtime has not been started.');

  const node = enterprise.snapshot.topology.nodes[subordinateNodeId];
  if (!node || node.role !== 'subordinate' || !node.parentId) {
    throw new Error(`Enterprise subordinate not found: ${subordinateNodeId}`);
  }
  if (live.workers.some((worker) => worker.nodeId === subordinateNodeId)) return live;

  const nextIndex = live.workers.length + 1;
  const paneId = await enterpriseTmuxAdapter.spawnPane(
    subordinateSpawnTarget(live.workers, node.parentId),
    projectRoot,
    await enterpriseTmuxAdapter.buildWorkerStartupCommand(
      live.tmuxSessionName,
      nextIndex,
      [],
      projectRoot,
      {
        OMX_ENTERPRISE_NODE_ID: node.id,
        OMX_ENTERPRISE_ROLE: node.role,
        OMX_ENTERPRISE_LEAD_ID: node.parentId,
        OMX_ENTERPRISE_PARENT_LEAD_ID: node.parentId,
        OMX_ENTERPRISE_STATE_ROOT: join(projectRoot, '.omx', 'state'),
      },
      'codex',
      `Enterprise subordinate ${node.label} is owned by ${node.parentId}.`,
    ),
  );
  const worker = await buildLiveWorker(projectRoot, live.tmuxSessionName, node as EnterpriseNode & { role: 'subordinate' }, paneId, nextIndex, node.parentId);
  const updatedLive: EnterpriseLiveRuntimeSnapshot = {
    ...live,
    workerPaneIds: [...live.workerPaneIds, paneId],
    workers: [...live.workers, worker],
    updated_at: new Date().toISOString(),
  };
  await persistLiveRuntimeSnapshot(projectRoot, updatedLive);
  await sendEnterpriseMailboxMessage(projectRoot, node.parentId, node.id, `ASSIGNMENT READY: ${node.scope}`);
  await updateModeState('enterprise', {
    live_worker_count: updatedLive.workers.length,
    live_subordinate_count: updatedLive.workers.filter((entry) => entry.role === 'subordinate').length,
    last_turn_at: updatedLive.updated_at,
  }, projectRoot);
  return updatedLive;
}


export async function shutdownEnterpriseLiveNode(nodeId: string, cwd: string = process.cwd()): Promise<EnterpriseLiveRuntimeSnapshot> {
  const projectRoot = resolve(cwd);
  const enterprise = await readEnterpriseRuntime(projectRoot);
  const live = await readEnterpriseLiveRuntime(projectRoot);
  if (!enterprise || !live) throw new Error('Enterprise live runtime has not been started.');
  const target = live.workers.find((entry) => entry.nodeId === nodeId);
  if (!target) throw new Error(`Enterprise live worker not found: ${nodeId}`);

  const workersToShutdown = live.workers.filter((entry) => (
    entry.nodeId === nodeId || (target.role === 'division_lead' && entry.ownerLeadId === nodeId)
  ));

  await appendEnterpriseEvent(projectRoot, {
    type: 'shutdown_requested',
    nodeId,
    summary: `Enterprise live worker shutdown requested for ${nodeId}`,
    createdAt: new Date().toISOString(),
    payload: { paneIds: workersToShutdown.map((entry) => entry.paneId) },
  });

  for (const worker of workersToShutdown) {
    await writeEnterpriseWorkerState(projectRoot, {
      nodeId: worker.nodeId,
      state: 'draining',
      paneId: worker.paneId,
      ownerLeadId: worker.ownerLeadId,
      updatedAt: new Date().toISOString(),
    });
    await enterpriseTmuxAdapter.killPane(worker.paneId);
    const stoppedAt = new Date().toISOString();
    await writeEnterpriseWorkerState(projectRoot, {
      nodeId: worker.nodeId,
      state: 'stopped',
      paneId: null,
      ownerLeadId: worker.ownerLeadId,
      updatedAt: stoppedAt,
    });
    await writeEnterpriseWorkerHeartbeat(projectRoot, {
      nodeId: worker.nodeId,
      paneId: null,
      alive: false,
      lastHeartbeatAt: stoppedAt,
      ownerLeadId: worker.ownerLeadId,
    });
  }

  const removedIds = new Set(workersToShutdown.map((entry) => entry.nodeId));
  const remainingWorkers = live.workers.filter((entry) => !removedIds.has(entry.nodeId));
  const updatedLive: EnterpriseLiveRuntimeSnapshot = {
    ...live,
    workerPaneIds: remainingWorkers.map((entry) => entry.paneId),
    workers: remainingWorkers,
    updated_at: new Date().toISOString(),
  };
  await persistLiveRuntimeSnapshot(projectRoot, updatedLive);
  for (const workerRecord of updatedLive.workers) {
    await writeEnterpriseWorkerIdentity(projectRoot, { ...workerRecord, updatedAt: updatedLive.updated_at });
    await writeEnterpriseWorkerState(projectRoot, {
      nodeId: workerRecord.nodeId,
      state: 'active',
      paneId: workerRecord.paneId,
      ownerLeadId: workerRecord.ownerLeadId,
      updatedAt: updatedLive.updated_at,
    });
    await writeEnterpriseWorkerHeartbeat(projectRoot, {
      nodeId: workerRecord.nodeId,
      paneId: workerRecord.paneId,
      alive: true,
      lastHeartbeatAt: updatedLive.updated_at,
      ownerLeadId: workerRecord.ownerLeadId,
    });
  }
  await updateModeState('enterprise', {
    live_worker_count: updatedLive.workers.length,
    live_subordinate_count: updatedLive.workers.filter((entry) => entry.role === 'subordinate').length,
    last_turn_at: updatedLive.updated_at,
  }, projectRoot);
  await appendEnterpriseEvent(projectRoot, {
    type: 'shutdown_completed',
    nodeId,
    summary: `Enterprise live worker shutdown completed for ${nodeId}`,
    createdAt: updatedLive.updated_at,
    payload: { removedNodeIds: [...removedIds] },
  });
  return updatedLive;
}


export async function nudgeEnterpriseLiveNode(nodeId: string, message: string, cwd: string = process.cwd()): Promise<void> {
  const projectRoot = resolve(cwd);
  const live = await readEnterpriseLiveRuntime(projectRoot);
  if (!live) throw new Error('Enterprise live runtime has not been started.');
  const worker = live.workers.find((entry) => entry.nodeId === nodeId);
  if (!worker) throw new Error(`Enterprise live worker not found: ${nodeId}`);
  await enterpriseTmuxAdapter.sendKeys(worker.paneId, message);
  await appendEnterpriseEvent(projectRoot, {
    type: 'mailbox_message',
    nodeId,
    summary: `Enterprise live node nudged: ${nodeId}`,
    createdAt: new Date().toISOString(),
    payload: { paneId: worker.paneId, message },
  });
}

export async function updateEnterpriseLiveMonitor(
  updates: Parameters<typeof applyEnterpriseExecutionUpdates>[0],
  cwd: string = process.cwd(),
): Promise<EnterpriseRuntimeHandle> {
  const handle = await applyEnterpriseExecutionUpdates(updates, cwd);
  await persistEnterpriseMonitorSnapshot(resolve(cwd), handle.snapshot.monitor);
  return handle;
}

export async function refreshEnterpriseLiveMonitor(cwd: string = process.cwd()): Promise<EnterpriseRuntimeHandle | null> {
  const projectRoot = resolve(cwd);
  const live = await readEnterpriseLiveRuntime(projectRoot);
  const enterprise = await readEnterpriseRuntime(projectRoot);
  if (!enterprise) return null;
  if (live) await persistEnterpriseMonitorSnapshot(projectRoot, enterprise.snapshot.monitor);
  return enterprise;
}

export async function shutdownEnterpriseLiveRuntime(cwd: string = process.cwd()): Promise<void> {
  const projectRoot = resolve(cwd);
  const enterprise = await readEnterpriseRuntime(projectRoot);
  if (!enterprise) throw new Error('Enterprise mode has not been started.');
  const live = await readEnterpriseLiveRuntime(projectRoot);
  const now = new Date().toISOString();
  await appendEnterpriseEvent(projectRoot, {
    type: 'shutdown_requested',
    summary: 'Enterprise live runtime shutdown requested',
    createdAt: now,
    payload: { liveSession: live?.tmuxSessionName ?? null },
  });
  if (live?.tmuxSessionName) {
    for (const worker of live.workers) {
      await writeEnterpriseWorkerState(projectRoot, {
        nodeId: worker.nodeId,
        state: 'draining',
        paneId: worker.paneId,
        ownerLeadId: worker.ownerLeadId,
        updatedAt: now,
      });
    }
    await enterpriseTmuxAdapter.destroyTmuxSession(live.tmuxSessionName);
    for (const worker of live.workers) {
      await writeEnterpriseWorkerState(projectRoot, {
        nodeId: worker.nodeId,
        state: 'stopped',
        paneId: null,
        ownerLeadId: worker.ownerLeadId,
        updatedAt: now,
      });
      await writeEnterpriseWorkerHeartbeat(projectRoot, {
        nodeId: worker.nodeId,
        paneId: null,
        alive: false,
        lastHeartbeatAt: now,
        ownerLeadId: worker.ownerLeadId,
      });
    }
  }
  await clearEnterpriseLiveState(projectRoot);
  await updateModeState('enterprise', {
    live_tmux_session: null,
    live_worker_count: 0,
    live_subordinate_count: 0,
    leader_pane_id: null,
    current_phase: 'enterprise-exec',
    last_turn_at: now,
  }, projectRoot);
  await appendEnterpriseEvent(projectRoot, {
    type: 'shutdown_completed',
    summary: 'Enterprise live runtime shutdown completed',
    createdAt: now,
  });
}
