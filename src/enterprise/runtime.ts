import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { readModeState, startMode, updateModeState, type ModeState } from '../modes/base.js';
import { buildEnterpriseShutdownPlan } from './shutdown.js';
import { defaultEnterprisePolicy, normalizeEnterprisePolicy } from './policy.js';
import { addDivisionLead, addSubordinate, createEnterpriseTopology, type AddEnterpriseNodeInput } from './topology.js';
import { buildEnterpriseMonitorSnapshot, projectChairmanSummary, summarizeDivisionLead } from './summary.js';
import { applyMailboxRoutingToDivisionSummaries } from './routing.js';
import {
  appendEnterpriseEvent,
  createEnterpriseAssignment,
  createEnterpriseEscalation,
  listEnterpriseMailboxMessages,
  listEnterpriseSubordinateRecords,
  persistEnterpriseRecords,
  sendEnterpriseMailboxMessage,
  type EnterpriseAssignmentRecord,
  type EnterpriseEscalationRecord,
} from './state.js';
import type {
  EnterpriseChairmanSummary,
  EnterpriseExecutionUpdate,
  EnterpriseMonitorSnapshot,
  EnterprisePolicy,
  EnterpriseShutdownStep,
  EnterpriseTopology,
} from './contracts.js';

export interface EnterpriseDivisionSeed {
  id: string;
  label: string;
  scope: string;
}

export interface EnterpriseSubordinateSeed {
  id: string;
  label: string;
  scope: string;
  leadId: string;
}

export interface EnterpriseStartOptions {
  divisions?: EnterpriseDivisionSeed[];
  subordinates?: EnterpriseSubordinateSeed[];
  policy?: Partial<EnterprisePolicy> | null;
  chairmanLabel?: string;
}

export interface EnterpriseRuntimeSnapshot {
  task: string;
  topology: EnterpriseTopology;
  chairmanSummary: EnterpriseChairmanSummary;
  monitor: EnterpriseMonitorSnapshot;
  executionUpdates: EnterpriseExecutionUpdate[];
  shutdownPlan: EnterpriseShutdownStep[];
  created_at: string;
  updated_at: string;
}

export interface EnterpriseRuntimeHandle {
  modeState: ModeState;
  snapshot: EnterpriseRuntimeSnapshot;
  snapshotPath: string;
}

export interface EnterpriseAssignmentResult {
  handle: EnterpriseRuntimeHandle;
  assignment: EnterpriseAssignmentRecord;
  subordinateId: string;
}

export interface EnterpriseEscalationResult {
  handle: EnterpriseRuntimeHandle;
  escalation: EnterpriseEscalationRecord;
}

function snapshotPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'enterprise-runtime.json');
}

function sanitizeId(prefix: string, label: string, index: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base ? `${prefix}-${base}` : `${prefix}-${index + 1}`;
}

function buildDivisionSeeds(task: string, divisions?: EnterpriseDivisionSeed[]): EnterpriseDivisionSeed[] {
  if (Array.isArray(divisions) && divisions.length > 0) return divisions;
  return [{ id: 'division-1', label: 'Division 1', scope: task }];
}

function buildSubordinateSeeds(divisions: EnterpriseDivisionSeed[], subordinates?: EnterpriseSubordinateSeed[]): EnterpriseSubordinateSeed[] {
  if (Array.isArray(subordinates) && subordinates.length > 0) return subordinates;
  return divisions.map((division, index) => ({
    id: `subordinate-${index + 1}`,
    label: `${division.label} Subordinate`,
    scope: division.scope,
    leadId: division.id,
  }));
}

