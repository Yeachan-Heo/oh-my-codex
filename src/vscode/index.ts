import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { redactAuthSecrets } from '../auth/redact.js';
import { CODEX_BYPASS_FLAG, MADMAX_FLAG, MADMAX_SPARK_FLAG } from '../cli/constants.js';
import {
  resolveCommandPathForPlatform,
  spawnPlatformCommand,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';

export const DIRECT_SESSION_SCHEMA_VERSION = 'omx.vscode/direct-session/v1';

const DEFAULT_OMX_COMMAND = 'omx';
const LAUNCH_POLICY_ENV = 'OMX_LAUNCH_POLICY';
const VSCODE_RUNNER_ENV = 'OMX_VSCODE_RUNNER';
const VSCODE_SESSION_ENV = 'OMX_VSCODE_SESSION_ID';
const VSCODE_LOG_ENV = 'OMX_VSCODE_LOG_PATH';
const DIRECT_POLICY_FLAGS = new Set(['--direct', '--tmux']);
const DANGEROUS_FLAGS = new Set([
  MADMAX_FLAG,
  MADMAX_SPARK_FLAG,
  CODEX_BYPASS_FLAG,
  '--yolo',
]);

export type DirectSessionMode = 'launch' | 'resume';

export interface BuildDirectSessionArgsOptions {
  mode?: DirectSessionMode;
  codexArgs?: string[];
}

export interface LaunchDirectSessionOptions extends BuildDirectSessionArgsOptions {
  cwd: string;
  prompt?: string;
  omxCommand?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dangerousApproved?: boolean;
  logPath?: string;
  sessionId?: string;
}

export interface ResolveVscodeLaunchEnvOptions {
  cwd: string;
  omxCommand?: string;
  baseEnv?: NodeJS.ProcessEnv;
  extraPath?: string[];
  platform?: NodeJS.Platform;
}

export interface VscodeLaunchEnvResolution {
  env: NodeJS.ProcessEnv;
  pathKey: string;
  pathEntries: string[];
  codexPath: string | null;
}

export interface OmxDirectSessionHandle {
  schema_version: typeof DIRECT_SESSION_SCHEMA_VERSION;
  session_id: string;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  log_path: string;
  started_at: string;
  child: ChildProcess;
  stop: (signal?: NodeJS.Signals | number) => boolean;
}

export interface RunOmxCatalogCommandOptions {
  cwd: string;
  omxCommand?: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface RunOmxCatalogCommandResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface LaunchDirectSessionDeps {
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => Date;
  randomId?: () => string;
}

interface RunOmxCatalogCommandDeps {
  spawnSync?: typeof nodeSpawnSync;
}

function normalizeCwd(cwd: string): string {
  const normalized = cwd.trim();
  if (!normalized) throw new Error('cwd is required');
  return resolve(normalized);
}

function stripPolicyFlags(args: readonly string[]): string[] {
  return args.filter((arg) => !DIRECT_POLICY_FLAGS.has(arg));
}

function dedupePathEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function resolvePathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function defaultVscodePathEntries(
  cwd: string,
  omxCommand: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  const entries = [
    isAbsolute(omxCommand ?? '') ? dirname(omxCommand as string) : '',
    join(cwd, 'node_modules', '.bin'),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.npm-global', 'bin'),
  ];

  if (platform === 'darwin') {
    entries.push('/Applications/Codex.app/Contents/Resources');
  }
  if (platform !== 'win32') {
    entries.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  }

  return entries;
}

export function resolveVscodeLaunchEnv(options: ResolveVscodeLaunchEnvOptions): VscodeLaunchEnvResolution {
  const cwd = normalizeCwd(options.cwd);
  const platform = options.platform ?? process.platform;
  const baseEnv = options.baseEnv ?? process.env;
  const pathKey = resolvePathKey(baseEnv);
  const currentPathEntries = String(baseEnv[pathKey] ?? baseEnv.PATH ?? baseEnv.Path ?? '')
    .split(delimiter)
    .filter(Boolean);
  const pathEntries = dedupePathEntries([
    ...(options.extraPath ?? []),
    ...defaultVscodePathEntries(cwd, options.omxCommand, platform),
    ...currentPathEntries,
  ]);
  const mergedPath = pathEntries.join(delimiter);
  const env = {
    ...baseEnv,
    [pathKey]: mergedPath,
    PATH: mergedPath,
  };

  return {
    env,
    pathKey,
    pathEntries,
    codexPath: resolveCommandPathForPlatform('codex', platform, env),
  };
}

export function buildDirectSessionArgs(options: BuildDirectSessionArgsOptions = {}): string[] {
  const mode = options.mode ?? 'launch';
  const codexArgs = stripPolicyFlags(options.codexArgs ?? []);
  return mode === 'resume'
    ? ['resume', '--direct', ...codexArgs]
    : ['launch', '--direct', ...codexArgs];
}

export function findDangerousLaunchArgs(args: readonly string[]): string[] {
  return args.filter((arg) => DANGEROUS_FLAGS.has(arg));
}

export function launchRequiresDangerousApproval(args: readonly string[]): boolean {
  return findDangerousLaunchArgs(args).length > 0;
}

export function redactOmxLogLine(value: unknown): string {
  return redactAuthSecrets(value);
}

function defaultSessionId(now: Date = new Date()): string {
  const suffix = randomBytes(4).toString('hex');
  return `vscode-${now.getTime()}-${suffix}`;
}

function defaultLogPath(cwd: string, sessionId: string): string {
  return join(cwd, '.omx', 'logs', 'vscode', `${sessionId}.log`);
}

function ensureLogStream(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: 'a' });
}

