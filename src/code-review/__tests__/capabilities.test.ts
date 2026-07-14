import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AcceptedEquivalent,
  AcceptedEquivalentRequest,
  EvidenceStatus,
  ReviewRecommendation,
  ScopeFile,
} from '../contract.js';

type Capability = 'LSP' | 'AST' | 'COMPILER' | 'LINT' | 'RG_FALLBACK';
type FileKind =
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

interface CapabilityPlanEntry {
  capability: Capability;
  applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
  file_kinds: FileKind[];
  fallback_for: Array<'LSP' | 'AST'>;
}

interface CapabilityPlan {
  file_kinds: Array<{ path: string; kind: FileKind }>;
  capabilities: CapabilityPlanEntry[];
  inherently_degraded: boolean;
}

interface CapabilityObservation {
  capability: Capability;
  execution: 'NATIVE' | 'ACCEPTED_EQUIVALENT' | 'FALLBACK' | 'UNAVAILABLE' | 'SKIPPED';
  outcome: 'PASS' | 'FAIL' | 'TIMED_OUT' | 'MALFORMED' | 'NOT_RUN';
  empty_result?: boolean;
}

interface CapabilityEvaluation {
  evidence_status: EvidenceStatus;
  maximum_recommendation: ReviewRecommendation;
  reasons: string[];
}

interface HookApprovalLedgerEntry {
  approval: Record<string, unknown>;
  provenance: {
    owner: 'CODEX_NATIVE_HOOK';
    event_ref: string;
    nonce: string;
  };
}

interface PreparedConsumption {
  schema_version: 1;
  state: 'PREPARED';
  nonce: string;
  review_id: string;
  capability: 'LSP' | 'AST';
  source_ref: string;
  prepared_at: string;
}

interface CommittedConsumption extends Omit<PreparedConsumption, 'state'> {
  state: 'COMMITTED';
  committed_at: string;
}

interface TrustedResolution {
  accepted_equivalents: AcceptedEquivalent[];
  reasons: string[];
  prepared_consumptions: PreparedConsumption[];
}

interface CapabilitiesApi {
  classifyReviewFile(file: ScopeFile): FileKind;
  buildCapabilityPlan(files: readonly ScopeFile[], options?: { rustAstSupported?: boolean }): CapabilityPlan;
  evaluateCapabilityEvidence(
    plan: CapabilityPlan,
    observations: readonly CapabilityObservation[],
  ): CapabilityEvaluation;
  parseAcceptedEquivalentRequests(value: unknown): AcceptedEquivalentRequest[];
  resolveTrustedEquivalents(options: {
    requests: unknown;
    context: {
      workingDirectory: string;
      session_id: string;
      root_thread_id: string;
      turn_id: string;
      review_id: string;
      base_sha?: string;
    };
    explicitApprovalLedger?: readonly unknown[];
    existingConsumptions?: readonly unknown[];
    readBaseContract?: (workingDirectory: string, args: readonly string[]) => Promise<string>;
    now?: Date;
    approvalTtlMs?: number;
  }): Promise<TrustedResolution>;
  prepareEquivalentConsumption(
    input: Omit<PreparedConsumption, 'schema_version' | 'state' | 'prepared_at'>,
    existing?: unknown,
    now?: Date,
  ): PreparedConsumption | CommittedConsumption;
  commitEquivalentConsumption(
    prepared: PreparedConsumption,
    existing?: unknown,
    now?: Date,
  ): CommittedConsumption;
  recoverEquivalentConsumption(
    prepared: PreparedConsumption,
    existing: unknown,
  ): PreparedConsumption | CommittedConsumption;
}

async function loadCapabilitiesApi(): Promise<CapabilitiesApi> {
  const modulePath: string = '../capabilities.js';
  const loaded = (await import(modulePath).catch(() => null)) as Partial<CapabilitiesApi> | null;
  assert.equal(
    typeof loaded?.buildCapabilityPlan,
    'function',
    'expected deterministic capability planning to be implemented',
  );
  assert.equal(typeof loaded?.evaluateCapabilityEvidence, 'function');
  assert.equal(typeof loaded?.resolveTrustedEquivalents, 'function');
  return loaded as CapabilitiesApi;
}

