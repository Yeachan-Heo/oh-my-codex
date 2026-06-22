import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns, type StdioOptions } from 'node:child_process';
import { join } from 'node:path';
import { getPackageRoot } from '../utils/package.js';

export interface OmxRuntimeSpawnOptions {
  stdio?: StdioOptions;
  detached?: boolean;
  windowsHide?: boolean;
  signal?: AbortSignal;
}

export interface OmxRuntimeClientOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  omxBin?: string;
  codexBin?: string;
  spawnOptions?: OmxRuntimeSpawnOptions;
  omxSpawnOptions?: OmxRuntimeSpawnOptions;
  codexSpawnOptions?: OmxRuntimeSpawnOptions;
}

export interface OmxSessionCommandOptions {
  sessionId?: string;
  prompt?: string;
  last?: boolean;
  all?: boolean;
  profile?: string;
  model?: string;
  madmax?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | string;
  direct?: boolean;
  extraArgs?: string[];
}

export interface OmxWorkflowCommandOptions {
  skill: string;
  prompt?: string;
  profile?: string;
  model?: string;
  madmax?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | string;
  direct?: boolean;
  extraArgs?: string[];
}

export function defaultOmxBin(packageRoot = getPackageRoot()): string {
  return join(packageRoot, 'dist', 'cli', 'omx.js');
}

export function buildCodexSessionArgs(command: 'resume' | 'fork', options: OmxSessionCommandOptions = {}): string[] {
  const args: string[] = [command];
  if (options.last) args.push('--last');
  if (options.all) args.push('--all');
  if (options.profile) args.push('--profile', options.profile);
  if (options.model) args.push('--model', options.model);
  if (options.madmax) args.push('--dangerously-bypass-approvals-and-sandbox');
  if (options.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  if (options.extraArgs) args.push(...options.extraArgs);
  if (options.sessionId) args.push(options.sessionId);
  if (options.prompt) args.push(options.prompt);
  return args;
}

export function buildOmxResumeArgs(options: OmxSessionCommandOptions = {}): string[] {
  const args = ['resume'];
  if (options.direct) args.push('--direct');
  // omx resume wraps codex resume, so omit the leading codex command from the normalized args.
  args.push(...buildCodexSessionArgs('resume', options).slice(1));
  return args;
}

export function buildCodexForkArgs(options: OmxSessionCommandOptions = {}): string[] {
  return buildCodexSessionArgs('fork', options);
}

export function buildOmxExecSkillArgs(options: OmxWorkflowCommandOptions): string[] {
  assertSafeRuntimeName(options.skill, 'skill');
  const args = ['exec'];
  if (options.direct) args.push('--direct');
  if (options.profile) args.push('--profile', options.profile);
  if (options.model) args.push('--model', options.model);
  if (options.madmax) args.push('--madmax');
  if (options.reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoningEffort)}`);
  if (options.extraArgs) args.push(...options.extraArgs);
  const skillPrompt = options.prompt?.trim()
    ? `$${options.skill} ${options.prompt.trim()}`
    : `$${options.skill}`;
  args.push(skillPrompt);
  return args;
}

function assertSafeRuntimeName(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`Invalid OMX ${label} name: ${value}`);
  }
}

export class OmxRuntimeClient {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly omxBin: string;
  readonly codexBin: string;
  readonly spawnOptions: OmxRuntimeSpawnOptions;
  readonly omxSpawnOptions: OmxRuntimeSpawnOptions;
  readonly codexSpawnOptions: OmxRuntimeSpawnOptions;

  constructor(options: OmxRuntimeClientOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.omxBin = options.omxBin ?? defaultOmxBin();
    this.codexBin = options.codexBin ?? 'codex';
    this.spawnOptions = options.spawnOptions ?? {};
    this.omxSpawnOptions = options.omxSpawnOptions ?? {};
    this.codexSpawnOptions = options.codexSpawnOptions ?? {};
  }

  buildResumeArgs(options: OmxSessionCommandOptions = {}): string[] {
    return buildOmxResumeArgs(options);
  }

  buildForkArgs(options: OmxSessionCommandOptions = {}): string[] {
    return buildCodexForkArgs(options);
  }

  buildSkillArgs(options: OmxWorkflowCommandOptions): string[] {
    return buildOmxExecSkillArgs(options);
  }

  resume(options: OmxSessionCommandOptions = {}): ChildProcess {
    return this.spawnOmx(this.buildResumeArgs(options));
  }

  fork(options: OmxSessionCommandOptions = {}): ChildProcess {
    return this.spawnCodex(this.buildForkArgs(options));
  }

  runSkill(options: OmxWorkflowCommandOptions): ChildProcess {
    return this.spawnOmx(this.buildSkillArgs(options));
  }

  runOmxSync(args: string[], options: { input?: string; timeoutMs?: number } = {}): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [this.omxBin, ...args], {
      cwd: this.cwd,
      env: this.env,
      input: options.input,
      timeout: options.timeoutMs,
      encoding: 'utf-8',
    });
  }

  private spawnOmx(args: string[]): ChildProcess {
    return spawn(process.execPath, [this.omxBin, ...args], this.toSpawnOptions(this.omxSpawnOptions));
  }

  private spawnCodex(args: string[]): ChildProcess {
    return spawn(this.codexBin, args, this.toSpawnOptions(this.codexSpawnOptions));
  }

  private toSpawnOptions(specificOptions: OmxRuntimeSpawnOptions): SpawnOptions {
    return {
      cwd: this.cwd,
      env: this.env,
      stdio: 'inherit',
      ...this.spawnOptions,
      ...specificOptions,
    };
  }
}
