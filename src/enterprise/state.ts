import { mkdir, readFile, readdir, rm, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { randomUUID } from 'crypto';
import type { EnterpriseChairmanSummary, EnterpriseDivisionSummary, EnterpriseExecutionUpdate, EnterpriseTopology } from './contracts.js';

export interface EnterpriseSubordinateRecord {
  nodeId: string;
  leadId: string | null;
  scope: string;
  status: EnterpriseExecutionUpdate['status'];
  summary: string;
  details?: string;
  blockers?: string[];
  filesTouched?: string[];
  escalated?: boolean;
  updatedAt: string;
}

export interface EnterpriseAssignmentRecord {
  assignmentId: string;
  nodeId: string;
  leadId: string | null;
  subject: string;
  description: string;
  status: 'pending' | 'assigned' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface EnterpriseEscalationRecord {
  escalationId: string;
  nodeId: string;
  leadId: string | null;
  summary: string;
  details?: string;
  createdAt: string;
}

export interface EnterpriseMailboxMessage {
  messageId: string;
  fromNodeId: string;
  toNodeId: string;
  body: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface EnterpriseMailbox {
  nodeId: string;
  messages: EnterpriseMailboxMessage[];
}



export interface EnterpriseWorkerHeartbeatRecord {
  nodeId: string;
  paneId: string | null;
  alive: boolean;
  lastHeartbeatAt: string;
  ownerLeadId: string | null;
}

export type EnterpriseWorkerHealth = 'healthy' | 'stale' | 'offline';

export interface EnterpriseWorkerStateRecord {
  nodeId: string;
  state: 'starting' | 'active' | 'draining' | 'stopped';
  paneId: string | null;
  ownerLeadId: string | null;
  updatedAt: string;
}

export interface EnterpriseWorkerIdentityRecord {
  nodeId: string;
  role: 'division_lead' | 'subordinate';
  ownerLeadId: string | null;
  paneId: string;
  cwd: string;
  startupCommand: string;
  instructionPath: string;
  updatedAt: string;
}

export interface EnterpriseEventRecord {
  type:
    | 'runtime_started'
    | 'live_runtime_started'
    | 'execution_update'
    | 'shutdown_requested'
    | 'shutdown_completed'
    | 'assignment_created'
    | 'escalation_created'
    | 'mailbox_message';
  nodeId?: string;
  summary: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

function enterpriseStateRoot(cwd: string): string {
  return join(resolve(cwd), '.omx', 'state', 'enterprise');
}

function subordinateDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'subordinates');
}

function divisionSummaryDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'division-summaries');
}

function chairmanSummaryPath(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'chairman-summary.json');
}

function eventLogPath(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'events.jsonl');
}

function assignmentDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'assignments');
}

function escalationDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'escalations');
}

function mailboxDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'mailbox');
}

export function subordinateRecordPath(cwd: string, nodeId: string): string {
  return join(subordinateDir(cwd), `${nodeId}.json`);
}

export function divisionSummaryPath(cwd: string, leadId: string): string {
  return join(divisionSummaryDir(cwd), `${leadId}.json`);
}

export function assignmentRecordPath(cwd: string, assignmentId: string): string {
  return join(assignmentDir(cwd), `${assignmentId}.json`);
}

export function escalationRecordPath(cwd: string, escalationId: string): string {
  return join(escalationDir(cwd), `${escalationId}.json`);
}

export function mailboxPath(cwd: string, nodeId: string): string {
  return join(mailboxDir(cwd), `${nodeId}.json`);
}


function workerHeartbeatDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'worker-heartbeat');
}

export function workerHeartbeatPath(cwd: string, nodeId: string): string {
  return join(workerHeartbeatDir(cwd), `${nodeId}.json`);
}

export async function writeEnterpriseWorkerHeartbeat(cwd: string, record: EnterpriseWorkerHeartbeatRecord): Promise<void> {
  await mkdir(workerHeartbeatDir(cwd), { recursive: true });
  await writeFile(workerHeartbeatPath(cwd, record.nodeId), JSON.stringify(record, null, 2));
}


