import * as vscode from 'vscode';
import { loadOmxCore } from './core';
import { buildLaunchPreviewArgs, normalizePrompt, resolveOmxCommand } from './sessionOptions';
import type { DirectSessionHandle } from './types';

type DirectMode = 'launch' | 'resume';

export interface SessionCallbacks {
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (error: Error) => void;
}

export class OmxSessionManager {
  private activeSession: DirectSessionHandle | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly onDidChange: () => void,
  ) {}

  get active(): DirectSessionHandle | null {
    return this.activeSession;
  }

  async promptAndStart(mode: DirectMode): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      title: mode === 'resume' ? 'Resume OMX session' : 'Start OMX session',
      prompt: 'Optional prompt passed to OMX',
      ignoreFocusOut: true,
    });
    if (prompt === undefined) return;
    await this.start(mode, normalizePrompt(prompt));
  }

  async start(
    mode: DirectMode,
    prompt?: string,
    callbacks: SessionCallbacks = {},
  ): Promise<DirectSessionHandle | null> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const config = vscode.workspace.getConfiguration('omx');
    const omxCommand = resolveOmxCommand(cwd, config.get<string>('command'));
    const launchEnv = core.resolveVscodeLaunchEnv({
      cwd,
      omxCommand,
      extraPath: config.get<string[]>('extraPath') ?? [],
    });
    const codexArgs = config.get<string[]>('defaultArgs') ?? [];
    const launchArgs = core.buildDirectSessionArgs({
      mode,
      codexArgs: buildLaunchPreviewArgs(codexArgs, prompt),
    });
    const needsApproval = core.launchRequiresDangerousApproval(launchArgs);
    const dangerousApproved = needsApproval
      ? await confirmDangerousLaunch(launchArgs, config)
      : false;
    if (needsApproval && !dangerousApproved) return null;

    const handle = core.launchDirectSession({
      cwd,
      mode,
      prompt,
      codexArgs,
      omxCommand,
      dangerousApproved,
      env: launchEnv.env,
    });
    this.bindSession(handle, mode, callbacks);
    return handle;
  }

  stop(): void {
    const active = this.activeSession;
    if (!active) return;
    active.stop();
    this.output.appendLine(`[omx] stop requested for ${active.session_id}`);
  }

  async doctor(): Promise<void> {
    const cwd = getWorkspaceRoot();
    const core = await loadOmxCore(this.context);
    const result = core.runOmxCatalogCommand({
      cwd,
      omxCommand: resolveOmxCommand(cwd, vscode.workspace.getConfiguration('omx').get<string>('command')),
      args: ['doctor'],
    });
    this.output.show(true);
    this.output.appendLine(`[omx] doctor exited code=${result.code ?? 'null'}`);
    if (result.stdout) this.output.append(result.stdout);
    if (result.stderr) this.output.append(result.stderr);
  }

  private bindSession(handle: DirectSessionHandle, mode: DirectMode, callbacks: SessionCallbacks): void {
    this.activeSession = handle;
    this.output.show(true);
    this.output.appendLine(`[omx] started ${mode} session ${handle.session_id}`);
    this.output.appendLine(`[omx] log: ${handle.log_path}`);

    handle.child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      this.output.append(text);
      callbacks.onOutput?.('stdout', text);
    });
    handle.child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = String(chunk);
      this.output.append(text);
      callbacks.onOutput?.('stderr', text);
    });
    handle.child.on('exit', (code, signal) => {
      this.output.appendLine(
        `\n[omx] session ${handle.session_id} exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
      );
      callbacks.onExit?.(code, signal);
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    handle.child.on('error', (error) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.output.appendLine(`[omx] launch error: ${normalized.message}`);
      callbacks.onError?.(normalized);
      if (this.activeSession?.session_id === handle.session_id) {
        this.activeSession = null;
        this.onDidChange();
      }
    });
    this.onDidChange();
  }
}

async function confirmDangerousLaunch(
  launchArgs: string[],
  config: vscode.WorkspaceConfiguration,
): Promise<boolean> {
  if (!config.get<boolean>('confirmDangerousLaunches', true)) return true;
  const choice = await vscode.window.showWarningMessage(
    `OMX will launch with approval-bypass flags: ${launchArgs.join(' ')}`,
    { modal: true },
    'Launch',
  );
  return choice === 'Launch';
}

export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}
