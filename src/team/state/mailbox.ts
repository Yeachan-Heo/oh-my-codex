import { randomUUID } from 'crypto';
import { getDefaultBridge, isBridgeEnabled, resolveBridgeStateDir, type MailboxRecord, type RuntimeCommand } from '../../runtime/bridge.js';

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

interface MailboxDeps {
  teamName: string;
  cwd: string;
  withMailboxLock: <T>(teamName: string, workerName: string, cwd: string, fn: () => Promise<T>) => Promise<T>;
  readMailbox: (teamName: string, workerName: string, cwd: string) => Promise<TeamMailbox>;
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
  readTeamConfig: (teamName: string, cwd: string) => Promise<{ workers: Array<{ name: string }> } | null>;
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

  await deps.withMailboxLock(deps.teamName, toWorker, deps.cwd, async () => {
    const mailbox = await deps.readMailbox(deps.teamName, toWorker, deps.cwd);
    const existing = mailbox.messages.find((candidate) =>
      candidate.from_worker === fromWorker
      && candidate.to_worker === toWorker
      && candidate.body === body
      && !candidate.delivered_at,
    );
    if (existing) {
      msg = existing;
      return;
    }

    const msgId = randomUUID();
    if (executeBridgeCommand(deps.cwd, {
      command: 'CreateMailboxMessage',
      message_id: msgId,
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
    })) {
      const bridgeMailbox = await deps.readMailbox(deps.teamName, toWorker, deps.cwd);
      const bridgeMessage = bridgeMailbox.messages.find((candidate) => candidate.message_id === msgId);
      if (bridgeMessage) {
        msg = bridgeMessage;
        created = true;
        return;
      }
    }

    msg = {
      message_id: msgId,
      from_worker: fromWorker,
      to_worker: toWorker,
      body,
      created_at: new Date().toISOString(),
    };
    mailbox.messages.push(msg);
    await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
    created = true;
  });

  if (!msg) {
    throw new Error('failed_to_persist_mailbox_message');
  }
  const persistedMessage = msg as TeamMailboxMessage;

  if (created) {
    await deps.appendTeamEvent(
      deps.teamName,
      { type: 'message_received', worker: toWorker, task_id: undefined, message_id: persistedMessage.message_id, reason: undefined },
      deps.cwd,
    );
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
  if (executeBridgeCommand(deps.cwd, { command: 'MarkMailboxDelivered', message_id: messageId })) {
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    if (mailbox.messages.some((message) => message.message_id === messageId)) return true;
  }
  return await deps.withMailboxLock(deps.teamName, workerName, deps.cwd, async () => {
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    if (!msg.delivered_at) {
      msg.delivered_at = new Date().toISOString();
      await deps.writeMailbox(deps.teamName, mailbox, deps.cwd);
    }
    return true;
  });
}

export async function markMessageNotified(
  workerName: string,
  messageId: string,
  deps: MailboxDeps,
): Promise<boolean> {
  if (executeBridgeCommand(deps.cwd, { command: 'MarkMailboxNotified', message_id: messageId })) {
    const mailbox = await deps.readMailbox(deps.teamName, workerName, deps.cwd);
    if (mailbox.messages.some((message) => message.message_id === messageId)) return true;
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
