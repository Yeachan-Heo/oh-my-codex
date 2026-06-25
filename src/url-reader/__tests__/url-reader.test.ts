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
		const result = await readUrl("http://example.test/page", {
			resolveHostname: publicResolver,
			fetch: async () =>
				response({
					url: "http://example.test/page",
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
		const result = await readUrl("http://example.test/protected", {
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
		const result = await readUrl("http://example.test/fail", {
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
		const result = await readUrl("http://example.test/start", {
			resolveHostname: publicResolver,
			fetch: async () =>
				response({
					url: "http://example.test/final",
					redirected: true,
					bodyText: "<title>Final</title><body>Final content</body>",
				}),
		});

		assert.equal(result.verdict, "redirect");
		assert.equal(result.redirected, true);
		assert.equal(result.final_url, "http://example.test/final");
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

		const result = await readUrl("http://example.test/large", {
			resolveHostname: publicResolver,
			maxBytes: 128,
			fetch: async () =>
				response({
					url: "http://example.test/large",
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

	it("blocks unsafe IPv6 literals before fetch", async () => {
		const unsafeUrls = [
			"http://[::]/secret",
			"http://[64:ff9b:1::10.0.0.1]/secret",
			"http://[100::1]/secret",
			"http://[100:0:0:1::1]/secret",
			"http://[2002:0a00:0001::1]/secret",
			"http://[3fff::1]/secret",
			"http://[5f00::1]/secret",
			"http://[fc00::1]/secret",
			"http://[fd12:3456:789a::1]/secret",
			"http://[fe80::1]/secret",
			"http://[ff02::1]/secret",
			"http://[::ffff:10.0.0.5]/secret",
			"http://[::ffff:127.0.0.1]/secret",
			"http://[::ffff:169.254.169.254]/secret",
		];

		for (const url of unsafeUrls) {
			let fetched = false;
			const result = await readUrl(url, {
				fetch: async () => {
					fetched = true;
					return response({});
				},
			});

			assert.equal(result.verdict, "blocked", url);
			assert.ok(result.signals.includes("unsafe-address"), url);
			assert.equal(fetched, false, url);
		}
	});

	it("allows public IPv6 literals", async () => {
		const result = await readUrl("http://[2606:4700:4700::1111]/", {
			fetch: async () => response({ url: "http://[2606:4700:4700::1111]/" }),
		});

		assert.equal(result.verdict, "ok");
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
		const result = await readUrl("http://internal.example.test/", {
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

	it("blocks hostnames that resolve to unsafe IPv6 addresses", async () => {
		const unsafeAddresses = [
			"64:ff9b:1::10.0.0.1",
			"100::1",
			"100:0:0:1::1",
			"2002:0a00:0001::1",
			"3fff::1",
			"5f00::1",
			"fc00::1",
			"fd12:3456:789a::1",
			"fe80::1",
			"ff02::1",
		];

		for (const address of unsafeAddresses) {
			let fetched = false;
			const result = await readUrl("http://internal-v6.example.test/", {
				resolveHostname: async () => [address],
				fetch: async () => {
					fetched = true;
					return response({});
				},
			});

			assert.equal(result.verdict, "blocked", address);
			assert.ok(result.signals.includes("unsafe-address"), address);
			assert.equal(fetched, false, address);
		}
	});


	it("pins HTTP hostname fetches to the resolved public address and preserves Host", async () => {
		const fetched: Array<{ url: string; host: string | undefined }> = [];
		const result = await readUrl("http://example.test:8080/page", {
			resolveHostname: async () => ["93.184.216.34"],
			fetch: async (url, init) => {
				fetched.push({
					url,
					host: (init?.headers as Record<string, string> | undefined)?.host,
				});
				return response({
					url: "http://example.test:8080/page",
					bodyText: "<title>Pinned</title>",
				});
			},
		});

		assert.equal(result.verdict, "ok");
		assert.deepEqual(fetched, [
			{ url: "http://93.184.216.34:8080/page", host: "example.test:8080" },
		]);
	});

	it("prevents DNS rebinding by never fetching the original HTTP hostname", async () => {
		let resolveCount = 0;
		const fetched: string[] = [];
		const result = await readUrl("http://rebind.example.test/path", {
			resolveHostname: async () => {
				resolveCount += 1;
				return resolveCount === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
			},
			fetch: async (url) => {
				fetched.push(url);
				assert.notEqual(new URL(url).hostname, "rebind.example.test");
				return response({ url: "http://rebind.example.test/path", bodyText: "safe" });
			},
		});

		assert.equal(result.verdict, "ok");
		assert.equal(resolveCount, 1);
		assert.deepEqual(fetched, ["http://93.184.216.34/path"]);
	});

	it("pins redirect HTTP hostname fetches to the resolved public address", async () => {
		const fetched: string[] = [];
		const result = await readUrl("http://example.test/start", {
			resolveHostname: async (hostname) =>
				hostname === "redirect.example.test" ? ["93.184.216.35"] : ["93.184.216.34"],
			fetch: async (url) => {
				fetched.push(url);
				if (fetched.length === 1) {
					return response({
						status: 302,
						statusText: "Found",
						url,
						headers: {
							get: (name: string) =>
								name.toLowerCase() === "location"
									? "http://redirect.example.test/final"
									: null,
						},
					});
				}
				return response({ url: "http://redirect.example.test/final", bodyText: "final" });
			},
		});

		assert.equal(result.verdict, "redirect");
		assert.deepEqual(fetched, [
			"http://93.184.216.34/start",
			"http://93.184.216.35/final",
		]);
	});

	it("blocks HTTPS hostname targets because this runtime cannot safely pin TLS/SNI", async () => {
		let fetched = false;
		const result = await readUrl("https://example.test/", {
			resolveHostname: async () => ["93.184.216.34"],
			fetch: async () => {
				fetched = true;
				return response({});
			},
		});

		assert.equal(result.verdict, "blocked");
		assert.ok(result.signals.includes("https-hostname-not-pinned"));
		assert.equal(fetched, false);
	});

	it("still allows direct public IP HTTPS targets", async () => {
		const fetched: string[] = [];
		const result = await readUrl("https://93.184.216.34/", {
			fetch: async (url) => {
				fetched.push(url);
				return response({ url, bodyText: "ip" });
			},
		});

		assert.equal(result.verdict, "ok");
		assert.deepEqual(fetched, ["https://93.184.216.34/"]);
	});

	it("blocks redirects to localhost before following", async () => {
		const fetched: string[] = [];
		const result = await readUrl("http://example.test/start", {
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
		assert.deepEqual(fetched, ["http://93.184.216.34/start"]);
	});

	it("blocks redirects to private targets before following", async () => {
		const fetched: string[] = [];
		const result = await readUrl("http://example.test/start", {
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
		assert.deepEqual(fetched, ["http://93.184.216.34/start"]);
	});

	it("blocks redirects to unsafe IPv6 literal targets before following", async () => {
		const redirectTargets = [
			"http://[64:ff9b:1::10.0.0.1]/secret",
			"http://[100::1]/secret",
			"http://[100:0:0:1::1]/secret",
			"http://[2002:0a00:0001::1]/secret",
			"http://[3fff::1]/secret",
			"http://[5f00::1]/secret",
			"http://[fc00::1]/secret",
			"http://[fe80::1]/secret",
			"http://[ff02::1]/secret",
		];

		for (const target of redirectTargets) {
			const fetched: string[] = [];
			const result = await readUrl("http://example.test/start", {
				resolveHostname: publicResolver,
				fetch: async (url) => {
					fetched.push(url);
					return response({
						status: 302,
						statusText: "Found",
						url,
						headers: {
							get: (name: string) =>
								name.toLowerCase() === "location" ? target : null,
						},
					});
				},
			});

			assert.equal(result.verdict, "blocked", target);
			assert.ok(result.signals.includes("unsafe-address"), target);
			assert.deepEqual(fetched, ["http://93.184.216.34/start"], target);
		}
	});

	it("blocks redirects to hostnames resolving to unsafe IPv6 before following", async () => {
		const unsafeAddresses = [
			"64:ff9b:1::10.0.0.1",
			"100::1",
			"100:0:0:1::1",
			"2002:0a00:0001::1",
			"3fff::1",
			"5f00::1",
			"fc00::1",
			"fe80::1",
			"ff02::1",
		];

		for (const address of unsafeAddresses) {
			const fetched: string[] = [];
			const result = await readUrl("http://example.test/start", {
				resolveHostname: async (hostname) =>
					hostname === "unsafe-v6.example.test" ? [address] : ["93.184.216.34"],
				fetch: async (url) => {
					fetched.push(url);
					return response({
						status: 302,
						statusText: "Found",
						url,
						headers: {
							get: (name: string) =>
								name.toLowerCase() === "location"
									? "http://unsafe-v6.example.test/secret"
									: null,
						},
					});
				},
			});

			assert.equal(result.verdict, "blocked", address);
			assert.ok(result.signals.includes("unsafe-address"), address);
			assert.deepEqual(fetched, ["http://93.184.216.34/start"], address);
		}
	});
});
