import { createHash } from 'node:crypto';
import type {
  DiagnosticSubmission,
  DiagnosticSummary,
  EvidenceStatus,
  LaneProvenance,
  LaneRecord,
  LaneResult,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewFinding,
  ReviewRecord,
} from './contract.js';
import { REVIEW_LIMITS } from './contract.js';
import {
  evaluateCapabilityEvidence,
  type Capability,
  type CapabilityPlan,
} from './capabilities.js';
import { validateReviewDiagnostics, validateReviewFinding } from './redaction.js';

export interface NativeTrackerSnapshot {
  session_id: string;
  thread_id: string;
  tracker_lane_id: string;
  tracker_path: string;
  first_seen_at: string;
  last_seen_at?: string;
  completed_at?: string;
  agent_id?: string;
}

export interface DiagnosticToolEvent {
  event_ref: string;
  thread_id: string;
  tool_name?: string;
  program?: string;
  args?: string[];
}

export interface ValidatedLaneEvidence {
  valid: boolean;
  failure_code?: 'LANE_EVIDENCE_INVALID';
  reasons: string[];
  evidence_status: EvidenceStatus;
  maximum_recommendation: 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES';
  result?: LaneResult;
  diagnostics: DiagnosticSummary[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('lane payload contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) throw new Error('lane payload must be plain JSON');
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalPayload(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalLanePayloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalPayload(value), 'utf8').digest('hex');
}

function timestamp(value: unknown, name: string): number {
  if (typeof value !== 'string') throw new Error(`${name} timestamp is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} timestamp is invalid`);
  return parsed;
}

function invalidEvidence(...reasons: string[]): ValidatedLaneEvidence {
  return {
    valid: false,
    failure_code: 'LANE_EVIDENCE_INVALID',
    reasons,
    evidence_status: 'DEGRADED_EVIDENCE',
    maximum_recommendation: 'REQUEST CHANGES',
    diagnostics: [],
  };
}

export function validateLaneStart(input: {
  review: ReviewRecord;
  lane: LaneRecord;
  thread_id: string;
  tracker: NativeTrackerSnapshot | undefined;
  alreadyBoundThreadIds: ReadonlySet<string>;
}): LaneProvenance {
  const { review, lane, tracker } = input;
  if (tracker === undefined) throw new Error('hook-owned tracker provenance is missing');
  if (review.status !== 'REVIEWING' || lane.attempt !== review.current_attempt || lane.status !== 'PENDING') {
    throw new Error('lane is not pending in the current review attempt');
  }
  if (review.session_id === undefined || tracker.session_id !== review.session_id) {
    throw new Error('tracker session does not match the review session');
  }
  if (tracker.thread_id !== input.thread_id) throw new Error('tracker thread identity does not match START');
  if (tracker.tracker_lane_id !== lane.lane_id) throw new Error('tracker lane label does not match the planned lane');
  if (input.alreadyBoundThreadIds.has(input.thread_id)) throw new Error('native child thread is already bound');
  const attempt = review.attempt_history.find((candidate) => candidate.attempt === review.current_attempt);
  if (attempt === undefined || timestamp(tracker.first_seen_at, 'first_seen_at') < timestamp(attempt.started_at, 'attempt start')) {
    throw new Error('tracker first_seen_at predates the current attempt');
  }
  if (tracker.tracker_path.length === 0 || tracker.tracker_path.length > REVIEW_LIMITS.path) {
    throw new Error('tracker path is invalid');
  }
  return {
    session_id: tracker.session_id,
    thread_id: tracker.thread_id,
    tracker_lane_id: tracker.tracker_lane_id,
    tracker_path: tracker.tracker_path,
    first_seen_at: tracker.first_seen_at,
    ...(tracker.last_seen_at === undefined ? {} : { last_seen_at: tracker.last_seen_at }),
    ...(tracker.completed_at === undefined ? {} : { completed_at: tracker.completed_at }),
    ...(tracker.agent_id === undefined ? {} : { agent_id: tracker.agent_id }),
  };
}

function expectedFindingFiles(review: ReviewRecord, lane: LaneRecord): Set<string> {
  if (lane.batch_id === 'global') return new Set(review.scope?.files.map((file) => file.path) ?? []);
  const batch = review.batches.find((candidate) => candidate.batch_id === lane.batch_id);
  return new Set(batch?.files ?? []);
}

function validateFindings(
  value: unknown,
  review: ReviewRecord,
  lane: LaneRecord,
): ReviewFinding[] | null {
  if (!Array.isArray(value) || value.length > REVIEW_LIMITS.findingsPerLane) return null;
  const allowed = expectedFindingFiles(review, lane);
  try {
    const findings = value.map(validateReviewFinding);
    if (findings.some((finding) => !allowed.has(finding.file))) return null;
    const existing = review.lanes.reduce((count, item) => count + item.findings.length, 0);
    if (existing + findings.length > REVIEW_LIMITS.findingsPerReview) return null;
    return findings;
  } catch {
    return null;
  }
}

function exactReviewerResult(
  value: Record<string, unknown>,
  review: ReviewRecord,
  lane: LaneRecord,
): LaneResult | null {
  if (!hasExactKeys(value, [
    'role', 'review_id', 'attempt', 'lane_id', 'batch_id', 'scope_hash',
    'recommendation', 'findings', 'diagnostics',
  ]) || value.role !== 'code-reviewer'
    || value.review_id !== review.review_id
    || value.attempt !== review.current_attempt
    || value.lane_id !== lane.lane_id
    || value.batch_id !== lane.batch_id
    || value.scope_hash !== lane.scope_hash
    || !(['APPROVE', 'COMMENT', 'REQUEST CHANGES'] as const).includes(value.recommendation as never)) return null;
  const findings = validateFindings(value.findings, review, lane);
  if (findings === null) return null;
  let diagnostics: DiagnosticSubmission[];
  try {
    diagnostics = validateReviewDiagnostics(value.diagnostics, { includeThreadId: false });
  } catch {
    return null;
  }
  return {
    role: 'code-reviewer',
    review_id: review.review_id,
    attempt: review.current_attempt,
    lane_id: lane.lane_id,
    batch_id: lane.batch_id,
    scope_hash: lane.scope_hash,
    recommendation: value.recommendation as 'APPROVE' | 'COMMENT' | 'REQUEST CHANGES',
    findings,
    diagnostics,
  };
}

function exactArchitectResult(
  value: Record<string, unknown>,
  review: ReviewRecord,
  lane: LaneRecord,
): LaneResult | null {
  if (!hasExactKeys(value, [
    'role', 'review_id', 'attempt', 'lane_id', 'batch_id', 'scope_hash',
    'architectural_status', 'findings',
  ]) || value.role !== 'architect'
    || value.review_id !== review.review_id
    || value.attempt !== review.current_attempt
    || value.lane_id !== lane.lane_id
    || value.batch_id !== 'global'
    || lane.batch_id !== 'global'
    || value.scope_hash !== lane.scope_hash
    || !(['CLEAR', 'WATCH', 'BLOCK'] as const).includes(value.architectural_status as never)) return null;
  const findings = validateFindings(value.findings, review, lane);
  if (findings === null) return null;
  return {
    role: 'architect',
    review_id: review.review_id,
    attempt: review.current_attempt,
    lane_id: lane.lane_id,
    batch_id: 'global',
    scope_hash: lane.scope_hash,
    architectural_status: value.architectural_status as 'CLEAR' | 'WATCH' | 'BLOCK',
    findings,
  };
}

function contradiction(result: LaneResult): boolean {
  const severe = result.findings.some((finding) => finding.severity === 'CRITICAL' || finding.severity === 'HIGH');
  return severe && (
    (result.role === 'code-reviewer' && result.recommendation === 'APPROVE')
    || (result.role === 'architect' && result.architectural_status !== 'BLOCK')
  );
}

function sameArgs(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function diagnosticProvenanceMatches(
  diagnostic: DiagnosticSubmission,
  event: DiagnosticToolEvent,
  threadId: string,
): boolean {
  if (event.thread_id !== threadId) return false;
  if (diagnostic.tool_name !== undefined) {
    return event.tool_name === diagnostic.tool_name
      && diagnostic.program === undefined
      && diagnostic.args === undefined;
  }
  if (diagnostic.program !== undefined) {
    return event.program === diagnostic.program
      && sameArgs(event.args, diagnostic.args)
      && diagnostic.tool_name === undefined;
  }
  return false;
}

export function validateLaneResultEvidence(input: {
  review: ReviewRecord;
  lane: LaneRecord;
  result: unknown;
  capabilityPlan?: CapabilityPlan;
  toolEvents?: readonly DiagnosticToolEvent[];
}): ValidatedLaneEvidence {
  let payload: string;
  try {
    payload = canonicalPayload(input.result);
  } catch {
    return invalidEvidence('PAYLOAD_MALFORMED');
  }
  if (Buffer.byteLength(payload, 'utf8') > REVIEW_LIMITS.lanePayload) {
    return invalidEvidence('PAYLOAD_OVERSIZED');
  }
  if (!isPlainObject(input.result) || input.lane.status !== 'RUNNING' || input.lane.provenance === undefined) {
    return invalidEvidence('LANE_OR_RESULT_INVALID');
  }
  const result = input.lane.role === 'code-reviewer'
    ? exactReviewerResult(input.result, input.review, input.lane)
    : exactArchitectResult(input.result, input.review, input.lane);
  if (result === null) return invalidEvidence('RESULT_SCHEMA_OR_IDENTITY_INVALID');
  if (contradiction(result)) return invalidEvidence('CONTRADICTORY_LANE_RESULT');
  if (result.role === 'architect') {
    return {
      valid: true,
      reasons: [],
      evidence_status: 'FULL_EVIDENCE',
      maximum_recommendation: result.architectural_status === 'BLOCK' ? 'REQUEST CHANGES' : 'APPROVE',
      result,
      diagnostics: [],
    };
  }

  const plan = input.capabilityPlan;
  if (plan === undefined) return invalidEvidence('CAPABILITY_PLAN_MISSING');
  const required = plan.capabilities
    .filter((entry) => entry.required_for.length > 0)
    .map((entry) => entry.capability);
  const counts = new Map<Capability, number>();
  for (const diagnostic of result.diagnostics) {
    counts.set(diagnostic.capability, (counts.get(diagnostic.capability) ?? 0) + 1);
  }
  if (required.some((capability) => counts.get(capability) !== 1)
    || [...counts].some(([, count]) => count !== 1)) {
    return invalidEvidence('DIAGNOSTIC_CAPABILITY_COVERAGE_INVALID');
  }

  const evaluation = evaluateCapabilityEvidence(
    plan,
    result.diagnostics.map((diagnostic) => ({
      capability: diagnostic.capability,
      execution: diagnostic.execution,
      outcome: diagnostic.outcome,
      ...(diagnostic.source_ref === undefined ? {} : { source_ref: diagnostic.source_ref }),
      ...(diagnostic.program === undefined ? {} : { program: diagnostic.program }),
      ...(diagnostic.args === undefined ? {} : { args: diagnostic.args }),
    })),
    input.review.effective_config.accepted_equivalents,
  );
  if (evaluation.maximum_recommendation === 'REQUEST CHANGES') {
    return invalidEvidence(...evaluation.reasons);
  }

  const events = input.toolEvents ?? [];
  const provenanceReasons: string[] = [];
  const diagnostics: DiagnosticSummary[] = result.diagnostics.map((diagnostic) => {
    const matches = events.filter((event) => event.event_ref === diagnostic.event_ref);
    if (matches.length !== 1
      || !diagnosticProvenanceMatches(diagnostic, matches[0]!, input.lane.provenance!.thread_id)) {
      provenanceReasons.push(`DIAGNOSTIC_EVENT_PROVENANCE_UNVERIFIED:${diagnostic.capability}`);
    }
    return { ...diagnostic, thread_id: input.lane.provenance!.thread_id };
  });
  const degraded = evaluation.evidence_status === 'DEGRADED_EVIDENCE' || provenanceReasons.length > 0;
  return {
    valid: true,
    reasons: [...evaluation.reasons, ...provenanceReasons],
    evidence_status: degraded ? 'DEGRADED_EVIDENCE' : 'FULL_EVIDENCE',
    maximum_recommendation: degraded ? 'COMMENT' : evaluation.maximum_recommendation,
    result,
    diagnostics,
  };
}

function exactPublication(value: unknown): value is ResultPostToolPublication {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'publication_id', 'published_at', 'activity', 'attestation',
  ]) || value.schema_version !== 1 || !isPlainObject(value.activity) || !isPlainObject(value.attestation)) return false;
  return hasExactKeys(value.activity, [
    'schema_version', 'session_id', 'review_id', 'attempt', 'lane_id', 'child_thread_id',
    'event_ref', 'event_kind', 'observed_at',
  ]) && hasExactKeys(value.attestation, [
    'schema_version', 'session_id', 'root_thread_id', 'review_id', 'attempt', 'lane_id',
    'child_thread_id', 'scope_hash', 'payload_digest', 'tool_event_ref', 'nonce', 'published_at',
  ]);
}

