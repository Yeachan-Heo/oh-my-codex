import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../utils/paths.js";

/**
 * Multiplexer backend selection for OMX-managed team runtimes.
 *
 * Resolution order mirrors readTeamModeConfig (src/config/team-mode.ts):
 *   1. env OMX_MULTIPLEXER
 *   2. project .omx/setup-scope.json (`multiplexer`)
 *   3. $CODEX_HOME/.omx-config.json (`multiplexer` or `features.multiplexer`)
 *   4. default "tmux" (zero behavior change)
 *
 * Invalid values fall back to "tmux" with status/source "invalid" so a
 * hand-edited config never bricks team mode.
 */
export const MULTIPLEXER_BACKENDS = ["tmux", "herdr"] as const;
export type MultiplexerBackend = (typeof MULTIPLEXER_BACKENDS)[number];

export const DEFAULT_MULTIPLEXER_BACKEND: MultiplexerBackend = "tmux";

export interface MultiplexerConfig {
	backend: MultiplexerBackend;
	status: MultiplexerBackend | "defaulted" | "invalid";
	source: "default" | "env" | "setup" | "file" | "invalid";
	path?: string;
}

export interface ReadMultiplexerOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	codexHomeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMultiplexerBackend(value: unknown): value is MultiplexerBackend {
	return (
		typeof value === "string" &&
		MULTIPLEXER_BACKENDS.includes(value as MultiplexerBackend)
	);
}

function backendFromNestedConfig(parsed: unknown): MultiplexerBackend | undefined {
	if (!isRecord(parsed)) return undefined;

	const topLevel = parsed.multiplexer;
	if (isMultiplexerBackend(topLevel)) return topLevel;

	const features = parsed.features;
	if (isRecord(features)) {
		const nested = features.multiplexer;
		if (isMultiplexerBackend(nested)) return nested;
	}

	return undefined;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function readBackendFromJson(path: string): MultiplexerBackend | undefined {
	if (!existsSync(path)) return undefined;
	return backendFromNestedConfig(readJson(path));
}

function invalidConfig(path: string): MultiplexerConfig {
	return {
		backend: DEFAULT_MULTIPLEXER_BACKEND,
		status: "invalid",
		source: "invalid",
		path,
	};
}

export function readMultiplexerConfig(
	options: ReadMultiplexerOptions = {},
): MultiplexerConfig {
	const env = options.env ?? process.env;

	const envValue = env.OMX_MULTIPLEXER?.trim().toLowerCase();
	if (envValue !== undefined && envValue !== "") {
		if (isMultiplexerBackend(envValue)) {
			return { backend: envValue, status: envValue, source: "env" };
		}
		return invalidConfig("env:OMX_MULTIPLEXER");
	}

	const cwd = options.cwd ?? process.cwd();
	const setupPath = join(cwd, ".omx", "setup-scope.json");
	try {
		const backend = readBackendFromJson(setupPath);
		if (backend !== undefined) {
			return { backend, status: backend, source: "setup", path: setupPath };
		}
	} catch {
		return invalidConfig(setupPath);
	}

	const userConfigPath = join(
		options.codexHomeDir ?? codexHome(),
		".omx-config.json",
	);
	try {
		const backend = readBackendFromJson(userConfigPath);
		if (backend !== undefined) {
			return { backend, status: backend, source: "file", path: userConfigPath };
		}
	} catch {
		return invalidConfig(userConfigPath);
	}

	return {
		backend: DEFAULT_MULTIPLEXER_BACKEND,
		status: "defaulted",
		source: "default",
	};
}
