import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, rename, rm, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../utils/paths.js";

/**
 * Credential provenance for project-scope launches (issue #3629).
 *
 * Project-scope setup stores managed Codex config under <project>/.codex, but
 * Codex resolves credentials from CODEX_HOME/auth.json only. When a launch
 * redirects CODEX_HOME to the per-session runtime mirror, the mirror starts
 * without credentials and every run fails with 401.
 *
 * This module locates the caller's real credential file and copies it, as an
 * opaque byte stream, into the ephemeral runtime home. Safety rules:
 * - The credential is NEVER copied into the durable project .codex directory
 *   or any repository-tracked location; the runtime home lives under the
 *   gitignored .omx/ tree and is removed after each session. Cleanup knows
 *   which files were seeded (seeded-runtime-auth.json manifest) and never
 *   lets them reach the project persistence path.
 * - Contents are never read, parsed, logged, or transformed.
 * - The destination is created exclusive (O_CREAT|O_EXCL|O_NOFOLLOW) at mode
 *   0600, so a pre-existing symlink or hard link at the destination can never
 *   redirect the write into another file.
 * - The source must be a regular file at read time (lstat + open + fstat
 *   re-validation narrows the TOCTOU window; a source that turns out to be a
 *   link or changes identity mid-copy aborts the seed).
 * - Failure to resolve or copy is not fatal and is not silent auth: the
 *   launch proceeds exactly as before (no credentials injected). The typed
 *   outcome lets doctor surface unusable provenance as a failure.
 */

const CODEX_AUTH_FILE_NAME = "auth.json";
export const SEEDED_RUNTIME_AUTH_MANIFEST_NAME = "seeded-runtime-auth.json";

export type CredentialProvenanceOutcome =
	| "seeded"
	| "missing"
	| "unsafe-source"
	| "unsafe-destination"
	| "unreadable-source"
	| "copy-failed";

export interface CodexCredentialSeedResult {
	outcome: CredentialProvenanceOutcome;
	/** Present only when outcome === "seeded". */
	sourcePath?: string;
	/** Present only when outcome === "seeded". */
	destinationPath?: string;
}

export interface CodexCredentialSource {
	/** Absolute path of the caller's regular auth.json file. */
	sourcePath: string;
	/** Absolute path inside the runtime home the copy was written to. */
	destinationPath: string;
}

export type CredentialSourceResolution =
	| { status: "found"; path: string }
	| { status: "missing" }
	| { status: "unsafe" };

/**
 * Resolve the caller's credential file path without following symlinks.
 * An explicit CODEX_HOME wins (same authority rule as codex-home.ts);
 * otherwise the user home (~/.codex) is used.
 */
export async function resolveUserCredentialSource(
	env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialSourceResolution> {
	const explicitHome = env.CODEX_HOME;
	const homeDir =
		typeof explicitHome === "string" && explicitHome.trim() !== ""
			? explicitHome.trim()
			: codexHome();
	const candidate = join(homeDir, CODEX_AUTH_FILE_NAME);
	if (!existsSync(candidate)) return { status: "missing" };
	try {
		const info = await lstat(candidate);
		if (!info.isFile()) return { status: "unsafe" };
		// Open + fstat re-validation: the file must still be a regular file with
		// the same identity when we actually read it.
		const handle = await open(candidate, "r");
		try {
			const openInfo = await handle.stat();
			if (!openInfo.isFile()) return { status: "unsafe" };
			if (openInfo.dev !== info.dev || openInfo.ino !== info.ino) {
				return { status: "unsafe" };
			}
		} finally {
			await handle.close();
		}
		return { status: "found", path: candidate };
	} catch {
		// existsSync true but open/lstat failed: treat as unreadable source.
		return { status: "unsafe" };
	}
}

/**
 * Back-compat helper: the caller's auth.json path when resolvable as a
 * regular file.
 */
export async function resolveUserCredentialFilePath(
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const resolution = await resolveUserCredentialSource(env);
	return resolution.status === "found" ? resolution.path : undefined;
}

function noFollowFlag(): number {
	return process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
}

/**
 * Record seeded-credential provenance for a runtime home. Cleanup reads this
 * manifest to guarantee seeded copies are deleted (or at minimum never
 * persisted) even when history artifacts are retained for recovery.
 */
export async function recordSeededRuntimeAuth(
	runtimeCodexHome: string,
): Promise<void> {
	const manifestPath = join(runtimeCodexHome, SEEDED_RUNTIME_AUTH_MANIFEST_NAME);
	try {
		const handle = await open(manifestPath, "w");
		try {
			await handle.writeFile(JSON.stringify({ files: [CODEX_AUTH_FILE_NAME] }));
		} finally {
			await handle.close();
		}
	} catch {
		// Manifest failure must not break the launch; cleanup still removes the
		// whole runtime home in the normal path.
	}
}

/**
 * Copy the caller's credential file into the ephemeral launch home.
 * Returns a typed outcome; callers must treat anything other than "seeded"
 * as "no credentials provided", never as success. The write is exclusive and
 * no-follow: a symlink already sitting at the destination aborts the seed
 * (outcome "unsafe-destination") instead of being followed.
 */
export async function seedCredentialIntoRuntimeHome(
	runtimeCodexHome: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexCredentialSeedResult> {
	const source = await resolveUserCredentialSource(env);
	if (source.status === "missing") return { outcome: "missing" };
	if (source.status === "unsafe") return { outcome: "unsafe-source" };
	const sourcePath = source.path;
	const destinationPath = join(runtimeCodexHome, CODEX_AUTH_FILE_NAME);
	try {
		if (existsSync(destinationPath) || existsSync(`${destinationPath}.`)) {
			// Any pre-existing destination entry (file or link) blocks seeding:
			// the mirror already carries a project auth and we must not overwrite
			// or follow it.
			return { outcome: "unsafe-destination" };
		}
		const info = await lstat(destinationPath).catch(() => undefined);
		if (info) return { outcome: "unsafe-destination" };
		await mkdir(runtimeCodexHome, { recursive: true });
		// Stage under a unique temporary name, then rename into place. The
		// staging open is exclusive and no-follow with 0600 so nothing can
		// redirect the bytes.
		const stagingPath = `${destinationPath}.omx-seed-${process.pid}-${Math.random().toString(36).slice(2)}`;
		let staged = false;
		try {
			const handle = await open(
				stagingPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
				0o600,
			);
			try {
				await copyFile(sourcePath, stagingPath);
				const stagedInfo = await lstat(stagingPath);
				if (!stagedInfo.isFile()) return { outcome: "unsafe-destination" };
				// copyFile adopts the source mode; force 0600 regardless.
				await chmod(stagingPath, 0o600);
				staged = true;
			} finally {
				await handle.close();
			}
			await rename(stagingPath, destinationPath);
			await recordSeededRuntimeAuth(runtimeCodexHome);
			return { outcome: "seeded", sourcePath, destinationPath };
		} finally {
			if (!staged) await rm(stagingPath, { force: true }).catch(() => undefined);
		}
	} catch {
		await unlink(destinationPath).catch(() => undefined);
		return { outcome: "copy-failed" };
	}
}
