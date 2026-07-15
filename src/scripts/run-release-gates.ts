#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ReleaseGate {
  program: 'npm' | 'cargo';
  args: readonly string[];
}

export const RELEASE_GATES = [
  { program: 'npm', args: ['run', 'build'] },
  { program: 'npm', args: ['run', 'lint'] },
  { program: 'npm', args: ['run', 'check:no-unused'] },
  { program: 'npm', args: ['run', 'verify:native-agents'] },
  { program: 'npm', args: ['run', 'verify:plugin-bundle'] },
  { program: 'npm', args: ['run', 'test:node'] },
  { program: 'cargo', args: ['test', '--workspace'] },
  { program: 'npm', args: ['run', 'coverage:team-critical:compiled'] },
  { program: 'npm', args: ['run', 'coverage:workflow-critical:compiled'] },
  { program: 'npm', args: ['run', 'coverage:ts:full:checked:compiled'] },
  { program: 'npm', args: ['run', 'test:mutation:core:compiled'] },
  { program: 'npm', args: ['run', 'smoke:packed-install'] },
] as const satisfies readonly ReleaseGate[];

export interface ReleaseGateExecution {
  gate: ReleaseGate;
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface ReleaseGateExecutionResult {
  status: number | null;
  error?: Error;
}

export type ReleaseGateExecutor = (execution: ReleaseGateExecution) => ReleaseGateExecutionResult;

export interface RunReleaseGatesOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  scripts?: Readonly<Record<string, string>>;
  execute?: ReleaseGateExecutor;
  log?: (message: string) => void;
}

export interface RunReleaseGateCliOptions extends RunReleaseGatesOptions {
  reportError?: (message: string) => void;
}

export class ReleaseGateFailure extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'ReleaseGateFailure';
  }
}

export function releaseGateCommand(gate: ReleaseGate, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return gate.program;
  return gate.program === 'npm' ? 'npm.cmd' : 'cargo.exe';
}

function releaseGateLabel(gate: ReleaseGate): string {
  return `${gate.program} ${gate.args.join(' ')}`;
}

function readPackageScripts(cwd: string): Readonly<Record<string, string>> {
  const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  return packageJson.scripts ?? {};
}

export function executeReleaseGate(execution: ReleaseGateExecution): ReleaseGateExecutionResult {
  const result = spawnSync(execution.command, [...execution.args], {
    cwd: execution.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  return {
    status: result.status,
    error: result.error,
  };
}

export function runReleaseGates(options: RunReleaseGatesOptions = {}): void {
  const cwd = resolve(options.cwd ?? process.cwd());
  const platform = options.platform ?? process.platform;
  const scripts = options.scripts ?? readPackageScripts(cwd);
  const execute = options.execute ?? executeReleaseGate;
  const log = options.log ?? ((message: string) => console.error(message));

  for (const gate of RELEASE_GATES) {
    const label = releaseGateLabel(gate);
    const scriptName = gate.program === 'npm' && gate.args[0] === 'run' ? gate.args[1] : undefined;
    if (scriptName && typeof scripts[scriptName] !== 'string') {
      throw new ReleaseGateFailure(`RELEASE_GATE_SCRIPT_MISSING: ${scriptName}`, 1);
    }

    log(`[verify:release] ${label}`);
    const result = execute({
      gate,
      command: releaseGateCommand(gate, platform),
      args: gate.args,
      cwd,
    });
    if (result.error) {
      throw new ReleaseGateFailure(`RELEASE_GATE_SPAWN_FAILED: ${label}: ${result.error.message}`, 1);
    }
    if (result.status !== 0) {
      const exitCode = result.status ?? 1;
      throw new ReleaseGateFailure(`RELEASE_GATE_FAILED: ${label} (exit ${exitCode})`, exitCode);
    }
  }
}

export function runReleaseGateCli(options: RunReleaseGateCliOptions = {}): number {
  try {
    runReleaseGates(options);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (options.reportError ?? ((value: string) => console.error(value)))(message);
    return error instanceof ReleaseGateFailure ? error.exitCode : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runReleaseGateCli();
}
