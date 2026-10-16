import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getDefaultBridge, isBridgeEnabled, resolveBridgeStateDir, type MailboxRecord, type RuntimeCommand } from '../../runtime/bridge.js';
import { appendTeamDeliveryLogForCwd } from '../delivery-log.js';

export interface TeamMailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

export interface TeamMailbox {
  worker: string;
  messages: TeamMailboxMessage[];
}

/** Old shadows may contain foreign IDs written by the pre-isolation bridge reader. */
export async function readLegacyMailboxMessageIds(
  teamName: string,
  workerName: string,
  mailbox: TeamMailbox,
  eventPath: string,
  bridgeRecords: readonly MailboxRecord[] = [],
): Promise<Set<string>> {
  if (!Array.isArray(bridgeRecords) || bridgeRecords.some((record) => !record || typeof record.message_id !== 'string')) {
    return new Set<string>();
  }
  const shadowIds = new Set<string>();
  const duplicateIds = new Set<string>();
  if (mailbox.worker === workerName) {
    for (const message of mailbox.messages) {
      if (typeof message?.message_id !== 'string') continue;
      if (shadowIds.has(message.message_id)) duplicateIds.add(message.message_id);
      shadowIds.add(message.message_id);
    }
    for (const message of mailbox.messages) {
      if (message?.to_worker !== workerName) shadowIds.delete(message?.message_id);
    }
  }
  const bridgeIds = new Set<string>();
  for (const record of bridgeRecords) {
    if (bridgeIds.has(record.message_id)) duplicateIds.add(record.message_id);
    bridgeIds.add(record.message_id);
  }
  for (const id of duplicateIds) shadowIds.delete(id);
  const ids = new Set<string>();
  if (shadowIds.size === 0) return ids;
  const events = await readFile(eventPath, 'utf8').catch(() => '');
  for (const line of events.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.team === teamName && event.type === 'message_received' && event.worker === workerName
        && shadowIds.has(event.message_id)) ids.add(event.message_id);
    } catch { /* A partial journal line cannot prove ownership. */ }
  }
  return ids;
}

export function mailboxRecordBelongsToTeam(
  record: MailboxRecord,
  teamName: string,
  workerName: string,
  legacyMessageIds: ReadonlySet<string>,
): boolean {
  return record.to_worker === workerName && (record.team_name == null
    ? legacyMessageIds.has(record.message_id)
    : record.team_name === teamName);
}

interface MailboxDeps {
  teamName: string;
  cwd: string;
  withMailboxLock: <T>(teamName: string, workerName: string, cwd: string, fn: () => Promise<T>) => Promise<T>;
  readMailbox: (teamName: string, workerName: string, cwd: string) => Promise<TeamMailbox>;
  readLegacyMailbox?: (teamName: string, workerName: string, cwd: string) => Promise<TeamMailbox>;
  writeMailbox: (teamName: string, mailbox: TeamMailbox, cwd: string) => Promise<void>;
  appendTeamEvent: (
    teamName: string,
    event: {
      type: 'message_received';
      worker: string;
      task_id?: string;
      message_id?: string | null;
      reason?: string;
    },
    cwd: string,
  ) => Promise<unknown>;
  readTeamConfig: (teamName: string, cwd: string) => Promise<{ created_at?: string; workers: Array<{ name: string }> } | null>;
}

function executeBridgeCommand(cwd: string, command: RuntimeCommand): boolean {
  if (!isBridgeEnabled()) return false;
  try {
    getDefaultBridge(resolveBridgeStateDir(cwd)).execCommand(command);
    return true;
  } catch {
    return false;
  }
}

export function normalizeBridgeMailboxMessage(record: MailboxRecord): TeamMailboxMessage {
  return {
    message_id: record.message_id,
    from_worker: record.from_worker,
    to_worker: record.to_worker,
    body: record.body,
    created_at: record.created_at,
    notified_at: record.notified_at ?? undefined,
    delivered_at: record.delivered_at ?? undefined,
  };
}

