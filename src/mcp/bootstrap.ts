import { execFileSync } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveOmxFirstPartyMcpEntrypointForPluginTarget } from '../config/omx-first-party-mcp.js';
import {
  appendPretrafficEvent,
  emit as emitLifecycleEvent,
  flush as flushLifecycleEvents,
  readPretrafficSiblingPids,
} from './lifecycle-telemetry.js';

export type McpServerName = 'state' | 'memory' | 'code_intel' | 'trace' | 'wiki';

const SERVER_DISABLE_ENV: Record<McpServerName, string> = {
  state: 'OMX_STATE_SERVER_DISABLE_AUTO_START',
  memory: 'OMX_MEMORY_SERVER_DISABLE_AUTO_START',
  code_intel: 'OMX_CODE_INTEL_SERVER_DISABLE_AUTO_START',
  trace: 'OMX_TRACE_SERVER_DISABLE_AUTO_START',
  wiki: 'OMX_WIKI_SERVER_DISABLE_AUTO_START',
};

const GLOBAL_DISABLE_ENV = 'OMX_MCP_SERVER_DISABLE_AUTO_START';
const LIFECYCLE_DEBUG_ENV = 'OMX_MCP_TRANSPORT_DEBUG';
const PARENT_WATCHDOG_INTERVAL_ENV = 'OMX_MCP_PARENT_WATCHDOG_INTERVAL_MS';
const DUPLICATE_SIBLING_WATCHDOG_INTERVAL_ENV = 'OMX_MCP_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS';
const DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_ENV = 'OMX_MCP_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS';
const DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_ENV = 'OMX_MCP_DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_MS';
const DUPLICATE_SIBLING_INITIAL_DELAY_ENV = 'OMX_MCP_DUPLICATE_SIBLING_INITIAL_DELAY_MS';
const DUPLICATE_SIBLING_INITIAL_DELAY_MAX_ENV = 'OMX_MCP_DUPLICATE_SIBLING_INITIAL_DELAY_MAX_MS';
const MAX_SIBLINGS_PER_ENTRYPOINT_ENV = 'OMX_MCP_MAX_SIBLINGS_PER_ENTRYPOINT';
const DUPLICATE_SIBLING_BACKOFF_INTERVAL_ENV = 'OMX_MCP_DUPLICATE_SIBLING_BACKOFF_INTERVAL_MS';
export const MCP_ENTRYPOINT_MARKER_ENV = 'OMX_MCP_ENTRYPOINT_MARKER';
const DEFAULT_PARENT_WATCHDOG_INTERVAL_MS = 1_000;
const DEFAULT_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS = 5_000;
const DEFAULT_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS = 2_000;
const DEFAULT_DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_MS = 60_000;
const DEFAULT_DUPLICATE_SIBLING_INITIAL_DELAY_MAX_MS = 1_000;
const DEFAULT_MAX_SIBLINGS_PER_ENTRYPOINT = 4;
const DEFAULT_DUPLICATE_SIBLING_BACKOFF_INTERVAL_MS = 30_000;
const MCP_ENTRYPOINT_PATTERN = /\b([a-z0-9-]+-server\.(?:[cm]?js|ts))\b/i;
const MCP_SERVE_TARGET_PATTERN = /(?:^|\s)mcp-serve\s+([^\s]+)/i;

interface StdioLifecycleServer {
  connect(transport: StdioServerTransport): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  command: string;
}

export interface DuplicateSiblingObservation {
  status: 'ambiguous' | 'unique' | 'newest' | 'older_duplicate';
  entrypoint: string | null;
  matchingPids: number[];
  newerSiblingPids: number[];
}

interface LifecycleTimingConfig {
  parentWatchdogIntervalMs: number;
  duplicateSiblingWatchdogIntervalMs: number;
  duplicateSiblingPreTrafficGraceMs: number;
  duplicateSiblingPostTrafficIdleMs: number;
  duplicateSiblingInitialDelayMs: number | null;
  duplicateSiblingInitialDelayMaxMs: number;
  duplicateSiblingBackoffIntervalMs: number;
  maxSiblingsPerEntrypoint: number;
}

