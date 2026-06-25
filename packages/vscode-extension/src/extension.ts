import * as vscode from 'vscode';
import { OmxChatPanel } from './chatView';
import { getWorkspaceRoot, OmxSessionManager } from './sessionManager';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('OMX');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let chatPanel: OmxChatPanel | undefined;
  const sessionManager = new OmxSessionManager(context, output, () => {
    refreshStatusBar(statusBar, sessionManager);
    void chatPanel?.refresh();
  });
  chatPanel = new OmxChatPanel(context, sessionManager, output);

  statusBar.command = 'omx.openChat';
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Open OMX Chat';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('omx.openChat', async () => {
      await chatPanel.open();
    }),
    vscode.commands.registerCommand('omx.start', async () => {
      await sessionManager.promptAndStart('launch');
      await chatPanel.refresh();
    }),
    vscode.commands.registerCommand('omx.resume', async () => {
      await sessionManager.promptAndStart('resume');
      await chatPanel.refresh();
    }),
    vscode.commands.registerCommand('omx.stop', () => {
      sessionManager.stop();
      void chatPanel.refresh();
    }),
    vscode.commands.registerCommand('omx.doctor', async () => {
      await sessionManager.doctor();
    }),
  );

  refreshStatusBar(statusBar, sessionManager);
}

export function deactivate(): void {
  // Child processes are owned by OmxSessionManager and stopped through the command surface.
}

function refreshStatusBar(statusBar: vscode.StatusBarItem, sessionManager: OmxSessionManager): void {
  const active = sessionManager.active;
  if (active) {
    statusBar.text = `OMX: ${active.session_id}`;
    statusBar.tooltip = `Running in ${getWorkspaceRoot()}\nLog: ${active.log_path}`;
    return;
  }
  statusBar.text = 'OMX';
  statusBar.tooltip = 'Open OMX Chat';
}
