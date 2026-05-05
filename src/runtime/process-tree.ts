import { spawn, type ChildProcess } from 'node:child_process';
import { buildPlatformCommandSpec } from '../utils/platform-command.js';

const DEFAULT_SIGTERM_GRACE_MS = 1_000;

export interface ProcessTreeRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  sigkillGraceMs?: number;
  platform?: NodeJS.Platform;
  spawnImpl?: typeof spawn;
  existsImpl?: (path: string) => boolean;
}

export interface ProcessTreeRunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: NodeJS.ErrnoException;
}

function parsePositiveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function killProcessTree(child: ChildProcess, platform: NodeJS.Platform, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (platform === 'win32') {
      child.kill(signal);
      return;
    }
    // Children are launched as a detached process group on POSIX so a negative
    // PID targets the whole tree instead of only the direct wrapper process.
    process.kill(-child.pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    try {
      child.kill(signal);
    } catch (fallbackErr) {
      if ((fallbackErr as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackErr;
    }
  }
}

export function runProcessTreeWithTimeout(
  command: string,
  args: string[],
  options: ProcessTreeRunOptions = {},
): Promise<ProcessTreeRunResult> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const spec = buildPlatformCommandSpec(command, args, platform, env, options.existsImpl);
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = parsePositiveTimeout(options.timeoutMs);
  const killSignal = options.killSignal ?? 'SIGTERM';
  const sigkillGraceMs = options.sigkillGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
  const encoding = options.encoding ?? 'utf-8';

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;

    const child = spawnImpl(spec.command, spec.args, {
      cwd: options.cwd,
      env,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (result: Omit<ProcessTreeRunResult, 'stdout' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      resolve({ ...result, stdout, stderr, timedOut });
    };

    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ status: null, signal: null, error });
    });
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      finish({ status, signal });
    });

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        killProcessTree(child, platform, killSignal);
        sigkillTimer = setTimeout(() => {
          if (!settled) killProcessTree(child, platform, 'SIGKILL');
        }, sigkillGraceMs);
      }, timeoutMs);
    }
  });
}
