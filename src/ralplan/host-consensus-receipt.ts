import {
  createHash,
  randomBytes,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

export const CODEX_HOST_CONSENSUS_PROTOCOL_VERSION = 1 as const;
export const CODEX_HOST_CONSENSUS_AUDIENCE = 'oh-my-codex.ralplan-handoff.v1' as const;
export const CODEX_HOST_CONSENSUS_JWS_TYPE = 'omx-ralplan-consensus-receipt+jws' as const;
export const CODEX_HOST_CONSENSUS_JWS_ALGORITHM = 'EdDSA' as const;

export const CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS = {
  documentedHostConsensusReceiptUnavailable: 'documented_host_consensus_receipt_unavailable',
  hostTransportFailure: 'host_consensus_receipt_transport_failure',
  malformedReceipt: 'malformed_host_consensus_receipt',
  unsupportedReceiptVersion: 'unsupported_host_consensus_receipt_version',
  unsupportedSignatureAlgorithm: 'unsupported_host_consensus_receipt_signature_algorithm',
  untrustedIssuer: 'untrusted_host_consensus_receipt_issuer',
  invalidSignature: 'invalid_host_consensus_receipt_signature',
  claimMismatch: 'host_consensus_receipt_claim_mismatch',
  notYetValid: 'host_consensus_receipt_not_yet_valid',
  expired: 'host_consensus_receipt_expired',
  replayed: 'host_consensus_receipt_replayed',
  consumeRejected: 'host_consensus_receipt_consume_rejected',
} as const;

export type CodexHostConsensusReceiptFailureReason =
  typeof CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS[keyof typeof CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS];

export const CODEX_HOST_CONSENSUS_REQUIRED_CAPABILITIES = Object.freeze([
  'documented_host_transport',
  'compiled_pinned_issuer_trust_root',
  'replay_safe_online_consume',
] as const);

export type CodexHostConsensusRequiredCapability =
  typeof CODEX_HOST_CONSENSUS_REQUIRED_CAPABILITIES[number];
export type RalplanHostConsensusReceiptVerifierCapability = 'available' | 'unavailable';

export interface CodexHostConsensusVerifierIntegrationStatus {
  readonly documentedHostTransport: boolean;
  readonly compiledPinnedIssuerTrustRoot: boolean;
  readonly replaySafeOnlineConsume: boolean;
}

export interface CodexHostConsensusVerifierReadiness {
  readonly capability: RalplanHostConsensusReceiptVerifierCapability;
  readonly missing: readonly CodexHostConsensusRequiredCapability[];
}

/** Phase 1 has no production bindings and performs no dynamic discovery. */
const PRODUCTION_INTEGRATIONS: CodexHostConsensusVerifierIntegrationStatus = Object.freeze({
  documentedHostTransport: false,
  compiledPinnedIssuerTrustRoot: false,
  replaySafeOnlineConsume: false,
});

export function assessCodexHostConsensusVerifierReadiness(
  integrations: CodexHostConsensusVerifierIntegrationStatus,
): CodexHostConsensusVerifierReadiness {
  const missing: CodexHostConsensusRequiredCapability[] = [];
  if (!integrations.documentedHostTransport) missing.push('documented_host_transport');
  if (!integrations.compiledPinnedIssuerTrustRoot) missing.push('compiled_pinned_issuer_trust_root');
  if (!integrations.replaySafeOnlineConsume) missing.push('replay_safe_online_consume');
  return Object.freeze({
    capability: missing.length === 0 ? 'available' : 'unavailable',
    missing: Object.freeze(missing),
  });
}

export function getCodexHostConsensusVerifierReadiness(): CodexHostConsensusVerifierReadiness {
  return assessCodexHostConsensusVerifierReadiness(PRODUCTION_INTEGRATIONS);
}

export interface CodexHostConsensusChallenge {
  readonly protocolVersion: typeof CODEX_HOST_CONSENSUS_PROTOCOL_VERSION;
  readonly requestNonce: string;
  readonly audience: typeof CODEX_HOST_CONSENSUS_AUDIENCE;
  readonly rootSessionId: string;
  readonly evidenceSha256: string;
}

export interface CodexHostConsensusReviewClaim {
  readonly role: 'architect' | 'critic';
  readonly threadId: string;
  readonly approvedAt: string;
}

export interface CodexHostConsensusReceiptClaims extends CodexHostConsensusChallenge {
  readonly receiptId: string;
  readonly issuer: string;
  readonly sequence: readonly ['architect-review', 'critic-review'];
  readonly architect: CodexHostConsensusReviewClaim;
  readonly critic: CodexHostConsensusReviewClaim;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
}

export interface CodexHostConsensusExpectedClaims {
  readonly challenge: CodexHostConsensusChallenge;
  readonly architectThreadId: string;
  readonly criticThreadId: string;
}

export interface DocumentedCodexHostConsensusTransport {
  readonly kind: 'documented_codex_host_consensus_transport';
  receiveRalplanConsensusReceipt(challenge: CodexHostConsensusChallenge): Promise<{ readonly receipt: string }>;
}

/**
 * Test seam only. Production enablement requires a compiled, pinned trust root;
 * it must not accept a key from repository state, .omx, environment, stdin, CLI,
 * transcripts, trackers, or any other same-user carrier.
 */
export interface TestOnlyCodexHostConsensusTrustRoot {
  readonly issuer: string;
  readonly keyId: string;
  readonly algorithm: typeof CODEX_HOST_CONSENSUS_JWS_ALGORITHM;
  readonly publicKey: KeyObject;
}

export interface ReplaySafeCodexHostConsensusConsumer {
  readonly kind: 'replay_safe_codex_host_consensus_consumer';
  consume(input: {
    readonly challenge: CodexHostConsensusChallenge;
    readonly receiptId: string;
    readonly signedTokenSha256: string;
  }): Promise<'consumed' | 'already_consumed' | 'rejected'>;
}

export type CodexHostConsensusReceiptVerificationResult = {
  readonly ok: true;
  readonly claims: CodexHostConsensusReceiptClaims;
} | {
  readonly ok: false;
  readonly reason: CodexHostConsensusReceiptFailureReason;
};

const JWS_HEADER_KEYS = new Set(['typ', 'kid', 'alg']);
const TRANSPORT_RESPONSE_KEYS = new Set(['receipt']);
const CHALLENGE_KEYS = new Set([
  'protocolVersion',
  'requestNonce',
  'audience',
  'rootSessionId',
  'evidenceSha256',
]);
const CLAIM_KEYS = new Set([
  ...CHALLENGE_KEYS,
  'receiptId',
  'issuer',
  'sequence',
  'architect',
  'critic',
  'issuedAt',
  'notBefore',
  'expiresAt',
]);
const REVIEW_KEYS = new Set(['role', 'threadId', 'approvedAt']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_NONCE = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const JWS_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_COMPACT_JWS_BYTES = 16 * 1024;
const MAX_RECEIPT_VALIDITY_MS = 5 * 60 * 1000;
const EVIDENCE_DOMAIN = Buffer.from('omx.ralplan.consensus-evidence.v1\0', 'utf8');
const REQUIREMENTS_LABEL = Buffer.from('requirements\0', 'utf8');
const PLAN_LABEL = Buffer.from('plan\0', 'utf8');

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function canonicalRequestNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !REQUEST_NONCE.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
}

function uint64be(value: number): Buffer {
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

/**
 * SHA-256(domain || "requirements\\0" || uint64be(requirements.length) ||
 * SHA-256(requirements) || "plan\\0" || uint64be(plan.length) || SHA-256(plan)).
 */
export function computeCodexHostConsensusEvidenceSha256(input: {
  readonly requirements: Uint8Array;
  readonly plan: Uint8Array;
}): string {
  const requirements = Buffer.from(input.requirements);
  const plan = Buffer.from(input.plan);
  const requirementsDigest = createHash('sha256').update(requirements).digest();
  const planDigest = createHash('sha256').update(plan).digest();
  return createHash('sha256')
    .update(EVIDENCE_DOMAIN)
    .update(REQUIREMENTS_LABEL)
    .update(uint64be(requirements.byteLength))
    .update(requirementsDigest)
    .update(PLAN_LABEL)
    .update(uint64be(plan.byteLength))
    .update(planDigest)
    .digest('hex');
}

function parseChallenge(value: unknown): CodexHostConsensusChallenge | null {
  const challenge = record(value);
  if (
    !challenge
    || !hasExactKeys(challenge, CHALLENGE_KEYS)
    || challenge.protocolVersion !== CODEX_HOST_CONSENSUS_PROTOCOL_VERSION
    || !canonicalRequestNonce(challenge.requestNonce)
    || challenge.audience !== CODEX_HOST_CONSENSUS_AUDIENCE
    || typeof challenge.rootSessionId !== 'string'
    || !CANONICAL_UUID.test(challenge.rootSessionId)
    || typeof challenge.evidenceSha256 !== 'string'
    || !SHA256.test(challenge.evidenceSha256)
  ) return null;
  return Object.freeze({
    protocolVersion: CODEX_HOST_CONSENSUS_PROTOCOL_VERSION,
    requestNonce: challenge.requestNonce,
    audience: challenge.audience,
    rootSessionId: challenge.rootSessionId,
    evidenceSha256: challenge.evidenceSha256,
  });
}

export function createCodexHostConsensusChallenge(input: {
  readonly rootSessionId: string;
  readonly evidenceSha256: string;
  readonly requestNonce?: string;
}): CodexHostConsensusChallenge {
  const challenge = parseChallenge({
    protocolVersion: CODEX_HOST_CONSENSUS_PROTOCOL_VERSION,
    requestNonce: input.requestNonce ?? randomBytes(32).toString('base64url'),
    audience: CODEX_HOST_CONSENSUS_AUDIENCE,
    rootSessionId: input.rootSessionId,
    evidenceSha256: input.evidenceSha256,
  });
  if (!challenge) throw new Error('invalid Codex host consensus challenge');
  return challenge;
}

function parseReviewClaim(value: unknown, role: 'architect' | 'critic'): CodexHostConsensusReviewClaim | null {
  const review = record(value);
  if (
    !review
    || !hasExactKeys(review, REVIEW_KEYS)
    || review.role !== role
    || typeof review.threadId !== 'string'
    || !CANONICAL_UUID.test(review.threadId)
    || !canonicalIso(review.approvedAt)
  ) return null;
  return { role, threadId: review.threadId, approvedAt: review.approvedAt };
}

function parseClaims(value: unknown): CodexHostConsensusReceiptClaims | null {
  const claims = record(value);
  if (!claims || !hasExactKeys(claims, CLAIM_KEYS)) return null;
  const challenge = parseChallenge(Object.fromEntries(
    [...CHALLENGE_KEYS].map((key) => [key, claims[key]]),
  ));
  const architect = parseReviewClaim(claims.architect, 'architect');
  const critic = parseReviewClaim(claims.critic, 'critic');
  const sequence = claims.sequence;
  if (
    !challenge
    || typeof claims.receiptId !== 'string'
    || !SAFE_ID.test(claims.receiptId)
    || typeof claims.issuer !== 'string'
    || !SAFE_ID.test(claims.issuer)
    || !Array.isArray(sequence)
    || sequence.length !== 2
    || sequence[0] !== 'architect-review'
    || sequence[1] !== 'critic-review'
    || !architect
    || !critic
    || !canonicalIso(claims.issuedAt)
    || !canonicalIso(claims.notBefore)
    || !canonicalIso(claims.expiresAt)
  ) return null;
  return {
    ...challenge,
    receiptId: claims.receiptId,
    issuer: claims.issuer,
    sequence: ['architect-review', 'critic-review'],
    architect,
    critic,
    issuedAt: claims.issuedAt,
    notBefore: claims.notBefore,
    expiresAt: claims.expiresAt,
  };
}

export function serializeCodexHostConsensusJwsProtectedHeader(keyId: string): Buffer {
  return Buffer.from(JSON.stringify({
    typ: CODEX_HOST_CONSENSUS_JWS_TYPE,
    kid: keyId,
    alg: CODEX_HOST_CONSENSUS_JWS_ALGORITHM,
  }), 'utf8');
}

export function serializeCodexHostConsensusJwsPayload(claims: CodexHostConsensusReceiptClaims): Buffer {
  return Buffer.from(JSON.stringify({
    protocolVersion: claims.protocolVersion,
    requestNonce: claims.requestNonce,
    audience: claims.audience,
    rootSessionId: claims.rootSessionId,
    evidenceSha256: claims.evidenceSha256,
    receiptId: claims.receiptId,
    issuer: claims.issuer,
    sequence: [...claims.sequence],
    architect: {
      role: claims.architect.role,
      threadId: claims.architect.threadId,
      approvedAt: claims.architect.approvedAt,
    },
    critic: {
      role: claims.critic.role,
      threadId: claims.critic.threadId,
      approvedAt: claims.critic.approvedAt,
    },
    issuedAt: claims.issuedAt,
    notBefore: claims.notBefore,
    expiresAt: claims.expiresAt,
  }), 'utf8');
}

function decodeCanonicalSegment(segment: string, maxBytes: number): Buffer | null {
  if (!BASE64URL_SEGMENT.test(segment)) return null;
  const decoded = Buffer.from(segment, 'base64url');
  return decoded.byteLength <= maxBytes && decoded.toString('base64url') === segment ? decoded : null;
}

function parseCanonicalJson(bytes: Buffer): Record<string, unknown> | null {
  try {
    return record(JSON.parse(bytes.toString('utf8')));
  } catch {
    return null;
  }
}

type ParsedCompactJws = {
  readonly keyId: string;
  readonly claims: CodexHostConsensusReceiptClaims;
  readonly signingInput: Buffer;
  readonly signature: Buffer;
};

function parseCompactJws(receipt: string): ParsedCompactJws | CodexHostConsensusReceiptVerificationResult {
  if (Buffer.byteLength(receipt, 'utf8') > MAX_COMPACT_JWS_BYTES) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  const segments = receipt.split('.');
  if (segments.length !== 3) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  const [protectedSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const protectedBytes = decodeCanonicalSegment(protectedSegment, 1024);
  const payloadBytes = decodeCanonicalSegment(payloadSegment, MAX_COMPACT_JWS_BYTES);
  if (!protectedBytes || !payloadBytes || !JWS_SIGNATURE.test(signatureSegment)) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  const header = parseCanonicalJson(protectedBytes);
  if (!header || !hasExactKeys(header, JWS_HEADER_KEYS)) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  if (header.typ !== CODEX_HOST_CONSENSUS_JWS_TYPE) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.unsupportedReceiptVersion };
  }
  if (header.alg !== CODEX_HOST_CONSENSUS_JWS_ALGORITHM) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.unsupportedSignatureAlgorithm };
  }
  if (typeof header.kid !== 'string' || !SAFE_ID.test(header.kid)) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  const claims = parseClaims(parseCanonicalJson(payloadBytes));
  if (
    !claims
    || !protectedBytes.equals(serializeCodexHostConsensusJwsProtectedHeader(header.kid))
    || !payloadBytes.equals(serializeCodexHostConsensusJwsPayload(claims))
  ) return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  const signature = decodeCanonicalSegment(signatureSegment, 64);
  if (!signature || signature.byteLength !== 64) {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  }
  return {
    keyId: header.kid,
    claims,
    signingInput: Buffer.from(`${protectedSegment}.${payloadSegment}`, 'ascii'),
    signature,
  };
}

