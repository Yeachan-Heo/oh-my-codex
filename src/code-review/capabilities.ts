import { posix } from 'node:path';
import type {
  AcceptedEquivalent,
  AcceptedEquivalentRequest,
  EvidenceStatus,
  ReviewRecommendation,
  ScopeFile,
} from './contract.js';

export type Capability = 'LSP' | 'AST' | 'COMPILER' | 'LINT' | 'RG_FALLBACK';
export type FileKind =
  | 'TYPESCRIPT_JAVASCRIPT'
  | 'RUST'
  | 'SHELL'
  | 'STRUCTURED_DATA'
  | 'DOCUMENTATION'
  | 'ASSET'
  | 'UNKNOWN_TEXT'
  | 'UNKNOWN_BINARY'
  | 'SYMLINK'
  | 'GITLINK';

export interface CapabilityPlanEntry {
  capability: Capability;
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
  file_kinds: FileKind[];
  fallback_for: Array<'LSP' | 'AST'>;
}

export interface CapabilityPlan {
  file_kinds: Array<{ path: string; kind: FileKind }>;
  capabilities: CapabilityPlanEntry[];
  inherently_degraded: boolean;
}

export interface CapabilityObservation {
  capability: Capability;
  execution: 'NATIVE' | 'ACCEPTED_EQUIVALENT' | 'FALLBACK' | 'UNAVAILABLE' | 'SKIPPED';
  outcome: 'PASS' | 'FAIL' | 'TIMED_OUT' | 'MALFORMED' | 'NOT_RUN';
  empty_result?: boolean;
}

export interface CapabilityEvaluation {
  evidence_status: EvidenceStatus;
  maximum_recommendation: ReviewRecommendation;
  reasons: string[];
}

export interface HookApprovalLedgerEntry {
  approval: Record<string, unknown>;
  provenance: {
    owner: 'CODEX_NATIVE_HOOK';
    event_ref: string;
    nonce: string;
  };
}

export interface PreparedEquivalentConsumption {
  schema_version: 1;
  state: 'PREPARED';
  nonce: string;
  review_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  prepared_at: string;
}

export interface CommittedEquivalentConsumption
  extends Omit<PreparedEquivalentConsumption, 'state'> {
  state: 'COMMITTED';
  committed_at: string;
}

export interface TrustedEquivalentResolution {
  accepted_equivalents: AcceptedEquivalent[];
  reasons: string[];
  prepared_consumptions: PreparedEquivalentConsumption[];
}

export interface EquivalentResolutionContext {
  workingDirectory: string;
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  review_id: string;
  base_sha?: string;
}

export interface ResolveTrustedEquivalentsOptions {
  requests: unknown;
  context: EquivalentResolutionContext;
  explicitApprovalLedger?: readonly unknown[];
  existingConsumptions?: readonly unknown[];
  readBaseContract?: (workingDirectory: string, args: readonly string[]) => Promise<string>;
  now?: Date;
  approvalTtlMs?: number;
}

export type CapabilitiesErrorCode =
  | 'INVALID_EQUIVALENT_REQUEST'
  | 'EQUIVALENT_CONSUMPTION_CONFLICT';

export class CapabilitiesError extends Error {
  readonly code: CapabilitiesErrorCode;

  constructor(code: CapabilitiesErrorCode, message: string) {
    super(message);
    this.name = 'CapabilitiesError';
    this.code = code;
  }
}

const CAPABILITY_ORDER: readonly Capability[] = ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK'];
const FILE_KIND_ORDER: readonly FileKind[] = [
  'TYPESCRIPT_JAVASCRIPT',
  'RUST',
  'SHELL',
  'STRUCTURED_DATA',
  'DOCUMENTATION',
  'ASSET',
  'UNKNOWN_TEXT',
  'UNKNOWN_BINARY',
  'SYMLINK',
  'GITLINK',
];
const TYPE_SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh']);
const STRUCTURED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml']);
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc', '.txt']);
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.otf', '.pdf', '.png', '.svg',
  '.tif', '.tiff', '.ttf', '.webm', '.webp', '.woff', '.woff2', '.mp3', '.mp4', '.mov', '.wav',
]);
const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;

