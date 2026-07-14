import type {
  LaneActivityEvent,
  LaneRecord,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewAttempt,
  ReviewRecord,
  ReviewRecordLaneEvent,
  ScopeManifest,
} from './contract.js';
import { buildCapabilityPlan } from './capabilities.js';
import {
  canonicalLanePayloadDigest,
  validateLaneIndependence,
  validateLaneResultEvidence,
  validateLaneStart,
  validatePostToolPublication,
  type NativeTrackerSnapshot,
} from './evidence.js';
import { synthesizeVerdict } from './verdict.js';

export const DEFAULT_LANE_TIMEOUT_MS = 600_000;
export const MIN_LANE_TIMEOUT_MS = 30_000;
export const MAX_LANE_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_CHANGED_LINES = 20_000;
const READINESS_WAIT_MS = 30_000;

export class ReviewCoordinatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReviewCoordinatorError';
    this.code = code;
  }
}

export interface ActivitySnapshot {
  cutoff_at: string;
  events: LaneActivityEvent[];
  publications: ResultPostToolPublication[];
}

function parseTimestamp(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', `${name} timestamp is invalid`);
  return parsed;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(parseTimestamp(timestamp, 'base') + milliseconds).toISOString();
}

function cloneRecord(record: ReviewRecord): ReviewRecord {
  return structuredClone(record);
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_LANE_TIMEOUT_MS || value > MAX_LANE_TIMEOUT_MS) {
    throw new ReviewCoordinatorError(
      'INVALID_CONFIGURATION',
      `lane timeout must be an integer from ${MIN_LANE_TIMEOUT_MS} through ${MAX_LANE_TIMEOUT_MS}`,
    );
  }
  return value;
}

export function resolveLaneTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMX_CODE_REVIEW_LANE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_LANE_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'lane timeout configuration must be a positive integer');
  }
  return boundedTimeout(Number(raw));
}

function assertUniqueLanePlan(lanes: Array<Pick<LaneRecord, 'lane_id' | 'role' | 'batch_id'>>): void {
  if (new Set(lanes.map((lane) => lane.lane_id)).size !== lanes.length) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'required lane ids must be unique');
  }
  if (lanes.some((lane) => (lane.role === 'architect') !== (lane.batch_id === 'global'))) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'lane role and batch plan conflict');
  }
}

export function createInitialReviewRecord(input: {
  review_id: string;
  session_id?: string;
  root_thread_id?: string;
  invocation_turn_id?: string;
  scope: ScopeManifest;
  lane_timeout_ms?: number;
  max_files_per_review?: number;
  max_changed_lines_per_review?: number;
  batches: ReviewRecord['batches'];
  required_lanes: Array<Pick<LaneRecord, 'lane_id' | 'role' | 'batch_id'>>;
  now: Date;
}): ReviewRecord {
  assertUniqueLanePlan(input.required_lanes);
  const timeout = boundedTimeout(input.lane_timeout_ms ?? DEFAULT_LANE_TIMEOUT_MS);
  const now = input.now.toISOString();
  const deadline = new Date(input.now.getTime() + timeout).toISOString();
  const lanes: LaneRecord[] = input.required_lanes.map((planned) => ({
    ...planned,
    scope_hash: input.scope.scope_hash,
    status: 'PENDING',
    attempt: 1,
    timeout_ms: timeout,
    idle_deadline_at: deadline,
    findings: [],
    diagnostic_ids: [],
  }));
  const noChanges = input.scope.files.length === 0;
  const attempt: ReviewAttempt = {
    attempt: 1,
    status: noChanges ? 'FINALIZED' : 'REVIEWING',
    bindings: lanes.map((lane) => ({
      lane_id: lane.lane_id,
      attempt: 1,
      role: lane.role,
      batch_id: lane.batch_id,
    })),
    lane_ids: lanes.map((lane) => lane.lane_id),
    started_at: now,
    updated_at: now,
    ...(noChanges ? { finalized_at: now } : {}),
    ...(noChanges ? {
      verdict: synthesizeVerdict({
        scope_status: input.scope.status,
        evidence_status: 'FULL_EVIDENCE',
        expected_reviewer_lane_ids: [],
        reviewer_lanes: [],
        no_changes: true,
      }),
    } : {}),
    resumable: false,
  };
  const record: ReviewRecord = {
    schema_version: 1,
    revision: 1,
    review_id: input.review_id,
    ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    ...(input.root_thread_id === undefined ? {} : { root_thread_id: input.root_thread_id }),
    ...(input.invocation_turn_id === undefined ? {} : { invocation_turn_id: input.invocation_turn_id }),
    status: noChanges ? 'FINALIZED' : 'REVIEWING',
    current_attempt: 1,
    effective_config: {
      lane_timeout_ms: timeout,
      max_files_per_review: input.max_files_per_review ?? DEFAULT_MAX_FILES,
      max_changed_lines_per_review: input.max_changed_lines_per_review ?? DEFAULT_MAX_CHANGED_LINES,
      accepted_equivalents: [],
    },
    scope: structuredClone(input.scope),
    review_flags: input.batches.length > 1 ? ['BATCHED_REVIEW'] : [],
    batches: structuredClone(input.batches),
    lanes,
    attempt_history: [attempt],
    diagnostics: [],
    ...(attempt.verdict === undefined ? {} : { verdict: attempt.verdict }),
    resumable: false,
    created_at: now,
    updated_at: now,
    ...(noChanges ? { finalized_at: now } : {}),
  };
  return record;
}

