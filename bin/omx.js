#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

function platformBundleBinaryRelativePath() {
	switch (process.platform) {
		case "linux":
			return "omx-x86_64-unknown-linux-gnu/omx";
		case "darwin":
			return process.arch === "arm64"
				? "omx-aarch64-apple-darwin/omx"
				: "omx-x86_64-apple-darwin/omx";
		case "win32":
			return "omx-x86_64-pc-windows-msvc/omx.exe";
		default:
			return null;
	}
}

function candidateNativeBins() {
	const envOverride = process.env.OMX_RUST_BIN
		? [resolve(process.cwd(), process.env.OMX_RUST_BIN)]
		: [];
	const bundleRelative = platformBundleBinaryRelativePath();
	const bundled = bundleRelative
		? [
				join(root, "release", bundleRelative),
				join(root, "native", bundleRelative),
			]
		: [];
	const local =
		process.platform === "win32"
			? [
					join(root, "target", "debug", "omx.exe"),
					join(root, "bin", "omx.exe"),
					join(root, "bin", "omx-native.exe"),
				]
			: [
					join(root, "target", "debug", "omx"),
					join(root, "bin", "omx"),
					join(root, "bin", "omx-native"),
				];

	return [...envOverride, ...bundled, ...local];
}

function resolveNativeBin() {
	return candidateNativeBins().find((candidate) => existsSync(candidate));
}

const nativeBin = resolveNativeBin();

if (!nativeBin) {
	console.error("oh-my-codex: native omx binary not found.");
	console.error("Searched:");
	for (const candidate of candidateNativeBins()) {
		console.error(`  - ${candidate}`);
	}
	console.error('Build the Rust CLI with "cargo build" or set OMX_RUST_BIN.');
	process.exit(1);
}

const result = spawnSync(nativeBin, process.argv.slice(2), {
	stdio: "inherit",
	env: process.env,
});

if (result.error) {
	console.error(`oh-my-codex: failed to launch native binary at ${nativeBin}`);
	console.error(result.error.message);
	process.exit(1);
}

if (result.signal) {
	process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
