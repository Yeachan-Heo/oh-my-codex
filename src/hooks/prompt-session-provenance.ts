import { normalizeSessionId, type SessionPointerReadResult, type SessionState } from './session.js';

export type PromptProducer = 'native' | 'notify';
export type PromptProvenanceRejectReason =
  | 'payload_session_invalid'
  | 'owner_env_invalid'
  | 'payload_session_absent'
  | 'selected_pointer_unusable'
  | 'owner_env_unbound'
  | 'notify_fork_missing'
  | 'foreign_child'
  | 'ambiguous_child';
export type PromptOwnershipRejectReason =
  | 'owner_conflict'
  | 'target_owner_mismatch'
  | 'target_owner_disagreement'
  | 'legacy_adoption_denied';

export type PromptThreadClassification =
  | { readonly kind: 'root-or-drift' }
  | { readonly kind: 'target-child'; readonly rootOwnerSessionId: string; readonly proof: 'spawn' | 'transcript' | 'tracker' }
  | { readonly kind: 'foreign-child'; readonly rootOwnerSessionId: string; readonly proof: 'spawn' | 'transcript' | 'tracker' }
  | { readonly kind: 'ambiguous-child'; readonly rootOwnerSessionIds: readonly string[] }
  | { readonly kind: 'unknown' };

export interface PromptMutationAuthorization {
  readonly targetSessionId: string;
  readonly ownerCodexSessionId: string;
  readonly allowedOwnerCodexSessionIds: readonly string[];
  readonly allowedStorageSessionIds: readonly string[];
  readonly targetRelation: 'explicit-independent' | 'pointer-alias' | 'pointer-fallback' | 'notify-explicit-existing-fork';
  readonly thread: PromptThreadClassification;
  readonly legacyAdoption: 'allow' | 'deny';
  readonly globalSideEffects: 'allow' | 'suppress';
}

export interface PromptDiagnosticDescriptor {
  readonly reason: PromptProvenanceRejectReason | PromptOwnershipRejectReason;
  readonly producer: PromptProducer;
  readonly selectedRootStatus: string;
  readonly relation?: PromptMutationAuthorization['targetRelation'];
  readonly timestamp: string;
}

export type ResolvedPromptTurnContext =
  | Readonly<{ status: 'authorized'; authorization: PromptMutationAuthorization; ownership: Readonly<{ status: 'compatible' | 'adoptable'; normalizedOwnerCodexSessionId: string }> }>
  | Readonly<{ status: 'suppressed-target-child'; authorization: PromptMutationAuthorization }>
  | Readonly<{ status: 'rejected'; reason: PromptProvenanceRejectReason | PromptOwnershipRejectReason; diagnostic: PromptDiagnosticDescriptor }>;

export interface PromptThreadFacts {
  readonly spawnRootOwnerSessionId?: unknown;
  readonly transcriptRootOwnerSessionId?: unknown;
  readonly trackerRootOwnerSessionIds?: readonly unknown[];
  /** A current-target anchor takes precedence over stale tracker evidence. */
  readonly currentTargetAnchored?: boolean;
  /** Factual raw-thread relation when no trusted child proof exists. */
  readonly rootOrDrift?: boolean;
}

export interface EvaluateResolvedPromptTurnInput {
  readonly producer: PromptProducer;
  /** Raw payload P; presence is validated even when malformed. */
  readonly payloadSessionId?: unknown;
  /** Raw E; presence is validated even when malformed. */
  readonly ownerEnvSessionId?: unknown;
  readonly selectedPointer: Pick<SessionPointerReadResult, 'status' | 'state'>;
  /** Neutral, validated `sessions/E` stat fact supplied only by notify. */
  readonly forkScopeExists?: boolean;
  readonly threadFacts?: PromptThreadFacts;
  readonly nowIso?: string;
}

export interface SelectedTargetOwnerEvidence {
  readonly ownerCodexSessionId?: unknown;
  readonly targetSessionId?: unknown;
}

export function extractSelectedTargetOwnerEvidence(value: unknown): readonly SelectedTargetOwnerEvidence[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze([{ ownerCodexSessionId: {} }]);
  }
  const record = value as Record<string, unknown>;
  const evidence: SelectedTargetOwnerEvidence[] = [{
    ownerCodexSessionId: record.owner_codex_session_id,
    targetSessionId: record.session_id,
  }];
  if (record.active_skills !== undefined) {
    if (!Array.isArray(record.active_skills)) {
      evidence.push({ ownerCodexSessionId: record.active_skills });
    } else {
      for (const entry of record.active_skills) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          evidence.push({ ownerCodexSessionId: entry ?? {} });
          continue;
        }
        const activeEntry = entry as Record<string, unknown>;
        evidence.push({
          ownerCodexSessionId: activeEntry.owner_codex_session_id,
          targetSessionId: activeEntry.session_id ?? record.session_id,
        });
      }
    }
  }
  return Object.freeze(evidence);
}

