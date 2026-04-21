import type { ExecResult, SpawnOptions, Worker, WorkerDriver } from './driver.js';

export type CannedResponse = (cmd: string, args: readonly string[]) => ExecResult | Promise<ExecResult>;

export interface InMemoryDriverOptions {
  id?: string;
  respond?: CannedResponse;
  defaultResult?: ExecResult;
}

export class InMemoryWorker implements Worker {
  readonly id: string;
  readonly workspacePath: string;
  closed = false;
  readonly log: Array<{ cmd: string; args: readonly string[] }> = [];
  private readonly respond: CannedResponse | undefined;
  private readonly defaultResult: ExecResult;

  constructor(
    id: string,
    workspacePath: string,
    respond: CannedResponse | undefined,
    defaultResult: ExecResult,
  ) {
    this.id = id;
    this.workspacePath = workspacePath;
    this.respond = respond;
    this.defaultResult = defaultResult;
  }

  async exec(cmd: string, args: readonly string[]): Promise<ExecResult> {
    if (this.closed) throw new Error(`worker ${this.id} is closed`);
    this.log.push({ cmd, args });
    if (this.respond) return await this.respond(cmd, args);
    return this.defaultResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class InMemoryWorkerDriver implements WorkerDriver {
  readonly id: string;
  readonly spawned: InMemoryWorker[] = [];
  private nextIndex = 0;
  private readonly respond: CannedResponse | undefined;
  private readonly defaultResult: ExecResult;

  constructor(options: InMemoryDriverOptions = {}) {
    this.id = options.id ?? 'in-memory';
    this.respond = options.respond;
    this.defaultResult = options.defaultResult ?? { code: 0, stdout: '', stderr: '' };
  }

  async spawn(opts: SpawnOptions): Promise<Worker> {
    const worker = new InMemoryWorker(
      `${this.id}-${this.nextIndex++}`,
      opts.workspacePath,
      this.respond,
      this.defaultResult,
    );
    this.spawned.push(worker);
    return worker;
  }
}