export async function touchEnterpriseWorkerHeartbeat(
  cwd: string,
  nodeId: string,
  ownerLeadId: string | null,
  paneId: string | null,
): Promise<EnterpriseWorkerHeartbeatRecord> {
  const record: EnterpriseWorkerHeartbeatRecord = {
    nodeId,
    paneId,
    alive: true,
    lastHeartbeatAt: new Date().toISOString(),
    ownerLeadId,
  };
  await writeEnterpriseWorkerHeartbeat(cwd, record);
  return record;
}

export async function readEnterpriseWorkerHeartbeat(cwd: string, nodeId: string): Promise<EnterpriseWorkerHeartbeatRecord | null> {
  const path = workerHeartbeatPath(cwd, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseWorkerHeartbeatRecord;
}

export async function listEnterpriseWorkerHeartbeats(cwd: string): Promise<EnterpriseWorkerHeartbeatRecord[]> {
  const dir = workerHeartbeatDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseWorkerHeartbeatRecord;
  }));
  return records.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function classifyEnterpriseWorkerHealth(
  heartbeat: EnterpriseWorkerHeartbeatRecord | null,
  now: number = Date.now(),
  staleAfterMs: number = 60_000,
): EnterpriseWorkerHealth {
  if (!heartbeat || heartbeat.alive !== true) return 'offline';
  const last = new Date(heartbeat.lastHeartbeatAt).getTime();
  if (!Number.isFinite(last)) return 'offline';
  return now - last > staleAfterMs ? 'stale' : 'healthy';
}

function workerStateDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'worker-state');
}

export function workerStatePath(cwd: string, nodeId: string): string {
  return join(workerStateDir(cwd), `${nodeId}.json`);
}

export async function writeEnterpriseWorkerState(cwd: string, record: EnterpriseWorkerStateRecord): Promise<void> {
  await mkdir(workerStateDir(cwd), { recursive: true });
  await writeFile(workerStatePath(cwd, record.nodeId), JSON.stringify(record, null, 2));
}

export async function readEnterpriseWorkerState(cwd: string, nodeId: string): Promise<EnterpriseWorkerStateRecord | null> {
  const path = workerStatePath(cwd, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseWorkerStateRecord;
}

export async function listEnterpriseWorkerStates(cwd: string): Promise<EnterpriseWorkerStateRecord[]> {
  const dir = workerStateDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseWorkerStateRecord;
  }));
  return records.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function workerIdentityDir(cwd: string): string {
  return join(enterpriseStateRoot(cwd), 'workers');
}

export function workerIdentityPath(cwd: string, nodeId: string): string {
  return join(workerIdentityDir(cwd), `${nodeId}.json`);
}

export async function writeEnterpriseWorkerIdentity(cwd: string, record: EnterpriseWorkerIdentityRecord): Promise<void> {
  await mkdir(workerIdentityDir(cwd), { recursive: true });
  await writeFile(workerIdentityPath(cwd, record.nodeId), JSON.stringify(record, null, 2));
}

