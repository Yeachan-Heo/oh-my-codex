import { spawn as nodeSpawn } from 'node:child_process';
import type { ExecResult, SpawnOptions, Worker, WorkerDriver } from './driver.js';

export interface SpawnedProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void };
  on(event: 'close' | 'error', cb: (arg: number | null | Error) => void): void;
}

export interface SpawnFn {
  (
    cmd: string,
    args: readonly string[],
    opts?: { env?: NodeJS.ProcessEnv },
  ): SpawnedProcess;
}

export interface DockerDriverOptions {
  id?: string;
  dockerBin?: string;
  spawn?: SpawnFn;
  pullPolicy?: 'always' | 'missing' | 'never';
}

export const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, [...args], { env: opts?.env }) as unknown as SpawnedProcess;

export async function runCommand(
  spawn: SpawnFn,
  cmd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(cmd, args, env ? { env } : undefined);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (arg) => reject(arg as Error));
    child.on('close', (arg) => {
      const code = typeof arg === 'number' || arg === null ? arg : 1;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

class DockerWorker implements Worker {
  readonly id: string;
  readonly workspacePath: string;
  private closed = false;
  private readonly dockerBin: string;
  private readonly spawnFn: SpawnFn;

  constructor(id: string, workspacePath: string, dockerBin: string, spawn: SpawnFn) {
    this.id = id;
    this.workspacePath = workspacePath;
    this.dockerBin = dockerBin;
    this.spawnFn = spawn;
  }

  async exec(cmd: string, args: readonly string[]): Promise<ExecResult> {
    if (this.closed) throw new Error(`docker worker ${this.id} is closed`);
    return await runCommand(this.spawnFn, this.dockerBin, ['exec', this.id, cmd, ...args]);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await runCommand(this.spawnFn, this.dockerBin, ['stop', '-t', '2', this.id]);
    await runCommand(this.spawnFn, this.dockerBin, ['rm', '-f', this.id]);
  }
}

export class DockerWorkerDriver implements WorkerDriver {
  readonly id: string;
  private readonly dockerBin: string;
  private readonly spawnFn: SpawnFn;
  private readonly pullPolicy: 'always' | 'missing' | 'never';
  private nextIndex = 0;

  constructor(opts: DockerDriverOptions = {}) {
    this.id = opts.id ?? 'docker';
    this.dockerBin = opts.dockerBin ?? 'docker';
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.pullPolicy = opts.pullPolicy ?? 'missing';
  }

  async spawn(opts: SpawnOptions): Promise<Worker> {
    const containerName = `bumpkin-${this.id}-${process.pid}-${this.nextIndex++}`;
    const envArgs = opts.env
      ? Object.entries(opts.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
      : [];

    const runArgs = [
      'run',
      '-d',
      '--rm',
      '--name',
      containerName,
      '--pull',
      this.pullPolicy,
      '-v',
      `${opts.workspacePath}:/workspace`,
      '-w',
      '/workspace',
      ...envArgs,
      opts.image,
      'sleep',
      'infinity',
    ];

    const result = await runCommand(this.spawnFn, this.dockerBin, runArgs);
    if (result.code !== 0) {
      throw new Error(`docker run failed (exit ${result.code}): ${result.stderr || result.stdout}`);
    }

    return new DockerWorker(containerName, opts.workspacePath, this.dockerBin, this.spawnFn);
  }
}
