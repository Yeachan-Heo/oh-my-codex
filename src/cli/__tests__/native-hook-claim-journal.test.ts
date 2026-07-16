import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearNativeHookClaimJournal,
	persistNativeHookClaimJournal,
	recoverNativeHookClaimJournal,
} from "../native-hook-claim-journal.js";

async function markJournalOwnerDead(root: string): Promise<void> {
	const path = join(root, ".omx", "native-hook-claim-journal.json");
	const journal = JSON.parse(await readFile(path, "utf-8")) as { ownerPid: number };
	journal.ownerPid = 2_147_483_647;
	await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");
}

test("claim journal restores an exact original after rename-away interruption", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-recovery-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.json.omx-claim-test.tmp");
		const before = Buffer.from('{"hooks":{}}\n');
		await writeFile(canonicalPath, before);
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: null,
		});
		await rename(canonicalPath, claimPath);
		await markJournalOwnerDead(root);

		assert.equal(await recoverNativeHookClaimJournal(root), true);
		assert.deepEqual(await readFile(canonicalPath), before);
		assert.equal(await recoverNativeHookClaimJournal(root), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal finalizes an exact installed successor and removes the parked original", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-finalize-"));
	try {
		const canonicalPath = join(root, "config.toml");
		const claimPath = join(root, ".config.toml.omx-claim-test.tmp");
		const before = Buffer.from('model = "before"\n');
		const after = Buffer.from('model = "after"\n');
		await writeFile(claimPath, before);
		await writeFile(canonicalPath, after);
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after,
		});
		await markJournalOwnerDead(root);

		assert.equal(await recoverNativeHookClaimJournal(root), true);
		assert.deepEqual(await readFile(canonicalPath), after);
		await assert.rejects(readFile(claimPath), /ENOENT/);
	} finally {
		await clearNativeHookClaimJournal(root).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal refuses to overwrite unrecognized canonical content", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-conflict-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.json.omx-claim-test.tmp");
		const before = Buffer.from("before\n");
		await writeFile(claimPath, before);
		await writeFile(canonicalPath, "foreign\n");
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: Buffer.from("managed\n"),
		});
		await markJournalOwnerDead(root);
		await assert.rejects(
			recoverNativeHookClaimJournal(root),
			/cannot recover without overwriting unrecognized canonical content/,
		);
		assert.equal(await readFile(canonicalPath, "utf-8"), "foreign\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal refuses to overwrite an existing recovery record", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-existing-"));
	try {
		const firstCanonicalPath = join(root, "hooks.json");
		const firstClaimPath = join(root, ".hooks.json.omx-claim-first.tmp");
		const first = Buffer.from("first\n");
		await persistNativeHookClaimJournal(root, {
			canonicalPath: firstCanonicalPath,
			claimPath: firstClaimPath,
			before: first,
			after: null,
		});
		const journalPath = join(root, ".omx", "native-hook-claim-journal.json");
		const originalJournal = await readFile(journalPath);

		await assert.rejects(
			persistNativeHookClaimJournal(root, {
				canonicalPath: join(root, "config.toml"),
				claimPath: join(root, ".config.toml.omx-claim-second.tmp"),
				before: Buffer.from("second\n"),
				after: null,
			}),
			/EEXIST/,
		);
		assert.deepEqual(await readFile(journalPath), originalJournal);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal finalizes a completed deletion after claim removal", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-deleted-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.json.omx-claim-deleted.tmp");
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before: Buffer.from("before\n"),
			after: null,
		});
		await markJournalOwnerDead(root);

		assert.equal(await recoverNativeHookClaimJournal(root), true);
		assert.equal(await recoverNativeHookClaimJournal(root), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
