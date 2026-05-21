/**
 * Subprocess helper for notify-hook modules.
 */

import { spawn } from 'child_process';

export function runProcess(command: string, args: string[], timeoutMs = 3000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const usingTestTmux = command === 'tmux' && process.env.OMX_TEST_TMUX_BIN;
    const relaxingTestTmuxTimeout = command === 'tmux' && process.env.OMX_TEST_RELAX_TMUX_TIMEOUT === '1';
    const executable = usingTestTmux ? process.env.OMX_TEST_TMUX_BIN as string : command;
    const effectiveTimeoutMs = usingTestTmux || relaxingTestTmuxTimeout ? Math.max(timeoutMs, 10_000) : timeoutMs;
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (clearPendingSigkill = true) => {
      clearTimeout(timer);
      if (clearPendingSigkill && sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('close', onClose);
    };

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString();
    };
    const onError = (err: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };
    const onClose = (code: number | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => {
        sigkillTimer = undefined;
        child.kill('SIGKILL');
      }, 250);
      sigkillTimer.unref?.();
      cleanup(false);
      reject(new Error(`timeout after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs);

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
  });
}