export async function readEnterpriseWorkerIdentity(cwd: string, nodeId: string): Promise<EnterpriseWorkerIdentityRecord | null> {
  const path = workerIdentityPath(cwd, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseWorkerIdentityRecord;
}

export async function listEnterpriseWorkerIdentities(cwd: string): Promise<EnterpriseWorkerIdentityRecord[]> {
  const dir = workerIdentityDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseWorkerIdentityRecord;
  }));
  return records.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export async function persistEnterpriseRecords(
  cwd: string,
  topology: EnterpriseTopology,
  executionUpdates: EnterpriseExecutionUpdate[],
  divisionSummaries: EnterpriseDivisionSummary[],
  chairmanSummary: EnterpriseChairmanSummary,
): Promise<void> {
  const root = enterpriseStateRoot(cwd);
  await mkdir(root, { recursive: true });
  await mkdir(subordinateDir(cwd), { recursive: true });
  await mkdir(divisionSummaryDir(cwd), { recursive: true });

  const updateByNodeId = new Map(executionUpdates.map((update) => [update.nodeId, update] as const));
  const subordinateNodes = Object.values(topology.nodes).filter((node) => node.role === 'subordinate');

  await Promise.all(subordinateNodes.map(async (node) => {
    const update = updateByNodeId.get(node.id) ?? {
      nodeId: node.id,
      status: 'pending' as const,
      summary: `Pending subordinate scope: ${node.scope}`,
    };
    const record: EnterpriseSubordinateRecord = {
      nodeId: node.id,
      leadId: node.parentId,
      scope: node.scope,
      status: update.status,
      summary: update.summary,
      details: update.details,
      blockers: update.blockers,
      filesTouched: update.filesTouched,
      escalated: update.escalated,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(subordinateRecordPath(cwd, node.id), JSON.stringify(record, null, 2));
  }));

  await Promise.all(divisionSummaries.map(async (summary) => {
    await writeFile(divisionSummaryPath(cwd, summary.leadId), JSON.stringify(summary, null, 2));
  }));

  await writeFile(chairmanSummaryPath(cwd), JSON.stringify(chairmanSummary, null, 2));
}

export async function appendEnterpriseEvent(cwd: string, event: EnterpriseEventRecord): Promise<void> {
  const root = enterpriseStateRoot(cwd);
  await mkdir(root, { recursive: true });
  await appendFile(eventLogPath(cwd), `${JSON.stringify(event)}\n`, 'utf-8');
}

export async function createEnterpriseAssignment(
  cwd: string,
  assignment: Omit<EnterpriseAssignmentRecord, 'assignmentId' | 'createdAt' | 'updatedAt' | 'status'>,
): Promise<EnterpriseAssignmentRecord> {
  await mkdir(assignmentDir(cwd), { recursive: true });
  const now = new Date().toISOString();
  const assignmentId = `assignment-${Date.now().toString(36)}`;
  const record: EnterpriseAssignmentRecord = {
    assignmentId,
    nodeId: assignment.nodeId,
    leadId: assignment.leadId,
    subject: assignment.subject,
    description: assignment.description,
    status: 'assigned',
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(assignmentRecordPath(cwd, assignmentId), JSON.stringify(record, null, 2));
  return record;
}

export async function listEnterpriseAssignments(cwd: string): Promise<EnterpriseAssignmentRecord[]> {
  const dir = assignmentDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseAssignmentRecord;
  }));
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function createEnterpriseEscalation(
  cwd: string,
  escalation: Omit<EnterpriseEscalationRecord, 'escalationId' | 'createdAt'>,
): Promise<EnterpriseEscalationRecord> {
  await mkdir(escalationDir(cwd), { recursive: true });
  const record: EnterpriseEscalationRecord = {
    escalationId: `escalation-${Date.now().toString(36)}`,
    nodeId: escalation.nodeId,
    leadId: escalation.leadId,
    summary: escalation.summary,
    details: escalation.details,
    createdAt: new Date().toISOString(),
  };
  await writeFile(escalationRecordPath(cwd, record.escalationId), JSON.stringify(record, null, 2));
  return record;
}

export async function listEnterpriseEscalations(cwd: string): Promise<EnterpriseEscalationRecord[]> {
  const dir = escalationDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseEscalationRecord;
  }));
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function sendEnterpriseMailboxMessage(
  cwd: string,
  fromNodeId: string,
  toNodeId: string,
  body: string,
): Promise<EnterpriseMailboxMessage> {
  await mkdir(mailboxDir(cwd), { recursive: true });
  const path = mailboxPath(cwd, toNodeId);
  const mailbox = await readEnterpriseMailbox(cwd, toNodeId);
  const message: EnterpriseMailboxMessage = {
    messageId: randomUUID(),
    fromNodeId,
    toNodeId,
    body,
    createdAt: new Date().toISOString(),
  };
  mailbox.messages.push(message);
  await writeFile(path, JSON.stringify(mailbox, null, 2));
  await appendEnterpriseEvent(cwd, {
    type: 'mailbox_message',
    nodeId: toNodeId,
    summary: `Message from ${fromNodeId} to ${toNodeId}`,
    createdAt: message.createdAt,
    payload: { messageId: message.messageId },
  });
  return message;
}

