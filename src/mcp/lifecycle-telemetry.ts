import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServerName } from './bootstrap.js';

const LIFECYCLE_LOG_ENV = 'OMX_MCP_LIFECYCLE_LOG';
const LIFECYCLE_LOG_DIR_ENV = 'OMX_MCP_LIFECYCLE_LOG_DIR';
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024;

export interface McpLifecycleTelemetryEvent {
  event: string;
  server: McpServerName;
  entrypoint: string | null;
  pid?: number;
  ppid?: number;
  reason?: string;
  matching_pids?: number[];
  newer_sibling_pids?: number[];
  [key: string]: unknown;
}

function isTelemetryDisabled(env: Record<string, string | undefined>): boolean {
  const raw = env[LIFECYCLE_LOG_ENV]?.trim().toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

export function resolveMcpLifecycleLogDir(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  currentPlatform = platform(),
): string | null {
  if (isTelemetryDisabled(env)) return null;

  const explicitDir = env[LIFECYCLE_LOG_DIR_ENV]?.trim();
  if (explicitDir) return explicitDir;

  if (currentPlatform === 'darwin') {
    return join(home, 'Library', 'Logs', 'oh-my-codex', 'mcp');
  }

  if (currentPlatform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    return localAppData
      ? join(localAppData, 'oh-my-codex', 'Logs', 'mcp')
      : join(home, 'AppData', 'Local', 'oh-my-codex', 'Logs', 'mcp');
  }

  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  return join(xdgStateHome || join(home, '.local', 'state'), 'oh-my-codex', 'mcp');
}

function sanitizeLogBasename(value: string | null): string {
  return (value || 'unknown-server')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown-server';
}

export function resolveMcpLifecycleLogFile(
  server: McpServerName,
  entrypoint: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dir = resolveMcpLifecycleLogDir(env);
  if (!dir) return null;
  return join(dir, `${sanitizeLogBasename(entrypoint ?? server)}.ndjson`);
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file)) return;
  if (statSync(file).size < MAX_LOG_BYTES) return;

  const older = `${file}.2`;
  const newer = `${file}.1`;
  try {
    if (existsSync(newer)) renameSync(newer, older);
  } catch {
    // Best-effort rotation only; append must remain non-fatal.
  }
  try {
    renameSync(file, newer);
  } catch {
    // Best-effort rotation only; append must remain non-fatal.
  }
}

export function writeMcpLifecycleTelemetry(
  event: McpLifecycleTelemetryEvent,
  env: Record<string, string | undefined> = process.env,
): void {
  const file = resolveMcpLifecycleLogFile(event.server, event.entrypoint, env);
  if (!file) return;

  try {
    mkdirSync(dirname(file), { recursive: true });
    rotateIfNeeded(file);
    const payload = {
      ts_ms: Date.now(),
      pid: process.pid,
      ppid: process.ppid,
      ...event,
    };
    let line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      line = `${JSON.stringify({
        ts_ms: payload.ts_ms,
        pid: payload.pid,
        ppid: payload.ppid,
        server: payload.server,
        entrypoint: payload.entrypoint,
        event: payload.event,
        reason: payload.reason,
        truncated: true,
      })}\n`;
    }
    appendFileSync(file, line, { encoding: 'utf8', flag: 'a' });
  } catch {
    // Lifecycle telemetry must never affect MCP stdio behavior.
  }
}
