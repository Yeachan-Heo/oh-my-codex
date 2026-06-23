import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveApiBinaryPathWithHydration } from '../cli/api.js';
import { OmxSdkError } from './errors.js';
import {
  daemonBaseUrl,
  daemonHostsMatch,
  isLoopbackHost,
  normalizeLoopbackHost,
  processIsAlive,
  tokenPathAllowedForState,
} from './internal.js';
import { codexProfileToApiEnv, resolveCodexProfile } from './profile.js';
import {
  daemonTokenFileForState,
  defaultOmxApiStateFile,
  readOmxDaemonState,
  readOmxDaemonToken,
  OmxClient,
} from './client.js';
import type { OmxApiBackend, OmxDaemonState } from './types.js';

export interface StartOmxApiDaemonOptions {
  host?: string;
  port?: number;
  backend?: OmxApiBackend;
  stateFile?: string;
  localBearerToken?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  binaryPath?: string;
  startupTimeoutMs?: number;
  timeoutMs?: number;
  profile?: string;
  codexHome?: string;
}

export interface OmxApiDaemonStatus {
  status: 'running' | 'not-running';
  daemon?: OmxDaemonState;
  baseUrl?: string;
  bearerToken?: string;
}

export function buildOmxApiServeArgs(options: Required<Pick<StartOmxApiDaemonOptions, 'host' | 'port' | 'backend' | 'stateFile'>>): string[] {
  assertLoopbackHost(options.host);
  assertDaemonPort(options.port);
  const host = normalizeLoopbackHost(options.host);
  return [
    'serve',
    '--host', host,
    '--port', String(options.port),
    '--backend', options.backend,
    '--state-file', options.stateFile,
  ];
}

export class OmxApiDaemon {
  readonly state: OmxDaemonState;
  readonly stateFile: string;
  readonly bearerToken?: string;
  readonly child?: ChildProcess;
  readonly client: OmxClient;
  private readonly managedStateDir?: string;

  constructor(options: {
    state: OmxDaemonState;
    stateFile: string;
    bearerToken?: string;
    child?: ChildProcess;
    timeoutMs?: number;
    managedStateDir?: string;
  }) {
    this.state = options.state;
    this.stateFile = options.stateFile;
    this.bearerToken = options.bearerToken;
    this.child = options.child;
    this.managedStateDir = options.managedStateDir;
    this.client = new OmxClient({
      baseUrl: this.baseUrl,
      bearerToken: options.bearerToken,
      timeoutMs: options.timeoutMs,
    });
  }

  get baseUrl(): string {
    return daemonBaseUrl(this.state.host, this.state.port);
  }

  async stop(options: { timeoutMs?: number; cleanupState?: boolean } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    try {
      await this.client.stop();
    } catch {
      // Fall back to process termination below when the admin endpoint is gone or unreachable.
    }

    if (this.child && this.child.exitCode === null) {
      await terminateChild(this.child, timeoutMs);
    }

    if (options.cleanupState !== false) {
      await cleanupDaemonStateFiles(this.stateFile, this.state);
      if (this.managedStateDir) await rm(this.managedStateDir, { recursive: true, force: true });
    }
  }
}

export async function readOmxApiDaemonStatus(stateFile = defaultOmxApiStateFile()): Promise<OmxApiDaemonStatus> {
  const daemon = await readOmxDaemonState(stateFile);
  if (!daemon) return { status: 'not-running' };
  if (!processIsAlive(daemon.pid)) return { status: 'not-running' };
  return {
    status: 'running',
    daemon,
    baseUrl: daemonBaseUrl(daemon.host, daemon.port),
    bearerToken: await readOmxDaemonToken(stateFile),
  };
}

export async function startOmxApiDaemon(options: StartOmxApiDaemonOptions = {}): Promise<OmxApiDaemon> {
  const host = normalizeDaemonBindHost(options.host ?? '127.0.0.1');
  const port = options.port ?? 14510;
  assertDaemonPort(port);
  const backend = options.backend ?? 'mock';
  const managedState = options.stateFile ? undefined : await managedOmxApiStateFile();
  const stateFile = resolve(options.stateFile ?? managedState?.stateFile ?? defaultOmxApiStateFile());
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env) };
  if (options.profile) {
    const profileEnv = codexProfileToApiEnv(await resolveCodexProfile({
      profile: options.profile,
      codexHome: options.codexHome,
      env,
    }));
    applyProfileEnvDefaults(env, profileEnv);
  }
  if (options.localBearerToken) env.OMX_API_LOCAL_BEARER = options.localBearerToken;
  const binaryPath = options.binaryPath ?? await resolveApiBinaryPathWithHydration({ cwd, env });
  await removeStaleDaemonStateFiles(stateFile);
  const args = buildOmxApiServeArgs({ host, port, backend, stateFile });

  let spawnError: Error | undefined;
  let stderrBuffer = '';
  const child = spawn(binaryPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.setEncoding('utf-8');
  const stderrHandler = (chunk: string | Buffer) => {
    stderrBuffer = `${stderrBuffer}${String(chunk)}`.slice(-16_384);
  };
  child.stderr?.on('data', stderrHandler);
  child.once('error', (error) => {
    spawnError = error;
  });

  let state: OmxDaemonState;
  try {
    state = await waitForDaemonState({
      child,
      stateFile,
      host,
      port,
      backend,
      startupTimeoutMs: options.startupTimeoutMs ?? 5_000,
      getSpawnError: () => spawnError,
      getStderr: () => stderrBuffer,
    });
  } catch (error) {
    child.stderr?.off('data', stderrHandler);
    if (managedState) await rm(managedState.stateDir, { recursive: true, force: true });
    throw error;
  }
  child.stderr?.off('data', stderrHandler);
  return new OmxApiDaemon({
    state,
    stateFile,
    bearerToken: await readOmxDaemonToken(stateFile),
    child,
    timeoutMs: options.timeoutMs,
    managedStateDir: managedState?.stateDir,
  });
}

