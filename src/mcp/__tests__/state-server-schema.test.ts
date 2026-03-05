import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("state-server schema validation", () => {
	it("exposes only state_* tool schemas after team MCP hard-deprecation", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerTools } = await import("../state-server.js");

		const tools = buildStateServerTools();
		const names = tools.map((tool: { name: string }) => tool.name).sort();

		assert.deepEqual(names, [
			"state_clear",
			"state_get_status",
			"state_list_active",
			"state_read",
			"state_write",
		]);

		assert.equal(
			tools.some((tool: { name: string }) => tool.name.startsWith("team_")),
			false,
		);
	});
});