function currentAttempt(record: ReviewRecord): ReviewAttempt {
  const attempt = record.attempt_history.find((candidate) => candidate.attempt === record.current_attempt);
  if (attempt === undefined) throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'current attempt record is missing');
  return attempt;
}

function currentLane(record: ReviewRecord, laneId: string): LaneRecord {
  const candidates = record.lanes.filter((lane) => lane.lane_id === laneId && lane.attempt <= record.current_attempt);
  const lane = candidates.sort((left, right) => right.attempt - left.attempt)[0];
  if (lane === undefined) throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', `unknown lane: ${laneId}`);
  return lane;
}

function advanceRevision(record: ReviewRecord, now: string): void {
  record.revision += 1;
  record.updated_at = now;
  const attempt = currentAttempt(record);
  attempt.updated_at = now;
}

export function applyLaneStart(input: {
  review: ReviewRecord;
  event: Extract<ReviewRecordLaneEvent, { event: 'START' }>;
  tracker: NativeTrackerSnapshot | undefined;
  now: Date;
}): ReviewRecord {
  const { event } = input;
  if (event.review_id !== input.review.review_id || event.attempt !== input.review.current_attempt) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'START targets the wrong review attempt');
  }
  const existing = currentLane(input.review, event.lane_id);
  if (existing.status === 'RUNNING') {
    if (existing.attempt === event.attempt && existing.provenance?.thread_id === event.thread_id) return input.review;
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'lane is already bound to another thread');
  }
  const bound = new Set(
    input.review.lanes
      .filter((lane) => lane.lane_id !== existing.lane_id && lane.provenance !== undefined)
      .map((lane) => lane.provenance!.thread_id),
  );
  let provenance;
  try {
    provenance = validateLaneStart({
      review: input.review,
      lane: existing,
      thread_id: event.thread_id,
      tracker: input.tracker,
      alreadyBoundThreadIds: bound,
    });
  } catch (error) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  const output = cloneRecord(input.review);
  const lane = currentLane(output, event.lane_id);
  lane.status = 'RUNNING';
  lane.provenance = provenance;
  lane.idle_deadline_at = addMilliseconds(provenance.first_seen_at, lane.timeout_ms);
  const binding = currentAttempt(output).bindings.find((candidate) => candidate.lane_id === event.lane_id);
  if (binding === undefined) throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'planned lane binding is missing');
  binding.thread_id = event.thread_id;
  advanceRevision(output, input.now.toISOString());
  return output;
}

