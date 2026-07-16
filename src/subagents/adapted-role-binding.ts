import { canonicalizeOriginCwd, type RoleRoutingUnavailableMarker } from '../leader/contract.js';
import {
  bindPendingRoleIntentUnderLock,
  completeAdaptedRoleBinding,
  isCanonicalClaimantToken,
  isCanonicalCorrelationToken,
  isRoleIntentOwnedByCwd,
  listBoundAdaptedRoleIntents,
  OMX_ADAPTED_PROVENANCE,
  type SubagentTrackingState,
} from './tracker.js';
import { writeRoleRoutingMarker } from './role-routing-marker.js';

export const NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_TTL_MS = 60 * 60_000;

type AdaptedRoleBind = (
  state: SubagentTrackingState,
  intent: { role: string; provenanceKind: typeof OMX_ADAPTED_PROVENANCE },
) => SubagentTrackingState;

function normalizeNowMs(nowMs: number | undefined): number {
  return typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
}

function buildAdaptedRoleRoutingMarker(
  cwd: string,
  sessionId: string,
  parentThreadId: string,
  nowMs: number,
): RoleRoutingUnavailableMarker {
  return {
    schema_version: 1,
    cwd: canonicalizeOriginCwd(cwd) ?? cwd,
    session_id: sessionId,
    parent_thread_id: parentThreadId,
    observed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_TTL_MS).toISOString(),
    evidence: 'validated OMX adapted role intent correlated to an untyped native child',
  };
}

export function recoverAdaptedRoleBindings(cwd: string, stateDir: string, nowMs?: number): void {
  const normalizedNowMs = normalizeNowMs(nowMs);
  const canonicalOrigin = canonicalizeOriginCwd(cwd);
  if (canonicalOrigin === null) return;
  for (const intent of listBoundAdaptedRoleIntents(cwd, normalizedNowMs, true)) {
    // Fail-closed origin authentication: under a shared OMX_ROOT/OMX_STATE_ROOT/
    // OMX_TEAM_STATE_ROOT the tracker is shared across workspaces. Only recover, publish a
    // marker for, and complete an intent that belongs to THIS canonical origin workspace; a
    // foreign workspace's retained journal is left untouched.
    if (!isRoleIntentOwnedByCwd(cwd, intent)) continue;
    try {
      if (!isCanonicalCorrelationToken(intent.correlation_token)) continue;
      if (Object.hasOwn(intent, 'binding_claimant_token') && !isCanonicalClaimantToken(intent.binding_claimant_token)) continue;
      writeRoleRoutingMarker(
        stateDir,
        buildAdaptedRoleRoutingMarker(cwd, intent.session_id, intent.parent_thread_id, normalizedNowMs),
      );
      completeAdaptedRoleBinding(cwd, {
        sessionId: intent.session_id,
        parentThreadId: intent.parent_thread_id,
        correlationToken: intent.correlation_token,
        ...(Object.hasOwn(intent, 'binding_claimant_token') ? { claimantToken: intent.binding_claimant_token as string } : {}),
        nowMs: normalizedNowMs,
      });
    } catch {
      // A later hook invocation retries each retained binding independently.
    }
  }
}

export function bindAndPublishAdaptedRole(
  cwd: string,
  stateDir: string,
  input: { correlationSessionId: string; parentThreadId: string; correlationToken?: string; nowMs?: number },
  bind: AdaptedRoleBind,
): { role: string } | null {
  const nowMs = normalizeNowMs(input.nowMs);
  recoverAdaptedRoleBindings(cwd, stateDir, nowMs);
  const binding = bindPendingRoleIntentUnderLock(cwd, {
    sessionId: input.correlationSessionId,
    parentThreadId: input.parentThreadId,
    correlationToken: input.correlationToken,
    nowMs,
  }, bind);
  if (!binding) return null;

  if (binding.alreadyBound || binding.claimantToken === undefined) {
    recoverAdaptedRoleBindings(cwd, stateDir, nowMs);
    return { role: binding.role };
  }

  writeRoleRoutingMarker(
    stateDir,
    buildAdaptedRoleRoutingMarker(cwd, input.correlationSessionId, input.parentThreadId, nowMs),
  );
  completeAdaptedRoleBinding(cwd, {
    sessionId: input.correlationSessionId,
    parentThreadId: input.parentThreadId,
    correlationToken: input.correlationToken,
    claimantToken: binding.claimantToken,
    nowMs,
  });
  return { role: binding.role };
}
