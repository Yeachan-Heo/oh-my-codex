import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const NATIVE_SPAWN_TASK_NAME_PATTERN = /^[a-z0-9_]+$/;
export const ROLE_INTENT_CORRELATION_TOKEN_PATTERN = /^[a-z0-9]+$/;
export const ROLE_INTENT_SPAWN_TASK_NAME_PREFIX = 'omx_role_intent_';


export function buildRoleIntentSpawnTaskName(correlationToken: string): string {
  const normalizedCorrelationToken = correlationToken.trim();
  if (!ROLE_INTENT_CORRELATION_TOKEN_PATTERN.test(normalizedCorrelationToken)) {
    throw new Error('Invalid role-intent correlation token.');
  }
  return `${ROLE_INTENT_SPAWN_TASK_NAME_PREFIX}${normalizedCorrelationToken}`;
}

export function isAppCompatibleSpawnTaskName(taskName: string): boolean {
  return NATIVE_SPAWN_TASK_NAME_PATTERN.test(taskName);
}

export function parseRoleIntentCorrelationToken(taskName: unknown): string | undefined {
  if (typeof taskName !== 'string') return undefined;
  if (!taskName.startsWith(ROLE_INTENT_SPAWN_TASK_NAME_PREFIX)) return undefined;
  const correlationToken = taskName.slice(ROLE_INTENT_SPAWN_TASK_NAME_PREFIX.length);
  return ROLE_INTENT_CORRELATION_TOKEN_PATTERN.test(correlationToken) ? correlationToken : undefined;
}

// Canonical origin-workspace identity for adapted role-intent journals. Existing paths
// resolve symlinks; nonexistent leaves retain their suffix beneath a canonical ancestor.
export function canonicalizeOriginCwd(cwd: string | undefined): string | null {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (!trimmed) return null;
  let resolved: string;
  try {
    resolved = resolve(trimmed);
  } catch {
    return null;
  }
  let prefix = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return suffix.length ? join(real, ...suffix) : real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(prefix);
      if (parent === prefix) return resolved;
      suffix.unshift(basename(prefix));
      prefix = parent;
    }
  }
}

export const LEADER_CONDUCTOR_PHILOSOPHY =
  'Conductor Philosophy: The core principle of OMX is: You are the conductor, not the performer.';

export const LEADER_CONDUCTOR_GOLDEN_RULE =
  'When the Main agent is acting in Conductor mode, NEVER make plan or code changes directly. ALWAYS delegate implementation to specialized agents. Your role is to guide, review, and orchestrate.';

export const LEADER_CONDUCTOR_SILVER_RULE =
  'Silver Rule: When follow-up work targets an existing role/lane, reuse or resume the assigned specialized agent whenever available before spawning a replacement.';

export const LEADER_CONDUCTOR_DELEGATION_NOTE =
  'Delegation note: assign bounded implementation, planning, review, and verification work to the appropriate specialized agents; Main owns orchestration, integration, and final judgment only.';

export const LEADER_CONDUCTOR_REUSE_AND_LEDGER_RULES = [
  'Conductor mode is a Main-root contract only; typed subagents never receive this block.',
  'Use .omx/state/subagent-tracking.json as the source of truth for saved subagent ids and recovery order.',
  'On SessionStart, eagerly attempt resume_agent(<subagent id>) for every saved subagent id before spawning any replacement agent.',
  'ralplan consensus planning may activate Conductor; autopilot rework stays exempt.',
] as const;

export const LEADER_CONDUCTOR_BLOCK = [
  'Conductor mode contract:',
  `- Golden Rule: ${LEADER_CONDUCTOR_GOLDEN_RULE}`,
  `- ${LEADER_CONDUCTOR_DELEGATION_NOTE}`,
].join('\n');

export const LEADER_CONDUCTOR_REUSE_AND_LEDGER_GUIDANCE = [
  'Conductor reuse and ledger guidance:',
  `- ${LEADER_CONDUCTOR_SILVER_RULE}`,
  ...LEADER_CONDUCTOR_REUSE_AND_LEDGER_RULES.map((line) => `- ${line}`),
].join('\n');
export type NativeSubagentSupportStatus = 'supported' | 'unsupported' | 'unknown' | 'role_routing_unavailable';

export type NativeSubagentUnsupportedReason =
  | 'native_subagents_unsupported'
  | 'multi_agent_v1_unavailable'
  | 'agent_thread_limit_reached';