async function buildSnapshot(projectRoot: string, task: string, topology: EnterpriseTopology, executionUpdates: EnterpriseExecutionUpdate[]): Promise<EnterpriseRuntimeSnapshot> {
  const subordinateReports = executionUpdates
    .filter((update): update is EnterpriseExecutionUpdate & { status: 'completed' | 'blocked' | 'failed' } => {
      const node = topology.nodes[update.nodeId];
      return node?.role === 'subordinate' && (update.status === 'completed' || update.status === 'blocked' || update.status === 'failed');
    })
    .map((update) => {
      const node = topology.nodes[update.nodeId]!;
      return {
        subordinateId: node.id,
        leadId: node.parentId!,
        scope: node.scope,
        status: update.status,
        summary: update.summary,
        details: update.details,
        blockers: update.blockers,
        filesTouched: update.filesTouched,
        escalated: update.escalated,
      };
    });

  const baseDivisionSummaries = Object.values(topology.nodes)
    .filter((node) => node.role === 'division_lead')
    .map((lead) => summarizeDivisionLead(topology, lead.id, subordinateReports.filter((report) => report.leadId === lead.id)));

  const mailboxMessages = await listEnterpriseMailboxMessages(projectRoot).catch(() => []);
  const subordinateRecords = await listEnterpriseSubordinateRecords(projectRoot).catch(() => []);
  const divisionSummaries = applyMailboxRoutingToDivisionSummaries(baseDivisionSummaries, mailboxMessages, subordinateRecords);

  const chairmanSummary = projectChairmanSummary(topology, divisionSummaries);
  const monitor = buildEnterpriseMonitorSnapshot(topology, executionUpdates);
  const shutdownPlan = buildEnterpriseShutdownPlan(topology);
  const now = new Date().toISOString();

  return {
    task,
    topology,
    chairmanSummary,
    monitor,
    executionUpdates,
    shutdownPlan,
    created_at: now,
    updated_at: now,
  };
}

async function writeSnapshot(cwd: string, snapshot: EnterpriseRuntimeSnapshot): Promise<string> {
  const path = snapshotPath(cwd);
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot, null, 2));
  return path;
}

async function persistEnterpriseSnapshotArtifacts(cwd: string, snapshot: EnterpriseRuntimeSnapshot): Promise<void> {
  await persistEnterpriseRecords(cwd, snapshot.topology, snapshot.executionUpdates, snapshot.chairmanSummary.divisions, snapshot.chairmanSummary);
}

function topologyCounts(topology: EnterpriseTopology): { divisionCount: number; subordinateCount: number; maxDepthUsed: number } {
  const nodes = Object.values(topology.nodes);
  return {
    divisionCount: nodes.filter((node) => node.role === 'division_lead').length,
    subordinateCount: nodes.filter((node) => node.role === 'subordinate').length,
    maxDepthUsed: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
  };
}

function computePhase(monitor: EnterpriseMonitorSnapshot): string {
  if (monitor.failedDivisionIds.length > 0) return 'enterprise-exec';
  if (monitor.blockedDivisionIds.length > 0) return 'enterprise-exec';
  if (monitor.subordinateCount > 0 && monitor.chairmanState === 'completed') return 'enterprise-verify';
  return 'enterprise-exec';
}

async function persistHandle(projectRoot: string, snapshot: EnterpriseRuntimeSnapshot, extraState: Partial<ModeState> = {}): Promise<EnterpriseRuntimeHandle> {
  const path = await writeSnapshot(projectRoot, snapshot);
  await persistEnterpriseSnapshotArtifacts(projectRoot, snapshot);
  const counts = topologyCounts(snapshot.topology);
  const updatedState = await updateModeState('enterprise', {
    current_phase: computePhase(snapshot.monitor),
    division_count: counts.divisionCount,
    subordinate_count: counts.subordinateCount,
    chairman_state: snapshot.monitor.chairmanState,
    blocked_division_ids: snapshot.monitor.blockedDivisionIds,
    failed_division_ids: snapshot.monitor.failedDivisionIds,
    snapshot_path: path,
    last_turn_at: snapshot.updated_at,
    ...extraState,
  }, projectRoot);
  return { modeState: updatedState, snapshot, snapshotPath: path };
}

