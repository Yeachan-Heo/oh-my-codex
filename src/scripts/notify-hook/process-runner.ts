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

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`timeout after ${effectiveTimeoutMs}ms`));
    }, effectiveTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(stderr.trim() || `${command} exited ${code}`));
      }
    });
  });
}
