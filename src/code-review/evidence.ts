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
  ReviewAttempt,
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
  schema_version: 1;
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
  schema_version: 1;
  session_id: string;
  review_id: string;
  attempt: number;
  lane_id: string;
  child_thread_id: string;
  event_ref: string;
  observed_at: string;
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

function hasStructuredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function boundedString(value: unknown, name: string, maximum = 160): string {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maximum
    || value.includes('\0') || /[\r\n]/u.test(value)) {
    throw new Error(`${name} must be a bounded string`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function hash(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 64);
  if (!/^[0-9a-f]{64}$/u.test(parsed)) throw new Error(`${name} must be a lower-case SHA-256 digest`);
  return parsed;
}

function uuid(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed)) {
    throw new Error(`${name} must be a cryptographic UUID`);
  }
  return parsed.toLowerCase();
}

function timestampString(value: unknown, name: string): string {
  const parsed = boundedString(value, name, 64);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${name} timestamp is invalid`);
  return parsed;
}

function boundedArgs(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error(`${name} must be a bounded array`);
  return value.map((item) => boundedString(item, name, REVIEW_LIMITS.path));
}

function parseNativeTracker(value: unknown): NativeTrackerSnapshot {
  if (!isPlainObject(value) || !hasStructuredKeys(value, [
    'schema_version', 'session_id', 'thread_id', 'tracker_lane_id', 'tracker_path', 'first_seen_at',
  ], ['last_seen_at', 'completed_at', 'agent_id']) || value.schema_version !== 1) {
    throw new Error('hook-owned tracker schema or fields are invalid');
  }
  const firstSeen = timestampString(value.first_seen_at, 'tracker first_seen_at');
  const lastSeen = value.last_seen_at === undefined ? undefined : timestampString(value.last_seen_at, 'tracker last_seen_at');
  const completed = value.completed_at === undefined ? undefined : timestampString(value.completed_at, 'tracker completed_at');
  if ((lastSeen !== undefined && Date.parse(lastSeen) < Date.parse(firstSeen))
    || (completed !== undefined && Date.parse(completed) < Date.parse(firstSeen))) {
    throw new Error('tracker timestamps are stale');
  }
  return {
    schema_version: 1,
    session_id: boundedString(value.session_id, 'tracker session_id'),
    thread_id: boundedString(value.thread_id, 'tracker thread_id'),
    tracker_lane_id: boundedString(value.tracker_lane_id, 'tracker lane_id'),
    tracker_path: boundedString(value.tracker_path, 'tracker path', REVIEW_LIMITS.path),
    first_seen_at: firstSeen,
    ...(lastSeen === undefined ? {} : { last_seen_at: lastSeen }),
    ...(completed === undefined ? {} : { completed_at: completed }),
    ...(value.agent_id === undefined ? {} : { agent_id: boundedString(value.agent_id, 'tracker agent_id') }),
  };
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
  tracker: unknown;
  alreadyBoundThreadIds: ReadonlySet<string>;
}): LaneProvenance {
  const { review, lane } = input;
  if (input.tracker === undefined) throw new Error('hook-owned tracker provenance is missing');
  const tracker = parseNativeTracker(input.tracker);
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

export function parseDiagnosticToolEvents(value: unknown): DiagnosticToolEvent[] {
  if (!Array.isArray(value) || value.length > 1_024) throw new Error('diagnostic tool events must be a bounded array');
  const seen = new Set<string>();
  return value.map((candidate): DiagnosticToolEvent => {
    if (!isPlainObject(candidate) || !hasStructuredKeys(candidate, [
      'schema_version', 'session_id', 'review_id', 'attempt', 'lane_id', 'child_thread_id',
      'event_ref', 'observed_at',
    ], ['tool_name', 'program', 'args']) || candidate.schema_version !== 1) {
      throw new Error('diagnostic tool event schema or fields are malformed');
    }
    const toolName = candidate.tool_name === undefined
      ? undefined
      : boundedString(candidate.tool_name, 'diagnostic tool_name');
    const program = candidate.program === undefined
      ? undefined
      : boundedString(candidate.program, 'diagnostic program', REVIEW_LIMITS.path);
    const args = candidate.args === undefined ? undefined : boundedArgs(candidate.args, 'diagnostic args');
    if ((toolName === undefined) === (program === undefined) || (toolName !== undefined && args !== undefined)) {
      throw new Error('diagnostic tool event must contain exactly one provenance form');
    }
    const eventRef = boundedString(candidate.event_ref, 'diagnostic event_ref', REVIEW_LIMITS.path);
    if (seen.has(eventRef)) throw new Error('diagnostic event_ref is duplicated');
    seen.add(eventRef);
    return {
      schema_version: 1,
      session_id: boundedString(candidate.session_id, 'diagnostic session_id'),
      review_id: uuid(candidate.review_id, 'diagnostic review_id'),
      attempt: positiveInteger(candidate.attempt, 'diagnostic attempt'),
      lane_id: boundedString(candidate.lane_id, 'diagnostic lane_id'),
      child_thread_id: boundedString(candidate.child_thread_id, 'diagnostic child_thread_id'),
      event_ref: eventRef,
      observed_at: timestampString(candidate.observed_at, 'diagnostic observed_at'),
      ...(toolName === undefined ? {} : { tool_name: toolName }),
      ...(program === undefined ? {} : { program }),
      ...(args === undefined ? {} : { args }),
    };
  });
}

function diagnosticProvenanceMatches(
  diagnostic: DiagnosticSubmission,
  event: DiagnosticToolEvent,
  review: ReviewRecord,
  lane: LaneRecord,
): boolean {
  if (event.session_id !== review.session_id
    || event.review_id !== review.review_id
    || event.attempt !== review.current_attempt
    || event.lane_id !== lane.lane_id
    || event.child_thread_id !== lane.provenance?.thread_id
    || Date.parse(event.observed_at) < Date.parse(lane.provenance.first_seen_at)
    || Date.parse(event.observed_at) > Date.parse(lane.idle_deadline_at)) return false;
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
    result.diagnostics.map((diagnostic) => diagnostic.execution === 'ACCEPTED_EQUIVALENT'
      ? {
          capability: diagnostic.capability,
          execution: diagnostic.execution,
          outcome: diagnostic.outcome,
          source_ref: diagnostic.source_ref,
          program: diagnostic.program,
          args: diagnostic.args,
        }
      : {
          capability: diagnostic.capability,
          execution: diagnostic.execution,
          outcome: diagnostic.outcome,
        }),
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
      || !diagnosticProvenanceMatches(diagnostic, matches[0]!, input.review, input.lane)) {
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

export function parseLaneActivityEvent(value: unknown): import('./contract.js').LaneActivityEvent {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'session_id', 'review_id', 'attempt', 'lane_id', 'child_thread_id',
    'event_ref', 'event_kind', 'observed_at',
  ]) || value.schema_version !== 1
    || !(['TOOL_START', 'TOOL_END', 'AGENT_PROGRESS', 'RESULT_POST_TOOL'] as const).includes(value.event_kind as never)) {
    throw new Error('activity event schema or fields are malformed');
  }
  return {
    schema_version: 1,
    session_id: boundedString(value.session_id, 'activity session_id'),
    review_id: uuid(value.review_id, 'activity review_id'),
    attempt: positiveInteger(value.attempt, 'activity attempt'),
    lane_id: boundedString(value.lane_id, 'activity lane_id'),
    child_thread_id: boundedString(value.child_thread_id, 'activity child_thread_id'),
    event_ref: boundedString(value.event_ref, 'activity event_ref', REVIEW_LIMITS.path),
    event_kind: value.event_kind as import('./contract.js').LaneActivityEvent['event_kind'],
    observed_at: timestampString(value.observed_at, 'activity observed_at'),
  };
}

function parsePublication(value: unknown): ResultPostToolPublication {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'schema_version', 'publication_id', 'published_at', 'activity', 'attestation',
  ]) || value.schema_version !== 1 || !isPlainObject(value.attestation)) {
    throw new Error('atomic PostTool publication or attestation is malformed');
  }
  const activity = parseLaneActivityEvent(value.activity);
  if (activity.event_kind !== 'RESULT_POST_TOOL' || !hasExactKeys(value.attestation, [
    'schema_version', 'session_id', 'root_thread_id', 'review_id', 'attempt', 'lane_id',
    'child_thread_id', 'scope_hash', 'payload_digest', 'tool_event_ref', 'nonce', 'published_at',
  ]) || value.attestation.schema_version !== 1) {
    throw new Error('atomic PostTool publication activity or attestation is malformed');
  }
  const nonce = boundedString(value.attestation.nonce, 'attestation nonce', 160);
  if (!/^[A-Za-z0-9_-]{8,160}$/u.test(nonce)) throw new Error('attestation nonce format is invalid');
  return {
    schema_version: 1,
    publication_id: uuid(value.publication_id, 'publication_id'),
    published_at: timestampString(value.published_at, 'publication published_at'),
    activity: { ...activity, event_kind: 'RESULT_POST_TOOL' },
    attestation: {
      schema_version: 1,
      session_id: boundedString(value.attestation.session_id, 'attestation session_id'),
      root_thread_id: boundedString(value.attestation.root_thread_id, 'attestation root_thread_id'),
      review_id: uuid(value.attestation.review_id, 'attestation review_id'),
      attempt: positiveInteger(value.attestation.attempt, 'attestation attempt'),
      lane_id: boundedString(value.attestation.lane_id, 'attestation lane_id'),
      child_thread_id: boundedString(value.attestation.child_thread_id, 'attestation child_thread_id'),
      scope_hash: hash(value.attestation.scope_hash, 'attestation scope_hash'),
      payload_digest: hash(value.attestation.payload_digest, 'attestation payload_digest'),
      tool_event_ref: boundedString(value.attestation.tool_event_ref, 'attestation tool_event_ref', REVIEW_LIMITS.path),
      nonce,
      published_at: timestampString(value.attestation.published_at, 'attestation published_at'),
    },
  };
}

export function validatePostToolPublication(input: {
  review: ReviewRecord;
  lane: LaneRecord;
  proposal: LaneResultProposal;
  publication: unknown;
  consumedToolEventRefs: ReadonlySet<string>;
}): ResultPostToolPublication {
  const publication = parsePublication(input.publication);
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
  uuid(input.proposal.idempotency_key, 'proposal idempotency_key');
  uuid(input.proposal.review_id, 'proposal review_id');
  positiveInteger(input.proposal.attempt, 'proposal attempt');
  boundedString(input.proposal.lane_id, 'proposal lane_id');
  hash(input.proposal.scope_hash, 'proposal scope_hash');
  hash(input.proposal.payload_digest, 'proposal payload_digest');
  timestampString(input.proposal.proposed_at, 'proposal proposed_at');
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
  attempt: ReviewAttempt;
}): string[] {
  const reasons: string[] = [];
  const current = input.lanes.filter((lane) => lane.provenance !== undefined);
  if (current.length !== input.lanes.length) reasons.push('INDEPENDENT_REVIEW_PROVENANCE_MISSING');
  for (const lane of current) {
    if (lane.provenance!.tracker_lane_id !== lane.lane_id) reasons.push(`TRACKER_LANE_MISMATCH:${lane.lane_id}`);
    try {
      if (timestamp(lane.provenance!.first_seen_at, 'lane first_seen_at')
        > timestamp(lane.provenance!.completed_at, 'lane completed_at')) {
        reasons.push(`LANE_PROVENANCE_INTERVAL_INVALID:${lane.lane_id}`);
      }
    } catch {
      reasons.push(`LANE_PROVENANCE_INTERVAL_INVALID:${lane.lane_id}`);
    }
    if (input.attempt.lane_ids.filter((laneId) => laneId === lane.lane_id).length !== 1
      || lane.attempt > input.attempt.attempt
      || (!input.resume && lane.attempt !== input.attempt.attempt)) {
      reasons.push(`ATTEMPT_LANE_IDENTITY_MISMATCH:${lane.lane_id}`);
    }
    const bindings = input.attempt.bindings.filter((binding) =>
      binding.lane_id === lane.lane_id && binding.attempt === lane.attempt);
    if (bindings.length !== 1) {
      reasons.push(`ATTEMPT_BINDING_MISSING_OR_DUPLICATE:${lane.lane_id}`);
    } else {
      const binding = bindings[0]!;
      if (binding.role !== lane.role
        || binding.batch_id !== lane.batch_id
        || binding.thread_id !== lane.provenance!.thread_id) {
        reasons.push(`ATTEMPT_BINDING_PROVENANCE_MISMATCH:${lane.lane_id}`);
      }
    }
  }
  const threads = current.map((lane) => lane.provenance!.thread_id);
  if (new Set(threads).size !== threads.length) reasons.push('NATIVE_CHILD_THREADS_MUST_BE_DISTINCT');
  const architects = current.filter((lane) => lane.role === 'architect');
  const reviewers = current.filter((lane) => lane.role === 'code-reviewer');
  if (architects.length !== 1 || reviewers.length === 0) reasons.push('REQUIRED_REVIEW_LANES_MISSING');
  if (architects.length === 1 && reviewers.length > 0) {
    const architect = architects[0]!;
    const reviewersRequiringOverlap = input.resume
      ? reviewers.filter((reviewer) =>
          reviewer.attempt === input.attempt.attempt && architect.attempt === input.attempt.attempt)
      : reviewers;
    const overlapRequired = !input.resume || reviewersRequiringOverlap.length > 0;
    const overlaps = reviewersRequiringOverlap.some((reviewer) => {
      try {
        return intervalsOverlap(architect.provenance!, reviewer.provenance!);
      } catch {
        return false;
      }
    });
    if (overlapRequired && !overlaps) reasons.push(input.batched
      ? 'BATCHED_ARCHITECT_MUST_OVERLAP_FIRST_REVIEWER_WAVE'
      : input.resume
        ? 'REPLACEMENT_REVIEWER_ARCHITECT_INTERVALS_MUST_OVERLAP'
        : 'INITIAL_REVIEWER_ARCHITECT_INTERVALS_MUST_OVERLAP');
  }
  return [...new Set(reasons)];
}