function sameProposalIdentity(
  proposal: LaneResultProposal,
  event: Extract<ReviewRecordLaneEvent, { event: 'RESULT' }>,
): boolean {
  return proposal.review_id === event.review_id
    && proposal.attempt === event.attempt
    && proposal.lane_id === event.lane_id
    && proposal.scope_hash === event.scope_hash
    && proposal.idempotency_key === event.idempotency_key
    && proposal.payload_digest === canonicalLanePayloadDigest(event.result);
}

export function createLaneResultProposal(input: {
  review: ReviewRecord;
  event: Extract<ReviewRecordLaneEvent, { event: 'RESULT' }>;
  source: 'MCP' | 'CLI';
  now: Date;
  existingProposal?: LaneResultProposal;
}): LaneResultProposal {
  const { event } = input;
  if (input.existingProposal !== undefined) {
    if (!sameProposalIdentity(input.existingProposal, event)) {
      throw new ReviewCoordinatorError('IDEMPOTENCY_CONFLICT', 'existing proposal identity or scope conflicts');
    }
    return input.existingProposal;
  }
  if (input.source === 'CLI') {
    throw new ReviewCoordinatorError('MCP_TRANSPORT_DEAD', 'CLI cannot initiate a fresh RESULT proposal');
  }
  if (event.review_id !== input.review.review_id || event.attempt !== input.review.current_attempt) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'late RESULT targets an old or foreign attempt');
  }
  const lane = currentLane(input.review, event.lane_id);
  if (lane.status !== 'RUNNING' || lane.attempt !== event.attempt) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT requires a currently running, bound lane');
  }
  if (event.scope_hash !== lane.scope_hash || event.scope_hash !== input.review.scope?.scope_hash) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT scope hash conflicts with the frozen scope');
  }
  if (event.result.role !== lane.role
    || event.result.lane_id !== lane.lane_id
    || event.result.batch_id !== lane.batch_id
    || event.result.review_id !== input.review.review_id
    || event.result.attempt !== input.review.current_attempt
    || event.result.scope_hash !== lane.scope_hash) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT role, lane, batch, or identity conflicts');
  }
  let digest: string;
  try {
    digest = canonicalLanePayloadDigest(event.result);
  } catch (error) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  return {
    schema_version: 1,
    state: 'PENDING_HOST_ATTESTATION',
    review_id: input.review.review_id,
    attempt: input.review.current_attempt,
    lane_id: lane.lane_id,
    scope_hash: lane.scope_hash,
    idempotency_key: event.idempotency_key,
    payload_digest: digest,
    result: structuredClone(event.result),
    proposed_at: input.now.toISOString(),
  };
}

function compareActivity(left: LaneActivityEvent, right: LaneActivityEvent): number {
  return parseTimestamp(left.observed_at, 'activity') - parseTimestamp(right.observed_at, 'activity')
    || Buffer.from(left.event_ref).compare(Buffer.from(right.event_ref));
}

function invalidLane(lane: LaneRecord): void {
  lane.status = 'INVALID';
  lane.failure_code = 'LANE_EVIDENCE_INVALID';
}

