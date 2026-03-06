import {
  applyEnterpriseExecutionUpdates,
  assignEnterpriseSubordinate,
  completeEnterpriseRuntime,
  escalateEnterpriseNode,
  readEnterpriseRuntime,
  refreshEnterpriseRuntime,
  startEnterpriseRuntime,
  summarizeEnterpriseHandle,
  type EnterpriseDivisionSeed,
  type EnterpriseStartOptions,
  type EnterpriseSubordinateSeed,
} from '../enterprise/runtime.js';
import {
  readEnterpriseChairmanSummary,
  readEnterpriseDivisionSummary,
  readEnterpriseEventLog,
  readEnterpriseMailbox,
  readEnterpriseSubordinateRecord,
  classifyEnterpriseWorkerHealth,
  touchEnterpriseWorkerHeartbeat,
  listEnterpriseAssignments,
  listEnterpriseEscalations,
  listEnterpriseWorkerHeartbeats,
  listEnterpriseWorkerIdentities,
  listEnterpriseWorkerStates,
  markEnterpriseMailboxDelivered,
  readEnterpriseWorkerHeartbeat,
  readEnterpriseWorkerIdentity,
  readEnterpriseWorkerState,
  sendEnterpriseMailboxMessage,
} from '../enterprise/state.js';
import {
  nudgeEnterpriseLiveNode,
  readEnterpriseLiveRuntime,
  refreshEnterpriseLiveMonitor,
  shutdownEnterpriseLiveNode,
  shutdownEnterpriseLiveRuntime,
  spawnEnterpriseSubordinateWorker,
  startEnterpriseLiveRuntime,
  updateEnterpriseLiveMonitor,
} from '../enterprise/live-runtime.js';

const ENTERPRISE_HELP = `
Usage: omx enterprise [options] "<task description>"
       omx enterprise status
       omx enterprise live-start
       omx enterprise shutdown
       omx enterprise shutdown-node <node-id>
       omx enterprise nudge <node-id> "<message>"
       omx enterprise heartbeat <node-id>
       omx enterprise refresh-monitor
       omx enterprise assign <lead-id> "<subject>:<scope>"
       omx enterprise escalate <node-id> "<summary>" [--details "..."]
       omx enterprise message <from-node-id> <to-node-id> "<body>"
       omx enterprise mailbox <node-id>
       omx enterprise ack-message <node-id> <message-id>
       omx enterprise inspect <subordinate|division|chairman|assignments|escalations|events> [id]
       omx enterprise update <node-id> <pending|working|blocked|completed|failed> "<summary>" [--details "..."] [--blocker "..."] [--escalate]
       omx enterprise complete
       omx enterprise help

Options:
  --division "<label>:<scope>"    Add a division lead seed (repeatable)
  --subordinate "<lead-id>:<label>:<scope>" Add a subordinate seed (repeatable)
  --max-division-leads <n>         Set the Phase 1 division lead cap
  --subordinates-per-lead <n>      Set the Phase 1 subordinate cap per division lead
  --max-subordinates-total <n>     Set the total subordinate cap
  --debug-chairman                 Enable debug chairman visibility

Examples:
  omx enterprise "ship a controlled multi-scope rollout"
  omx enterprise --division "Research:investigate runtime reuse" --division "Execution:build runtime shell" "issue 590 phase 1"
  omx enterprise live-start
  omx enterprise assign division-1 "Verifier:verify runtime shell"
  omx enterprise shutdown-node subordinate-1
  omx enterprise nudge subordinate-1 "continue and summarize blockers"
  omx enterprise heartbeat subordinate-1
  omx enterprise message subordinate-1 division-1 "verification complete"
  omx enterprise mailbox chairman-1
  omx enterprise escalate subordinate-1 "needs chairman attention" --details "blocked on shared file ownership"
  omx enterprise inspect escalations
  omx enterprise update subordinate-1 completed "runtime shell implemented"
  omx enterprise shutdown
  omx enterprise status
`;

export interface ParsedEnterpriseStartArgs {
  task: string;
  divisions: EnterpriseDivisionSeed[];
  subordinates: EnterpriseSubordinateSeed[];
  options: EnterpriseStartOptions;
}

