import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  LaneActivityEvent,
  LaneRecord,
  LaneResult,
  LaneResultProposal,
  ResultPostToolPublication,
  ReviewAttempt,
  ReviewConsumptionKind,
  ReviewConsumptionMarker,
  ReviewRecord,
  ReviewRecordLaneEvent,
  ScopeManifest,
} from './contract.js';
import type { BatchPlan } from './batching.js';
import { createBatchPlan } from './batching.js';
import { buildCapabilityPlan, parseAcceptedEquivalentRequests } from './capabilities.js';
import { parseCodeReviewArguments } from './arguments.js';
import {
  canonicalLanePayloadDigest,
  parseLaneResultSubmission,
  parseDiagnosticToolEvents,
  parseLaneActivityEvent,
  parsePostToolPublication,
  validateLaneIndependence,
  validateLaneResultEvidence,
  validateLaneStart,
  validatePostToolPublication,
} from './evidence.js';
import { sanitizeForPersistence } from './redaction.js';
import {
  createReviewConsumptionEffect,
  readActiveReview,
  readReviewConsumptionMarkers,
  recoverPendingReviewTransactions,
  resolveReviewPersistencePaths,
  runDurableReviewTransactionWithPlanFactory,
  runDurableTransaction,
  writeFinalReviewArtifacts,
  type DurableTransactionBoundary,
  type DurableTransactionEffect,
  type DurableTransactionPlan,
  type ReviewPersistenceContext,
  type ReviewPersistencePaths,
} from './persistence.js';
import { resolveGitScope, runGitCommand, verifyScopeDrift } from './scope.js';
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

interface TrustedHookJournalSnapshot {
  events: unknown[];
  diagnostic_events: unknown[];
  publication_ids: string[];
}

export interface DurableReviewCoordinatorHostDependencies {
  root_thread_id: string;
  loadHookJournalSnapshot(input: {
    session_id: string;
    root_thread_id: string;
    review_id: string;
    cutoff_at: string;
  }): Promise<unknown>;
  now?: () => Date;
}

export interface PublishedHookJournalSnapshotInput {
  workingDirectory: string;
  session_id: string;
  root_thread_id: string;
  review_id: string;
  cutoff_at: string;
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
  if (scope.files.length === 0) {
    if (scope.changed_lines !== 0
      || plan.review_flags.length !== 0
      || plan.batches.length !== 0
      || plan.required_lanes.length !== 0) {
      throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'an empty scope requires an empty authoritative batch plan');
    }
    return structuredClone(plan);
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
  result: LaneResultProposal['result'],
): boolean {
  return proposal.review_id === event.review_id
    && proposal.attempt === event.attempt
    && proposal.lane_id === event.lane_id
    && proposal.scope_hash === event.scope_hash
    && proposal.idempotency_key === event.idempotency_key
    && proposal.payload_digest === canonicalLanePayloadDigest(result);
}

export function createLaneResultProposal(input: {
  review: ReviewRecord;
  event: Extract<ReviewRecordLaneEvent, { event: 'RESULT' }>;
  source: 'MCP' | 'CLI';
  now: Date;
  existingProposal?: LaneResultProposal;
}): LaneResultProposal {
  const { event } = input;
  if (input.source === 'CLI' && input.existingProposal === undefined) {
    throw new ReviewCoordinatorError('MCP_TRANSPORT_DEAD', 'CLI cannot initiate a fresh RESULT proposal');
  }
  if (event.review_id !== input.review.review_id
    || (input.existingProposal === undefined && event.attempt !== input.review.current_attempt)) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'late RESULT targets an old or foreign attempt');
  }
  const lane = input.review.lanes.find((candidate) =>
    candidate.lane_id === event.lane_id && candidate.attempt === event.attempt);
  if (lane === undefined) throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT targets an unknown lane');
  let result: LaneResultProposal['result'];
  try {
    const parsed = parseLaneResultSubmission({
      review: input.review,
      lane,
      result: event.result,
      expected_attempt: event.attempt,
    });
    result = sanitizeForPersistence(parsed);
  } catch (error) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  if (input.existingProposal !== undefined) {
    if (!sameProposalIdentity(input.existingProposal, event, result)) {
      throw new ReviewCoordinatorError('IDEMPOTENCY_CONFLICT', 'existing proposal identity or scope conflicts');
    }
    return input.existingProposal;
  }
  if (lane.status !== 'RUNNING' || lane.attempt !== event.attempt) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT requires a currently running, bound lane');
  }
  if (event.scope_hash !== lane.scope_hash || event.scope_hash !== input.review.scope?.scope_hash) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'RESULT scope hash conflicts with the frozen scope');
  }
  let digest: string;
  try {
    digest = canonicalLanePayloadDigest(result);
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
    result: structuredClone(result),
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
    if (lane === undefined) {
      const staleAttempt = record.lanes.some((candidate) => candidate.lane_id === input.lane_id);
      throw new ReviewCoordinatorError(
        'LANE_EVIDENCE_INVALID',
        staleAttempt ? 'lane readiness attempt does not match the current review attempt' : 'lane readiness target is unknown',
      );
    }
    if (lane.status === 'RUNNING') return lane;
    if (lane.status !== 'PENDING') {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', `lane readiness ended in ${lane.status}`);
    }
    const laneDeadline = parseTimestamp(lane.idle_deadline_at, 'lane readiness deadline');
    const effectiveDeadline = Math.min(deadline, laneDeadline);
    if (input.now().getTime() >= effectiveDeadline) {
      throw new ReviewCoordinatorError('LANE_TIMED_OUT', 'lane readiness timeout expired');
    }
    await input.waitForChange(new Date(effectiveDeadline).toISOString());
  }
}

