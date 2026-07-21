import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SocketHerdrTransport } from "../transport.js";

let dir: string;
let servers: Server[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omx-herdr-sock-"));
	servers = [];
});
afterEach(async () => {
	for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
	await rm(dir, { recursive: true, force: true });
});

function listen(
	handler: (line: string, reply: (data: string) => void) => void,
): Promise<string> {
	const path = join(dir, `h-${servers.length}.sock`);
	const server = createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf-8");
			const nl = buf.indexOf("\n");
			if (nl !== -1) {
				const line = buf.slice(0, nl);
				handler(line, (data) => socket.write(data));
			}
		});
	});
	servers.push(server);
	return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

describe("SocketHerdrTransport live Unix-socket round-trip", () => {
	it("reports ok on a correlated success reply", async () => {
		const socketPath = await listen((line, reply) => {
			const req = JSON.parse(line);
			assert.equal(req.method, "pane.report_agent");
			assert.equal(req.params.seq, 3);
			reply(`${JSON.stringify({ id: req.id, result: { type: "pane_info" } })}\n`);
		});
		const transport = new SocketHerdrTransport({ socketPath, timeoutMs: 2000 });
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "working",
			seq: 3,
		});
		assert.equal(result.ok, true);
		assert.match(result.detail, /accepted/);
	});

	it("reports NOT ok when the server returns an error reply", async () => {
		const socketPath = await listen((line, reply) => {
			const req = JSON.parse(line);
			reply(`${JSON.stringify({ id: req.id, error: { message: "stale seq" } })}\n`);
		});
		const transport = new SocketHerdrTransport({ socketPath, timeoutMs: 2000 });
		const result = await transport.releaseAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /stale seq/);
	});

	it("reports NOT ok when the server never replies (timeout)", async () => {
		const socketPath = await listen(() => {
			/* swallow: never reply */
		});
		const transport = new SocketHerdrTransport({ socketPath, timeoutMs: 150 });
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

	it("reports NOT ok when the reply exceeds the max frame size", async () => {
		const socketPath = await listen((_line, reply) => {
			// Flood bytes with no newline to trip the bounded-frame guard.
			reply("x".repeat(5000));
		});
		const transport = new SocketHerdrTransport({
			socketPath,
			timeoutMs: 2000,
			maxFrameBytes: 1024,
		});
		const result = await transport.reportAgent({
			paneId: "w1:p1",
			source: "omx:runtime",
			agent: "codex",
			state: "idle",
			seq: 1,
		});
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /max frame/);
	});
});