function parseIntegerFlag(flag: string, value: string | undefined): number {
  if (!value || value.startsWith('-')) throw new Error(`Missing numeric value after ${flag}`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseDivisionSeed(raw: string, index: number): EnterpriseDivisionSeed {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`--division value at index ${index} must not be empty`);
  const split = trimmed.split(':');
  if (split.length >= 2) {
    const label = split.shift()?.trim() || `Division ${index + 1}`;
    const scope = split.join(':').trim() || label;
    return { id: `division-${index + 1}`, label, scope };
  }
  return { id: `division-${index + 1}`, label: trimmed, scope: trimmed };
}

function parseSubordinateSeed(raw: string, index: number): EnterpriseSubordinateSeed {
  const trimmed = raw.trim();
  const parts = trimmed.split(':');
  if (parts.length < 3) throw new Error('--subordinate must use <lead-id>:<label>:<scope> format');
  const leadId = parts.shift()?.trim();
  const label = parts.shift()?.trim();
  const scope = parts.join(':').trim();
  if (!leadId || !label || !scope) throw new Error('--subordinate must use <lead-id>:<label>:<scope> format');
  return { id: `subordinate-${index + 1}`, leadId, label, scope };
}

function parseSubjectScope(raw: string): { subject: string; scope: string } {
  const trimmed = raw.trim();
  const parts = trimmed.split(':');
  if (parts.length < 2) throw new Error('expected <subject>:<scope>');
  const subject = parts.shift()?.trim();
  const scope = parts.join(':').trim();
  if (!subject || !scope) throw new Error('expected <subject>:<scope>');
  return { subject, scope };
}

export function parseEnterpriseStartArgs(args: string[]): ParsedEnterpriseStartArgs {
  const divisions: EnterpriseDivisionSeed[] = [];
  const subordinates: EnterpriseSubordinateSeed[] = [];
  const policy: NonNullable<EnterpriseStartOptions['policy']> = {};
  const taskParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--division') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value after --division');
      divisions.push(parseDivisionSeed(next, divisions.length));
      index += 1;
      continue;
    }
    if (token === '--subordinate') {
      const next = args[index + 1];
      if (!next) throw new Error('Missing value after --subordinate');
      subordinates.push(parseSubordinateSeed(next, subordinates.length));
      index += 1;
      continue;
    }
    if (token === '--max-division-leads') {
      policy.max_division_leads = parseIntegerFlag(token, args[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--subordinates-per-lead') {
      policy.max_subordinates_per_lead = parseIntegerFlag(token, args[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--max-subordinates-total') {
      policy.max_subordinates_total = parseIntegerFlag(token, args[index + 1]);
      index += 1;
      continue;
    }
    if (token === '--debug-chairman') {
      policy.chairman_visibility = 'debug';
      continue;
    }
    if (token === '--help' || token === '-h') {
      throw new Error(ENTERPRISE_HELP.trim());
    }
    taskParts.push(token);
  }

  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('Usage: omx enterprise [options] "<task description>"');
  return { task, divisions, subordinates, options: { divisions, subordinates, policy } };
}

function parseUpdateArgs(args: string[]): {
  nodeId: string;
  status: 'pending' | 'working' | 'blocked' | 'completed' | 'failed';
  summary: string;
  details?: string;
  blockers?: string[];
  escalated?: boolean;
} {
  const [, nodeId, statusRaw, summaryRaw, ...rest] = args;
  if (!nodeId || !statusRaw || !summaryRaw) {
    throw new Error('Usage: omx enterprise update <node-id> <pending|working|blocked|completed|failed> "<summary>" [--details "..."] [--blocker "..."] [--escalate]');
  }
  const status = statusRaw as 'pending' | 'working' | 'blocked' | 'completed' | 'failed';
  if (!['pending', 'working', 'blocked', 'completed', 'failed'].includes(status)) throw new Error(`Invalid enterprise status: ${statusRaw}`);
  const blockers: string[] = [];
  let details: string | undefined;
  let escalated = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--details') {
      details = rest[index + 1];
      index += 1;
      continue;
    }
    if (token === '--blocker') {
      const blocker = rest[index + 1];
      if (blocker) blockers.push(blocker);
      index += 1;
      continue;
    }
    if (token === '--escalate') {
      escalated = true;
      continue;
    }
  }
  return { nodeId, status, summary: summaryRaw, details, blockers, escalated };
}

