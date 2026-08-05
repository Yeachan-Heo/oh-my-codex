import assert from "node:assert/strict";
import {
	copyFile,
	link,
	lstat,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	clearNativeHookClaimJournal as clearNativeHookClaimJournalWithDurability,
	createNativeHookClaimJournalDurability,
	persistNativeHookClaimJournal as persistNativeHookClaimJournalWithDurability,
	recoverNativeHookClaimJournal as recoverNativeHookClaimJournalWithDurability,
	restoreNativeHookClaimNoClobber,
} from "../native-hook-claim-journal.js";

const durability = createNativeHookClaimJournalDurability();

const clearNativeHookClaimJournal = (root: string) =>
	clearNativeHookClaimJournalWithDurability(root, durability);
const persistNativeHookClaimJournal = (
	root: string,
	entry: Parameters<typeof persistNativeHookClaimJournalWithDurability>[1],
) => persistNativeHookClaimJournalWithDurability(root, entry, durability);
const recoverNativeHookClaimJournal = (root: string) =>
	recoverNativeHookClaimJournalWithDurability(root, durability);

async function markJournalOwnerDead(root: string): Promise<void> {
	const path = join(root, ".omx", "native-hook-claim-journal.json");
	const journal = JSON.parse(await readFile(path, "utf-8")) as {
		ownerPid: number;
	};
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

		assert.equal((await recoverNativeHookClaimJournal(root)).recovered, true);
		assert.deepEqual(await readFile(canonicalPath), before);
		assert.equal((await recoverNativeHookClaimJournal(root)).recovered, false);
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

		assert.equal((await recoverNativeHookClaimJournal(root)).recovered, true);
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

		assert.equal((await recoverNativeHookClaimJournal(root)).recovered, true);
		assert.equal((await recoverNativeHookClaimJournal(root)).recovered, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal treats only injected Windows regular-file EPERM as degraded", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-durability-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.json.claim");
		const order: string[] = [];
		const outcome = await persistNativeHookClaimJournalWithDurability(
			root,
			{
				canonicalPath,
				claimPath,
				before: Buffer.from("before\n"),
				after: null,
			},
			{
				platform: "win32",
				syncRegularFile: async () => {
					order.push("regular");
					return "unsupported-windows-eperm";
				},
				syncDirectory: async () => {
					order.push("directory");
					return "synced";
				},
			},
		);
		assert.equal(outcome, "unsupported-windows-eperm");
		assert.deepEqual(order, ["directory", "regular", "directory"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal rejects paths outside its controlled root", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-controlled-root-"));
	try {
		await assert.rejects(
			persistNativeHookClaimJournal(root, {
				canonicalPath: join(root, "..", "foreign-hooks.json"),
				claimPath: join(root, ".hooks.json.claim"),
				before: Buffer.from("before\n"),
				after: null,
			}),
			/outside controlled root/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim restore rejects an unexpected hard-linked claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-hard-link-"));
	try {
		const claimPath = join(root, ".hooks.json.claim");
		await writeFile(claimPath, "before\n");
		await link(claimPath, join(root, "foreign-link"));
		await assert.rejects(
			restoreNativeHookClaimNoClobber(
				claimPath,
				join(root, "hooks.json"),
				durability,
			),
			/refuses unsafe claim/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim recovery rejects a linked-directory escape from the controlled root", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-root-"));
	const outside = await mkdtemp(join(tmpdir(), "omx-claim-outside-"));
	try {
		const claimPath = join(root, ".hooks.claim");
		const safeCanonicalPath = join(root, "hooks.json");
		const linkedDirectory = join(root, "escape");
		const escapedCanonicalPath = join(linkedDirectory, "victim");
		const before = Buffer.from("before\n");
		await writeFile(claimPath, before);
		await persistNativeHookClaimJournal(root, {
			canonicalPath: safeCanonicalPath,
			claimPath,
			before,
			after: null,
		});
		await symlink(
			outside,
			linkedDirectory,
			process.platform === "win32" ? "junction" : "dir",
		);
		const path = join(root, ".omx", "native-hook-claim-journal.json");
		const journal = JSON.parse(await readFile(path, "utf-8")) as {
			ownerPid: number;
			canonicalPath: string;
		};
		journal.ownerPid = 2_147_483_647;
		journal.canonicalPath = escapedCanonicalPath;
		await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");

		await assert.rejects(
			recoverNativeHookClaimJournal(root),
			/ancestor is unsafe/,
		);
		await assert.rejects(readFile(join(outside, "victim")), /ENOENT/);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});

test("claim recovery rejects a journal replacement after opening the original", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-journal-identity-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.claim");
		const before = Buffer.from("before\n");
		await writeFile(claimPath, before);
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: null,
		});
		await markJournalOwnerDead(root);
		const path = join(root, ".omx", "native-hook-claim-journal.json");
		const parkedPath = `${path}.parked`;
		const replacementPath = `${path}.replacement`;
		let replaced = false;

		await assert.rejects(
			recoverNativeHookClaimJournalWithDurability(root, {
				...durability,
				openFileForRead: async (targetPath) => {
					const handle = await open(targetPath, "r");
					if (targetPath === path && !replaced) {
						await writeFile(replacementPath, await readFile(path));
						await rename(path, parkedPath);
						await rename(replacementPath, path);
						replaced = true;
					}
					return handle;
				},
			}),
			/refuses unsafe artifact/,
		);
		assert.equal(replaced, true);
		await assert.doesNotReject(readFile(path));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim recovery treats post-open journal removal as a race", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-journal-removal-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.claim");
		const before = Buffer.from("before\n");
		await writeFile(claimPath, before);
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: null,
		});
		await markJournalOwnerDead(root);
		const path = join(root, ".omx", "native-hook-claim-journal.json");
		let removed = false;

		await assert.rejects(
			recoverNativeHookClaimJournalWithDurability(root, {
				...durability,
				openFileForRead: async (targetPath) => {
					const handle = await open(targetPath, "r");
					if (targetPath === path && !removed) {
						await rm(path);
						removed = true;
					}
					return handle;
				},
			}),
			/ENOENT/,
		);
		assert.equal(removed, true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim recovery treats post-open artifact removal as a race", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-post-open-removal-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.claim");
		const before = Buffer.from("before\n");
		await writeFile(claimPath, before);
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: null,
		});
		await markJournalOwnerDead(root);
		let removed = false;

		await assert.rejects(
			recoverNativeHookClaimJournalWithDurability(root, {
				...durability,
				openFileForRead: async (targetPath) => {
					const handle = await open(targetPath, "r");
					if (targetPath === claimPath && !removed) {
						await rm(claimPath);
						removed = true;
					}
					return handle;
				},
			}),
			/ENOENT/,
		);
		assert.equal(removed, true);
		await assert.doesNotReject(
			readFile(join(root, ".omx", "native-hook-claim-journal.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim restore rejects a hardlink added during durability sync", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-hardlink-race-"));
	try {
		const claimPath = join(root, ".hooks.claim");
		const destinationPath = join(root, "hooks.json");
		const foreignLink = join(root, "foreign-link");
		await writeFile(claimPath, "before\n");
		let injected = false;
		await assert.rejects(
			restoreNativeHookClaimNoClobber(claimPath, destinationPath, {
				platform: "win32",
				syncRegularFile: async () => "synced",
				syncDirectory: async () => {
					if (!injected) {
						injected = true;
						await link(claimPath, foreignLink);
					}
					return "synced";
				},
			}),
			/changed during restore/,
		);
		assert.equal(injected, true);
		const [claim, destination, foreign] = await Promise.all([
			lstat(claimPath),
			lstat(destinationPath),
			lstat(foreignLink),
		]);
		assert.equal(claim.nlink, 3);
		assert.equal(destination.ino, claim.ino);
		assert.equal(foreign.ino, claim.ino);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("copy fallback rejects a same-byte destination with a new identity", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-copy-identity-"));
	try {
		const claimPath = join(root, ".hooks.claim");
		const destinationPath = join(root, "hooks.json");
		const replacementPath = join(root, ".replacement");
		await writeFile(claimPath, "before\n");
		let replaced = false;
		await assert.rejects(
			restoreNativeHookClaimNoClobber(claimPath, destinationPath, {
				platform: "win32",
				syncRegularFile: async () => "synced",
				syncDirectory: async () => {
					if (!replaced) {
						const owned = await lstat(destinationPath);
						await writeFile(replacementPath, await readFile(destinationPath));
						const replacement = await lstat(replacementPath);
						assert.notEqual(replacement.ino, owned.ino);
						await rm(destinationPath);
						await rename(replacementPath, destinationPath);
						replaced = true;
					}
					return "synced";
				},
				linkFile: async () => {
					throw Object.assign(new Error("forced link fallback"), {
						code: "EPERM",
					});
				},
				copyFileExclusive: async (sourcePath, targetPath) =>
					copyFile(sourcePath, targetPath),
			}),
			/changed during restore/,
		);
		assert.equal(replaced, true);
		assert.equal(await readFile(destinationPath, "utf-8"), "before\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal continues when Windows directory sync reports unsupported EPERM", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-directory-durability-"));
	try {
		const outcome = await persistNativeHookClaimJournalWithDurability(
			root,
			{
				canonicalPath: join(root, "hooks.json"),
				claimPath: join(root, ".hooks.json.claim"),
				before: Buffer.from("before\n"),
				after: null,
			},
			{
				platform: "win32",
				syncRegularFile: async () => "synced",
				syncDirectory: async () => "unsupported-windows-eperm",
			},
		);
		assert.equal(outcome, "synced");
		await assert.doesNotReject(
			readFile(join(root, ".omx", "native-hook-claim-journal.json")),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal keeps POSIX regular-file and directory EPERM fatal", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-durability-fatal-"));
	try {
		const entry = {
			canonicalPath: join(root, "hooks.json"),
			claimPath: join(root, ".hooks.json.claim"),
			before: Buffer.from("before\n"),
			after: null,
		};
		const regularError = Object.assign(new Error("EPERM"), { code: "EPERM" });
		await assert.rejects(
			persistNativeHookClaimJournalWithDurability(root, entry, {
				platform: "linux",
				syncRegularFile: async () => {
					throw regularError;
				},
				syncDirectory: async () => "synced",
			}),
			(error) => error === regularError,
		);
		const directoryError = Object.assign(new Error("EPERM"), { code: "EPERM" });
		await assert.rejects(
			persistNativeHookClaimJournalWithDurability(root, entry, {
				platform: "linux",
				syncRegularFile: async () => "synced",
				syncDirectory: async () => {
					throw directoryError;
				},
			}),
			(error) => error === directoryError,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("claim journal recovery returns independent recovered and no-op outcomes", async () => {
	const root = await mkdtemp(join(tmpdir(), "omx-claim-recovery-outcome-"));
	try {
		const canonicalPath = join(root, "hooks.json");
		const claimPath = join(root, ".hooks.json.claim");
		const before = Buffer.from("before\n");
		await persistNativeHookClaimJournal(root, {
			canonicalPath,
			claimPath,
			before,
			after: null,
		});
		await rename(canonicalPath, claimPath).catch(() => undefined);
		await writeFile(claimPath, before);
		await markJournalOwnerDead(root);
		const recovered = await recoverNativeHookClaimJournalWithDurability(root, {
			platform: "win32",
			syncRegularFile: async () => "unsupported-windows-eperm",
			syncDirectory: async () => "synced",
		});
		assert.deepEqual(recovered, {
			recovered: true,
			outcome: "unsupported-windows-eperm",
		});
		assert.deepEqual(
			await recoverNativeHookClaimJournalWithDurability(root, durability),
			{ recovered: false, outcome: "synced" },
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
