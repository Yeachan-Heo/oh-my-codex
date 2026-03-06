import { spawnSync } from 'child_process';

export interface EnterpriseTmuxSession {
  name: string;
  workerCount: number;
  cwd: string;
  workerPaneIds: string[];
  leaderPaneId: string;
  hudPaneId: string | null;
  resizeHookName: string | null;
  resizeHookTarget: string | null;
}

interface WorkerStartupShape {
  cwd?: string;
  env?: Record<string, string>;
  initialPrompt?: string;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function loadTmuxModule(): Promise<any> {
  const modulePath = '../team/' + 'tmux-session.js';
  return await import(modulePath) as any;
}

function buildEnterpriseShellCommand(extraEnv: Record<string, string>, initialPrompt?: string): string {
  const shell = process.env.SHELL || '/bin/sh';
  const cli = process.env.OMX_ENTERPRISE_WORKER_CLI || 'codex';
  const envPrefix = Object.entries(extraEnv)
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([key, value]) => `${key}=${shellQuoteSingle(value)}`)
    .join(' ');
  const prompt = initialPrompt ? `printf '%s\n' ${shellQuoteSingle(initialPrompt)}; ` : '';
  return `env ${envPrefix} ${shellQuoteSingle(shell)} -lc ${shellQuoteSingle(`${prompt}exec ${cli}`)}`;
}

export const enterpriseTmuxAdapter = {
  async isTmuxAvailable(): Promise<boolean> {
    const mod = await loadTmuxModule();
    return mod.isTmuxAvailable();
  },

  async createTmuxSession(
    teamName: string,
    workerCount: number,
    cwd: string,
    workerLaunchArgs: string[] = [],
    workerStartups: WorkerStartupShape[] = [],
  ): Promise<EnterpriseTmuxSession> {
    const mod = await loadTmuxModule();
    return mod.createTeamSession(teamName, workerCount, cwd, workerLaunchArgs, workerStartups);
  },





  async sendKeys(paneId: string, text: string): Promise<void> {
    const result = spawnSync('tmux', ['send-keys', '-t', paneId, '-l', '--', text], { encoding: 'utf-8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
    }
    const enter = spawnSync('tmux', ['send-keys', '-t', paneId, 'C-m'], { encoding: 'utf-8' });
    if (enter.error) throw enter.error;
    if (enter.status !== 0) {
      throw new Error((enter.stderr || '').trim() || `tmux exited ${enter.status}`);
    }
  },

  async killPane(paneId: string): Promise<void> {
    const result = spawnSync('tmux', ['kill-pane', '-t', paneId], { encoding: 'utf-8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
    }
  },

  async destroyTmuxSession(sessionName: string): Promise<void> {
    const mod = await loadTmuxModule();
    return mod.destroyTeamSession(sessionName);
  },

  async buildWorkerStartupCommand(
    _teamName: string,
    _workerIndex: number,
    _workerLaunchArgs: string[] = [],
    _cwd?: string,
    workerEnv?: Record<string, string>,
    _workerCli?: 'codex' | 'claude' | 'gemini',
    initialPrompt?: string,
  ): Promise<string> {
    return buildEnterpriseShellCommand(workerEnv ?? {}, initialPrompt);
  },

  async spawnPane(targetPaneId: string, cwd: string, command: string): Promise<string> {
    const result = spawnSync('tmux', [
      'split-window', '-v', '-t', targetPaneId, '-d', '-P', '-F', '#{pane_id}', '-c', cwd, command,
    ], { encoding: 'utf-8' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
    }
    const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
    if (!paneId || !paneId.startsWith('%')) {
      throw new Error('failed to capture subordinate pane id');
    }
    return paneId;
  },
};
