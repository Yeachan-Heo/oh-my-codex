import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { classifyCodeReviewExternalMutationArgs } from "../guard.js";
import {
	createDefaultReviewReceiptFileOps,
	publishGithubPrReview,
	reviewPublicationStateFilename,
	ReviewPublisherError,
	validateDiffAnchors,
	validateFindingsArtifact,
	type GhResult,
	type ReviewFindingsArtifact,
	type ReviewReceiptFileOps,
} from "../publisher.js";

const SHA = "a".repeat(40);
const MOVED_SHA = "b".repeat(40);
const REPO = "owner/repo";
const REVIEW_ID = 99;
const REVIEW_BODY = "Requested changes for 1 actionable finding: G007-P1-001";
const COMMENT_BODY = "**P1 G007-P1-001**\n\nThis accepts stale input and can publish an incorrect result.\n\n**Required fix:** Compare the immutable reviewed SHA before submission.";

function artifact(overrides: Partial<ReviewFindingsArtifact> = {}): ReviewFindingsArtifact {
	return {
		schema_version: 1,
		repository: REPO,
		pull_request: 7,
		reviewed_head_sha: SHA,
		findings: [{
			id: "G007-P1-001",
			severity: "P1",
			body: "This accepts stale input and can publish an incorrect result.",
			fix: "Compare the immutable reviewed SHA before submission.",
			path: "src/example.ts",
			line: 2,
			side: "RIGHT",
		}],
		...overrides,
	};
}

interface MockGh {
	run: (args: readonly string[], input?: string) => GhResult;
	calls: Array<{ args: readonly string[]; input?: string }>;
}

interface MockGhOptions {
	repository?: string;
	pullRequest?: number;
	publishResult?: GhResult;
	pullRequests?: unknown[];
	storedReview?: unknown;
	storedComments?: unknown;
	readFailures?: Record<string, GhResult>;
}

function pullRequest(headSha = SHA, repository = REPO): unknown {
	return { state: "open", head: { sha: headSha }, base: { repo: { full_name: repository } } };
}

function storedReview(overrides: Record<string, unknown> = {}, repository = REPO, pullRequestNumber = 7): unknown {
	return {
		id: REVIEW_ID,
		url: `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}/reviews/${REVIEW_ID}`,
		html_url: `https://github.com/${repository}/pull/${pullRequestNumber}#pullrequestreview-${REVIEW_ID}`,
		pull_request_url: `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`,
		commit_id: SHA,
		body: REVIEW_BODY,
		state: "CHANGES_REQUESTED",
		...overrides,
	};
}

function storedComment(overrides: Record<string, unknown> = {}, repository = REPO, pullRequestNumber = 7): unknown {
	return {
		id: 501,
		pull_request_review_id: REVIEW_ID,
		pull_request_url: `https://api.github.com/repos/${repository}/pulls/${pullRequestNumber}`,
		commit_id: SHA,
		path: "src/example.ts",
		line: 2,
		side: "RIGHT",
		body: COMMENT_BODY,
		...overrides,
	};
}

function normalizedGhKey(args: readonly string[]): string {
	return args[0] === "api" ? ["api", ...args.slice(3)].join(" ") : args.join(" ");
}

