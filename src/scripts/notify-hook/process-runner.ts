/**
 * Subprocess helper for notify-hook modules.
 */

import { spawn } from 'child_process';
import { normalizeMuxStdout, resolveMuxInvocation } from './mux-adapter.js';

export function runProcess(command: string, args: string[], timeoutMs = 3000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const invocation = resolveMuxInvocation(command, args, process.env);
    const effectiveTimeoutMs = invocation.usingTestBinary || invocation.relaxTimeout ? Math.max(timeoutMs, 10_000) : timeoutMs;
    const child = spawn(invocation.command, invocation.args, {
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
        resolve({ stdout: normalizeMuxStdout(invocation, stdout, process.env), stderr, code });
      } else {
        reject(new Error(stderr.trim() || `${invocation.command} exited ${code}`));
      }
    });
  });
}