export async function sendDirectMessage(
  fromWorker: string,
  toWorker: string,
  body: string,
  deps: MailboxDeps,
): Promise<TeamMailboxMessage> {
  let created = false;
  let msg: TeamMailboxMessage | null = null;
  let creationTransport: 'bridge' | 'legacy-json' = 'legacy-json';

  await deps.withMailboxLock(deps.teamName, toWorker, deps.cwd, async () => {
    const mailbox = await deps.readMailbox(deps.teamName, toWorker, deps.cwd);
    const legacyMailbox = deps.readLegacyMailbox
      ? await deps.readLegacyMailbox(deps.teamName, toWorker, deps.cwd)
      : mailbox;
    const dedupeCandidates = [...mailbox.messages];
    if (deps.readLegacyMailbox) {
      const seenMessageIds = new Set(dedupeCandidates.map((candidate) => candidate.message_id));
      const missingLegacyMessages = legacyMailbox.messages.filter((message) => !seenMessageIds.has(message.message_id));
      const legacyIds = missingLegacyMessages.length === 0
        ? new Set<string>()
        : isBridgeEnabled()
          ? await readLegacyMailboxMessageIds(deps.teamName, toWorker, legacyMailbox,
            join(resolveBridgeStateDir(deps.cwd), 'team', deps.teamName, 'events', 'events.ndjson'),
            getDefaultBridge(resolveBridgeStateDir(deps.cwd)).readMailboxRecords())
          : new Set(missingLegacyMessages.map((candidate) => candidate.message_id));
      for (const legacyMessage of missingLegacyMessages) {
        if (legacyIds.has(legacyMessage.message_id) && !seenMessageIds.has(legacyMessage.message_id)) {
          dedupeCandidates.push(legacyMessage);
          seenMessageIds.add(legacyMessage.message_id);
        }
      }
    }
    const config = await deps.readTeamConfig(deps.teamName, deps.cwd).catch(() => null);
    const teamCreatedAt = typeof config?.created_at === 'string' ? Date.parse(config.created_at) : Number.NaN;
    const isCurrentTeamMessage = (candidate: TeamMailboxMessage): boolean => {
      if (!Number.isFinite(teamCreatedAt)) return true;
      const candidateCreatedAt = Date.parse(candidate.created_at);
      return Number.isFinite(candidateCreatedAt) && candidateCreatedAt >= teamCreatedAt;
    };

    const existing = dedupeCandidates.find((candidate) =>
      candidate.from_worker === fromWorker
      && candidate.to_worker === toWorker
      && candidate.body === body
      && !candidate.delivered_at
      && isCurrentTeamMessage(candidate),
    );
    if (existing) {
      msg = existing;
      return;
    }

    const msgId = randomUUID();
    const provisionalMessage: TeamMailboxMessage = {
      message_id: msgId,
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
      created_at: new Date().toISOString(),
    };
    const shadowMailbox = {
      worker: legacyMailbox.worker,
      messages: [...legacyMailbox.messages, provisionalMessage],
    };
    // Publish Team ownership evidence before creating the authoritative
    // record. A crash after authoritative creation must leave enough durable
    // evidence for shutdown to reconcile the record safely.
    await deps.writeMailbox(deps.teamName, shadowMailbox, deps.cwd);
    msg = provisionalMessage;
    created = true;
    if (executeBridgeCommand(deps.cwd, {
      command: 'CreateMailboxMessage',
      team_name: deps.teamName,
      message_id: msgId,
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
    })) {
      const bridgeMailbox = await deps.readMailbox(deps.teamName, toWorker, deps.cwd);
      const bridgeMessage = bridgeMailbox.messages.find((candidate) => candidate.message_id === msgId);
      if (bridgeMessage) {
        creationTransport = 'bridge';
        msg = {
          ...bridgeMessage,
          body: bridgeMessage.body || body,
        };
        const updatedShadowMailbox = {
          worker: legacyMailbox.worker,
          messages: [...shadowMailbox.messages],
        };
        const shadowIndex = updatedShadowMailbox.messages.findIndex((candidate) => candidate.message_id === msgId);
        if (shadowIndex >= 0) updatedShadowMailbox.messages[shadowIndex] = msg;
        await deps.writeMailbox(deps.teamName, updatedShadowMailbox, deps.cwd);
      }
    }
    if (created) {
      await deps.appendTeamEvent(
        deps.teamName,
        { type: 'message_received', worker: toWorker, task_id: undefined, message_id: msgId, reason: undefined },
        deps.cwd,
      );
    }
  });

  if (!msg) {
    throw new Error('failed_to_persist_mailbox_message');
  }
  const persistedMessage = msg as TeamMailboxMessage;

  if (created) {
    await appendTeamDeliveryLogForCwd(deps.cwd, {
      event: 'mailbox_created',
      source: 'team.state.mailbox',
      team: deps.teamName,
      message_id: persistedMessage.message_id,
      from_worker: fromWorker,
      to_worker: toWorker,
      transport: creationTransport,
      result: 'created',
    });
  }
  return persistedMessage;
}

