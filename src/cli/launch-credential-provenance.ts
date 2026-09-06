import { copyFile, lstat, mkdir } from "node:fs/promises";
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
 *   gitignored .omx/ tree and is removed after each session.
 * - Contents are never read, parsed, logged, or transformed.
 * - Only regular files are accepted (symlinks are rejected so a hostile
   project tree cannot redirect the read).
 * - Failure to resolve or copy is not fatal and is not silent auth: the launch
 *   proceeds exactly as before (no credentials injected), which callers may
 *   surface as a diagnostic.
 */

const CODEX_AUTH_FILE_NAME = "auth.json";

export interface CodexCredentialSource {
	/** Absolute path of the caller's regular auth.json file. */
	sourcePath: string;
	/** Absolute path inside the runtime home the copy was written to. */
	destinationPath: string;
}

/**
 * Resolve the caller's credential file path without following symlinks.
 * An explicit CODEX_HOME wins (same authority rule as codex-home.ts);
 * otherwise the user home (~/.codex) is used.
 */
export async function resolveUserCredentialFilePath(
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	const explicitHome = env.CODEX_HOME;
	const homeDir =
		typeof explicitHome === "string" && explicitHome.trim() !== ""
			? explicitHome.trim()
			: codexHome();
	const candidate = join(homeDir, CODEX_AUTH_FILE_NAME);
	if (!existsSync(candidate)) return undefined;
	try {
		const info = await lstat(candidate);
		return info.isFile() ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Copy the caller's credential file into the ephemeral launch home.
 * Returns undefined when no source credential exists or it cannot be copied
 * safely; callers must treat undefined as "no credentials provided", never as
 * success.
 */
export async function seedCredentialIntoRuntimeHome(
	runtimeCodexHome: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CodexCredentialSource | undefined> {
	const sourcePath = await resolveUserCredentialFilePath(env);
	if (!sourcePath) return undefined;
	const destinationPath = join(runtimeCodexHome, CODEX_AUTH_FILE_NAME);
	try {
		const info = await lstat(sourcePath);
		if (!info.isFile()) return undefined;
		await mkdir(runtimeCodexHome, { recursive: true });
		await copyFile(sourcePath, destinationPath);
		// The copy must be a regular file at the destination. If a symlink
		// already existed at the destination path, fail closed rather than
		// leaving (or following) a link.
		const copied = await lstat(destinationPath);
		if (!copied.isFile()) return undefined;
		return { sourcePath, destinationPath };
	} catch {
		return undefined;
	}
}