function parseAssignArgs(args: string[]): { leadId: string; subject: string; scope: string } {
  const [, leadId, raw] = args;
  if (!leadId || !raw) throw new Error('Usage: omx enterprise assign <lead-id> "<subject>:<scope>"');
  const parsed = parseSubjectScope(raw);
  return { leadId, subject: parsed.subject, scope: parsed.scope };
}

function parseEscalateArgs(args: string[]): { nodeId: string; summary: string; details?: string } {
  const [, nodeId, summary, ...rest] = args;
  if (!nodeId || !summary) throw new Error('Usage: omx enterprise escalate <node-id> "<summary>" [--details "..."]');
  let details: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--details') {
      details = rest[index + 1];
      index += 1;
    }
  }
  return { nodeId, summary, details };
}

function parseMessageArgs(args: string[]): { fromNodeId: string; toNodeId: string; body: string } {
  const [, fromNodeId, toNodeId, body] = args;
  if (!fromNodeId || !toNodeId || !body) throw new Error('Usage: omx enterprise message <from-node-id> <to-node-id> "<body>"');
  return { fromNodeId, toNodeId, body };
}

function parseAckMessageArgs(args: string[]): { nodeId: string; messageId: string } {
  const [, nodeId, messageId] = args;
  if (!nodeId || !messageId) throw new Error('Usage: omx enterprise ack-message <node-id> <message-id>');
  return { nodeId, messageId };
}

async function renderInspect(kind: string, id: string | undefined): Promise<void> {
  const cwd = process.cwd();
  switch (kind) {
    case 'subordinate': {
      if (!id) throw new Error('Usage: omx enterprise inspect subordinate <node-id>');
      const record = await readEnterpriseSubordinateRecord(cwd, id);
      if (!record) throw new Error(`Enterprise subordinate not found: ${id}`);
      const live = await readEnterpriseLiveRuntime(cwd);
      const liveWorker = live?.workers.find((worker) => worker.nodeId === id) ?? null;
      const workerIdentity = await readEnterpriseWorkerIdentity(cwd, id);
      const workerState = await readEnterpriseWorkerState(cwd, id);
      const workerHeartbeat = await readEnterpriseWorkerHeartbeat(cwd, id);
      const workerHealth = classifyEnterpriseWorkerHealth(workerHeartbeat);
      console.log(JSON.stringify({ ...record, liveWorker, workerIdentity, workerState, workerHeartbeat, workerHealth, mailbox: await readEnterpriseMailbox(cwd, id) }, null, 2));
      return;
    }
    case 'division': {
      if (!id) throw new Error('Usage: omx enterprise inspect division <lead-id>');
      const summary = await readEnterpriseDivisionSummary(cwd, id);
      if (!summary) throw new Error(`Enterprise division summary not found: ${id}`);
      const live = await readEnterpriseLiveRuntime(cwd);
      const leadWorker = live?.workers.find((worker) => worker.nodeId === id) ?? null;
      const subordinateWorkers = live?.workers.filter((worker) => worker.ownerLeadId === id) ?? [];
      const workerIdentity = await readEnterpriseWorkerIdentity(cwd, id);
      const workerState = await readEnterpriseWorkerState(cwd, id);
      const workerHeartbeat = await readEnterpriseWorkerHeartbeat(cwd, id);
      const workerHealth = classifyEnterpriseWorkerHealth(workerHeartbeat);
      const assignments = (await listEnterpriseAssignments(cwd)).filter((entry) => entry.leadId === id);
      const escalations = (await listEnterpriseEscalations(cwd)).filter((entry) => entry.leadId === id);
      const subordinateHealth = { healthy: 0, stale: 0, offline: 0 };
      for (const worker of subordinateWorkers) {
        const hb = await readEnterpriseWorkerHeartbeat(cwd, worker.nodeId);
        const health = classifyEnterpriseWorkerHealth(hb);
        subordinateHealth[health] += 1;
      }
      console.log(JSON.stringify({ ...summary, liveLeadWorker: leadWorker, workerIdentity, workerState, workerHeartbeat, workerHealth, liveSubordinateWorkers: subordinateWorkers, subordinateHealth, assignments, escalations }, null, 2));
      return;
    }
    case 'chairman': {
      const summary = await readEnterpriseChairmanSummary(cwd);
      if (!summary) throw new Error('Enterprise chairman summary not found.');
      const assignments = await listEnterpriseAssignments(cwd);
      const escalations = await listEnterpriseEscalations(cwd);
      const identities = await listEnterpriseWorkerIdentities(cwd);
      const heartbeats = await listEnterpriseWorkerHeartbeats(cwd);
      const health = { healthy: 0, stale: 0, offline: 0 };
      for (const heartbeat of heartbeats) {
        health[classifyEnterpriseWorkerHealth(heartbeat)] += 1;
      }
      console.log(JSON.stringify({ ...summary, assignmentCount: assignments.length, escalationCount: escalations.length, workerCount: identities.length, workerHealth: health }, null, 2));
      return;
    }
    case 'assignments': {
      console.log(JSON.stringify(await listEnterpriseAssignments(cwd), null, 2));
      return;
    }
    case 'escalations': {
      console.log(JSON.stringify(await listEnterpriseEscalations(cwd), null, 2));
      return;
    }
    case 'events': {
      console.log(JSON.stringify(await readEnterpriseEventLog(cwd), null, 2));
      return;
    }
    case 'workers': {
      const identities = await listEnterpriseWorkerIdentities(cwd);
      const states = await listEnterpriseWorkerStates(cwd);
      const heartbeats = await listEnterpriseWorkerHeartbeats(cwd);
      const byNodeId = new Map(states.map((state) => [state.nodeId, state] as const));
      const hbByNodeId = new Map(heartbeats.map((heartbeat) => [heartbeat.nodeId, heartbeat] as const));
      console.log(JSON.stringify(identities.map((identity) => {
        const workerHeartbeat = hbByNodeId.get(identity.nodeId) ?? null;
        return {
          ...identity,
          workerState: byNodeId.get(identity.nodeId) ?? null,
          workerHeartbeat,
          workerHealth: classifyEnterpriseWorkerHealth(workerHeartbeat),
        };
      }), null, 2));
      return;
    }
    default:
      throw new Error('Usage: omx enterprise inspect <subordinate|division|chairman|assignments|escalations|events|workers> [id]');
  }
}