export type NativeSubagentSupportEvidenceSource =
  | 'hook_payload_capability'
  | 'hook_payload_available_tools'
  | 'post_tool_failure'
  | 'persisted_support_blocker'
  | 'persisted_role_routing_marker'
  | 'capacity_blocker'
  | 'default_unknown';

export interface NativeSubagentSupportEvidence {
  status: NativeSubagentSupportStatus;
  reason?: NativeSubagentUnsupportedReason;
  source: NativeSubagentSupportEvidenceSource;
  evidenceSummary?: string;
  observedAt?: string;
  expiresAt?: string;
}

export interface RoleRoutingUnavailableMarker {
  schema_version: 1;
  cwd?: string;
  session_id?: string;
  parent_thread_id?: string;
  observed_at: string;
  expires_at: string;
  evidence?: string;
}

export interface NativeSubagentCapabilityInput {
  payload?: Record<string, unknown> | null;
  persistedSupportBlocker?: Record<string, unknown> | null;
  persistedRoleRoutingMarker?: unknown;
  persistedCapacityBlocker?: Record<string, unknown> | null;
  nowMs?: number;
  cwd?: string;
  sessionId?: string;
}

export const NATIVE_SUBAGENT_SUPPORT_BLOCKER_REASONS = [
  'native_subagents_unsupported',
  'multi_agent_v1_unavailable',
  'agent_thread_limit_reached',
] as const;

export const NATIVE_SUBAGENT_SUPPORT_BLOCKER_FILE = 'native-subagent-support.json';

export const LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK = [
  'Native subagent support is unavailable in this environment.',
  'Do not enter or preserve strict Main-root Conductor delegation that requires native subagents or multi_agent_v1.',
  'Record the unsupported native-subagent blocker, terminalize the workflow as blocked/cancelled/failed, or restart in a runtime with working native subagents.',
  'Do not treat this as clean ralplan consensus, clean ultragoal final review, or permission for Main-root source/package/git edits.',
  'Do not call multi_agent_v1.close_agent after native subagent capacity/support failures; stale native handles can hang the turn.',
].join(' ');

export const LEADER_CONDUCTOR_ROLE_ROUTING_DEGRADE_BLOCK = [
  'Native role routing is unavailable in this environment.',
  'PROCEED with adapted role-specific consensus using the exposed spawn tool.',
  'Record role identity via the OMX adapted role-intent ledger.',
  'Keep unknown-role validation loud.',
  'Continue the workflow without claiming native typed-subagent provenance.',
].join(' ');

function supportRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function supportString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function supportBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function supportArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isNativeSubagentUnsupportedReason(value: unknown): value is NativeSubagentUnsupportedReason {
  return typeof value === 'string'
    && (NATIVE_SUBAGENT_SUPPORT_BLOCKER_REASONS as readonly string[]).includes(value);
}

function isNativeSubagentSupportEvidenceSource(value: unknown): value is NativeSubagentSupportEvidenceSource {
  return typeof value === 'string'
    && ['hook_payload_capability', 'hook_payload_available_tools', 'post_tool_failure', 'persisted_support_blocker', 'persisted_role_routing_marker', 'capacity_blocker', 'default_unknown'].includes(value);
}

function blockerMatchesScope(blocker: Record<string, unknown>, input: NativeSubagentCapabilityInput): boolean {
  const expiresAt = supportString(blocker.expires_at ?? blocker.expiresAt);
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return false;
  }
  const blockerCwd = supportString(blocker.cwd);
  if (blockerCwd && (!input.cwd || canonicalizeOriginCwd(blockerCwd) !== canonicalizeOriginCwd(input.cwd))) return false;
  const blockerSessionId = supportString(blocker.session_id ?? blocker.sessionId);
  if (blockerSessionId && (!input.sessionId || blockerSessionId !== input.sessionId)) return false;
  return true;
}

function unsupportedEvidenceMatchesScope(record: Record<string, unknown>, input: Pick<NativeSubagentCapabilityInput, 'cwd' | 'sessionId' | 'nowMs'>): boolean {
  if (!blockerMatchesScope(record, input)) return false;
  const source = record.source;
  return isNativeSubagentSupportEvidenceSource(source)
    && source !== 'capacity_blocker'
    && source !== 'default_unknown';
}

