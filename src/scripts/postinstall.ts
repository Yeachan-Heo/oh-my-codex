import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isInstallVersionBump,
  readUserInstallStamp,
  type UserInstallStamp,
  writeUserInstallStamp,
} from './postinstall-advisory.js';
import { getPackageRoot } from "../utils/package.js";
import { hydrateNativeBinary } from "../cli/native-assets.js";

type PostinstallStatus =
  | "noop-local"
  | "noop-same-version"
  | "noop-missing-version"
  | "hinted";

export interface PostinstallResult {
  status: PostinstallStatus;
  version: string | null;
}

interface PostinstallDependencies {
  env: NodeJS.ProcessEnv;
  getCurrentVersion: () => Promise<string | null>;
  log: (message: string) => void;
  hydrateRuntime: () => Promise<string | undefined>;
  readStamp: () => Promise<UserInstallStamp | null>;
  writeStamp: (stamp: UserInstallStamp) => Promise<void>;
}

const RUNTIME_HYDRATION_TIMEOUT_MS = 120_000;

export async function hydrateOmxRuntime(options: {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  timeoutMs?: number;
} = {}): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_HYDRATION_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  try {
    return await hydrateNativeBinary("omx-runtime", {
      packageRoot: options.packageRoot,
      env: options.env,
      platform: options.platform,
      arch: options.arch,
      signal: controller.signal,
      strictManifestErrors: true,
    });
  } catch (error) {
    if (!timedOut) throw error;
    const detail = redactHydrationDiagnosticUrls(error instanceof Error ? error.message : String(error));
    const cause = deepestErrorMessage(error);
    throw new Error(
      `[omx] omx-runtime hydration timed out after ${timeoutMs} ms: ${detail}; cause: ${cause}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function hydrateOmxRuntimeNonFatal(options: {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (message: string) => void;
  timeoutMs?: number;
} = {}): Promise<string | undefined> {
  const log = options.log ?? ((message: string) => console.log(message));
  try {
    const runtimePath = await hydrateOmxRuntime(options);
    if (runtimePath) log(`[omx] Hydrated omx-runtime for this platform: ${runtimePath}`);
    else log("[omx] omx-runtime was not available for this platform; native runtime features remain disabled.");
    return runtimePath;
  } catch (error) {
    const message = redactHydrationDiagnosticUrls(error instanceof Error ? error.message : String(error));
    log(`[omx] omx-runtime hydration failed non-fatally: ${message}`);
    return undefined;
  }
}

function deepestErrorMessage(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && current.cause !== undefined && !seen.has(current)) {
    seen.add(current);
    current = current.cause;
  }
  return redactHydrationDiagnosticUrls(current instanceof Error ? current.message : String(current));
}

function redactHydrationDiagnosticUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[URL redacted]";
    }
  });
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
  log: (message) => console.log(message),
  hydrateRuntime: () => hydrateOmxRuntimeNonFatal(),
  readStamp: () => readUserInstallStamp(),
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
  try {
    const runtimePath = await resolved.hydrateRuntime();
    if (runtimePath) {
      resolved.log(`[omx] Hydrated omx-runtime for this platform: ${runtimePath}`);
    } else {
      resolved.log(
        "[omx] omx-runtime was not available for this platform; native runtime features remain disabled.",
      );
    }
  } catch (error) {
    resolved.log(
      `[omx] omx-runtime hydration failed non-fatally: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

  resolved.log(
    `[omx] Installed oh-my-codex v${currentStampVersion}. OMX setup is explicit opt-in; run \`omx setup\` or \`omx update\` when you're ready.`,
  );
  return { status: "hinted", version: currentStampVersion };
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
