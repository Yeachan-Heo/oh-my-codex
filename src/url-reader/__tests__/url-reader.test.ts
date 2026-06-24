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
	const publicResolver = async () => ["93.184.216.34"];

	it("returns ok with title and snippet for reachable HTML", async () => {
		const result = await readUrl("https://example.test/page", {
			resolveHostname: publicResolver,
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
			resolveHostname: publicResolver,
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
			resolveHostname: publicResolver,
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
			resolveHostname: publicResolver,
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
			resolveHostname: publicResolver,
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

	it("rejects unsupported protocols with a blocked verdict", async () => {
		const result = await readUrl("file:///tmp/example");

		assert.equal(result.verdict, "blocked");
		assert.equal(result.error?.name, "UnsupportedProtocolError");
		assert.ok(result.signals.includes("unsupported-protocol"));
	});

	it("blocks localhost names before fetch", async () => {
		let fetched = false;
		const result = await readUrl("http://localhost/admin", {
			fetch: async () => {
				fetched = true;
				return response({});
			},
		});

		assert.equal(result.verdict, "blocked");
		assert.equal(result.error?.name, "UnsafeUrlError");
		assert.ok(result.signals.includes("localhost-name"));
		assert.equal(fetched, false);
	});

	it("blocks IPv4 loopback before fetch", async () => {
		const result = await readUrl("http://127.0.0.1:8080/secret", {
			fetch: async () => response({}),
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
	});

	it("blocks IPv6 loopback before fetch", async () => {
		const result = await readUrl("http://[::1]/secret", {
			fetch: async () => response({}),
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
	});

	it("blocks private IPv4 before fetch", async () => {
		const result = await readUrl("http://10.0.0.5/metadata", {
			fetch: async () => response({}),
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
	});

	it("blocks link-local IPv4 before fetch", async () => {
		const result = await readUrl("http://169.254.169.254/latest/meta-data/", {
			fetch: async () => response({}),
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
	});

	it("blocks hostnames that resolve to private addresses", async () => {
		let fetched = false;
		const result = await readUrl("https://internal.example.test/", {
			resolveHostname: async () => ["192.168.1.10"],
			fetch: async () => {
				fetched = true;
				return response({});
			},
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
		assert.equal(fetched, false);
	});

	it("blocks redirects to localhost before following", async () => {
		const fetched: string[] = [];
		const result = await readUrl("https://example.test/start", {
			resolveHostname: publicResolver,
			fetch: async (url) => {
				fetched.push(url);
				return response({
					status: 302,
					statusText: "Found",
					url,
					headers: {
						get: (name: string) =>
							name.toLowerCase() === "location" ? "http://localhost/secret" : null,
					},
				});
			},
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("localhost-name"));
		assert.deepEqual(fetched, ["https://example.test/start"]);
	});

	it("blocks redirects to private targets before following", async () => {
		const fetched: string[] = [];
		const result = await readUrl("https://example.test/start", {
			resolveHostname: async (hostname) =>
				hostname === "private.example.test" ? ["10.0.0.2"] : ["93.184.216.34"],
			fetch: async (url) => {
				fetched.push(url);
				return response({
					status: 302,
					statusText: "Found",
					url,
					headers: {
						get: (name: string) =>
							name.toLowerCase() === "location"
								? "http://private.example.test/secret"
								: null,
					},
				});
			},
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("unsafe-address"));
		assert.deepEqual(fetched, ["https://example.test/start"]);
	});
});
