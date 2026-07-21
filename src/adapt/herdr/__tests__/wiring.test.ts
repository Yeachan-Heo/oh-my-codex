import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildNativeHookEvent } from "../../../hooks/extensibility/events.js";
import { reportHerdrLifecycleEvent } from "../wiring.js";
import type {
	HerdrAgentReport,
	HerdrReleaseReport,
	HerdrTransport,
	HerdrTransportResult,
} from "../transport.js";

class RecordingTransport implements HerdrTransport {
	readonly kind = "cli" as const;
	calls: Array<{ op: string; state?: string; seq: number }> = [];
	async reportAgent(r: HerdrAgentReport): Promise<HerdrTransportResult> {
		this.calls.push({ op: "report", state: r.state, seq: r.seq });
		return { ok: true, transport: "cli", detail: "ok" };
	}
	async releaseAgent(r: HerdrReleaseReport): Promise<HerdrTransportResult> {
		this.calls.push({ op: "release", seq: r.seq });
		return { ok: true, transport: "cli", detail: "ok" };
	}
}

let baseDir: string;
let seq: number;
beforeEach(async () => {
	baseDir = await mkdtemp(join(tmpdir(), "omx-herdr-wiring-"));
	seq = 0;
});
afterEach(async () => {
	await rm(baseDir, { recursive: true, force: true });
});

const enabledEnv = {
	enabled: true,
	paneId: "w1:p1",
	socketPath: null,
	binPath: null,
};

describe("reportHerdrLifecycleEvent", () => {
	it("is a no-op outside a Herdr pane", async () => {
		const transport = new RecordingTransport();
		const result = await reportHerdrLifecycleEvent({
			cwd: baseDir,
			event: buildNativeHookEvent("session-start"),
			bridgeOptions: {
				env: { enabled: false, paneId: null, socketPath: null, binPath: null },
				transport,
			},
		});
		assert.equal(result.wired, false);
		assert.equal(result.reason, "herdr-not-detected");
		assert.equal(transport.calls.length, 0);
	});

	it("reports a working transition for a working event", async () => {
		const transport = new RecordingTransport();
		const result = await reportHerdrLifecycleEvent({
			cwd: baseDir,
			event: buildNativeHookEvent("run.heartbeat"),
			bridgeOptions: {
				env: enabledEnv,
				transport,
				seqFn: () => ++seq,
				stateBaseDir: baseDir,
			},
		});
		assert.equal(result.wired, true);
		assert.equal(result.state, "working");
		assert.equal(transport.calls[0].op, "report");
	});

	it("reports blocked for a needs-input event", async () => {
		const transport = new RecordingTransport();
		const result = await reportHerdrLifecycleEvent({
			cwd: baseDir,
			event: buildNativeHookEvent("needs-input"),
			bridgeOptions: {
				env: enabledEnv,
				transport,
				seqFn: () => ++seq,
				stateBaseDir: baseDir,
			},
		});
		assert.equal(result.state, "blocked");
	});

	it("releases authority on whole-session shutdown", async () => {
		const transport = new RecordingTransport();
		const result = await reportHerdrLifecycleEvent({
			cwd: baseDir,
			event: buildNativeHookEvent("session-end"),
			bridgeOptions: {
				env: enabledEnv,
				transport,
				seqFn: () => ++seq,
				stateBaseDir: baseDir,
			},
		});
		assert.equal(result.state, "idle");
		assert.equal(result.released, true);
		assert.ok(transport.calls.some((c) => c.op === "release"));
	});

	it("never throws even if reporting fails internally", async () => {
		const throwing: HerdrTransport = {
			kind: "cli",
			reportAgent: async () => {
				throw new Error("kaboom");
			},
			releaseAgent: async () => ({ ok: true, transport: "cli", detail: "ok" }),
		};
		const result = await reportHerdrLifecycleEvent({
			cwd: baseDir,
			event: buildNativeHookEvent("run.heartbeat"),
			bridgeOptions: {
				env: enabledEnv,
				transport: throwing,
				seqFn: () => ++seq,
				stateBaseDir: baseDir,
			},
		});
		// The bridge captures the throw; wiring still returns wired:true with a failed report.
		assert.equal(result.wired, true);
	});
});