function nextSubordinateIndex(topology: EnterpriseTopology): number {
  const ids = Object.keys(topology.nodes)
    .filter((id) => topology.nodes[id]?.role === 'subordinate')
    .map((id) => {
      const match = /subordinate-(\d+)$/.exec(id);
      return match ? Number.parseInt(match[1] ?? '0', 10) : 0;
    });
  return (ids.length > 0 ? Math.max(...ids) : 0) + 1;
}

export async function startEnterpriseRuntime(
  task: string,
  options: EnterpriseStartOptions = {},
  cwd: string = process.cwd(),
): Promise<EnterpriseRuntimeHandle> {
  const projectRoot = resolve(cwd);
  const existing = await readModeState('enterprise', projectRoot);
  if (existing?.active === true) {
    throw new Error('Enterprise mode is already active. Use "omx enterprise status", "omx enterprise complete", or "omx cancel" first.');
  }

  const normalizedPolicy = normalizeEnterprisePolicy(options.policy);
  await startMode('enterprise', task, 20, projectRoot);
  let topology = createEnterpriseTopology({
    task,
    chairmanLabel: options.chairmanLabel ?? 'Chairman',
    policy: normalizedPolicy,
  });

  const divisions = buildDivisionSeeds(task, options.divisions).map((division, index) => ({
    id: division.id || sanitizeId('division', division.label, index),
    label: division.label,
    scope: division.scope,
  } satisfies AddEnterpriseNodeInput));

  for (const division of divisions) {
    topology = addDivisionLead(topology, division);
  }

  const subordinates = buildSubordinateSeeds(divisions, options.subordinates).map((subordinate, index) => ({
    id: subordinate.id || sanitizeId('subordinate', subordinate.label, index),
    label: subordinate.label,
    scope: subordinate.scope,
    leadId: subordinate.leadId,
  }));

  for (const subordinate of subordinates) {
    topology = addSubordinate(topology, subordinate.leadId, {
      id: subordinate.id,
      label: subordinate.label,
      scope: subordinate.scope,
    });
  }

  const executionUpdates: EnterpriseExecutionUpdate[] = Object.values(topology.nodes)
    .filter((node) => node.role === 'subordinate')
    .map((node) => ({
      nodeId: node.id,
      status: 'pending',
      summary: `Pending subordinate scope: ${node.scope}`,
    }));

  const snapshot = await buildSnapshot(projectRoot, task, topology, executionUpdates);
  const handle = await persistHandle(projectRoot, snapshot, {
    task_description: task,
    tree_depth: topologyCounts(topology).maxDepthUsed,
    chairman_id: topology.rootId,
    chairman_visibility: normalizedPolicy.chairman_visibility,
    policy: normalizedPolicy,
  });

  await appendEnterpriseEvent(projectRoot, {
    type: 'runtime_started',
    summary: `Enterprise runtime started for task: ${task}`,
    createdAt: snapshot.updated_at,
    payload: { divisions: snapshot.monitor.divisionCount, subordinates: snapshot.monitor.subordinateCount },
  });

  return handle;
}

export async function readEnterpriseRuntime(cwd: string = process.cwd()): Promise<EnterpriseRuntimeHandle | null> {
  const projectRoot = resolve(cwd);
  const state = await readModeState('enterprise', projectRoot);
  const path = snapshotPath(projectRoot);
  if (!state || !existsSync(path)) return null;
  const snapshot = JSON.parse(await readFile(path, 'utf-8')) as EnterpriseRuntimeSnapshot;
  return { modeState: state, snapshot, snapshotPath: path };
}

export async function refreshEnterpriseRuntime(cwd: string = process.cwd()): Promise<EnterpriseRuntimeHandle> {
  const projectRoot = resolve(cwd);
  const handle = await readEnterpriseRuntime(projectRoot);
  if (!handle) throw new Error('Enterprise mode has not been started.');
  const snapshot = await buildSnapshot(projectRoot, handle.snapshot.task, handle.snapshot.topology, handle.snapshot.executionUpdates);
  return persistHandle(projectRoot, snapshot);
}

