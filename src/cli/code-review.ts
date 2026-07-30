import { publishGithubPrReview } from "../github-pr-review/publisher.js";
import { classifyCodeReviewExternalMutationArgs } from "../github-pr-review/guard.js";

export const CODE_REVIEW_HELP = `
Usage:
  omx code-review --github-pr <number> --findings <artifact.json> [--repo <owner/name>] [--head <sha>] [--dry-run]
  omx code-review --github-pr <number> --findings <artifact.json> [--repo <owner/name>] [--head <sha>] --publish [--receipt <path>]

Without --publish, the command performs a read-only preflight and prints the exact proposed REQUEST_CHANGES payload.
--publish is the explicit external-write approval boundary and submits exactly one pinned GitHub review.
Publishing is unavailable on Windows; win32 fails before any guard, receipt, or POST, while dry-run remains supported.
Each publish reserves a canonical artifact-keyed guard under .omx/reviews/guards using a bounded opaque identity digest independently of --receipt.
--receipt selects only the destination receipt and cannot bypass an existing pending, ambiguous, final, or stale guard.
`;

interface ParsedArgs {
	pullRequest: number;
	artifactPath: string;
	repository?: string;
	reviewedHeadSha?: string;
	publish: boolean;
	receiptPath?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(CODE_REVIEW_HELP);
		throw new Error("__help__");
	}
	const values = new Map<string, string>();
	let publish = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--publish") {
			if (publish) throw new Error("duplicate --publish");
			publish = true;
			continue;
		}
		if (arg === "--dry-run") {
			if (dryRun) throw new Error("duplicate --dry-run");
			dryRun = true;
			continue;
		}
		if (!arg || !["--github-pr", "--findings", "--repo", "--head", "--receipt"].includes(arg)) throw new Error(`unknown argument: ${arg ?? ""}`);
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
		if (values.has(arg)) throw new Error(`duplicate ${arg}`);
		values.set(arg, value);
		index += 1;
	}
	if (publish && dryRun) throw new Error("--publish and --dry-run are mutually exclusive");
	if (!publish && values.has("--receipt")) throw new Error("--receipt is available only with --publish; dry-run performs zero writes");
	const prText = values.get("--github-pr");
	const pullRequest = Number(prText);
	if (!prText || !Number.isSafeInteger(pullRequest) || pullRequest <= 0) throw new Error("--github-pr must be a positive integer");
	const artifactPath = values.get("--findings");
	if (!artifactPath) throw new Error("--findings is required");
	return {
		pullRequest,
		artifactPath,
		repository: values.get("--repo"),
		reviewedHeadSha: values.get("--head"),
		publish,
		receiptPath: values.get("--receipt"),
	};
}

export async function codeReviewCommand(args: readonly string[]): Promise<void> {
	if (!args.includes("--help") && !args.includes("-h") && classifyCodeReviewExternalMutationArgs(args) === "invalid") {
		throw new Error("invalid code-review arguments; see `omx code-review --help`");
	}
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(args);
	} catch (error) {
		if (error instanceof Error && error.message === "__help__") return;
		throw error;
	}
	const result = await publishGithubPrReview(parsed);
	console.log(JSON.stringify(result, null, 2));
}