function supportEvidenceFromBlocker(
  blocker: Record<string, unknown> | null | undefined,
  source: NativeSubagentSupportEvidenceSource,
  input: NativeSubagentCapabilityInput,
): NativeSubagentSupportEvidence | null {
  if (!blocker || !blockerMatchesScope(blocker, input)) return null;
  const reason = blocker.reason;
  if (!isNativeSubagentUnsupportedReason(reason)) return null;
  if (reason === 'agent_thread_limit_reached') {
    if (source !== 'capacity_blocker') return null;
    const expiresAt = supportString(blocker.expires_at ?? blocker.expiresAt);
    const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return null;
    return {
      status: 'unknown',
      reason,
      source,
      ...(supportString(blocker.error_summary ?? blocker.evidenceSummary ?? blocker.evidence) ? { evidenceSummary: supportString(blocker.error_summary ?? blocker.evidenceSummary ?? blocker.evidence) } : {}),
      ...(supportString(blocker.observed_at ?? blocker.observedAt) ? { observedAt: supportString(blocker.observed_at ?? blocker.observedAt) } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  const status = supportString(blocker.status) || 'unsupported';
  if (status && status !== 'unsupported') return null;
  return {
    status: 'unsupported',
    reason,
    source,
    ...(supportString(blocker.error_summary ?? blocker.evidenceSummary ?? blocker.evidence) ? { evidenceSummary: supportString(blocker.error_summary ?? blocker.evidenceSummary ?? blocker.evidence) } : {}),
    ...(supportString(blocker.observed_at ?? blocker.observedAt) ? { observedAt: supportString(blocker.observed_at ?? blocker.observedAt) } : {}),
    ...(supportString(blocker.expires_at ?? blocker.expiresAt) ? { expiresAt: supportString(blocker.expires_at ?? blocker.expiresAt) } : {}),
  };
}

function roleRoutingUnavailableEvidenceFromMarker(
  marker: unknown,
  input: NativeSubagentCapabilityInput,
): NativeSubagentSupportEvidence | null {
  const record = supportRecord(marker);
  if (!record || record.schema_version !== 1 || !blockerMatchesScope(record, input)) return null;

  const markerCwd = supportString(record.cwd);
  const markerSessionId = supportString(record.session_id ?? record.sessionId);
  if (!markerCwd && !markerSessionId) return null;

  const observedAt = supportString(record.observed_at ?? record.observedAt);
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return null;
  const expiresAt = supportString(record.expires_at ?? record.expiresAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!expiresAt || !Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return null;

  return {
    status: 'role_routing_unavailable',
    source: 'persisted_role_routing_marker',
    ...(supportString(record.evidence ?? record.evidenceSummary) ? { evidenceSummary: supportString(record.evidence ?? record.evidenceSummary) } : {}),
    observedAt,
    expiresAt,
  };
}

function capabilityStatusFromRecord(record: Record<string, unknown> | null): NativeSubagentSupportStatus | null {
  if (!record) return null;
  const nativeSubagents = supportBoolean(record.native_subagents ?? record.nativeSubagents);
  const multiAgent = supportBoolean(record.multi_agent_v1 ?? record.multiAgentV1);
  const roleRouting = supportBoolean(record.role_routing ?? record.roleRouting);
  if (nativeSubagents === false || multiAgent === false) return 'unsupported';
  if (roleRouting === false) return 'role_routing_unavailable';
  if (nativeSubagents === true || multiAgent === true) return 'supported';
  return null;
}

function reasonFromCapabilityRecord(record: Record<string, unknown> | null): NativeSubagentUnsupportedReason {
  const nativeSubagents = supportBoolean(record?.native_subagents ?? record?.nativeSubagents);
  return nativeSubagents === false ? 'native_subagents_unsupported' : 'multi_agent_v1_unavailable';
}

const NATIVE_SUBAGENT_SPAWN_TOOL_PATTERN = /(?:^|\.)spawn_agent$/;

// Recognizes native delegation spawn tools across terminology drift: bare
// `spawn_agent`, and namespaced forms such as `multi_agent_v1.spawn_agent` and
// the current Codex App `collaboration.spawn_agent`, plus the legacy `task`
// alias. The suffix anchor keeps `respawn_agent`/`spawn_agentx` from matching.
export function isNativeSubagentSpawnToolName(name: string): boolean {
  return NATIVE_SUBAGENT_SPAWN_TOOL_PATTERN.test(name) || name === 'task';
}

function availableToolsEvidence(payload: Record<string, unknown> | null): NativeSubagentSupportEvidence | null {
  const tools = supportArray(payload?.available_tools ?? payload?.availableTools ?? payload?.tools);
  if (!tools) return null;
  const names = tools.map((tool) => typeof tool === 'string'
    ? tool
    : supportString(supportRecord(tool)?.name ?? supportRecord(tool)?.tool_name ?? supportRecord(tool)?.toolName)).filter(Boolean);
  const hasNativeSubagentTool = names.some(isNativeSubagentSpawnToolName);
  if (hasNativeSubagentTool) {
    return { status: 'supported', source: 'hook_payload_available_tools', evidenceSummary: names.join(', ') };
  }
  // A present-but-incomplete tool inventory is NOT explicit negative evidence:
  // collaboration/deferred tools can be absent from this hook payload while a
  // spawn surface remains callable. Report `unknown` (with observed-name
  // provenance) rather than persisting an `unsupported` false negative.
  return { status: 'unknown', source: 'hook_payload_available_tools', evidenceSummary: names.join(', ') };
}

export function resolveNativeSubagentSupportStatus(input: NativeSubagentCapabilityInput): NativeSubagentSupportEvidence {
  const supportBlockerEvidence = supportEvidenceFromBlocker(input.persistedSupportBlocker, 'persisted_support_blocker', input);
  if (supportBlockerEvidence) return supportBlockerEvidence;

  const payload = supportRecord(input.payload);
  const explicitCapability = supportRecord(payload?.omx_runtime_capabilities)
    ?? supportRecord(payload?.capabilities);
  const explicitStatus = capabilityStatusFromRecord(explicitCapability);
  if (explicitStatus === 'unsupported') {
    return {
      status: 'unsupported',
      reason: reasonFromCapabilityRecord(explicitCapability),
      source: 'hook_payload_capability',
      evidenceSummary: 'payload capability reports native subagents or multi_agent_v1 unavailable',
    };
  }
  if (explicitStatus === 'supported') {
    return {
      status: 'supported',
      source: 'hook_payload_capability',
      evidenceSummary: 'payload capability reports native subagent support',
    };
  }
  if (explicitStatus === 'role_routing_unavailable') {
    return {
      status: 'role_routing_unavailable',
      source: 'hook_payload_capability',
      evidenceSummary: 'payload capability reports role routing unavailable',
    };
  }

  const roleRoutingMarkerEvidence = roleRoutingUnavailableEvidenceFromMarker(input.persistedRoleRoutingMarker, input);
  if (roleRoutingMarkerEvidence) return roleRoutingMarkerEvidence;

  const toolEvidence = availableToolsEvidence(payload);
  if (toolEvidence?.status === 'supported') return toolEvidence;

  // A capacity blocker means delegation exists but is temporarily exhausted, so
  // it outranks an incomplete tool inventory. Only fall back to the inventory's
  // `unknown` (with provenance) when no stronger evidence applies.
  const capacityBlockerEvidence = supportEvidenceFromBlocker(input.persistedCapacityBlocker, 'capacity_blocker', input);
  if (capacityBlockerEvidence) return capacityBlockerEvidence;

  if (toolEvidence) return toolEvidence;

  return { status: 'unknown', source: 'default_unknown' };
}

export function isUnsupportedNativeSubagentEvidenceForScope(
  value: unknown,
  input: Pick<NativeSubagentCapabilityInput, 'cwd' | 'sessionId' | 'nowMs'> = {},
): boolean {
  const record = supportRecord(value);
  if (!record) return false;
  if (record.status !== 'unsupported') return false;
  if (!unsupportedEvidenceMatchesScope(record, input)) return false;
  if (record.reason === 'agent_thread_limit_reached') return false;
  return isNativeSubagentUnsupportedReason(record.reason);
}

export function isUnsupportedNativeSubagentEvidence(value: unknown): boolean {
  return isUnsupportedNativeSubagentEvidenceForScope(value);
}

export function isRoleRoutingUnavailableEvidence(value: unknown): boolean {
  const record = supportRecord(value);
  return record?.status === 'role_routing_unavailable';
}

export function buildUnsupportedNativeSubagentGuidance(evidence: NativeSubagentSupportEvidence): string {
  const reason = evidence.reason ? ` Reason: ${evidence.reason}.` : '';
  const summary = evidence.evidenceSummary ? ` Evidence: ${evidence.evidenceSummary}.` : '';
  return `${LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK}${reason}${summary}`;
}

export function buildRoleRoutingUnavailableGuidance(evidence: NativeSubagentSupportEvidence): string {
  const reason = evidence.reason ? ` Reason: ${evidence.reason}.` : '';
  const summary = evidence.evidenceSummary ? ` Evidence: ${evidence.evidenceSummary}.` : '';
  return `${LEADER_CONDUCTOR_ROLE_ROUTING_DEGRADE_BLOCK}${reason}${summary}`;
}

export type ConductorPhase =
  | 'deep-interview'
  | 'ralplan'
  | 'autopilot-supervision'
  | 'ultragoal'
  | 'team'
  | 'ralph';

export type ConductorLaneKind =
  | 'main-conductor'
  | 'typed-subagent'
  | 'team-worker'
  | 'performer-carveout';

export type ConductorActionKind =
  | 'read-only'
  | 'orchestration-metadata-write'
  | 'substantive-deliverable-write'
  | 'implementation-mutation'
  | 'unknown-write';

export type ConductorArtifactKind =
  | 'orchestration-metadata'
  | 'transport'
  | 'ledger'
  | 'substantive-plan-spec-interview-review-qa'
  | 'implementation-source-package-git'
  | 'unknown';

export interface ConductorAuthorizationInput {
  phase: ConductorPhase;
  laneKind: ConductorLaneKind;
  actionKind: ConductorActionKind;
  artifactKind: ConductorArtifactKind;
}

export interface ConductorAuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export const CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES = [
  '.omx/state',
  '.omx/ultragoal',
  '.omx/ralph',
  '.omx/team',
  '.omx/mailbox',
  '.omx/handoff',
  '.omx/handoffs',
  '.omx/goals',
  '.omx/notepad',
  '.omx/wiki',
  '.beads',
] as const;

const CONDUCTOR_SUBSTANTIVE_DELIVERABLE_PREFIXES = [
  '.omx/context',
  '.omx/interviews',
  '.omx/plans',
  '.omx/specs',
  '.omx/reviews',
  '.omx/qa',
] as const;

export function classifyConductorArtifactKind(relativePath: string): ConductorArtifactKind {
  const normalized = relativePath.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  if (!normalized) return 'unknown';
  if (/^\.omx\/state(?:\/.*)?\/subagent-tracking\.json$/.test(normalized)) {
    return 'ledger';
  }
  if (normalized.startsWith('.omx/state/')) return 'transport';
  if (CONDUCTOR_ORCHESTRATION_METADATA_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return 'orchestration-metadata';
  }
  if (CONDUCTOR_SUBSTANTIVE_DELIVERABLE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return 'substantive-plan-spec-interview-review-qa';
  }
  if (normalized.startsWith('.omx/')) return 'unknown';
  return 'implementation-source-package-git';
}

export function actionKindForConductorArtifact(artifactKind: ConductorArtifactKind): ConductorActionKind {
  switch (artifactKind) {
    case 'orchestration-metadata':
    case 'transport':
    case 'ledger':
      return 'orchestration-metadata-write';
    case 'substantive-plan-spec-interview-review-qa':
      return 'substantive-deliverable-write';
    case 'implementation-source-package-git':
      return 'implementation-mutation';
    default:
      return 'unknown-write';
  }
}

export function authorizeConductorAction(input: ConductorAuthorizationInput): ConductorAuthorizationDecision {
  if (input.actionKind === 'read-only') {
    return { allowed: true, reason: 'read-only actions are outside the write guard' };
  }
  if (input.laneKind === 'typed-subagent' || input.laneKind === 'team-worker' || input.laneKind === 'performer-carveout') {
    return { allowed: true, reason: 'delegated performer lanes are outside Main-root Conductor write restrictions' };
  }
  if (input.laneKind !== 'main-conductor') {
    return { allowed: false, reason: 'unknown lane kind fails closed' };
  }
  if (
    input.actionKind === 'orchestration-metadata-write'
    && (input.artifactKind === 'orchestration-metadata' || input.artifactKind === 'transport' || input.artifactKind === 'ledger')
  ) {
    return { allowed: true, reason: 'Main-root Conductor may write orchestration metadata, transport, and ledger artifacts' };
  }
  if (input.actionKind === 'substantive-deliverable-write') {
    return { allowed: false, reason: 'Main-root Conductor must delegate substantive plan/spec/interview/review/QA deliverables' };
  }
  if (input.actionKind === 'implementation-mutation') {
    return { allowed: false, reason: 'Main-root Conductor must delegate source/package/git implementation mutations' };
  }
  return { allowed: false, reason: 'Main-root Conductor write target is unclassified and fails closed' };
}
