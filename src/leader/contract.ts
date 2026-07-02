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