function foldLaneEvents(lane: LaneRecord, record: ReviewRecord, events: LaneActivityEvent[], cutoff: number): boolean {
  if (lane.status !== 'RUNNING' || lane.provenance === undefined) return false;
  const relevant = events.filter((event) =>
    event.lane_id === lane.lane_id || event.child_thread_id === lane.provenance!.thread_id,
  );
  const newEvents = relevant.filter((event) => {
    if (lane.last_processed_activity_at === undefined || lane.last_processed_activity_ref === undefined) return true;
    const time = parseTimestamp(event.observed_at, 'activity');
    const last = parseTimestamp(lane.last_processed_activity_at, 'last activity');
    return time > last || (time === last && Buffer.from(event.event_ref).compare(Buffer.from(lane.last_processed_activity_ref)) > 0);
  }).sort(compareActivity);
  const seen = new Set<string>();
  let changed = false;
  for (const event of newEvents) {
    const observed = parseTimestamp(event.observed_at, 'activity');
    const invalid = event.schema_version !== 1
      || event.session_id !== record.session_id
      || event.review_id !== record.review_id
      || event.attempt !== record.current_attempt
      || event.lane_id !== lane.lane_id
      || event.child_thread_id !== lane.provenance.thread_id
      || observed < parseTimestamp(lane.provenance.first_seen_at, 'first_seen_at')
      || observed > cutoff
      || seen.has(event.event_ref);
    if (invalid) {
      invalidLane(lane);
      return true;
    }
    seen.add(event.event_ref);
    const deadline = parseTimestamp(lane.idle_deadline_at, 'lane deadline');
    if (observed > deadline) {
      lane.status = 'TIMED_OUT';
      lane.failure_code = 'LANE_TIMED_OUT';
      return true;
    }
    lane.last_processed_activity_ref = event.event_ref;
    lane.last_processed_activity_at = event.observed_at;
    lane.last_heartbeat_at = event.observed_at;
    lane.idle_deadline_at = new Date(observed + lane.timeout_ms).toISOString();
    changed = true;
  }
  if (cutoff > parseTimestamp(lane.idle_deadline_at, 'lane deadline')) {
    lane.status = 'TIMED_OUT';
    lane.failure_code = 'LANE_TIMED_OUT';
    return true;
  }
  return changed;
}

export function foldActivitySnapshot(input: {
  review: ReviewRecord;
  snapshot: ActivitySnapshot;
}): ReviewRecord {
  const cutoff = parseTimestamp(input.snapshot.cutoff_at, 'snapshot cutoff');
  const output = cloneRecord(input.review);
  let changed = false;
  for (const lane of output.lanes.filter((candidate) => candidate.attempt === output.current_attempt)) {
    if (foldLaneEvents(lane, output, input.snapshot.events, cutoff)) changed = true;
  }
  if (changed) advanceRevision(output, input.snapshot.cutoff_at);
  return changed ? output : input.review;
}

export async function waitForLaneRunning(input: {
  load: () => ReviewRecord | Promise<ReviewRecord>;
  lane_id: string;
  now: () => Date;
  waitForChange: (deadline_at: string) => void | Promise<void>;
  maximum_wait_ms?: number;
}): Promise<LaneRecord> {
  const maximum = Math.min(READINESS_WAIT_MS, Math.max(0, input.maximum_wait_ms ?? READINESS_WAIT_MS));
  const deadline = input.now().getTime() + maximum;
  while (true) {
    const record = await input.load();
    const lane = record.lanes.find((candidate) => candidate.lane_id === input.lane_id && candidate.attempt === record.current_attempt);
    if (lane?.status === 'RUNNING') return lane;
    if (lane !== undefined && lane.status !== 'PENDING') {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', `lane readiness ended in ${lane.status}`);
    }
    if (input.now().getTime() >= deadline) {
      throw new ReviewCoordinatorError('LANE_TIMED_OUT', 'lane readiness timeout expired');
    }
    await input.waitForChange(new Date(deadline).toISOString());
  }
}

function filesForLane(record: ReviewRecord, lane: LaneRecord) {
  if (lane.batch_id === 'global') return record.scope?.files ?? [];
  const files = new Set(record.batches.find((batch) => batch.batch_id === lane.batch_id)?.files ?? []);
  return (record.scope?.files ?? []).filter((file) => files.has(file.path));
}

