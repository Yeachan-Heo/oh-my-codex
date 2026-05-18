#!/usr/bin/env node

/**
 * oh-my-codex notify dispatcher.
 * Runs a pre-existing user notify command first, then the OMX notify hook.
 */

import { readFile } from "fs/promises";
import { spawnSync } from "child_process";

interface NotifyDispatcherMetadata {
	managedBy?: string;
	version?: number;
	previousNotify?: string[] | null;
	omxNotify?: string[];
	dispatcherNotify?: string[];
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
	const metadata = await readMetadata(metadataPath);
	if (!isManagedPreviousNotify(metadata?.previousNotify, metadata)) {
		runNotify(metadata?.previousNotify, payloadArg);
	}
	runNotify(metadata?.omxNotify, payloadArg);
}

main().catch(() => {});
