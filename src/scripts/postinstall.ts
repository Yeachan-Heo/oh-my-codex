import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isInstallVersionBump,
  readUserInstallStamp,
  type UserInstallStamp,
  writeUserInstallStamp,
} from "../cli/update.js";
import { setup } from "../cli/setup.js";
import { getPackageRoot } from "../utils/package.js";

type PostinstallStatus =
  | "noop-local"
  | "noop-same-version"
  | "noop-missing-version"
  | "hinted"
  | "setup-ran"
  | "setup-failed";

export interface PostinstallResult {
  status: PostinstallStatus;
  version: string | null;
}

interface PostinstallDependencies {
  env: NodeJS.ProcessEnv;
  getCurrentVersion: () => Promise<string | null>;
  isInteractive: () => boolean;
  log: (message: string) => void;
  readStamp: () => Promise<UserInstallStamp | null>;
  runSetup: typeof setup;
  warn: (message: string) => void;
  writeStamp: (stamp: UserInstallStamp) => Promise<void>;
}

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function isGlobalInstallLifecycle(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnv(env.npm_config_global) || env.npm_config_location === "global";
}

function resolveInstallRoot(env: NodeJS.ProcessEnv): string {
  const installPrefix = env.npm_config_prefix?.trim() || env.npm_config_local_prefix?.trim();
  return installPrefix ? resolve(installPrefix) : process.cwd();
}

async function runSetupFromInstallRoot(
  runSetup: typeof setup,
  installRoot: string,
): Promise<void> {
  const previousCwd = process.cwd();
  if (previousCwd === installRoot) {
    await runSetup();
    return;
  }

  process.chdir(installRoot);
  try {
    await runSetup();
  } finally {
    process.chdir(previousCwd);
  }
}

async function getCurrentVersion(): Promise<string | null> {
  try {
    const packageJsonPath = join(getPackageRoot(), "package.json");
    const content = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(content) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

const defaultDependencies: PostinstallDependencies = {
  env: process.env,
  getCurrentVersion,
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log: (message) => console.log(message),
  readStamp: () => readUserInstallStamp(),
  runSetup: setup,
  warn: (message) => console.warn(message),
  writeStamp: (stamp) => writeUserInstallStamp(stamp),
};

export async function runPostinstall(
  dependencies: Partial<PostinstallDependencies> = {},
): Promise<PostinstallResult> {
  const resolved = { ...defaultDependencies, ...dependencies };
  const { env } = resolved;

  if (!isGlobalInstallLifecycle(env)) {
    return { status: "noop-local", version: null };
  }

  const currentVersion = await resolved.getCurrentVersion();
  if (!currentVersion) {
    return { status: "noop-missing-version", version: null };
  }

  const currentStampVersion = stripLeadingV(currentVersion);
  const existingStamp = await resolved.readStamp();
  if (!isInstallVersionBump(currentVersion, existingStamp)) {
    return { status: "noop-same-version", version: currentStampVersion };
  }

  await resolved.writeStamp({
    installed_version: currentStampVersion,
    ...(typeof existingStamp?.setup_completed_version === "string"
      ? { setup_completed_version: existingStamp.setup_completed_version }
      : {}),
    updated_at: new Date().toISOString(),
  });

  if (!resolved.isInteractive()) {
    resolved.log(
      `[omx] Installed oh-my-codex v${currentStampVersion}. Run \`omx setup\` (interactive) or \`omx update\` when you're ready.`,
    );
    return { status: "hinted", version: currentStampVersion };
  }

  resolved.log(
    `[omx] Detected oh-my-codex v${currentStampVersion} install/update. Launching interactive setup...`,
  );

  try {
    await runSetupFromInstallRoot(resolved.runSetup, resolveInstallRoot(env));
    await resolved.writeStamp({
      installed_version: currentStampVersion,
      setup_completed_version: currentStampVersion,
      updated_at: new Date().toISOString(),
    });
    resolved.log(`[omx] Setup refresh completed for v${currentStampVersion}.`);
    return { status: "setup-ran", version: currentStampVersion };
  } catch (error) {
    resolved.warn(
      `[omx] Postinstall setup skipped after a non-fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "setup-failed", version: currentStampVersion };
  }
}

export async function main(): Promise<void> {
  await runPostinstall();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.warn(
      `[omx] Postinstall setup skipped after a non-fatal error: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