function filesForLane(record: ReviewRecord, lane: LaneRecord) {
  if (lane.batch_id === 'global') return record.scope?.files ?? [];
  const files = new Set(record.batches.find((batch) => batch.batch_id === lane.batch_id)?.files ?? []);
  return (record.scope?.files ?? []).filter((file) => files.has(file.path));
}

interface ReconcileResultPublicationsInput {
  review: ReviewRecord;
  proposals: readonly LaneResultProposal[];
  snapshot: ActivitySnapshot;
  now: Date;
}

function consumptionMarkerIdentity(marker: Pick<ReviewConsumptionMarker, 'kind' | 'value_sha256'>): string {
  return `${marker.kind}:${marker.value_sha256}`;
}

function consumptionIdentityForValue(input: {
  review_id: string;
  idempotency_key: string;
  kind: ReviewConsumptionKind;
  value: string;
  consumed_at: string;
}): string {
  const effect = createReviewConsumptionEffect(input);
  return consumptionMarkerIdentity(effect.payload as ReviewConsumptionMarker);
}

export function reconcileResultPublications(input: ReconcileResultPublicationsInput): ReviewRecord {
  if (Object.hasOwn(input, 'consumedToolEventRefs')) {
    throw new ReviewCoordinatorError(
      'LANE_EVIDENCE_INVALID',
      'consumption state must come from durable review markers, not caller input',
    );
  }
  return reconcileResultPublicationsTrusted(input, []);
}

function reconcileResultPublicationsTrusted(
  input: ReconcileResultPublicationsInput,
  consumedMarkers: readonly ReviewConsumptionMarker[],
): ReviewRecord {
  const cutoff = parseTimestamp(input.snapshot.cutoff_at, 'snapshot cutoff');
  let ordinaryEvents: LaneActivityEvent[];
  let diagnosticEvents;
  try {
    ordinaryEvents = input.snapshot.events
      .map(parseLaneActivityEvent)
      .filter((event) => event.event_kind !== 'RESULT_POST_TOOL');
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
  const durableConsumptions = new Set(consumedMarkers.map(consumptionMarkerIdentity));
  const nonceSet = new Set<string>();
  const output = cloneRecord(input.review);
  const validatedPairs: Array<{
    proposal: LaneResultProposal;
    publication: ResultPostToolPublication;
  }> = [];
  const matchedLaneIds = new Set<string>();
  let changed = false;
  for (const pair of matchedRaw) {
    const lane = currentLane(output, pair.proposal.lane_id);
    if (lane.status === 'COMPLETE') continue;
    if (lane.status !== 'RUNNING') continue;
    matchedLaneIds.add(lane.lane_id);
    try {
      const parsedPublication = parsePostToolPublication(pair.publication);
      const published = parseTimestamp(parsedPublication.activity.observed_at, 'publication activity');
      if (published > cutoff) {
        throw new Error('publication is after the frozen snapshot cutoff');
      }
      const precedingEvents = ordinaryEvents.filter((event) =>
        compareActivity(event, parsedPublication.activity) < 0);
      if (foldLaneEvents(lane, output, precedingEvents, published)) changed = true;
      if (lane.status !== 'RUNNING') continue;
      const publication = validatePostToolPublication({
        review: output,
        lane,
        proposal: pair.proposal,
        publication: parsedPublication,
        consumedToolEventRefs: consumed,
      });
      for (const [kind, value] of [
        ['PROPOSAL_KEY', pair.proposal.idempotency_key],
        ['TOOL_EVENT_REF', publication.attestation.tool_event_ref],
        ['NONCE', publication.attestation.nonce],
      ] as const) {
        const identity = consumptionIdentityForValue({
          review_id: input.review.review_id,
          idempotency_key: pair.proposal.idempotency_key,
          kind,
          value,
          consumed_at: input.snapshot.cutoff_at,
        });
        if (durableConsumptions.has(identity)) {
          throw new Error(`${kind.toLowerCase()} was already consumed by this review`);
        }
      }
      if (nonceSet.has(publication.attestation.nonce)) {
        throw new Error('attestation nonce is reused');
      }
      nonceSet.add(publication.attestation.nonce);
      consumed.add(publication.attestation.tool_event_ref);
      validatedPairs.push({ proposal: pair.proposal, publication });
    } catch (error) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
    }
  }

  for (const lane of output.lanes.filter((candidate) => candidate.attempt === output.current_attempt)) {
    if (!matchedLaneIds.has(lane.lane_id)
      && foldLaneEvents(lane, output, ordinaryEvents, cutoff)) changed = true;
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
    lane.status = 'COMPLETE';
    lane.findings = evidence.result.findings;
    lane.diagnostic_ids = evidence.diagnostics.map((diagnostic) => diagnostic.diagnostic_id);
    lane.last_processed_activity_ref = publication.activity.event_ref;
    lane.last_processed_activity_at = publication.activity.observed_at;
    if (evidence.result.role === 'code-reviewer') {
      lane.recommendation = evidence.evidence_status === 'DEGRADED_EVIDENCE'
        && evidence.result.recommendation === 'APPROVE'
        ? 'COMMENT'
        : evidence.result.recommendation;
      if (evidence.evidence_status === 'DEGRADED_EVIDENCE') lane.failure_code = 'DIAGNOSTIC_DEGRADED';
    }
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
      attempt,
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

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function parseReviewId(value: unknown, name: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', `${name} must be a cryptographic UUID`);
  }
  return value.toLowerCase();
}

function parseDurableReconcileRequest(value: unknown): {
  review_id: string;
  crashAt?: DurableTransactionBoundary;
} {
  if (!isObject(value)
    || !exactObjectKeys(value, value.crashAt === undefined ? ['review_id'] : ['review_id', 'crashAt'])) {
    throw new ReviewCoordinatorError(
      'LANE_EVIDENCE_INVALID',
      'durable reconciliation accepts only review_id and host test controls',
    );
  }
  const reviewId = parseReviewId(value.review_id, 'review_id');
  if (value.crashAt !== undefined && (typeof value.crashAt !== 'string'
    || !/^(?:before|after):(?:prepared|locator|proposal|post-tool|consume|manifest|lane|review|report|active-overlay|approval|stop-marker|committed|receipt|locator-cleanup)$/u.test(value.crashAt))) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'reconciliation crash boundary is invalid');
  }
  return {
    review_id: reviewId,
    ...(value.crashAt === undefined ? {} : { crashAt: value.crashAt as DurableTransactionBoundary }),
  };
}

