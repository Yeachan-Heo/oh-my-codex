import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export const GITHUB_PR_REVIEW_SCHEMA_VERSION = 1;

export type ReviewSeverity = "P0" | "P1" | "P2";
export type ReviewSide = "LEFT" | "RIGHT";

export interface ReviewFinding {
	id: string;
	severity: ReviewSeverity;
	body: string;
	fix: string;
	path: string;
	line: number;
	side: ReviewSide;
}

export interface ReviewFindingsArtifact {
	schema_version: 1;
	repository: string;
	pull_request: number;
	reviewed_head_sha: string;
	findings: ReviewFinding[];
}

export interface GhResult {
	status: number;
	stdout: string;
	stderr: string;
}

export type GhRunner = (args: readonly string[], input?: string) => GhResult;

export interface ReviewPublisherOptions {
	artifactPath: string;
	pullRequest: number;
	repository?: string;
	reviewedHeadSha?: string;
	publish?: boolean;
	receiptPath?: string;
	cwd?: string;
	gh?: GhRunner;
	receiptFileOps?: ReviewReceiptFileOps;
	platform?: NodeJS.Platform;
}

interface PullRequestResponse {
	state?: string;
	head?: { sha?: string };
	base?: { repo?: { full_name?: string } };
}

interface RepositoryResponse {
	full_name?: string;
	permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
}

interface PullFileResponse {
	filename?: string;
	patch?: string;
}

interface ReviewResponse {
	id?: number;
	url?: string;
	html_url?: string;
	pull_request_url?: string;
	commit_id?: string;
	body?: string;
	state?: string;
}

interface ReviewCommentResponse {
	id?: number;
	pull_request_review_id?: number;
	pull_request_url?: string;
	commit_id?: string;
	path?: string;
	line?: number | null;
	original_line?: number | null;
	side?: string | null;
	original_side?: string | null;
	original_commit_id?: string;
	body?: string;
}

export interface ReviewReceiptFileHandle {
	writeFile(data: string): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface ReviewReceiptFileOps {
	mkdir(path: string): Promise<void>;
	open(path: string, flags: "r" | "wx", mode?: number): Promise<ReviewReceiptFileHandle>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string): Promise<void>;
	syncDirectory(path: string): Promise<void>;
	token(): string;
}

export interface ReviewProposal {
	mode: "dry-run";
	repository: string;
	pull_request: number;
	head_sha: string;
	artifact_sha256: string;
	finding_ids: string[];
	request: ReviewRequestPayload;
}

export interface ReviewReceipt {
	mode: "publish";
	host: "github.com";
	repository: string;
	pull_request: number;
	head_sha: string;
	artifact_sha256: string;
	finding_ids: string[];
	review_id: number;
	review_url: string;
	review_state: string;
	submission_count: 1;
	comment_count: number;
	receipt_path: string;
}

export interface ReviewStaleReceipt {
	mode: "publish-stale";
	host: "github.com";
	repository: string;
	pull_request: number;
	reviewed_head_sha: string;
	current_head_sha: string;
	artifact_sha256: string;
	finding_ids: string[];
	review_id: number;
	review_url: string;
	review_state: "CHANGES_REQUESTED";
	submission_count: 1;
	comment_count: number;
	receipt_path: string;
	status: "review_submitted_but_pr_head_moved";
}

export interface ReviewRequestPayload {
	commit_id: string;
	event: "REQUEST_CHANGES";
	body: string;
	comments: Array<{
		path: string;
		line: number;
		side: ReviewSide;
		body: string;
	}>;
}

export class ReviewPublisherError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "ReviewPublisherError";
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export function createDefaultReviewReceiptFileOps(): ReviewReceiptFileOps {
	return {
		mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
		open: (path, flags, mode) => open(path, flags, mode) as Promise<FileHandle>,
		rename,
		rm: (path) => rm(path, { force: true }),
		syncDirectory,
		token: randomUUID,
	};
}

const GITHUB_HOST = "github.com";

function ghApiArgs(...args: string[]): string[] {
	return ["api", "--hostname", GITHUB_HOST, ...args];
}

