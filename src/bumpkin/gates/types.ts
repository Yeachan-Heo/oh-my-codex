export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface GateContext {
  workspacePath: string;
  run: CommandRunner;
  baseline?: Record<string, unknown>;
}

export interface GateVerdict {
  pass: boolean;
  reason: string;
  artifacts?: Record<string, unknown>;
}

export interface Gate {
  readonly name: string;
  run(ctx: GateContext): Promise<GateVerdict>;
}
