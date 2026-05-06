import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { buildPlatformCommandSpec } from '../utils/platform-command.js';

const DEFAULT_SIGTERM_GRACE_MS = 1_000;
const DEFAULT_PROCESS_LIMIT_POLL_MS = 100;

export interface ProcessTreeRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  timeoutMs?: number;
  killSignal?: NodeJS.Signals;
  sigkillGraceMs?: number;
  maxOutputBytes?: number;
  maxProcessCount?: number;
  processLimitPollMs?: number;
  cleanupOnParentExit?: boolean;
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
  processLimitExceeded: boolean;
  outputLimitExceeded: boolean;
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

function parsePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function readLinuxProcessTable(): Map<number, number> | undefined {
  try {
    const entries = readdirSync('/proc', { withFileTypes: true });
    const table = new Map<number, number>();
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number.parseInt(entry.name, 10);
      let stat: string;
      try {
        stat = readFileSync(`/proc/${entry.name}/stat`, 'utf-8');
      } catch {
        continue;
      }
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) continue;
      const fields = stat.slice(closeParen + 2).split(' ');
      const ppid = Number.parseInt(fields[1] ?? '', 10);
      if (Number.isFinite(ppid)) table.set(pid, ppid);
    }
    return table;
  } catch {
    return undefined;
  }
}

function countDescendantsLinux(rootPid: number): number | undefined {
  const table = readLinuxProcessTable();
  if (!table) return undefined;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  let count = 0;
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    count += 1;
    stack.push(...(children.get(pid) ?? []));
  }
  return count;
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
  const maxOutputBytes = parsePositiveInteger(options.maxOutputBytes);
  const maxProcessCount = parsePositiveInteger(options.maxProcessCount);
  const processLimitPollMs = parsePositiveInteger(options.processLimitPollMs) ?? DEFAULT_PROCESS_LIMIT_POLL_MS;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let processLimitExceeded = false;
    let outputLimitExceeded = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let sigkillTimer: NodeJS.Timeout | undefined;
    let processLimitTimer: NodeJS.Timeout | undefined;
    const cleanupSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

    const child = spawnImpl(spec.command, spec.args, {
      cwd: options.cwd,
      env,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const terminate = (signal: NodeJS.Signals = killSignal): void => {
      killProcessTree(child, platform, signal);
      if (signal !== 'SIGKILL') {
        sigkillTimer ??= setTimeout(() => {
          if (!settled) killProcessTree(child, platform, 'SIGKILL');
        }, sigkillGraceMs);
      }
    };

    const parentCleanupHandler = (signal?: NodeJS.Signals | number): void => {
      terminate(typeof signal === 'string' ? signal : killSignal);
    };

    if (options.cleanupOnParentExit) {
      for (const signal of cleanupSignals) process.once(signal, parentCleanupHandler);
      process.once('beforeExit', parentCleanupHandler);
      process.once('exit', parentCleanupHandler);
    }

    const removeParentCleanupHandlers = (): void => {
      if (!options.cleanupOnParentExit) return;
      for (const signal of cleanupSignals) process.off(signal, parentCleanupHandler);
      process.off('beforeExit', parentCleanupHandler);
      process.off('exit', parentCleanupHandler);
    };

    const finish = (result: Omit<ProcessTreeRunResult, 'stdout' | 'stderr' | 'timedOut' | 'processLimitExceeded' | 'outputLimitExceeded'>): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      if (processLimitTimer) clearInterval(processLimitTimer);
      removeParentCleanupHandlers();
      resolve({ ...result, stdout, stderr, timedOut, processLimitExceeded, outputLimitExceeded });
    };

    const appendBoundedOutput = (current: string, chunk: string): string => {
      if (outputLimitExceeded) return current;
      if (maxOutputBytes === undefined) return current + chunk;
      const currentBytes = Buffer.byteLength(current, encoding);
      const chunkBytes = Buffer.byteLength(chunk, encoding);
      if (currentBytes + chunkBytes <= maxOutputBytes) return current + chunk;
      outputLimitExceeded = true;
      terminate();
      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      return current + Buffer.from(chunk, encoding).subarray(0, remaining).toString(encoding);
    };

    child.stdout.setEncoding(encoding);
    child.stderr.setEncoding(encoding);
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    const sweepProcessGroupAfterParentExit = (): void => {
      if (platform === 'win32') return;
      killProcessTree(child, platform, killSignal);
      const residualSigkillTimer = setTimeout(() => {
        killProcessTree(child, platform, 'SIGKILL');
      }, sigkillGraceMs);
      residualSigkillTimer.unref?.();
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ status: null, signal: null, error });
    });
    child.on('exit', () => {
      // `close` waits for stdio EOF, so a direct wrapper that exits while a
      // grandchild keeps inherited stdout/stderr open can otherwise sit until
      // timeout. Sweep as soon as the direct parent exits, then let `close`
      // report the parent's status and captured output.
      sweepProcessGroupAfterParentExit();
    });
    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      finish({ status, signal });
    });

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        terminate();
      }, timeoutMs);
    }
    if (platform === 'linux' && maxProcessCount !== undefined) {
      processLimitTimer = setInterval(() => {
        if (settled || child.pid === undefined) return;
        const descendants = countDescendantsLinux(child.pid);
        if (descendants === undefined) return;
        if (descendants + 1 > maxProcessCount) {
          processLimitExceeded = true;
          terminate();
        }
      }, processLimitPollMs);
    }
  });
}
