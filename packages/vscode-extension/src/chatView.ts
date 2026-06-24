import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  appendMessage,
  createConversation,
  listConversations,
  readConversation,
  updateMessage,
  type ChatConversation,
  type ChatConversationSummary,
} from './chatStore';
import { normalizeWebviewMessage } from './chatProtocol';
import { formatSessionMessage, trimTranscript } from './sessionTranscript';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';
import type { DirectSessionHandle } from './types';
import { listVscodeLogs, realPathInsideWorkspace, type VscodeLogSummary } from './workspaceStatus';

interface ChatViewState {
  activeConversationId: string | null;
  conversations: ChatConversationSummary[];
  conversation: ChatConversation | null;
  activeSession: {
    session_id: string;
    log_path: string;
    started_at: string;
  } | null;
  logs: VscodeLogSummary[];
}

export class OmxChatPanel {
  private panel: vscode.WebviewPanel | undefined;
  private activeConversationId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: OmxSessionManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  async open(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      await this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel('omx.chat', 'OMX Chat', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    panel.webview.html = renderChatHtml(randomUUID());
    panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.context.subscriptions);
    panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    }, null, this.context.subscriptions);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      await this.panel.webview.postMessage({ type: 'state', state: await this.buildState() });
    } catch (error) {
      await this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async buildState(): Promise<ChatViewState> {
    const cwd = getWorkspaceRoot();
    const [conversations, logs] = await Promise.all([listConversations(cwd), listVscodeLogs(cwd, 8)]);
    if (!this.activeConversationId && conversations[0]) this.activeConversationId = conversations[0].id;
    const conversation = this.activeConversationId ? await readConversation(cwd, this.activeConversationId) : null;
    if (this.activeConversationId && !conversation) this.activeConversationId = null;
    const active = this.sessionManager.active;
    return {
      activeConversationId: conversation?.id ?? null,
      conversations,
      conversation,
      activeSession: active
        ? { session_id: active.session_id, log_path: active.log_path, started_at: active.started_at }
        : null,
      logs,
    };
  }

  private async handleMessage(rawMessage: unknown): Promise<void> {
    const message = normalizeWebviewMessage(rawMessage);
    if (!message) return;
    switch (message.command) {
      case 'send':
        await this.send(message.text ?? '');
        break;
      case 'newConversation':
        this.activeConversationId = (await createConversation(getWorkspaceRoot())).id;
        await this.refresh();
        break;
      case 'selectConversation':
        this.activeConversationId = message.conversationId ?? null;
        await this.refresh();
        break;
      case 'openLog':
        await this.openLog(message.logPath);
        break;
      case 'stop':
        this.sessionManager.stop();
        await this.refresh();
        break;
      case 'doctor':
        await this.sessionManager.doctor();
        await this.refresh();
        break;
      case 'refresh':
        await this.refresh();
        break;
    }
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;
    const cwd = getWorkspaceRoot();
    const conversation = await this.ensureConversation(text);
    await appendMessage(cwd, conversation.id, { role: 'user', text });

    if (this.sessionManager.active) {
      await appendMessage(cwd, conversation.id, {
        role: 'system',
        text: 'An OMX session is already running. Stop it before sending another prompt.',
      });
      await this.refresh();
      return;
    }

    const pending = await appendMessage(cwd, conversation.id, {
      role: 'assistant',
      text: 'Starting OMX session...',
    });
    const responseId = pending.messages[pending.messages.length - 1]?.id;
    let transcript = '';
    let handle: DirectSessionHandle | null = null;
    let terminalStatus: string | null = null;
    let updateQueue: Promise<void> = Promise.resolve();
    const updateResponse = async (status: string): Promise<void> => {
      if (!responseId) return;
      await updateMessage(cwd, conversation.id, responseId, {
        text: formatSessionMessage(status, handle, transcript),
        session_id: handle?.session_id,
        log_path: handle?.log_path,
      });
      await this.refresh();
    };
    const scheduleResponseUpdate = (status: string): void => {
      updateQueue = updateQueue
        .catch(() => undefined)
        .then(() => updateResponse(status));
      void updateQueue.catch((error) => {
        this.output.appendLine(`[omx] chat update failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    await this.refresh();

    try {
      handle = await this.sessionManager.start('launch', text, {
        onOutput: (_stream, chunk) => {
          transcript = trimTranscript(`${transcript}${chunk}`);
          scheduleResponseUpdate('Running');
        },
        onExit: (code, signal) => {
          terminalStatus = `Exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
          scheduleResponseUpdate(terminalStatus);
        },
        onError: (error) => {
          terminalStatus = `Launch error: ${error.message}`;
          scheduleResponseUpdate(terminalStatus);
        },
      });
      if (handle) {
        if (!terminalStatus) scheduleResponseUpdate('Running');
        await updateQueue;
      } else if (responseId) {
        await updateMessage(cwd, conversation.id, responseId, { text: 'Launch cancelled.' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[omx] chat launch failed: ${message}`);
      if (responseId) {
        await updateMessage(cwd, conversation.id, responseId, { text: `Launch failed:\n${message}` });
      } else {
        await appendMessage(cwd, conversation.id, { role: 'assistant', text: `Launch failed:\n${message}` });
      }
    }
    await this.refresh();
  }

  private async ensureConversation(initialText: string): Promise<ChatConversation> {
    const cwd = getWorkspaceRoot();
    if (this.activeConversationId) {
      const existing = await readConversation(cwd, this.activeConversationId);
      if (existing) return existing;
    }
    const created = await createConversation(cwd, initialText);
    this.activeConversationId = created.id;
    return created;
  }

  private async openLog(logPath: string | undefined): Promise<void> {
    if (!logPath) return;
    const cwd = getWorkspaceRoot();
    if (!await realPathInsideWorkspace(cwd, logPath)) {
      await vscode.window.showErrorMessage('OMX refused to open a log outside the active workspace.');
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(logPath)));
    await vscode.window.showTextDocument(document, { preview: true });
  }
}

function renderChatHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .layout { display: grid; grid-template-columns: minmax(150px, 220px) 1fr; height: 100vh; }
    aside { border-right: 1px solid var(--vscode-panel-border); overflow: auto; }
    main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
    header, form { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    form { border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
    button, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    button { padding: 6px 8px; cursor: pointer; }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    textarea { flex: 1; min-height: 52px; resize: vertical; padding: 8px; font-family: inherit; }
    .conversation, .log { display: block; width: 100%; padding: 10px; text-align: left; border-width: 0 0 1px; border-radius: 0; }
    .conversation.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .logs { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
    .messages { overflow: auto; padding: 14px; }
    .message { margin: 0 0 14px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 4px; }
    .bubble { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .user .bubble { background: var(--vscode-input-background); }
    .empty, .error { color: var(--vscode-descriptionForeground); padding: 14px; }
    .error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="layout">
    <aside>
      <header><button id="new">New</button><button id="refresh">Refresh</button></header>
      <div id="conversations"></div>
      <section class="logs"><div class="meta">Recent logs</div><div id="logs"></div></section>
    </aside>
    <main>
      <header><div id="status" class="meta"></div><button id="stop">Stop</button><button id="doctor">Doctor</button></header>
      <div id="messages" class="messages"></div>
      <form id="form"><textarea id="input" rows="3"></textarea><button class="primary" type="submit">Send</button></form>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const conversationsEl = document.getElementById('conversations');
    const logsEl = document.getElementById('logs');
    const messagesEl = document.getElementById('messages');
    const statusEl = document.getElementById('status');
    const inputEl = document.getElementById('input');
    document.getElementById('new').addEventListener('click', () => post('newConversation'));
    document.getElementById('refresh').addEventListener('click', () => post('refresh'));
    document.getElementById('stop').addEventListener('click', () => post('stop'));
    document.getElementById('doctor').addEventListener('click', () => post('doctor'));
    document.getElementById('form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = inputEl.value;
      inputEl.value = '';
      post('send', { text });
    });
    function post(command, payload = {}) { vscode.postMessage({ command, ...payload }); }
    function renderState(state) {
      const messages = state.conversation ? state.conversation.messages || [] : [];
      statusEl.textContent = state.activeSession ? 'Running ' + state.activeSession.session_id : 'Idle';
      conversationsEl.textContent = '';
      for (const item of state.conversations || []) {
        const button = document.createElement('button');
        button.className = 'conversation' + (item.id === state.activeConversationId ? ' active' : '');
        button.textContent = item.title + ' · ' + item.message_count;
        button.addEventListener('click', () => post('selectConversation', { conversationId: item.id }));
        conversationsEl.appendChild(button);
      }
      logsEl.textContent = '';
      for (const log of state.logs || []) {
        const button = document.createElement('button');
        button.className = 'log';
        button.textContent = log.name + ' · ' + log.size + ' bytes';
        button.addEventListener('click', () => post('openLog', { logPath: log.path }));
        logsEl.appendChild(button);
      }
      messagesEl.textContent = '';
      if (!messages.length) {
        messagesEl.appendChild(empty('No messages yet.'));
        return;
      }
      for (const message of messages) {
        const row = document.createElement('div');
        row.className = 'message ' + message.role;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = message.role + ' · ' + new Date(message.created_at).toLocaleString();
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = message.text || '';
        row.appendChild(meta);
        row.appendChild(bubble);
        if (message.log_path) {
          const open = document.createElement('button');
          open.textContent = 'Open log';
          open.addEventListener('click', () => post('openLog', { logPath: message.log_path }));
          row.appendChild(open);
        }
        messagesEl.appendChild(row);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }
    window.addEventListener('message', (event) => {
      if (event.data.type === 'state') renderState(event.data.state);
      if (event.data.type === 'error') {
        messagesEl.textContent = '';
        const node = empty(event.data.message);
        node.className = 'error';
        messagesEl.appendChild(node);
      }
    });
  </script>
</body>
</html>`;
}
