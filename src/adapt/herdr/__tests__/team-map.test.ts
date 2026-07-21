import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollupTeamState } from "../semantic.js";
import { mapTeamStateToRollup } from "../team-map.js";

describe("mapTeamStateToRollup", () => {
	it("maps leader attention to a user-blocking rollup", () => {
		const input = mapTeamStateToRollup({
			leaderAttentionPending: true,
			workers: [{ id: "w1", state: "working" }],
		});
		assert.equal(input.leaderBlockedOnUser, true);
		assert.equal(rollupTeamState(input).state, "blocked");
	});

	it("treats a system-blocked worker as non-user-blocking", () => {
		const input = mapTeamStateToRollup({
			workers: [
				{ id: "w1", state: "working" },
				{ id: "w2", state: "blocked", reason: "waiting on network" },
			],
		});
		assert.equal(rollupTeamState(input).state, "working");
	});

	it("treats a user-reason blocked worker as user-blocking", () => {
		const input = mapTeamStateToRollup({
			workers: [{ id: "w2", state: "blocked", reason: "needs user approval" }],
		});
		assert.equal(rollupTeamState(input).state, "blocked");
	});

	it("maps draining to working (still active)", () => {
		const input = mapTeamStateToRollup({
			workers: [{ id: "w1", state: "draining" }],
		});
		assert.equal(rollupTeamState(input).state, "working");
	});

	it("is idle when all workers are terminal", () => {
		const input = mapTeamStateToRollup({
			runTerminal: true,
			workers: [
				{ id: "w1", state: "done" },
				{ id: "w2", state: "failed" },
			],
		});
		assert.equal(rollupTeamState(input).state, "idle");
	});
});
