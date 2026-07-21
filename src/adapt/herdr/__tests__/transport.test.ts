import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CliHerdrTransport,
	SocketHerdrTransport,
	buildReleaseAgentArgs,
	buildReportAgentArgs,
	detectHerdrEnv,
	type SocketRequest,
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

	it("captures socket and bin paths", () => {
		const env = detectHerdrEnv({
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
			HERDR_BIN_PATH: "/usr/bin/herdr",
		});
		assert.equal(env.paneId, "w1:p1");
		assert.equal(env.socketPath, "/tmp/herdr.sock");
		assert.equal(env.binPath, "/usr/bin/herdr");
	});
});

describe("herdr CLI argv builders", () => {
	it("builds shell-free, ordered report-agent argv with seq", () => {
		const args = buildReportAgentArgs({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "working",
			message: "team: 3 workers active",
			seq: 7,
		});
		assert.deepEqual(args, [
			"pane",
			"report-agent",
			"w1:p1",
			"--source",
			"omx:runtime",
			"--agent",
			"codex",
			"--state",
			"working",
			"--seq",
			"7",
			"--message",
			"team: 3 workers active",
		]);
	});

	it("omits an empty message and keeps injection-prone text as one argv token", () => {
		const args = buildReportAgentArgs({
			paneId: "w1:p1; rm -rf /",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		// The dangerous pane id stays a single argv element; execFile never shells.
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

describe("CliHerdrTransport", () => {
	it("invokes the injected execFile with the herdr binary and reports ok", async () => {
		const calls: Array<{ file: string; args: string[] }> = [];
		const transport = new CliHerdrTransport({
			binPath: "/opt/herdr",
			execFileFn: (file, args, cb) => {
				calls.push({ file, args });
				cb(null);
			},
		});
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "working",
			seq: 1,
		});
		assert.equal(result.ok, true);
		assert.equal(calls[0].file, "/opt/herdr");
		assert.equal(calls[0].args[1], "report-agent");
	});

	it("captures execFile errors without throwing", async () => {
		const transport = new CliHerdrTransport({
			execFileFn: (_file, _args, cb) => cb(new Error("herdr not found")),
		});
		const result = await transport.releaseAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /herdr not found/);
	});
});

describe("SocketHerdrTransport", () => {
	it("writes dot-notation NDJSON requests with seq", async () => {
		const requests: SocketRequest[] = [];
		const transport = new SocketHerdrTransport({
			socketPath: "/tmp/herdr.sock",
			writer: async (_path, request) => {
				requests.push(request);
			},
		});
		await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "blocked",
			message: "needs input",
			seq: 4,
		});
		await transport.releaseAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			seq: 5,
		});
		assert.equal(requests[0].method, "pane.report_agent");
		assert.deepEqual(requests[0].params, {
			pane_id: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "blocked",
			seq: 4,
			message: "needs input",
		});
		assert.equal(requests[1].method, "pane.release_agent");
		assert.equal(requests[1].params.seq, 5);
	});

	it("captures writer errors without throwing", async () => {
		const transport = new SocketHerdrTransport({
			socketPath: "/tmp/herdr.sock",
			writer: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /ECONNREFUSED/);
	});
});
