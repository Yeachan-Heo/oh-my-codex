import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createDurableReviewCoordinator,
	createInitialReviewRecord,
} from "../../code-review/coordinator.js";
import {
	createSubagentTrackingState,
	recordSubagentTurn,
	writeSubagentTrackingState,
} from "../../subagents/tracker.js";

const REVIEW_ID = "10000000-0000-4000-8000-000000000001";
const START_KEY = "10000000-0000-4000-8000-000000000002";
const LANE_KEY = "10000000-0000-4000-8000-000000000003";
const RESULT_KEY = "10000000-0000-4000-8000-000000000004";
const HASH = "a".repeat(64);

async function stateServer() {
	process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
	return await import("../state-server.js");
}

async function seedRunningArchitect(workingDirectory: string) {
	const coordinator = createDurableReviewCoordinator({ workingDirectory, session_id: "session-1" });
	const record = createInitialReviewRecord({
		review_id: REVIEW_ID,
		session_id: "session-1",
		root_thread_id: "root-1",
		scope: {
			selector: { explicit_paths: [] }, status: "FULL_SCOPE", head_sha: "b".repeat(40),
			scope_hash: HASH,
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
		now: new Date("2026-07-14T00:00:00.000Z"),
	});
	await coordinator.start({ record, idempotency_key: START_KEY });
	await coordinator.recordStart({
		event: {
			event: "START", review_id: REVIEW_ID, attempt: 1, lane_id: "architect-global",
			thread_id: "child-architect", idempotency_key: LANE_KEY,
		},
		tracker: {
			schema_version: 1, session_id: "session-1", thread_id: "child-architect",
			tracker_lane_id: "architect-global", tracker_path: ".omx/state/subagent-tracking.json",
			first_seen_at: "2026-07-14T00:00:00.000Z",
		},
		now: new Date("2026-07-14T00:00:00.000Z"),
	});
	return coordinator;
}

function architectResult() {
	return {
		role: "architect" as const,
		review_id: REVIEW_ID,
		attempt: 1,
		lane_id: "architect-global",
		batch_id: "global" as const,
		scope_hash: HASH,
		architectural_status: "CLEAR" as const,
		findings: [],
	};
}

describe("state-server code-review control plane", () => {
	it("publishes five strict schemas including the START and RESULT union", async () => {
		const { buildStateServerTools } = await stateServer();
		const reviewTools = buildStateServerTools().filter((tool) => tool.name.startsWith("review_"));
		assert.deepEqual(reviewTools.map((tool) => tool.name), [
			"review_start", "review_get", "review_record_lane", "review_resume", "review_finalize",
		]);
		for (const tool of reviewTools.filter((candidate) => candidate.name !== "review_record_lane")) {
			assert.equal((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, false);
		}
		const lane = reviewTools.find((tool) => tool.name === "review_record_lane");
		const variants = (lane?.inputSchema as { oneOf?: Array<{ additionalProperties?: boolean; properties?: Record<string, unknown> }> }).oneOf;
		assert.equal(variants?.length, 2);
		assert.deepEqual(variants?.map((variant) => variant.additionalProperties), [false, false]);
		assert.deepEqual(variants?.map((variant) => Object.keys(variant.properties ?? {}).sort()), [
			["attempt", "event", "idempotency_key", "lane_id", "review_id", "session_id", "thread_id", "workingDirectory"],
			["attempt", "event", "idempotency_key", "lane_id", "result", "review_id", "scope_hash", "session_id", "workingDirectory"],
		]);
	});

	it("dispatches every review operation as structured JSON instead of an unknown tool", async () => {
		const { handleStateToolCall } = await stateServer();
		for (const name of ["review_start", "review_get", "review_record_lane", "review_resume", "review_finalize"]) {
			const response = await handleStateToolCall({ params: { name, arguments: { workingDirectory: process.cwd() } } });
			const text = response.content[0]?.text ?? "";
			assert.doesNotMatch(text, /Unknown tool/);
			assert.doesNotThrow(() => JSON.parse(text));
		}
	});

	it("rejects caller-supplied transport identity without echoing raw context", async () => {
		const { handleStateToolCall } = await stateServer();
		for (const field of ["source", "tracker", "attestation", "root_thread_id", "tool_event_ref", "prompt", "raw_context"]) {
			const sentinel = `secret-${field}`;
			const response = await handleStateToolCall({
				params: { name: "review_get", arguments: { workingDirectory: process.cwd(), [field]: sentinel } },
			});
			const text = response.content[0]?.text ?? "";
			assert.equal(response.isError, true);
			assert.doesNotMatch(text, new RegExp(sentinel));
			const payload = JSON.parse(text) as { code?: string };
			assert.equal(payload.code, "INVALID_INVOCATION");
		}
	});

	it("returns only a pending proposal for a fresh MCP RESULT", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-mcp-"));
		const coordinator = await seedRunningArchitect(workingDirectory);
		const { handleStateToolCall } = await stateServer();
		const response = await handleStateToolCall({
			params: {
				name: "review_record_lane",
				arguments: {
					workingDirectory, session_id: "session-1", event: "RESULT", review_id: REVIEW_ID,
					attempt: 1, lane_id: "architect-global", scope_hash: HASH,
					result: architectResult(), idempotency_key: RESULT_KEY,
				},
			},
		});
		assert.equal(response.isError, undefined);
		const proposal = JSON.parse(response.content[0]?.text ?? "") as { state?: string };
		assert.equal(proposal.state, "PENDING_HOST_ATTESTATION");
		assert.equal((await coordinator.get(REVIEW_ID)).lanes.find((lane) => lane.lane_id === "architect-global")?.status, "RUNNING");
	});

	it("loads START identity from the hook-owned tracker instead of caller fields", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-start-"));
		const coordinator = await seedRunningArchitect(workingDirectory);
		let tracking = createSubagentTrackingState();
		tracking = recordSubagentTurn(tracking, {
			sessionId: "session-1", threadId: "root-1", leaderThreadId: "root-1", kind: "leader",
			timestamp: "2026-07-14T00:00:00.000Z",
		});
		tracking = recordSubagentTurn(tracking, {
			sessionId: "session-1", threadId: "child-reviewer", leaderThreadId: "root-1", kind: "subagent",
			laneId: "reviewer-batch-1", role: "code-reviewer", timestamp: "2026-07-14T00:00:00.000Z",
		});
		await writeSubagentTrackingState(workingDirectory, tracking);
		const { handleStateToolCall } = await stateServer();
		const response = await handleStateToolCall({ params: {
			name: "review_record_lane",
			arguments: {
				workingDirectory, session_id: "session-1", event: "START", review_id: REVIEW_ID,
				attempt: 1, lane_id: "reviewer-batch-1", thread_id: "child-reviewer",
				idempotency_key: "10000000-0000-4000-8000-000000000005",
			},
		} });
		assert.equal(response.isError, undefined, response.content[0]?.text);
		assert.equal((await coordinator.get(REVIEW_ID)).lanes.find((lane) => lane.lane_id === "reviewer-batch-1")?.status, "RUNNING");
	});

	it("replays review_start with the same key instead of creating another active review", async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), "omx-state-review-start-replay-"));
		execFileSync("git", ["init", "-q"], { cwd: workingDirectory });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workingDirectory });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: workingDirectory });
		await writeFile(join(workingDirectory, "a.ts"), "export const value = 1;\n");
		execFileSync("git", ["add", "a.ts"], { cwd: workingDirectory });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: workingDirectory });
		await writeFile(join(workingDirectory, "a.ts"), "export const value = 2;\n");
		const { handleStateToolCall } = await stateServer();
		const request = {
			params: { name: "review_start", arguments: {
				workingDirectory, session_id: "session-1", invocation: [],
				idempotency_key: "10000000-0000-4000-8000-000000000006",
			} },
		};
		const first = await handleStateToolCall(request);
		const replay = await handleStateToolCall(request);
		assert.equal(first.isError, undefined, first.content[0]?.text);
		assert.equal(replay.isError, undefined, replay.content[0]?.text);
		assert.deepEqual(JSON.parse(replay.content[0]?.text ?? ""), JSON.parse(first.content[0]?.text ?? ""));
	});
});
