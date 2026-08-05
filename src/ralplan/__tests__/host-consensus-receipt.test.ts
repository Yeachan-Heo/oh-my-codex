import assert from 'node:assert/strict';
import {
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { describe, it } from 'node:test';

import {
  assessCodexHostConsensusVerifierReadiness,
  CODEX_HOST_CONSENSUS_JWS_ALGORITHM,
  CODEX_HOST_CONSENSUS_JWS_TYPE,
  CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS,
  computeCodexHostConsensusEvidenceSha256,
  createCodexHostConsensusChallenge,
  getCodexHostConsensusVerifierReadiness,
  serializeCodexHostConsensusJwsPayload,
  serializeCodexHostConsensusJwsProtectedHeader,
  verifyAndConsumeCodexHostConsensusReceipt,
  type CodexHostConsensusChallenge,
  type CodexHostConsensusReceiptClaims,
  type ReplaySafeCodexHostConsensusConsumer,
} from '../host-consensus-receipt.js';

const RFC_8032_TEST_SEED = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc4' +
  '4449c5697b326919703bac031cae7f60',
  'hex',
);
const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    RFC_8032_TEST_SEED,
  ]),
  format: 'der',
  type: 'pkcs8',
});
const TEST_PUBLIC_KEY = createPublicKey(TEST_PRIVATE_KEY);
const KEY_ID = 'codex-host-test-key-1';
const NOW_MS = Date.parse('2026-08-05T12:03:00.000Z');
const REQUIREMENTS = Buffer.from('requirements bytes\n', 'utf8');
const PLAN = Buffer.from('plan bytes\n', 'utf8');
const REQUEST_NONCE = Buffer.alloc(32, 7).toString('base64url');
const EVIDENCE_SHA256 = computeCodexHostConsensusEvidenceSha256({ requirements: REQUIREMENTS, plan: PLAN });

const BASE_CHALLENGE = createCodexHostConsensusChallenge({
  requestNonce: REQUEST_NONCE,
  rootSessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSha256: EVIDENCE_SHA256,
});

const BASE_CLAIMS: CodexHostConsensusReceiptClaims = {
  ...BASE_CHALLENGE,
  receiptId: 'receipt-0001',
  issuer: 'openai-codex-host',
  sequence: ['architect-review', 'critic-review'],
  architect: {
    role: 'architect',
    threadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    approvedAt: '2026-08-05T12:00:00.000Z',
  },
  critic: {
    role: 'critic',
    threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    approvedAt: '2026-08-05T12:01:00.000Z',
  },
  issuedAt: '2026-08-05T12:02:00.000Z',
  notBefore: '2026-08-05T12:02:00.000Z',
  expiresAt: '2026-08-05T12:07:00.000Z',
};

function compactJws(
  claims: CodexHostConsensusReceiptClaims = BASE_CLAIMS,
  protectedBytes = serializeCodexHostConsensusJwsProtectedHeader(KEY_ID),
  payloadBytes = serializeCodexHostConsensusJwsPayload(claims),
): string {
  const protectedSegment = protectedBytes.toString('base64url');
  const payloadSegment = payloadBytes.toString('base64url');
  const signingInput = Buffer.from(`${protectedSegment}.${payloadSegment}`, 'ascii');
  return `${protectedSegment}.${payloadSegment}.${sign(null, signingInput, TEST_PRIVATE_KEY).toString('base64url')}`;
}

