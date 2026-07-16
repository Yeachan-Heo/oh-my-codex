import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalizeOriginCwd, type RoleRoutingUnavailableMarker } from '../leader/contract.js';
import { withCrossProcessFileLockSync } from './tracker.js';

export const NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE = 'native-subagent-role-routing.json';

const ROLE_ROUTING_MARKER_SCHEMA_VERSION = 1;
const ROLE_ROUTING_MARKER_LOCK_RETRY_MS = 10;
const ROLE_ROUTING_MARKER_LOCK_MAX_ATTEMPTS = 200;

type RoleRoutingMarkerStore = {
  schema_version: 1;
  markers: RoleRoutingUnavailableMarker[];
};

function markerStorePath(baseStateDir: string): string {
  return join(baseStateDir, NATIVE_SUBAGENT_ROLE_ROUTING_MARKER_FILE);
}

function readString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeMarker(value: unknown): RoleRoutingUnavailableMarker | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RoleRoutingUnavailableMarker>;
  const sessionId = readString(candidate.session_id);
  const observedAt = readString(candidate.observed_at);
  const expiresAt = readString(candidate.expires_at);
  if (!sessionId || !observedAt || !expiresAt) return null;
  if (!Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(expiresAt))) return null;

  const cwd = readString(candidate.cwd);
  const parentThreadId = readString(candidate.parent_thread_id);
  const evidence = readString(candidate.evidence);
  return {
    schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION,
    ...(cwd ? { cwd } : {}),
    session_id: sessionId,
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    observed_at: observedAt,
    expires_at: expiresAt,
    ...(evidence ? { evidence } : {}),
  };
}

function readMarkerStore(baseStateDir: string): RoleRoutingMarkerStore {
  const path = markerStorePath(baseStateDir);
  if (!existsSync(path)) return { schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION, markers: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<RoleRoutingMarkerStore>;
    if (parsed.schema_version !== ROLE_ROUTING_MARKER_SCHEMA_VERSION || !Array.isArray(parsed.markers)) {
      return { schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION, markers: [] };
    }
    return {
      schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION,
      markers: parsed.markers
        .map((marker) => normalizeMarker(marker))
        .filter((marker): marker is RoleRoutingUnavailableMarker => marker !== null),
    };
  } catch {
    return { schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION, markers: [] };
  }
}

function writeMarkerStore(
  baseStateDir: string,
  store: RoleRoutingMarkerStore,
  publish?: (contents: string) => void,
): void {
  const path = markerStorePath(baseStateDir);
  mkdirSync(dirname(path), { recursive: true });
  const contents = `${JSON.stringify(store, null, 2)}\n`;
  if (publish) {
    publish(contents);
    return;
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, contents);
  renameSync(temporaryPath, path);
}

function isExpired(marker: RoleRoutingUnavailableMarker, nowMs: number): boolean {
  const expiresAtMs = Date.parse(marker.expires_at);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
}

function markerSortTimestamp(marker: RoleRoutingUnavailableMarker): number {
  const observedAtMs = Date.parse(marker.observed_at);
  return Number.isFinite(observedAtMs) ? observedAtMs : Number.NEGATIVE_INFINITY;
}

function sameCanonicalCwd(a: string | undefined, b: string | undefined): boolean {
  return canonicalizeOriginCwd(a) === canonicalizeOriginCwd(b);
}

// Session-isolated, expiring, cross-process-safe store. File shape:
//   { schema_version: 1, markers: RoleRoutingUnavailableMarker[] }
export function writeRoleRoutingMarker(baseStateDir: string, marker: RoleRoutingUnavailableMarker): void {
  const normalizedMarker = normalizeMarker(marker);
  if (!normalizedMarker) {
    throw new Error('Role-routing marker requires a session_id plus valid observed_at and expires_at timestamps.');
  }
  const parentThreadId = normalizedMarker.parent_thread_id ?? '';

  withCrossProcessFileLockSync(markerStorePath(baseStateDir), (context) => {
    const nowMs = Date.now();
    const store = readMarkerStore(baseStateDir);
    const markers = store.markers.filter((candidate) => {
      if (!sameCanonicalCwd(candidate.cwd, normalizedMarker.cwd)) return true;
      if (isExpired(candidate, nowMs)) return false;
      return candidate.session_id !== normalizedMarker.session_id
        || (candidate.parent_thread_id ?? '') !== parentThreadId;
    });
    markers.push(normalizedMarker);
    context.assertOwnership();
    writeMarkerStore(baseStateDir, {
      schema_version: ROLE_ROUTING_MARKER_SCHEMA_VERSION,
      markers,
    }, context.publish);
  }, {
    maxAttempts: ROLE_ROUTING_MARKER_LOCK_MAX_ATTEMPTS,
    retryMs: ROLE_ROUTING_MARKER_LOCK_RETRY_MS,
  });
}

// readRoleRoutingMarker: return the newest non-expired marker matching scope
// (cwd optional, session_id required, parent_thread_id optional), else null.
export function readRoleRoutingMarker(
  baseStateDir: string,
  scope: { cwd?: string; sessionId: string; parentThreadId?: string; nowMs?: number },
): RoleRoutingUnavailableMarker | null {
  const sessionId = scope.sessionId.trim();
  if (!sessionId) return null;
  const cwd = scope.cwd?.trim();
  const parentThreadId = scope.parentThreadId?.trim();
  const nowMs = typeof scope.nowMs === 'number' && Number.isFinite(scope.nowMs) ? scope.nowMs : Date.now();

  return readMarkerStore(baseStateDir).markers
    .filter((marker) => (
      !isExpired(marker, nowMs)
      && marker.session_id === sessionId
      && (!marker.cwd || sameCanonicalCwd(marker.cwd, cwd))
      && (!parentThreadId || marker.parent_thread_id === parentThreadId)
    ))
    .sort((left, right) => {
      const leftCwdRank = left.cwd ? 1 : 0;
      const rightCwdRank = right.cwd ? 1 : 0;
      if (leftCwdRank !== rightCwdRank) return rightCwdRank - leftCwdRank;
      return markerSortTimestamp(right) - markerSortTimestamp(left);
    })[0] ?? null;
}
