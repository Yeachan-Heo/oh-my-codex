import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { omxAdaptersDir } from "../../utils/paths.js";

/**
 * Durable, atomic, per-source monotonic sequence store for Herdr reports.
 *
 * Herdr accepts but ignores a report whose `seq <= last accepted seq for the
 * same source`. Hooks run as short-lived processes, so an in-memory counter
 * resets to 1 on every process/restart and would (a) let legitimate new reports
 * be rejected as stale after a restart and (b) fail to prevent stale reports
 * across concurrent processes. This store persists the counter under
 * `.omx/adapters/herdr/seq/<sanitized-source>.json` and serializes concurrent
 * increments with an atomic mkdir lock, so seq is strictly increasing per source
 * across processes and restarts.
 */

export interface SeqStoreOptions {
	/** Base `.omx/adapters/herdr` dir; defaults to the resolved OMX adapters dir. */
	baseDir?: string;
	/** Max time to wait for the lock before giving up (best-effort). */
	lockTimeoutMs?: number;
	/** Consider a held lock stale after this age (crash recovery). */
	lockStaleMs?: number;
}

const DEFAULT_LOCK_TIMEOUT_MS = 2000;
const DEFAULT_LOCK_STALE_MS = 10_000;
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

function herdrSeqDir(baseDir?: string): string {
	return join(baseDir ?? join(omxAdaptersDir(), "herdr"), "seq");
}

/** Filesystem-safe, collision-resistant file stem for a source id. */
export function sanitizeSourceKey(source: string): string {
	const cleaned = source.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
	return cleaned.length > 0 ? cleaned : "unknown-source";
}

function counterPath(baseDir: string | undefined, source: string): string {
	return join(herdrSeqDir(baseDir), `${sanitizeSourceKey(source)}.json`);
}

function lockPath(baseDir: string | undefined, source: string): string {
	return join(herdrSeqDir(baseDir), `${sanitizeSourceKey(source)}.lock`);
}

function readCounter(path: string): number {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as { seq?: unknown };
		const value = typeof parsed.seq === "number" ? parsed.seq : 0;
		return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
	} catch {
		// Missing or corrupt counter: restart from 0 (first seq will be 1).
		return 0;
	}
}

function writeCounterAtomic(path: string, seq: number): void {
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(
		tmp,
		`${JSON.stringify({ seq, updated_at: new Date().toISOString() })}\n`,
		"utf-8",
	);
	renameSync(tmp, path);
}

function acquireLock(lock: string, timeoutMs: number, staleMs: number): boolean {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			mkdirSync(lock, { recursive: false });
			return true;
		} catch {
			// Lock held: break it if stale, otherwise spin until the deadline.
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > staleMs) {
					try {
						rmdirSync(lock);
					} catch {
						// another process broke it first; retry
					}
					continue;
				}
			} catch {
				// lock vanished between mkdir and stat; retry
			}
			if (Date.now() >= deadline) return false;
			busyWait(5);
		}
	}
}

function releaseLock(lock: string): void {
	try {
		rmdirSync(lock);
	} catch {
		// already released
	}
}

/** Small synchronous sleep so the lock loop stays sync (hooks call this inline). */
function busyWait(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// intentional short spin; ms is tiny (single-digit)
	}
}

/**
 * Atomically read-increment-persist the per-source counter and return the new
 * seq. Strictly increasing and unique per source across concurrent processes
 * and restarts. Falls back to a time-derived seq only if the lock cannot be
 * acquired, so a report is never dropped and never regresses below the last
 * persisted value.
 */
export function nextSeq(source: string, options: SeqStoreOptions = {}): number {
	const dir = herdrSeqDir(options.baseDir);
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// If we cannot even create the dir, fall back to a time-derived seq.
		return timeDerivedSeq();
	}

	const path = counterPath(options.baseDir, source);
	const lock = lockPath(options.baseDir, source);
	const acquired = acquireLock(
		lock,
		options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
		options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS,
	);

	if (!acquired) {
		// Best-effort: never block the OMX run on lock contention.
		return timeDerivedSeq(readCounter(path));
	}

	try {
		const current = readCounter(path);
		const next = current >= MAX_SEQ ? current : current + 1;
		writeCounterAtomic(path, next);
		return next;
	} finally {
		releaseLock(lock);
	}
}

/**
 * Monotonic-ish fallback derived from wall clock, floored above any known
 * persisted value so it cannot regress below the last accepted seq.
 */
function timeDerivedSeq(floor = 0): number {
	return Math.max(floor + 1, Date.now());
}

export function readPersistedSeq(
	source: string,
	options: SeqStoreOptions = {},
): number {
	return readCounter(counterPath(options.baseDir, source));
}