function file(path: string, overrides: Partial<ScopeFile> = {}): ScopeFile {
  return {
    path,
    change: 'MODIFIED',
    sources: ['WORKTREE'],
    binary: false,
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

function applicable(plan: CapabilityPlan): Capability[] {
  return plan.capabilities
    .filter((entry) => entry.applicability === 'APPLICABLE')
    .map((entry) => entry.capability);
}

function passingObservations(plan: CapabilityPlan): CapabilityObservation[] {
  return applicable(plan).map((capability) => ({
    capability,
    execution: 'NATIVE',
    outcome: 'PASS',
  }));
}

const NOW = new Date('2026-07-15T01:00:00.000Z');
const REVIEW_ID = '11111111-1111-4111-8111-111111111111';

function explicitApproval(overrides: Record<string, unknown> = {}): HookApprovalLedgerEntry {
  const nonce = 'hook-nonce-1';
  return {
    approval: {
      schema_version: 1,
      session_id: 'session-1',
      root_thread_id: 'root-thread-1',
      turn_id: 'turn-1',
      capability: 'LSP',
      source_ref: 'approval:event-1',
      program: 'npm',
      args: ['run', 'typecheck'],
      approved_at: '2026-07-15T00:59:00.000Z',
      nonce,
      ...overrides,
    },
    provenance: {
      owner: 'CODEX_NATIVE_HOOK',
      event_ref: 'events/user-approval-1.json',
      nonce: typeof overrides.nonce === 'string' ? overrides.nonce : nonce,
    },
  };
}

function explicitContext() {
  return {
    workingDirectory: '/repo',
    session_id: 'session-1',
    root_thread_id: 'root-thread-1',
    turn_id: 'turn-1',
    review_id: REVIEW_ID,
  };
}

describe('file-kind capability planning', () => {
  it('classifies every documented file kind before selecting requirements', async () => {
    const api = await loadCapabilitiesApi();
    const cases: Array<[ScopeFile, FileKind]> = [
      [file('src/a.ts'), 'TYPESCRIPT_JAVASCRIPT'],
      [file('src/a.jsx'), 'TYPESCRIPT_JAVASCRIPT'],
      [file('src/lib.rs'), 'RUST'],
      [file('scripts/run.zsh'), 'SHELL'],
      [file('config/app.yaml'), 'STRUCTURED_DATA'],
      [file('Cargo.toml'), 'STRUCTURED_DATA'],
      [file('README.mdx'), 'DOCUMENTATION'],
      [file('public/logo.svg'), 'ASSET'],
      [file('mystery.custom'), 'UNKNOWN_TEXT'],
      [file('mystery.custom', { binary: true }), 'UNKNOWN_BINARY'],
      [file('link', { change: 'SYMLINK' }), 'SYMLINK'],
      [file('vendor', { change: 'SUBMODULE' }), 'GITLINK'],
    ];
    assert.deepEqual(cases.map(([value]) => api.classifyReviewFile(value)), cases.map(([, kind]) => kind));
  });

  it('builds the complete TypeScript/JavaScript native and fallback union', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts'), file('src/b.js')]);
    assert.deepEqual(applicable(plan), ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK']);
    assert.deepEqual(
      plan.capabilities.filter((entry) => entry.fallback_for.length > 0).map((entry) => [entry.capability, entry.fallback_for]),
      [
        ['COMPILER', ['LSP', 'AST']],
        ['LINT', ['LSP', 'AST']],
        ['RG_FALLBACK', ['LSP', 'AST']],
      ],
    );
    assert.equal(plan.inherently_degraded, false);
  });

  it('makes Rust AST conditional while retaining LSP and cargo/lint fallback evidence', async () => {
    const api = await loadCapabilitiesApi();
    assert.deepEqual(applicable(api.buildCapabilityPlan([file('src/lib.rs')])), ['LSP', 'LINT', 'RG_FALLBACK']);
    assert.deepEqual(
      applicable(api.buildCapabilityPlan([file('src/lib.rs')], { rustAstSupported: true })),
      ['LSP', 'AST', 'LINT', 'RG_FALLBACK'],
    );
  });

  it('applies shell, structured-data, docs, assets, links, and unknown-kind rules exactly', async () => {
    const api = await loadCapabilitiesApi();
    const cases: Array<[ScopeFile, Capability[], boolean]> = [
      [file('run.sh'), ['LINT', 'RG_FALLBACK'], false],
      [file('config.json'), ['COMPILER', 'LINT'], false],
      [file('README.md'), [], false],
      [file('logo.png', { binary: true }), [], false],
      [file('link', { change: 'SYMLINK' }), [], false],
      [file('vendor', { change: 'SUBMODULE' }), [], false],
      [file('unknown.custom'), ['RG_FALLBACK'], true],
      [file('unknown.custom', { binary: true }), [], false],
    ];
    for (const [value, expected, degraded] of cases) {
      const plan = api.buildCapabilityPlan([value]);
      assert.deepEqual(applicable(plan), expected, value.path);
      assert.equal(plan.inherently_degraded, degraded, value.path);
      for (const capability of ['LSP', 'AST'] as const) {
        if (!expected.includes(capability)) {
          assert.equal(
            plan.capabilities.find((entry) => entry.capability === capability)?.applicability,
            'NOT_APPLICABLE',
          );
        }
      }
    }
  });

  it('uses a stable union for mixed scopes without duplicate requirements', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([
      file('README.md'),
      file('src/lib.rs'),
      file('src/a.ts'),
      file('run.sh'),
      file('unknown.custom'),
    ], { rustAstSupported: true });
    assert.deepEqual(applicable(plan), ['LSP', 'AST', 'COMPILER', 'LINT', 'RG_FALLBACK']);
    assert.equal(new Set(plan.capabilities.map((entry) => entry.capability)).size, 5);
    assert.equal(plan.inherently_degraded, true);
  });
});

describe('capability evidence degradation', () => {
  it('allows full evidence and approval only when every applicable requirement succeeds', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts')]);
    assert.deepEqual(api.evaluateCapabilityEvidence(plan, passingObservations(plan)), {
      evidence_status: 'FULL_EVIDENCE',
      maximum_recommendation: 'APPROVE',
      reasons: [],
    });
  });

  it('caps successful LSP/AST fallback at COMMENT', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts')]);
    const observations = passingObservations(plan).map((observation) =>
      observation.capability === 'LSP' || observation.capability === 'AST'
        ? { ...observation, execution: 'UNAVAILABLE' as const, outcome: 'NOT_RUN' as const }
        : { ...observation, execution: 'FALLBACK' as const },
    );
    const result = api.evaluateCapabilityEvidence(plan, observations);
    assert.equal(result.evidence_status, 'DEGRADED_EVIDENCE');
    assert.equal(result.maximum_recommendation, 'COMMENT');
    assert.match(result.reasons.join('\n'), /LSP|AST/u);
  });

  it('requires REQUEST CHANGES for failed, timed-out, malformed, or incomplete fallback evidence', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts')]);
    for (const outcome of ['FAIL', 'TIMED_OUT', 'MALFORMED'] as const) {
      const observations = passingObservations(plan).map((observation) =>
        observation.capability === 'LSP'
          ? { ...observation, execution: 'UNAVAILABLE' as const, outcome: 'NOT_RUN' as const }
          : observation.capability === 'COMPILER'
            ? { ...observation, execution: 'FALLBACK' as const, outcome }
            : observation,
      );
      assert.equal(
        api.evaluateCapabilityEvidence(plan, observations).maximum_recommendation,
        'REQUEST CHANGES',
        outcome,
      );
    }

    const missingFallback = passingObservations(plan)
      .filter((observation) => observation.capability !== 'RG_FALLBACK')
      .map((observation) => observation.capability === 'AST'
        ? { ...observation, execution: 'UNAVAILABLE' as const, outcome: 'NOT_RUN' as const }
        : observation);
    assert.equal(
      api.evaluateCapabilityEvidence(plan, missingFallback).maximum_recommendation,
      'REQUEST CHANGES',
    );
  });

  it('does not treat unavailable AST with an empty result as successful evidence', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts')]);
    const observations = passingObservations(plan).map((observation) => observation.capability === 'AST'
      ? { ...observation, execution: 'UNAVAILABLE' as const, outcome: 'PASS' as const, empty_result: true }
      : { ...observation, execution: observation.capability === 'LSP' ? observation.execution : 'FALLBACK' as const });
    const result = api.evaluateCapabilityEvidence(plan, observations);
    assert.equal(result.evidence_status, 'DEGRADED_EVIDENCE');
    assert.equal(result.maximum_recommendation, 'COMMENT');
  });

  it('accepts a successful trusted equivalent as full evidence', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts')]);
    const observations = passingObservations(plan).map((observation) => observation.capability === 'LSP'
      ? { ...observation, execution: 'ACCEPTED_EQUIVALENT' as const }
      : observation);
    assert.equal(api.evaluateCapabilityEvidence(plan, observations).evidence_status, 'FULL_EVIDENCE');
  });

  it('never improves evidence or recommendation when a capability observation is removed', async () => {
    const api = await loadCapabilitiesApi();
    const plan = api.buildCapabilityPlan([file('src/a.ts'), file('unknown.custom')]);
    const complete = passingObservations(plan);
    const recommendationSeverity: Record<ReviewRecommendation, number> = {
      APPROVE: 0,
      COMMENT: 1,
      'REQUEST CHANGES': 2,
    };
    const evidenceSeverity: Record<EvidenceStatus, number> = {
      FULL_EVIDENCE: 0,
      DEGRADED_EVIDENCE: 1,
    };
    const baseline = api.evaluateCapabilityEvidence(plan, complete);
    for (let index = 0; index < complete.length; index += 1) {
      const reduced = api.evaluateCapabilityEvidence(plan, complete.filter((_, candidate) => candidate !== index));
      assert.ok(evidenceSeverity[reduced.evidence_status] >= evidenceSeverity[baseline.evidence_status]);
      assert.ok(
        recommendationSeverity[reduced.maximum_recommendation]
          >= recommendationSeverity[baseline.maximum_recommendation],
      );
    }
  });
});

