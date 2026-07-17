import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const UNSUPPORTED_DOCUMENTED_LEADER_PROOF = 'unsupported_documented_leader_proof' as const;

export const UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
  }),
});

export const UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE = Object.freeze({
  hookSpecificOutput: Object.freeze({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.',
  }),
});

type PreToolUseDenial = typeof UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE
  | typeof UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;

export interface Codex01445PreToolUseDependencies {
  resolveInstalledRoleName: typeof resolveInstalledRoleName;
  platform: NodeJS.Platform;
}

const defaultDependencies: Codex01445PreToolUseDependencies = {
  resolveInstalledRoleName,
  platform: process.platform,
};

function readCommand(payload: Record<string, unknown>): string | undefined {
  if (payload.tool_name !== 'Bash') return undefined;
  const toolInput = payload.tool_input;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

/**
 * Recognize only the canonical standalone adapted role-intent invocation. The
 * environment placeholder is matched lexically and is never expanded or used
 * as authority. Wrappers, assignments, compounds, redirects, duplicate flags,
 * alternate ordering, and malformed commands deliberately fall through to the
 * CLI parser.
 */
export function parseCodex01445AdaptedRoleIntentCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { role: string } | null {
  const parentPlaceholder = platform === 'win32'
    ? '"%CODEX_THREAD_ID%"'
    : '"$CODEX_THREAD_ID"';
  const escapedPlaceholder = parentPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^omx ralplan role-intent write --role ([A-Za-z0-9_-]{1,64}) --parent-thread ${escapedPlaceholder} --json$`,
  );
  const match = command.match(pattern);
  return match?.[1] ? { role: match[1] } : null;
}

export function evaluateCodex01445PreToolUse(
  payload: Record<string, unknown>,
  overrides: Partial<Codex01445PreToolUseDependencies> = {},
): PreToolUseDenial | undefined {
  const command = readCommand(payload);
  if (!command) return undefined;
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseCodex01445AdaptedRoleIntentCommand(command, dependencies.platform);
  if (!parsed) return undefined;
  return dependencies.resolveInstalledRoleName(parsed.role)
    ? UNSUPPORTED_DOCUMENTED_LEADER_PRE_TOOL_USE
    : UNKNOWN_RALPLAN_ROLE_PRE_TOOL_USE;
}