function normalizeCommand(command: string): string {
  return command.replace(/\\+/g, '/').trim();
}

export function extractMcpEntrypointMarker(command: string): string | null {
  const normalizedCommand = normalizeCommand(command);
  const entrypointMatch = normalizedCommand.match(MCP_ENTRYPOINT_PATTERN);
  if (entrypointMatch?.[1]) return entrypointMatch[1].toLowerCase();

  const mcpServeMatch = normalizedCommand.match(MCP_SERVE_TARGET_PATTERN);
  return resolveOmxFirstPartyMcpEntrypointForPluginTarget(mcpServeMatch?.[1]);
}

export function resolveCurrentMcpEntrypointMarker(
  env: Record<string, string | undefined> = process.env,
  argv1: string | undefined = process.argv[1],
): string | null {
  const explicitMarker = extractMcpEntrypointMarker(
    env[MCP_ENTRYPOINT_MARKER_ENV] ?? '',
  );
  if (explicitMarker) return explicitMarker;
  return extractMcpEntrypointMarker(argv1 ?? '');
}

export function parseProcessTable(output: string): ProcessTableEntry[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return null;
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      const command = match[3]?.trim();
      if (!Number.isInteger(pid) || pid <= 0) return null;
      if (!Number.isInteger(ppid) || ppid < 0) return null;
      if (!command) return null;
      return { pid, ppid, command } satisfies ProcessTableEntry;
    })
    .filter((entry): entry is ProcessTableEntry => entry !== null);
}

export function listProcessTable(
  readPs: typeof execFileSync = execFileSync,
): ProcessTableEntry[] | null {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const output = readPs('ps', ['axww', '-o', 'pid=,ppid=,command='], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    return parseProcessTable(output);
  } catch {
    return null;
  }
}

export function analyzeDuplicateSiblingState(
  processes: readonly ProcessTableEntry[],
  currentPid: number,
  currentParentPid: number,
  currentEntrypoint: string | null,
): DuplicateSiblingObservation {
  if (!currentEntrypoint || !Number.isInteger(currentPid) || currentPid <= 0) {
    return {
      status: 'ambiguous',
      entrypoint: currentEntrypoint,
      matchingPids: [],
      newerSiblingPids: [],
    };
  }

  const self = processes.find((entry) => entry.pid === currentPid);
  if (!self || self.ppid !== currentParentPid) {
    return {
      status: 'ambiguous',
      entrypoint: currentEntrypoint,
      matchingPids: [],
      newerSiblingPids: [],
    };
  }

  const selfMarker = extractMcpEntrypointMarker(self.command);
  if (selfMarker !== currentEntrypoint) {
    return {
      status: 'ambiguous',
      entrypoint: currentEntrypoint,
      matchingPids: [],
      newerSiblingPids: [],
    };
  }

  const matching = processes
    .filter((entry) => entry.ppid === currentParentPid)
    .filter((entry) => extractMcpEntrypointMarker(entry.command) === currentEntrypoint)
    .sort((left, right) => left.pid - right.pid);

  if (!matching.some((entry) => entry.pid === currentPid)) {
    return {
      status: 'ambiguous',
      entrypoint: currentEntrypoint,
      matchingPids: matching.map((entry) => entry.pid),
      newerSiblingPids: [],
    };
  }

  if (matching.length <= 1) {
    return {
      status: 'unique',
      entrypoint: currentEntrypoint,
      matchingPids: matching.map((entry) => entry.pid),
      newerSiblingPids: [],
    };
  }

  const newerSiblingPids = matching
    .filter((entry) => entry.pid > currentPid)
    .map((entry) => entry.pid);

  return {
    status: newerSiblingPids.length > 0 ? 'older_duplicate' : 'newest',
    entrypoint: currentEntrypoint,
    matchingPids: matching.map((entry) => entry.pid),
    newerSiblingPids,
  };
}

function readNonNegativeIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number | null,
): number | null {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPositiveIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveLifecycleTimingConfig(
  env: Record<string, string | undefined>,
): LifecycleTimingConfig {
  return {
    parentWatchdogIntervalMs: readPositiveIntegerEnv(
      env,
      PARENT_WATCHDOG_INTERVAL_ENV,
      DEFAULT_PARENT_WATCHDOG_INTERVAL_MS,
    ),
    duplicateSiblingWatchdogIntervalMs: readPositiveIntegerEnv(
      env,
      DUPLICATE_SIBLING_WATCHDOG_INTERVAL_ENV,
      DEFAULT_DUPLICATE_SIBLING_WATCHDOG_INTERVAL_MS,
    ),
    duplicateSiblingPreTrafficGraceMs: readPositiveIntegerEnv(
      env,
      DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_ENV,
      DEFAULT_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS,
    ),
    duplicateSiblingPostTrafficIdleMs: readPositiveIntegerEnv(
      env,
      DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_ENV,
      DEFAULT_DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_MS,
    ),
    duplicateSiblingInitialDelayMs: readNonNegativeIntegerEnv(
      env,
      DUPLICATE_SIBLING_INITIAL_DELAY_ENV,
      null,
    ),
    duplicateSiblingInitialDelayMaxMs: readPositiveIntegerEnv(
      env,
      DUPLICATE_SIBLING_INITIAL_DELAY_MAX_ENV,
      DEFAULT_DUPLICATE_SIBLING_INITIAL_DELAY_MAX_MS,
    ),
    duplicateSiblingBackoffIntervalMs: readPositiveIntegerEnv(
      env,
      DUPLICATE_SIBLING_BACKOFF_INTERVAL_ENV,
      DEFAULT_DUPLICATE_SIBLING_BACKOFF_INTERVAL_MS,
    ),
    maxSiblingsPerEntrypoint: readNonNegativeIntegerEnv(
      env,
      MAX_SIBLINGS_PER_ENTRYPOINT_ENV,
      DEFAULT_MAX_SIBLINGS_PER_ENTRYPOINT,
    ) ?? DEFAULT_MAX_SIBLINGS_PER_ENTRYPOINT,
  };
}

export function shouldSelfExitForHardCap(
  observation: DuplicateSiblingObservation,
  pretrafficSiblingPids: ReadonlyArray<number>,
  maxSiblings: number,
  currentPid: number,
): boolean {
  if (!Number.isInteger(maxSiblings) || maxSiblings <= 0) return false;
  if (!pretrafficSiblingPids.includes(currentPid)) return false;
  if (observation.matchingPids.length <= maxSiblings) return false;
  // Only pre-traffic siblings are killable. Cap the exit count so we never
  // try to evict more victims than we have.
  const exitCount = Math.min(
    observation.matchingPids.length - maxSiblings,
    pretrafficSiblingPids.length,
  );
  if (exitCount <= 0) return false;
  const sorted = [...pretrafficSiblingPids].sort((a, b) => a - b);
  const idx = sorted.indexOf(currentPid);
  if (idx === -1) return false;
  return idx < exitCount;
}

export function shouldBackoffWatchdog(
  observation: DuplicateSiblingObservation,
  maxSiblings: number,
): boolean {
  if (!Number.isInteger(maxSiblings) || maxSiblings <= 0) return false;
  return observation.matchingPids.length > maxSiblings;
}

// The hard cap can only fire when the entrypoint exceeds its configured maximum,
// so steady-state ticks with cap >= count must skip the pretraffic ledger read
// entirely — otherwise every tracked MCP child pays disk I/O on every poll for a
// branch that cannot evict anyone.
export function shouldEvaluateHardCap(
  matchingPids: ReadonlyArray<number>,
  maxSiblings: number,
): boolean {
  if (!Number.isInteger(maxSiblings) || maxSiblings <= 0) return false;
  return matchingPids.length > maxSiblings;
}

// The in-memory `lastTrafficAtMs` on this process is authoritative for self even when
// the corresponding `traffic` ledger append has not flushed to disk yet. Without this
// override, the ledger's last-known event for self is still 'start', and the cap could
// evict a transport that has already been claimed by the client.
export function effectivePretrafficSiblings(
  pretrafficSiblingPids: ReadonlyArray<number>,
  selfPid: number,
  selfLastTrafficAtMs: number | null,
): number[] {
  if (selfLastTrafficAtMs === null) return [...pretrafficSiblingPids];
  return pretrafficSiblingPids.filter((pid) => pid !== selfPid);
}

function stableStringHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash * 31) + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function resolveDuplicateSiblingWatchdogInitialDelayMs(
  serverName: McpServerName,
  entrypoint: string | null,
  config: Pick<LifecycleTimingConfig, 'duplicateSiblingInitialDelayMs' | 'duplicateSiblingInitialDelayMaxMs'>,
): number {
  if (typeof config.duplicateSiblingInitialDelayMs === 'number') {
    return Math.max(0, config.duplicateSiblingInitialDelayMs);
  }

  const maxMs = Math.max(0, config.duplicateSiblingInitialDelayMaxMs);
  if (maxMs <= 0) return 0;
  return stableStringHash(`${serverName}:${entrypoint ?? 'unknown'}`) % (maxMs + 1);
}