export function validatePostToolPublication(input: {
  review: ReviewRecord;
  lane: LaneRecord;
  proposal: LaneResultProposal;
  publication: unknown;
  consumedToolEventRefs: ReadonlySet<string>;
}): ResultPostToolPublication {
  if (!exactPublication(input.publication)) throw new Error('atomic PostTool publication or attestation is malformed');
  const publication = input.publication;
  const activity = publication.activity;
  const attestation = publication.attestation;
  const provenance = input.lane.provenance;
  if (input.lane.status !== 'RUNNING' || provenance === undefined) throw new Error('publication targets an unbound or terminal lane');
  if (publication.publication_id !== input.proposal.idempotency_key
    || activity.schema_version !== 1 || attestation.schema_version !== 1
    || activity.event_kind !== 'RESULT_POST_TOOL'
    || activity.event_ref !== attestation.tool_event_ref
    || input.consumedToolEventRefs.has(attestation.tool_event_ref)) {
    throw new Error('publication identity is reused or does not match the proposal');
  }
  if (activity.session_id !== input.review.session_id
    || attestation.session_id !== input.review.session_id
    || attestation.root_thread_id !== input.review.root_thread_id
    || activity.review_id !== input.review.review_id
    || attestation.review_id !== input.review.review_id
    || activity.attempt !== input.review.current_attempt
    || attestation.attempt !== input.review.current_attempt
    || activity.lane_id !== input.lane.lane_id
    || attestation.lane_id !== input.lane.lane_id
    || activity.child_thread_id !== provenance.thread_id
    || attestation.child_thread_id !== provenance.thread_id) {
    throw new Error('publication session, child, lane, or review identity is invalid');
  }
  if (attestation.scope_hash !== input.proposal.scope_hash
    || attestation.scope_hash !== input.lane.scope_hash
    || attestation.payload_digest !== input.proposal.payload_digest
    || input.proposal.payload_digest !== canonicalLanePayloadDigest(input.proposal.result)) {
    throw new Error('publication scope or payload digest is invalid');
  }
  const published = timestamp(publication.published_at, 'publication');
  if (published !== timestamp(activity.observed_at, 'activity')
    || published !== timestamp(attestation.published_at, 'attestation')) {
    throw new Error('combined publication timestamps conflict');
  }
  if (published > timestamp(input.lane.idle_deadline_at, 'lane deadline')) {
    throw new Error('publication was observed after the idle deadline');
  }
  return publication;
}

