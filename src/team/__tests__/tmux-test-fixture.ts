import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const TMUX_COMMAND_TIMEOUT_MS = 5_000;
const NULL_TMUX_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null';

interface TmuxEnvSnapshot {
  TMUX?: string;
  TMUX_PANE?: string;
}

export interface TempTmuxSessionFixture {
  sessionName: string;
  serverName: string;
  windowTarget: string;
  leaderPaneId: string;
  socketPath: string;
  serverKind: 'ambient' | 'synthetic';
  env: {
    TMUX: string;
    TMUX_PANE: string;
  };
  sessionExists: (targetSessionName?: string) => boolean;
  run: (args: string[]) => string;
  runResult: (args: string[]) => { status: number | null; stdout: string; stderr: string; error: string };
  runPtyResult: (command: string) => { status: number | null; stdout: string; stderr: string; error: string };
  createPathShim: (directory: string, commandLogPath?: string) => Promise<string>;
  triggerClientResize: (
    targetSession: string,
    geometry?: { rows?: number; cols?: number },
  ) => void;
  serverLogPath: string | null;
  readServerLog: () => Promise<string>;
}

export interface TempTmuxSessionOptions {
  useAmbientServer?: boolean;
  serverLog?: boolean;
}

function snapshotTmuxEnv(source: NodeJS.ProcessEnv = process.env): TmuxEnvSnapshot {
  return {
    TMUX: typeof source.TMUX === 'string' ? source.TMUX : undefined,
    TMUX_PANE: typeof source.TMUX_PANE === 'string' ? source.TMUX_PANE : undefined,
  };
}

function applyTmuxEnv(snapshot: TmuxEnvSnapshot): void {
  if (typeof snapshot.TMUX === 'string') process.env.TMUX = snapshot.TMUX;
  else delete process.env.TMUX;

  if (typeof snapshot.TMUX_PANE === 'string') process.env.TMUX_PANE = snapshot.TMUX_PANE;
  else delete process.env.TMUX_PANE;
}

function runTmuxResult(
  args: string[],
  options: {
    ignoreTmuxEnv?: boolean;
    env?: NodeJS.ProcessEnv;
    serverName?: string;
    configFile?: string;
    verbose?: boolean;
    cwd?: string;
  } = {},
): { status: number | null; stdout: string; stderr: string; error: string } {
  const env = options.env
    ?? (options.ignoreTmuxEnv ? { ...process.env, TMUX: undefined, TMUX_PANE: undefined } : process.env);
  const argv = [
    ...(options.configFile ? ['-f', options.configFile] : []),
    ...(options.serverName ? ['-L', options.serverName] : []),
    ...(options.verbose ? ['-vv'] : []),
    ...args,
  ];
  const result = spawnSync('tmux', argv, {
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    cwd: options.cwd,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || '',
  };
}

function runTmux(
  args: string[],
  options: {
    ignoreTmuxEnv?: boolean;
    env?: NodeJS.ProcessEnv;
    serverName?: string;
    configFile?: string;
    verbose?: boolean;
    cwd?: string;
  } = {},
): string {
  const result = runTmuxResult(args, options);
  if (result.error) {
    throw new Error(result.error);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `tmux exited ${result.status}`);
  }
  return result.stdout.trim();
}

export function isRealTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], {
    encoding: 'utf-8',
    env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `tmux exited ${result.status}`);
  }
  return true;
}

/**
 * Test-only PTY invocation for GNU/util-linux `script(1)` vs. BSD/macOS `script(1)`.
 *
 * util-linux (Linux) accepts `-c command` and always requires a trailing log-file
 * argument: `script -q -e -c <command> /dev/null`.
 *
 * BSD/macOS `script(1)` (shell_cmds) has no `-c` flag; the command is a trailing
 * positional argument vector after the log file: `script [file [command ...]]`.
 * Verified against Apple's shell_cmds script.1 source (apple-oss-distributions/shell_cmds):
 * "-e: Accepted for compatibility with util-linux script. The child command exit
 * status is always the exit status of script." — i.e. on BSD/macOS, `script`
 * unconditionally propagates the child's exit status even without `-e`, so `-e`
 * is redundant there and intentionally omitted. The command is passed as a single
 * `/bin/sh -c <command>` argv triple (not a shell string) to keep the wrapped
 * command as exactly one argument, matching the util-linux `-c` contract.
 */
export interface PtyScriptCommand {
  executable: string;
  args: string[];
}

export function buildPtyScriptCommand(command: string, platform: NodeJS.Platform = process.platform): PtyScriptCommand {
  if (platform === 'darwin') {
    return { executable: 'script', args: ['-q', '/dev/null', '/bin/sh', '-c', command] };
  }
  return { executable: 'script', args: ['-q', '-e', '-c', command, '/dev/null'] };
}

