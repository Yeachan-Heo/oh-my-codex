import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkExploreHarness } from "../doctor.js";

describe("doctor deprecated explore harness UX", () => {
	it("reports OK on Windows when deprecated explore routing is disabled by default", () => {
		const check = checkExploreHarness("win32", {} as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "pass");
		assert.match(check.message, /omx explore is hard-deprecated/i);
		assert.match(check.message, /explore routing is disabled by default/i);
		assert.match(check.message, /omx sparkshell/i);
		assert.doesNotMatch(check.message, /not ready on Windows/i);
	});

	it("preserves the Windows warning when explore routing is explicitly enabled", () => {
		const check = checkExploreHarness("win32", {
			USE_OMX_EXPLORE_CMD: "1",
		} as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "warn");
		assert.match(check.message, /not ready on Windows/i);
		assert.match(check.message, /OMX_EXPLORE_BIN/);
		assert.match(check.message, /omx sparkshell/i);
	});

	it("preserves explicit custom harness override diagnostics", () => {
		const check = checkExploreHarness("win32", {
			OMX_EXPLORE_BIN: "missing-custom-harness.exe",
		} as NodeJS.ProcessEnv);

		assert.equal(check.name, "Explore Harness");
		assert.equal(check.status, "warn");
		assert.match(check.message, /OMX_EXPLORE_BIN is set but path was not found/);
	});
});