function orderedUnique(values: Array<string | undefined>): readonly string[] {
  return Object.freeze([...new Set(values.filter((value): value is string => Boolean(value)))]);
}

function hasRawValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function selectedAliases(state: SessionState | undefined): readonly string[] {
  if (!state) return Object.freeze([]);
  return orderedUnique([
    normalizeSessionId(state.session_id),
    normalizeSessionId(state.native_session_id),
    normalizeSessionId(state.previous_native_session_id),
    normalizeSessionId(state.owner_omx_session_id),
    normalizeSessionId(state.owner_codex_session_id),
  ]);
}

function fallbackOwner(state: SessionState, canonical: string): string {
  return normalizeSessionId(state.owner_codex_session_id)
    ?? normalizeSessionId(state.codex_session_id)
    ?? normalizeSessionId(state.native_session_id)
    ?? normalizeSessionId(state.previous_native_session_id)
    ?? normalizeSessionId(state.owner_omx_session_id)
    ?? canonical;
}

function diagnostic(
  reason: PromptProvenanceRejectReason | PromptOwnershipRejectReason,
  producer: PromptProducer,
  selectedRootStatus: string,
  relation?: PromptMutationAuthorization['targetRelation'],
  nowIso = '',
): ResolvedPromptTurnContext {
  return Object.freeze({
    status: 'rejected' as const,
    reason,
    diagnostic: Object.freeze({ reason, producer, selectedRootStatus, ...(relation ? { relation } : {}), timestamp: nowIso }),
  });
}

export function classifyPromptThread(facts: PromptThreadFacts | undefined, ownerIds: readonly string[]): PromptThreadClassification {
  const proofValues: Array<[string | undefined, 'spawn' | 'transcript' | 'tracker']> = [
    [normalizeSessionId(facts?.spawnRootOwnerSessionId), 'spawn'],
    [normalizeSessionId(facts?.transcriptRootOwnerSessionId), 'transcript'],
  ];
  for (const root of facts?.trackerRootOwnerSessionIds ?? []) proofValues.push([normalizeSessionId(root), 'tracker']);
  const roots = orderedUnique(proofValues.map(([root]) => root));
  if (roots.length === 0) return Object.freeze(facts?.rootOrDrift ? { kind: 'root-or-drift' } : { kind: 'unknown' });
  if (facts?.currentTargetAnchored) {
    return Object.freeze({ kind: 'root-or-drift' });
  }
  if (roots.length > 1) return Object.freeze({ kind: 'ambiguous-child', rootOwnerSessionIds: roots });
  const [root] = roots;
  const proof = proofValues.find(([candidate]) => candidate === root)?.[1] ?? 'tracker';
  return ownerIds.includes(root)
    ? Object.freeze({ kind: 'target-child', rootOwnerSessionId: root, proof })
    : Object.freeze({ kind: 'foreign-child', rootOwnerSessionId: root, proof });
}

function authorization(
  targetSessionId: string,
  ownerCodexSessionId: string,
  allowedOwnerCodexSessionIds: readonly string[],
  allowedStorageSessionIds: readonly string[],
  targetRelation: PromptMutationAuthorization['targetRelation'],
  globalSideEffects: 'allow' | 'suppress',
  legacyAdoption: 'allow' | 'deny',
  threadFacts?: PromptThreadFacts,
): PromptMutationAuthorization {
  const owners = orderedUnique([...allowedOwnerCodexSessionIds, ownerCodexSessionId]);
  return Object.freeze({
    targetSessionId,
    ownerCodexSessionId,
    allowedOwnerCodexSessionIds: owners,
    allowedStorageSessionIds: orderedUnique([...allowedStorageSessionIds, targetSessionId]),
    targetRelation,
    thread: classifyPromptThread(threadFacts, owners),
    legacyAdoption,
    globalSideEffects,
  });
}

function finishAuthorization(
  input: EvaluateResolvedPromptTurnInput,
  value: PromptMutationAuthorization,
): ResolvedPromptTurnContext {
  if (value.thread.kind === 'target-child') return Object.freeze({ status: 'suppressed-target-child', authorization: value });
  if (value.thread.kind === 'foreign-child') return diagnostic('foreign_child', input.producer, input.selectedPointer.status, value.targetRelation, input.nowIso);
  if (value.thread.kind === 'ambiguous-child') return diagnostic('ambiguous_child', input.producer, input.selectedPointer.status, value.targetRelation, input.nowIso);
  return Object.freeze({
    status: 'authorized',
    authorization: value,
    ownership: Object.freeze({ status: value.legacyAdoption === 'allow' ? 'adoptable' : 'compatible', normalizedOwnerCodexSessionId: value.ownerCodexSessionId }),
  });
}

/**
 * The sole provenance policy evaluator. It is pure: callers supply selected-root
 * facts and may call this once before any ownership-sensitive read or effect.
 */
