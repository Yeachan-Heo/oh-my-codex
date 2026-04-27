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
			mcpServeCommand(["unknown-entrypoint"], { env }),
			/Unknown MCP target: unknown-entrypoint/,
		);

		assert.equal(env[MCP_ENTRYPOINT_MARKER_ENV], undefined);
	});
});