function byteCompare(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
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

function boundedString(value: unknown, maximum = 1_024): string | null {
  return typeof value === 'string'
    && value.length > 0
    && [...value].length <= maximum
    && !value.includes('\0')
    && !/[\r\n]/u.test(value)
    ? value
    : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isCapability(value: unknown): value is 'LSP' | 'AST' {
  return value === 'LSP' || value === 'AST';
}

function safeProgram(value: unknown): string | null {
  const program = boundedString(value, 512);
  if (program === null || !/^[a-zA-Z0-9_./:+@-]+$/u.test(program)) return null;
  const executable = program.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase();
  if (executable === undefined || [
    'sh', 'bash', 'zsh', 'dash', 'fish', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe',
    'pwsh', 'pwsh.exe',
  ].includes(executable)) return null;
  return program;
}

function safeArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || [...entry].length > 1_024 || entry.includes('\0') || /[\r\n]/u.test(entry)) {
      return null;
    }
    args.push(entry);
  }
  return args;
}

export function classifyReviewFile(file: ScopeFile): FileKind {
  if (file.change === 'SYMLINK') return 'SYMLINK';
  if (file.change === 'SUBMODULE') return 'GITLINK';
  const extension = posix.extname(file.path).toLowerCase();
  if (ASSET_EXTENSIONS.has(extension)) return 'ASSET';
  if (file.binary) return 'UNKNOWN_BINARY';
  if (TYPE_SCRIPT_EXTENSIONS.has(extension)) return 'TYPESCRIPT_JAVASCRIPT';
  if (extension === '.rs') return 'RUST';
  if (SHELL_EXTENSIONS.has(extension)) return 'SHELL';
  if (STRUCTURED_EXTENSIONS.has(extension)) return 'STRUCTURED_DATA';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'DOCUMENTATION';
  return 'UNKNOWN_TEXT';
}

function requiredCapabilities(kind: FileKind, rustAstSupported: boolean): Capability[] {
  switch (kind) {
    case 'TYPESCRIPT_JAVASCRIPT':
      return ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK'];
    case 'RUST':
      return rustAstSupported
        ? ['LSP', 'AST', 'LINT', 'RG_FALLBACK']
        : ['LSP', 'LINT', 'RG_FALLBACK'];
    case 'SHELL':
      return ['LINT', 'RG_FALLBACK'];
    case 'STRUCTURED_DATA':
      return ['COMPILER', 'LINT'];
    case 'UNKNOWN_TEXT':
      return ['RG_FALLBACK'];
    default:
      return [];
  }
}

function fallbackTargets(
  capability: Capability,
  applicableKinds: ReadonlySet<FileKind>,
  rustAstSupported: boolean,
): Array<'LSP' | 'AST'> {
  if (capability !== 'COMPILER' && capability !== 'LINT' && capability !== 'RG_FALLBACK') return [];
  const targets = new Set<'LSP' | 'AST'>();
  if (applicableKinds.has('TYPESCRIPT_JAVASCRIPT')) {
    targets.add('LSP');
    targets.add('AST');
  }
  if (applicableKinds.has('RUST') && (capability === 'LINT' || capability === 'RG_FALLBACK')) {
    targets.add('LSP');
    if (rustAstSupported) targets.add('AST');
  }
  return ['LSP', 'AST'].filter((target): target is 'LSP' | 'AST' => targets.has(target as 'LSP' | 'AST'));
}

export function buildCapabilityPlan(
  files: readonly ScopeFile[],
  options: { rustAstSupported?: boolean } = {},
): CapabilityPlan {
  const rustAstSupported = options.rustAstSupported === true;
  const fileKinds = files
    .map((file) => ({ path: file.path, kind: classifyReviewFile(file) }))
    .sort((left, right) => byteCompare(left.path, right.path));
  const kindSet = new Set(fileKinds.map((entry) => entry.kind));
  const capabilities = CAPABILITY_ORDER.map((capability): CapabilityPlanEntry => {
    const kinds = FILE_KIND_ORDER.filter((kind) =>
      kindSet.has(kind) && requiredCapabilities(kind, rustAstSupported).includes(capability),
    );
    return {
      capability,
      applicability: kinds.length > 0 ? 'APPLICABLE' : 'NOT_APPLICABLE',
      file_kinds: kinds,
      fallback_for: fallbackTargets(capability, kindSet, rustAstSupported),
    };
  });
  return {
    file_kinds: fileKinds,
    capabilities,
    inherently_degraded: kindSet.has('UNKNOWN_TEXT'),
  };
}

