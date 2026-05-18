import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function runDispatcher(metadataPath: string): void {
	const dispatcherScript = join(process.cwd(), "dist", "scripts", "notify-dispatcher.js");
	const result = spawnSync(
		process.execPath,
		[dispatcherScript, "--metadata", metadataPath, JSON.stringify({ type: "test" })],
		{ encoding: "utf-8", windowsHide: true },
	);
	assert.equal(result.status, 0, result.stderr || result.stdout);
}

describe("notify dispatcher previousNotify guard", () => {
	it("skips stale OMX-managed previousNotify dispatcher entries", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-stale-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-previous-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(staleDispatcher, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [process.execPath, staleDispatcher, "--metadata", metadataPath],
					omxNotify: [process.execPath, omxHook],
					dispatcherNotify: [
						process.execPath,
						join(process.cwd(), "dist", "scripts", "notify-dispatcher.js"),
						"--metadata",
						metadataPath,
					],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips stale OMX-managed previousNotify dispatcher entries behind node flags", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-flagged-stale-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-previous-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(staleDispatcher, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						"--no-warnings",
						staleDispatcher,
						"--metadata",
						metadataPath,
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips stale turn-ended wrappers whose previousNotify is an OMX dispatcher", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-wrapper-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-wrapper-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const turnEndedWrapper = join(wd, "SkyComputerUseClient");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(
				turnEndedWrapper,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`,
			);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						turnEndedWrapper,
						"turn-ended",
						"--previous-notify",
						JSON.stringify([
							process.execPath,
							staleDispatcher,
							"--metadata",
							metadataPath,
						]),
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips stale turn-ended wrappers whose previousNotify text is an OMX hook", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-wrapper-text-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "stale-wrapper-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleHook = join(oldPkgScripts, "notify-hook.js");
			const turnEndedWrapper = join(wd, "SkyComputerUseClient");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(
				turnEndedWrapper,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`,
			);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						turnEndedWrapper,
						"turn-ended",
						`--previous-notify=node ${staleHook}`,
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips SkyComputerUseClient wrappers with quoted nested previousNotify self-references", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-nested-wrapper-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "nested-wrapper-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const turnEndedWrapper = join(wd, "SkyComputerUseClient");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(
				turnEndedWrapper,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`,
			);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			const nestedSelfReference = JSON.stringify([
				process.execPath,
				turnEndedWrapper,
				"turn-ended",
				"--previous-notify",
				JSON.stringify([process.execPath, staleDispatcher, "--metadata", metadataPath]),
			]);
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						turnEndedWrapper,
						"turn-ended",
						"--previous-notify",
						JSON.stringify(nestedSelfReference),
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips wrapper metadata objects with encoded OMX dispatcher payloads", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-object-wrapper-"));
		try {
			const oldPkgScripts = join(wd, "global", "oh-my-codex", "dist", "scripts");
			mkdirSync(oldPkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "object-wrapper-ran");
			const omxMarker = join(wd, "omx-ran");
			const staleDispatcher = join(oldPkgScripts, "notify-dispatcher.js");
			const turnEndedWrapper = join(wd, "SkyComputerUseClient");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(
				turnEndedWrapper,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "ran");\n`,
			);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						turnEndedWrapper,
						"turn-ended",
						`--previous-notify=${JSON.stringify({ previousNotify: JSON.stringify([process.execPath, staleDispatcher]) })}`,
					],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("skips reporter-shaped SkyComputerUseClient previousNotify dispatcher recursion", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-reporter-wrapper-"));
		try {
			const pkgScripts = join(wd, "pkg-without-managed-name", "dist", "scripts");
			mkdirSync(pkgScripts, { recursive: true });
			const stalePreviousMarker = join(wd, "skycomputer-ran");
			const omxMarker = join(wd, "omx-ran");
			const dispatcher = join(pkgScripts, "notify-dispatcher.js");
			const turnEndedWrapper = join(wd, "SkyComputerUseClient");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(dispatcher, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(stalePreviousMarker)}, "dispatcher");\n`);
			writeFileSync(
				turnEndedWrapper,
				`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(stalePreviousMarker)}, "wrapper\\n");\n`,
			);
			chmodSync(turnEndedWrapper, 0o755);
			writeFileSync(omxHook, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(omxMarker)}, "omx\\n");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						turnEndedWrapper,
						"turn-ended",
						"--previous-notify",
						JSON.stringify([
							"node",
							dispatcher,
							"--metadata",
							metadataPath,
						]),
					],
					omxNotify: [process.execPath, omxHook],
					dispatcherNotify: ["node", dispatcher, "--metadata", metadataPath],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(existsSync(stalePreviousMarker), false);
			assert.equal(readFileSync(omxMarker, "utf-8"), "omx\n");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("preserves and runs real user previousNotify entries", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-user-"));
		try {
			const userMarker = join(wd, "user-ran");
			const omxMarker = join(wd, "omx-ran");
			const userScript = join(wd, "user-notify.js");
			const omxHook = join(wd, "current-notify-hook.js");
			writeFileSync(userScript, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(userMarker)}, "ran");\n`);
			writeFileSync(omxHook, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(omxMarker)}, "ran");\n`);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [process.execPath, userScript],
					omxNotify: [process.execPath, omxHook],
				}),
			);

			runDispatcher(metadataPath);

			assert.equal(readFileSync(userMarker, "utf-8"), "ran");
			assert.equal(readFileSync(omxMarker, "utf-8"), "ran");
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});

	it("does not mistake real user notify arguments for managed entrypoints", () => {
		const wd = mkdtempSync(join(tmpdir(), "omx-notify-dispatcher-user-arg-"));
		try {
			const userMarker = join(wd, "user-ran");
			const userScript = join(wd, "user-notify.js");
			writeFileSync(
				userScript,
				`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(userMarker)}, process.argv.slice(2).join("\\n"));\n`,
			);
			const metadataPath = join(wd, "notify-dispatch.json");
			writeFileSync(
				metadataPath,
				JSON.stringify({
					managedBy: "oh-my-codex",
					version: 1,
					previousNotify: [
						process.execPath,
						userScript,
						"/opt/homebrew/lib/node_modules/oh-my-codex/dist/scripts/notify-hook.js",
					],
				}),
			);

			runDispatcher(metadataPath);

			assert.match(readFileSync(userMarker, "utf-8"), /notify-hook\.js/);
		} finally {
			rmSync(wd, { recursive: true, force: true });
		}
	});
});
