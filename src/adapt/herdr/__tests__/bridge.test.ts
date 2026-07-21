import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HerdrBridge } from "../bridge.js";
import type {
	HerdrAgentReport,
	HerdrReleaseReport,
	HerdrTransport,
	HerdrTransportResult,
} from "../transport.js";

interface RecordedCall {
	op: "report" | "release";
	state?: string;
	seq: number;
}

class RecordingTransport implements HerdrTransport {
	readonly kind = "cli" as const;
	calls: RecordedCall[] = [];
	failReport = false;
	throwOnReport = false;

	async reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult> {
		if (this.throwOnReport) throw new Error("boom");
		this.calls.push({ op: "report", state: report.state, seq: report.seq });
		return this.failReport
			? { ok: false, transport: "cli", detail: "failed", error: "nope" }
			: { ok: true, transport: "cli", detail: "ok" };
	}

	async releaseAgent(report: HerdrReleaseReport): Promise<HerdrTransportResult> {
		this.calls.push({ op: "release", seq: report.seq });
		return { ok: true, transport: "cli", detail: "ok" };
	}
}

const HERDR_ENV = {
	enabled: true,
	paneId: "w1:p1",
	socketPath: null,
	binPath: null,
};

describe("HerdrBridge opt-in gate", () => {
	it("is a no-op when not inside a Herdr pane", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({
			env: { enabled: false, paneId: null, socketPath: null, binPath: null },
			transport,
		});
		assert.equal(bridge.enabled, false);
		const outcome = await bridge.reportState("working");
		assert.equal(outcome.skipped, true);
		assert.equal(outcome.reason, "herdr-not-detected");
		const evented = await bridge.reportHookEvent("finished");
		assert.equal(evented.skipped, true);
		const released = await bridge.release();
		assert.equal(released.skipped, true);
		assert.equal(transport.calls.length, 0);
	});
});

describe("HerdrBridge monotonic seq ordering", () => {
	it("uses a single monotonic seq shared across report and release", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		await bridge.reportState("working");
		await bridge.reportState("blocked");
		await bridge.reportState("working");
		await bridge.release();
		const seqs = transport.calls.map((c) => c.seq);
		assert.deepEqual(seqs, [1, 2, 3, 4]);
		// strictly increasing so stale reports cannot win at the pane
		for (let i = 1; i < seqs.length; i += 1) {
			assert.ok(seqs[i] > seqs[i - 1]);
		}
		assert.equal(transport.calls.at(-1)?.op, "release");
	});
});

describe("HerdrBridge hook-event reporting", () => {
	it("maps and reports a working event without release", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		const outcome = await bridge.reportHookEvent("session-start");
		assert.equal(outcome.state, "working");
		assert.equal(transport.calls.length, 1);
		assert.equal(transport.calls[0].op, "report");
	});

	it("reports idle and releases authority on a terminal event", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		const outcome = await bridge.reportHookEvent("finished");
		assert.equal(outcome.state, "idle");
		assert.equal(outcome.released, true);
		assert.deepEqual(
			transport.calls.map((c) => c.op),
			["report", "release"],
		);
		// release seq is greater than the report seq
		assert.ok(transport.calls[1].seq > transport.calls[0].seq);
	});

	it("reports an authoritative team rollup state", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		const outcome = await bridge.reportTeamRollup({
			leaderBlockedOnUser: true,
			workers: [{ id: "w1", state: "working" }],
		});
		assert.equal(outcome.state, "blocked");
		assert.equal(transport.calls[0].state, "blocked");
	});
});

describe("HerdrBridge release idempotence", () => {
	it("releases at most once", async () => {
		const transport = new RecordingTransport();
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		const first = await bridge.release();
		const second = await bridge.release();
		assert.equal(first.released, true);
		assert.equal(second.skipped, true);
		assert.equal(second.reason, "already-released");
		assert.equal(transport.calls.filter((c) => c.op === "release").length, 1);
	});
});

describe("HerdrBridge failure isolation", () => {
	it("returns a failed outcome when the transport reports failure", async () => {
		const transport = new RecordingTransport();
		transport.failReport = true;
		const bridge = new HerdrBridge({ env: HERDR_ENV, transport });
		const outcome = await bridge.reportState("working");
		assert.equal(outcome.attempted, true);
		assert.equal(outcome.ok, false);
	});

	it("never throws when the transport throws", async () => {
		const transport = new RecordingTransport();
		transport.throwOnReport = true;
		let loggerCalled = false;
		const bridge = new HerdrBridge({
			env: HERDR_ENV,
			transport,
			logger: () => {
				loggerCalled = true;
			},
		});
		const outcome = await bridge.reportState("working");
		assert.equal(outcome.ok, false);
		assert.match(outcome.reason, /threw/);
		assert.equal(loggerCalled, true);
	});
});
