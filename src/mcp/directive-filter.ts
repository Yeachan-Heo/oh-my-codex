/**
 * Directive filtering utilities (side-effect-free)
 * Separated from memory-server.ts to avoid triggering autoStart side effects
 */

import { randomBytes } from 'crypto';

export interface ProjectDirective {
  id?: string;  // dir-<8 hex>, generated on add, migrated on first read
  directive: string;
  priority: string;
  context?: string;
  timestamp: string;
  expiresAt?: string;  // ISO 8601 timestamp
}

/**
 * Generate a stable directive ID.
 * Format: dir-<8 lowercase hex>
 */
export function generateDirectiveId(): string {
  return `dir-${randomBytes(4).toString('hex')}`;
}

/**
 * Validate that expiresAt is a valid ISO 8601 timestamp.
 * Returns true if expiresAt is valid, false if it's malformed.
 * Returns true if expiresAt is undefined (no expiry).
 */
export function isValidExpiry(expiresAt: string | undefined): boolean {
  if (!expiresAt) return true;  // No expiry is valid
  const parsed = Date.parse(expiresAt);
  return !isNaN(parsed);  // NaN means invalid
}

/**
 * Filter directives that have not yet expired.
 * Comparison uses Date.parse for proper instant comparison, not string comparison.
 * Malformed expiresAt values are treated as invalid and filtered out (fail-closed).
 */
export function filterActiveDirectives(directives: ProjectDirective[] | undefined): ProjectDirective[] {
  if (!directives) return [];
  const now = Date.now();
  return directives.filter(d => {
    if (!d.expiresAt) return true;  // No expiry means always active
    const parsed = Date.parse(d.expiresAt);
    if (isNaN(parsed)) return false;  // Malformed expiry: filter out (fail-closed)
    return parsed > now;  // Not yet expired
  });
}

/**
 * Select active high-priority directives for injection.
 * Returns up to 3 high-priority directives, newest first.
 * This is the shared injection rule for both agents-overlay and codex-native-hook.
 */
export function selectHighPriorityDirectives(
  directives: ProjectDirective[] | undefined,
  maxCount: number = 3,
): ProjectDirective[] {
  const active = filterActiveDirectives(directives);
  const high = active.filter(d => d.priority === 'high');
  // Sort by timestamp descending (newest first)
  return high.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, maxCount);
}

/**
 * Calculate the earliest future expiry time among all directives.
 * Returns undefined if no directives have an expiry or all expiries are in the past.
 * This is used to invalidate the wiki cache when directives expire.
 */
export function getEarliestFutureExpiry(directives: ProjectDirective[] | undefined): string | undefined {
  if (!directives) return undefined;
  const now = Date.now();
  let earliest: string | undefined;
  let earliestTime = Infinity;

  for (const d of directives) {
    if (!d.expiresAt) continue;  // Skip directives without expiry
    const parsed = Date.parse(d.expiresAt);
    if (isNaN(parsed)) continue;  // Skip malformed expiries
    if (parsed <= now) continue;  // Skip already-expired directives

    if (parsed < earliestTime) {
      earliestTime = parsed;
      earliest = d.expiresAt;
    }
  }

  return earliest;
}
