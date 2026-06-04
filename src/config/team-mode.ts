import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../utils/paths.js";

export const SETUP_TEAM_MODES = ["enabled", "disabled"] as const;
export type SetupTeamMode = (typeof SETUP_TEAM_MODES)[number];

export interface TeamModeConfig {
	enabled: boolean;
	status: "enabled" | "disabled" | "defaulted" | "invalid";
	source: "default" | "env" | "setup" | "file" | "invalid";
	path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function booleanFromNestedConfig(parsed: unknown): boolean | undefined {
	if (!isRecord(parsed)) return undefined;

	const topLevel = parsed.teamMode;
	if (topLevel === "enabled") return true;
	if (topLevel === "disabled") return false;
	if (isRecord(topLevel) && typeof topLevel.enabled === "boolean") {
		return topLevel.enabled;
	}

	const orchestration = parsed.orchestration;
	if (isRecord(orchestration)) {
		const team = orchestration.team;
		if (isRecord(team) && typeof team.enabled === "boolean") {
			return team.enabled;
		}
	}

	const features = parsed.features;
	if (isRecord(features)) {
		const team = features.team;
		if (isRecord(team) && typeof team.enabled === "boolean") {
			return team.enabled;
		}
		if (typeof team === "boolean") return team;
	}

	return undefined;
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function readBooleanFromJson(path: string): boolean | undefined {
	if (!existsSync(path)) return undefined;
	return booleanFromNestedConfig(readJson(path));
}

export function isSetupTeamMode(value: string): value is SetupTeamMode {
	return SETUP_TEAM_MODES.includes(value as SetupTeamMode);
}

export function teamModeEnabled(mode: SetupTeamMode | undefined): boolean {
	return mode !== "disabled";
}

export function readTeamModeConfig(cwd = process.cwd()): TeamModeConfig {
	const env = process.env.OMX_TEAM_MODE?.trim().toLowerCase();
	if (env === "enabled" || env === "1" || env === "true") {
		return { enabled: true, status: "enabled", source: "env" };
	}
	if (env === "disabled" || env === "0" || env === "false") {
		return { enabled: false, status: "disabled", source: "env" };
	}

	const setupPath = join(cwd, ".omx", "setup-scope.json");
	try {
		const enabled = readBooleanFromJson(setupPath);
		if (enabled !== undefined) {
			return {
				enabled,
				status: enabled ? "enabled" : "disabled",
				source: "setup",
				path: setupPath,
			};
		}
	} catch {
		return { enabled: true, status: "invalid", source: "invalid", path: setupPath };
	}

	const userConfigPath = join(codexHome(), ".omx-config.json");
	try {
		const enabled = readBooleanFromJson(userConfigPath);
		if (enabled !== undefined) {
			return {
				enabled,
				status: enabled ? "enabled" : "disabled",
				source: "file",
				path: userConfigPath,
			};
		}
	} catch {
		return { enabled: true, status: "invalid", source: "invalid", path: userConfigPath };
	}

	return { enabled: true, status: "defaulted", source: "default" };
}
