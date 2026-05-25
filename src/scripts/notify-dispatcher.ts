#!/usr/bin/env node

/**
 * oh-my-codex notify dispatcher.
 * Runs a pre-existing user notify command first, then the OMX notify hook.
 */

import { readFile } from "fs/promises";
import { spawnSync } from "child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

interface NotifyDispatcherMetadata {
	managedBy?: string;
	version?: number;
	previousNotify?: string[] | null;
	omxNotify?: string[];
	dispatcherNotify?: string[];
}

const DISPATCH_LOCK_STALE_MS = 45_000;
// Codex Desktop can replay a backlog of turn-ended callbacks well after the UI
// window has gone away. Keep the default same-turn coalescing window longer
// than a heavily loaded notification hook invocation so sequential queued
// callbacks from one thread do not slip through merely because the first
// dispatch was slow. Payloads with different thread/session identity retain
// independent notification cadence.
const DEFAULT_TURN_DISPATCH_MIN_INTERVAL_MS = 10_000;
const DEFAULT_STALE_EVENT_AGE_MS = 5 * 60_000;

interface DispatchGuard {
	ok: boolean;
	release?: () => void;
}

interface DispatchGuardState {
	lastDispatchAt?: unknown;
	lastDispatchByIdentity?: Record<string, unknown>;
}

function parseNonNegativeEnvMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (typeof raw !== "string" || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePayloadObject(payloadArg: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(payloadArg) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function isTurnEndedPayload(payload: Record<string, unknown> | null): boolean {
	if (!payload) return false;
	const type = String(payload.type ?? payload.event ?? payload.hook_event_name ?? "")
		.trim()
		.toLowerCase();
	return type === ""
		|| type === "agent-turn-complete"
		|| type === "turn-complete"
		|| type === "turn-ended";
}

function readPayloadTimestampMs(payload: Record<string, unknown>): number | null {
	for (const key of ["timestamp", "created_at", "createdAt", "event_time", "eventTime", "time"]) {
		const value = payload[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value > 1_000_000_000_000 ? value : value * 1000;
		}
		if (typeof value === "string" && value.trim()) {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

function readPayloadIdentity(payload: Record<string, unknown> | null): string {
	if (!payload) return "global";
	for (const key of [
		"thread_id",
		"threadId",
		"conversation_id",
		"conversationId",
		"session_id",
		"sessionId",
	]) {
		const value = payload[key];
		if (typeof value === "string" && value.trim()) {
			return `${key}:${value.trim()}`;
		}
	}
	return "global";
}

function dispatchGuardDir(metadataPath: string): string {
	if (metadataPath) return dirname(metadataPath);
	return join(tmpdir(), "oh-my-codex-notify-dispatch");
}

function writeDispatchGuardState(
	statePath: string,
	state: DispatchGuardState,
	identity: string,
	minIntervalMs: number,
	staleEventAgeMs: number,
): void {
	const previousByIdentity = state.lastDispatchByIdentity && typeof state.lastDispatchByIdentity === "object"
		? state.lastDispatchByIdentity
		: {};
	const retainedByIdentity: Record<string, number> = {};
	const now = Date.now();
	const retentionMs = Math.max(minIntervalMs, staleEventAgeMs, DEFAULT_TURN_DISPATCH_MIN_INTERVAL_MS);
	for (const [key, value] of Object.entries(previousByIdentity)) {
		if (typeof value === "number" && now - value <= retentionMs) {
			retainedByIdentity[key] = value;
		}
	}
	retainedByIdentity[identity] = now;
	writeFileSync(statePath, JSON.stringify({
		lastDispatchAt: identity === "global" ? now : (typeof state.lastDispatchAt === "number" ? state.lastDispatchAt : undefined),
		lastDispatchByIdentity: retainedByIdentity,
		pid: process.pid,
	}));
}

function acquireTurnDispatchGuard(metadataPath: string, payloadArg: string): DispatchGuard {
	const payload = parsePayloadObject(payloadArg);
	if (!isTurnEndedPayload(payload)) return { ok: true };

	const now = Date.now();
	const staleEventAgeMs = parseNonNegativeEnvMs("OMX_NOTIFY_DISPATCH_STALE_EVENT_AGE_MS", DEFAULT_STALE_EVENT_AGE_MS);
	const eventTimestampMs = payload ? readPayloadTimestampMs(payload) : null;
	if (eventTimestampMs !== null && staleEventAgeMs > 0 && now - eventTimestampMs > staleEventAgeMs) {
		return { ok: false };
	}

	const dir = dispatchGuardDir(metadataPath);
	mkdirSync(dir, { recursive: true });
	const lockPath = join(dir, "notify-dispatch.lock");
	const statePath = join(dir, "notify-dispatch.guard.json");
	try {
		const lockStat = statSync(lockPath);
		if (now - lockStat.mtimeMs > DISPATCH_LOCK_STALE_MS) unlinkSync(lockPath);
	} catch {
		// Missing or unreadable lock: try to acquire below.
	}

	let fd: number;
	try {
		fd = openSync(lockPath, "wx");
		writeFileSync(fd, String(process.pid));
		closeSync(fd);
	} catch {
		return { ok: false };
	}

	const release = () => {
		try {
			unlinkSync(lockPath);
		} catch {
			// Best effort.
		}
	};

	try {
		const minIntervalMs = parseNonNegativeEnvMs("OMX_NOTIFY_DISPATCH_MIN_INTERVAL_MS", DEFAULT_TURN_DISPATCH_MIN_INTERVAL_MS);
		const identity = readPayloadIdentity(payload);
		let state: DispatchGuardState = {};
		try {
			state = JSON.parse(readFileSync(statePath, "utf-8")) as typeof state;
		} catch {
			// No prior guard state.
		}
		if (minIntervalMs > 0) {
			const byIdentity = state.lastDispatchByIdentity && typeof state.lastDispatchByIdentity === "object"
				? state.lastDispatchByIdentity
				: {};
			const identityLastDispatchAt = typeof byIdentity[identity] === "number" ? byIdentity[identity] : 0;
			const legacyLastDispatchAt = identity === "global" && typeof state.lastDispatchAt === "number" ? state.lastDispatchAt : 0;
			const lastDispatchAt = Math.max(identityLastDispatchAt, legacyLastDispatchAt);
			if (lastDispatchAt > 0 && now - lastDispatchAt < minIntervalMs) {
				release();
				return { ok: false };
			}
		}
		return {
			ok: true,
			release: () => {
				try {
					writeDispatchGuardState(statePath, state, identity, minIntervalMs, staleEventAgeMs);
				} catch {
					// Guard state is best effort; the lock still prevents concurrent duplicate dispatch.
				}
				release();
			},
		};
	} catch {
		release();
		return { ok: false };
	}
}

function parseArgs(): { metadataPath: string; payloadArg: string } {
	let metadataPath = "";
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "--metadata") {
			metadataPath = args[i + 1] || "";
			i += 1;
		}
	}
	return {
		metadataPath,
		payloadArg: process.argv[process.argv.length - 1] || "",
	};
}

function isCommand(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function sameCommand(
	left: readonly string[] | null | undefined,
	right: readonly string[] | null | undefined,
): boolean {
	if (!left || !right || left.length !== right.length) return false;
	return left.every((part, index) => part === right[index]);
}

function resolveNotifyEntrypoint(command: readonly string[]): string | undefined {
	if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(command[0] ?? "")) {
		return command[0];
	}
	return command.slice(1).find((arg) => !arg.startsWith("-"));
}

function getPreviousNotifyWrapperValue(
	command: readonly string[],
): string | undefined {
	for (let index = 0; index < command.length; index += 1) {
		const part = command[index];
		if (part === "--previous-notify") {
			return command[index + 1];
		}
		if (part.startsWith("--previous-notify=")) {
			return part.slice("--previous-notify=".length);
		}
	}
	return undefined;
}

function isOmxManagedNotifyCommand(command: readonly string[] | null | undefined): boolean {
	if (!command) return false;
	const entrypoint = resolveNotifyEntrypoint(command);
	if (!entrypoint) return false;
	if (!/(?:^|[\\/])notify-(?:hook|dispatcher)\.js$/.test(entrypoint)) {
		return false;
	}
	return /(?:^|[\\/])oh-my-codex(?:[\\/]|$)/.test(entrypoint);
}

function isOmxDispatcherMetadataCommand(command: readonly string[] | null | undefined): boolean {
	if (!command) return false;
	const entrypoint = resolveNotifyEntrypoint(command);
	if (!entrypoint || !/(?:^|[\\/])notify-dispatcher\.js$/.test(entrypoint)) {
		return false;
	}
	const metadataIndex = command.indexOf("--metadata");
	const metadataPath = metadataIndex >= 0 ? command[metadataIndex + 1] : undefined;
	return typeof metadataPath === "string" && /(?:^|[\\/])(?:\.omx[\\/])?notify-dispatch\.json$/.test(metadataPath);
}

function isOmxManagedPayloadText(value: string): boolean {
	const containsManagedPackageNotify =
		/(?:^|[\\/])notify-(?:hook|dispatcher)\.js(?:\s|$|["'])/.test(
			value,
		) && /(?:^|[\\/])oh-my-codex(?:[\\/]|$)/.test(value);
	const containsDispatcherMetadataNotify =
		/(?:^|[\\/])notify-dispatcher\.js(?:\s|$|["'])/.test(value) &&
		/--metadata(?:\s|=)/.test(value) &&
		/(?:^|[\\/])(?:\.omx[\\/])?notify-dispatch\.json(?:\s|$|["'])/.test(value);
	return containsManagedPackageNotify || containsDispatcherMetadataNotify;
}

function parseJsonString(value: string): unknown | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const first = trimmed[0];
	if (first !== "[" && first !== "{" && first !== '"') return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function containsOmxManagedNotifyPayload(value: unknown, depth = 0): boolean {
	if (depth > 8 || value == null) return false;
	if (typeof value === "string") {
		const parsed = parseJsonString(value);
		if (parsed !== undefined && parsed !== value) {
			return containsOmxManagedNotifyPayload(parsed, depth + 1);
		}
		return isOmxManagedPayloadText(value);
	}
	if (Array.isArray(value)) {
		if (value.every((item) => typeof item === "string")) {
			const command = value as string[];
			return (
				isOmxManagedNotifyCommand(command) ||
				isOmxDispatcherMetadataCommand(command) ||
				isOmxManagedPreviousNotifyWrapper(command)
			);
		}
		return value.some((item) => containsOmxManagedNotifyPayload(item, depth + 1));
	}
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return [
			record.previousNotify,
			record.previous_notify,
			record.notify,
			record.command,
			record.argv,
			record.args,
		].some((item) => containsOmxManagedNotifyPayload(item, depth + 1));
	}
	return false;
}

function isOmxManagedPreviousNotifyWrapper(
	command: readonly string[] | null | undefined,
): boolean {
	if (!command) return false;
	if (!command.some((part) => part === "turn-ended")) return false;
	const previousNotify = getPreviousNotifyWrapperValue(command);
	if (!previousNotify) return false;

	return containsOmxManagedNotifyPayload(previousNotify);
}

function isManagedPreviousNotify(
	previousNotify: readonly string[] | null | undefined,
	metadata: NotifyDispatcherMetadata | null,
): boolean {
	return (
		isOmxManagedNotifyCommand(previousNotify) ||
		isOmxDispatcherMetadataCommand(previousNotify) ||
		isOmxManagedPreviousNotifyWrapper(previousNotify) ||
		sameCommand(previousNotify, metadata?.omxNotify) ||
		sameCommand(previousNotify, metadata?.dispatcherNotify)
	);
}

async function readMetadata(
	path: string,
): Promise<NotifyDispatcherMetadata | null> {
	if (!path) return null;
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as NotifyDispatcherMetadata;
	} catch {
		return null;
	}
}

function runNotify(
	command: string[] | null | undefined,
	payloadArg: string,
): void {
	if (!isCommand(command) || command.length === 0) return;
	const [bin, ...args] = command;
	spawnSync(bin, [...args, payloadArg], {
		stdio: "ignore",
		env: process.env,
		windowsHide: true,
		timeout: 30_000,
	});
}

async function main(): Promise<void> {
	const { metadataPath, payloadArg } = parseArgs();
	if (!payloadArg || payloadArg.startsWith("-")) return;
	const guard = acquireTurnDispatchGuard(metadataPath, payloadArg);
	if (!guard.ok) return;
	try {
		const metadata = await readMetadata(metadataPath);
		if (!isManagedPreviousNotify(metadata?.previousNotify, metadata)) {
			runNotify(metadata?.previousNotify, payloadArg);
		}
		runNotify(metadata?.omxNotify, payloadArg);
	} finally {
		guard.release?.();
	}
}

main().catch(() => {});