function writeLog(stream: WriteStream, text: string): void {
  stream.write(redactOmxLogLine(text));
}

function resolveLaunchEnv(
  baseEnv: NodeJS.ProcessEnv,
  sessionId: string,
  logPath: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [LAUNCH_POLICY_ENV]: 'direct',
    [VSCODE_RUNNER_ENV]: '1',
    [VSCODE_SESSION_ENV]: sessionId,
    [VSCODE_LOG_ENV]: logPath,
  };
}

export function launchDirectSession(
  options: LaunchDirectSessionOptions,
  deps: LaunchDirectSessionDeps = {},
): OmxDirectSessionHandle {
  const cwd = normalizeCwd(options.cwd);
  const now = deps.now?.() ?? new Date();
  const sessionId = options.sessionId ?? deps.randomId?.() ?? defaultSessionId(now);
  const command = options.omxCommand?.trim() || DEFAULT_OMX_COMMAND;
  const promptArg = typeof options.prompt === 'string' && options.prompt.trim() !== ''
    ? [options.prompt]
    : [];
  const args = buildDirectSessionArgs({
    mode: options.mode,
    codexArgs: [...(options.codexArgs ?? []), ...promptArg],
  });
  const dangerousArgs = findDangerousLaunchArgs(args);
  if (dangerousArgs.length > 0 && options.dangerousApproved !== true) {
    throw new Error(`dangerous_launch_requires_approval:${dangerousArgs.join(',')}`);
  }

  const logPath = options.logPath ? resolve(options.logPath) : defaultLogPath(cwd, sessionId);
  const logStream = ensureLogStream(logPath);
  const env = resolveLaunchEnv(options.env ?? process.env, sessionId, logPath);
  const platform = options.platform ?? process.platform;
  const spawnOptions: SpawnOptions = {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const launched = spawnPlatformCommand(command, args, spawnOptions, platform, env, undefined, deps.spawn ?? nodeSpawn);
  const child = launched.child;
  const startedAt = now.toISOString();
  writeLog(logStream, `[${startedAt}] $ ${launched.spec.command} ${launched.spec.args.join(' ')}\n`);

  child.stdout?.on('data', (chunk: Buffer | string) => writeLog(logStream, String(chunk)));
  child.stderr?.on('data', (chunk: Buffer | string) => writeLog(logStream, String(chunk)));
  child.on('error', (error) => {
    writeLog(logStream, `\n[${new Date().toISOString()}] launch error: ${redactOmxLogLine(error)}\n`);
  });
  child.on('exit', (code, signal) => {
    writeLog(logStream, `\n[${new Date().toISOString()}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    logStream.end();
  });

  return {
    schema_version: DIRECT_SESSION_SCHEMA_VERSION,
    session_id: sessionId,
    cwd,
    command: launched.spec.command,
    args: launched.spec.args,
    pid: child.pid,
    log_path: logPath,
    started_at: startedAt,
    child,
    stop: (signal: NodeJS.Signals | number = 'SIGTERM') => child.kill(signal),
  };
}

export function runOmxCatalogCommand(
  options: RunOmxCatalogCommandOptions,
  deps: RunOmxCatalogCommandDeps = {},
): RunOmxCatalogCommandResult {
  const cwd = normalizeCwd(options.cwd);
  const command = options.omxCommand?.trim() || DEFAULT_OMX_COMMAND;
  const env = { ...(options.env ?? process.env), [LAUNCH_POLICY_ENV]: 'direct', [VSCODE_RUNNER_ENV]: '1' };
  const { spec, result } = spawnPlatformCommandSync(command, options.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
  }, options.platform ?? process.platform, env, undefined, deps.spawnSync ?? nodeSpawnSync);
  return {
    command: spec.command,
    args: [...spec.args],
    stdout: String(result.stdout ?? ''),
    stderr: result.error ? result.error.message : String(result.stderr ?? ''),
    code: typeof result.status === 'number' ? result.status : null,
    signal: result.signal as NodeJS.Signals | null,
  };
}