function mockGh(options: MockGhOptions = {}): MockGh {
	const calls: Array<{ args: readonly string[]; input?: string }> = [];
	let pullRequestRead = 0;
	const repository = options.repository ?? REPO;
	const pullRequestNumber = options.pullRequest ?? 7;
	return {
		calls,
		run(args, input) {
			calls.push({ args, input });
			if (args[0] === "api") assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
			const key = normalizedGhKey(args);
			const readFailure = options.readFailures?.[key];
			if (readFailure) return readFailure;
			if (key === "auth status --hostname github.com") return { status: 0, stdout: "", stderr: "" };
			if (key === `api repos/${repository}`) return { status: 0, stdout: JSON.stringify({ full_name: repository, permissions: { push: true } }), stderr: "" };
			if (key === `api repos/${repository}/pulls/${pullRequestNumber}`) {
				const responses = options.pullRequests ?? [pullRequest(SHA, repository)];
				const response = responses[Math.min(pullRequestRead, responses.length - 1)];
				pullRequestRead += 1;
				return { status: 0, stdout: JSON.stringify(response), stderr: "" };
			}
			if (key === `api repos/${repository}/pulls/${pullRequestNumber}/files --paginate --slurp`) return { status: 0, stdout: JSON.stringify([[{ filename: "src/example.ts", patch: "@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;\n const c = 3;" }]]), stderr: "" };
			if (key === `api -X POST repos/${repository}/pulls/${pullRequestNumber}/reviews --input -`) return options.publishResult ?? { status: 0, stdout: JSON.stringify({ id: REVIEW_ID }), stderr: "" };
			if (key === `api repos/${repository}/pulls/${pullRequestNumber}/reviews/${REVIEW_ID}`) return { status: 0, stdout: JSON.stringify(options.storedReview ?? storedReview({}, repository, pullRequestNumber)), stderr: "" };
			if (key === `api repos/${repository}/pulls/${pullRequestNumber}/reviews/${REVIEW_ID}/comments --paginate --slurp`) return { status: 0, stdout: JSON.stringify(options.storedComments ?? [[storedComment({}, repository, pullRequestNumber)]]), stderr: "" };
			throw new Error(`unexpected gh call: ${key}`);
		},
	};
}

type FinalizationFault = "open" | "write" | "fsync" | "rename" | "directory-fsync";

function faultingReceiptFileOps(fault: FinalizationFault, receiptPath: string): ReviewReceiptFileOps {
	const base = createDefaultReviewReceiptFileOps();
	let finalRenamed = false;
	return {
		...base,
		token: () => "fault-injection",
		async open(path, flags, mode) {
			const isFinalTemp = path.startsWith(`${receiptPath}.tmp.`);
			if (isFinalTemp && fault === "open") throw new Error("injected temp open failure");
			const handle = await base.open(path, flags, mode);
			if (!isFinalTemp) return handle;
			return {
				writeFile: fault === "write" ? async () => { throw new Error("injected temp write failure"); } : handle.writeFile.bind(handle),
				sync: fault === "fsync" ? async () => { throw new Error("injected temp fsync failure"); } : handle.sync.bind(handle),
				close: handle.close.bind(handle),
			};
		},
		async rename(from, to) {
			if (fault === "rename" && to === receiptPath) throw new Error("injected rename failure");
			await base.rename(from, to);
			if (to === receiptPath) finalRenamed = true;
		},
		async syncDirectory(path) {
			if (fault === "directory-fsync" && finalRenamed) throw new Error("injected directory fsync failure");
			await base.syncDirectory(path);
		},
	};
}

async function withArtifact(run: (root: string, path: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "omx-review-publisher-"));
	const path = join(root, "findings.json");
	await writeFile(path, JSON.stringify(artifact()));
	try {
		await run(root, path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function guards(root: string): Promise<Array<Record<string, unknown>>> {
	const guardDirectory = join(root, ".omx", "reviews", "guards");
	return Promise.all((await readdir(guardDirectory)).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(guardDirectory, name), "utf8")) as Record<string, unknown>));
}

