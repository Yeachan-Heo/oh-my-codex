import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getDefaultBridge, isBridgeEnabled, isRuntimeTransportError, preflightRuntimeBridge, resolveBridgeStateDir, RuntimeBridgeError, type MailboxRecord, type RuntimeCommand } from '../../runtime/bridge.js';
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
  const shadowsById = new Map<string, TeamMailboxMessage>();
  const duplicateIds = new Set<string>();
  if (mailbox.worker === workerName) {
    for (const message of mailbox.messages) {
      if (typeof message?.message_id !== 'string') continue;
      if (shadowIds.has(message.message_id)) duplicateIds.add(message.message_id);
      shadowIds.add(message.message_id);
      shadowsById.set(message.message_id, message);
    }
    for (const message of mailbox.messages) {
      if (message?.to_worker !== workerName) shadowIds.delete(message?.message_id);
    }
  }
  const relevantBridgeRecords = bridgeRecords.filter((record) => record.team_name == null || record.team_name === teamName);
  const bridgeIds = new Set<string>();
  for (const record of relevantBridgeRecords) {
    if (bridgeIds.has(record.message_id)) duplicateIds.add(record.message_id);
    bridgeIds.add(record.message_id);
    const shadow = shadowsById.get(record.message_id);
    if (shadow && !mailboxMessageContentMatches(shadow, normalizeBridgeMailboxMessage(record, shadow))) {
      duplicateIds.add(record.message_id);
    }
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

export function needsLegacyMailboxEvidence(
  teamName: string,
  workerName: string,
  mailbox: TeamMailbox,
  bridgeRecords: readonly MailboxRecord[],
): boolean {
  if (!Array.isArray(bridgeRecords) || bridgeRecords.some((record) => !record || typeof record.message_id !== 'string')) {
    return true;
  }
  const recordsById = new Map<string, MailboxRecord[]>();
  for (const record of bridgeRecords) {
    if (record.team_name !== teamName || record.to_worker !== workerName) continue;
    const matches = recordsById.get(record.message_id) ?? [];
    matches.push(record);
    recordsById.set(record.message_id, matches);
  }
  const seenIds = new Set<string>();
  for (const message of mailbox.messages) {
    if (typeof message?.message_id !== 'string' || message.message_id === '' || seenIds.has(message.message_id)) return true;
    seenIds.add(message.message_id);
    const records = recordsById.get(message.message_id);
    if (records?.length !== 1) return true;
    const [record] = records;
    if (!mailboxMessageContentMatches(message, record) || (!record.body && message.body)) return true;
  }
  return false;
}

interface MailboxDeps {
  teamName: string;
  cwd: string;
  withMailboxLock: <T>(teamName: string, workerName: string, cwd: string, fn: () => Promise<T>) => Promise<T>;
  readMailbox: (teamName: string, workerName: string, cwd: string) => Promise<TeamMailbox>;
  readLegacyMailbox?: (teamName: string, workerName: string, cwd: string) => Promise<TeamMailbox>;
  writeMailbox: (teamName: string, mailbox: TeamMailbox, cwd: string, replacedMessage?: TeamMailboxMessage) => Promise<void>;
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
  const stateDir = resolveBridgeStateDir(cwd);
  if (command.command === 'MarkMailboxNotified' || command.command === 'MarkMailboxDelivered') {
    const bridge = getDefaultBridge(stateDir);
    let compat = bridge.readCompatFile<{ records?: MailboxRecord[] }>('mailbox.json');
    const mailboxCompatPath = join(stateDir, 'mailbox.json');
    const hasRuntimeAuthority = ['events.json', 'snapshot.json', 'mailbox.json']
      .some((name) => existsSync(join(stateDir, name)));
    const isAbsentFromCompat = (): boolean => Array.isArray(compat?.records)
      && compat.records.every((record) => record && typeof record.message_id === 'string')
      && !compat.records.some((record) => record.message_id === command.message_id
        && (record.team_name == null || record.team_name === command.team_name));
    if (hasRuntimeAuthority && (!existsSync(mailboxCompatPath) || isAbsentFromCompat())) {
      // Refresh a missing or stale projection before deciding that a proven
      // shadow message has no authoritative runtime record.
      bridge.execCommand({ command: 'CaptureSnapshot' });
      compat = bridge.readCompatFile<{ records?: MailboxRecord[] }>('mailbox.json');
    }
    if (isAbsentFromCompat() || !hasRuntimeAuthority) {
      // Callers proved shadow+journal ownership and no compatible runtime row was found.
      preflightRuntimeBridge(stateDir);
      return false;
    }
  }
  try {
    const event = getDefaultBridge(stateDir).execCommand(command);
    if (command.command === 'CreateMailboxMessage' && (!event || event.event !== 'MailboxMessageCreated'
      || event.message_id !== command.message_id || event.from_worker !== command.from_worker
      || event.to_worker !== command.to_worker
      || (event.team_name != null && event.team_name !== command.team_name)
      || (event.body != null && event.body !== command.body))) {
      throw new RuntimeBridgeError('omx-runtime returned invalid mailbox creation acknowledgement', { command: command.command });
    }
    return true;
  } catch (error) {
    if (error instanceof RuntimeBridgeError && error.context.command === 'schema') throw error;
    if (command.command === 'CreateMailboxMessage' && isRuntimeTransportError(error)) return false;
    throw error;
  }
}

export function mailboxMessageIdentity(message: TeamMailboxMessage | MailboxRecord): string {
  return JSON.stringify([message?.message_id, message?.from_worker, message?.to_worker, message?.body, message?.created_at]);
}

export function mailboxMessageContentMatches(left: TeamMailboxMessage | MailboxRecord, right: TeamMailboxMessage | MailboxRecord): boolean {
  return left?.message_id === right?.message_id && left?.from_worker === right?.from_worker
    && left?.to_worker === right?.to_worker && left?.body === right?.body;
}

export function hasUniqueScopedMailboxMatch(
  teamName: string,
  message: TeamMailboxMessage,
  records: MailboxRecord[],
  shadows: TeamMailboxMessage[],
): boolean {
  const scoped = records.filter((record) => record.team_name === teamName && record.message_id === message.message_id);
  return scoped.length === 1 && mailboxMessageContentMatches(scoped[0], message)
    && shadows.filter((shadow) => mailboxMessageContentMatches(shadow, message)).length === 1;
}

export function normalizeBridgeMailboxMessage(record: MailboxRecord, recovery?: TeamMailboxMessage): TeamMailboxMessage {
  const recoveredBody = recovery?.message_id === record.message_id
    && recovery.from_worker === record.from_worker && recovery.to_worker === record.to_worker ? recovery.body : '';
  return {
    message_id: record.message_id,
    from_worker: record.from_worker,
    to_worker: record.to_worker,
    body: record.body || recoveredBody,
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
        : await readLegacyMailboxMessageIds(deps.teamName, toWorker, legacyMailbox,
          join(resolveBridgeStateDir(deps.cwd), 'team', deps.teamName, 'events', 'events.ndjson'),
          isBridgeEnabled() ? getDefaultBridge(resolveBridgeStateDir(deps.cwd)).readMailboxRecords() : []);
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

    const findExisting = (messages: TeamMailboxMessage[]) => messages.find((candidate) =>
      candidate.from_worker === fromWorker
      && candidate.to_worker === toWorker
      && candidate.body === body
      && !candidate.delivered_at
      && isCurrentTeamMessage(candidate),
    );
    let existing = findExisting(dedupeCandidates);
    const stateDir = resolveBridgeStateDir(deps.cwd);
    const eventsPath = join(stateDir, 'events.json');
    if (!existing && isBridgeEnabled() && existsSync(eventsPath)) {
      const events = JSON.parse(await readFile(eventsPath, 'utf8'));
      if (!Array.isArray(events)) throw new RuntimeBridgeError('invalid runtime mailbox event log');
      const creations = events.filter(event => event?.event === 'MailboxMessageCreated'
        && event.team_name === deps.teamName && event.from_worker === fromWorker && event.to_worker === toWorker
        && (event.body == null || event.body === body));
      if (creations.length > 0) {
        const bridge = getDefaultBridge(stateDir);
        const containsCreations = (records: MailboxRecord[] | undefined): boolean => Array.isArray(records)
          && creations.every(event => records.some(record => record?.team_name === deps.teamName
            && record.message_id === event.message_id && record.from_worker === fromWorker && record.to_worker === toWorker
            && (event.body == null || record.body === event.body)));
        let records = bridge.readCompatFile<{ records?: MailboxRecord[] }>('mailbox.json')?.records;
        if (!containsCreations(records)) {
          // Events commit before mailbox.json; replay before assigning a new message ID.
          const snapshot = bridge.execCommand({ command: 'CaptureSnapshot' });
          records = bridge.readCompatFile<{ records?: MailboxRecord[] }>('mailbox.json')?.records;
          if (snapshot?.event !== 'SnapshotCaptured'
            || !containsCreations(records)) {
            throw new RuntimeBridgeError('mailbox creation recovery could not verify authoritative messages');
          }
        }
        existing = findExisting((records ?? []).filter(record => record.team_name === deps.teamName)
          .map(record => normalizeBridgeMailboxMessage(record)));
      }
    }
    if (existing) {
      msg = existing;
      return;
    }

    preflightRuntimeBridge(resolveBridgeStateDir(deps.cwd));
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
    let bridgeCreated: boolean;
    try {
      bridgeCreated = executeBridgeCommand(deps.cwd, {
        command: 'CreateMailboxMessage',
        team_name: deps.teamName,
        message_id: msgId,
        from_worker: fromWorker,
        to_worker: toWorker,
        body,
      });
    } catch (error) {
      await deps.writeMailbox(deps.teamName, legacyMailbox, deps.cwd, provisionalMessage);
      throw error;
    }
    if (bridgeCreated) {
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
        const shadowIndex = updatedShadowMailbox.messages.findIndex((candidate) => mailboxMessageIdentity(candidate) === mailboxMessageIdentity(provisionalMessage));
        if (shadowIndex >= 0) updatedShadowMailbox.messages[shadowIndex] = msg;
        await deps.writeMailbox(deps.teamName, updatedShadowMailbox, deps.cwd, provisionalMessage);
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
  if (!(await deps.readMailbox(deps.teamName, workerName, deps.cwd)).messages.some((message) => message.message_id === messageId)) return false;
  let transport: 'bridge' | 'legacy-json' | undefined;
  const updated = await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
    const existingMailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const existingMessage = existingMailbox.messages.find((message) => message.message_id === messageId);
    if (!existingMessage) return false;
    if (existingMessage.delivered_at && existingMailbox.messages.filter((message) => message.message_id === messageId).length === 1) return true;

    transport = executeBridgeCommand(deps.cwd, { command: 'MarkMailboxDelivered', team_name: deps.teamName, message_id: messageId })
      ? 'bridge' : 'legacy-json';
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const msg = mailbox.messages.find((message) => message.message_id === messageId);
    if (!msg) return false;
    if (!msg.delivered_at || transport === 'bridge') {
      if (!msg.delivered_at) msg.delivered_at = new Date().toISOString();
      await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
    }
    return true;
  });
  if (updated && transport) {
    await appendTeamDeliveryLogForCwd(deps.cwd, {
      event: 'delivered',
      source: 'team.state.mailbox',
      team: deps.teamName,
      message_id: messageId,
      to_worker: workerName,
      transport,
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

  return await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
    const existingMailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const existingMessage = existingMailbox.messages.find((message) => message.message_id === messageId);
    if (!existingMessage) return false;
    if (existingMessage.delivered_at && existingMailbox.messages.filter((message) => message.message_id === messageId).length === 1) return true;

    executeBridgeCommand(deps.cwd, { command: 'MarkMailboxNotified', team_name: deps.teamName, message_id: messageId });
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const msg = mailbox.messages.find((message) => message.message_id === messageId);
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
