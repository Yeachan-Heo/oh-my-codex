import type {
  ArchitectStatus,
  EvidenceStatus,
  FinalVerdict,
  LaneRecord,
  ScopeStatus,
} from './contract.js';

export interface VerdictSynthesisInput {
  scope_status: ScopeStatus;
  evidence_status: EvidenceStatus;
  expected_reviewer_lane_ids: readonly string[];
  reviewer_lanes: readonly LaneRecord[];
  architect_lane?: LaneRecord;
  failures?: readonly string[];
  diagnostic_failure?: boolean;
  no_changes?: boolean;
}

const ARCHITECT_SEVERITY: Record<ArchitectStatus, number> = { CLEAR: 0, WATCH: 1, BLOCK: 2 };

export function worseArchitectStatus(left: ArchitectStatus, right: ArchitectStatus): ArchitectStatus {
  return ARCHITECT_SEVERITY[left] >= ARCHITECT_SEVERITY[right] ? left : right;
}

function boundedReasons(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.slice(0, 500)))];
}

function verdict(
  input: VerdictSynthesisInput,
  recommendation: FinalVerdict['recommendation'],
  architecturalStatus: ArchitectStatus,
  ruleId: string,
  reasons: readonly string[],
): FinalVerdict {
  const clean = ruleId === 'CLEAN_APPROVAL'
    && recommendation === 'APPROVE'
    && architecturalStatus === 'CLEAR'
    && input.scope_status === 'FULL_SCOPE'
    && input.evidence_status === 'FULL_EVIDENCE';
  return {
    recommendation,
    architectural_status: architecturalStatus,
    scope_status: input.scope_status,
    evidence_status: input.evidence_status,
    rule_id: ruleId,
    reasons: boundedReasons(reasons),
    clean,
  };
}

function validArchitect(lane: LaneRecord | undefined): lane is LaneRecord & { architectural_status: ArchitectStatus } {
  return lane !== undefined
    && lane.role === 'architect'
    && lane.batch_id === 'global'
    && lane.status === 'COMPLETE'
    && (lane.architectural_status === 'CLEAR'
      || lane.architectural_status === 'WATCH'
      || lane.architectural_status === 'BLOCK');
}

function reviewerTopologyFailures(input: VerdictSynthesisInput): string[] {
  const reasons: string[] = [];
  const expected = [...input.expected_reviewer_lane_ids];
  if (new Set(expected).size !== expected.length) reasons.push('DUPLICATE_PLANNED_REVIEWER_LANE');
  const byId = new Map<string, LaneRecord[]>();
  for (const lane of input.reviewer_lanes) {
    const group = byId.get(lane.lane_id) ?? [];
    group.push(lane);
    byId.set(lane.lane_id, group);
  }
  for (const laneId of expected) {
    const lanes = byId.get(laneId) ?? [];
    if (lanes.length === 0) reasons.push(`MISSING_LANE:${laneId}`);
    if (lanes.length > 1) reasons.push(`DUPLICATE_LANE:${laneId}`);
  }
  for (const lane of input.reviewer_lanes) {
    if (!expected.includes(lane.lane_id)) reasons.push(`UNPLANNED_LANE:${lane.lane_id}`);
    if (lane.role !== 'code-reviewer' || lane.status !== 'COMPLETE' || lane.recommendation === undefined) {
      reasons.push(`INVALID_LANE:${lane.lane_id}:${lane.status}`);
    }
  }
  return reasons;
}

