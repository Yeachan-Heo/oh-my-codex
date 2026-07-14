import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { BatchPlan } from './batching.js';
import { buildCapabilityPlan } from './capabilities.js';
import {
  canonicalLanePayloadDigest,
  parseDiagnosticToolEvents,
  parseLaneActivityEvent,
  validateLaneIndependence,
  validateLaneResultEvidence,
  validateLaneStart,
  validatePostToolPublication,
} from './evidence.js';
import {
  recoverPendingReviewTransactions,
  resolveReviewPersistencePaths,
  runDurableTransaction,
  type DurableTransactionBoundary,
  type DurableTransactionEffect,
  type ReviewPersistenceContext,
  type ReviewPersistencePaths,
} from './persistence.js';
import { synthesizeVerdict } from './verdict.js';
import { projectFinalReviewArtifact } from './render.js';

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
  events: unknown[];
  publications: unknown[];
  diagnostic_events?: unknown[];
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

function validateBatchPlan(scope: ScopeManifest, plan: BatchPlan): BatchPlan {
  if (!Array.isArray(plan.review_flags)
    || plan.review_flags.some((flag) => flag !== 'BATCHED_REVIEW')
    || new Set(plan.review_flags).size !== plan.review_flags.length
    || !Array.isArray(plan.batches)
    || !Array.isArray(plan.required_lanes)) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'batch plan collections or flags are invalid');
  }
  const batchIds = plan.batches.map((batch) => batch.batch_id);
  if (new Set(batchIds).size !== batchIds.length || batchIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'batch ids must be unique and non-empty');
  }
  const expectedFiles = scope.files.map((file) => file.path).sort();
  const actualFiles = plan.batches.flatMap((batch) => {
    if (typeof batch.module_root !== 'string' || batch.module_root.length === 0
      || !Array.isArray(batch.files) || new Set(batch.files).size !== batch.files.length
      || !Number.isSafeInteger(batch.changed_lines) || batch.changed_lines < 0
      || typeof batch.oversized_single_file !== 'boolean') {
      throw new ReviewCoordinatorError('INVALID_CONFIGURATION', `batch ${batch.batch_id} is malformed`);
    }
    return batch.files;
  }).sort();
  if (expectedFiles.length !== actualFiles.length
    || expectedFiles.some((path, index) => path !== actualFiles[index])) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'batch plan must exactly cover the frozen scope');
  }
  const laneIds = plan.required_lanes.map((lane) => lane.lane_id);
  if (new Set(laneIds).size !== laneIds.length) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'required lane ids must be unique');
  }
  const reviewers = plan.required_lanes.filter((lane) => lane.role === 'code-reviewer');
  const architects = plan.required_lanes.filter((lane) => lane.role === 'architect');
  const reviewerBatchIds = reviewers.map((lane) => lane.batch_id);
  if (reviewers.length !== plan.batches.length
    || new Set(reviewerBatchIds).size !== reviewerBatchIds.length
    || reviewerBatchIds.some((batchId) => batchId === 'global' || !batchIds.includes(batchId))
    || batchIds.some((batchId) => !reviewerBatchIds.includes(batchId))) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'reviewer lanes must match planned batches exactly once');
  }
  if (architects.length !== 1
    || architects.some((lane) => lane.batch_id !== 'global')) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'batch plan requires exactly one global architect lane');
  }
  if (plan.required_lanes.some((lane) => typeof lane.lane_id !== 'string' || lane.lane_id.length === 0
    || (lane.role !== 'code-reviewer' && lane.role !== 'architect'))) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'required lane plan is malformed');
  }
  return structuredClone(plan);
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
  batch_plan: BatchPlan;
  now: Date;
}): ReviewRecord {
  const plan = validateBatchPlan(input.scope, input.batch_plan);
  const timeout = boundedTimeout(input.lane_timeout_ms ?? DEFAULT_LANE_TIMEOUT_MS);
  const now = input.now.toISOString();
  const deadline = new Date(input.now.getTime() + timeout).toISOString();
  const lanes: LaneRecord[] = plan.required_lanes.map((planned) => ({
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
    review_flags: structuredClone(plan.review_flags),
    batches: structuredClone(plan.batches),
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
  tracker: unknown;
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
      || (lane.last_processed_activity_ref === event.event_ref
        && lane.last_processed_activity_at !== undefined
        && observed > parseTimestamp(lane.last_processed_activity_at, 'last activity'))
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
  let events: LaneActivityEvent[];
  try {
    events = input.snapshot.events.map(parseLaneActivityEvent);
  } catch (error) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  const output = cloneRecord(input.review);
  let changed = false;
  for (const lane of output.lanes.filter((candidate) => candidate.attempt === output.current_attempt)) {
    if (foldLaneEvents(lane, output, events, cutoff)) changed = true;
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
  consumedToolEventRefs?: ReadonlySet<string>;
  now: Date;
}): ReviewRecord {
  const cutoff = parseTimestamp(input.snapshot.cutoff_at, 'snapshot cutoff');
  let ordinaryEvents: LaneActivityEvent[];
  let diagnosticEvents;
  try {
    ordinaryEvents = input.snapshot.events.map(parseLaneActivityEvent);
    diagnosticEvents = parseDiagnosticToolEvents(input.snapshot.diagnostic_events ?? []);
  } catch (error) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  const attemptStartedAt = parseTimestamp(currentAttempt(input.review).started_at, 'attempt start');
  for (const event of diagnosticEvents) {
    const observed = parseTimestamp(event.observed_at, 'diagnostic event');
    const claimedLane = input.review.lanes.find((lane) =>
      lane.lane_id === event.lane_id && lane.attempt === event.attempt);
    if (observed > cutoff || observed < attemptStartedAt
      || (claimedLane?.provenance !== undefined
        && observed < parseTimestamp(claimedLane.provenance.first_seen_at, 'lane first_seen_at'))) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'diagnostic event is future or stale for the frozen snapshot');
    }
  }

  const proposalsById = new Map<string, LaneResultProposal>();
  for (const proposal of input.proposals) {
    if (proposalsById.has(proposal.idempotency_key)) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'duplicate RESULT proposal identity');
    }
    proposalsById.set(proposal.idempotency_key, proposal);
  }
  const matchedRaw = input.snapshot.publications.flatMap((publication) => {
    if (publication === null || typeof publication !== 'object' || Array.isArray(publication)) return [];
    const publicationId = (publication as { publication_id?: unknown }).publication_id;
    return typeof publicationId === 'string' && proposalsById.has(publicationId)
      ? [{ publication, proposal: proposalsById.get(publicationId)! }]
      : [];
  });
  if (new Set(matchedRaw.map((pair) => pair.proposal.idempotency_key)).size !== matchedRaw.length) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'duplicate atomic PostTool publication');
  }

  const consumed = new Set(input.review.lanes.flatMap((lane) =>
    lane.last_processed_activity_ref === undefined ? [] : [lane.last_processed_activity_ref]));
  const nonceSet = new Set<string>();
  const validatedPairs: Array<{
    proposal: LaneResultProposal;
    publication: ResultPostToolPublication;
  }> = [];
  const lateLaneIds = new Set<string>();
  for (const pair of matchedRaw) {
    const lane = currentLane(input.review, pair.proposal.lane_id);
    if (lane.status === 'COMPLETE') continue;
    if (lane.status !== 'RUNNING') continue;
    try {
      const publication = validatePostToolPublication({
        review: input.review,
        lane,
        proposal: pair.proposal,
        publication: pair.publication,
        consumedToolEventRefs: consumed,
      });
      if (nonceSet.has(publication.attestation.nonce)) {
        throw new Error('attestation nonce is reused');
      }
      nonceSet.add(publication.attestation.nonce);
      consumed.add(publication.attestation.tool_event_ref);
      validatedPairs.push({ proposal: pair.proposal, publication });
    } catch (error) {
      if ((error as Error).message.includes('after the idle deadline')) {
        lateLaneIds.add(lane.lane_id);
        continue;
      }
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
    }
  }

  const output = cloneRecord(input.review);
  const publicationEvents = validatedPairs.map((pair) => pair.publication.activity);
  let changed = false;
  for (const lane of output.lanes.filter((candidate) => candidate.attempt === output.current_attempt)) {
    if (lateLaneIds.has(lane.lane_id)) {
      lane.status = 'TIMED_OUT';
      lane.failure_code = 'LANE_TIMED_OUT';
      changed = true;
      continue;
    }
    if (foldLaneEvents(lane, output, [...ordinaryEvents, ...publicationEvents], cutoff)) changed = true;
  }

  for (const { proposal, publication } of validatedPairs) {
    const lane = currentLane(output, proposal.lane_id);
    if (lane.status !== 'RUNNING') continue;
    const evidence = validateLaneResultEvidence({
      review: output,
      lane,
      result: proposal.result,
      ...(lane.role === 'code-reviewer' ? { capabilityPlan: buildCapabilityPlan(filesForLane(output, lane)) } : {}),
      toolEvents: diagnosticEvents,
    });
    if (!evidence.valid || evidence.result === undefined) {
      invalidLane(lane);
      changed = true;
      continue;
    }
    if (evidence.evidence_status === 'DEGRADED_EVIDENCE') {
      invalidLane(lane);
      changed = true;
      continue;
    }
    lane.status = 'COMPLETE';
    lane.findings = evidence.result.findings;
    lane.diagnostic_ids = evidence.diagnostics.map((diagnostic) => diagnostic.diagnostic_id);
    lane.last_processed_activity_ref = publication.activity.event_ref;
    lane.last_processed_activity_at = publication.activity.observed_at;
    if (evidence.result.role === 'code-reviewer') lane.recommendation = evidence.result.recommendation;
    else lane.architectural_status = evidence.result.architectural_status;
    if (lane.provenance !== undefined) lane.provenance.completed_at = publication.published_at;
    output.diagnostics.push(...evidence.diagnostics);
    changed = true;
  }
  const attempt = currentAttempt(output);
  const frozenLanes = attempt.lane_ids.map((laneId) => currentLane(output, laneId));
  if (frozenLanes.length === attempt.lane_ids.length
    && frozenLanes.every((lane) => lane.status === 'COMPLETE')
    && output.status !== 'READY_TO_SYNTHESIZE') {
    output.status = 'READY_TO_SYNTHESIZE';
    attempt.status = 'READY_TO_SYNTHESIZE';
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
  if (input.review.status === 'FINALIZED') {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'finalized reviews cannot be resumed');
  }
  if (input.review.status !== 'BLOCKED' || !input.review.resumable || input.review.resumable_reason === undefined) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'review is not explicitly resumable');
  }
  const output = cloneRecord(input.review);
  const priorAttempt = currentAttempt(output);
  const nextAttempt = output.current_attempt + 1;
  const now = input.now.toISOString();
  const usedIds = new Set(output.lanes.map((lane) => lane.lane_id));
  const bindings: ReviewAttempt['bindings'] = [];
  const laneIds: string[] = [];
  for (const binding of priorAttempt.bindings) {
    const existing = output.lanes.find((lane) => lane.lane_id === binding.lane_id && lane.attempt === binding.attempt);
    if (existing?.status === 'COMPLETE') {
      bindings.push(structuredClone(binding));
      laneIds.push(existing.lane_id);
      continue;
    }
    let replacementId = `${binding.lane_id}-resume-${nextAttempt}`;
    let suffix = 2;
    while (usedIds.has(replacementId)) {
      replacementId = `${binding.lane_id}-resume-${nextAttempt}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(replacementId);
    const timeout = existing?.timeout_ms ?? output.effective_config.lane_timeout_ms;
    const replacement: LaneRecord = {
      lane_id: replacementId,
      role: binding.role,
      batch_id: binding.batch_id,
      scope_hash: input.current_scope_hash,
      status: 'PENDING',
      attempt: nextAttempt,
      timeout_ms: timeout,
      idle_deadline_at: new Date(input.now.getTime() + timeout).toISOString(),
      findings: [],
      diagnostic_ids: [],
    };
    output.lanes.push(replacement);
    bindings.push({
      lane_id: replacementId,
      attempt: nextAttempt,
      role: binding.role,
      batch_id: binding.batch_id,
    });
    laneIds.push(replacementId);
  }
  const attempt: ReviewAttempt = {
    attempt: nextAttempt,
    status: 'REVIEWING',
    bindings,
    lane_ids: laneIds,
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
  if (input.review.status === 'FINALIZED'
    || (input.review.status === 'BLOCKED' && input.review.verdict !== undefined && input.review.finalized_at !== undefined)) {
    return input.review;
  }
  const attempt = currentAttempt(input.review);
  const laneByBinding = attempt.bindings.map((binding) => input.review.lanes.find((lane) =>
    lane.lane_id === binding.lane_id && lane.attempt === binding.attempt));
  const lanes = laneByBinding.filter((lane): lane is LaneRecord => lane !== undefined);
  const missingBindings = attempt.bindings.filter((_binding, index) => {
    const lane = laneByBinding[index];
    return lane === undefined || lane.status === 'PENDING' || lane.status === 'RUNNING';
  });
  const reviewers = lanes.filter((lane) => lane.role === 'code-reviewer');
  const architect = lanes.find((lane) => lane.role === 'architect');
  const failures = [
    ...missingBindings.map((binding) => `MISSING_LANE:${binding.lane_id}`),
    ...lanes
      .filter((lane) => lane.status !== 'COMPLETE' && lane.status !== 'PENDING' && lane.status !== 'RUNNING')
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
    expected_reviewer_lane_ids: attempt.bindings.filter((binding) => binding.role === 'code-reviewer').map((binding) => binding.lane_id),
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
  output.resumable = output.status === 'BLOCKED' && (missingBindings.length > 0 || resumableLane !== undefined);
  outputAttempt.resumable = output.resumable;
  if (output.resumable) {
    const reason = missingBindings.length > 0
      ? 'MISSING_LANE'
      : resumableLane!.status === 'FAILED'
      ? 'LANE_FAILED'
      : resumableLane!.status === 'TIMED_OUT'
        ? 'LANE_TIMED_OUT'
        : 'LANE_EVIDENCE_INVALID';
    output.resumable_reason = reason;
    outputAttempt.resumable_reason = reason;
  }
  advanceRevision(output, now);
  return output;
}

function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', `persisted review JSON is malformed: ${path}`);
  }
}

function parsePersistedProposal(value: unknown, review: ReviewRecord): LaneResultProposal {
  if (!isObject(value)) throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'persisted RESULT proposal is malformed');
  const expected = [
    'schema_version', 'state', 'review_id', 'attempt', 'lane_id', 'scope_hash',
    'idempotency_key', 'payload_digest', 'result', 'proposed_at',
  ];
  if (Object.keys(value).length !== expected.length || Object.keys(value).some((key) => !expected.includes(key))
    || value.schema_version !== 1 || value.state !== 'PENDING_HOST_ATTESTATION'
    || value.review_id !== review.review_id || !Number.isSafeInteger(value.attempt) || (value.attempt as number) <= 0
    || typeof value.lane_id !== 'string' || value.lane_id.length === 0 || value.lane_id.length > 160
    || typeof value.scope_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(value.scope_hash)
    || typeof value.idempotency_key !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.idempotency_key)
    || typeof value.payload_digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.payload_digest)
    || typeof value.proposed_at !== 'string' || !Number.isFinite(Date.parse(value.proposed_at))) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'persisted RESULT proposal schema or identity is invalid');
  }
  if (canonicalLanePayloadDigest(value.result) !== value.payload_digest) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'persisted RESULT proposal digest is invalid');
  }
  return value as unknown as LaneResultProposal;
}

function deterministicTransactionId(value: unknown): string {
  const characters = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex').slice(0, 32).split('');
  characters[12] = '4';
  characters[16] = '8';
  const hex = characters.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function reviewEffect(record: ReviewRecord): DurableTransactionEffect {
  return {
    name: 'review',
    mode: 'APPLY_REVIEW_REVISION',
    target: { area: 'REVIEW_STATE', path: `${record.review_id}/review.json` },
    payload: record,
  };
}

async function readPersistedReview(paths: ReviewPersistencePaths, reviewId: string): Promise<ReviewRecord> {
  const value = await readJson(join(paths.reviewRoot, reviewId, 'review.json'));
  if (!isObject(value) || value.review_id !== reviewId || !Number.isSafeInteger(value.revision)) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'persisted review record is missing or malformed');
  }
  if (paths.session_id !== undefined && value.session_id !== paths.session_id) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'persisted review ownership conflicts');
  }
  return value as unknown as ReviewRecord;
}

export interface DurableReviewCoordinator {
  start(input: { record: ReviewRecord; idempotency_key: string; crashAt?: DurableTransactionBoundary }): Promise<ReviewRecord>;
  get(reviewId: string): Promise<ReviewRecord>;
  recordStart(input: {
    event: Extract<ReviewRecordLaneEvent, { event: 'START' }>;
    tracker: unknown;
    now: Date;
  }): Promise<ReviewRecord>;
  recordResult(input: {
    event: Extract<ReviewRecordLaneEvent, { event: 'RESULT' }>;
    source: 'MCP' | 'CLI';
    now: Date;
  }): Promise<LaneResultProposal>;
  reconcile(input: {
    review_id: string;
    snapshot: ActivitySnapshot;
    now: Date;
    crashAt?: DurableTransactionBoundary;
  }): Promise<ReviewRecord>;
  resume(input: { review_id: string; current_scope_hash: string; now: Date; idempotency_key: string }): Promise<ReviewRecord>;
  finalize(input: { review_id: string; current_scope_hash: string; now: Date; idempotency_key: string }): Promise<ReviewRecord>;
}

export function createDurableReviewCoordinator(context: ReviewPersistenceContext): DurableReviewCoordinator {
  let pathsPromise: Promise<ReviewPersistencePaths> | undefined;
  const paths = (): Promise<ReviewPersistencePaths> => {
    pathsPromise ??= resolveReviewPersistencePaths(context);
    return pathsPromise;
  };
  const recoverAndRead = async (reviewId: string): Promise<ReviewRecord> => {
    const resolved = await paths();
    await recoverPendingReviewTransactions(resolved);
    return await readPersistedReview(resolved, reviewId);
  };

  return {
    async start({ record, idempotency_key: idempotencyKey, crashAt }) {
      const resolved = await paths();
      // START-scoped journals are retained and Task 2 revalidates their revision-one
      // review effect on every root scan. A locator-backed REVIEW transaction provides
      // the same create-once allocation and root recovery without becoming stale after
      // the first lane mutation.
      await runDurableTransaction(resolved, {
        idempotency_key: idempotencyKey,
        review_id: record.review_id,
        operation: 'START_REVIEW',
        input: { review_id: record.review_id, scope_hash: record.scope?.scope_hash },
        expected_revision: 0,
        effects: [
          reviewEffect(record),
          {
            name: 'active-overlay',
            mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: record.review_id, status: record.status },
          },
        ],
        response: record,
      }, crashAt === undefined ? {} : { crashAt });
      return await readPersistedReview(resolved, record.review_id);
    },

    async get(reviewId) {
      return await recoverAndRead(reviewId);
    },

    async recordStart({ event, tracker, now }) {
      const resolved = await paths();
      const current = await recoverAndRead(event.review_id);
      const output = applyLaneStart({ review: current, event, tracker, now });
      if (output === current) return current;
      await runDurableTransaction(resolved, {
        idempotency_key: event.idempotency_key,
        review_id: event.review_id,
        operation: 'START_LANE',
        input: event,
        expected_revision: current.revision,
        effects: [
          {
            name: 'lane', mode: 'CREATE_ONCE_JSON',
            target: { area: 'REVIEW_STATE', path: `${event.review_id}/lanes/${event.lane_id}-attempt-${event.attempt}/start` },
            payload: event,
          },
          reviewEffect(output),
        ],
        response: output,
      });
      return await readPersistedReview(resolved, event.review_id);
    },

    async recordResult({ event, source, now }) {
      const resolved = await paths();
      const current = await recoverAndRead(event.review_id);
      const proposalPath = join(resolved.reviewRoot, event.review_id, 'submissions', event.idempotency_key, 'proposal');
      const persisted = await readJson(proposalPath);
      const existingProposal = persisted === undefined ? undefined : parsePersistedProposal(persisted, current);
      const proposal = createLaneResultProposal({
        review: current,
        event,
        source,
        now,
        ...(existingProposal === undefined ? {} : { existingProposal }),
      });
      if (existingProposal !== undefined) return proposal;
      await runDurableTransaction(resolved, {
        idempotency_key: event.idempotency_key,
        review_id: event.review_id,
        operation: 'PROPOSE_LANE_RESULT',
        input: event,
        expected_revision: current.revision,
        effects: [{
          name: 'proposal', mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: `${event.review_id}/submissions/${event.idempotency_key}/proposal` },
          payload: proposal,
        }],
        response: proposal,
      });
      return proposal;
    },

    async reconcile({ review_id: reviewId, snapshot, now, crashAt }) {
      const resolved = await paths();
      await recoverPendingReviewTransactions(resolved);
      const current = await readPersistedReview(resolved, reviewId);
      const persistedProposals: LaneResultProposal[] = [];
      const persistedPublications: unknown[] = [];
      const notifiedIds = new Set(snapshot.publications.flatMap((publication) => {
        if (!isObject(publication) || typeof publication.publication_id !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(publication.publication_id)) return [];
        return [publication.publication_id];
      }));
      for (const id of [...notifiedIds].sort()) {
        const proposalValue = await readJson(join(resolved.reviewRoot, reviewId, 'submissions', id, 'proposal'));
        const publicationValue = await readJson(join(resolved.reviewRoot, reviewId, 'submissions', id, 'post-tool'));
        if (proposalValue === undefined || publicationValue === undefined) continue;
        persistedProposals.push(parsePersistedProposal(proposalValue, current));
        persistedPublications.push(publicationValue);
      }
      const persistedSnapshot: ActivitySnapshot = { ...snapshot, publications: persistedPublications };
      const output = reconcileResultPublications({
        review: current,
        proposals: persistedProposals,
        snapshot: persistedSnapshot,
        now,
      });
      if (output === current) return current;
      const accepted = output.lanes.filter((lane) => {
        const before = current.lanes.find((candidate) => candidate.lane_id === lane.lane_id && candidate.attempt === lane.attempt);
        return lane.status === 'COMPLETE' && before?.status !== 'COMPLETE';
      });
      const key = deterministicTransactionId({
        review_id: reviewId,
        attempt: current.current_attempt,
        cutoff_at: snapshot.cutoff_at,
        publication_refs: accepted.map((lane) => lane.last_processed_activity_ref).sort(),
        revision: current.revision,
      });
      const effects: DurableTransactionEffect[] = [];
      if (accepted.length > 0) {
        effects.push({
          name: 'consume', mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${key}/consumed` },
          payload: { schema_version: 1, state: 'CONSUMED', review_id: reviewId, idempotency_key: key, consumed_at: snapshot.cutoff_at },
        });
      }
      for (const lane of accepted) {
        const proposal = persistedProposals.find((candidate) => candidate.lane_id === lane.lane_id && candidate.attempt === lane.attempt);
        if (proposal === undefined) throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'terminal lane has no durable proposal');
        effects.push({
          name: 'lane', mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: `${reviewId}/lanes/${lane.lane_id}-attempt-${lane.attempt}/terminal` },
          payload: {
            event: 'RESULT', review_id: reviewId, attempt: lane.attempt, lane_id: lane.lane_id,
            scope_hash: lane.scope_hash, result: proposal.result, idempotency_key: key,
          },
        });
      }
      effects.push(reviewEffect(output));
      await runDurableTransaction(resolved, {
        idempotency_key: key,
        review_id: reviewId,
        operation: 'RECONCILE_RESULT_PUBLICATIONS',
        input: { cutoff_at: snapshot.cutoff_at, publication_ids: persistedProposals.map((proposal) => proposal.idempotency_key).sort() },
        expected_revision: current.revision,
        effects,
        response: output,
      }, crashAt === undefined ? {} : { crashAt });
      return await readPersistedReview(resolved, reviewId);
    },

    async resume({ review_id: reviewId, current_scope_hash: currentScopeHash, now, idempotency_key: key }) {
      const resolved = await paths();
      const current = await recoverAndRead(reviewId);
      const output = resumeReview({ review: current, current_scope_hash: currentScopeHash, now });
      await runDurableTransaction(resolved, {
        idempotency_key: key, review_id: reviewId, operation: 'RESUME_REVIEW',
        input: { current_scope_hash: currentScopeHash }, expected_revision: current.revision,
        effects: [
          reviewEffect(output),
          {
            name: 'active-overlay', mode: 'CREATE_ONCE_JSON', target: { area: 'REVIEW_STATE', path: 'active.json' },
            payload: { schema_version: 1, review_id: reviewId, status: 'REVIEWING' },
          },
        ],
        response: output,
      });
      return await readPersistedReview(resolved, reviewId);
    },

    async finalize({ review_id: reviewId, current_scope_hash: currentScopeHash, now, idempotency_key: key }) {
      const resolved = await paths();
      const current = await recoverAndRead(reviewId);
      const output = finalizeReview({ review: current, current_scope_hash: currentScopeHash, now });
      if (output === current) return current;
      await runDurableTransaction(resolved, {
        idempotency_key: key, review_id: reviewId, operation: 'FINALIZE_REVIEW',
        input: { current_scope_hash: currentScopeHash }, expected_revision: current.revision,
        effects: [
          reviewEffect(output),
          { name: 'report', mode: 'CREATE_ONCE_JSON', target: { area: 'FINAL_REVIEWS', path: `${reviewId}.json` }, payload: projectFinalReviewArtifact(output) },
          { name: 'active-overlay', mode: 'REMOVE_MATCHING_ACTIVE', target: { area: 'REVIEW_STATE', path: 'active.json' }, review_id: reviewId },
        ],
        response: output,
      });
      return await readPersistedReview(resolved, reviewId);
    },
  };
}
