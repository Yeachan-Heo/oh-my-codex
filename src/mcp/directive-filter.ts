/**
 * Directive filtering utilities (side-effect-free)
 * Separated from memory-server.ts to avoid triggering autoStart side effects
 */

export interface ProjectDirective {
  directive: string;
  priority: string;
  context?: string;
  timestamp: string;
  expiresAt?: string;
}

/**
 * Filter directives that have not yet expired.
 * Comparison uses Date.parse for proper instant comparison, not string comparison.
 */
export function filterActiveDirectives(directives: ProjectDirective[] | undefined): ProjectDirective[] {
  if (!directives) return [];
  const now = Date.now();
  return directives.filter(d => !d.expiresAt || Date.parse(d.expiresAt) > now);
}
