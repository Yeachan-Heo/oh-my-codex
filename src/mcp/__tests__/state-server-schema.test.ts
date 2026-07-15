import { describe, it } from "node:test";
import assert from "node:assert/strict";

type StateServerToolSchema = {
	name: string;
	inputSchema?: { properties?: { mode?: { enum?: string[] } } };
};

describe("state-server schema validation", () => {
	it("exposes the exact state_* and review_* tool schemas after team MCP hard-deprecation", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerTools } = await import("../state-server.js");

		const tools = buildStateServerTools() as StateServerToolSchema[];
		const names = tools.map((tool: { name: string }) => tool.name).sort();

		// ASSERTION-CHANGE-JUSTIFIED: Task 6 adds the five review_* tools while preserving the exact state_* set and excluding deprecated team_* tools.
		assert.deepEqual(names, [
			"review_finalize",
			"review_get",
			"review_record_lane",
			"review_resume",
			"review_start",
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

	it("includes deep-interview anywhere mode enums are exposed", async () => {
		process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = "1";
		const { buildStateServerTools } = await import("../state-server.js");

		const tools = buildStateServerTools() as StateServerToolSchema[];
		const toolsWithModeEnum = tools.filter(
			(tool: {
				inputSchema?: { properties?: { mode?: { enum?: string[] } } };
			}) => Array.isArray(tool.inputSchema?.properties?.mode?.enum),
		);

		assert.ok(toolsWithModeEnum.length > 0);
		for (const tool of toolsWithModeEnum) {
			assert.ok(
				tool.inputSchema?.properties?.mode?.enum?.includes("deep-interview"),
			);
		}
	});
});