function challengesEqual(left: CodexHostConsensusChallenge, right: CodexHostConsensusChallenge): boolean {
  return left.protocolVersion === right.protocolVersion
    && left.requestNonce === right.requestNonce
    && left.audience === right.audience
    && left.rootSessionId === right.rootSessionId
    && left.evidenceSha256 === right.evidenceSha256;
}

function validateClaims(
  claims: CodexHostConsensusReceiptClaims,
  expected: CodexHostConsensusExpectedClaims,
  nowMs: number,
): CodexHostConsensusReceiptFailureReason | null {
  if (!Number.isFinite(nowMs)) return CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.claimMismatch;
  const architectApprovedAt = Date.parse(claims.architect.approvedAt);
  const criticApprovedAt = Date.parse(claims.critic.approvedAt);
  const issuedAt = Date.parse(claims.issuedAt);
  const notBefore = Date.parse(claims.notBefore);
  const expiresAt = Date.parse(claims.expiresAt);
  if (nowMs < notBefore || nowMs < issuedAt) {
    return CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.notYetValid;
  }
  if (nowMs >= expiresAt) return CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.expired;
  if (
    !challengesEqual(claims, expected.challenge)
    || claims.architect.role !== 'architect'
    || claims.critic.role !== 'critic'
    || claims.architect.threadId === claims.critic.threadId
    || claims.architect.threadId !== expected.architectThreadId
    || claims.critic.threadId !== expected.criticThreadId
    || architectApprovedAt >= criticApprovedAt
    || criticApprovedAt > issuedAt
    || notBefore > issuedAt
    || issuedAt >= expiresAt
    || expiresAt - issuedAt > MAX_RECEIPT_VALIDITY_MS
  ) return CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.claimMismatch;
  return null;
}

