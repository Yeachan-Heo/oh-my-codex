import { collectSidecarSnapshot } from './collector.js';
import { renderSidecar } from './render.js';
import { launchSidecarTmuxPane } from './tmux.js';
import type { CollectSidecarSnapshotOptions, SidecarFlags, SidecarSnapshot } from './types.js';

export const SIDECAR_USAGE = [
  'Usage:',
  '  omx sidecar <team-name>              Render sidecar once',
  '  omx sidecar <team-name> --json       Output normalized sidecar snapshot',
  '  omx sidecar <team-name> --watch      Refresh sidecar in the current terminal',
  '  omx sidecar <team-name> --tmux       Open a right-side tmux pane running watch mode',
  'Options:',
  '  --width <cols> / --width=<cols>      Sidecar width (default 48, minimum 30)',
  '  --interval-ms <ms>                   Watch refresh interval (default 1000)',
].join('\n');

interface ParsedSidecarArgs {
  teamName: string;
  flags: SidecarFlags;
}

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseSidecarArgs(args: string[]): ParsedSidecarArgs {
  const flags: SidecarFlags = { json: false, watch: false, tmux: false };
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') flags.json = true;
    else if (arg === '--watch' || arg === '-w') flags.watch = true;
    else if (arg === '--tmux') flags.tmux = true;
    else if (arg === '--width') {
      flags.width = parsePositiveInt(args[index + 1], 48);
      index += 1;
    } else if (arg.startsWith('--width=')) {
      flags.width = parsePositiveInt(arg.slice('--width='.length), 48);
    } else if (arg === '--interval-ms') {
      flags.intervalMs = parsePositiveInt(args[index + 1], 1000);
      index += 1;
    } else if (arg.startsWith('--interval-ms=')) {
      flags.intervalMs = parsePositiveInt(arg.slice('--interval-ms='.length), 1000);
    } else {
      rest.push(arg);
    }
  }
  return { teamName: rest[0] || '', flags };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export interface RunSidecarWatchDeps {
  collect: (teamName: string, options: CollectSidecarSnapshotOptions) => Promise<SidecarSnapshot | null>;
  render: (snapshot: SidecarSnapshot, options: { width?: number; height?: number }) => string;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  sleep: SleepFn;
  registerSigint: (handler: () => void) => void;
  stdoutColumns?: () => number | undefined;
  stdoutRows?: () => number | undefined;
}

export async function runSidecarWatch(
  teamName: string,
  flags: SidecarFlags,
  options: CollectSidecarSnapshotOptions = {},
  deps: Partial<RunSidecarWatchDeps> = {},
): Promise<void> {
  const dependencies: RunSidecarWatchDeps = {
    collect: deps.collect ?? collectSidecarSnapshot,
    render: deps.render ?? renderSidecar,
    writeStdout: deps.writeStdout ?? ((text) => process.stdout.write(text)),
    writeStderr: deps.writeStderr ?? ((text) => process.stderr.write(text)),
    sleep: deps.sleep ?? defaultSleep,
    registerSigint: deps.registerSigint ?? ((handler) => process.on('SIGINT', handler)),
    stdoutColumns: deps.stdoutColumns ?? (() => process.stdout.columns),
    stdoutRows: deps.stdoutRows ?? (() => process.stdout.rows),
  };
  const intervalMs = Math.max(100, flags.intervalMs ?? 1000);
  const abortController = new AbortController();
  let firstRender = true;
  let inFlight = false;
  let queued = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abortController.abort();
    dependencies.writeStdout('\x1b[?25h');
  };
  dependencies.registerSigint(stop);
  dependencies.writeStdout('\x1b[?25l');

  const renderTick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      const snapshot = await dependencies.collect(teamName, options);
      const output = snapshot
        ? dependencies.render(snapshot, { width: flags.width ?? dependencies.stdoutColumns?.(), height: dependencies.stdoutRows?.() })
        : `No team state found for ${teamName}`;
      dependencies.writeStdout(firstRender ? '\x1b[2J\x1b[H' : '\x1b[H');
      firstRender = false;
      dependencies.writeStdout(`${output}\x1b[J`);
    } catch (error) {
      dependencies.writeStderr(`Sidecar watch render failed: ${error instanceof Error ? error.message : String(error)}\n`);
      stop();
    } finally {
      inFlight = false;
    }
    if (queued) {
      queued = false;
      await renderTick();
    }
  };

  while (!stopped && !abortController.signal.aborted) {
    const started = Date.now();
    await renderTick();
    if (stopped || abortController.signal.aborted) break;
    await dependencies.sleep(Math.max(0, intervalMs - (Date.now() - started)), abortController.signal);
  }
  dependencies.writeStdout('\x1b[?25h');
}

export async function sidecarCommand(args: string[]): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h' || args.length === 0) {
    console.log(SIDECAR_USAGE);
    return;
  }
  const { teamName, flags } = parseSidecarArgs(args);
  if (!teamName) throw new Error(SIDECAR_USAGE);
  const cwd = process.cwd();

  if (flags.tmux) {
    if (!process.env.TMUX) {
      console.error('Not inside a tmux session. Start tmux first, then run: omx sidecar <team-name> --tmux');
      process.exitCode = 1;
      return;
    }
    const paneId = launchSidecarTmuxPane({ cwd, teamName, width: flags.width, sessionId: process.env.OMX_SESSION_ID });
    if (!paneId) {
      console.error('Failed to create sidecar tmux pane. Ensure tmux is available.');
      process.exitCode = 1;
      return;
    }
    console.log(`Sidecar launched in right tmux pane ${paneId}.`);
    return;
  }

  if (flags.watch) {
    await runSidecarWatch(teamName, flags, { cwd });
    return;
  }

  const snapshot = await collectSidecarSnapshot(teamName, { cwd });
  if (flags.json) {
    console.log(JSON.stringify(snapshot ?? { status: 'missing', team_name: teamName }, null, 2));
    return;
  }
  if (!snapshot) {
    console.log(`No team state found for ${teamName}`);
    return;
  }
  console.log(renderSidecar(snapshot, { width: flags.width ?? process.stdout.columns }));
}