function failedEvaluation(reasons: string[]): CapabilityEvaluation {
  return {
    evidence_status: 'DEGRADED_EVIDENCE',
    maximum_recommendation: 'REQUEST CHANGES',
    reasons: [...new Set(reasons)],
  };
}

export function evaluateCapabilityEvidence(
  plan: CapabilityPlan,
  observations: readonly CapabilityObservation[],
): CapabilityEvaluation {
  const required = plan.capabilities.filter((entry) => entry.applicability === 'APPLICABLE');
  const requiredNames = new Set(required.map((entry) => entry.capability));
  const byCapability = new Map<Capability, CapabilityObservation>();
  const invalid: string[] = [];
  for (const observation of observations) {
    if (!requiredNames.has(observation.capability)) {
      invalid.push(`UNEXPECTED_CAPABILITY:${observation.capability}`);
      continue;
    }
    if (byCapability.has(observation.capability)) {
      invalid.push(`DUPLICATE_CAPABILITY:${observation.capability}`);
      continue;
    }
    byCapability.set(observation.capability, observation);
  }
  for (const entry of required) {
    if (!byCapability.has(entry.capability)) invalid.push(`MISSING_CAPABILITY:${entry.capability}`);
  }
  if (invalid.length > 0) return failedEvaluation(invalid);

  let degraded = plan.inherently_degraded;
  let hardFailure = false;
  const reasons: string[] = plan.inherently_degraded ? ['UNKNOWN_TEXT_REQUIRES_MANUAL_REVIEW'] : [];
  for (const entry of required) {
    const observation = byCapability.get(entry.capability) as CapabilityObservation;
    const unavailable = (entry.capability === 'LSP' || entry.capability === 'AST')
      && observation.execution === 'UNAVAILABLE';
    if (unavailable) {
      const unavailableCapability = entry.capability as 'LSP' | 'AST';
      degraded = true;
      reasons.push(`${entry.capability}_UNAVAILABLE`);
      if (observation.outcome !== 'NOT_RUN'
        && !(observation.outcome === 'PASS' && observation.empty_result === true)) {
        hardFailure = true;
        reasons.push(`${entry.capability}_UNAVAILABLE_RESULT_INVALID`);
      }
      const fallbacks = required.filter((candidate) =>
        candidate.fallback_for.includes(unavailableCapability),
      );
      if (fallbacks.length === 0 || fallbacks.some((fallback) => {
        const result = byCapability.get(fallback.capability);
        return result?.execution !== 'FALLBACK' || result.outcome !== 'PASS';
      })) {
        hardFailure = true;
        reasons.push(`${entry.capability}_FALLBACK_INCOMPLETE`);
      }
      continue;
    }
    if (observation.outcome !== 'PASS'
      || observation.execution === 'UNAVAILABLE'
      || observation.execution === 'SKIPPED') {
      hardFailure = true;
      reasons.push(`${entry.capability}_${observation.outcome}`);
      continue;
    }
    if ((entry.capability === 'LSP' || entry.capability === 'AST')
      && observation.execution === 'FALLBACK') {
      degraded = true;
      reasons.push(`${entry.capability}_FALLBACK_USED`);
    }
  }

  if (hardFailure) return failedEvaluation(reasons);
  return {
    evidence_status: degraded ? 'DEGRADED_EVIDENCE' : 'FULL_EVIDENCE',
    maximum_recommendation: degraded ? 'COMMENT' : 'APPROVE',
    reasons: [...new Set(reasons)],
  };
}

export function parseAcceptedEquivalentRequests(value: unknown): AcceptedEquivalentRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent requests must be an array');
  }
  const requests = value.map((entry): AcceptedEquivalentRequest => {
    if (!isPlainObject(entry) || !hasExactKeys(entry, ['capability', 'source_ref'])
      || !isCapability(entry.capability)) {
      throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent request is malformed');
    }
    const sourceRef = boundedString(entry.source_ref);
    if (sourceRef === null) {
      throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent source_ref is invalid');
    }
    return { capability: entry.capability, source_ref: sourceRef };
  });
  const identities = requests.map((request) => `${request.capability}\0${request.source_ref}`);
  if (new Set(identities).size !== identities.length) {
    throw new CapabilitiesError('INVALID_EQUIVALENT_REQUEST', 'accepted equivalent request is duplicated');
  }
  return requests;
}

