import {
  teamWriteWorkerInbox as writeWorkerInbox,
  teamSendMessage as sendDirectMessage,
  teamBroadcast as broadcastMessage,
  teamMarkMessageNotified as markMessageNotified,
} from './team-ops.js';

export interface TeamNotifierTarget {
  workerName: string;
  workerIndex?: number;
  paneId?: string;
}

export type TeamNotifier = (target: TeamNotifierTarget, message: string) => boolean | Promise<boolean>;

interface QueueInboxParams {
  teamName: string;
  workerName: string;
  workerIndex: number;
  paneId?: string;
  inbox: string;
  triggerMessage: string;
  cwd: string;
  notify: TeamNotifier;
}

export async function queueInboxInstruction(params: QueueInboxParams): Promise<boolean> {
  await writeWorkerInbox(params.teamName, params.workerName, params.inbox, params.cwd);
  return await params.notify(
    { workerName: params.workerName, workerIndex: params.workerIndex, paneId: params.paneId },
    params.triggerMessage,
  );
}

interface QueueDirectMessageParams {
  teamName: string;
  fromWorker: string;
  toWorker: string;
  toWorkerIndex?: number;
  toPaneId?: string;
  body: string;
  triggerMessage: string;
  cwd: string;
  notify: TeamNotifier;
}

export async function queueDirectMailboxMessage(params: QueueDirectMessageParams): Promise<void> {
  const message = await sendDirectMessage(params.teamName, params.fromWorker, params.toWorker, params.body, params.cwd);
  const notified = await params.notify(
    { workerName: params.toWorker, workerIndex: params.toWorkerIndex, paneId: params.toPaneId },
    params.triggerMessage,
  );
  if (notified) {
    await markMessageNotified(params.teamName, params.toWorker, message.message_id, params.cwd);
  }
}

interface QueueBroadcastParams {
  teamName: string;
  fromWorker: string;
  recipients: Array<{ workerName: string; workerIndex: number; paneId?: string }>;
  body: string;
  cwd: string;
  triggerFor: (workerName: string) => string;
  notify: TeamNotifier;
}

export async function queueBroadcastMailboxMessage(params: QueueBroadcastParams): Promise<void> {
  const messages = await broadcastMessage(params.teamName, params.fromWorker, params.body, params.cwd);
  const recipientByName = new Map(params.recipients.map((r) => [r.workerName, r]));

  for (const message of messages) {
    const recipient = recipientByName.get(message.to_worker);
    if (!recipient) continue;
    const notified = await params.notify(
      { workerName: recipient.workerName, workerIndex: recipient.workerIndex, paneId: recipient.paneId },
      params.triggerFor(recipient.workerName),
    );
    if (notified) {
      await markMessageNotified(params.teamName, recipient.workerName, message.message_id, params.cwd);
    }
  }
}