export function shouldSelfExitForDuplicateSibling(
  observation: DuplicateSiblingObservation,
  nowMs: number,
  duplicateObservedAtMs: number | null,
  lastTrafficAtMs: number | null,
  preTrafficGraceMs = DEFAULT_DUPLICATE_SIBLING_PRE_TRAFFIC_GRACE_MS,
  postTrafficIdleMs = DEFAULT_DUPLICATE_SIBLING_POST_TRAFFIC_IDLE_MS,
): boolean {
  if (observation.status !== 'older_duplicate') {
    return false;
  }
  if (!Number.isFinite(nowMs) || duplicateObservedAtMs === null || duplicateObservedAtMs > nowMs) {
    return false;
  }

  if (lastTrafficAtMs !== null && (!Number.isFinite(lastTrafficAtMs) || lastTrafficAtMs > nowMs)) {
    return false;
  }

  if (lastTrafficAtMs !== null) {
    // Stdio traffic means a client initialized or otherwise owned this transport.
    // Keep that protection, but do not make it permanent: Codex.app can reuse a
    // long-lived parent across sessions, leaving initialized older siblings alive
    // after a newer server for the same first-party entrypoint has taken over.
    // Require a conservative idle window after both the duplicate observation and
    // the most recent traffic before self-exiting.
    const idleSinceMs = Math.max(duplicateObservedAtMs, lastTrafficAtMs);
    return nowMs - idleSinceMs >= postTrafficIdleMs;
  }

  return nowMs - duplicateObservedAtMs >= preTrafficGraceMs;
}