interface ParsedHookApproval {
  session_id: string;
  root_thread_id: string;
  turn_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  program: string;
  args: string[];
  approved_at: string;
  nonce: string;
}

function parseHookApproval(value: unknown): ParsedHookApproval | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ['approval', 'provenance'])
    || !isPlainObject(value.approval) || !isPlainObject(value.provenance)) return null;
  const approval = value.approval;
  const provenance = value.provenance;
  if (!hasExactKeys(approval, [
    'schema_version', 'session_id', 'root_thread_id', 'turn_id', 'capability', 'source_ref',
    'program', 'args', 'approved_at', 'nonce',
  ]) || !hasExactKeys(provenance, ['owner', 'event_ref', 'nonce'])
    || approval.schema_version !== 1 || !isCapability(approval.capability)
    || provenance.owner !== 'CODEX_NATIVE_HOOK') return null;
  const sessionId = boundedString(approval.session_id, 160);
  const rootThreadId = boundedString(approval.root_thread_id, 160);
  const turnId = boundedString(approval.turn_id, 160);
  const sourceRef = boundedString(approval.source_ref);
  const program = safeProgram(approval.program);
  const args = safeArgs(approval.args);
  const approvedAt = boundedString(approval.approved_at, 64);
  const nonce = boundedString(approval.nonce, 160);
  const provenanceNonce = boundedString(provenance.nonce, 160);
  const eventRef = boundedString(provenance.event_ref);
  if (sessionId === null || rootThreadId === null || turnId === null || sourceRef === null
    || program === null || args === null || approvedAt === null || nonce === null
    || provenanceNonce !== nonce || eventRef === null || !Number.isFinite(Date.parse(approvedAt))) return null;
  return {
    session_id: sessionId,
    root_thread_id: rootThreadId,
    turn_id: turnId,
    capability: approval.capability,
    source_ref: sourceRef,
    program,
    args,
    approved_at: approvedAt,
    nonce,
  };
}

interface EquivalentConsumptionInput {
  nonce: string;
  review_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
}

function validateConsumptionIdentity(value: unknown): EquivalentConsumptionInput {
  if (!isPlainObject(value) || !hasExactKeys(value, ['nonce', 'review_id', 'capability', 'source_ref'])
    || !isCapability(value.capability)) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption identity is malformed');
  }
  const nonce = boundedString(value.nonce, 160);
  const reviewId = boundedString(value.review_id, 64);
  const sourceRef = boundedString(value.source_ref);
  if (nonce === null || reviewId === null || !isUuid(reviewId) || sourceRef === null) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption identity is malformed');
  }
  return { nonce, review_id: reviewId, capability: value.capability, source_ref: sourceRef };
}

function parseConsumption(
  value: unknown,
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  if (!isPlainObject(value) || (value.state !== 'PREPARED' && value.state !== 'COMMITTED')) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption is malformed');
  }
  const committed = value.state === 'COMMITTED';
  const keys = committed
    ? ['schema_version', 'state', 'nonce', 'review_id', 'capability', 'source_ref', 'prepared_at', 'committed_at']
    : ['schema_version', 'state', 'nonce', 'review_id', 'capability', 'source_ref', 'prepared_at'];
  if (!hasExactKeys(value, keys) || value.schema_version !== 1 || !isCapability(value.capability)) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption is malformed');
  }
  const identity = validateConsumptionIdentity({
    nonce: value.nonce,
    review_id: value.review_id,
    capability: value.capability,
    source_ref: value.source_ref,
  });
  const preparedAt = boundedString(value.prepared_at, 64);
  const committedAt = committed ? boundedString(value.committed_at, 64) : null;
  if (preparedAt === null || !Number.isFinite(Date.parse(preparedAt))
    || (committed && (committedAt === null || !Number.isFinite(Date.parse(committedAt))))) {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'equivalent consumption timestamp is invalid');
  }
  const prepared: PreparedEquivalentConsumption = {
    schema_version: 1,
    state: 'PREPARED',
    ...identity,
    prepared_at: preparedAt,
  };
  return committed
    ? { ...prepared, state: 'COMMITTED', committed_at: committedAt as string }
    : prepared;
}

function sameConsumptionIdentity(
  left: EquivalentConsumptionInput,
  right: EquivalentConsumptionInput,
): boolean {
  return left.nonce === right.nonce
    && left.review_id === right.review_id
    && left.capability === right.capability
    && left.source_ref === right.source_ref;
}