describe("GitHub PR review artifact contract", () => {
	it("uses bounded domain-separated opaque filenames for every identity component", () => {
		const baseArtifact = artifact();
		const artifactHash = "c".repeat(64);
		const filenames = [
			reviewPublicationStateFilename("guard", baseArtifact, artifactHash),
			reviewPublicationStateFilename("receipt", baseArtifact, artifactHash),
			reviewPublicationStateFilename("guard", { ...baseArtifact, repository: "other/repo" }, artifactHash),
			reviewPublicationStateFilename("guard", { ...baseArtifact, pull_request: 8 }, artifactHash),
			reviewPublicationStateFilename("guard", { ...baseArtifact, reviewed_head_sha: MOVED_SHA }, artifactHash),
			reviewPublicationStateFilename("guard", baseArtifact, "d".repeat(64)),
		];
		assert.equal(new Set(filenames).size, filenames.length);
		for (const filename of filenames) {
			assert.match(filename, /^(?:guard|receipt)-[0-9a-f]{64}\.json$/);
			assert.ok(filename.length <= 96);
		}
	});

	it("accepts only actionable P0/P1/P2 findings with stable ids and exact identity", () => {
		assert.deepEqual(validateFindingsArtifact(artifact()), artifact());
		for (const invalid of [
			artifact({ findings: [{ ...artifact().findings[0]!, severity: "P3" as "P2" }] }),
			artifact({ findings: [{ ...artifact().findings[0]!, body: " " }] }),
			artifact({ findings: [{ ...artifact().findings[0]!, fix: "" }] }),
			artifact({ findings: [{ ...artifact().findings[0]!, path: "../secret" }] }),
			artifact({ findings: [{ ...artifact().findings[0]!, id: "x" }] }),
		]) {
			assert.throws(() => validateFindingsArtifact(invalid), ReviewPublisherError);
		}
	});

	it("rejects duplicate ids, unknown fields, and empty finding sets", () => {
		const duplicate = artifact({ findings: [artifact().findings[0]!, artifact().findings[0]!] });
		assert.throws(() => validateFindingsArtifact(duplicate), /duplicate finding id/);
		assert.throws(() => validateFindingsArtifact({ ...artifact(), extra: true }), /unknown fields/);
		assert.throws(() => validateFindingsArtifact(artifact({ findings: [] })), /non-empty array/);
	});

	it("validates side-specific diff anchors and fails closed on missing patches", () => {
		const finding = artifact().findings[0]!;
		assert.doesNotThrow(() => validateDiffAnchors([finding], [{ filename: finding.path, patch: "@@ -1 +1,2 @@\n old\n+new" }]));
		assert.throws(() => validateDiffAnchors([{ ...finding, side: "LEFT" }], [{ filename: finding.path, patch: "@@ -1 +1,2 @@\n old\n+new" }]), /does not anchor/);
		assert.throws(() => validateDiffAnchors([finding], [{ filename: finding.path }]), /no complete reviewable patch/);
	});
});