function expected(challenge: CodexHostConsensusChallenge = BASE_CHALLENGE) {
  return {
    challenge,
    architectThreadId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    criticThreadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
}

function consumer(result: 'consumed' | 'already_consumed' | 'rejected' = 'consumed') {
  const calls: Array<{
    challenge: CodexHostConsensusChallenge;
    receiptId: string;
    signedTokenSha256: string;
  }> = [];
  const value: ReplaySafeCodexHostConsensusConsumer = {
    kind: 'replay_safe_codex_host_consensus_consumer',
    async consume(input) {
      calls.push(input);
      return result;
    },
  };
  return { value, calls };
}

async function verify(
  receipt: string,
  options: {
    challenge?: CodexHostConsensusChallenge;
    consumeResult?: 'consumed' | 'already_consumed' | 'rejected';
    architectThreadId?: string;
    criticThreadId?: string;
    nowMs?: number;
  } = {},
) {
  const replayConsumer = consumer(options.consumeResult);
  const receivedChallenges: CodexHostConsensusChallenge[] = [];
  const result = await verifyAndConsumeCodexHostConsensusReceipt({
    transport: {
      kind: 'documented_codex_host_consensus_transport',
      async receiveRalplanConsensusReceipt(challenge) {
        receivedChallenges.push(challenge);
        return { receipt };
      },
    },
    testOnlyTrustRoot: {
      issuer: 'openai-codex-host',
      keyId: KEY_ID,
      algorithm: CODEX_HOST_CONSENSUS_JWS_ALGORITHM,
      publicKey: TEST_PUBLIC_KEY,
    },
    consumer: replayConsumer.value,
    expected: {
      ...expected(options.challenge),
      architectThreadId: options.architectThreadId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      criticThreadId: options.criticThreadId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    },
    nowMs: options.nowMs ?? NOW_MS,
  });
  return { result, consumeCalls: replayConsumer.calls, receivedChallenges };
}

describe('Codex host consensus verifier readiness', () => {
  it('keeps production unavailable until all three host capabilities exist', () => {
    assert.deepEqual(getCodexHostConsensusVerifierReadiness(), {
      capability: 'unavailable',
      missing: [
        'documented_host_transport',
        'compiled_pinned_issuer_trust_root',
        'replay_safe_online_consume',
      ],
    });
    assert.equal(assessCodexHostConsensusVerifierReadiness({
      documentedHostTransport: true,
      compiledPinnedIssuerTrustRoot: true,
      replaySafeOnlineConsume: false,
    }).capability, 'unavailable');
    assert.equal(assessCodexHostConsensusVerifierReadiness({
      documentedHostTransport: true,
      compiledPinnedIssuerTrustRoot: true,
      replaySafeOnlineConsume: true,
    }).capability, 'available');
  });

  it('does not discover authority from environment-shaped input', () => {
    const previous = process.env.OMX_CODEX_HOST_CONSENSUS_RECEIPT;
    process.env.OMX_CODEX_HOST_CONSENSUS_RECEIPT = compactJws();
    try {
      assert.equal(getCodexHostConsensusVerifierReadiness().capability, 'unavailable');
    } finally {
      if (previous === undefined) delete process.env.OMX_CODEX_HOST_CONSENSUS_RECEIPT;
      else process.env.OMX_CODEX_HOST_CONSENSUS_RECEIPT = previous;
    }
  });
});

describe('Codex host consensus challenge and evidence', () => {
  it('pins the domain-separated raw-byte evidence mapping', () => {
    assert.equal(EVIDENCE_SHA256, '82e1778c8ea8734e297367c375b69b7a0cd3d1d3d99c5ac787246ce1a44a5c6b');
    assert.notEqual(
      computeCodexHostConsensusEvidenceSha256({ requirements: Buffer.concat([REQUIREMENTS, Buffer.from([0])]), plan: PLAN }),
      EVIDENCE_SHA256,
    );
    assert.notEqual(
      computeCodexHostConsensusEvidenceSha256({ requirements: REQUIREMENTS, plan: Buffer.concat([PLAN, Buffer.from([0])]) }),
      EVIDENCE_SHA256,
    );
    assert.notEqual(
      computeCodexHostConsensusEvidenceSha256({ requirements: PLAN, plan: REQUIREMENTS }),
      EVIDENCE_SHA256,
    );
  });

  it('generates a typed 256-bit nonce when one is not explicitly supplied', () => {
    const generated = createCodexHostConsensusChallenge({
      rootSessionId: '11111111-1111-4111-8111-111111111111',
      evidenceSha256: EVIDENCE_SHA256,
    });
    assert.equal(generated.protocolVersion, 1);
    assert.equal(typeof generated.protocolVersion, 'number');
    assert.match(generated.requestNonce, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Object.isFrozen(generated));
  });

  it('rejects a 43-character nonce with noncanonical base64url trailing bits', () => {
    const noncanonical = `${REQUEST_NONCE.slice(0, -1)}d`;
    assert.equal(Buffer.from(noncanonical, 'base64url').equals(Buffer.from(REQUEST_NONCE, 'base64url')), true);
    assert.notEqual(Buffer.from(noncanonical, 'base64url').toString('base64url'), noncanonical);
    assert.throws(() => createCodexHostConsensusChallenge({
      requestNonce: noncanonical,
      rootSessionId: '11111111-1111-4111-8111-111111111111',
      evidenceSha256: EVIDENCE_SHA256,
    }), /invalid Codex host consensus challenge/);
  });
});

describe('Codex host consensus compact JWS receipt', () => {
  it('keeps the Phase 1 failure vocabulary stable', () => {
    assert.deepEqual(CODEX_HOST_CONSENSUS_RECEIPT_FAILURE_REASONS, {
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
    });
  });

  it('verifies a deterministic compact JWS Ed25519 vector and consumes it once', async () => {
    const receipt = compactJws();
    assert.equal(
      receipt,
      'eyJ0eXAiOiJvbXgtcmFscGxhbi1jb25zZW5zdXMtcmVjZWlwdCtqd3MiLCJraWQiOiJjb2RleC1ob3N0LXRlc3Qta2V5LTEiLCJhbGciOiJFZERTQSJ9.eyJwcm90b2NvbFZlcnNpb24iOjEsInJlcXVlc3ROb25jZSI6IkJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2MiLCJhdWRpZW5jZSI6Im9oLW15LWNvZGV4LnJhbHBsYW4taGFuZG9mZi52MSIsInJvb3RTZXNzaW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJldmlkZW5jZVNoYTI1NiI6IjgyZTE3NzhjOGVhODczNGUyOTczNjdjMzc1YjY5YjdhMGNkM2QxZDNkOTljNWFjNzg3MjQ2Y2UxYTQ0YTVjNmIiLCJyZWNlaXB0SWQiOiJyZWNlaXB0LTAwMDEiLCJpc3N1ZXIiOiJvcGVuYWktY29kZXgtaG9zdCIsInNlcXVlbmNlIjpbImFyY2hpdGVjdC1yZXZpZXciLCJjcml0aWMtcmV2aWV3Il0sImFyY2hpdGVjdCI6eyJyb2xlIjoiYXJjaGl0ZWN0IiwidGhyZWFkSWQiOiJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJhcHByb3ZlZEF0IjoiMjAyNi0wOC0wNVQxMjowMDowMC4wMDBaIn0sImNyaXRpYyI6eyJyb2xlIjoiY3JpdGljIiwidGhyZWFkSWQiOiJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJhcHByb3ZlZEF0IjoiMjAyNi0wOC0wNVQxMjowMTowMC4wMDBaIn0sImlzc3VlZEF0IjoiMjAyNi0wOC0wNVQxMjowMjowMC4wMDBaIiwibm90QmVmb3JlIjoiMjAyNi0wOC0wNVQxMjowMjowMC4wMDBaIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0wNVQxMjowNzowMC4wMDBaIn0.ic0uU4QS_mtu-7YEgQcu2L4Foy6cWNnpq_B7-0ajNfcmkuamUtcOCQWm1diX1IpwoLIf7OTDuNQlrevtFHN6DQ',
    );

    const { result, consumeCalls, receivedChallenges } = await verify(receipt);
    assert.equal(result.ok, true);
    assert.deepEqual(receivedChallenges, [BASE_CHALLENGE]);
    assert.equal(consumeCalls.length, 1);
    assert.deepEqual(consumeCalls[0]?.challenge, BASE_CHALLENGE);
    assert.equal(consumeCalls[0]?.receiptId, 'receipt-0001');
    assert.match(consumeCalls[0]?.signedTokenSha256 ?? '', /^[0-9a-f]{64}$/);
  });

  it('requires exact protected-header and payload canonical bytes', async () => {
    const reorderedHeader = Buffer.from(JSON.stringify({
      alg: CODEX_HOST_CONSENSUS_JWS_ALGORITHM,
      kid: KEY_ID,
      typ: CODEX_HOST_CONSENSUS_JWS_TYPE,
    }), 'utf8');
    assert.deepEqual((await verify(compactJws(BASE_CLAIMS, reorderedHeader))).result, {
      ok: false,
      reason: 'malformed_host_consensus_receipt',
    });

    const reorderedPayload = Buffer.from(JSON.stringify(Object.fromEntries([
      ['issuer', BASE_CLAIMS.issuer],
      ...Object.entries(BASE_CLAIMS).filter(([key]) => key !== 'issuer'),
    ])), 'utf8');
    assert.deepEqual((await verify(compactJws(BASE_CLAIMS, undefined, reorderedPayload))).result, {
      ok: false,
      reason: 'malformed_host_consensus_receipt',
    });
  });

  it('rejects cryptographic substitution before online consume', async () => {
    const receipt = compactJws();
    const [header, payload, signature] = receipt.split('.') as [string, string, string];
    const invalid = `${header}.${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const { result, consumeCalls } = await verify(invalid);
    assert.deepEqual(result, { ok: false, reason: 'invalid_host_consensus_receipt_signature' });
    assert.equal(consumeCalls.length, 0);
  });

  it('rejects nonce, root-session, and evidence preplay/substitution', async () => {
    const substitutions: CodexHostConsensusChallenge[] = [
      { ...BASE_CHALLENGE, requestNonce: Buffer.alloc(32, 8).toString('base64url') },
      { ...BASE_CHALLENGE, rootSessionId: '22222222-2222-4222-8222-222222222222' },
      { ...BASE_CHALLENGE, evidenceSha256: 'c'.repeat(64) },
    ];
    for (const challenge of substitutions) {
      const rejected = await verify(compactJws({ ...BASE_CLAIMS, ...challenge }));
      assert.deepEqual(rejected.result, { ok: false, reason: 'host_consensus_receipt_claim_mismatch' });
      assert.equal(rejected.consumeCalls.length, 0);
    }
  });

  it('binds exact threads, roles, strict order, and validity window', async () => {
    assert.deepEqual((await verify(compactJws(), {
      architectThreadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })).result, {
      ok: false,
      reason: 'host_consensus_receipt_claim_mismatch',
    });
    assert.deepEqual((await verify(compactJws({
      ...BASE_CLAIMS,
      critic: { ...BASE_CLAIMS.critic, threadId: BASE_CLAIMS.architect.threadId },
    }))).result, { ok: false, reason: 'host_consensus_receipt_claim_mismatch' });
    const wrongRole = {
      ...BASE_CLAIMS,
      architect: { ...BASE_CLAIMS.architect, role: 'critic' },
    } as unknown as CodexHostConsensusReceiptClaims;
    assert.deepEqual((await verify(compactJws(wrongRole))).result, {
      ok: false,
      reason: 'malformed_host_consensus_receipt',
    });
    assert.deepEqual((await verify(compactJws({
      ...BASE_CLAIMS,
      architect: { ...BASE_CLAIMS.architect, approvedAt: '2026-08-05T12:01:30.000Z' },
    }))).result, { ok: false, reason: 'host_consensus_receipt_claim_mismatch' });
    assert.deepEqual((await verify(compactJws(), { nowMs: Date.parse('2026-08-05T12:01:30.000Z') })).result, {
      ok: false,
      reason: 'host_consensus_receipt_not_yet_valid',
    });
    assert.deepEqual((await verify(compactJws(), { nowMs: Date.parse('2026-08-05T12:08:00.000Z') })).result, {
      ok: false,
      reason: 'host_consensus_receipt_expired',
    });
  });

  it('fails closed when atomic online consume reports replay or rejection', async () => {
    assert.deepEqual((await verify(compactJws(), { consumeResult: 'already_consumed' })).result, {
      ok: false,
      reason: 'host_consensus_receipt_replayed',
    });
    assert.deepEqual((await verify(compactJws(), { consumeResult: 'rejected' })).result, {
      ok: false,
      reason: 'host_consensus_receipt_consume_rejected',
    });
  });
});
