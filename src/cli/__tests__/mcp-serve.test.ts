import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_ENTRYPOINT_MARKER_ENV } from "../../mcp/bootstrap.js";
import { mcpServeCommand } from "../mcp-serve.js";

describe("mcp-serve command", () => {
	it("passes the selected MCP entrypoint marker to bootstrap before loading the server module", async () => {
		const env: Record<string, string | undefined> = {};
		const loaded: string[] = [];

		await mcpServeCommand(["trace"], {
			env,
			keepProcessAlive: false,
			loaders: {
				"state-server.js": async () => {
					loaded.push("state-server.js");
				},
				"memory-server.js": async () => {
					loaded.push("memory-server.js");
				},
				"code-intel-server.js": async () => {
					loaded.push("code-intel-server.js");
				},
				"trace-server.js": async () => {
					loaded.push(env[MCP_ENTRYPOINT_MARKER_ENV] ?? "missing");
				},
				"wiki-server.js": async () => {
					loaded.push("wiki-server.js");
				},
			},
		});

		assert.equal(env[MCP_ENTRYPOINT_MARKER_ENV], "trace-server.js");
		assert.deepEqual(loaded, ["trace-server.js"]);
	});

	it("does not mutate the entrypoint marker when argument validation fails before target resolution", async () => {
		const env: Record<string, string | undefined> = {};

		await assert.rejects(
			mcpServeCommand(["unknown-entrypoint"], { env, keepProcessAlive: false }),
			/Unknown MCP target: unknown-entrypoint/,
		);

		assert.equal(env[MCP_ENTRYPOINT_MARKER_ENV], undefined);
	});

	it("keeps the stdio server process alive after loading the target module", async () => {
		const env: Record<string, string | undefined> = {};
		let loaded = false;
		let settled = false;

		const commandPromise = mcpServeCommand(["state"], {
			env,
			loaders: {
				"state-server.js": async () => {
					loaded = true;
				},
				"memory-server.js": async () => {},
				"code-intel-server.js": async () => {},
				"trace-server.js": async () => {},
				"wiki-server.js": async () => {},
			},
		});
		void commandPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(loaded, true);
		assert.equal(settled, false);
	});
});