/**
 * Phase-1 test scaffold. It cannot authorize production because the production
 * transport, compiled trust root, consumer, and gate wiring remain absent.
 */
export async function verifyAndConsumeCodexHostConsensusReceipt(input: {
  readonly transport: DocumentedCodexHostConsensusTransport;
  readonly testOnlyTrustRoot: TestOnlyCodexHostConsensusTrustRoot;
  readonly consumer: ReplaySafeCodexHostConsensusConsumer;
  readonly expected: CodexHostConsensusExpectedClaims;
  readonly nowMs: number;
}): Promise<CodexHostConsensusReceiptVerificationResult> {
  const challenge = parseChallenge(input.expected.challenge);
  if (!challenge) return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.claimMismatch };
  if (input.transport.kind !== 'documented_codex_host_consensus_transport') {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.hostTransportFailure };
  }
  let response: unknown;
  try {
    response = await input.transport.receiveRalplanConsensusReceipt(challenge);
  } catch {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.hostTransportFailure };
  }
  const responseRecord = record(response);
  if (
    !responseRecord
    || !hasExactKeys(responseRecord, TRANSPORT_RESPONSE_KEYS)
    || typeof responseRecord.receipt !== 'string'
  ) return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.malformedReceipt };
  const parsed = parseCompactJws(responseRecord.receipt);
  if ('ok' in parsed) return parsed;
  if (
    parsed.claims.issuer !== input.testOnlyTrustRoot.issuer
    || parsed.keyId !== input.testOnlyTrustRoot.keyId
    || input.testOnlyTrustRoot.algorithm !== CODEX_HOST_CONSENSUS_JWS_ALGORITHM
  ) return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.untrustedIssuer };
  try {
    if (
      input.testOnlyTrustRoot.publicKey.type !== 'public'
      || !verifySignature(null, parsed.signingInput, input.testOnlyTrustRoot.publicKey, parsed.signature)
    ) return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.invalidSignature };
  } catch {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.invalidSignature };
  }
  const claimFailure = validateClaims(parsed.claims, { ...input.expected, challenge }, input.nowMs);
  if (claimFailure) return { ok: false, reason: claimFailure };
  if (input.consumer.kind !== 'replay_safe_codex_host_consensus_consumer') {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.consumeRejected };
  }
  let consumed: 'consumed' | 'already_consumed' | 'rejected';
  try {
    consumed = await input.consumer.consume({
      challenge,
      receiptId: parsed.claims.receiptId,
      signedTokenSha256: createHash('sha256').update(responseRecord.receipt, 'utf8').digest('hex'),
    });
  } catch {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.consumeRejected };
  }
  if (consumed === 'already_consumed') {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.replayed };
  }
  if (consumed !== 'consumed') {
    return { ok: false, reason: CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS.consumeRejected };
  }
  return { ok: true, claims: parsed.claims };
}
