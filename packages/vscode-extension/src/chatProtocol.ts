export type WebviewCommand =
  | { command: 'send'; text: string }
  | { command: 'newConversation' }
  | { command: 'selectConversation'; conversationId?: string }
  | { command: 'openLog'; logPath?: string }
  | { command: 'stop' }
  | { command: 'doctor' }
  | { command: 'refresh' };

export function normalizeWebviewMessage(value: unknown): WebviewCommand | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command !== 'string') return null;
  switch (record.command) {
    case 'send':
      return { command: 'send', text: typeof record.text === 'string' ? record.text : '' };
    case 'newConversation':
    case 'stop':
    case 'doctor':
    case 'refresh':
      return { command: record.command };
    case 'selectConversation':
      return {
        command: 'selectConversation',
        conversationId: typeof record.conversationId === 'string' ? record.conversationId : undefined,
      };
    case 'openLog':
      return { command: 'openLog', logPath: typeof record.logPath === 'string' ? record.logPath : undefined };
    default:
      return null;
  }
}