export function evaluateResolvedPromptTurn(input: EvaluateResolvedPromptTurnInput): ResolvedPromptTurnContext {
  const nowIso = input.nowIso;
  const payloadPresent = hasRawValue(input.payloadSessionId);
  const envPresent = hasRawValue(input.ownerEnvSessionId);
  const payload = normalizeSessionId(input.payloadSessionId);
  const ownerEnv = normalizeSessionId(input.ownerEnvSessionId);
  if (payloadPresent && !payload) return diagnostic('payload_session_invalid', input.producer, input.selectedPointer.status, undefined, nowIso);
  if (envPresent && !ownerEnv) return diagnostic('owner_env_invalid', input.producer, input.selectedPointer.status, undefined, nowIso);

  const state = input.selectedPointer.status === 'usable' ? input.selectedPointer.state : undefined;
  const canonical = normalizeSessionId(state?.session_id);
  const aliases = selectedAliases(state);

  if (payload) {
    if (aliases.includes(payload) && canonical) {
      if (ownerEnv && ownerEnv !== payload && !aliases.includes(ownerEnv)) {
        if (input.producer !== 'notify') return diagnostic('owner_env_unbound', input.producer, input.selectedPointer.status, 'pointer-alias', nowIso);
        if (!input.forkScopeExists) return diagnostic('notify_fork_missing', input.producer, input.selectedPointer.status, 'pointer-alias', nowIso);
        return finishAuthorization(input, authorization(ownerEnv, payload, [payload, ...aliases], [ownerEnv], 'notify-explicit-existing-fork', 'suppress', 'deny', input.threadFacts));
      }
      return finishAuthorization(input, authorization(canonical, payload, [payload, ...aliases], [canonical, ...aliases], 'pointer-alias', 'allow', 'deny', input.threadFacts));
    }
    if (!ownerEnv || ownerEnv === payload) {
      const globalSideEffects = input.selectedPointer.status === 'absent' ? 'allow' : 'suppress';
      return finishAuthorization(input, authorization(payload, payload, [payload], [payload], 'explicit-independent', globalSideEffects, 'allow', input.threadFacts));
    }
    return diagnostic('owner_env_unbound', input.producer, input.selectedPointer.status, undefined, nowIso);
  }

  if (!state || !canonical) return diagnostic(input.selectedPointer.status === 'absent' ? 'payload_session_absent' : 'selected_pointer_unusable', input.producer, input.selectedPointer.status, undefined, nowIso);
  if (ownerEnv && !aliases.includes(ownerEnv)) return diagnostic('owner_env_unbound', input.producer, input.selectedPointer.status, 'pointer-fallback', nowIso);
  const owner = fallbackOwner(state, canonical);
  return finishAuthorization(input, authorization(canonical, owner, [owner, ...aliases], [canonical, ...aliases], 'pointer-fallback', 'allow', 'allow', input.threadFacts));
}

/** Read-only selected-target owner preflight; no path discovery or mutation. */
export function preflightSelectedTargetOwner(
  context: ResolvedPromptTurnContext,
  evidence: readonly SelectedTargetOwnerEvidence[],
  producer: PromptProducer = 'native',
  nowIso = '',
): ResolvedPromptTurnContext {
  if (context.status !== 'authorized') return context;
  const { authorization } = context;
  const observedOwners = new Set<string>();
  let adoptable = context.ownership.status === 'adoptable';
  for (const item of evidence) {
    const target = hasRawValue(item.targetSessionId) ? normalizeSessionId(item.targetSessionId) : undefined;
    const owner = hasRawValue(item.ownerCodexSessionId) ? normalizeSessionId(item.ownerCodexSessionId) : undefined;
    if (hasRawValue(item.targetSessionId) && !target) return diagnostic('target_owner_mismatch', producer, 'preflight', authorization.targetRelation, nowIso);
    if (target && target !== authorization.targetSessionId) return diagnostic('target_owner_mismatch', producer, 'preflight', authorization.targetRelation, nowIso);
    if (hasRawValue(item.ownerCodexSessionId) && !owner) return diagnostic('owner_conflict', producer, 'preflight', authorization.targetRelation, nowIso);
    if (owner && !authorization.allowedOwnerCodexSessionIds.includes(owner)) return diagnostic('owner_conflict', producer, 'preflight', authorization.targetRelation, nowIso);
    if (owner) observedOwners.add(owner);
    if (observedOwners.size > 1) return diagnostic('target_owner_disagreement', producer, 'preflight', authorization.targetRelation, nowIso);
    if (!owner && target === authorization.targetSessionId && authorization.legacyAdoption === 'deny') return diagnostic('legacy_adoption_denied', producer, 'preflight', authorization.targetRelation, nowIso);
    if (!owner && target === authorization.targetSessionId) adoptable = true;
  }
  return Object.freeze({ ...context, ownership: Object.freeze({ ...context.ownership, status: adoptable ? 'adoptable' : 'compatible' }) });
}