export function reconcileResultPublications(input: {
  review: ReviewRecord;
  proposals: readonly LaneResultProposal[];
  snapshot: ActivitySnapshot;
  consumedToolEventRefs: ReadonlySet<string>;
  now: Date;
}): ReviewRecord {
  const publicationEvents = input.snapshot.publications.map((publication) => {
    if (publication === null || typeof publication !== 'object' || publication.activity === undefined) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'atomic publication is missing activity or attestation');
    }
    return publication.activity;
  });
  let output = foldActivitySnapshot({
    review: input.review,
    snapshot: { ...input.snapshot, events: [...input.snapshot.events, ...publicationEvents] },
  });
  const activityChanged = output !== input.review;
  output = cloneRecord(output);
  const consumed = new Set(input.consumedToolEventRefs);
  const publicationIds = input.snapshot.publications.map((publication) => publication.publication_id);
  if (new Set(publicationIds).size !== publicationIds.length) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'duplicate atomic PostTool publication');
  }
  let changed = activityChanged;
  for (const publication of input.snapshot.publications) {
    const proposals = input.proposals.filter((proposal) => proposal.idempotency_key === publication.publication_id);
    if (proposals.length !== 1) continue;
    const proposal = proposals[0]!;
    const lane = currentLane(output, proposal.lane_id);
    if (lane.status === 'TIMED_OUT' || lane.status === 'FAILED' || lane.status === 'INVALID') continue;
    let validatedPublication;
    try {
      validatedPublication = validatePostToolPublication({
        review: output,
        lane,
        proposal,
        publication,
        consumedToolEventRefs: consumed,
      });
    } catch (error) {
      if ((error as Error).message.includes('after the idle deadline')) {
        lane.status = 'TIMED_OUT';
        lane.failure_code = 'LANE_TIMED_OUT';
        changed = true;
        continue;
      }
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
    }
    const evidence = validateLaneResultEvidence({
      review: output,
      lane,
      result: proposal.result,
      ...(lane.role === 'code-reviewer' ? { capabilityPlan: buildCapabilityPlan(filesForLane(output, lane)) } : {}),
      toolEvents: [],
    });
    if (!evidence.valid || evidence.result === undefined) {
      invalidLane(lane);
      changed = true;
      continue;
    }
    lane.status = 'COMPLETE';
    lane.findings = evidence.result.findings;
    lane.diagnostic_ids = evidence.diagnostics.map((diagnostic) => diagnostic.diagnostic_id);
    if (evidence.result.role === 'code-reviewer') lane.recommendation = evidence.result.recommendation;
    else lane.architectural_status = evidence.result.architectural_status;
    if (evidence.evidence_status === 'DEGRADED_EVIDENCE') lane.failure_code = 'DIAGNOSTIC_DEGRADED';
    if (lane.provenance !== undefined) lane.provenance.completed_at = validatedPublication.published_at;
    output.diagnostics.push(...evidence.diagnostics);
    consumed.add(validatedPublication.attestation.tool_event_ref);
    changed = true;
  }
  const currentLanes = output.lanes.filter((lane) => lane.attempt === output.current_attempt
    || (lane.status === 'COMPLETE' && currentAttempt(output).lane_ids.includes(lane.lane_id)));
  if (currentLanes.length === currentAttempt(output).lane_ids.length
    && currentLanes.every((lane) => lane.status === 'COMPLETE')) {
    output.status = 'READY_TO_SYNTHESIZE';
    currentAttempt(output).status = 'READY_TO_SYNTHESIZE';
    changed = true;
  }
  if (changed) advanceRevision(output, input.now.toISOString());
  return changed ? output : input.review;
}

export function resumeReview(input: {
  review: ReviewRecord;
  current_scope_hash: string;
  now: Date;
}): ReviewRecord {
  if (input.review.scope?.scope_hash !== input.current_scope_hash) {
    throw new ReviewCoordinatorError('SCOPE_DRIFT', 'scope hash changed before resume');
  }
  if (input.review.status !== 'BLOCKED' || !input.review.resumable || input.review.resumable_reason === undefined) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'review is not explicitly resumable');
  }
  const output = cloneRecord(input.review);
  const nextAttempt = output.current_attempt + 1;
  const now = input.now.toISOString();
  const replaceStatuses = new Set(['FAILED', 'TIMED_OUT', 'INVALID', 'PENDING', 'RUNNING']);
  output.lanes = output.lanes.map((lane) => {
    if (!replaceStatuses.has(lane.status)) return lane;
    return {
      lane_id: lane.lane_id,
      role: lane.role,
      batch_id: lane.batch_id,
      scope_hash: lane.scope_hash,
      status: 'PENDING',
      attempt: nextAttempt,
      timeout_ms: lane.timeout_ms,
      idle_deadline_at: new Date(input.now.getTime() + lane.timeout_ms).toISOString(),
      findings: [],
      diagnostic_ids: [],
    };
  });
  const attempt: ReviewAttempt = {
    attempt: nextAttempt,
    status: 'REVIEWING',
    bindings: output.lanes.map((lane) => ({
      lane_id: lane.lane_id,
      attempt: lane.attempt,
      role: lane.role,
      batch_id: lane.batch_id,
      ...(lane.provenance === undefined ? {} : { thread_id: lane.provenance.thread_id }),
    })),
    lane_ids: output.lanes.map((lane) => lane.lane_id),
    started_at: now,
    updated_at: now,
    resumable: false,
  };
  output.current_attempt = nextAttempt;
  output.status = 'REVIEWING';
  output.resumable = false;
  delete output.resumable_reason;
  output.attempt_history.push(attempt);
  advanceRevision(output, now);
  return output;
}