describe("GitHub PR review publisher", () => {
	it("publishes with maximum GitHub owner/repository lengths using bounded real-filesystem names", async () => {
		await withArtifact(async (root, path) => {
			const repository = `${"o".repeat(39)}/${"r".repeat(100)}`;
			await writeFile(path, JSON.stringify(artifact({ repository })));
			const gh = mockGh({ repository });
			const result = await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, cwd: root, gh: gh.run });
			assert.equal(result.mode, "publish");
			if (result.mode !== "publish") throw new Error("expected publish receipt");
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
			const guard = (await guards(root))[0];
			const guardFilename = basename(String(guard?.guard_path));
			const receiptFilename = basename(result.receipt_path);
			assert.match(guardFilename, /^guard-[0-9a-f]{64}\.json$/);
			assert.match(receiptFilename, /^receipt-[0-9a-f]{64}\.json$/);
			assert.ok(guardFilename.length <= 96);
			assert.ok(receiptFilename.length <= 96);
			assert.equal(guard?.host, "github.com");
			assert.equal(guard?.repository, repository);
			assert.equal(guard?.reviewed_head_sha, SHA);
			assert.match(String(guard?.artifact_sha256), /^[0-9a-f]{64}$/);
			assert.equal(result.host, "github.com");
			assert.equal(result.repository, repository);
			assert.equal(result.head_sha, SHA);
			assert.match(result.artifact_sha256, /^[0-9a-f]{64}$/);
		});
	});

	it("does not misclassify an overlong guard-path filesystem error as an existing guard", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			const base = createDefaultReviewReceiptFileOps();
			const fileOps: ReviewReceiptFileOps = {
				...base,
				async open(value, flags, mode) {
					if (value.includes("/guards/") && flags === "wx") throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" });
					return base.open(value, flags, mode);
				},
			};
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, cwd: root, gh: gh.run, receiptFileOps: fileOps }),
				(error: unknown) => error instanceof ReviewPublisherError && error.code === "publish_guard_reservation_failed" && /ENAMETOOLONG/.test(error.message),
			);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 0);
		});
	});

	it("supports win32 dry-run but rejects publish before any local or external write", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			let fileOpCalls = 0;
			const base = createDefaultReviewReceiptFileOps();
			const fileOps: ReviewReceiptFileOps = {
				...base,
				mkdir: async (value) => { fileOpCalls += 1; await base.mkdir(value); },
			};
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, platform: "win32", cwd: root, gh: gh.run, receiptFileOps: fileOps }),
				/publish_unsupported_platform.*win32.*dry-run remains supported/,
			);
			assert.equal(gh.calls.length, 0);
			assert.equal(fileOpCalls, 0);
			assert.deepEqual(await readdir(root), ["findings.json"]);
			const proposal = await publishGithubPrReview({ artifactPath: path, pullRequest: 7, platform: "win32", cwd: root, gh: gh.run, receiptFileOps: fileOps });
			assert.equal(proposal.mode, "dry-run");
			assert.equal(fileOpCalls, 0);
		});
	});

	it("defaults to read-only dry-run, preflights identity/head/anchors, and performs zero writes", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			const result = await publishGithubPrReview({ artifactPath: path, pullRequest: 7, cwd: root, gh: gh.run });
			assert.equal(result.mode, "dry-run");
			assert.equal(result.head_sha, SHA);
			assert.deepEqual(result.finding_ids, ["G007-P1-001"]);
			assert.equal(result.request.event, "REQUEST_CHANGES");
			assert.equal(result.request.commit_id, SHA);
			assert.equal(gh.calls.some((call) => call.args.includes("POST")), false);
			assert.deepEqual(await readdir(root), ["findings.json"]);
		});
	});

	it("publishes exactly one REST create-review request and persists an auditable receipt", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			const receiptPath = join(root, "receipt.json");
			const result = await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run });
			assert.equal(result.mode, "publish");
			assert.equal(result.review_id, 99);
			assert.equal(result.submission_count, 1);
			assert.equal(result.comment_count, 1);
			const writes = gh.calls.filter((call) => call.args.includes("POST"));
			assert.equal(writes.length, 1);
			assert.deepEqual(writes[0]?.args, ["api", "--hostname", "github.com", "-X", "POST", `repos/${REPO}/pulls/7/reviews`, "--input", "-"]);
			assert.doesNotMatch(writes[0]?.args.join(" ") ?? "", /comments|issues/);
			const payload = JSON.parse(writes[0]?.input ?? "{}") as { event?: string; commit_id?: string; comments?: unknown[] };
			assert.equal(payload.event, "REQUEST_CHANGES");
			assert.equal(payload.commit_id, SHA);
			assert.equal(payload.comments?.length, 1);
			assert.deepEqual(gh.calls.map((call) => call.args.join(" ")), [
				"auth status --hostname github.com",
				`api --hostname github.com repos/${REPO}`,
				`api --hostname github.com repos/${REPO}/pulls/7`,
				`api --hostname github.com repos/${REPO}/pulls/7/files --paginate --slurp`,
				`api --hostname github.com repos/${REPO}/pulls/7`,
				`api --hostname github.com -X POST repos/${REPO}/pulls/7/reviews --input -`,
				`api --hostname github.com repos/${REPO}/pulls/7`,
				`api --hostname github.com repos/${REPO}/pulls/7/reviews/${REVIEW_ID}`,
				`api --hostname github.com repos/${REPO}/pulls/7/reviews/${REVIEW_ID}/comments --paginate --slurp`,
			]);
			assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), result);
		});
	});

	it("keeps the default receipt separate from the canonical guard", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			const result = await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, cwd: root, gh: gh.run });
			assert.equal(result.mode, "publish");
			assert.match(result.receipt_path, /\.omx\/reviews\/receipts\/receipt-[0-9a-f]{64}\.json$/);
			assert.equal((await guards(root))[0]?.guard_path === result.receipt_path, false);
			assert.deepEqual(JSON.parse(await readFile(result.receipt_path, "utf8")), result);
		});
	});

	it("pins every REST read and write to github.com even when GH_HOST names an enterprise host", async () => {
		await withArtifact(async (root, path) => {
			const previousHost = process.env.GH_HOST;
			process.env.GH_HOST = "ghe.example.invalid";
			try {
				const gh = mockGh();
				await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "receipt.json"), cwd: root, gh: gh.run });
				const apiCalls = gh.calls.filter((call) => call.args[0] === "api");
				assert.ok(apiCalls.length > 0);
				assert.ok(apiCalls.every((call) => call.args[1] === "--hostname" && call.args[2] === "github.com"));
				assert.equal(apiCalls.filter((call) => call.args.includes("POST") && call.args[2] !== "github.com").length, 0);
			} finally {
				if (previousHost === undefined) delete process.env.GH_HOST;
				else process.env.GH_HOST = previousHost;
			}
		});
	});

	it("uses one canonical guard across distinct receipt paths for the same artifact", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "first.json"), cwd: root, gh: gh.run });
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "second.json"), cwd: root, gh: gh.run }),
				/publish_guard_exists.*publication was not attempted/,
			);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
			const storedGuards = await guards(root);
			assert.equal(storedGuards.length, 1);
			assert.equal(storedGuards[0]?.status, "final");
		});
	});

	it("keys canonical guards by artifact hash", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "first.json"), cwd: root, gh: gh.run });
			await writeFile(path, `${JSON.stringify(artifact())} `);
			await publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "second.json"), cwd: root, gh: gh.run });
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 2);
			const storedGuards = await guards(root);
			assert.equal(storedGuards.length, 2);
			assert.notEqual(storedGuards[0]?.artifact_sha256, storedGuards[1]?.artifact_sha256);
		});
	});

	it("keeps a pre-submit pending guard when receipt reservation fails and blocks an alternate receipt", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh();
			const occupiedReceipt = join(root, "occupied.json");
			await writeFile(occupiedReceipt, "occupied\n");
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: occupiedReceipt, cwd: root, gh: gh.run }),
				/receipt_reservation_failed/,
			);
			const storedGuards = await guards(root);
			assert.equal(storedGuards.length, 1);
			assert.equal(storedGuards[0]?.status, "pending");
			assert.equal(storedGuards[0]?.phase, "pre_submit_receipt_reservation_failed");
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "alternate.json"), cwd: root, gh: gh.run }),
				/publish_guard_exists/,
			);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 0);
		});
	});

	it("keeps an ambiguous guard after stored verification fails and blocks an alternate receipt", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh({ storedReview: storedReview({ body: "wrong" }) });
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "first.json"), cwd: root, gh: gh.run }),
				/publish_ambiguous_response/,
			);
			const ambiguousGuard = (await guards(root))[0];
			assert.equal(ambiguousGuard?.status, "ambiguous");
			assert.equal(ambiguousGuard?.review_id, REVIEW_ID);
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "alternate.json"), cwd: root, gh: gh.run }),
				/publish_guard_exists/,
			);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
		});
	});

	it("re-reads the head after diff validation and refuses to create a receipt or submit when it moved", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh({ pullRequests: [pullRequest(), pullRequest(MOVED_SHA)] });
			const receiptPath = join(root, "receipt.json");
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run }),
				/stale_head.*pre-submit head verification.*current head b{40}/,
			);
			assert.equal(gh.calls.some((call) => call.args.includes("POST")), false);
			assert.deepEqual(await readdir(root), ["findings.json"]);
		});
	});

	it("persists a truthful stale receipt and throws when the PR head moves after verified submission", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh({
				pullRequests: [pullRequest(), pullRequest(), pullRequest(MOVED_SHA)],
				storedComments: [[storedComment({ line: null, original_line: 2, commit_id: MOVED_SHA, original_commit_id: SHA })]],
			});
			const receiptPath = join(root, "receipt.json");
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run }),
				/post_submit_stale_head.*review 99 was submitted.*current head is b{40}/,
			);
			const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
			assert.deepEqual(receipt, {
				mode: "publish-stale",
				host: "github.com",
				repository: REPO,
				pull_request: 7,
				reviewed_head_sha: SHA,
				current_head_sha: MOVED_SHA,
				artifact_sha256: receipt.artifact_sha256,
				finding_ids: ["G007-P1-001"],
				review_id: REVIEW_ID,
				review_url: `https://github.com/${REPO}/pull/7#pullrequestreview-${REVIEW_ID}`,
				review_state: "CHANGES_REQUESTED",
				submission_count: 1,
				comment_count: 1,
				receipt_path: receiptPath,
				status: "review_submitted_but_pr_head_moved",
			});
			assert.match(String(receipt.artifact_sha256), /^[0-9a-f]{64}$/);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
			assert.equal((await guards(root))[0]?.status, "stale");
			const retryGh = mockGh();
			await assert.rejects(
				() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, "alternate-stale.json"), cwd: root, gh: retryGh.run }),
				/publish_guard_exists/,
			);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length + retryGh.calls.filter((call) => call.args.includes("POST")).length, 1);
		});
	});

	it("fails closed on ambiguous original coordinates after a post-submit head move", async () => {
		await withArtifact(async (root, path) => {
			const scenarios = [
				storedComment({ line: null, original_line: null, commit_id: MOVED_SHA, original_commit_id: SHA }),
				storedComment({ line: null, original_line: 2, commit_id: MOVED_SHA, original_commit_id: MOVED_SHA }),
				storedComment({ line: null, original_line: 2, side: null, commit_id: MOVED_SHA, original_commit_id: SHA }),
				storedComment({ line: null, original_line: 2, commit_id: "not-a-sha", original_commit_id: SHA }),
			];
			for (const [index, comment] of scenarios.entries()) {
				await writeFile(path, `${JSON.stringify(artifact())}${" ".repeat(index + 1)}`);
				const receiptPath = join(root, `ambiguous-stale-${index}.json`);
				const gh = mockGh({ pullRequests: [pullRequest(), pullRequest(), pullRequest(MOVED_SHA)], storedComments: [[comment]] });
				await assert.rejects(() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run }), /publish_ambiguous_response/);
				assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { mode?: string }).mode, "publish-pending");
				assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
			}
		});
	});

	it("keeps a recoverable pending or explicit ambiguity guard for every finalization fault", async () => {
		await withArtifact(async (root, path) => {
			for (const [index, fault] of (["open", "write", "fsync", "rename", "directory-fsync"] as const).entries()) {
				const receiptPath = join(root, `finalization-${fault}.json`);
				await writeFile(path, `${JSON.stringify(artifact())}${" ".repeat(index + 1)}`);
				const gh = mockGh();
				await assert.rejects(
					() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run, receiptFileOps: faultingReceiptFileOps(fault, receiptPath) }),
					/receipt_finalization_failed/,
					fault,
				);
				const canonical = JSON.parse(await readFile(receiptPath, "utf8")) as { mode?: string };
				assert.equal(canonical.mode, fault === "directory-fsync" ? "publish" : "publish-pending", fault);
				assert.equal((JSON.parse(await readFile(`${receiptPath}.ambiguous`, "utf8")) as { mode?: string }).mode, "publish-ambiguous", fault);
				const canonicalGuard = (await guards(root)).find((guard) => guard.receipt_path === receiptPath);
				assert.equal(canonicalGuard?.status, "final", fault);
				assert.equal(canonicalGuard?.review_id, REVIEW_ID, fault);
				assert.equal((await readdir(root)).some((name) => name.startsWith(`finalization-${fault}.json.tmp.`)), false, fault);
				assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1, fault);
			}
		});
	});

	it("fails closed for repo, permission, PR state, and moved-head preflight", async () => {
		await withArtifact(async (root, path) => {
			const scenarios = [
				{ match: `api repos/${REPO}`, response: { full_name: "other/repo", permissions: { push: true } }, error: /repository_mismatch/ },
				{ match: `api repos/${REPO}`, response: { full_name: REPO, permissions: { push: false } }, error: /permission_denied/ },
				{ match: `api repos/${REPO}/pulls/7`, response: { state: "closed", head: { sha: SHA }, base: { repo: { full_name: REPO } } }, error: /pull_request_not_open/ },
				{ match: `api repos/${REPO}/pulls/7`, response: { state: "open", head: { sha: "b".repeat(40) }, base: { repo: { full_name: REPO } } }, error: /stale_head/ },
			];
			for (const scenario of scenarios) {
				const gh = mockGh();
				const base = gh.run;
				gh.run = (args, input) => normalizedGhKey(args) === scenario.match
					? (gh.calls.push({ args, input }), { status: 0, stdout: JSON.stringify(scenario.response), stderr: "" })
					: base(args, input);
				await assert.rejects(() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, cwd: root, gh: gh.run }), scenario.error);
				assert.equal(gh.calls.some((call) => call.args.includes("POST")), false);
			}
		});
	});

	it("never retries 403, 422, rate-limit, or ambiguous write failures", async () => {
		await withArtifact(async (root, path) => {
			for (const [index, failure] of [
				{ result: { status: 1, stdout: "", stderr: "HTTP 403 Forbidden" }, code: /publish_permission_denied/ },
				{ result: { status: 1, stdout: "", stderr: "HTTP 422 Validation Failed" }, code: /publish_validation_failed/ },
				{ result: { status: 1, stdout: "", stderr: "secondary rate limit" }, code: /publish_rate_limited/ },
				{ result: { status: -1, stdout: "", stderr: "socket closed" }, code: /publish_ambiguous_failure/ },
			].entries()) {
				await writeFile(path, `${JSON.stringify(artifact())}${" ".repeat(index + 1)}`);
				const gh = mockGh({ publishResult: failure.result });
				await assert.rejects(() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath: join(root, `failure-${index}.json`), cwd: root, gh: gh.run }), failure.code);
				assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
			}
		});
	});

	it("does not retry an ambiguous successful response without a review receipt identity", async () => {
		await withArtifact(async (root, path) => {
			const gh = mockGh({ publishResult: { status: 0, stdout: "{}", stderr: "" } });
			await assert.rejects(() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, cwd: root, gh: gh.run }), /publish_ambiguous_response/);
			assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1);
		});
	});

	it("preserves the pending receipt and never retries for every stored-review identity mismatch", async () => {
		await withArtifact(async (root, path) => {
			const scenarios: Array<{ name: string; review?: unknown; readFailures?: Record<string, GhResult> }> = [
				{ name: "missing review", readFailures: { [`api repos/${REPO}/pulls/7/reviews/${REVIEW_ID}`]: { status: 1, stdout: "", stderr: "HTTP 404 Not Found" } } },
				{ name: "wrong id", review: storedReview({ id: 100 }) },
				{ name: "foreign API URL", review: storedReview({ url: `https://api.github.com/repos/other/repo/pulls/7/reviews/${REVIEW_ID}` }) },
				{ name: "foreign PR URL", review: storedReview({ pull_request_url: `https://api.github.com/repos/other/repo/pulls/7` }) },
				{ name: "foreign HTML URL", review: storedReview({ html_url: `https://github.com/other/repo/pull/7#pullrequestreview-${REVIEW_ID}` }) },
				{ name: "wrong head", review: storedReview({ commit_id: MOVED_SHA }) },
				{ name: "approved state", review: storedReview({ state: "APPROVED" }) },
				{ name: "wrong body", review: storedReview({ body: "different summary" }) },
			];
			for (const [index, scenario] of scenarios.entries()) {
				await writeFile(path, `${JSON.stringify(artifact())}${" ".repeat(index + 1)}`);
				const receiptPath = join(root, `review-mismatch-${index}.json`);
				const gh = mockGh({ storedReview: scenario.review, readFailures: scenario.readFailures });
				await assert.rejects(
					() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run }),
					/publish_ambiguous_response/,
					scenario.name,
				);
				assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { mode?: string }).mode, "publish-pending", scenario.name);
				assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1, scenario.name);
			}
		});
	});

	it("preserves the pending receipt for every stored-comment count and identity mismatch", async () => {
		await withArtifact(async (root, path) => {
			const scenarios: Array<{ name: string; comments?: unknown; readFailures?: Record<string, GhResult> }> = [
				{ name: "missing comments", readFailures: { [`api repos/${REPO}/pulls/7/reviews/${REVIEW_ID}/comments --paginate --slurp`]: { status: 1, stdout: "", stderr: "HTTP 404 Not Found" } } },
				{ name: "wrong count", comments: [[]] },
				{ name: "wrong review id", comments: [[storedComment({ pull_request_review_id: 100 })]] },
				{ name: "foreign PR URL", comments: [[storedComment({ pull_request_url: `https://api.github.com/repos/other/repo/pulls/7` })]] },
				{ name: "wrong head", comments: [[storedComment({ commit_id: MOVED_SHA })]] },
				{ name: "wrong path", comments: [[storedComment({ path: "src/other.ts" })]] },
				{ name: "wrong line", comments: [[storedComment({ line: 3 })]] },
				{ name: "wrong side", comments: [[storedComment({ side: "LEFT" })]] },
				{ name: "wrong body", comments: [[storedComment({ body: "different finding" })]] },
			];
			for (const [index, scenario] of scenarios.entries()) {
				await writeFile(path, `${JSON.stringify(artifact())}${" ".repeat(index + 1)}`);
				const receiptPath = join(root, `comment-mismatch-${index}.json`);
				const gh = mockGh({ storedComments: scenario.comments, readFailures: scenario.readFailures });
				await assert.rejects(
					() => publishGithubPrReview({ artifactPath: path, pullRequest: 7, publish: true, receiptPath, cwd: root, gh: gh.run }),
					/publish_ambiguous_response/,
					scenario.name,
				);
				assert.equal((JSON.parse(await readFile(receiptPath, "utf8")) as { mode?: string }).mode, "publish-pending", scenario.name);
				assert.equal(gh.calls.filter((call) => call.args.includes("POST")).length, 1, scenario.name);
			}
		});
	});
});

describe("external mutation guard", () => {
	it("classifies default and --dry-run as read-only and requires explicit --publish for external write", () => {
		const base = ["--github-pr", "7", "--findings", "findings.json"];
		assert.equal(classifyCodeReviewExternalMutationArgs(base), "read-only");
		assert.equal(classifyCodeReviewExternalMutationArgs([...base, "--dry-run"]), "read-only");
		assert.equal(classifyCodeReviewExternalMutationArgs([...base, "--publish"]), "external-write");
		assert.equal(classifyCodeReviewExternalMutationArgs([...base, "--publish", "--dry-run"]), "invalid");
		assert.equal(classifyCodeReviewExternalMutationArgs([...base, "--receipt", "receipt.json"]), "invalid");
		assert.equal(classifyCodeReviewExternalMutationArgs(["--publish"]), "invalid");
	});
});