describe('trusted diagnostic equivalents', () => {
  it('accepts only identifier requests and rejects caller commands, args, source, and unknown fields', async () => {
    const api = await loadCapabilitiesApi();
    assert.deepEqual(api.parseAcceptedEquivalentRequests([
      { capability: 'LSP', source_ref: 'approval:event-1' },
      { capability: 'AST', source_ref: 'base#ast' },
    ]), [
      { capability: 'LSP', source_ref: 'approval:event-1' },
      { capability: 'AST', source_ref: 'base#ast' },
    ]);
    for (const value of [
      [{ capability: 'LSP', source_ref: 'approval:event-1', program: 'npm' }],
      [{ capability: 'LSP', source_ref: 'approval:event-1', args: ['run', 'lint'] }],
      [{ capability: 'LSP', source_ref: 'approval:event-1', source: 'EXPLICIT_USER' }],
      [{ capability: 'LSP', source_ref: 'approval:event-1', extra: true }],
      [{ capability: 'COMPILER', source_ref: 'approval:event-1' }],
    ]) {
      assert.throws(
        () => api.parseAcceptedEquivalentRequests(value),
        (error: unknown) => (error as { code?: unknown }).code === 'INVALID_EQUIVALENT_REQUEST',
      );
    }
  });

  it('resolves one unexpired exact current-context hook approval and prepares one-time nonce consumption', async () => {
    const api = await loadCapabilitiesApi();
    const result = await api.resolveTrustedEquivalents({
      requests: [{ capability: 'LSP', source_ref: 'approval:event-1' }],
      context: explicitContext(),
      explicitApprovalLedger: [explicitApproval()],
      now: NOW,
      approvalTtlMs: 5 * 60_000,
    });
    assert.deepEqual(result.accepted_equivalents, [{
      capability: 'LSP',
      source: 'EXPLICIT_USER',
      source_ref: 'approval:event-1',
      program: 'npm',
      args: ['run', 'typecheck'],
    }]);
    assert.equal(result.prepared_consumptions.length, 1);
    assert.equal(result.prepared_consumptions[0]?.nonce, 'hook-nonce-1');
    assert.equal(result.prepared_consumptions[0]?.review_id, REVIEW_ID);
    assert.deepEqual(result.reasons, []);
  });

  it('rejects missing, duplicate, expired, context-mismatched, unverifiable, malformed, and consumed approvals', async () => {
    const api = await loadCapabilitiesApi();
    const baseOptions = {
      requests: [{ capability: 'LSP', source_ref: 'approval:event-1' }],
      context: explicitContext(),
      now: NOW,
      approvalTtlMs: 5 * 60_000,
    };
    const consumed = api.commitEquivalentConsumption(
      api.prepareEquivalentConsumption({
        nonce: 'hook-nonce-1',
        review_id: '22222222-2222-4222-8222-222222222222',
        capability: 'LSP',
        source_ref: 'approval:event-1',
      }, undefined, NOW) as PreparedConsumption,
      undefined,
      NOW,
    );
    const cases: Array<[string, readonly unknown[], (readonly unknown[])?]> = [
      ['missing', [], []],
      ['duplicate', [explicitApproval(), explicitApproval()], []],
      ['expired', [explicitApproval({ approved_at: '2026-07-15T00:00:00.000Z' })], []],
      ['session mismatch', [explicitApproval({ session_id: 'other' })], []],
      ['root thread mismatch', [explicitApproval({ root_thread_id: 'other' })], []],
      ['turn mismatch', [explicitApproval({ turn_id: 'other' })], []],
      ['capability mismatch', [explicitApproval({ capability: 'AST' })], []],
      ['unverifiable owner', [{ ...explicitApproval(), provenance: { owner: 'MODEL', event_ref: 'e', nonce: 'hook-nonce-1' } }], []],
      ['nonce mismatch', [{ ...explicitApproval(), provenance: { owner: 'CODEX_NATIVE_HOOK', event_ref: 'e', nonce: 'other' } }], []],
      ['unknown approval field', [explicitApproval({ untrusted: true })], []],
      ['already consumed', [explicitApproval()], [consumed]],
    ];
    for (const [name, ledger, existingConsumptions = []] of cases) {
      const result = await api.resolveTrustedEquivalents({
        ...baseOptions,
        explicitApprovalLedger: ledger,
        existingConsumptions,
      });
      assert.deepEqual(result.accepted_equivalents, [], name);
      assert.equal(result.prepared_consumptions.length, 0, name);
      assert.ok(result.reasons.length > 0, name);
    }
  });

  it('makes approval consumption prepare/apply/recovery idempotent and rejects conflicting nonce reuse', async () => {
    const api = await loadCapabilitiesApi();
    const input = {
      nonce: 'nonce-1',
      review_id: REVIEW_ID,
      capability: 'AST' as const,
      source_ref: 'approval:ast-1',
    };
    const prepared = api.prepareEquivalentConsumption(input, undefined, NOW) as PreparedConsumption;
    assert.deepEqual(api.prepareEquivalentConsumption(input, prepared, NOW), prepared);
    const committed = api.commitEquivalentConsumption(prepared, undefined, NOW);
    assert.deepEqual(api.commitEquivalentConsumption(prepared, committed, NOW), committed);
    assert.deepEqual(api.recoverEquivalentConsumption(prepared, committed), committed);
    assert.throws(
      () => api.prepareEquivalentConsumption({ ...input, review_id: '33333333-3333-4333-8333-333333333333' }, committed, NOW),
      (error: unknown) => (error as { code?: unknown }).code === 'EQUIVALENT_CONSUMPTION_CONFLICT',
    );
    assert.throws(
      () => api.recoverEquivalentConsumption({ ...prepared, source_ref: 'different' }, committed),
      (error: unknown) => (error as { code?: unknown }).code === 'EQUIVALENT_CONSUMPTION_CONFLICT',
    );
  });

  it('binds one hook nonce to only one approval request in a resolution', async () => {
    const api = await loadCapabilitiesApi();
    const result = await api.resolveTrustedEquivalents({
      requests: [
        { capability: 'LSP', source_ref: 'approval:event-1' },
        { capability: 'AST', source_ref: 'approval:event-2' },
      ],
      context: explicitContext(),
      explicitApprovalLedger: [
        explicitApproval(),
        explicitApproval({
          capability: 'AST',
          source_ref: 'approval:event-2',
          program: 'npm',
          args: ['run', 'ast-check'],
          nonce: 'hook-nonce-1',
        }),
      ],
      now: NOW,
      approvalTtlMs: 5 * 60_000,
    });
    assert.deepEqual(result.accepted_equivalents.map((entry) => entry.capability), ['LSP']);
    assert.equal(result.prepared_consumptions.length, 1);
    assert.match(result.reasons.join('\n'), /NONCE/u);
  });

  it('reads repository equivalents only from the exact base object with strict schema and source_ref', async () => {
    const api = await loadCapabilitiesApi();
    const baseSha = 'a'.repeat(40);
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const result = await api.resolveTrustedEquivalents({
      requests: [{
        capability: 'AST',
        source_ref: `${baseSha}:code-review-equivalents.json#typescript-ast`,
      }],
      context: { ...explicitContext(), base_sha: baseSha },
      readBaseContract: async (cwd, args) => {
        calls.push({ cwd, args });
        return JSON.stringify({
          schema_version: 1,
          equivalents: [{
            capability: 'AST',
            program: 'npm',
            args: ['run', 'ast-check'],
            rule_id: 'typescript-ast',
          }],
        });
      },
      now: NOW,
    });
    assert.deepEqual(calls, [{
      cwd: '/repo',
      args: ['show', `${baseSha}:code-review-equivalents.json`],
    }]);
    assert.deepEqual(result.accepted_equivalents, [{
      capability: 'AST',
      program: 'npm',
      args: ['run', 'ast-check'],
      source: 'REPO_CONTRACT',
      source_ref: `${baseSha}:code-review-equivalents.json#typescript-ast`,
    }]);
    assert.deepEqual(result.prepared_consumptions, []);
  });

  it('cannot self-authorize from a worktree contract, an unresolved base, a mismatched rule, or malformed base data', async () => {
    const api = await loadCapabilitiesApi();
    const baseSha = 'b'.repeat(40);
    let reads = 0;
    const request = [{
      capability: 'LSP',
      source_ref: `${baseSha}:code-review-equivalents.json#typescript-lsp`,
    }];
    const noBase = await api.resolveTrustedEquivalents({
      requests: request,
      context: explicitContext(),
      readBaseContract: async () => {
        reads += 1;
        return '{}';
      },
      now: NOW,
    });
    assert.deepEqual(noBase.accepted_equivalents, []);
    assert.equal(reads, 0, 'must not read a worktree file without an authoritative base');

    for (const contract of [
      { schema_version: 1, equivalents: [{ capability: 'LSP', program: 'npm', args: ['run', 'check'], rule_id: 'other' }] },
      { schema_version: 1, equivalents: [{ capability: 'LSP', program: 'npm', args: ['run'], rule_id: 'typescript-lsp', extra: true }] },
      { schema_version: 1, equivalents: [{ capability: 'LSP', program: 'sh', args: ['-c', 'npm test'], rule_id: 'typescript-lsp' }] },
      { schema_version: 1, equivalents: [{ capability: 'LSP', program: 'npm && echo pwned', args: [], rule_id: 'typescript-lsp' }] },
      { schema_version: 1, equivalents: [
        { capability: 'LSP', program: 'npm', args: ['run', 'a'], rule_id: 'typescript-lsp' },
        { capability: 'LSP', program: 'npm', args: ['run', 'b'], rule_id: 'typescript-lsp' },
      ] },
      { schema_version: 1, equivalents: [], extra: true },
    ]) {
      const result = await api.resolveTrustedEquivalents({
        requests: request,
        context: { ...explicitContext(), base_sha: baseSha },
        readBaseContract: async () => JSON.stringify(contract),
        now: NOW,
      });
      assert.deepEqual(result.accepted_equivalents, [], JSON.stringify(contract));
      assert.ok(result.reasons.length > 0);
    }
  });
});
