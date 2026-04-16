import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  createDuplicateCoordinator,
  type DuplicateCoordinator,
} from './duplicate-coordination.js';

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
const PARENT_WATCHDOG_INTERVAL_MS = 25;

interface StdioLifecycleServer {
  connect(transport: StdioServerTransport): Promise<unknown>;
  close(): Promise<unknown>;
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
  let duplicateCoordinator: DuplicateCoordinator | null = null;
  const lifecycleDebugEnabled = env[LIFECYCLE_DEBUG_ENV] === '1';
  const trackedParentPid = Number.isInteger(process.ppid) ? process.ppid : 0;

  const logLifecycle = (message: string, error?: unknown) => {
    if (!lifecycleDebugEnabled) return;
    const detail = error ? ` ${error instanceof Error ? error.message : String(error)}` : '';
    process.stderr.write(`[omx-${serverName}-server] ${message}${detail}\n`);
  };

  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logLifecycle(`transport shutdown: ${reason}`);
    if (parentWatchdog) {
      clearInterval(parentWatchdog);
    }
    process.stdin.off('data', handleFirstTraffic);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);

    try {
      await duplicateCoordinator?.dispose();
    } catch (error) {
      logLifecycle('duplicate coordination dispose failed', error);
    }

    try {
      await server.close();
    } catch (error) {
      console.error(`[omx-${serverName}-server] shutdown failed`, error);
    }

    logLifecycle('transport shutdown: exit');
    process.exit(0);
  };

  const parentWatchdog = trackedParentPid > 1
    ? setInterval(() => {
      if (!isParentProcessAlive(trackedParentPid)) {
        void shutdown('parent_gone');
      }
    }, PARENT_WATCHDOG_INTERVAL_MS)
    : null;
  parentWatchdog?.unref();

  const duplicateCoordinatorPromise = createDuplicateCoordinator({
    parentPid: trackedParentPid,
    selfPid: process.pid,
    serverName,
    lifecycleDebugEnabled,
    shutdown,
  }).then(async (coordinator) => {
    if (shuttingDown) {
      await coordinator.dispose();
      return coordinator;
    }
    duplicateCoordinator = coordinator;
    return coordinator;
  }).catch((error) => {
    logLifecycle('duplicate coordination setup failed', error);
    return null;
  });

  const handleStdinEnd = () => {
    void shutdown('stdin_end');
  };
  const handleStdinClose = () => {
    void shutdown('stdin_close');
  };
  const handleFirstTraffic = () => {
    // Duplicate reconciliation must stay off the message hot path. We only react to the
    // first stdin chunk, then hand coordination off to a one-shot owner claim.
    void duplicateCoordinatorPromise
      .then((coordinator) => coordinator?.markFirstTraffic())
      .catch((error) => {
        logLifecycle('duplicate coordination first-traffic hook failed', error);
      });
  };
  const handleSigterm = () => {
    void shutdown('sigterm');
  };
  const handleSigint = () => {
    void shutdown('sigint');
  };

  process.stdin.once('data', handleFirstTraffic);
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
    process.stdin.off('data', handleFirstTraffic);
    process.stdin.off('end', handleStdinEnd);
    process.stdin.off('close', handleStdinClose);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGINT', handleSigint);
    console.error(error);
  });
}