function parseTrustedHookJournalSnapshot(input: {
  value: unknown;
  review: ReviewRecord;
  cutoff_at: string;
}): TrustedHookJournalSnapshot {
  if (!isObject(input.value)
    || !exactObjectKeys(input.value, ['events', 'diagnostic_events', 'publication_ids'])
    || !Array.isArray(input.value.events)
    || !Array.isArray(input.value.diagnostic_events)
    || !Array.isArray(input.value.publication_ids)
    || input.value.events.length > 4_096
    || input.value.diagnostic_events.length > 1_024
    || input.value.publication_ids.length > 1_024) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted hook journal snapshot is missing or malformed');
  }
  let events: LaneActivityEvent[];
  let diagnosticEvents: ReturnType<typeof parseDiagnosticToolEvents>;
  let publicationIds: string[];
  try {
    events = input.value.events.map(parseLaneActivityEvent);
    diagnosticEvents = parseDiagnosticToolEvents(input.value.diagnostic_events);
    publicationIds = input.value.publication_ids.map((value) => parseReviewId(value, 'publication_id'));
  } catch (error) {
    if (error instanceof ReviewCoordinatorError) throw error;
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', (error as Error).message);
  }
  if (new Set(publicationIds).size !== publicationIds.length) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted publication identity is duplicated');
  }
  const cutoff = parseTimestamp(input.cutoff_at, 'trusted snapshot cutoff');
  const validateEventIdentity = (event: {
    session_id: string;
    review_id: string;
    attempt: number;
    lane_id: string;
    child_thread_id: string;
    observed_at: string;
  }): void => {
    const lane = input.review.lanes.find((candidate) =>
      candidate.lane_id === event.lane_id && candidate.attempt === event.attempt);
    const observed = parseTimestamp(event.observed_at, 'trusted journal event');
    if (event.session_id !== input.review.session_id
      || event.review_id !== input.review.review_id
      || lane?.provenance === undefined
      || event.child_thread_id !== lane.provenance.thread_id
      || observed < parseTimestamp(lane.provenance.first_seen_at, 'lane first_seen_at')
      || observed > cutoff) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted hook journal event identity or time is invalid');
    }
  };
  for (const event of events) validateEventIdentity(event);
  for (const event of diagnosticEvents) validateEventIdentity(event);
  const currentAttempt = input.review.current_attempt;
  return {
    events: events.filter((event) => event.attempt === currentAttempt),
    diagnostic_events: diagnosticEvents.filter((event) => event.attempt === currentAttempt),
    publication_ids: publicationIds,
  };
}

/**
 * Read the hook-owned, create-once PostTool publications from their derived
 * persistence location. Callers provide review identity, never a path or
 * locator, and malformed publications fail closed before reconciliation.
 */
export async function loadPublishedReviewHookJournalSnapshot(
  input: PublishedHookJournalSnapshotInput,
): Promise<TrustedHookJournalSnapshot> {
  const reviewId = parseReviewId(input.review_id, 'review_id');
  if (typeof input.session_id !== 'string' || input.session_id.length === 0 || input.session_id.length > 160
    || typeof input.root_thread_id !== 'string' || input.root_thread_id.length === 0 || input.root_thread_id.length > 160) {
    throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted publication ownership is invalid');
  }
  const cutoff = parseTimestamp(input.cutoff_at, 'trusted publication cutoff');
  const paths = await resolveReviewPersistencePaths({
    workingDirectory: input.workingDirectory,
    session_id: input.session_id,
  });
  const submissionsRoot = join(paths.reviewRoot, reviewId, 'submissions');
  let entries;
  try {
    entries = await readdir(submissionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], diagnostic_events: [], publication_ids: [] };
    }
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'trusted publication directory is unavailable');
  }

  const events: LaneActivityEvent[] = [];
  const publicationIds: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !REVIEW_ID_PATTERN.test(entry.name)) continue;
    let raw: Buffer;
    try {
      raw = await readFile(join(submissionsRoot, entry.name, 'post-tool'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'trusted publication is unreadable');
    }
    if (raw.byteLength > 1_048_576) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted publication exceeds the size limit');
    }
    let publication: ResultPostToolPublication;
    try {
      publication = parsePostToolPublication(JSON.parse(raw.toString('utf8')) as unknown);
    } catch {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted publication is malformed');
    }
    if (publication.publication_id !== entry.name.toLowerCase()
      || publication.activity.session_id !== input.session_id
      || publication.attestation.session_id !== input.session_id
      || publication.attestation.root_thread_id !== input.root_thread_id
      || publication.activity.review_id !== reviewId
      || publication.attestation.review_id !== reviewId) {
      throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted publication ownership is invalid');
    }
    if (parseTimestamp(publication.published_at, 'trusted publication') > cutoff) continue;
    events.push(publication.activity);
    publicationIds.push(publication.publication_id);
  }
  return { events, diagnostic_events: [], publication_ids: publicationIds };
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

