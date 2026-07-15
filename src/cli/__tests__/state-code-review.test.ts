import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createDurableReviewCoordinator,
	createInitialReviewRecord,
	createLaneResultProposal,
	executeReviewOperation,
	type ReviewOperationName,
} from "../../code-review/coordinator.js";
import {
	resolveReviewPersistencePaths,
	runDurableTransaction,
} from "../../code-review/persistence.js";
import { stateCommand } from "../state.js";

const INPUT = Buffer.from(JSON.stringify({ workingDirectory: "." }), "utf8");
const REVIEW_ID = "20000000-0000-4000-8000-000000000001";
const START_KEY = "20000000-0000-4000-8000-000000000002";
const LANE_KEY = "20000000-0000-4000-8000-000000000003";
const RESULT_KEY = "20000000-0000-4000-8000-000000000004";
const HASH = "c".repeat(64);
const NOW = new Date("2026-07-14T00:00:00.000Z");

async function expectRejected(args: string[], pattern: RegExp, input = INPUT) {
	await assert.rejects(
		stateCommand(args, {
			readStdin: async () => input,
			executeReview: async () => ({ payload: { ok: true } }),
		}),
		pattern,
	);
}

async function seedRunningArchitect(workingDirectory: string) {
	const coordinator = createDurableReviewCoordinator({ workingDirectory, session_id: "session-1" });
	const record = createInitialReviewRecord({
		review_id: REVIEW_ID, session_id: "session-1", root_thread_id: "root-1", now: NOW,
		scope: {
			selector: { explicit_paths: [] }, status: "FULL_SCOPE", head_sha: "d".repeat(40), scope_hash: HASH,
			files: [{ path: "src/a.ts", change: "MODIFIED", sources: ["WORKTREE"], binary: false, additions: 1, deletions: 0 }],
			changed_lines: 1, reasons: [],
		},
		batch_plan: {
			review_flags: [],
			batches: [{ batch_id: "batch-1", module_root: "src", files: ["src/a.ts"], changed_lines: 1, oversized_single_file: false }],
			required_lanes: [
				{ lane_id: "reviewer-batch-1", role: "code-reviewer", batch_id: "batch-1" },
				{ lane_id: "architect-global", role: "architect", batch_id: "global" },
			],
		},
	});
	await coordinator.start({ record, idempotency_key: START_KEY });
	await coordinator.recordStart({
		event: { event: "START", review_id: REVIEW_ID, attempt: 1, lane_id: "architect-global", thread_id: "child-architect", idempotency_key: LANE_KEY },
		tracker: {
			schema_version: 1, session_id: "session-1", thread_id: "child-architect",
			tracker_lane_id: "architect-global", tracker_path: ".omx/state/subagent-tracking.json",
			first_seen_at: NOW.toISOString(),
		},
		now: NOW,
	});
	return coordinator;
}

function resultInput(workingDirectory: string) {
	return {
		workingDirectory, session_id: "session-1", event: "RESULT", review_id: REVIEW_ID,
		attempt: 1, lane_id: "architect-global", scope_hash: HASH, idempotency_key: RESULT_KEY,
		result: {
			role: "architect" as const, review_id: REVIEW_ID, attempt: 1, lane_id: "architect-global",
			batch_id: "global" as const, scope_hash: HASH, architectural_status: "CLEAR" as const, findings: [],
		},
	};
}

async function runCliReview(input: Record<string, unknown>) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const previousExitCode = process.exitCode;
	process.exitCode = undefined;
	try {
		await stateCommand(["review-record-lane", "--input", "-", "--json"], {
			readStdin: async () => Buffer.from(JSON.stringify(input)),
			stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
		});
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.exitCode = previousExitCode;
	}
}

async function runCliGet(input: Record<string, unknown>) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const previousExitCode = process.exitCode;
	process.exitCode = undefined;
	try {
		await stateCommand(["review-get", "--input", "-", "--json"], {
			readStdin: async () => Buffer.from(JSON.stringify(input)),
			stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
		});
		return { stdout, stderr, exitCode: process.exitCode };
	} finally {
		process.exitCode = previousExitCode;
	}
}

