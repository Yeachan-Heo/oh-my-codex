/**
 * Decide whether `omx setup` should MERGE the OMX-managed block into an existing
 * AGENTS.md (preserving user-authored content) or fall back to the previous
 * overwrite/refresh behavior.
 *
 * Merge is the DEFAULT: a routine install/update must never silently drop the
 * user's project guidance. Callers opt out explicitly:
 *   - `--no-merge-agents` disables the default merge (previous behavior:
 *     refresh managed sections only, or prompt before overwriting).
 *   - `--force` performs a full reinstall and replaces AGENTS.md after backup.
 * `--merge-agents` is kept for explicitness and always selects merge (it also
 * re-enables merge alongside `--force`).
 */
export function resolveMergeAgents(flags: Set<string>): boolean {
	if (flags.has("--no-merge-agents")) return false;
	if (flags.has("--merge-agents")) return true;
	return !flags.has("--force");
}
