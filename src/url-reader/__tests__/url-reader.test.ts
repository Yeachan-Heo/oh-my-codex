import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type FetchLikeResponse, readUrl } from "../index.js";

function streamFrom(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

function response(
	overrides: Partial<FetchLikeResponse> & { bodyText?: string },
): FetchLikeResponse {
	return {
		status: overrides.status ?? 200,
		statusText: overrides.statusText ?? "OK",
		url: overrides.url ?? "https://example.test/",
		redirected: overrides.redirected ?? false,
		body: overrides.body ?? streamFrom(overrides.bodyText ?? ""),
		headers: overrides.headers ?? {
			get: (name: string) =>
				name.toLowerCase() === "content-type"
					? "text/html; charset=utf-8"
					: null,
		},
	};
}

describe("readUrl", () => {
	it("returns ok with title and snippet for reachable HTML", async () => {
		const result = await readUrl("https://example.test/page", {
			fetch: async () =>
				response({
					url: "https://example.test/page",
					bodyText:
						"<html><head><title>Example &amp; Demo</title><script>ignore()</script></head><body><h1>Hello world</h1></body></html>",
				}),
		});

		assert.equal(result.verdict, "ok");
		assert.equal(result.status, 200);
		assert.equal(result.title, "Example & Demo");
		assert.match(result.snippet ?? "", /Hello world/);
		assert.doesNotMatch(result.snippet ?? "", /ignore/);
	});

	it("classifies challenge-like responses as blocked", async () => {
		const result = await readUrl("https://example.test/protected", {
			fetch: async () =>
				response({
					status: 403,
					statusText: "Forbidden",
					bodyText:
						"<title>Just a moment...</title><body>Verify you are human before continuing.</body>",
				}),
		});

		assert.equal(result.verdict, "blocked");
		assert.equal(result.status, 403);
		assert.ok(result.signals.includes("status-403"));
		assert.ok(result.signals.includes("just-a-moment-marker"));
		assert.ok(result.signals.includes("human-verification-marker"));
	});

	it("returns safe error details when fetch fails", async () => {
		const error = Object.assign(
			new Error("connection refused token=redacted"),
			{ code: "ECONNREFUSED" },
		);
		const result = await readUrl("https://example.test/fail", {
			fetch: async () => {
				throw error;
			},
		});

		assert.equal(result.verdict, "error");
		assert.equal(result.status, null);
		assert.equal(result.error?.name, "Error");
		assert.equal(result.error?.code, "ECONNREFUSED");
		assert.doesNotMatch(JSON.stringify(result.error), /stack/i);
	});

	it("reports redirects with final URL and readable metadata", async () => {
		const result = await readUrl("https://example.test/start", {
			fetch: async () =>
				response({
					url: "https://example.test/final",
					redirected: true,
					bodyText: "<title>Final</title><body>Final content</body>",
				}),
		});

		assert.equal(result.verdict, "redirect");
		assert.equal(result.redirected, true);
		assert.equal(result.final_url, "https://example.test/final");
		assert.equal(result.title, "Final");
	});

	it("caps streamed body reads before decoding", async () => {
		let cancelCalled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
			},
			cancel() {
				cancelCalled = true;
			},
		});

		const result = await readUrl("https://example.test/large", {
			maxBytes: 128,
			fetch: async () =>
				response({
					url: "https://example.test/large",
					body,
					bodyText: undefined,
				}),
		});

		assert.equal(result.verdict, "ok");
		assert.equal(result.truncated, true);
		assert.equal(result.bytes_read, 128);
		assert.equal(result.snippet?.length, 128);
		assert.equal(cancelCalled, true);
	});

	it("rejects unsupported protocols with an error verdict", async () => {
		const result = await readUrl("file:///tmp/example");

		assert.equal(result.verdict, "error");
		assert.equal(result.error?.name, "UnsupportedProtocolError");
	});
});