export function defaultGhRunner(args: readonly string[], input?: string): GhResult {
	const result = spawnSync("gh", [...args], {
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	if (result.error) {
		return { status: -1, stdout: result.stdout ?? "", stderr: result.error.message };
	}
	return {
		status: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function fail(code: string, message: string): never {
	throw new ReviewPublisherError(code, message);
}

function parseJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fail("invalid_gh_response", `${label} returned invalid JSON`);
	}
}

function parsePostSubmitJson<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fail("publish_ambiguous_response", `${label} returned invalid JSON after submission; submission was not retried`);
	}
}

function runRead(gh: GhRunner, args: readonly string[], label: string): string {
	const result = gh(args);
	if (result.status !== 0) {
		fail("preflight_failed", `${label}: ${result.stderr.trim() || `gh exited ${result.status}`}`);
	}
	return result.stdout;
}

function runPostSubmitRead(gh: GhRunner, args: readonly string[], label: string): string {
	const result = gh(args);
	if (result.status !== 0) {
		fail("publish_ambiguous_response", `${label} failed after submission: ${result.stderr.trim() || `gh exited ${result.status}`}; submission was not retried`);
	}
	return result.stdout;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const extras = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extras.length > 0) fail("invalid_artifact", `${label} contains unknown fields: ${extras.join(", ")}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRepository(value: string): boolean {
	return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function validPath(value: string): boolean {
	return value.length > 0
		&& !value.startsWith("/")
		&& !value.startsWith("../")
		&& !value.includes("\\")
		&& !value.split("/").includes("..");
}

export function validateFindingsArtifact(value: unknown): ReviewFindingsArtifact {
	if (!isRecord(value)) fail("invalid_artifact", "artifact must be an object");
	assertExactKeys(value, ["schema_version", "repository", "pull_request", "reviewed_head_sha", "findings"], "artifact");
	if (value.schema_version !== GITHUB_PR_REVIEW_SCHEMA_VERSION) fail("invalid_artifact", "schema_version must be 1");
	if (typeof value.repository !== "string" || !validRepository(value.repository)) fail("invalid_artifact", "repository must be owner/name");
	if (!Number.isSafeInteger(value.pull_request) || Number(value.pull_request) <= 0) fail("invalid_artifact", "pull_request must be a positive integer");
	if (typeof value.reviewed_head_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.reviewed_head_sha)) fail("invalid_artifact", "reviewed_head_sha must be a lowercase 40-character SHA");
	if (!Array.isArray(value.findings) || value.findings.length === 0) fail("invalid_artifact", "findings must be a non-empty array");

	const ids = new Set<string>();
	const findings = value.findings.map((candidate, index): ReviewFinding => {
		if (!isRecord(candidate)) fail("invalid_artifact", `finding ${index} must be an object`);
		assertExactKeys(candidate, ["id", "severity", "body", "fix", "path", "line", "side"], `finding ${index}`);
		if (typeof candidate.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(candidate.id)) fail("invalid_artifact", `finding ${index} has an invalid stable id`);
		if (ids.has(candidate.id)) fail("invalid_artifact", `duplicate finding id ${candidate.id}`);
		ids.add(candidate.id);
		if (candidate.severity !== "P0" && candidate.severity !== "P1" && candidate.severity !== "P2") fail("invalid_artifact", `${candidate.id} severity must be P0, P1, or P2`);
		if (typeof candidate.body !== "string" || candidate.body.trim().length === 0) fail("invalid_artifact", `${candidate.id} body must be actionable and non-empty`);
		if (typeof candidate.fix !== "string" || candidate.fix.trim().length === 0) fail("invalid_artifact", `${candidate.id} fix must be actionable and non-empty`);
		if (typeof candidate.path !== "string" || !validPath(candidate.path)) fail("invalid_artifact", `${candidate.id} path must be PR-relative`);
		if (!Number.isSafeInteger(candidate.line) || Number(candidate.line) <= 0) fail("invalid_artifact", `${candidate.id} line must be a positive integer`);
		if (candidate.side !== "LEFT" && candidate.side !== "RIGHT") fail("invalid_artifact", `${candidate.id} side must be LEFT or RIGHT`);
		return candidate as unknown as ReviewFinding;
	});

	return {
		schema_version: 1,
		repository: value.repository,
		pull_request: Number(value.pull_request),
		reviewed_head_sha: value.reviewed_head_sha,
		findings,
	};
}

function patchAnchors(patch: string): Set<string> {
	const anchors = new Set<string>();
	let oldLine = 0;
	let newLine = 0;
	for (const rawLine of patch.split("\n")) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
		if (header) {
			oldLine = Number(header[1]);
			newLine = Number(header[2]);
			continue;
		}
		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			anchors.add(`RIGHT:${newLine}`);
			newLine += 1;
		} else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			anchors.add(`LEFT:${oldLine}`);
			oldLine += 1;
		} else if (rawLine.startsWith(" ")) {
			anchors.add(`LEFT:${oldLine}`);
			anchors.add(`RIGHT:${newLine}`);
			oldLine += 1;
			newLine += 1;
		}
	}
	return anchors;
}

export function validateDiffAnchors(findings: readonly ReviewFinding[], files: readonly PullFileResponse[]): void {
	const patches = new Map(files.map((file) => [file.filename, file.patch]));
	for (const finding of findings) {
		const patch = patches.get(finding.path);
		if (typeof patch !== "string" || patch.length === 0) fail("invalid_anchor", `${finding.id} path has no complete reviewable patch`);
		if (!patchAnchors(patch).has(`${finding.side}:${finding.line}`)) fail("invalid_anchor", `${finding.id} does not anchor to ${finding.path}:${finding.line}:${finding.side}`);
	}
}

function buildRequest(artifact: ReviewFindingsArtifact): ReviewRequestPayload {
	const ids = artifact.findings.map((finding) => finding.id);
	return {
		commit_id: artifact.reviewed_head_sha,
		event: "REQUEST_CHANGES",
		body: `Requested changes for ${ids.length} actionable finding${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`,
		comments: artifact.findings.map((finding) => ({
			path: finding.path,
			line: finding.line,
			side: finding.side,
			body: `**${finding.severity} ${finding.id}**\n\n${finding.body.trim()}\n\n**Required fix:** ${finding.fix.trim()}`,
		})),
	};
}

function assertCurrentHead(
	gh: GhRunner,
	artifact: ReviewFindingsArtifact,
	label: string,
): PullRequestResponse {
	const pr = parseJson<PullRequestResponse>(
		runRead(gh, ghApiArgs(`repos/${artifact.repository}/pulls/${artifact.pull_request}`), label),
		label,
	);
	if (pr.base?.repo?.full_name !== artifact.repository) fail("repository_mismatch", `${label} resolved a foreign base repository`);
	if (pr.state !== "open") fail("pull_request_not_open", `${label} found pull request state ${pr.state ?? "unknown"}`);
	if (pr.head?.sha !== artifact.reviewed_head_sha) fail("stale_head", `${label} found current head ${pr.head?.sha ?? "unknown"}`);
	return pr;
}

function expectedApiRoot(repository: string): string {
	return `https://api.github.com/repos/${repository}`;
}

function expectedReviewUrl(repository: string, pullRequest: number, reviewId: number): string {
	return `${expectedApiRoot(repository)}/pulls/${pullRequest}/reviews/${reviewId}`;
}

function expectedPullRequestUrl(repository: string, pullRequest: number): string {
	return `${expectedApiRoot(repository)}/pulls/${pullRequest}`;
}

function expectedReviewHtmlUrl(repository: string, pullRequest: number, reviewId: number): string {
	return `https://github.com/${repository}/pull/${pullRequest}#pullrequestreview-${reviewId}`;
}

function validSha(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function requestedCommentSignature(comment: ReviewRequestPayload["comments"][number]): string {
	return JSON.stringify([comment.path, comment.line, comment.side, comment.body]);
}

function storedCommentSignature(comment: ReviewCommentResponse, headMoved: boolean): string | undefined {
	if (typeof comment.path !== "string" || typeof comment.body !== "string") return undefined;
	if (!headMoved) {
		if (!Number.isSafeInteger(comment.line) || (comment.side !== "LEFT" && comment.side !== "RIGHT")) return undefined;
		return JSON.stringify([comment.path, comment.line, comment.side, comment.body]);
	}
	const originalSide = comment.original_side ?? comment.side;
	if (!Number.isSafeInteger(comment.original_line) || (originalSide !== "LEFT" && originalSide !== "RIGHT")) return undefined;
	return JSON.stringify([comment.path, comment.original_line, originalSide, comment.body]);
}

function verifyStoredReview(
	gh: GhRunner,
	artifact: ReviewFindingsArtifact,
	request: ReviewRequestPayload,
	reviewId: number,
	headMoved: boolean,
): { review: Required<Pick<ReviewResponse, "id" | "html_url" | "state">>; commentCount: number } {
	const reviewRoute = `repos/${artifact.repository}/pulls/${artifact.pull_request}/reviews/${reviewId}`;
	const review = parsePostSubmitJson<ReviewResponse>(runPostSubmitRead(gh, ghApiArgs(reviewRoute), "stored review verification"), "stored review verification");
	const expectedReviewApiUrl = expectedReviewUrl(artifact.repository, artifact.pull_request, reviewId);
	if (
		review.id !== reviewId
		|| review.url !== expectedReviewApiUrl
		|| review.pull_request_url !== expectedPullRequestUrl(artifact.repository, artifact.pull_request)
		|| review.html_url !== expectedReviewHtmlUrl(artifact.repository, artifact.pull_request, reviewId)
		|| review.commit_id !== artifact.reviewed_head_sha
		|| review.state !== "CHANGES_REQUESTED"
		|| review.body !== request.body
	) {
		fail("publish_ambiguous_response", "stored review identity, head, state, body, or canonical URLs did not match the submitted review; submission was not retried");
	}

	const pagedComments = parsePostSubmitJson<ReviewCommentResponse[][]>(
		runPostSubmitRead(gh, ghApiArgs(`${reviewRoute}/comments`, "--paginate", "--slurp"), "stored review comments verification"),
		"stored review comments verification",
	);
	if (!Array.isArray(pagedComments) || pagedComments.some((page) => !Array.isArray(page))) {
		fail("publish_ambiguous_response", "stored review comments response was not a paginated array; submission was not retried");
	}
	const comments = pagedComments.flat();
	const expectedCommentSignatures = request.comments.map(requestedCommentSignature).sort();
	const observedCommentSignatures = comments.map((comment) => storedCommentSignature(comment, headMoved)).sort();
	const commentsMatch = comments.length === request.comments.length
		&& comments.every((comment) => Number.isSafeInteger(comment.id)
			&& Number(comment.id) > 0
			&& comment.pull_request_review_id === reviewId
			&& comment.pull_request_url === expectedPullRequestUrl(artifact.repository, artifact.pull_request)
			&& (headMoved
				? comment.original_commit_id === artifact.reviewed_head_sha && validSha(comment.commit_id)
				: comment.commit_id === artifact.reviewed_head_sha))
		&& observedCommentSignatures.every((signature) => signature !== undefined)
		&& JSON.stringify(observedCommentSignatures) === JSON.stringify(expectedCommentSignatures);
	if (!commentsMatch) {
		fail("publish_ambiguous_response", "stored inline comments did not exactly match the submitted count, review identity, head, paths, lines, sides, and bodies; submission was not retried");
	}

	return {
		review: {
			id: reviewId,
			html_url: review.html_url,
			state: "CHANGES_REQUESTED",
		},
		commentCount: comments.length,
	};
}

function receiptJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeExclusiveDurable(path: string, contents: string, fileOps: ReviewReceiptFileOps): Promise<void> {
	const parent = dirname(path);
	let created = false;
	let handle: ReviewReceiptFileHandle | undefined;
	try {
		handle = await fileOps.open(path, "wx", 0o600);
		created = true;
		await handle.writeFile(contents);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fileOps.syncDirectory(parent);
	} catch (error) {
		if (handle) await handle.close().catch(() => undefined);
		if (created) await fileOps.rm(path).catch(() => undefined);
		throw error;
	}
}

async function reservePendingReceipt(receiptPath: string, pending: unknown, fileOps: ReviewReceiptFileOps): Promise<void> {
	await fileOps.mkdir(dirname(receiptPath));
	try {
		await writeExclusiveDurable(receiptPath, receiptJson(pending), fileOps);
	} catch (error) {
		throw new ReviewPublisherError("receipt_reservation_failed", error instanceof Error ? error.message : String(error));
	}
}

async function reserveCanonicalGuard(guardPath: string, pending: unknown, fileOps: ReviewReceiptFileOps): Promise<void> {
	try {
		await fileOps.mkdir(dirname(guardPath));
		await writeExclusiveDurable(guardPath, receiptJson(pending), fileOps);
	} catch (error) {
		const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
		const errorPath = isRecord(error) && typeof error.path === "string" ? error.path : undefined;
		if (errorCode === "EEXIST" && errorPath === guardPath) {
			throw new ReviewPublisherError("publish_guard_exists", `${guardPath} is already reserved; publication was not attempted`);
		}
		throw new ReviewPublisherError("publish_guard_reservation_failed", `${guardPath} could not be reserved: ${errorCode ? `${errorCode}: ` : ""}${error instanceof Error ? error.message : String(error)}; publication was not attempted`);
	}
}

async function replaceDurable(path: string, value: unknown, fileOps: ReviewReceiptFileOps, code: string): Promise<void> {
	const parent = dirname(path);
	const tempPath = `${path}.tmp.${fileOps.token()}`;
	try {
		await writeExclusiveDurable(tempPath, receiptJson(value), fileOps);
		await fileOps.rename(tempPath, path);
		await fileOps.syncDirectory(parent);
	} catch (error) {
		await fileOps.rm(tempPath).catch(() => undefined);
		throw new ReviewPublisherError(code, `${error instanceof Error ? error.message : String(error)}; prior durable state was preserved`);
	}
}

async function finalizeReceipt(receiptPath: string, finalReceipt: unknown, fileOps: ReviewReceiptFileOps): Promise<void> {
	const parent = dirname(receiptPath);
	const guardPath = `${receiptPath}.ambiguous`;
	const tempPath = `${receiptPath}.tmp.${fileOps.token()}`;
	const guard = {
		mode: "publish-ambiguous",
		status: "receipt_finalization_in_progress",
		receipt_path: receiptPath,
	};
	try {
		await writeExclusiveDurable(guardPath, receiptJson(guard), fileOps);
		await writeExclusiveDurable(tempPath, receiptJson(finalReceipt), fileOps);
		await fileOps.rename(tempPath, receiptPath);
		await fileOps.syncDirectory(parent);
		await fileOps.rm(guardPath);
	} catch (error) {
		await fileOps.rm(tempPath).catch(() => undefined);
		throw new ReviewPublisherError("receipt_finalization_failed", `${error instanceof Error ? error.message : String(error)}; pending receipt or durable ambiguity guard was preserved`);
	}
}

function classifyPublishFailure(result: GhResult): ReviewPublisherError {
	const detail = result.stderr.trim() || result.stdout.trim() || `gh exited ${result.status}`;
	if (/403|forbidden|resource not accessible/i.test(detail)) return new ReviewPublisherError("publish_permission_denied", detail);
	if (/422|unprocessable|validation failed/i.test(detail)) return new ReviewPublisherError("publish_validation_failed", detail);
	if (/429|rate.?limit|secondary rate/i.test(detail)) return new ReviewPublisherError("publish_rate_limited", detail);
	return new ReviewPublisherError("publish_ambiguous_failure", `${detail}; submission was not retried`);
}

export function reviewPublicationStateFilename(
	kind: "guard" | "receipt",
	artifact: Pick<ReviewFindingsArtifact, "repository" | "pull_request" | "reviewed_head_sha">,
	artifactSha256: string,
): string {
	const identity = JSON.stringify({
		host: GITHUB_HOST,
		repository: artifact.repository,
		pull_request: artifact.pull_request,
		reviewed_head_sha: artifact.reviewed_head_sha,
		artifact_sha256: artifactSha256,
	});
	const digest = createHash("sha256").update(`omx-github-pr-review-${kind}\0`).update(identity).digest("hex");
	return `${kind}-${digest}.json`;
}

function receiptDefaultPath(cwd: string, artifact: ReviewFindingsArtifact, artifactSha256: string): string {
	return join(cwd, ".omx", "reviews", "receipts", reviewPublicationStateFilename("receipt", artifact, artifactSha256));
}

function canonicalGuardPath(cwd: string, artifact: ReviewFindingsArtifact, artifactSha256: string): string {
	return join(cwd, ".omx", "reviews", "guards", reviewPublicationStateFilename("guard", artifact, artifactSha256));
}

export async function publishGithubPrReview(options: ReviewPublisherOptions): Promise<ReviewProposal | ReviewReceipt> {
	if (options.publish && (options.platform ?? process.platform) === "win32") {
		fail("publish_unsupported_platform", "--publish is unavailable on win32 because crash-durable guard and receipt semantics are not guaranteed; dry-run remains supported");
	}
	const artifactBytes = await readFile(options.artifactPath, "utf8");
	let artifactJson: unknown;
	try {
		artifactJson = JSON.parse(artifactBytes);
	} catch {
		fail("invalid_artifact", "findings artifact is not valid JSON");
	}
	const artifact = validateFindingsArtifact(artifactJson);
	if (options.pullRequest !== artifact.pull_request) fail("identity_mismatch", "--github-pr does not match artifact pull_request");
	if (options.repository && options.repository !== artifact.repository) fail("identity_mismatch", "--repo does not match artifact repository");
	if (options.reviewedHeadSha && options.reviewedHeadSha !== artifact.reviewed_head_sha) fail("identity_mismatch", "--head does not match artifact reviewed_head_sha");

	const gh = options.gh ?? defaultGhRunner;
	runRead(gh, ["auth", "status", "--hostname", "github.com"], "gh authentication");
	const repo = parseJson<RepositoryResponse>(runRead(gh, ghApiArgs(`repos/${artifact.repository}`), "repository preflight"), "repository preflight");
	if (repo.full_name !== artifact.repository) fail("repository_mismatch", `resolved repository is ${repo.full_name ?? "unknown"}`);
	if (!(repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push)) fail("permission_denied", "authenticated user lacks write/maintain/admin permission");

	assertCurrentHead(gh, artifact, "pull request preflight");

	const pagedFiles = parseJson<PullFileResponse[][]>(runRead(gh, ghApiArgs(`repos/${artifact.repository}/pulls/${artifact.pull_request}/files`, "--paginate", "--slurp"), "pull request diff preflight"), "pull request diff preflight");
	if (!Array.isArray(pagedFiles) || pagedFiles.some((page) => !Array.isArray(page))) fail("invalid_gh_response", "pull request files response must be paginated arrays");
	validateDiffAnchors(artifact.findings, pagedFiles.flat());
	assertCurrentHead(gh, artifact, "pre-submit head verification");

	const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
	const request = buildRequest(artifact);
	const findingIds = artifact.findings.map((finding) => finding.id);
	if (!options.publish) {
		return {
			mode: "dry-run",
			repository: artifact.repository,
			pull_request: artifact.pull_request,
			head_sha: artifact.reviewed_head_sha,
			artifact_sha256: artifactSha256,
			finding_ids: findingIds,
			request,
		};
	}

	const cwd = options.cwd ?? process.cwd();
	const receiptPath = options.receiptPath ?? receiptDefaultPath(cwd, artifact, artifactSha256);
	const guardPath = canonicalGuardPath(cwd, artifact, artifactSha256);
	const fileOps = options.receiptFileOps ?? createDefaultReviewReceiptFileOps();
	const guardBase = {
		mode: "publish-guard",
		host: GITHUB_HOST,
		repository: artifact.repository,
		pull_request: artifact.pull_request,
		reviewed_head_sha: artifact.reviewed_head_sha,
		artifact_sha256: artifactSha256,
		finding_ids: findingIds,
		guard_path: guardPath,
		receipt_path: receiptPath,
	};
	await reserveCanonicalGuard(guardPath, {
		...guardBase,
		status: "pending",
		phase: "pre_submit_reserved",
		submission_count: 0,
	}, fileOps);
	try {
		await reservePendingReceipt(receiptPath, {
			mode: "publish-pending",
			host: GITHUB_HOST,
			repository: artifact.repository,
			pull_request: artifact.pull_request,
			head_sha: artifact.reviewed_head_sha,
			artifact_sha256: artifactSha256,
			finding_ids: findingIds,
			guard_path: guardPath,
		}, fileOps);
	} catch (error) {
		await replaceDurable(guardPath, {
			...guardBase,
			status: "pending",
			phase: "pre_submit_receipt_reservation_failed",
			submission_count: 0,
		}, fileOps, "publish_guard_finalization_failed").catch(() => undefined);
		throw error;
	}

	await replaceDurable(guardPath, {
		...guardBase,
		status: "ambiguous",
		phase: "submission_in_progress",
		submission_count: "unknown",
	}, fileOps, "publish_guard_finalization_failed");

	let reviewId: number | undefined;
	let guardFinalized = false;
	try {
		const result = gh(
			ghApiArgs("-X", "POST", `repos/${artifact.repository}/pulls/${artifact.pull_request}/reviews`, "--input", "-"),
			JSON.stringify(request),
		);
		if (result.status !== 0) throw classifyPublishFailure(result);
		const response = parsePostSubmitJson<ReviewResponse>(result.stdout, "create review");
		if (!Number.isSafeInteger(response.id) || Number(response.id) <= 0) {
			fail("publish_ambiguous_response", "create review succeeded without a positive numeric review id; submission was not retried");
		}
		reviewId = response.id as number;
		const postSubmitPr = parsePostSubmitJson<PullRequestResponse>(
			runPostSubmitRead(gh, ghApiArgs(`repos/${artifact.repository}/pulls/${artifact.pull_request}`), "post-submit head verification"),
			"post-submit head verification",
		);
		if (postSubmitPr.base?.repo?.full_name !== artifact.repository || postSubmitPr.state !== "open") {
			fail("publish_ambiguous_response", "post-submit head verification resolved a foreign or non-open pull request");
		}
		const currentHeadSha = postSubmitPr.head?.sha;
		if (typeof currentHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(currentHeadSha)) {
			fail("publish_ambiguous_response", "post-submit head verification returned no valid current head SHA");
		}
		const headMoved = currentHeadSha !== artifact.reviewed_head_sha;
		const verified = verifyStoredReview(gh, artifact, request, reviewId, headMoved);
		if (headMoved) {
			const staleReceipt: ReviewStaleReceipt = {
				mode: "publish-stale",
				host: GITHUB_HOST,
				repository: artifact.repository,
				pull_request: artifact.pull_request,
				reviewed_head_sha: artifact.reviewed_head_sha,
				current_head_sha: currentHeadSha,
				artifact_sha256: artifactSha256,
				finding_ids: findingIds,
				review_id: verified.review.id,
				review_url: verified.review.html_url,
				review_state: "CHANGES_REQUESTED",
				submission_count: 1,
				comment_count: verified.commentCount,
				receipt_path: receiptPath,
				status: "review_submitted_but_pr_head_moved",
			};
			await replaceDurable(guardPath, {
				...guardBase,
				status: "stale",
				current_head_sha: currentHeadSha,
				review_id: verified.review.id,
				review_url: verified.review.html_url,
				review_state: "CHANGES_REQUESTED",
				submission_count: 1,
				comment_count: verified.commentCount,
			}, fileOps, "publish_guard_finalization_failed");
			guardFinalized = true;
			await finalizeReceipt(receiptPath, staleReceipt, fileOps);
			fail("post_submit_stale_head", `review ${reviewId} was submitted to ${artifact.reviewed_head_sha}, but current head is ${currentHeadSha}; submission was not retried`);
		}
		const receipt: ReviewReceipt = {
			mode: "publish",
			host: GITHUB_HOST,
			repository: artifact.repository,
			pull_request: artifact.pull_request,
			head_sha: artifact.reviewed_head_sha,
			artifact_sha256: artifactSha256,
			finding_ids: findingIds,
			review_id: verified.review.id,
			review_url: verified.review.html_url,
			review_state: verified.review.state,
			submission_count: 1,
			comment_count: verified.commentCount,
			receipt_path: receiptPath,
		};
		await replaceDurable(guardPath, {
			...guardBase,
			status: "final",
			current_head_sha: currentHeadSha,
			review_id: verified.review.id,
			review_url: verified.review.html_url,
			review_state: verified.review.state,
			submission_count: 1,
			comment_count: verified.commentCount,
		}, fileOps, "publish_guard_finalization_failed");
		guardFinalized = true;
		await finalizeReceipt(receiptPath, receipt, fileOps);
		return receipt;
	} catch (error) {
		if (!guardFinalized) {
			await replaceDurable(guardPath, {
				...guardBase,
				status: "ambiguous",
				phase: "post_submit_verification_or_finalization_failed",
				submission_count: "unknown",
				...(reviewId === undefined ? {} : { review_id: reviewId }),
				error_code: error instanceof ReviewPublisherError ? error.code : "unknown_error",
			}, fileOps, "publish_guard_finalization_failed").catch(() => undefined);
		}
		throw error;
	}
}