function assertSameConsumption(
  expected: EquivalentConsumptionInput,
  existing: PreparedEquivalentConsumption | CommittedEquivalentConsumption,
): void {
  if (!sameConsumptionIdentity(expected, existing)) {
    throw new CapabilitiesError(
      'EQUIVALENT_CONSUMPTION_CONFLICT',
      'approval nonce is already bound to a different review',
    );
  }
}

export function prepareEquivalentConsumption(
  inputValue: EquivalentConsumptionInput,
  existing?: unknown,
  now = new Date(),
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  const input = validateConsumptionIdentity(inputValue);
  if (existing !== undefined) {
    const parsed = parseConsumption(existing);
    assertSameConsumption(input, parsed);
    return parsed;
  }
  return {
    schema_version: 1,
    state: 'PREPARED',
    ...input,
    prepared_at: now.toISOString(),
  };
}

export function commitEquivalentConsumption(
  preparedValue: PreparedEquivalentConsumption,
  existing?: unknown,
  now = new Date(),
): CommittedEquivalentConsumption {
  const prepared = parseConsumption(preparedValue);
  if (prepared.state !== 'PREPARED') {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'only a prepared consumption can commit');
  }
  if (existing !== undefined) {
    const parsed = parseConsumption(existing);
    assertSameConsumption(prepared, parsed);
    if (parsed.state === 'COMMITTED') return parsed;
  }
  return { ...prepared, state: 'COMMITTED', committed_at: now.toISOString() };
}

export function recoverEquivalentConsumption(
  preparedValue: PreparedEquivalentConsumption,
  existing: unknown,
): PreparedEquivalentConsumption | CommittedEquivalentConsumption {
  const prepared = parseConsumption(preparedValue);
  if (prepared.state !== 'PREPARED') {
    throw new CapabilitiesError('EQUIVALENT_CONSUMPTION_CONFLICT', 'recovery intent is not prepared');
  }
  const parsed = parseConsumption(existing);
  assertSameConsumption(prepared, parsed);
  return parsed;
}

interface RepositoryEquivalent {
  capability: 'LSP' | 'AST';
  program: string;
  args: string[];
  rule_id: string;
}

function parseRepositoryContract(text: string): RepositoryEquivalent[] | null {
  if (Buffer.byteLength(text, 'utf8') > 64 * 1_024) return null;
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !hasExactKeys(value, ['schema_version', 'equivalents'])
    || value.schema_version !== 1 || !Array.isArray(value.equivalents)
    || value.equivalents.length > 128) return null;
  const equivalents: RepositoryEquivalent[] = [];
  for (const entry of value.equivalents) {
    if (!isPlainObject(entry)
      || !hasExactKeys(entry, ['capability', 'program', 'args', 'rule_id'])
      || !isCapability(entry.capability)) return null;
    const program = safeProgram(entry.program);
    const args = safeArgs(entry.args);
    const ruleId = boundedString(entry.rule_id, 160);
    if (program === null || args === null || ruleId === null
      || !/^[a-zA-Z0-9_.-]+$/u.test(ruleId)) return null;
    equivalents.push({ capability: entry.capability, program, args, rule_id: ruleId });
  }
  if (new Set(equivalents.map((entry) => entry.rule_id)).size !== equivalents.length) return null;
  return equivalents;
}

function rawApprovalMatches(value: unknown, request: AcceptedEquivalentRequest): boolean {
  return isPlainObject(value) && isPlainObject(value.approval)
    && value.approval.capability === request.capability
    && value.approval.source_ref === request.source_ref;
}

function rawConsumptionNonce(value: unknown): unknown {
  return isPlainObject(value) ? value.nonce : undefined;
}

function reason(capability: 'LSP' | 'AST', code: string): string {
  return `${capability}_${code}`;
}