export async function readEnterpriseMailbox(cwd: string, nodeId: string): Promise<EnterpriseMailbox> {
  const path = mailboxPath(cwd, nodeId);
  if (!existsSync(path)) return { nodeId, messages: [] };
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseMailbox;
}


export async function readEnterpriseMailboxMessage(
  cwd: string,
  nodeId: string,
  messageId: string,
): Promise<EnterpriseMailboxMessage | null> {
  const mailbox = await readEnterpriseMailbox(cwd, nodeId);
  return mailbox.messages.find((entry) => entry.messageId === messageId) ?? null;
}

export async function markEnterpriseMailboxDelivered(cwd: string, nodeId: string, messageId: string): Promise<boolean> {
  const path = mailboxPath(cwd, nodeId);
  if (!existsSync(path)) return false;
  const mailbox = JSON.parse(await readFile(path, 'utf-8')) as EnterpriseMailbox;
  const message = mailbox.messages.find((entry) => entry.messageId === messageId);
  if (!message) return false;
  if (!message.deliveredAt) {
    message.deliveredAt = new Date().toISOString();
    await writeFile(path, JSON.stringify(mailbox, null, 2));
  }
  return true;
}


export async function listEnterpriseSubordinateRecords(cwd: string): Promise<EnterpriseSubordinateRecord[]> {
  const ids = await listEnterpriseSubordinateRecordIds(cwd);
  const records = await Promise.all(ids.map((id) => readEnterpriseSubordinateRecord(cwd, id)));
  return records.filter((record): record is EnterpriseSubordinateRecord => record !== null);
}

export async function listEnterpriseMailboxes(cwd: string): Promise<EnterpriseMailbox[]> {
  const dir = mailboxDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const mailboxes = await Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) => {
    const raw = await readFile(join(dir, file), 'utf-8');
    return JSON.parse(raw) as EnterpriseMailbox;
  }));
  return mailboxes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export async function listEnterpriseMailboxMessages(cwd: string): Promise<EnterpriseMailboxMessage[]> {
  const mailboxes = await listEnterpriseMailboxes(cwd);
  return mailboxes.flatMap((mailbox) => mailbox.messages);
}

export async function readEnterpriseSubordinateRecord(cwd: string, nodeId: string): Promise<EnterpriseSubordinateRecord | null> {
  const path = subordinateRecordPath(cwd, nodeId);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseSubordinateRecord;
}

export async function readEnterpriseDivisionSummary(cwd: string, leadId: string): Promise<EnterpriseDivisionSummary | null> {
  const path = divisionSummaryPath(cwd, leadId);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseDivisionSummary;
}

export async function readEnterpriseChairmanSummary(cwd: string): Promise<EnterpriseChairmanSummary | null> {
  const path = chairmanSummaryPath(cwd);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8')) as EnterpriseChairmanSummary;
}

export async function readEnterpriseEventLog(cwd: string): Promise<EnterpriseEventRecord[]> {
  const path = eventLogPath(cwd);
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf-8');
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as EnterpriseEventRecord);
}

export async function clearEnterpriseLiveState(cwd: string): Promise<void> {
  const projectRoot = resolve(cwd);
  await rm(join(projectRoot, '.omx', 'state', 'enterprise-live-runtime.json'), { force: true }).catch(() => {});
  await rm(join(projectRoot, '.omx', 'state', 'enterprise-monitor-snapshot.json'), { force: true }).catch(() => {});
}

export async function listEnterpriseSubordinateRecordIds(cwd: string): Promise<string[]> {
  const dir = subordinateDir(cwd);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files.filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, '')).sort();
}