export async function applyEnterpriseExecutionUpdates(
  updates: EnterpriseExecutionUpdate[],
  cwd: string = process.cwd(),
): Promise<EnterpriseRuntimeHandle> {
  const projectRoot = resolve(cwd);
  const handle = await readEnterpriseRuntime(projectRoot);
  if (!handle) {
    throw new Error('Enterprise mode has not been started.');
  }

  const byNodeId = new Map(handle.snapshot.executionUpdates.map((update) => [update.nodeId, update] as const));
  for (const update of updates) {
    byNodeId.set(update.nodeId, update);
  }
  const mergedUpdates = [...byNodeId.values()];
  const snapshot = await buildSnapshot(projectRoot, handle.snapshot.task, handle.snapshot.topology, mergedUpdates);
  const nextHandle = await persistHandle(projectRoot, snapshot);

  for (const update of updates) {
    await appendEnterpriseEvent(projectRoot, {
      type: 'execution_update',
      nodeId: update.nodeId,
      summary: update.summary,
      createdAt: snapshot.updated_at,
      payload: { status: update.status, blockers: update.blockers ?? [], escalated: update.escalated === true },
    });
    if (update.escalated === true) {
      const node = snapshot.topology.nodes[update.nodeId];
      const escalation = await createEnterpriseEscalation(projectRoot, {
        nodeId: update.nodeId,
        leadId: node?.parentId ?? null,
        summary: update.summary,
        details: update.details,
      });
      await sendEnterpriseMailboxMessage(projectRoot, update.nodeId, 'chairman-1', `ESCALATION: ${escalation.summary}${escalation.details ? `\n${escalation.details}` : ''}`);
      await appendEnterpriseEvent(projectRoot, {
        type: 'escalation_created',
        nodeId: update.nodeId,
        summary: escalation.summary,
        createdAt: escalation.createdAt,
        payload: { escalationId: escalation.escalationId },
      });
    }
  }

  return nextHandle;
}

export async function assignEnterpriseSubordinate(
  leadId: string,
  subject: string,
  scope: string,
  cwd: string = process.cwd(),
): Promise<EnterpriseAssignmentResult> {
  const projectRoot = resolve(cwd);
  const handle = await readEnterpriseRuntime(projectRoot);
  if (!handle) throw new Error('Enterprise mode has not been started.');
  const lead = handle.snapshot.topology.nodes[leadId];
  if (!lead || lead.role !== 'division_lead') {
    throw new Error(`Enterprise division lead not found: ${leadId}`);
  }

  const subordinateId = sanitizeId('subordinate', subject, nextSubordinateIndex(handle.snapshot.topology) - 1);
  const nextTopology = addSubordinate(handle.snapshot.topology, leadId, {
    id: subordinateId,
    label: subject,
    scope,
  });
  const nextUpdates = [
    ...handle.snapshot.executionUpdates,
    {
      nodeId: subordinateId,
      status: 'pending' as const,
      summary: `Pending subordinate scope: ${scope}`,
    },
  ];
  const snapshot = await buildSnapshot(projectRoot, handle.snapshot.task, nextTopology, nextUpdates);
  const nextHandle = await persistHandle(projectRoot, snapshot);
  const assignment = await createEnterpriseAssignment(projectRoot, {
    nodeId: subordinateId,
    leadId,
    subject,
    description: scope,
  });
  await appendEnterpriseEvent(projectRoot, {
    type: 'assignment_created',
    nodeId: subordinateId,
    summary: `Assigned subordinate ${subordinateId} to ${leadId}: ${subject}`,
    createdAt: assignment.createdAt,
    payload: { assignmentId: assignment.assignmentId, leadId, scope },
  });
  return { handle: nextHandle, assignment, subordinateId };
}

