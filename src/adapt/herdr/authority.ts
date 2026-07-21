import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { omxAdaptersDir } from "../../utils/paths.js";

/**
 * Tracks whether OMX currently holds Herdr `omx:runtime` authority for a pane,
 * so release only fires when no OMX workflow remains active, and so a stale
 * authority left by a crashed process can be reconciled on the next
 * session-start.
 */

export interface AuthorityRecord {
	pane_id: string;
	source: string;
	owner_pid: number;
	session_id?: string;
	acquired_at: string;
	updated_at: string;
}

export interface AuthorityStoreOptions {
	baseDir?: string;
}

function authorityPath(baseDir?: string): string {
	return join(baseDir ?? join(omxAdaptersDir(), "herdr"), "authority.json");
}

export function readAuthority(
	options: AuthorityStoreOptions = {},
): AuthorityRecord | null {
	try {
		return JSON.parse(
			readFileSync(authorityPath(options.baseDir), "utf-8"),
		) as AuthorityRecord;
	} catch {
		return null;
	}
}

function writeAuthorityAtomic(record: AuthorityRecord, baseDir?: string): void {
	const path = authorityPath(baseDir);
	mkdirSync(join(baseDir ?? join(omxAdaptersDir(), "herdr")), {
		recursive: true,
	});
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

export function recordAuthority(
	record: Omit<AuthorityRecord, "acquired_at" | "updated_at"> &
		Partial<Pick<AuthorityRecord, "acquired_at">>,
	options: AuthorityStoreOptions = {},
): void {
	const now = new Date().toISOString();
	const existing = readAuthority(options);
	writeAuthorityAtomic(
		{
			...record,
			acquired_at: record.acquired_at ?? existing?.acquired_at ?? now,
			updated_at: now,
		},
		options.baseDir,
	);
}

export function clearAuthority(options: AuthorityStoreOptions = {}): void {
	const path = authorityPath(options.baseDir);
	if (existsSync(path)) {
		try {
			rmSync(path);
		} catch {
			// best-effort
		}
	}
}

/**
 * A liveness probe for the current owner process. Injectable for tests; the
 * default checks whether the recorded pid is alive via `process.kill(pid, 0)`.
 */
export type PidLivenessProbe = (pid: number) => boolean;

const defaultPidAlive: PidLivenessProbe = (pid) => {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH => no such process; EPERM => exists but not ours (treat as alive)
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * Crash reconciliation: if an authority record exists but its owner process is
 * no longer alive, clear it so Herdr returns to normal screen detection. Call
 * on session-start. Returns true when a stale record was cleared.
 */
export function reconcileStaleAuthority(
	options: AuthorityStoreOptions & { pidAlive?: PidLivenessProbe } = {},
): boolean {
	const record = readAuthority(options);
	if (!record) return false;
	const alive = (options.pidAlive ?? defaultPidAlive)(record.owner_pid);
	if (alive) return false;
	clearAuthority(options);
	return true;
}
