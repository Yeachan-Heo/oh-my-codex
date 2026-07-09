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
export type NativeSubagentSupportStatus = 'supported' | 'unsupported' | 'unknown';

export type NativeSubagentUnsupportedReason =
  | 'native_subagents_unsupported'
  | 'multi_agent_v1_unavailable'
  | 'agent_thread_limit_reached';

export type NativeSubagentSupportEvidenceSource =
  | 'hook_payload_capability'
  | 'hook_payload_available_tools'
  | 'post_tool_failure'
  | 'persisted_support_blocker'
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

export interface NativeSubagentCapabilityInput {
  payload?: Record<string, unknown> | null;
  persistedSupportBlocker?: Record<string, unknown> | null;
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
    && ['hook_payload_capability', 'hook_payload_available_tools', 'post_tool_failure', 'persisted_support_blocker', 'capacity_blocker', 'default_unknown'].includes(value);
}

function blockerMatchesScope(blocker: Record<string, unknown>, input: NativeSubagentCapabilityInput): boolean {
  const expiresAt = supportString(blocker.expires_at ?? blocker.expiresAt);
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return false;
  }
  const blockerCwd = supportString(blocker.cwd);
  if (blockerCwd && (!input.cwd || blockerCwd !== input.cwd)) return false;
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

function capabilityStatusFromRecord(record: Record<string, unknown> | null): NativeSubagentSupportStatus | null {
  if (!record) return null;
  const nativeSubagents = supportBoolean(record.native_subagents ?? record.nativeSubagents);
  const multiAgent = supportBoolean(record.multi_agent_v1 ?? record.multiAgentV1);
  if (nativeSubagents === false || multiAgent === false) return 'unsupported';
  if (nativeSubagents === true || multiAgent === true) return 'supported';
  return null;
}

function reasonFromCapabilityRecord(record: Record<string, unknown> | null): NativeSubagentUnsupportedReason {
  const nativeSubagents = supportBoolean(record?.native_subagents ?? record?.nativeSubagents);
  return nativeSubagents === false ? 'native_subagents_unsupported' : 'multi_agent_v1_unavailable';
}

function availableToolsEvidence(payload: Record<string, unknown> | null): NativeSubagentSupportEvidence | null {
  const tools = supportArray(payload?.available_tools ?? payload?.availableTools ?? payload?.tools);
  if (!tools) return null;
  const names = tools.map((tool) => typeof tool === 'string'
    ? tool
    : supportString(supportRecord(tool)?.name ?? supportRecord(tool)?.tool_name ?? supportRecord(tool)?.toolName)).filter(Boolean);
  const hasNativeSubagentTool = names.some((name) => /(?:^|\.)spawn_agent$/.test(name) || /multi_agent_v1\.spawn_agent/.test(name) || name === 'task');
  return hasNativeSubagentTool
    ? { status: 'supported', source: 'hook_payload_available_tools', evidenceSummary: names.join(', ') }
    : { status: 'unsupported', reason: 'multi_agent_v1_unavailable', source: 'hook_payload_available_tools', evidenceSummary: names.join(', ') };
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

  const toolEvidence = availableToolsEvidence(payload);
  if (toolEvidence) return toolEvidence;

  const capacityBlockerEvidence = supportEvidenceFromBlocker(input.persistedCapacityBlocker, 'capacity_blocker', input);
  if (capacityBlockerEvidence) return capacityBlockerEvidence;

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

export function buildUnsupportedNativeSubagentGuidance(evidence: NativeSubagentSupportEvidence): string {
  const reason = evidence.reason ? ` Reason: ${evidence.reason}.` : '';
  const summary = evidence.evidenceSummary ? ` Evidence: ${evidence.evidenceSummary}.` : '';
  return `${LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK}${reason}${summary}`;
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
