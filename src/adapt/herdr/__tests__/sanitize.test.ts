import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_MESSAGE_LEN,
	MAX_TOKENS,
	sanitizeMessage,
	sanitizeMetadata,
} from "../sanitize.js";

describe("sanitizeMessage", () => {
	it("collapses whitespace and returns undefined for empty", () => {
		assert.equal(sanitizeMessage("  a\n\t b "), "a b");
		assert.equal(sanitizeMessage(""), undefined);
		assert.equal(sanitizeMessage(undefined), undefined);
	});

	it("caps length", () => {
		const out = sanitizeMessage("x".repeat(500));
		assert.ok((out ?? "").length <= MAX_MESSAGE_LEN);
	});

	it("redacts secrets and absolute paths", () => {
		assert.equal(sanitizeMessage("bearer abcDEF12345 token"), "[redacted]");
		const pathed = sanitizeMessage("failed at /home/user/app/src/secret.ts now");
		assert.ok(!(pathed ?? "").includes("/home/user"));
		assert.ok((pathed ?? "").includes("[path]"));
	});
});

describe("sanitizeMetadata", () => {
	it("drops secret-like keys and values", () => {
		const out = sanitizeMetadata({
			summary: "review ready",
			authorization: "Bearer xyz",
			api_key: "abc",
			blob: "sk-abcdefgh12345678",
		});
		assert.deepEqual(Object.keys(out ?? {}).sort(), ["blob", "summary"]);
		assert.equal(out?.blob, "[redacted]");
		assert.equal(out?.summary, "review ready");
	});

	it("caps the number of tokens", () => {
		const many: Record<string, string> = {};
		for (let i = 0; i < 50; i += 1) many[`k${i}`] = `v${i}`;
		const out = sanitizeMetadata(many);
		assert.ok(Object.keys(out ?? {}).length <= MAX_TOKENS);
	});

	it("returns undefined when nothing survives", () => {
		assert.equal(sanitizeMetadata({ password: "x" }), undefined);
		assert.equal(sanitizeMetadata(undefined), undefined);
	});
});