export function finalizeReview(input: {
  review: ReviewRecord;
  current_scope_hash: string;
  now: Date;
}): ReviewRecord {
  if (input.review.scope?.scope_hash !== input.current_scope_hash) {
    throw new ReviewCoordinatorError('SCOPE_DRIFT', 'scope hash changed before finalization');
  }
  if (input.review.status === 'FINALIZED') return input.review;
  const attempt = currentAttempt(input.review);
  const lanes = attempt.lane_ids.map((laneId) => currentLane(input.review, laneId));
  if (lanes.some((lane) => lane.status === 'PENDING' || lane.status === 'RUNNING')) {
    throw new ReviewCoordinatorError('MISSING_LANE', 'every planned lane must reach a terminal state before finalization');
  }
  const reviewers = lanes.filter((lane) => lane.role === 'code-reviewer');
  const architect = lanes.find((lane) => lane.role === 'architect');
  const failures = [
    ...lanes
      .filter((lane) => lane.status !== 'COMPLETE')
      .map((lane) => lane.failure_code ?? `MISSING_LANE:${lane.lane_id}`),
    ...validateLaneIndependence({
      lanes: lanes.filter((lane) => lane.status === 'COMPLETE'),
      batched: input.review.review_flags.includes('BATCHED_REVIEW'),
      resume: input.review.current_attempt > 1,
    }),
  ];
  const evidenceStatus = reviewers.some((lane) => lane.failure_code === 'DIAGNOSTIC_DEGRADED')
    ? 'DEGRADED_EVIDENCE'
    : 'FULL_EVIDENCE';
  const verdict = synthesizeVerdict({
    scope_status: input.review.scope?.status ?? 'PARTIAL_SCOPE',
    evidence_status: evidenceStatus,
    expected_reviewer_lane_ids: lanes.filter((lane) => lane.role === 'code-reviewer').map((lane) => lane.lane_id),
    reviewer_lanes: reviewers,
    architect_lane: architect,
    failures,
    diagnostic_failure: reviewers.some((lane) => lane.failure_code === 'DIAGNOSTIC_FAILED'),
  });
  const output = cloneRecord(input.review);
  const now = input.now.toISOString();
  output.verdict = verdict;
  output.status = verdict.recommendation === 'REQUEST CHANGES' ? 'BLOCKED' : 'FINALIZED';
  output.finalized_at = now;
  const outputAttempt = currentAttempt(output);
  outputAttempt.status = output.status;
  outputAttempt.verdict = verdict;
  outputAttempt.finalized_at = now;
  const resumableLane = lanes.find((lane) => lane.status === 'FAILED' || lane.status === 'TIMED_OUT' || lane.status === 'INVALID');
  output.resumable = output.status === 'BLOCKED' && resumableLane !== undefined;
  outputAttempt.resumable = output.resumable;
  if (resumableLane !== undefined) {
    const reason = resumableLane.status === 'FAILED'
      ? 'LANE_FAILED'
      : resumableLane.status === 'TIMED_OUT'
        ? 'LANE_TIMED_OUT'
        : 'LANE_EVIDENCE_INVALID';
    output.resumable_reason = reason;
    outputAttempt.resumable_reason = reason;
  }
  advanceRevision(output, now);
  return output;
}