export async function broadcastMessage(
  fromWorker: string,
  body: string,
  deps: MailboxDeps,
): Promise<TeamMailboxMessage[]> {
  const cfg = await deps.readTeamConfig(deps.teamName, deps.cwd);
  if (!cfg) throw new Error(`Team ${deps.teamName} not found`);

  const delivered: TeamMailboxMessage[] = [];
  for (const target of cfg.workers.map((w) => w.name)) {
    if (target === fromWorker) continue;
    delivered.push(await sendDirectMessage(fromWorker, target, body, deps));
  }
  return delivered;
}

export async function markMessageDelivered(
  workerName: string,
  messageId: string,
  deps: MailboxDeps,
): Promise<boolean> {
  const existingMailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
  const existingMessage = existingMailbox.messages.find((message) => message.message_id === messageId);
  if (!existingMessage) return false;
  if (existingMessage.delivered_at) return true;

  if (executeBridgeCommand(deps.cwd, { command: 'MarkMailboxDelivered', team_name: deps.teamName, message_id: messageId })) {
    const updated = await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
      const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
      const msg = mailbox.messages.find((message) => message.message_id === messageId);
      if (!msg) return false;
      if (!msg.delivered_at) {
        msg.delivered_at = new Date().toISOString();
        await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
      } else {
        await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
      }
      return true;
    });
    if (updated) {
      await appendTeamDeliveryLogForCwd(deps.cwd, {
        event: 'delivered',
        source: 'team.state.mailbox',
        team: deps.teamName,
        message_id: messageId,
        to_worker: workerName,
        transport: 'bridge',
        result: 'updated',
      });
    }
    return updated;
  }
  const updated = await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    if (!msg.delivered_at) {
      msg.delivered_at = new Date().toISOString();
      await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
    }
    return true;
  });
  if (updated) {
    await appendTeamDeliveryLogForCwd(deps.cwd, {
      event: 'delivered',
      source: 'team.state.mailbox',
      team: deps.teamName,
      message_id: messageId,
      to_worker: workerName,
      transport: 'legacy-json',
      result: 'updated',
    });
  }
  return updated;
}

export async function markMessageNotified(
  workerName: string,
  messageId: string,
  deps: MailboxDeps,
): Promise<boolean> {
  const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
  if (!mailbox.messages.some((message) => message.message_id === messageId)) return false;

  if (executeBridgeCommand(deps.cwd, { command: 'MarkMailboxNotified', team_name: deps.teamName, message_id: messageId })) {
    return await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
      const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
      const msg = mailbox.messages.find((message) => message.message_id === messageId);
      if (!msg) return false;
      msg.notified_at = new Date().toISOString();
      await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
      return true;
    });
  }
  return await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.notified_at = new Date().toISOString();
    await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
    return true;
  });
}

export async function listMailboxMessages(
  workerName: string,
  deps: MailboxDeps,
): Promise<TeamMailboxMessage[]> {
  const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
  return mailbox.messages;
}
