import {
  probeInstalledCodexVersionDetailed,
  type CodexVersionProbeResult,
} from './codex-feature-probe.js';

import { resolveInstalledRoleName } from '../subagents/tracker.js';
import { readModeState, readModeStateForExplicitSession, startMode } from '../modes/base.js';
import { runRalplanConsensus, type RalplanConsensusExecutor } from '../ralplan/runtime.js';

export const RALPLAN_HELP = `omx ralplan - consensus planning runtime and adapted-authority diagnostics

Usage:
  omx ralplan run --task <text> [--session <id>] [--json]
  omx ralplan start --task <text> [--session <id>] [--json]
  omx ralplan status [--session <id>] [--json]
                Starts or inspects the session-scoped Planner -> Architect -> Critic runtime state.
                The active model performs the three sequential lanes and persists their artifacts.
  omx ralplan preflight [--json]
                Required only when native role routing is unavailable and adapted Ralplan authority is requested.
                State-preserving diagnostic only. Ordinary work remains under its own workflow gates.
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]
                Compatibility diagnostic only: installed roles are denied with unsupported_documented_leader_proof.
`;

type RoleIntentFailureReason = 'unknown_role' | 'unsupported_documented_leader_proof';


interface ParsedRoleIntentWriteArgs {
  role: string;
  parentThreadId: string;
  sessionId?: string;
  ttlMs?: number;
  json: boolean;
}



export interface RalplanCommandDependencies {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveInstalledRoleName?: typeof resolveInstalledRoleName;
  probeCodexVersionDetailed?: () => CodexVersionProbeResult | null | undefined;
  consensusExecutor?: RalplanConsensusExecutor;
}

const REVIEWED_ROOT_IDENTITY_ABSENT_VERSIONS = new Set([
  '0.144.5',
  '0.145.0',
  '0.146.1',
  '0.148.0-alpha.5',
]);

type DocumentedRootIdentityStatus = 'missing' | 'unknown';

interface RalplanPreflightDiagnostics {
  probe_status: CodexVersionProbeResult['status'];
  detected_version: string | null;
  documented_root_identity: { status: DocumentedRootIdentityStatus };
}

function normalizeDetectedVersion(result: CodexVersionProbeResult): string | null {
  if (result.status !== 'ok' || result.collected.truncated || result.collected.lineLimitExceeded) return null;
  for (const line of result.collected.output.split(/\r?\n/).slice(0, 8)) {
    for (const token of line.trim().split(/\s+/)) {
      if (token.length > 64) continue;
      const match = /^(?:v)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(token);
      if (!match) continue;
      const normalized = `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ''}`;
      return normalized;
    }
  }
  return null;
}

function buildPreflightDiagnostics(result: CodexVersionProbeResult): RalplanPreflightDiagnostics {
  const detectedVersion = normalizeDetectedVersion(result);
  const completeOutput = result.status === 'ok'
    && !result.collected.truncated
    && !result.collected.lineLimitExceeded;
  return {
    probe_status: result.status,
    detected_version: detectedVersion,
    documented_root_identity: {
      status: completeOutput && detectedVersion !== null && REVIEWED_ROOT_IDENTITY_ABSENT_VERSIONS.has(detectedVersion)
        ? 'missing'
        : 'unknown',
    },
  };
}

function resolvePreflightProbeResult(deps: RalplanCommandDependencies): CodexVersionProbeResult {
  if (!Object.prototype.hasOwnProperty.call(deps, 'probeCodexVersionDetailed')) {
    return probeInstalledCodexVersionDetailed();
  }
  try {
    return deps.probeCodexVersionDetailed?.() ?? { status: 'exit-failure' };
  } catch {
    return { status: 'exit-failure' };
  }
}