function intervalsOverlap(left: LaneProvenance, right: LaneProvenance): boolean {
  const leftStart = timestamp(left.first_seen_at, 'lane first_seen_at');
  const rightStart = timestamp(right.first_seen_at, 'lane first_seen_at');
  const leftEnd = timestamp(left.completed_at, 'lane completed_at');
  const rightEnd = timestamp(right.completed_at, 'lane completed_at');
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

export function validateLaneIndependence(input: {
  lanes: readonly LaneRecord[];
  batched: boolean;
  resume: boolean;
}): string[] {
  const reasons: string[] = [];
  const current = input.lanes.filter((lane) => lane.provenance !== undefined);
  if (current.length !== input.lanes.length) reasons.push('INDEPENDENT_REVIEW_PROVENANCE_MISSING');
  for (const lane of current) {
    if (lane.provenance!.tracker_lane_id !== lane.lane_id) reasons.push(`TRACKER_LANE_MISMATCH:${lane.lane_id}`);
  }
  const threads = current.map((lane) => lane.provenance!.thread_id);
  if (new Set(threads).size !== threads.length) reasons.push('NATIVE_CHILD_THREADS_MUST_BE_DISTINCT');
  const architects = current.filter((lane) => lane.role === 'architect');
  const reviewers = current.filter((lane) => lane.role === 'code-reviewer');
  if (architects.length !== 1 || reviewers.length === 0) reasons.push('REQUIRED_REVIEW_LANES_MISSING');
  if (!input.resume && architects.length === 1 && reviewers.length > 0) {
    const overlaps = reviewers.some((reviewer) => {
      try {
        return intervalsOverlap(architects[0]!.provenance!, reviewer.provenance!);
      } catch {
        return false;
      }
    });
    if (!overlaps) reasons.push(input.batched
      ? 'BATCHED_ARCHITECT_MUST_OVERLAP_FIRST_REVIEWER_WAVE'
      : 'INITIAL_REVIEWER_ARCHITECT_INTERVALS_MUST_OVERLAP');
  }
  return [...new Set(reasons)];
}