export function isParentProcessAlive(
  parentPid: number,
  signalProcess: typeof process.kill = process.kill,
): boolean {
  if (!Number.isInteger(parentPid) || parentPid <= 1) {
    return false;
  }

  try {
    signalProcess(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

export function shouldAutoStartMcpServer(
  server: McpServerName,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const globalDisabled = env[GLOBAL_DISABLE_ENV] === '1';
  const serverDisabled = env[SERVER_DISABLE_ENV[server]] === '1';
  return !globalDisabled && !serverDisabled;
}

export function autoStartStdioMcpServer(
  serverName: McpServerName,
  server: StdioLifecycleServer,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!shouldAutoStartMcpServer(serverName, env)) {
    return;
  }

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const lifecycleDebugEnabled = env[LIFECYCLE_DEBUG_ENV] === '1';
  const lifecycleTiming = resolveLifecycleTimingConfig(env);
  const trackedParentPid = Number.isInteger(process.ppid) ? process.ppid : 0;
  const trackedEntrypoint = resolveCurrentMcpEntrypointMarker(
    env,
    process.argv[1] ?? '',
  );
  let lastTrafficAtMs: number | null = null;
  let duplicateObservedAtMs: number | null = null;

  const telemetryEntrypoint = trackedEntrypoint
    ? trackedEntrypoint.replace(/\.[cm]?[jt]s$/i, '')
    : `${serverName}-server`;
  const emitEvent = (event: string, payload: Record<string, unknown> = {}) =>
    emitLifecycleEvent(
      event,
      { serverName, ...payload },
      { entrypoint: telemetryEntrypoint, env },
    );

  emitEvent('startup', {
    argv1: process.argv[1] ?? null,
    marker: trackedEntrypoint,
    parentPid: trackedParentPid,
    maxSiblingsPerEntrypoint: lifecycleTiming.maxSiblingsPerEntrypoint,
  });
  if (!trackedEntrypoint) {
    emitEvent('marker_resolution_failed', {
      argv0: process.argv[0] ?? null,
      argv1: process.argv[1] ?? null,
      argv2: process.argv[2] ?? null,
      markerEnv: env[MCP_ENTRYPOINT_MARKER_ENV] ?? null,
    });
  }
  void appendPretrafficEvent('start', { entrypoint: telemetryEntrypoint, env });
  let recordedTraffic = false;

  const logLifecycle = (message: string, error?: unknown) => {
    if (!lifecycleDebugEnabled) return;
    const detail = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
    process.stderr.write(`[omx-${serverName}-server] ${message}${detail}\n`);
  };

  const parentWatchdog = trackedParentPid > 1
    ? setInterval(() => {
      if (!isParentProcessAlive(trackedParentPid)) {
        void shutdown('parent_gone');
      }
    }, lifecycleTiming.parentWatchdogIntervalMs)
    : null;
  parentWatchdog?.unref();
  let duplicateSiblingWatchdog: ReturnType<typeof setInterval> | null = null;
  let duplicateSiblingInitialDelayTimer: ReturnType<typeof setTimeout> | null = null;

  let watchdogBackedOff = false;

  const applyBackoff = () => {
    if (watchdogBackedOff) return;
    if (!duplicateSiblingWatchdog) return;
    clearInterval(duplicateSiblingWatchdog);
    duplicateSiblingWatchdog = setInterval(
      runDuplicateSiblingWatchdog,
      lifecycleTiming.duplicateSiblingBackoffIntervalMs,
    );
    duplicateSiblingWatchdog.unref();
    watchdogBackedOff = true;
    emitEvent('duplicate_watchdog_backoff', {
      newIntervalMs: lifecycleTiming.duplicateSiblingBackoffIntervalMs,
    });
  };

  const runDuplicateSiblingWatchdog = async () => {
    try {
      const processes = listProcessTable();
      if (!processes) {
        duplicateObservedAtMs = null;
        return;
      }

      const observation = analyzeDuplicateSiblingState(
        processes,
        process.pid,
        trackedParentPid,
        trackedEntrypoint,
      );

      if (observation.status !== 'unique') {
        emitEvent('duplicate_observation', {
          status: observation.status,
          matchingPids: observation.matchingPids,
          newerSiblingPids: observation.newerSiblingPids,
          lastTrafficAtMs,
        });
      }

      if (shouldBackoffWatchdog(observation, lifecycleTiming.maxSiblingsPerEntrypoint)) {
        applyBackoff();
      }

      if (shouldEvaluateHardCap(observation.matchingPids, lifecycleTiming.maxSiblingsPerEntrypoint)) {
        const pretrafficSiblingPids = await readPretrafficSiblingPids(
          observation.matchingPids,
          { entrypoint: telemetryEntrypoint, env },
        );
        const effectivePretraffic = effectivePretrafficSiblings(
          pretrafficSiblingPids,
          process.pid,
          lastTrafficAtMs,
        );
        if (
          shouldSelfExitForHardCap(
            observation,
            effectivePretraffic,
            lifecycleTiming.maxSiblingsPerEntrypoint,
            process.pid,
          )
        ) {
          void shutdown('superseded_hard_cap_pre_traffic');
          return;
        }
      }

      if (observation.status !== 'older_duplicate') {
        duplicateObservedAtMs = null;
        return;
      }

      duplicateObservedAtMs ??= Date.now();
      if (!shouldSelfExitForDuplicateSibling(
        observation,
        Date.now(),
        duplicateObservedAtMs,
        lastTrafficAtMs,
        lifecycleTiming.duplicateSiblingPreTrafficGraceMs,
        lifecycleTiming.duplicateSiblingPostTrafficIdleMs,
      )) {
        return;
      }

      void shutdown(
        lastTrafficAtMs !== null && lastTrafficAtMs > duplicateObservedAtMs
          ? 'superseded_duplicate_after_idle'
          : 'superseded_duplicate_before_traffic',
      );
    } catch (error) {
      emitEvent('duplicate_watchdog_error', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack ?? null : null,
      });
    }
  };

  if (trackedParentPid > 1 && trackedEntrypoint) {
    const initialDelayMs = resolveDuplicateSiblingWatchdogInitialDelayMs(
      serverName,
      trackedEntrypoint,
      lifecycleTiming,
    );
    duplicateSiblingInitialDelayTimer = setTimeout(() => {
      duplicateSiblingInitialDelayTimer = null;
      runDuplicateSiblingWatchdog();
      duplicateSiblingWatchdog = setInterval(
        runDuplicateSiblingWatchdog,
        lifecycleTiming.duplicateSiblingWatchdogIntervalMs,
      );
      duplicateSiblingWatchdog.unref();
    }, initialDelayMs);
    duplicateSiblingInitialDelayTimer.unref();
  }

  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    emitEvent('shutdown_reason', { reason });
    logLifecycle(`transport shutdown: ${reason}`);
    if (parentWatchdog) {
      clearInterval(parentWatchdog);
    }
    if (duplicateSiblingInitialDelayTimer) {
      clearTimeout(duplicateSiblingInitialDelayTimer);
    }
    if (duplicateSiblingWatchdog) {
      clearInterval(duplicateSiblingWatchdog);
    }
    process.stdin.off('data', handleStdinData);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);

    try {
      await server.close();
    } catch (error) {
      console.error(`[omx-${serverName}-server] shutdown failed`, error);
    }

    void appendPretrafficEvent('exit', { entrypoint: telemetryEntrypoint, env });
    logLifecycle('transport shutdown: exit');
    await flushLifecycleEvents().catch(() => {});
    process.exit(0);
  };

  const handleStdinEnd = () => {
    void shutdown('stdin_end');
  };
  const handleStdinClose = () => {
    void shutdown('stdin_close');
  };
  const handleStdinData = () => {
    lastTrafficAtMs = Date.now();
    if (!recordedTraffic) {
      recordedTraffic = true;
      void appendPretrafficEvent('traffic', { entrypoint: telemetryEntrypoint, env });
    }
  };
  const handleSigterm = () => {
    void shutdown('sigterm');
  };
  const handleSigint = () => {
    void shutdown('sigint');
  };

  process.stdin.on('data', handleStdinData);
  process.stdin.once('end', handleStdinEnd);
  process.stdin.once('close', handleStdinClose);
  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);

  // Funnel transport/client disconnects through the same idempotent shutdown path.
  transport.onclose = () => {
    void shutdown('transport_close');
  };

  server.connect(transport).catch((error) => {
    logLifecycle('server.connect failed', error);
    emitEvent('server_connect_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.stdin.off('data', handleStdinData);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    console.error(error);
  });
}