export async function ralplanCommand(args: string[], deps: RalplanCommandDependencies = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }
  if (args[0] === 'run' || args[0] === 'start' || args[0] === 'status') {
    const sessionFlag = args.find((arg) => arg.startsWith('--session='));
    const sessionIndex = args.indexOf('--session');
    const sessionId = sessionFlag?.slice('--session='.length)
      ?? (sessionIndex >= 0 ? args[sessionIndex + 1] : undefined);
    const json = args.includes('--json');
    const cwd = (deps.cwd ?? process.cwd)();
    if (args[0] === 'run' || args[0] === 'start') {
      const taskFlag = args.find((arg) => arg.startsWith('--task='));
      const taskIndex = args.indexOf('--task');
      const task = taskFlag?.slice('--task='.length)
        ?? (taskIndex >= 0 ? args[taskIndex + 1] : undefined);
      if (!task?.trim()) throw new Error('Missing --task.');
      if (deps.consensusExecutor) {
        const parent = sessionId
          ? await readModeStateForExplicitSession('autopilot', sessionId, cwd)
          : null;
        const supervised = parent?.active === true && parent.current_phase === 'ralplan';
        const result = await runRalplanConsensus(deps.consensusExecutor, {
          task: task.trim(),
          cwd,
          sessionId,
          ...(supervised ? { selectedExecutionLane: 'ultragoal' as const } : {}),
        });
        if (json) stdout(JSON.stringify({ ok: result.status === 'completed', result }));
        else stdout(result.status === 'completed'
          ? 'Ralplan consensus complete; proceed to Ultragoal.'
          : `Ralplan ${result.status}: ${result.error ?? result.phase}`);
        return;
      }
      await startMode('ralplan', task.trim(), 5, cwd, sessionId);
    }
    const state = sessionId
      ? await readModeStateForExplicitSession('ralplan', sessionId, cwd)
      : await readModeState('ralplan', cwd);
    if (!state) throw new Error('No Ralplan state found.');
    const instruction = [
      `Run the Ralplan consensus runtime for ${JSON.stringify(String(state.task_description ?? ''))}.`,
      'Execute Planner first, await Architect approval second, then await Critic approval third.',
      'Persist the execution-ready plan, sequential review evidence, and bound ralplan_execution_handoff in this exact session.',
    ].join('\n');
    if (json) stdout(JSON.stringify({ ok: true, state, instruction }));
    else stdout(instruction);
    return;
  }
  if (args[0] === 'preflight') {
    const json = args.length === 2 && args[1] === '--json';
    if ((args.length !== 1 && !json)) throw new Error(`Unknown ralplan preflight argument: ${args.slice(1).join(' ')}`);

    const diagnostics = buildPreflightDiagnostics(resolvePreflightProbeResult(deps));
    const failure = { ok: false, reason: 'unsupported_documented_leader_proof' as const, diagnostics };
    if (json) {
      stdout(JSON.stringify(failure));
    } else {
      stderr('ralplan preflight failed: unsupported_documented_leader_proof');
      stderr(`detected codex ${diagnostics.detected_version ?? 'null'}; probe_status: ${diagnostics.probe_status}; documented_root_identity: ${diagnostics.documented_root_identity.status}`);
    }
    process.exitCode = 1;
    return;
  }
  if (args[0] !== 'role-intent' || args[1] !== 'write') throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  const cwd = (deps.cwd ?? process.cwd)();
  const installedRole = (deps.resolveInstalledRoleName ?? resolveInstalledRoleName)(parsed.role, undefined, cwd);
  if (!installedRole) {
    emitRoleIntentFailure('unknown_role', parsed.json, stdout, stderr);
    return;
  }
  emitRoleIntentFailure('unsupported_documented_leader_proof', parsed.json, stdout, stderr);
}

function parseRoleIntentWriteArgs(args: string[]): ParsedRoleIntentWriteArgs {
  let role: string | undefined;
  let parentThreadId: string | undefined;
  let sessionId: string | undefined;
  let ttlMs: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') { json = true; continue; }
    if (arg === '--role' || arg === '--parent-thread' || arg === '--session' || arg === '--ttl-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}.`);
      if (arg === '--role') role = value;
      if (arg === '--parent-thread') parentThreadId = value;
      if (arg === '--session') sessionId = value;
      if (arg === '--ttl-ms') ttlMs = parseTtlMs(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) role = arg.slice('--role='.length);
    else if (arg.startsWith('--parent-thread=')) parentThreadId = arg.slice('--parent-thread='.length);
    else if (arg.startsWith('--session=')) sessionId = arg.slice('--session='.length);
    else if (arg.startsWith('--ttl-ms=')) ttlMs = parseTtlMs(arg.slice('--ttl-ms='.length));
    else throw new Error(`Unknown role-intent write argument: ${arg}`);
  }
  if (!role?.trim()) throw new Error('Missing --role.');
  if (!parentThreadId?.trim()) throw new Error('Missing --parent-thread.');
  return { role, parentThreadId, ...(sessionId === undefined ? {} : { sessionId }), ...(ttlMs === undefined ? {} : { ttlMs }), json };
}

function parseTtlMs(value: string): number {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('--ttl-ms must be a positive integer.');
  return ttlMs;
}

function emitRoleIntentFailure(reason: RoleIntentFailureReason, json: boolean, stdout: (line: string) => void, stderr: (line: string) => void): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
