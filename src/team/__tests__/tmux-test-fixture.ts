import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempTmuxSessionFixture {
  sessionName: string;
  windowTarget: string;
  leaderPaneId: string;
  env: {
    TMUX: string;
    TMUX_PANE: string;
  };
  sessionExists: () => boolean;
}

function runTmux(args: string[], options: { ignoreTmuxEnv?: boolean } = {}): string {
  const env = options.ignoreTmuxEnv ? { ...process.env, TMUX: undefined, TMUX_PANE: undefined } : process.env;
  return execFileSync('tmux', args, { encoding: 'utf-8', env }).trim();
}

export function isRealTmuxAvailable(): boolean {
  try {
    runTmux(['-V'], { ignoreTmuxEnv: true });
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(sessionName: string): boolean {
  try {
    runTmux(['has-session', '-t', sessionName], { ignoreTmuxEnv: true });
    return true;
  } catch {
    return false;
  }
}

function uniqueSessionName(): string {
  return `omx-test-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function withTempTmuxSession<T>(fn: (fixture: TempTmuxSessionFixture) => Promise<T> | T): Promise<T> {
  if (!isRealTmuxAvailable()) {
    throw new Error('tmux is not available');
  }

  const fixtureCwd = await mkdtemp(join(tmpdir(), 'omx-tmux-fixture-'));
  const sessionName = uniqueSessionName();
  const created = runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}:#{window_index} #{pane_id}',
    '-s',
    sessionName,
    '-c',
    fixtureCwd,
    'sleep 300',
  ], { ignoreTmuxEnv: true });
  const [windowTarget = '', leaderPaneId = ''] = created.split(/\s+/, 2);
  if (windowTarget === '' || leaderPaneId === '') {
    try {
      runTmux(['kill-session', '-t', sessionName], { ignoreTmuxEnv: true });
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
    throw new Error(`failed to create temporary tmux fixture: ${created}`);
  }

  const socketPath = runTmux(['display-message', '-p', '-t', leaderPaneId, '#{socket_path}'], { ignoreTmuxEnv: true });
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  process.env.TMUX = `${socketPath},${process.pid},0`;
  process.env.TMUX_PANE = leaderPaneId;

  const fixture: TempTmuxSessionFixture = {
    sessionName,
    windowTarget,
    leaderPaneId,
    env: {
      TMUX: process.env.TMUX,
      TMUX_PANE: leaderPaneId,
    },
    sessionExists: () => tmuxSessionExists(sessionName),
  };

  try {
    return await fn(fixture);
  } finally {
    try {
      runTmux(['kill-session', '-t', sessionName], { ignoreTmuxEnv: true });
    } catch {}
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    await rm(fixtureCwd, { recursive: true, force: true });
  }
}