describe("omx state code-review recovery aliases", () => {
	it("maps every review alias to the matching internal operation and stdin object", async () => {
		const expected: Array<[string, ReviewOperationName]> = [
			["review-start", "review_start"],
			["review-get", "review_get"],
			["review-record-lane", "review_record_lane"],
			["review-resume", "review_resume"],
			["review-finalize", "review_finalize"],
		];
		for (const [alias, operation] of expected) {
			const calls: Array<{ operation: ReviewOperationName; input: unknown; source: string }> = [];
			const stdout: string[] = [];
			await stateCommand([alias, "--input", "-", "--json"], {
				readStdin: async () => INPUT,
				stdout: (line) => stdout.push(line),
				executeReview: async (actualOperation, input, host) => {
					calls.push({ operation: actualOperation, input, source: host.source });
					return { payload: { operation: actualOperation } };
				},
			});
			assert.deepEqual(calls, [{ operation, input: { workingDirectory: "." }, source: "CLI" }]);
			assert.deepEqual(JSON.parse(stdout[0] ?? ""), { operation });
		}
	});

	it("accepts only the exact --input - spelling and rejects inline/file/mode/duplicate input", async () => {
		await expectRejected(["review-get", "--input", "{}"], /require.*--input -/i);
		await expectRejected(["review-get", "--input-file", "payload.json"], /do not accept --input-file/i);
		await expectRejected(["review-get", "--input", "-", "--mode", "ralph"], /do not accept --mode/i);
		await expectRejected(["review-get", "--input=-"], /exact arguments --input -/i);
		await expectRejected(["review-get", "--input", "-", "--input", "-"], /only once|duplicate/i);
	});

	it("rejects empty, invalid UTF-8, and multiple JSON values with stdin guidance", async () => {
		await expectRejected(["review-get", "--input", "-"], /one JSON object/i, Buffer.alloc(0));
		await expectRejected(["review-get", "--input", "-"], /valid UTF-8/i, Buffer.from([0xff]));
		await expectRejected(
			["review-get", "--input", "-"],
			/valid JSON.*Pipe JSON.*--input -/is,
			Buffer.from('{"workingDirectory":"."}{"workingDirectory":"."}'),
		);
	});

	it("prints compact structured JSON to stderr and sets exit code on operation failure", async () => {
		const stderr: string[] = [];
		const previousExitCode = process.exitCode;
		try {
			process.exitCode = undefined;
			await stateCommand(["review-get", "--input", "-", "--json"], {
				readStdin: async () => INPUT,
				stderr: (line) => stderr.push(line),
				executeReview: async () => ({ payload: { error: "missing", code: "REVIEW_NOT_STARTED" }, isError: true }),
			});
			assert.equal(process.exitCode, 1);
			assert.equal(stderr[0], '{"error":"missing","code":"REVIEW_NOT_STARTED"}');
		} finally {
			process.exitCode = previousExitCode;
		}
	});

	it("keeps legacy state inline JSON legal", async () => {
		const calls: unknown[] = [];
		await stateCommand(["read", "--input", '{"mode":"ralph"}', "--json"], {
			stdout: () => {},
			execute: async (operation, input) => {
				calls.push({ operation, input });
				return { payload: { exists: false } };
			},
		});
		assert.deepEqual(calls, [{ operation: "state_read", input: { mode: "ralph" } }]);
	});

	it("rejects every readiness field at the real CLI adapter while MCP observation remains legal", async () => {
		for (const readiness of [
			{ lane_id: "reviewer-batch-1" },
			{ wait: false },
			{ maximum_wait_ms: 1_000 },
		]) {
			const cli = await runCliGet({ workingDirectory: process.cwd(), ...readiness });
			assert.equal(cli.exitCode, 1);
			assert.equal((JSON.parse(cli.stderr[0] ?? "") as { code?: string }).code, "INVALID_INVOCATION");
		}

		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-mcp-readiness-"));
		await seedRunningArchitect(workingDirectory);
		const mcp = await executeReviewOperation("review_get", {
			workingDirectory, session_id: "session-1", review_id: REVIEW_ID,
			lane_id: "architect-global", wait: false,
		}, { source: "MCP", now: () => NOW });
		assert.equal(mcp.isError, undefined);
	});

	it("rejects fresh CLI RESULT but recovers the same committed proposal key", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-cli-"));
		await seedRunningArchitect(workingDirectory);
		const input = resultInput(workingDirectory);
		const fresh = await runCliReview(input);
		assert.equal(fresh.exitCode, 1);
		assert.equal((JSON.parse(fresh.stderr[0] ?? "") as { code?: string }).code, "MCP_TRANSPORT_DEAD");

		const proposed = await executeReviewOperation("review_record_lane", input, { source: "MCP", now: () => NOW });
		assert.equal(proposed.isError, undefined);
		const recovered = await runCliReview(input);
		assert.equal(recovered.exitCode, undefined);
		assert.deepEqual(JSON.parse(recovered.stdout[0] ?? ""), proposed.payload);
	});

	it("recovers a PREPARED proposal with the same key and preserves MCP/CLI get parity", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-cli-prepared-"));
		const coordinator = await seedRunningArchitect(workingDirectory);
		const input = resultInput(workingDirectory);
		const current = await coordinator.get(REVIEW_ID);
		const event = {
			event: "RESULT" as const, review_id: REVIEW_ID, attempt: 1, lane_id: "architect-global",
			scope_hash: HASH, result: input.result, idempotency_key: RESULT_KEY,
		};
		const proposal = createLaneResultProposal({ review: current, event, source: "MCP", now: NOW });
		const paths = await resolveReviewPersistencePaths({ workingDirectory, session_id: "session-1" });
		await assert.rejects(
			runDurableTransaction(paths, {
				idempotency_key: RESULT_KEY, review_id: REVIEW_ID, operation: "PROPOSE_LANE_RESULT",
				input: { ...event, result: proposal.result }, expected_revision: current.revision,
				effects: [{
					name: "proposal", mode: "CREATE_ONCE_JSON",
					target: { area: "REVIEW_STATE", path: `${REVIEW_ID}/submissions/${RESULT_KEY}/proposal` },
					payload: proposal,
				}],
				response: proposal,
			}, { crashAt: "after:prepared" }),
			/injected crash/i,
		);
		const recovered = await runCliReview(input);
		assert.equal(recovered.exitCode, undefined);
		assert.deepEqual(JSON.parse(recovered.stdout[0] ?? ""), proposal);

		const getInput = { workingDirectory, session_id: "session-1", review_id: REVIEW_ID };
		const mcp = await executeReviewOperation("review_get", getInput, { source: "MCP" });
		const output: string[] = [];
		await stateCommand(["review-get", "--input", "-", "--json"], {
			readStdin: async () => Buffer.from(JSON.stringify(getInput)), stdout: (line) => output.push(line),
		});
		assert.deepEqual(JSON.parse(output[0] ?? ""), mcp.payload);
	});
});
