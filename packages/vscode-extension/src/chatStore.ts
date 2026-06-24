import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  created_at: string;
  session_id?: string;
  log_path?: string;
}

export interface ChatConversation {
  schema_version: 'omx.vscode/conversation/v1';
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

export interface ChatConversationSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

const SAFE_CONVERSATION_ID = /^[a-zA-Z0-9._-]+$/;

function conversationsDir(cwd: string): string {
  return path.join(cwd, '.omx', 'vscode', 'conversations');
}

function conversationPath(cwd: string, id: string): string {
  if (!SAFE_CONVERSATION_ID.test(id)) throw new Error(`invalid conversation id: ${id}`);
  return path.join(conversationsDir(cwd), `${id}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function defaultTitle(text?: string): string {
  const firstLine = text?.trim().split(/\r?\n/)[0]?.trim();
  if (!firstLine) return 'New conversation';
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine;
}

async function writeConversation(cwd: string, conversation: ChatConversation): Promise<void> {
  const dir = conversationsDir(cwd);
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${conversation.id}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(conversation, null, 2)}\n`);
    await rename(temp, conversationPath(cwd, conversation.id));
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createConversation(cwd: string, title?: string): Promise<ChatConversation> {
  const timestamp = nowIso();
  const conversation: ChatConversation = {
    schema_version: 'omx.vscode/conversation/v1',
    id: `chat-${Date.now()}-${randomUUID().slice(0, 8)}`,
    title: defaultTitle(title),
    created_at: timestamp,
    updated_at: timestamp,
    messages: [],
  };
  await writeConversation(cwd, conversation);
  return conversation;
}

export async function readConversation(cwd: string, id: string): Promise<ChatConversation | null> {
  let raw: string;
  try {
    raw = await readFile(conversationPath(cwd, id), 'utf8');
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
  return parseConversation(raw, id);
}

export async function listConversations(cwd: string): Promise<ChatConversationSummary[]> {
  let entries: string[];
  try {
    entries = await readdir(conversationsDir(cwd));
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return [];
    throw error;
  }

  const summaries: ChatConversationSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!SAFE_CONVERSATION_ID.test(id)) continue;
    const conversation = await readConversation(cwd, id);
    if (!conversation) continue;
    summaries.push({
      id: conversation.id,
      title: conversation.title,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
      message_count: conversation.messages.length,
    });
  }
  return summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function appendMessage(
  cwd: string,
  conversationId: string,
  message: Omit<ChatMessage, 'id' | 'created_at'> & Partial<Pick<ChatMessage, 'id' | 'created_at'>>,
): Promise<ChatConversation> {
  const conversation = await readConversation(cwd, conversationId);
  if (!conversation) throw new Error(`conversation not found: ${conversationId}`);
  const createdAt = message.created_at ?? nowIso();
  conversation.messages.push({
    id: message.id ?? `msg-${Date.now()}-${randomUUID().slice(0, 8)}`,
    role: message.role,
    text: message.text,
    created_at: createdAt,
    session_id: message.session_id,
    log_path: message.log_path,
  });
  if (conversation.messages.length === 1 && conversation.title === 'New conversation') {
    conversation.title = defaultTitle(message.text);
  }
  conversation.updated_at = createdAt;
  await writeConversation(cwd, conversation);
  return conversation;
}

export async function updateMessage(
  cwd: string,
  conversationId: string,
  messageId: string,
  patch: Partial<Pick<ChatMessage, 'role' | 'text' | 'session_id' | 'log_path'>>,
): Promise<ChatConversation> {
  const conversation = await readConversation(cwd, conversationId);
  if (!conversation) throw new Error(`conversation not found: ${conversationId}`);
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message) throw new Error(`message not found: ${messageId}`);
  if (patch.role !== undefined) message.role = patch.role;
  if (patch.text !== undefined) message.text = patch.text;
  if (patch.session_id !== undefined) message.session_id = patch.session_id;
  if (patch.log_path !== undefined) message.log_path = patch.log_path;
  conversation.updated_at = nowIso();
  await writeConversation(cwd, conversation);
  return conversation;
}

function parseConversation(raw: string, expectedId: string): ChatConversation | null {
  try {
    return normalizeConversation(JSON.parse(raw), expectedId);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function normalizeConversation(value: unknown, expectedId: string): ChatConversation | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<ChatConversation>;
  if (parsed.schema_version !== 'omx.vscode/conversation/v1' || parsed.id !== expectedId) return null;
  return {
    schema_version: 'omx.vscode/conversation/v1',
    id: parsed.id,
    title: typeof parsed.title === 'string' ? parsed.title : 'Untitled conversation',
    created_at: typeof parsed.created_at === 'string' ? parsed.created_at : nowIso(),
    updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : nowIso(),
    messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isChatMessage) : [],
  };
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ChatMessage>;
  return (
    typeof record.id === 'string' &&
    (record.role === 'user' || record.role === 'assistant' || record.role === 'system') &&
    typeof record.text === 'string' &&
    typeof record.created_at === 'string'
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}
