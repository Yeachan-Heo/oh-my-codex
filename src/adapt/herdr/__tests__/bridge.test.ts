import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
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
	message?: string;
}

class RecordingTransport implements HerdrTransport {
	readonly kind = "cli" as const;
	calls: RecordedCall[] = [];
	failReport = false;
	throwOnReport = false;

	async reportAgent(report: HerdrAgentReport): Promise<HerdrTransportResult> {
		if (this.throwOnReport) throw new Error("boom");
		this.calls.push({
			op: "report",
			state: report.state,
			seq: report.seq,
			message: report.message,
		});
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

let baseDir: string;
// Deterministic injected seq so tests do not depend on the durable fs store.
function makeSeqFn() {
	let n = 0;
	return () => {
		n += 1;
		return n;
	};
}

beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), "omx-herdr-bridge-"));
});
afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

function bridge(transport: RecordingTransport, extra = {}) {
	return new HerdrBridge({
		env: HERDR_ENV,
		transport,
		seqFn: makeSeqFn(),
		stateBaseDir: baseDir,
		...extra,
	});
}

describe("HerdrBridge opt-in gate", () => {
	it("is a no-op when not inside a Herdr pane", async () => {
		const transport = new RecordingTransport();
		const b = new HerdrBridge({
			env: { enabled: false, paneId: null, socketPath: null, binPath: null },
			transport,
			seqFn: makeSeqFn(),
			stateBaseDir: baseDir,
		});
		assert.equal(b.enabled, false);
		assert.equal((await b.reportState("working")).skipped, true);
		assert.equal((await b.reportHookEvent("stop")).skipped, true);
		assert.equal((await b.release()).skipped, true);
		assert.equal(transport.calls.length, 0);
	});
});

describe("HerdrBridge monotonic seq ordering", () => {
	it("uses a single monotonic seq shared across report and release", async () => {
		const transport = new RecordingTransport();
		const b = bridge(transport);
		await b.reportState("working");
		await b.reportState("blocked");
		await b.reportState("working");
		await b.release();
		const seqs = transport.calls.map((c) => c.seq);
		assert.deepEqual(seqs, [1, 2, 3, 4]);
		for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i] > seqs[i - 1]);
		assert.equal(transport.calls.at(-1)?.op, "release");
	});
});

describe("HerdrBridge hook-event reporting", () => {
	it("maps and reports a working event without release", async () => {
		const transport = new RecordingTransport();
		const outcome = await bridge(transport).reportHookEvent("session-start");
		assert.equal(outcome.state, "working");
		assert.equal(transport.calls.length, 1);
		assert.equal(transport.calls[0].op, "report");
	});

	it("reports idle on a per-run finish WITHOUT releasing authority", async () => {
		const transport = new RecordingTransport();
		const outcome = await bridge(transport).reportHookEvent("finished");
		assert.equal(outcome.state, "idle");
		assert.deepEqual(
			transport.calls.map((c) => c.op),
			["report"],
		);
	});

	it("reports idle and releases authority on whole-session shutdown", async () => {
		const transport = new RecordingTransport();
		const outcome = await bridge(transport).reportHookEvent("session-end");
		assert.equal(outcome.state, "idle");
		assert.equal(outcome.released, true);
		assert.deepEqual(
			transport.calls.map((c) => c.op),
			["report", "release"],
		);
		assert.ok(transport.calls[1].seq > transport.calls[0].seq);
	});

	it("reports an authoritative team rollup state", async () => {
		const transport = new RecordingTransport();
		const outcome = await bridge(transport).reportTeamRollup({
			leaderBlockedOnUser: true,
			workers: [{ id: "w1", state: "working" }],
		});
		assert.equal(outcome.state, "blocked");
		assert.equal(transport.calls[0].state, "blocked");
	});
});

describe("HerdrBridge release gating", () => {
	it("suppresses release while another workflow is active", async () => {
		const transport = new RecordingTransport();
		const b = bridge(transport, { workflowActiveFn: () => true });
		const outcome = await b.release();
		assert.equal(outcome.skipped, true);
		assert.equal(outcome.reason, "workflow-still-active");
		assert.equal(transport.calls.filter((c) => c.op === "release").length, 0);
	});

	it("releases at most once", async () => {
		const transport = new RecordingTransport();
		const b = bridge(transport);
		const first = await b.release();
		const second = await b.release();
		assert.equal(first.released, true);
		assert.equal(second.skipped, true);
		assert.equal(second.reason, "already-released");
		assert.equal(transport.calls.filter((c) => c.op === "release").length, 1);
	});
});

describe("HerdrBridge metadata sanitization", () => {
	it("bounds and redacts the message before it hits the transport", async () => {
		const transport = new RecordingTransport();
		await bridge(transport).reportState("working", {
			message: "token=sk-abcdefgh12345678 running at /home/user/secret/app.ts",
		});
		const sent = transport.calls[0].message ?? "";
		assert.ok(!sent.includes("sk-abcdefgh12345678"));
	});
});

describe("HerdrBridge failure isolation", () => {
	it("returns a failed outcome when the transport reports failure", async () => {
		const transport = new RecordingTransport();
		transport.failReport = true;
		const outcome = await bridge(transport).reportState("working");
		assert.equal(outcome.attempted, true);
		assert.equal(outcome.ok, false);
	});

	it("never throws when the transport throws", async () => {
		const transport = new RecordingTransport();
		transport.throwOnReport = true;
		let logged = false;
		const b = bridge(transport, {
			logger: () => {
				logged = true;
			},
		});
		const outcome = await b.reportState("working");
		assert.equal(outcome.ok, false);
		assert.match(outcome.reason, /threw/);
		assert.equal(logged, true);
	});
});