function hasSevereFinding(lane: LaneRecord): boolean {
  return lane.findings.some((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH');
}

export function synthesizeVerdict(input: VerdictSynthesisInput): FinalVerdict {
  // Rule 1 deliberately precedes every lane check: clean repositories launch no lanes and never approve.
  if (input.no_changes) {
    return {
      recommendation: 'COMMENT',
      architectural_status: 'CLEAR',
      scope_status: input.scope_status,
      evidence_status: 'FULL_EVIDENCE',
      rule_id: 'NO_CHANGES',
      reasons: ['NO_CHANGES'],
      clean: false,
    };
  }

  const architectLane = input.architect_lane;
  const architectIsValid = validArchitect(architectLane);
  const architecturalStatus: ArchitectStatus = architectIsValid
    ? architectLane.architectural_status
    : 'BLOCK';
  const topologyFailures = reviewerTopologyFailures(input);
  if (!architectIsValid) topologyFailures.push('MISSING_OR_INVALID_ARCHITECT');
  const explicitFailures = [...(input.failures ?? [])];
  if (topologyFailures.length > 0 || explicitFailures.length > 0) {
    return verdict(
      input,
      'REQUEST CHANGES',
      architecturalStatus,
      'INVALID_OR_MISSING_EVIDENCE',
      [...explicitFailures, ...topologyFailures],
    );
  }

  if (input.diagnostic_failure
    || input.reviewer_lanes.some((lane) => lane.failure_code === 'DIAGNOSTIC_FAILED')) {
    return verdict(input, 'REQUEST CHANGES', architecturalStatus, 'DIAGNOSTIC_FAILED', ['DIAGNOSTIC_FAILED']);
  }

  if (architecturalStatus === 'BLOCK'
    || input.reviewer_lanes.some((lane) => lane.recommendation === 'REQUEST CHANGES')) {
    return verdict(
      input,
      'REQUEST CHANGES',
      architecturalStatus,
      'LANE_REQUEST_CHANGES',
      [
        ...(architecturalStatus === 'BLOCK' ? ['ARCHITECT_BLOCK'] : []),
        ...input.reviewer_lanes
          .filter((lane) => lane.recommendation === 'REQUEST CHANGES')
          .map((lane) => `REVIEWER_REQUEST_CHANGES:${lane.lane_id}`),
      ],
    );
  }

  const contradictory = [
    ...input.reviewer_lanes
      .filter((lane) => lane.recommendation === 'APPROVE' && hasSevereFinding(lane))
      .map((lane) => `CONTRADICTORY_REVIEWER:${lane.lane_id}`),
    ...(input.architect_lane !== undefined
      && (architecturalStatus === 'CLEAR' || architecturalStatus === 'WATCH')
      && hasSevereFinding(input.architect_lane)
      ? ['CONTRADICTORY_ARCHITECT']
      : []),
  ];
  if (contradictory.length > 0) {
    return verdict(input, 'REQUEST CHANGES', architecturalStatus, 'CONTRADICTORY_LANE', contradictory);
  }

  const effectiveEvidence: EvidenceStatus = input.evidence_status === 'DEGRADED_EVIDENCE'
    || input.reviewer_lanes.some((lane) => lane.failure_code === 'DIAGNOSTIC_DEGRADED')
    ? 'DEGRADED_EVIDENCE'
    : 'FULL_EVIDENCE';
  const normalizedInput = effectiveEvidence === input.evidence_status
    ? input
    : { ...input, evidence_status: effectiveEvidence };
  if (input.scope_status === 'PARTIAL_SCOPE' || effectiveEvidence === 'DEGRADED_EVIDENCE') {
    return verdict(
      normalizedInput,
      'COMMENT',
      architecturalStatus,
      'PARTIAL_OR_DEGRADED',
      [
        ...(input.scope_status === 'PARTIAL_SCOPE' ? ['PARTIAL_SCOPE'] : []),
        ...(effectiveEvidence === 'DEGRADED_EVIDENCE' ? ['DEGRADED_EVIDENCE'] : []),
      ],
    );
  }

  const remainingFindings = [
    ...input.reviewer_lanes.flatMap((lane) => lane.findings),
    ...(input.architect_lane?.findings ?? []),
  ];
  if (architecturalStatus === 'WATCH'
    || input.reviewer_lanes.some((lane) => lane.recommendation === 'COMMENT')
    || remainingFindings.length > 0) {
    return verdict(
      input,
      'COMMENT',
      architecturalStatus,
      'COMMENT_OR_FINDINGS',
      [
        ...(architecturalStatus === 'WATCH' ? ['ARCHITECT_WATCH'] : []),
        ...input.reviewer_lanes
          .filter((lane) => lane.recommendation === 'COMMENT')
          .map((lane) => `REVIEWER_COMMENT:${lane.lane_id}`),
        ...(remainingFindings.length > 0 ? ['REMAINING_FINDINGS'] : []),
      ],
    );
  }

  // All non-approval recommendations and architect statuses returned in the ordered rules above.
  return verdict(input, 'APPROVE', 'CLEAR', 'CLEAN_APPROVAL', ['ALL_REQUIRED_EVIDENCE_CLEAR']);
}