function validateStartTransactionResponse(value: unknown, expected: ReviewRecord): ReviewRecord {
  if (!isDeepStrictEqual(value, expected)) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'START transaction receipt response is malformed');
  }
  return structuredClone(value) as ReviewRecord;
}

function validateProposalTransactionResponse(
  value: unknown,
  expected: LaneResultProposal,
): LaneResultProposal {
  if (!isDeepStrictEqual(value, expected)) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'RESULT transaction receipt response is malformed');
  }
  return structuredClone(value) as LaneResultProposal;
}

function activeStatusTransitionEffects(
  current: ReviewRecord,
  output: ReviewRecord,
): DurableTransactionEffect[] {
  if (current.status === output.status) return [];
  if (output.status === 'FINALIZED' || output.status === 'BLOCKED') {
    return [{
      name: 'active-overlay',
      mode: 'REMOVE_MATCHING_ACTIVE',
      target: { area: 'REVIEW_STATE', path: 'active.json' },
      review_id: current.review_id,
      expected_status: current.status,
      expected_revision: current.revision,
    }];
  }
  if (current.status === 'BLOCKED') {
    return [{
      name: 'active-overlay',
      mode: 'RESTORE_MISSING_ACTIVE',
      target: { area: 'REVIEW_STATE', path: 'active.json' },
      payload: { schema_version: 1, review_id: current.review_id, status: output.status },
      review_id: current.review_id,
      expected_status: current.status,
      expected_revision: current.revision,
    }];
  }
  if (current.status === 'FINALIZED') {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'finalized reviews cannot transition back to active');
  }
  return [{
    name: 'active-overlay',
    mode: 'UPDATE_MATCHING_ACTIVE',
    target: { area: 'REVIEW_STATE', path: 'active.json' },
    payload: { schema_version: 1, review_id: current.review_id, status: output.status },
    review_id: current.review_id,
    expected_status: current.status,
    expected_revision: current.revision,
  }];
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
  start(input: {
    record: ReviewRecord;
    idempotency_key: string;
    request_identity?: unknown;
    crashAt?: DurableTransactionBoundary;
  }): Promise<ReviewRecord>;
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
    crashAt?: DurableTransactionBoundary;
  }): Promise<ReviewRecord>;
  resume(input: { review_id: string; current_scope_hash: string; now: Date; idempotency_key: string }): Promise<ReviewRecord>;
  finalize(input: { review_id: string; current_scope_hash: string; now: Date; idempotency_key: string }): Promise<ReviewRecord>;
}

