import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HERDR_SEMANTIC_STATES,
	isTerminalHookEvent,
	mapHookEventToHerdrState,
	rollupTeamState,
} from "../semantic.js";

describe("herdr semantic mapping", () => {
	it("maps active-work events to working", () => {
		for (const event of [
			"session-start",
			"run.heartbeat",
			"worker.assigned",
			"worker.recovered",
			"test-started",
			"pre-tool-use",
			"post-tool-use",
		]) {
			assert.equal(mapHookEventToHerdrState(event).state, "working", event);
		}
	});

	it("maps attention-required events to blocked", () => {
		for (const event of [
			"blocked",
			"run.blocked_on_user",
			"run.blocked_on_system",
			"needs-input",
			"handoff-needed",
		]) {
			assert.equal(mapHookEventToHerdrState(event).state, "blocked", event);
		}
	});

	it("maps terminal/resting events to idle", () => {
		for (const event of [
			"turn-complete",
			"finished",
			"failed",
			"stop",
			"session-end",
			"session-idle",
		]) {
			assert.equal(mapHookEventToHerdrState(event).state, "idle", event);
		}
	});

	it("maps unknown or unmapped events to unknown rather than guessing", () => {
		for (const event of ["worker.stalled", "retry-needed", "pr-created", "??"]) {
			assert.equal(mapHookEventToHerdrState(event).state, "unknown", event);
		}
	});

	it("only flags whole-session shutdown events as authority-terminal", () => {
		assert.equal(mapHookEventToHerdrState("stop").terminal, true);
		assert.equal(mapHookEventToHerdrState("session-end").terminal, true);
		// per-run outcomes map to idle but do NOT release authority
		assert.equal(mapHookEventToHerdrState("finished").terminal, false);
		assert.equal(mapHookEventToHerdrState("failed").terminal, false);
		assert.equal(mapHookEventToHerdrState("turn-complete").terminal, false);
		assert.equal(mapHookEventToHerdrState("session-idle").terminal, false);
		assert.equal(isTerminalHookEvent("stop"), true);
		assert.equal(isTerminalHookEvent("finished"), false);
	});

	it("accepts a hook envelope object", () => {
		const mapping = mapHookEventToHerdrState({
			schema_version: "1",
			event: "run.blocked_on_user",
			timestamp: new Date().toISOString(),
			source: "native",
			context: {},
		});
		assert.equal(mapping.state, "blocked");
	});

	it("exposes the four documented semantic states", () => {
		assert.deepEqual(
			[...HERDR_SEMANTIC_STATES],
			["working", "blocked", "idle", "unknown"],
		);
	});
});

describe("herdr team rollup", () => {
	it("escalates to blocked when the leader is blocked on user", () => {
		const result = rollupTeamState({
			leaderBlockedOnUser: true,
			workers: [{ id: "w1", state: "working" }],
		});
		assert.equal(result.state, "blocked");
	});

	it("escalates to blocked when a worker is blocked on user action", () => {
		const result = rollupTeamState({
			workers: [
				{ id: "w1", state: "working" },
				{ id: "w2", state: "blocked", blockedOnUser: true },
			],
		});
		assert.equal(result.state, "blocked");
		assert.equal(result.counts.blockedOnUser, 1);
	});

	it("does not escalate for a worker blocked on the system only", () => {
		const result = rollupTeamState({
			workers: [
				{ id: "w1", state: "working" },
				{ id: "w2", state: "blocked", blockedOnUser: false },
			],
		});
		assert.equal(result.state, "working");
		assert.equal(result.counts.blocked, 1);
		assert.equal(result.counts.blockedOnUser, 0);
	});

	it("is working while any worker is active", () => {
		const result = rollupTeamState({
			workers: [
				{ id: "w1", state: "done" },
				{ id: "w2", state: "working" },
			],
		});
		assert.equal(result.state, "working");
		assert.equal(result.counts.working, 1);
		assert.equal(result.counts.done, 1);
	});

	it("is idle when no worker is active or user-blocking", () => {
		const result = rollupTeamState({
			runTerminal: true,
			workers: [
				{ id: "w1", state: "done" },
				{ id: "w2", state: "failed" },
			],
		});
		assert.equal(result.state, "idle");
		assert.equal(result.counts.total, 2);
	});

	it("defaults a bare blocked worker to user-blocking", () => {
		const result = rollupTeamState({
			workers: [{ id: "w1", state: "blocked" }],
		});
		assert.equal(result.state, "blocked");
		assert.equal(result.counts.blockedOnUser, 1);
	});
});
