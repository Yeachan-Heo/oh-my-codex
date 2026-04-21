export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  image: string;
  workspacePath: string;
  env?: Record<string, string>;
  label?: string;
}

export interface Worker {
  readonly id: string;
  readonly workspacePath: string;
  exec(cmd: string, args: readonly string[]): Promise<ExecResult>;
  close(): Promise<void>;
}

export interface WorkerDriver {
  readonly id: string;
  spawn(opts: SpawnOptions): Promise<Worker>;
}
