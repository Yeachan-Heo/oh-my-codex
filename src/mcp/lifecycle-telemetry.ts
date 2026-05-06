import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const LIFECYCLE_LOG_ENV = 'OMX_MCP_LIFECYCLE_LOG';
export const LIFECYCLE_LOG_DIR_ENV = 'OMX_MCP_LIFECYCLE_LOG_DIR';

const MAX_LINE_BYTES = 4 * 1024 - 64;
const ROTATION_THRESHOLD_BYTES = 4 * 1024 * 1024;
const ROTATION_KEEP = 2;

export type LogDirSource = 'env' | 'platform' | 'fallback';

export interface ResolveLogDirResult {
  dir: string;
  source: LogDirSource;
}

export interface ResolveLogDirOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  home?: string | null;
  tmp?: string;
}

export function resolveLogDir(options: ResolveLogDirOptions = {}): ResolveLogDirResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = 'home' in options ? options.home : (homedir() || null);
  const tmp = options.tmp ?? tmpdir();

  const override = env[LIFECYCLE_LOG_DIR_ENV]?.trim();
  if (override) {
    return { dir: override, source: 'env' };
  }

  if (platform === 'darwin' && home) {
    return {
      dir: join(home, 'Library', 'Logs', 'oh-my-codex', 'mcp'),
      source: 'platform',
    };
  }

  if (platform === 'linux' && home) {
    const xdgState = env.XDG_STATE_HOME?.trim();
    const stateRoot = xdgState && xdgState.length > 0 ? xdgState : join(home, '.local', 'state');
    return {
      dir: join(stateRoot, 'oh-my-codex', 'mcp'),
      source: 'platform',
    };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return {
        dir: join(localAppData, 'oh-my-codex', 'Logs', 'mcp'),
        source: 'platform',
      };
    }
  }

  return {
    dir: join(tmp, 'oh-my-codex-mcp'),
    source: 'fallback',
  };
}

export function isLifecycleLogDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[LIFECYCLE_LOG_ENV]?.toLowerCase() === 'off';
}

export interface EmitOptions {
  entrypoint: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  now?: () => number;
  pid?: number;
  ppid?: number;
}

let dirEnsured: string | null = null;

async function ensureDirOnce(dir: string): Promise<void> {
  if (dirEnsured === dir) return;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  dirEnsured = dir;
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    const info = await stat(filePath);
    size = info.size;
  } catch {
    return;
  }
  if (size < ROTATION_THRESHOLD_BYTES) return;

  for (let i = ROTATION_KEEP; i >= 1; i -= 1) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    try {
      await rename(src, dst);
    } catch {
      // generation may not exist yet
    }
  }
  try {
    await rename(filePath, `${filePath}.1`);
  } catch {
    // another writer may have rotated first
  }
}

interface EmitContext {
  pid: number;
  ppid: number;
  now: number;
  filePath: string;
  dir: string;
}

function buildContext(options: EmitOptions): EmitContext | null {
  const env = options.env ?? process.env;
  if (isLifecycleLogDisabled(env)) return null;
  const platform = options.platform ?? process.platform;
  const resolution = resolveLogDir({ env, platform });
  return {
    pid: options.pid ?? process.pid,
    ppid: options.ppid ?? process.ppid,
    now: options.now ? options.now() : Date.now(),
    filePath: join(resolution.dir, `${options.entrypoint}.ndjson`),
    dir: resolution.dir,
  };
}

function buildLine(
  event: string,
  payload: Record<string, unknown>,
  ctx: EmitContext,
): string | null {
  const record: Record<string, unknown> = {
    ts_ms: ctx.now,
    pid: ctx.pid,
    ppid: ctx.ppid,
    event,
    ...payload,
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return null;
  }
  if (Buffer.byteLength(serialized, 'utf8') >= MAX_LINE_BYTES) {
    const skip = {
      ts_ms: ctx.now,
      pid: ctx.pid,
      ppid: ctx.ppid,
      event: 'lifecycle_event_skipped',
      reason: 'oversize',
      original_event: event,
      original_bytes: Buffer.byteLength(serialized, 'utf8'),
    };
    serialized = JSON.stringify(skip);
  }
  return `${serialized}\n`;
}

const inflight = new Set<Promise<void>>();

export function emit(
  event: string,
  payload: Record<string, unknown>,
  options: EmitOptions,
): Promise<void> {
  const ctx = buildContext(options);
  if (!ctx) return Promise.resolve();
  const line = buildLine(event, payload, ctx);
  if (!line) return Promise.resolve();
  const writePromise = (async () => {
    try {
      await ensureDirOnce(ctx.dir);
      await rotateIfNeeded(ctx.filePath);
      await appendFile(ctx.filePath, line, { flag: 'a' });
    } catch {
      // emit must never throw
    }
  })();
  inflight.add(writePromise);
  void writePromise.finally(() => {
    inflight.delete(writePromise);
  });
  return writePromise;
}

export async function flush(): Promise<void> {
  const pending = Array.from(inflight);
  if (pending.length === 0) return;
  await Promise.allSettled(pending);
}

export function _resetForTests(): void {
  dirEnsured = null;
  inflight.clear();
}
