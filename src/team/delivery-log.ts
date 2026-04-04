import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

export type TeamDeliveryEventName =
  | 'mailbox_created'
  | 'dispatch_attempted'
  | 'dispatch_result'
  | 'delivered'
  | 'mark_delivered'
  | 'nudge_triggered';

export type TeamDeliveryResult =
  | 'created'
  | 'queued'
  | 'ok'
  | 'confirmed'
  | 'notified'
  | 'updated'
  | 'missing'
  | 'retry'
  | 'deferred'
  | 'sent'
  | 'failed';

export interface TeamDeliveryLogEvent {
  event: TeamDeliveryEventName;
  source: string;
  team: string;
  transport?: string;
  result?: TeamDeliveryResult;
  [key: string]: unknown;
}

function normalizeTransport(transport: unknown): string | undefined {
  if (typeof transport !== 'string') return undefined;
  switch (transport) {
    case 'tmux_send_keys':
      return 'send-keys';
    case 'prompt_stdin':
      return 'prompt-stdin';
    default:
      return transport;
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  ) as T;
}

export function teamDeliveryLogPath(logsDir: string, now: Date = new Date()): string {
  return join(logsDir, `team-delivery-${now.toISOString().slice(0, 10)}.jsonl`);
}

export async function appendTeamDeliveryLog(logsDir: string, event: TeamDeliveryLogEvent): Promise<void> {
  const now = new Date();
  const entry = compactObject({
    timestamp: now.toISOString(),
    kind: 'team_delivery',
    ...event,
    transport: normalizeTransport(event.transport),
  });

  await mkdir(logsDir, { recursive: true }).catch(() => {});
  await appendFile(teamDeliveryLogPath(logsDir, now), `${JSON.stringify(entry)}\n`).catch(() => {});
}

export async function appendTeamDeliveryLogForCwd(cwd: string, event: TeamDeliveryLogEvent): Promise<void> {
  await appendTeamDeliveryLog(join(cwd, '.omx', 'logs'), event);
}
