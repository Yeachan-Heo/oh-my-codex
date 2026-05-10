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

function isOmxManagedNotifyCommand(command: readonly string[] | null | undefined): boolean {
	if (!command) return false;
	const entrypoint = resolveNotifyEntrypoint(command);
	if (!entrypoint) return false;
	if (!/(?:^|[\\/])notify-(?:hook|dispatcher)\.js$/.test(entrypoint)) {
		return false;
	}
	return /(?:^|[\\/])oh-my-codex(?:[\\/]|$)/.test(entrypoint);
}

function isManagedPreviousNotify(
	previousNotify: readonly string[] | null | undefined,
	metadata: NotifyDispatcherMetadata | null,
): boolean {
	return (
		isOmxManagedNotifyCommand(previousNotify) ||
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