export async function enterpriseCommand(args: string[]): Promise<void> {
  const subcommand = (args[0] || '').toLowerCase();
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.log(ENTERPRISE_HELP.trim());
    return;
  }

  if (subcommand === 'status') {
    const refreshed = await refreshEnterpriseRuntime().catch(() => null);
    if (!refreshed) {
      console.log('No active enterprise mode.');
      return;
    }
    await refreshEnterpriseLiveMonitor();
    for (const line of summarizeEnterpriseHandle(refreshed)) console.log(line);
    const heartbeats = await listEnterpriseWorkerHeartbeats(process.cwd());
    const counts = { healthy: 0, stale: 0, offline: 0 };
    for (const heartbeat of heartbeats) {
      const health = classifyEnterpriseWorkerHealth(heartbeat);
      counts[health] += 1;
    }
    if (heartbeats.length > 0) {
      console.log(`Worker health: healthy=${counts.healthy} stale=${counts.stale} offline=${counts.offline}`);
    }
    return;
  }

  if (subcommand === 'inspect') {
    await renderInspect((args[1] || '').toLowerCase(), args[2]);
    return;
  }



  if (subcommand === 'heartbeat') {
    const nodeId = args[1];
    if (!nodeId) throw new Error('Usage: omx enterprise heartbeat <node-id>');
    const workerIdentity = await readEnterpriseWorkerIdentity(process.cwd(), nodeId);
    const record = await touchEnterpriseWorkerHeartbeat(
      process.cwd(),
      nodeId,
      workerIdentity?.ownerLeadId ?? null,
      workerIdentity?.paneId ?? null,
    );
    console.log(`Enterprise heartbeat updated: ${record.nodeId}`);
    return;
  }

  if (subcommand === 'nudge') {
    const nodeId = args[1];
    const message = args[2];
    if (!nodeId || !message) throw new Error('Usage: omx enterprise nudge <node-id> "<message>"');
    await nudgeEnterpriseLiveNode(nodeId, message);
    console.log(`Enterprise node nudged: ${nodeId}`);
    return;
  }

  if (subcommand === 'mailbox') {
    const nodeId = args[1];
    if (!nodeId) throw new Error('Usage: omx enterprise mailbox <node-id>');
    console.log(JSON.stringify(await readEnterpriseMailbox(process.cwd(), nodeId), null, 2));
    return;
  }

  if (subcommand === 'ack-message') {
    const parsed = parseAckMessageArgs(args);
    const ok = await markEnterpriseMailboxDelivered(process.cwd(), parsed.nodeId, parsed.messageId);
    if (!ok) throw new Error(`Enterprise mailbox message not found: ${parsed.messageId}`);
    console.log(`Enterprise message acknowledged: ${parsed.messageId}`);
    return;
  }

  if (subcommand === 'message') {
    const parsed = parseMessageArgs(args);
    const message = await sendEnterpriseMailboxMessage(process.cwd(), parsed.fromNodeId, parsed.toNodeId, parsed.body);
    console.log(`Enterprise message sent: ${message.messageId}`);
    return;
  }

  if (subcommand === 'refresh-monitor') {
    const handle = await refreshEnterpriseRuntime();
    await refreshEnterpriseLiveMonitor();
    console.log('Enterprise monitor refreshed.');
    for (const line of summarizeEnterpriseHandle(handle)) console.log(line);
    return;
  }

  if (subcommand === 'live-start') {
    const handle = await startEnterpriseLiveRuntime();
    console.log('Enterprise live runtime started.');
    for (const line of summarizeEnterpriseHandle(handle.enterprise)) console.log(line);
    return;
  }

  if (subcommand === 'shutdown') {
    await shutdownEnterpriseLiveRuntime();
    console.log('Enterprise live runtime shutdown complete.');
    return;
  }

  if (subcommand === 'shutdown-node') {
    const nodeId = args[1];
    if (!nodeId) throw new Error('Usage: omx enterprise shutdown-node <node-id>');
    const live = await shutdownEnterpriseLiveNode(nodeId);
    console.log(`Enterprise live worker shutdown complete: ${nodeId}`);
    console.log(JSON.stringify(live, null, 2));
    return;
  }

  if (subcommand === 'assign') {
    const parsed = parseAssignArgs(args);
    const result = await assignEnterpriseSubordinate(parsed.leadId, parsed.subject, parsed.scope);
    if (await readEnterpriseLiveRuntime()) {
      await spawnEnterpriseSubordinateWorker(result.subordinateId);
    }
    const refreshed = await refreshEnterpriseRuntime();
    await refreshEnterpriseLiveMonitor();
    console.log(`Enterprise assignment created: ${result.assignment.assignmentId} -> ${result.subordinateId}`);
    for (const line of summarizeEnterpriseHandle(refreshed)) console.log(line);
    return;
  }

  if (subcommand === 'escalate') {
    const parsed = parseEscalateArgs(args);
    const result = await escalateEnterpriseNode(parsed.nodeId, parsed.summary, parsed.details);
    await refreshEnterpriseLiveMonitor();
    console.log(`Enterprise escalation created: ${result.escalation.escalationId}`);
    for (const line of summarizeEnterpriseHandle(result.handle)) console.log(line);
    return;
  }

  if (subcommand === 'update') {
    const parsed = parseUpdateArgs(args);
    const live = await readEnterpriseLiveRuntime();
    const handle = live
      ? await updateEnterpriseLiveMonitor([parsed])
      : await applyEnterpriseExecutionUpdates([parsed]);
    console.log('Enterprise update applied.');
    for (const line of summarizeEnterpriseHandle(handle)) console.log(line);
    return;
  }

  if (subcommand === 'complete') {
    await completeEnterpriseRuntime();
    console.log('Enterprise mode marked complete.');
    return;
  }

  const parsed = parseEnterpriseStartArgs(args);
  const handle = await startEnterpriseRuntime(parsed.task, parsed.options);
  console.log('Started enterprise mode.');
  for (const line of summarizeEnterpriseHandle(handle)) console.log(line);
}
