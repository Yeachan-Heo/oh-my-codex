import { randomUUID } from 'node:crypto';

import { buildRoleIntentSpawnTaskName, isAppCompatibleSpawnTaskName, parseRoleIntentCorrelationToken, ROLE_INTENT_CORRELATION_TOKEN_PATTERN } from '../leader/contract.js';
import { resolveRuntimeStateScope } from '../mcp/state-paths.js';
import { cancelMode } from '../modes/base.js';
import { ensureLeaderAndRecordIntent, hasLeaderSubagentCollision, hasVerifiedLeaderAttestation, type PendingRoleIntent, readSubagentTrackingStateStrict, resolveInstalledRoleName } from '../subagents/tracker.js';

export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan preflight [--json]
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]
`;

type RoleIntentFailureReason = 'unknown_role' | 'invalid_correlation_token' | 'invalid_origin' | 'single_flight_conflict' | 'session_not_current' | 'spawn_task_name_unsupported' | 'native_anchor_unavailable' | 'native_anchor_mismatch' | 'unsupported_documented_leader_proof';

interface ParsedRoleIntentWriteArgs {
  role: string;
  parentThreadId: string;
  sessionId?: string;
  ttlMs?: number;
  json: boolean;
}

function isSupportedCorrelationToken(token: string): boolean {
  const taskName = buildRoleIntentSpawnTaskName(token);
  return ROLE_INTENT_CORRELATION_TOKEN_PATTERN.test(token)
    && isAppCompatibleSpawnTaskName(taskName)
    && parseRoleIntentCorrelationToken(taskName) === token;
}

export interface RalplanCommandDependencies {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveSessionScope?: typeof resolveRuntimeStateScope;
  resolveInstalledRoleName?: typeof resolveInstalledRoleName;
  readTrackingState?: typeof readSubagentTrackingStateStrict;
  verifyLeaderAttestation?: typeof hasVerifiedLeaderAttestation;
  ensureLeaderAndRecordIntent?: typeof ensureLeaderAndRecordIntent;
  generateCorrelationToken?: () => string;
  cancelRalplan?: (cwd?: string) => Promise<void>;
}

export async function ralplanCommand(args: string[], deps: RalplanCommandDependencies = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }
  if (args[0] === 'preflight') {
    const json = args.length === 2 && args[1] === '--json';
    if (args.length !== 1 && !json) throw new Error(`Unknown ralplan preflight argument: ${args.slice(1).join(' ')}`);
    const cwd = (deps.cwd ?? process.cwd)();
    const scope = await (deps.resolveSessionScope ?? resolveRuntimeStateScope)(cwd);
    const tracking = await (deps.readTrackingState ?? readSubagentTrackingStateStrict)(cwd);
    const leader = scope.sessionId && tracking.ok ? tracking.state.sessions[scope.sessionId]?.leader_thread_id?.trim() : undefined;
    const attested = scope.sessionId && tracking.ok ? (deps.verifyLeaderAttestation ?? hasVerifiedLeaderAttestation)(scope.sessionId, tracking.state.sessions[scope.sessionId]) : false;
    const collision = tracking.ok && leader ? hasLeaderSubagentCollision(tracking.state, leader) : true;
    if (scope.sessionId && leader && attested && !collision) {
      if (json) stdout(JSON.stringify({ ok: true, session_id: scope.sessionId, leader_thread_id: leader }));
      else stdout(`ralplan preflight authenticated: session=${scope.sessionId} leader-thread=${leader}`);
      return;
    }
    await (deps.cancelRalplan ?? ((value?: string) => cancelMode('ralplan', value)))(cwd);
    emitRoleIntentFailure('unsupported_documented_leader_proof', json, stdout, stderr);
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
  const resolveSessionScope = deps.resolveSessionScope ?? resolveRuntimeStateScope;
  const currentScope = await resolveSessionScope(cwd);
  if (!currentScope.sessionId || !currentScope.metadata || currentScope.metadata.sessionId !== currentScope.sessionId) {
    emitRoleIntentFailure('native_anchor_unavailable', parsed.json, stdout, stderr);
    return;
  }
  if (parsed.sessionId !== undefined && (await resolveSessionScope(cwd, parsed.sessionId)).sessionId !== currentScope.sessionId) {
    emitRoleIntentFailure('session_not_current', parsed.json, stdout, stderr);
    return;
  }
  const correlationToken = (deps.generateCorrelationToken ?? (() => randomUUID().replace(/-/g, '')))();
  if (!isSupportedCorrelationToken(correlationToken)) {
    emitRoleIntentFailure('spawn_task_name_unsupported', parsed.json, stdout, stderr);
    return;
  }
  const result = (deps.ensureLeaderAndRecordIntent ?? ensureLeaderAndRecordIntent)(currentScope.cwd, {
    role: installedRole,
    sessionId: currentScope.sessionId,
    parentThreadId: parsed.parentThreadId,
    correlationToken,
    ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
  });
  if (!result.ok) {
    emitRoleIntentFailure(result.reason, parsed.json, stdout, stderr);
    return;
  }
  const intent: PendingRoleIntent = result.intent;
  const spawnTaskName = buildRoleIntentSpawnTaskName(intent.correlation_token);
  if (!isSupportedCorrelationToken(intent.correlation_token)) {
    emitRoleIntentFailure('spawn_task_name_unsupported', parsed.json, stdout, stderr);
    return;
  }
  const receipt = {
    ok: true,
    intent: {
      role: intent.role,
      session_id: intent.session_id,
      parent_thread_id: intent.parent_thread_id,
      correlation_token: intent.correlation_token,
      expires_at: intent.expires_at,
    },
    spawn_task_name: spawnTaskName,
  };
  if (parsed.json) stdout(JSON.stringify(receipt));
  else stdout(`role-intent recorded: role=${intent.role} session=${intent.session_id} parent-thread=${intent.parent_thread_id} correlation-token=${intent.correlation_token} spawn-task-name=${spawnTaskName} expires-at=${intent.expires_at}`);
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