export async function resolveTrustedEquivalents(
  options: ResolveTrustedEquivalentsOptions,
): Promise<TrustedEquivalentResolution> {
  const requests = parseAcceptedEquivalentRequests(options.requests);
  const now = options.now ?? new Date();
  const ttl = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const ledger = options.explicitApprovalLedger ?? [];
  const consumptions = options.existingConsumptions ?? [];
  const accepted: AcceptedEquivalent[] = [];
  const reasons: string[] = [];
  const preparedConsumptions: PreparedEquivalentConsumption[] = [];
  let repositoryContract: RepositoryEquivalent[] | null | undefined;

  for (const request of requests) {
    const candidates = ledger.filter((entry) => rawApprovalMatches(entry, request));
    if (candidates.length > 0) {
      if (candidates.length !== 1) {
        reasons.push(reason(request.capability, 'EXPLICIT_APPROVAL_DUPLICATE'));
        continue;
      }
      const approval = parseHookApproval(candidates[0]);
      const approvedAt = approval === null ? Number.NaN : Date.parse(approval.approved_at);
      if (approval === null
        || approval.session_id !== options.context.session_id
        || approval.root_thread_id !== options.context.root_thread_id
        || approval.turn_id !== options.context.turn_id
        || approval.capability !== request.capability
        || approval.source_ref !== request.source_ref
        || !Number.isSafeInteger(ttl) || ttl <= 0
        || approvedAt > now.getTime()
        || now.getTime() - approvedAt > ttl) {
        reasons.push(reason(request.capability, 'EXPLICIT_APPROVAL_UNAVAILABLE'));
        continue;
      }

      const matchingConsumptions = [...consumptions, ...preparedConsumptions]
        .filter((entry) => rawConsumptionNonce(entry) === approval.nonce);
      if (matchingConsumptions.length > 1) {
        reasons.push(reason(request.capability, 'APPROVAL_NONCE_CONFLICT'));
        continue;
      }
      let existing: PreparedEquivalentConsumption | CommittedEquivalentConsumption | undefined;
      if (matchingConsumptions.length === 1) {
        try {
          existing = parseConsumption(matchingConsumptions[0]);
        } catch {
          reasons.push(reason(request.capability, 'APPROVAL_CONSUMPTION_UNVERIFIABLE'));
          continue;
        }
      }
      const identity: EquivalentConsumptionInput = {
        nonce: approval.nonce,
        review_id: options.context.review_id,
        capability: request.capability,
        source_ref: request.source_ref,
      };
      let consumption: PreparedEquivalentConsumption | CommittedEquivalentConsumption;
      try {
        consumption = prepareEquivalentConsumption(identity, existing, now);
      } catch {
        reasons.push(reason(request.capability, 'APPROVAL_NONCE_CONFLICT'));
        continue;
      }
      accepted.push({
        capability: request.capability,
        source: 'EXPLICIT_USER',
        source_ref: request.source_ref,
        program: approval.program,
        args: [...approval.args],
      });
      if (consumption.state === 'PREPARED') preparedConsumptions.push(consumption);
      continue;
    }

    const baseSha = options.context.base_sha;
    const prefix = baseSha === undefined
      ? undefined
      : `${baseSha}:code-review-equivalents.json#`;
    if (prefix === undefined || !request.source_ref.startsWith(prefix)) {
      reasons.push(reason(request.capability, 'TRUSTED_SOURCE_UNAVAILABLE'));
      continue;
    }
    const ruleId = request.source_ref.slice(prefix.length);
    if (!/^[a-zA-Z0-9_.-]+$/u.test(ruleId) || options.readBaseContract === undefined) {
      reasons.push(reason(request.capability, 'REPO_CONTRACT_UNAVAILABLE'));
      continue;
    }
    if (repositoryContract === undefined) {
      try {
        const text = await options.readBaseContract(
          options.context.workingDirectory,
          ['show', `${baseSha}:code-review-equivalents.json`],
        );
        repositoryContract = parseRepositoryContract(text);
      } catch {
        repositoryContract = null;
      }
    }
    if (repositoryContract === null) {
      reasons.push(reason(request.capability, 'REPO_CONTRACT_INVALID'));
      continue;
    }
    const matches = repositoryContract.filter((entry) =>
      entry.rule_id === ruleId && entry.capability === request.capability,
    );
    if (matches.length !== 1) {
      reasons.push(reason(request.capability, 'REPO_RULE_UNAVAILABLE'));
      continue;
    }
    const equivalent = matches[0] as RepositoryEquivalent;
    accepted.push({
      capability: equivalent.capability,
      program: equivalent.program,
      args: [...equivalent.args],
      source: 'REPO_CONTRACT',
      source_ref: request.source_ref,
    });
  }

  return {
    accepted_equivalents: accepted,
    reasons,
    prepared_consumptions: preparedConsumptions,
  };
}
