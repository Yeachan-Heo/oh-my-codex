import assert from "node:assert/strict";
import { execPath } from "node:process";
import { describe, it } from "node:test";
import {
	CliHerdrTransport,
	SocketHerdrTransport,
	buildReleaseAgentArgs,
	buildReportAgentArgs,
	detectHerdrEnv,
	resolveTrustedHerdrBin,
	type SocketRequest,
	type SocketResponse,
} from "../transport.js";

describe("herdr env detection", () => {
	it("is enabled only when HERDR_ENV=1 and a pane id are present", () => {
		assert.equal(
			detectHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }).enabled,
			true,
		);
		assert.equal(detectHerdrEnv({ HERDR_PANE_ID: "w1:p1" }).enabled, false);
		assert.equal(detectHerdrEnv({ HERDR_ENV: "1" }).enabled, false);
		assert.equal(
			detectHerdrEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "  " }).enabled,
			false,
		);
	});
});

describe("herdr CLI argv builders", () => {
	it("builds shell-free, ordered report-agent argv with seq", () => {
		assert.deepEqual(
			buildReportAgentArgs({
				paneId: "w1:p1",
				source: "omx:runtime",
				agent: "codex",
				state: "working",
				message: "team: 3 workers active",
				seq: 7,
			}),
			[
				"pane", "report-agent", "w1:p1", "--source", "omx:runtime",
				"--agent", "codex", "--state", "working", "--seq", "7",
				"--message", "team: 3 workers active",
			],
		);
	});

	it("keeps injection-prone text as one argv token and omits empty message", () => {
		const args = buildReportAgentArgs({
			paneId: "w1:p1; rm -rf /",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		assert.equal(args[2], "w1:p1; rm -rf /");
		assert.ok(!args.includes("--message"));
	});

	it("builds release-agent argv with seq", () => {
		assert.deepEqual(
			buildReleaseAgentArgs({ paneId: "w1:p1", source: "omx:runtime", seq: 9 }),
			["pane", "release-agent", "w1:p1", "--source", "omx:runtime", "--seq", "9"],
		);
	});
});

describe("trust-pinned CLI resolution", () => {
	it("accepts only an absolute existing file", () => {
		assert.equal(resolveTrustedHerdrBin(execPath), execPath); // node binary is absolute+exists
		assert.equal(resolveTrustedHerdrBin("herdr"), null); // bare PATH name rejected
		assert.equal(resolveTrustedHerdrBin("/nonexistent/herdr"), null);
		assert.equal(resolveTrustedHerdrBin(undefined), null);
	});

	it("does not execFile when no trusted binary is available", async () => {
		let called = false;
		const transport = new CliHerdrTransport({
			binPath: "herdr",
			execFileFn: (_f, _a, cb) => {
				called = true;
				cb(null);
			},
		});
		assert.equal(transport.available, false);
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "working",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.equal(called, false);
		assert.match(result.error ?? "", /trust-pinned/);
	});

	it("invokes execFile with a trusted absolute binary", async () => {
		const calls: string[][] = [];
		const transport = new CliHerdrTransport({
			binPath: execPath,
			execFileFn: (_f, args, cb) => {
				calls.push(args);
				cb(null);
			},
		});
		assert.equal(transport.available, true);
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "working",
			seq: 1,
		});
		assert.equal(result.ok, true);
		assert.equal(calls[0][1], "report-agent");
	});
});

describe("SocketHerdrTransport request/response correlation", () => {
	function transportWith(
		exchange: (path: string, req: SocketRequest) => Promise<SocketResponse>,
	) {
		return new SocketHerdrTransport({ socketPath: "/tmp/h.sock", exchange });
	}

	it("reports ok only on a correlated success reply and sends dot-notation + seq", async () => {
		const seen: SocketRequest[] = [];
		const transport = transportWith(async (_p, req) => {
			seen.push(req);
			return { id: req.id, result: { type: "pane_info" } };
		});
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "blocked",
			message: "needs input",
			seq: 4,
			metadata: { summary: "review" },
		});
		assert.equal(result.ok, true);
		assert.equal(seen[0].method, "pane.report_agent");
		assert.equal(seen[0].params.seq, 4);
		assert.equal(seen[0].params.message, "needs input");
		assert.deepEqual(seen[0].params.tokens, { summary: "review" });
	});

	it("reports NOT ok when Herdr returns an error reply", async () => {
		const transport = transportWith(async (_p, req) => ({
			id: req.id,
			error: { code: "not_found", message: "pane not found" },
		}));
		const result = await transport.releaseAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			seq: 5,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /pane not found/);
	});

	it("reports NOT ok on id mismatch", async () => {
		const transport = transportWith(async () => ({
			id: "someone-else",
			result: {},
		}));
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.detail, /mismatch/);
	});

	it("captures exchange errors (timeout/backpressure) without throwing", async () => {
		const transport = transportWith(async () => {
			throw new Error("herdr socket timeout");
		});
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /timeout/);
	});
});
