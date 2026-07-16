import assert from "node:assert/strict";
import { test } from "node:test";
import {
	emitDegradedDurabilityWarning,
	recordRegularFileSyncOutcome,
	syncRegularFile,
	type RegularFileDurabilityTracker,
} from "../file-durability.js";

function errno(code: unknown): Error & { code: unknown } {
	return Object.assign(new Error(`${String(code)}: fsync`), { code });
}

test("regular-file sync returns the Windows EPERM durability outcome", async () => {
	const outcome = await syncRegularFile(
		{ sync: async () => { throw errno("EPERM"); } },
		"win32",
	);
	assert.equal(outcome, "unsupported-windows-eperm");
});

test("regular-file sync returns synced after a successful sync", async () => {
	assert.equal(await syncRegularFile({ sync: async () => {} }, "win32"), "synced");
});

for (const { description, platform, failure } of [
	{ description: "Linux string EPERM", platform: "linux", failure: errno("EPERM") },
	{ description: "Windows EACCES", platform: "win32", failure: errno("EACCES") },
	{ description: "Windows non-string code", platform: "win32", failure: errno(1) },
	{ description: "Windows message-only EPERM", platform: "win32", failure: new Error("EPERM") },
] as const) {
	test(`regular-file sync preserves fatal error identity for ${description}`, async () => {
		await assert.rejects(
			syncRegularFile({ sync: async () => { throw failure; } }, platform),
			(error: unknown) => error === failure,
		);
	});
}

test("durability tracker aggregates outcomes and emits one exact best-effort warning", () => {
	const tracker: RegularFileDurabilityTracker = { degraded: false };
	recordRegularFileSyncOutcome(tracker, "synced");
	recordRegularFileSyncOutcome(tracker, "unsupported-windows-eperm");
	recordRegularFileSyncOutcome(tracker, "unsupported-windows-eperm");
	const originalWrite = process.stderr.write;
	const warnings: string[] = [];
	process.stderr.write = ((value: string) => {
		warnings.push(value);
		return true;
	}) as typeof process.stderr.write;
	try {
		emitDegradedDurabilityWarning("session pointer start/reconcile", tracker);
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.deepEqual(warnings, [
		"[omx] warning: Windows EPERM regular-file fsync unsupported in session pointer start/reconcile; operation succeeded with degraded durability.\n",
	]);
});

test("a throwing stderr sink cannot fail an already successful transaction", () => {
	const originalWrite = process.stderr.write;
	const tracker: RegularFileDurabilityTracker = { degraded: false };
	recordRegularFileSyncOutcome(tracker, "unsupported-windows-eperm");
	process.stderr.write = (() => { throw new Error("stderr unavailable"); }) as typeof process.stderr.write;
	try {
		assert.doesNotThrow(() => emitDegradedDurabilityWarning("session pointer end", tracker));
	} finally {
		process.stderr.write = originalWrite;
	}
});
