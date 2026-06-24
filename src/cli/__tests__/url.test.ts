import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseUrlReadArgs, urlCommand } from "../url.js";

function runOmx(cwd: string, argv: string[]) {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	const omxBin = join(repoRoot, "dist", "cli", "omx.js");
	return spawnSync(process.execPath, [omxBin, ...argv], {
		cwd,
		encoding: "utf-8",
		env: {
			...process.env,
			OMX_AUTO_UPDATE: "0",
			OMX_NOTIFY_FALLBACK: "0",
			OMX_HOOK_DERIVED_SIGNALS: "0",
		},
	});
}

describe("omx url", () => {
	it("documents passive URL reader in top-level and nested help", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omx-url-help-"));
		try {
			const mainHelp = runOmx(cwd, ["--help"]);
			assert.equal(mainHelp.status, 0, mainHelp.stderr || mainHelp.stdout);
			assert.match(
				mainHelp.stdout,
				/omx url\s+Passive URL reader \(read <url> --json\)/i,
			);

			const urlHelp = runOmx(cwd, ["url", "--help"]);
			assert.equal(urlHelp.status, 0, urlHelp.stderr || urlHelp.stdout);
			assert.match(urlHelp.stdout, /Usage:\s*\n\s*omx url read <url> --json/i);
			assert.match(
				urlHelp.stdout,
				/does not bypass challenges, use a browser, inject cookies/i,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("requires explicit JSON output for passive reads", () => {
		assert.throws(
			() => parseUrlReadArgs(["http://example.test/"]),
			/Missing required --json flag/,
		);
		assert.deepEqual(parseUrlReadArgs(["http://example.test/", "--json"]), {
			url: "http://example.test/",
			json: true,
		});
	});

	it("prints structured JSON from an injected fetch implementation", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (message?: unknown) => {
			logs.push(String(message));
		};
		try {
			await urlCommand(["read", "http://example.test/", "--json"], {
				resolveHostname: async () => ["93.184.216.34"],
				fetch: async () => ({
					status: 200,
					statusText: "OK",
					url: "http://example.test/",
					redirected: false,
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									"<title>Example</title><body>Hello</body>",
								),
							);
							controller.close();
						},
					}),
					headers: {
						get: (name: string) =>
							name.toLowerCase() === "content-type" ? "text/html" : null,
					},
				}),
			});
		} finally {
			console.log = originalLog;
		}

		const parsed = JSON.parse(logs.join("\n"));
		assert.equal(parsed.verdict, "ok");
		assert.equal(parsed.title, "Example");
		assert.equal(parsed.error, null);
	});
});