export function createDurableReviewCoordinator(
  context: ReviewPersistenceContext,
  host?: DurableReviewCoordinatorHostDependencies,
): DurableReviewCoordinator {
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
    async start({ record, idempotency_key: idempotencyKey, request_identity: requestIdentity, crashAt }) {
      const resolved = await paths();
      const terminal = record.status === 'FINALIZED' || record.status === 'BLOCKED';
      const transaction = await runDurableTransaction(resolved, {
        journal_scope: 'START',
        idempotency_key: idempotencyKey,
        review_id: record.review_id,
        operation: 'START_REVIEW',
        input: {
          review_id: record.review_id,
          scope_hash: record.scope?.scope_hash,
          ...(requestIdentity === undefined ? {} : { request_identity: requestIdentity }),
        },
        expected_revision: 0,
        effects: [
          reviewEffect(record),
          ...(terminal ? [{
            name: 'report' as const,
            mode: 'CREATE_ONCE_JSON' as const,
            target: { area: 'FINAL_REVIEWS' as const, path: `${record.review_id}.json` },
            payload: projectFinalReviewArtifact(record),
          }] : [{
            name: 'active-overlay',
            mode: 'CREATE_ONCE_JSON' as const,
            target: { area: 'REVIEW_STATE' as const, path: 'active.json' },
            payload: { schema_version: 1, review_id: record.review_id, status: record.status },
          }]),
        ],
        response: record,
      }, crashAt === undefined ? {} : { crashAt });
      return validateStartTransactionResponse(transaction.response, record);
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
      const transaction = await runDurableTransaction(resolved, {
        idempotency_key: event.idempotency_key,
        review_id: event.review_id,
        operation: 'PROPOSE_LANE_RESULT',
        input: { ...event, result: proposal.result },
        expected_revision: current.revision,
        effects: [{
          name: 'proposal', mode: 'CREATE_ONCE_JSON',
          target: { area: 'REVIEW_STATE', path: `${event.review_id}/submissions/${event.idempotency_key}/proposal` },
          payload: proposal,
        }],
        response: proposal,
      });
      return validateProposalTransactionResponse(transaction.response, proposal);
    },

    async reconcile(request) {
      const { review_id: reviewId, crashAt } = parseDurableReconcileRequest(request);
      const resolved = await paths();
      if (context.session_id === undefined || host === undefined
        || typeof host.root_thread_id !== 'string' || host.root_thread_id.length === 0
        || typeof host.loadHookJournalSnapshot !== 'function') {
        throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted hook journal loader is unavailable');
      }
      const sessionId = context.session_id;
      const rootThreadId = host.root_thread_id;
      const loadHookJournalSnapshot = host.loadHookJournalSnapshot;
      const trustedNow = host.now;
      const result = await runDurableReviewTransactionWithPlanFactory(resolved, {
        review_id: reviewId,
        session_id: sessionId,
        root_thread_id: rootThreadId,
        plan_factory: async ({ current_review: current }): Promise<DurableTransactionPlan | undefined> => {
          const cutoff = (trustedNow ?? (() => new Date()))();
          if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
            throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted snapshot clock is invalid');
          }
          const cutoffAt = cutoff.toISOString();
          const trusted = parseTrustedHookJournalSnapshot({
            value: await loadHookJournalSnapshot({
              session_id: current.session_id ?? sessionId,
              root_thread_id: rootThreadId,
              review_id: current.review_id,
              cutoff_at: cutoffAt,
            }),
            review: current,
            cutoff_at: cutoffAt,
          });
          const persistedProposals: LaneResultProposal[] = [];
          const persistedPublications: unknown[] = [];
          for (const id of [...trusted.publication_ids].sort()) {
            const proposalValue = await readJson(join(resolved.reviewRoot, reviewId, 'submissions', id, 'proposal'));
            const publicationValue = await readJson(join(resolved.reviewRoot, reviewId, 'submissions', id, 'post-tool'));
            if (proposalValue === undefined || publicationValue === undefined) continue;
            persistedProposals.push(parsePersistedProposal(proposalValue, current));
            persistedPublications.push(publicationValue);
          }
          const snapshot: ActivitySnapshot = {
            cutoff_at: cutoffAt,
            events: trusted.events,
            publications: persistedPublications,
            diagnostic_events: trusted.diagnostic_events,
          };
          const consumedMarkers = await readReviewConsumptionMarkers(resolved, reviewId);
          const output = reconcileResultPublicationsTrusted({
            review: current,
            proposals: persistedProposals,
            snapshot,
            now: cutoff,
          }, consumedMarkers);
          if (output === current) return undefined;
          const accepted = output.lanes.filter((lane) => {
            const before = current.lanes.find((candidate) =>
              candidate.lane_id === lane.lane_id && candidate.attempt === lane.attempt);
            return lane.status === 'COMPLETE' && before?.status !== 'COMPLETE';
          });
          const key = deterministicTransactionId({
            review_id: reviewId,
            attempt: current.current_attempt,
            cutoff_at: cutoffAt,
            publication_refs: accepted.map((lane) => lane.last_processed_activity_ref).sort(),
            revision: current.revision,
          });
          const effects: DurableTransactionEffect[] = [];
          for (const lane of accepted) {
            const proposal = persistedProposals.find((candidate) =>
              candidate.lane_id === lane.lane_id && candidate.attempt === lane.attempt);
            if (proposal === undefined) {
              throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'terminal lane has no durable proposal');
            }
            const publication = persistedPublications.find((candidate) =>
              isObject(candidate) && candidate.publication_id === proposal.idempotency_key) as ResultPostToolPublication | undefined;
            if (publication === undefined) {
              throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'terminal lane has no durable post-tool publication');
            }
            effects.push(
              {
                name: 'proposal', mode: 'CREATE_ONCE_JSON',
                target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${proposal.idempotency_key}/proposal` },
                payload: proposal,
              },
              {
                name: 'post-tool', mode: 'CREATE_ONCE_JSON',
                target: { area: 'REVIEW_STATE', path: `${reviewId}/submissions/${proposal.idempotency_key}/post-tool` },
                payload: publication,
              },
              createReviewConsumptionEffect({
                review_id: reviewId, idempotency_key: key, kind: 'PROPOSAL_KEY',
                value: proposal.idempotency_key, consumed_at: cutoffAt,
              }),
              createReviewConsumptionEffect({
                review_id: reviewId, idempotency_key: key, kind: 'TOOL_EVENT_REF',
                value: publication.attestation.tool_event_ref, consumed_at: cutoffAt,
              }),
              createReviewConsumptionEffect({
                review_id: reviewId, idempotency_key: key, kind: 'NONCE',
                value: publication.attestation.nonce, consumed_at: cutoffAt,
              }),
            );
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
          effects.push(...activeStatusTransitionEffects(current, output));
          return {
            idempotency_key: key,
            review_id: reviewId,
            operation: 'RECONCILE_RESULT_PUBLICATIONS',
            input: {
              cutoff_at: cutoffAt,
              publication_ids: persistedProposals.map((proposal) => proposal.idempotency_key).sort(),
            },
            expected_revision: current.revision,
            effects,
            response: output,
          };
        },
      }, crashAt === undefined ? {} : { crashAt });
      return result.review;
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
          ...activeStatusTransitionEffects(current, output),
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
          ...activeStatusTransitionEffects(current, output),
        ],
        response: output,
      });
      return await readPersistedReview(resolved, reviewId);
    },
  };
}

export const REVIEW_OPERATION_NAMES = [
  'review_start',
  'review_get',
  'review_record_lane',
  'review_resume',
  'review_finalize',
] as const;

export type ReviewOperationName = (typeof REVIEW_OPERATION_NAMES)[number];
export type ReviewOperationSource = 'MCP' | 'CLI';

export interface ReviewOperationResponse {
  payload: unknown;
  isError?: boolean;
}

export interface ReviewOperationHostContext {
  source: ReviewOperationSource;
  seeded_review_id?: string;
  root_thread_id?: string;
  now?: () => Date;
  loadTracker?(input: {
    workingDirectory: string;
    session_id?: string;
    review_id: string;
    attempt: number;
    lane_id: string;
    thread_id: string;
  }): Promise<unknown>;
  loadHookJournalSnapshot?(input: {
    session_id: string;
    root_thread_id: string;
    review_id: string;
    cutoff_at: string;
  }): Promise<unknown>;
}

const REVIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function operationInput(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', 'review operation input must be a JSON object');
  }
  return value;
}

function exactOperationFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key)).sort();
  if (unknown.length > 0) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', `unknown review operation field: ${unknown[0]}`);
  }
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', `missing review operation field: ${missing[0]}`);
  }
}

function operationString(
  value: unknown,
  name: string,
  maximum = 1_024,
): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\0\r\n]/u.test(value)) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', `${name} must be a non-empty bounded string`);
  }
  return value;
}

function operationUuid(value: unknown, name: string): string {
  const parsed = operationString(value, name, 64).toLowerCase();
  if (!REVIEW_ID_PATTERN.test(parsed)) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', `${name} must be a cryptographic UUID`);
  }
  return parsed;
}

function operationAttempt(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ReviewCoordinatorError('INVALID_INVOCATION', 'attempt must be a positive integer');
  }
  return value as number;
}

function operationContext(input: Record<string, unknown>): ReviewPersistenceContext {
  const workingDirectory = resolve(operationString(input.workingDirectory, 'workingDirectory', 4_096));
  const sessionId = input.session_id === undefined
    ? undefined
    : operationString(input.session_id, 'session_id', 160);
  return {
    workingDirectory,
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
  };
}

function operationNow(host: ReviewOperationHostContext): Date {
  const now = (host.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ReviewCoordinatorError('INVALID_CONFIGURATION', 'trusted review clock is invalid');
  }
  return now;
}

function hostDependencies(
  host: ReviewOperationHostContext,
): DurableReviewCoordinatorHostDependencies | undefined {
  if (host.root_thread_id === undefined || host.loadHookJournalSnapshot === undefined) return undefined;
  return {
    root_thread_id: host.root_thread_id,
    loadHookJournalSnapshot: host.loadHookJournalSnapshot,
    ...(host.now === undefined ? {} : { now: host.now }),
  };
}

function adaptiveReviewChangeWaiter(reviewPath: string): (deadlineAt: string) => Promise<void> {
  let backoffMs = 50;
  return async (deadlineAt) => {
    const remainingMs = Math.max(0, Date.parse(deadlineAt) - Date.now());
    if (remainingMs === 0) return;
    const delayMs = Math.min(remainingMs, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 1_000);
    await new Promise<void>((resolveWait) => {
      let settled = false;
      let directoryWatcher: ReturnType<typeof watch> | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        directoryWatcher?.close();
        resolveWait();
      };
      // Node timers use a monotonic clock. The bounded timer is the fallback
      // when the platform watcher coalesces or misses an atomic rename event.
      const timer = setTimeout(finish, delayMs);
      try {
        directoryWatcher = watch(dirname(reviewPath), { persistent: false }, (_event, filename) => {
          if (filename === null || filename.toString() === 'review.json') finish();
        });
        directoryWatcher.once('error', finish);
      } catch {
        // The adaptive monotonic timer remains the condition-poll fallback.
      }
    });
  };
}

function relativeReviewArtifacts(reviewId: string): { json_path: string; markdown_path: string } {
  return {
    json_path: `.omx/reviews/${reviewId}.json`,
    markdown_path: `.omx/reviews/${reviewId}.md`,
  };
}

function projectOperationReview(record: ReviewRecord): Record<string, unknown> {
  return {
    review_id: record.review_id,
    ...(record.session_id === undefined ? {} : { session_id: record.session_id }),
    attempt: record.current_attempt,
    status: record.status,
    revision: record.revision,
    ...(record.scope === undefined ? {} : {
      scope: {
        status: record.scope.status,
        scope_hash: record.scope.scope_hash,
        file_count: record.scope.files.length,
        changed_lines: record.scope.changed_lines,
        reasons: record.scope.reasons,
      },
    }),
    review_flags: record.review_flags,
    batches: record.batches,
    lanes: record.lanes.map((lane) => ({
      lane_id: lane.lane_id,
      role: lane.role,
      batch_id: lane.batch_id,
      attempt: lane.attempt,
      status: lane.status,
      scope_hash: lane.scope_hash,
      idle_deadline_at: lane.idle_deadline_at,
    })),
    diagnostics: record.diagnostics.slice(0, 128).map((diagnostic) => ({
      diagnostic_id: diagnostic.diagnostic_id,
      capability: diagnostic.capability,
      applicability: diagnostic.applicability,
      execution: diagnostic.execution,
      outcome: diagnostic.outcome,
      event_ref: diagnostic.event_ref,
      summary: diagnostic.summary,
    })),
    resumable: record.resumable,
    ...(record.resumable_reason === undefined ? {} : { resumable_reason: record.resumable_reason }),
    ...(record.verdict === undefined ? {} : { verdict: record.verdict }),
    artifacts: relativeReviewArtifacts(record.review_id),
  };
}

async function activeReviewId(context: ReviewPersistenceContext): Promise<string> {
  const paths = await resolveReviewPersistencePaths(context);
  const active = await readActiveReview(paths);
  if (active === null) {
    throw new ReviewCoordinatorError('REVIEW_NOT_STARTED', 'no active code review exists for this state scope');
  }
  return active.review_id;
}

async function committedStartResponse(
  paths: ReviewPersistencePaths,
  idempotencyKey: string,
  reviewId: string,
): Promise<ReviewRecord | undefined> {
  await recoverPendingReviewTransactions(paths);
  let raw: string;
  try {
    raw = await readFile(join(paths.startReceiptsRoot, `${idempotencyKey}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const receipt = JSON.parse(raw) as unknown;
  if (!isObject(receipt)
    || receipt.idempotency_key !== idempotencyKey
    || receipt.review_id !== reviewId
    || !isObject(receipt.response)
    || receipt.response.review_id !== reviewId) {
    throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'START receipt response is malformed');
  }
  return structuredClone(receipt.response) as unknown as ReviewRecord;
}

async function currentScopeHash(
  context: ReviewPersistenceContext,
  record: ReviewRecord,
): Promise<string> {
  if (record.scope === undefined) {
    throw new ReviewCoordinatorError('REVIEW_NOT_STARTED', 'review scope has not been frozen');
  }
  const drift = await verifyScopeDrift(record.scope, { workingDirectory: context.workingDirectory });
  return drift.current_scope_hash;
}

function operationError(
  error: unknown,
  workingDirectory: string | undefined,
): ReviewOperationResponse {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : 'REVIEW_OPERATION_FAILED';
  const message = typeof candidate?.message === 'string' ? candidate.message : 'review operation failed';
  let payload: unknown = { error: 'review operation failed', code };
  try {
    payload = sanitizeForPersistence(
      { error: message, code },
      workingDirectory === undefined ? {} : { repositoryRoot: workingDirectory },
    );
  } catch {
    // Keep the fallback generic when even the error cannot satisfy persistence limits.
  }
  return { payload, isError: true };
}

/**
 * The only runtime control-plane adapter for code review. Transport provenance
 * is supplied out-of-band through `host`; payload fields are never trusted as
 * MCP/CLI identity or attestation evidence.
 */
export async function executeReviewOperation(
  name: ReviewOperationName,
  rawInput: unknown,
  host: ReviewOperationHostContext,
): Promise<ReviewOperationResponse> {
  let context: ReviewPersistenceContext | undefined;
  try {
    const input = operationInput(rawInput);
    context = operationContext(input);
    const coordinator = createDurableReviewCoordinator(context, hostDependencies(host));

    switch (name) {
      case 'review_start': {
        exactOperationFields(
          input,
          ['workingDirectory', 'session_id', 'invocation', 'idempotency_key', 'accepted_equivalent_requests'],
          ['workingDirectory', 'invocation', 'idempotency_key'],
        );
        if (!Array.isArray(input.invocation)
          || input.invocation.some((argument) => typeof argument !== 'string')) {
          throw new ReviewCoordinatorError('INVALID_INVOCATION', 'invocation must be an array of strings');
        }
        const key = operationUuid(input.idempotency_key, 'idempotency_key');
        const acceptedRequests = input.accepted_equivalent_requests === undefined
          ? []
          : parseAcceptedEquivalentRequests(input.accepted_equivalent_requests);
        const parsed = await parseCodeReviewArguments(input.invocation as string[], {
          workingDirectory: context.workingDirectory,
          validateRef: async (ref) => {
            try {
              await runGitCommand(context!.workingDirectory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
              return true;
            } catch {
              return false;
            }
          },
        });
        if (parsed.operation !== 'start') {
          throw new ReviewCoordinatorError('INVALID_INVOCATION', 'review_start cannot resume an existing review');
        }
        const reviewId = host.seeded_review_id === undefined
          ? key
          : operationUuid(host.seeded_review_id, 'seeded_review_id');
        const paths = await resolveReviewPersistencePaths(context);
        const requestIdentity = {
          selector: parsed.selector,
          accepted_equivalent_requests: acceptedRequests,
        };
        const committed = await committedStartResponse(paths, key, reviewId);
        if (committed !== undefined) {
          const started = await coordinator.start({
            record: committed,
            idempotency_key: key,
            request_identity: requestIdentity,
          });
          if (started.scope === undefined) {
            throw new ReviewCoordinatorError('PERSISTENCE_FAILED', 'committed START response has no frozen scope');
          }
          return {
            payload: {
              ...projectOperationReview(started),
              capability_plan: buildCapabilityPlan(started.scope.files),
              required_lane_plan: started.lanes
                .filter((lane) => lane.attempt === 1)
                .map((lane) => ({ lane_id: lane.lane_id, role: lane.role, batch_id: lane.batch_id })),
              accepted_equivalent_requests: acceptedRequests,
              state_path: `code-review/${started.review_id}/review.json`,
            },
          };
        }
        const scope = await resolveGitScope({
          workingDirectory: context.workingDirectory,
          selector: parsed.selector,
        });
        const repositoryRoot = (await runGitCommand(
          context.workingDirectory,
          ['rev-parse', '--show-toplevel'],
        )).toString('utf8').trim();
        const batchPlan = await createBatchPlan({ repositoryRoot, files: scope.files });
        const now = operationNow(host);
        const record = createInitialReviewRecord({
          // The caller-generated v4 key makes concurrent retries converge before
          // any START receipt exists; the durable layer still validates conflicts.
          review_id: reviewId,
          ...(context.session_id === undefined ? {} : { session_id: context.session_id }),
          ...(host.root_thread_id === undefined ? {} : { root_thread_id: host.root_thread_id }),
          scope,
          batch_plan: batchPlan,
          now,
        });
        const started = await coordinator.start({
          record,
          idempotency_key: key,
          request_identity: requestIdentity,
        });
        return {
          payload: {
            ...projectOperationReview(started),
            capability_plan: buildCapabilityPlan(scope.files),
            required_lane_plan: batchPlan.required_lanes,
            accepted_equivalent_requests: acceptedRequests,
            state_path: `code-review/${started.review_id}/review.json`,
          },
        };
      }

      case 'review_get': {
        exactOperationFields(
          input,
          ['workingDirectory', 'session_id', 'review_id', 'lane_id', 'wait', 'maximum_wait_ms'],
          ['workingDirectory'],
        );
        const reviewId = input.review_id === undefined
          ? await activeReviewId(context)
          : operationUuid(input.review_id, 'review_id');
        const laneId = input.lane_id === undefined
          ? undefined
          : operationString(input.lane_id, 'lane_id', 160);
        if (input.wait !== undefined && typeof input.wait !== 'boolean') {
          throw new ReviewCoordinatorError('INVALID_INVOCATION', 'wait must be a boolean');
        }
        const wait = input.wait === true;
        if (wait && laneId === undefined) {
          throw new ReviewCoordinatorError('INVALID_INVOCATION', 'lane_id is required when wait is true');
        }
        let maximumWaitMs: number | undefined;
        if (input.maximum_wait_ms !== undefined) {
          if (!Number.isSafeInteger(input.maximum_wait_ms)
            || (input.maximum_wait_ms as number) < 1
            || (input.maximum_wait_ms as number) > READINESS_WAIT_MS
            || !wait) {
            throw new ReviewCoordinatorError(
              'INVALID_INVOCATION',
              `maximum_wait_ms requires wait=true and must be an integer from 1 through ${READINESS_WAIT_MS}`,
            );
          }
          maximumWaitMs = input.maximum_wait_ms as number;
        }
        const canReconcile = hostDependencies(host) !== undefined;
        const load = async (): Promise<ReviewRecord> => {
          const current = await coordinator.get(reviewId);
          return canReconcile ? await coordinator.reconcile({ review_id: reviewId }) : current;
        };
        if (wait) {
          const paths = await resolveReviewPersistencePaths(context);
          await waitForLaneRunning({
            load,
            lane_id: laneId!,
            now: () => operationNow(host),
            waitForChange: adaptiveReviewChangeWaiter(join(paths.reviewRoot, reviewId, 'review.json')),
            ...(maximumWaitMs === undefined ? {} : { maximum_wait_ms: maximumWaitMs }),
          });
        }
        const record = await load();
        return { payload: projectOperationReview(record) };
      }

      case 'review_record_lane': {
        const event = input.event;
        if (event !== 'START' && event !== 'RESULT') {
          throw new ReviewCoordinatorError('INVALID_INVOCATION', 'review_record_lane event must be START or RESULT');
        }
        const common = ['workingDirectory', 'session_id', 'event', 'review_id', 'attempt', 'lane_id', 'idempotency_key'];
        exactOperationFields(
          input,
          event === 'START' ? [...common, 'thread_id'] : [...common, 'scope_hash', 'result'],
          event === 'START' ? [...common, 'thread_id'] : [...common, 'scope_hash', 'result'],
        );
        const reviewId = operationUuid(input.review_id, 'review_id');
        const attempt = operationAttempt(input.attempt);
        const laneId = operationString(input.lane_id, 'lane_id', 160);
        const key = operationUuid(input.idempotency_key, 'idempotency_key');
        const now = operationNow(host);
        if (event === 'START') {
          if (host.loadTracker === undefined) {
            throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'trusted hook tracker loader is unavailable');
          }
          const threadId = operationString(input.thread_id, 'thread_id', 160);
          const tracker = await host.loadTracker({
            ...context,
            review_id: reviewId,
            attempt,
            lane_id: laneId,
            thread_id: threadId,
          });
          const record = await coordinator.recordStart({
            event: {
              event: 'START', review_id: reviewId, attempt, lane_id: laneId,
              thread_id: threadId, idempotency_key: key,
            },
            tracker,
            now,
          });
          return { payload: projectOperationReview(record) };
        }
        const proposal = await coordinator.recordResult({
          event: {
            event: 'RESULT', review_id: reviewId, attempt, lane_id: laneId,
            scope_hash: operationString(input.scope_hash, 'scope_hash', 128),
            result: input.result as LaneResult,
            idempotency_key: key,
          },
          source: host.source,
          now,
        });
        return { payload: proposal };
      }

      case 'review_resume': {
        exactOperationFields(
          input,
          ['workingDirectory', 'session_id', 'review_id', 'idempotency_key'],
          ['workingDirectory', 'review_id', 'idempotency_key'],
        );
        const reviewId = operationUuid(input.review_id, 'review_id');
        const current = await coordinator.get(reviewId);
        const record = await coordinator.resume({
          review_id: reviewId,
          current_scope_hash: await currentScopeHash(context, current),
          now: operationNow(host),
          idempotency_key: operationUuid(input.idempotency_key, 'idempotency_key'),
        });
        return { payload: projectOperationReview(record) };
      }

      case 'review_finalize': {
        exactOperationFields(
          input,
          ['workingDirectory', 'session_id', 'review_id', 'attempt', 'idempotency_key'],
          ['workingDirectory', 'review_id', 'attempt', 'idempotency_key'],
        );
        const reviewId = operationUuid(input.review_id, 'review_id');
        let current = await coordinator.get(reviewId);
        const attempt = operationAttempt(input.attempt);
        if (current.current_attempt !== attempt) {
          throw new ReviewCoordinatorError('LANE_EVIDENCE_INVALID', 'review_finalize targets the wrong attempt');
        }
        if (hostDependencies(host) !== undefined) {
          current = await coordinator.reconcile({ review_id: reviewId });
        }
        const record = await coordinator.finalize({
          review_id: reviewId,
          current_scope_hash: await currentScopeHash(context, current),
          now: operationNow(host),
          idempotency_key: operationUuid(input.idempotency_key, 'idempotency_key'),
        });
        const paths = await resolveReviewPersistencePaths(context);
        const artifacts = await writeFinalReviewArtifacts(paths, projectFinalReviewArtifact(record));
        return {
          payload: {
            ...projectOperationReview(record),
            artifacts: relativeReviewArtifacts(reviewId),
            artifact_sha256: artifacts.artifact_sha256,
          },
        };
      }
    }
  } catch (error) {
    return operationError(error, context?.workingDirectory);
  }
}