export function isRealScriptAvailable(): boolean {
  const result = spawnSync('/bin/sh', ['-c', 'command -v script'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TMUX_COMMAND_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw result.error;
  }
  return result.status === 0;
}

export function tmuxSessionExists(sessionName: string, serverName?: string): boolean {
  try {
    runTmux(['has-session', '-t', sessionName], {
      ignoreTmuxEnv: true,
      serverName,
    });
    return true;
  } catch {
    return false;
  }
}

function resolveTmuxExecutable(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory || '.', 'tmux');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('tmux executable disappeared after availability probe');
}

function uniqueTmuxIdentifier(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function withTempTmuxSession<T>(
  optionsOrFn: TempTmuxSessionOptions | ((fixture: TempTmuxSessionFixture) => Promise<T> | T),
  maybeFn?: (fixture: TempTmuxSessionFixture) => Promise<T> | T,
): Promise<T> {
  if (!isRealTmuxAvailable()) {
    throw new Error('tmux is not available');
  }

  const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (!fn) {
    throw new Error('withTempTmuxSession requires a callback');
  }

  if (options.serverLog && options.useAmbientServer) {
    throw new Error('server logging requires a private synthetic tmux server');
  }

  const previousEnv = snapshotTmuxEnv(process.env);
  const fixtureCwd = await mkdtemp(join(tmpdir(), 'omx-tmux-fixture-'));
  const sessionName = uniqueTmuxIdentifier('omx-test');
  const serverName = options.useAmbientServer ? '' : uniqueTmuxIdentifier('omx-fixture');
  const serverKind: TempTmuxSessionFixture['serverKind'] = options.useAmbientServer ? 'ambient' : 'synthetic';
  const tmuxOptions = {
    ignoreTmuxEnv: true,
    serverName: serverName || undefined,
    configFile: serverKind === 'synthetic' ? NULL_TMUX_CONFIG : undefined,
  } as const;
  const tmuxExecutable = resolveTmuxExecutable();
  const createPathShim = async (directory: string, commandLogPath?: string): Promise<string> => {
    if (serverKind !== 'synthetic') throw new Error('private tmux PATH shim requires a synthetic server');
    const shimPath = join(directory, 'tmux');
    const logCommand = commandLogPath ? `printf '%s\\n' 'tmux argv:' >> ${JSON.stringify(commandLogPath)}\nfor argument do printf '%s\\n' "$argument"; done >> ${JSON.stringify(commandLogPath)}\nprintf '%s\\n' 'end tmux argv' >> ${JSON.stringify(commandLogPath)}\n` : '';
    await writeFile(
      shimPath,
      `#!/bin/sh\n${logCommand}exec ${JSON.stringify(tmuxExecutable)} -f ${JSON.stringify(NULL_TMUX_CONFIG)} -L ${JSON.stringify(serverName)} "$@"\n`,
    );
    await chmod(shimPath, 0o755);
    runTmux(['set-environment', '-g', 'PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`], tmuxOptions);
    return shimPath;
  };
  const runPtyResult = (command: string): { status: number | null; stdout: string; stderr: string; error: string } => {
    if (process.platform !== 'darwin') {
      throw new Error('runPtyResult is only supported on Darwin');
    }
    if (serverKind !== 'synthetic') {
      throw new Error('runPtyResult requires a private synthetic tmux server');
    }
    runTmux(['set-option', '-g', 'remain-on-exit', 'on'], tmuxOptions);
    const ptyCommand = buildPtyScriptCommand(command, 'darwin');
    const paneId = runTmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      sessionName,
      ...[ptyCommand.executable, ...ptyCommand.args].map(shellQuote),
    ], tmuxOptions);
    let status: number | null = null;
    let state = '';
    for (let attempt = 0; attempt < 240; attempt += 1) {
      state = runTmux(['display-message', '-p', '-t', paneId, '#{pane_dead} #{pane_exit_status}'], tmuxOptions);
      const [dead, exitStatus] = state.split(/\s+/, 2);
      if (dead === '1') {
        status = /^-?\d+$/.test(exitStatus ?? '') ? Number(exitStatus) : null;
        break;
      }
      spawnSync('sleep', ['0.05'], { stdio: 'ignore' });
    }
    const outputResult = runTmuxResult(['capture-pane', '-p', '-t', paneId, '-S', '-'], tmuxOptions);
    const cleanupResult = runTmuxResult(['kill-pane', '-t', paneId], tmuxOptions);
    if (status === null) {
      return {
        status: null,
        stdout: outputResult.stdout,
        stderr: outputResult.stderr || cleanupResult.stderr,
        error: `PTY command did not exit: ${state}`,
      };
    }
    return {
      status,
      stdout: outputResult.stdout,
      stderr: outputResult.stderr || cleanupResult.stderr,
      error: outputResult.error || cleanupResult.error,
    };
  };
  const triggerClientResize = (
    targetSession: string,
    geometry: { rows?: number; cols?: number } = {},
  ): void => {
    const rows = geometry.rows === undefined ? 41 : geometry.rows;
    const cols = geometry.cols === undefined ? 121 : geometry.cols;
    if (!Number.isSafeInteger(rows) || rows < 4 || rows > 500) {
      throw new Error(`invalid trigger rows: ${rows}`);
    }
    if (!Number.isSafeInteger(cols) || cols < 20 || cols > 500) {
      throw new Error(`invalid trigger cols: ${cols}`);
    }
    const tmuxAttachCommand = [
      shellQuote(tmuxExecutable),
      '-f',
      shellQuote(NULL_TMUX_CONFIG),
      '-L',
      shellQuote(serverName),
      'attach-session',
      '-t',
      shellQuote(targetSession),
    ].join(' ');
    const watchdog = [
      `const { spawn } = require('node:child_process');`,
      `const child = spawn(process.argv[1], process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, TERM: 'xterm' } });`,
      `let timedOut = false; let forceKillTimer;`,
      `const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 250); }, 1000);`,
      `child.once('error', (error) => { clearTimeout(timer); clearTimeout(forceKillTimer); console.error(error.message); process.exit(127); });`,
      `child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(forceKillTimer); process.exit(timedOut ? 124 : (code ?? (signal ? 1 : 0))); });`,
    ].join('');
    const script = `(sleep 0.1; stty rows ${rows} cols ${cols}) & exec ${shellQuote(process.execPath)} -e ${shellQuote(watchdog)} -- ${tmuxAttachCommand}`;
    const ptyCommand = buildPtyScriptCommand(script);
    const result = spawnSync(ptyCommand.executable, ptyCommand.args, {
      encoding: 'utf-8',
      env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TMUX_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    if (result.error) throw result.error;
    if (result.status !== 124) {
      throw new Error(`client resize trigger result: ${JSON.stringify({ status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: '' })}`);
    }
  };


  const created = runTmux([
    'new-session',
    '-d',
    '-P',
    '-F',
    '#{session_name}:#{window_index} #{pane_id}',
    '-s',
    sessionName,
    '-c',
    fixtureCwd,
    'sleep 300',
  ], options.serverLog ? { ...tmuxOptions, verbose: true, cwd: fixtureCwd } : tmuxOptions);
  const [windowTarget = '', leaderPaneId = ''] = created.split(/\s+/, 2);
  if (windowTarget === '' || leaderPaneId === '') {
    try {
      if (serverKind === 'synthetic') {
        runTmux(['kill-server'], tmuxOptions);
      } else {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      }
    } catch {}
    await rm(fixtureCwd, { recursive: true, force: true });
    throw new Error(`failed to create temporary tmux fixture: ${created}`);
  }

  const serverLogPath = options.serverLog
    ? join(fixtureCwd, `tmux-server-${runTmux(['display-message', '-p', '#{pid}'], tmuxOptions)}.log`)
    : null;

  const socketPath = runTmux(['display-message', '-p', '-t', leaderPaneId, '#{socket_path}'], tmuxOptions);
  process.env.TMUX = `${socketPath},${process.pid},0`;
  process.env.TMUX_PANE = leaderPaneId;

  const fixture: TempTmuxSessionFixture = {
    sessionName,
    serverName,
    windowTarget,
    leaderPaneId,
    socketPath,
    serverKind,
    env: {
      TMUX: process.env.TMUX,
      TMUX_PANE: leaderPaneId,
    },
    sessionExists: (targetSessionName = sessionName) => tmuxSessionExists(targetSessionName, serverName || undefined),
    run: (args) => runTmux(args, tmuxOptions),
    runResult: (args) => runTmuxResult(args, tmuxOptions),
    runPtyResult,
    createPathShim,
    triggerClientResize,
    serverLogPath,
    readServerLog: async () => {
      if (serverLogPath === null) {
        throw new Error('server logging was not enabled');
      }
      return readFile(serverLogPath, 'utf-8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
    },
  };

  try {
    return await fn(fixture);
  } finally {
    if (serverKind === 'synthetic') {
      try {
        runTmux(['kill-server'], tmuxOptions);
      } catch {}
      const expectedNoServerMessages = [
        `no server running on ${socketPath}`,
        `error connecting to ${socketPath} (No such file or directory)`,
      ];
      let probe = runTmuxResult(['list-sessions'], tmuxOptions);
      for (let attempt = 0; attempt < 10 && !(
        probe.status === 1
        && probe.stdout === ''
        && expectedNoServerMessages.includes(probe.stderr.trim())
      ); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        probe = runTmuxResult(['list-sessions'], tmuxOptions);
      }
      if (
        probe.error
        || probe.status !== 1
        || probe.stdout !== ''
        || !expectedNoServerMessages.includes(probe.stderr.trim())
      ) {
        applyTmuxEnv(previousEnv);
        await rm(fixtureCwd, { recursive: true, force: true });
        throw new Error(
          `private tmux fixture cleanup did not prove private server termination: ${serverName}; ${JSON.stringify(probe)}`,
        );
      }
    } else {
      try {
        runTmux(['kill-session', '-t', sessionName], tmuxOptions);
      } catch {}
    }
    applyTmuxEnv(previousEnv);
    await rm(fixtureCwd, { recursive: true, force: true });
  }
}
