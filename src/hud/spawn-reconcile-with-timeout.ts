import { execFileSync, spawn } from 'child_process';

export interface SpawnReconcileOptions {
  omxBinary: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  leaderPaneId?: string;
  leaderPanePid?: string;
  keepAlive?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Spawn the reconcile process with timeout and process tree kill on both POSIX and Windows.
 * On POSIX, kills the process group to terminate any child processes.
 * On Windows, uses taskkill /T to kill the process tree.
 * Callers that must wait for the result before exiting can keep the child and
 * timeout referenced; the long-running watcher leaves them unreferenced so
 * stopping the watcher is not delayed by an in-flight repair.
 */
export async function spawnReconcileWithTimeout(options: SpawnReconcileOptions): Promise<boolean> {
  const {
    omxBinary,
    cwd,
    env,
    timeoutMs,
    leaderPaneId,
    leaderPanePid,
    keepAlive = false,
    platform = process.platform,
  } = options;

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
  };
  if (leaderPaneId) {
    childEnv.TMUX_PANE = leaderPaneId;
  }
  if (leaderPanePid) {
    childEnv.OMX_HUD_WATCH_LEADER_PID = leaderPanePid;
  }
  childEnv.OMX_HUD_WATCH_REPAIR = '1';

  const child = spawn(process.execPath, [omxBinary, 'hud', '--reconcile-tmux'], {
    cwd,
    env: childEnv,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });

  const killChild = (): void => {
    // The detached child leads its own process group on POSIX; kill the
    // group so a subprocess it started (tmux) does not outlive it.
    // Windows has no process groups: `taskkill /T` ends the process tree.
    try {
      if (child.pid === undefined) {
        child.kill('SIGKILL');
      } else if (platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 5_000,
        });
      } else {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      child.kill('SIGKILL');
    }
  };

  const onParentSigterm = keepAlive && platform !== 'win32' ? killChild : undefined;
  if (onParentSigterm) process.once('SIGTERM', onParentSigterm);

  // A child stuck before it runs any JS never exits on its own; bound it
  // so the watcher can retry instead of waiting on it forever. The hook wrapper
  // keeps this timer referenced so the wrapper cannot exit before it fires.
  const killTimer = setTimeout(killChild, timeoutMs);
  if (!keepAlive) killTimer.unref();

  const settled = new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      clearTimeout(killTimer);
      if (onParentSigterm) process.removeListener('SIGTERM', onParentSigterm);
    };
    child.once('error', () => {
      cleanup();
      resolve(false);
    });
    child.once('close', (code) => {
      cleanup();
      resolve(code === 0);
    });
  });

  if (!keepAlive) child.unref();
  return settled;
}