function applyProfileEnvDefaults(env: NodeJS.ProcessEnv, profileEnv: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(profileEnv)) {
    if (!value) continue;
    const current = env[key];
    if (typeof current !== 'string' || current.trim() === '') {
      env[key] = value;
    }
  }
}

function assertLoopbackHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new OmxSdkError(`omx-api SDK daemons must bind to a loopback host, got ${host}`);
  }
}

function assertDaemonPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new OmxSdkError(`omx-api SDK daemon ports must be integers from 0 to 65535, got ${port}`);
  }
}

function normalizeDaemonBindHost(host: string): string {
  assertLoopbackHost(host);
  return normalizeLoopbackHost(host);
}



async function managedOmxApiStateFile(): Promise<{ stateFile: string; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'omx-api-daemon-'));
  if (process.platform !== 'win32') await chmod(stateDir, 0o700);
  return { stateDir, stateFile: join(stateDir, 'daemon.json') };
}

async function removeStaleDaemonStateFiles(stateFile: string): Promise<void> {
  const current = await readOmxDaemonState(stateFile);
  if (current && processIsAlive(current.pid)) {
    throw new OmxSdkError(`refusing to replace live omx-api daemon state at ${stateFile} (pid ${current.pid})`);
  }
  const tokenPaths = new Set<string>([daemonTokenFileForState(stateFile)]);
  if (current?.local_bearer_token_file && tokenPathAllowedForState(current.local_bearer_token_file, stateFile)) {
    tokenPaths.add(current.local_bearer_token_file);
  }
  await Promise.all([
    rm(stateFile, { force: true }),
    ...[...tokenPaths].map((tokenPath) => rm(tokenPath, { force: true })),
  ]);
}

function stateMatchesSpawnedDaemon(state: OmxDaemonState, expected: {
  child: ChildProcess;
  host: string;
  port: number;
  backend: OmxApiBackend;
}): boolean {
  return state.pid === expected.child.pid
    && daemonHostsMatch(state.host, expected.host)
    && state.backend === expected.backend
    && (expected.port === 0 ? state.port > 0 : state.port === expected.port);
}

async function waitForDaemonState(options: {
  child: ChildProcess;
  stateFile: string;
  host: string;
  port: number;
  backend: OmxApiBackend;
  startupTimeoutMs: number;
  getSpawnError: () => Error | undefined;
  getStderr: () => string;
}): Promise<OmxDaemonState> {
  const deadline = Date.now() + options.startupTimeoutMs;
  while (Date.now() <= deadline) {
    const spawnError = options.getSpawnError();
    if (spawnError) throw new OmxSdkError(withStderr(`failed to launch omx-api: ${spawnError.message}`, options.getStderr()), { cause: spawnError });
    const state = await readOmxDaemonState(options.stateFile);
    if (state && stateMatchesSpawnedDaemon(state, options)) return state;
    if (options.child.exitCode !== null) {
      throw new OmxSdkError(withStderr(`omx-api exited before writing daemon state (exit ${options.child.exitCode})`, options.getStderr()));
    }
    await delay(50);
  }
  if (options.child.exitCode === null) {
    await terminateChild(options.child, Math.min(options.startupTimeoutMs, 1_000));
  }
  const checked = existsSync(options.stateFile) ? options.stateFile : `${options.stateFile} (missing)`;
  throw new OmxSdkError(withStderr(`omx-api did not write daemon state within ${options.startupTimeoutMs}ms: ${checked}`, options.getStderr()));
}

function withStderr(message: string, stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `${message}; stderr: ${trimmed}` : message;
}

async function cleanupDaemonStateFiles(stateFile: string, expectedState: OmxDaemonState): Promise<void> {
  const current = await readOmxDaemonState(stateFile);
  if (current && current.pid !== expectedState.pid) return;
  if (!current && existsSync(stateFile)) return;
  const tokenPath = expectedState.local_bearer_token_file && tokenPathAllowedForState(expectedState.local_bearer_token_file, stateFile)
    ? expectedState.local_bearer_token_file
    : daemonTokenFileForState(stateFile);
  await Promise.all([
    rm(stateFile, { force: true }),
    rm(tokenPath, { force: true }),
  ]);
}

async function terminateChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  const exited = await waitForChildExit(child, timeoutMs);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForChildExit(child, Math.min(timeoutMs, 1_000));
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return true;
  return await new Promise<boolean>((resolvePromise) => {
    let settled = false;
    let timeout: NodeJS.Timeout;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(true);
    };
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      resolvePromise(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
