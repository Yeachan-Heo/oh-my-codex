export type CodeReviewExternalMutationClass = "read-only" | "external-write" | "invalid";

/**
 * Classify only the exact public code-review publisher grammar. Invalid or
 * unfamiliar forms fail closed instead of borrowing read-only treatment.
 */
export function classifyCodeReviewExternalMutationArgs(
	args: readonly string[],
): CodeReviewExternalMutationClass {
	const valueOptions = new Set(["--github-pr", "--findings", "--repo", "--head", "--receipt"]);
	const seen = new Set<string>();
	let publish = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "--publish" || arg === "--dry-run") {
			if (seen.has(arg)) return "invalid";
			seen.add(arg);
			publish ||= arg === "--publish";
			dryRun ||= arg === "--dry-run";
			continue;
		}
		if (!valueOptions.has(arg) || seen.has(arg)) return "invalid";
		const value = args[index + 1] ?? "";
		if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) return "invalid";
		seen.add(arg);
		index += 1;
	}
	if (publish && dryRun) return "invalid";
	if (!seen.has("--github-pr") || !seen.has("--findings")) return "invalid";
	if (!publish && seen.has("--receipt")) return "invalid";
	return publish ? "external-write" : "read-only";
}
