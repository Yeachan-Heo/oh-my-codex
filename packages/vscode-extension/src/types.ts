import type { ChildProcess } from 'node:child_process';

export interface DirectSessionHandle {
  session_id: string;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  log_path: string;
  started_at: string;
  child: ChildProcess;
  stop: (signal?: NodeJS.Signals | number) => boolean;
}

export interface OmxCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OmxCore {
  buildDirectSessionArgs(options?: { mode?: 'launch' | 'resume'; codexArgs?: string[] }): string[];
  resolveVscodeLaunchEnv(options: {
    cwd: string;
    omxCommand?: string;
    baseEnv?: NodeJS.ProcessEnv;
    extraPath?: string[];
  }): {
    env: NodeJS.ProcessEnv;
    pathKey: string;
    pathEntries: string[];
    codexPath: string | null;
  };
  launchDirectSession(options: {
    cwd: string;
    mode?: 'launch' | 'resume';
    prompt?: string;
    codexArgs?: string[];
    omxCommand?: string;
    dangerousApproved?: boolean;
    env?: NodeJS.ProcessEnv;
  }): DirectSessionHandle;
  launchRequiresDangerousApproval(args: readonly string[]): boolean;
  runOmxCatalogCommand(options: {
    cwd: string;
    omxCommand?: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): OmxCommandResult;
}