export async function escalateEnterpriseNode(
  nodeId: string,
  summary: string,
  details: string | undefined,
  cwd: string = process.cwd(),
): Promise<EnterpriseEscalationResult> {
  const projectRoot = resolve(cwd);
  const handle = await readEnterpriseRuntime(projectRoot);
  if (!handle) throw new Error('Enterprise mode has not been started.');
  const node = handle.snapshot.topology.nodes[nodeId];
  if (!node) throw new Error(`Enterprise node not found: ${nodeId}`);

  const current = handle.snapshot.executionUpdates.find((update) => update.nodeId === nodeId);
  const nextHandle = await applyEnterpriseExecutionUpdates([
    {
      nodeId,
      status: current?.status ?? 'working',
      summary: current?.summary ?? summary,
      details,
      blockers: current?.blockers,
      filesTouched: current?.filesTouched,
      escalated: true,
    },
  ], projectRoot);
  const escalation = await createEnterpriseEscalation(projectRoot, {
    nodeId,
    leadId: node.parentId,
    summary,
    details,
  });
  await sendEnterpriseMailboxMessage(projectRoot, nodeId, 'chairman-1', `ESCALATION: ${summary}${details ? `\n${details}` : ''}`);
  await appendEnterpriseEvent(projectRoot, {
    type: 'escalation_created',
    nodeId,
    summary,
    createdAt: escalation.createdAt,
    payload: { escalationId: escalation.escalationId },
  });
  return { handle: nextHandle, escalation };
}

export async function completeEnterpriseRuntime(cwd: string = process.cwd()): Promise<ModeState> {
  const projectRoot = resolve(cwd);
  const current = await readModeState('enterprise', projectRoot);
  if (!current) {
    throw new Error('Enterprise mode has not been started.');
  }
  return updateModeState('enterprise', {
    active: false,
    current_phase: 'complete',
    completed_at: new Date().toISOString(),
    last_turn_at: new Date().toISOString(),
  }, projectRoot);
}

export function summarizeEnterpriseHandle(handle: EnterpriseRuntimeHandle): string[] {
  const { snapshot, modeState } = handle;
  const counts = topologyCounts(snapshot.topology);
  const policy = (modeState.policy as EnterprisePolicy | undefined) ?? defaultEnterprisePolicy();
  const divisionLines = snapshot.monitor.divisions.map((division) => {
    const parts = [
      `- ${division.leadLabel}`,
      `state=${division.state}`,
      `subordinates=${division.subordinateCount}`,
      `completed=${division.completedCount}`,
    ];
    if (division.blockedCount > 0) parts.push(`blocked=${division.blockedCount}`);
    if (division.failedCount > 0) parts.push(`failed=${division.failedCount}`);
    if (division.latestSummary) parts.push(`latest="${division.latestSummary}"`);
    return parts.join(' | ');
  });
  const liveSession = typeof modeState.live_tmux_session === 'string' ? modeState.live_tmux_session : '';
  return [
    `Enterprise mode: ${modeState.active === true ? 'ACTIVE' : 'inactive'} (phase: ${String(modeState.current_phase)})`,
    `Task: ${snapshot.task}`,
    `Chairman: ${snapshot.topology.rootId}`,
    `Divisions: ${counts.divisionCount}`,
    `Subordinates: ${counts.subordinateCount}`,
    `Chairman state: ${snapshot.monitor.chairmanState}`,
    `Policy: depth=${policy.max_depth}, max_division_leads=${policy.max_division_leads}, max_subordinates_per_lead=${policy.max_subordinates_per_lead}`,
    `Snapshot: ${handle.snapshotPath}`,
    ...(liveSession ? [`Live tmux session: ${liveSession}`] : []),
    ...(divisionLines.length > 0 ? ['Division summaries:', ...divisionLines] : []),
  ];
}
