import { spawn } from "child_process";
import { dirname } from "path";
import { homedir } from "os";
import { buildPlatformCommandSpec, classifySpawnError } from "../utils/platform-command.js";
import { readAuthConfig } from "./config.js";
import { isQuotaError } from "./quota-detector.js";
import { redactAuthSecrets } from "./redact.js";
import { buildRotationPlan, nextSlotAfter } from "./rotation.js";
import { findLatestRolloutSession } from "./sessions.js";
import { listSlots, markSlotQuota, readAuthMetadata, useSlot } from "./storage.js";
import { isSessionPointerLaunchAbort } from "../hooks/session.js";

export interface PreparedHotswapCodexHome {
  codexHomeOverride?: string;
  sqliteHomeOverride?: string;
  projectLocalCodexHomeForCleanup?: string;
  runtimeCodexHomeForCleanup?: string;
}

export interface HotswapLifecycle {
  prepareCodexHomeForLaunch: (cwd: string, sessionId: string, env: NodeJS.ProcessEnv) => Promise<PreparedHotswapCodexHome>;
  preLaunch: (
    cwd: string,
    sessionId: string,
    notifyTempContract: unknown,
    codexHomeOverride: string | undefined,
    enableNotifyFallbackAuthority: boolean,
    worktreeDirty: boolean,
  ) => Promise<void>;
  postLaunch: (
    cwd: string,
    sessionId: string,
    codexHomeOverride: string | undefined,
    enableNotifyFallbackAuthority: boolean,
    projectLocalCodexHomeForCleanup?: string,
  ) => Promise<void>;
  cleanupRuntimeCodexHome: (runtimeCodexHome?: string, projectCodexHome?: string) => Promise<void>;
  normalizeCodexLaunchArgs: (args: string[]) => string[];
  injectModelInstructionsBypassArgs: (cwd: string, args: string[], env: NodeJS.ProcessEnv, defaultFilePath?: string) => string[];
  sessionModelInstructionsPath: (cwd: string, sessionId: string) => string;
  resolveOmxRootForLaunch: (cwd: string, env: NodeJS.ProcessEnv) => string | undefined;
  resolveNotifyTempContract: (args: string[], env: NodeJS.ProcessEnv) => {
    contract: unknown;
    passthroughArgs: string[];
  };
}

export interface HotswapOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  argv: string[];
  lifecycle: HotswapLifecycle;
}

export interface CodexRunResult {
  status: number;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export function stripHotswapArg(args: string[]): string[] {
  return args.filter((arg) => arg !== "--hotswap");
}

function isAuthInvalidationError(stderr: string | undefined): boolean {
  return /token_invalidated|refresh_token_invalidated|authentication token has been invalidated/i.test(stderr || "");
}

async function runCodexDirect(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CodexRunResult> {
  const spec = buildPlatformCommandSpec("codex", args, process.platform, env);
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd,
      env,
      stdio: ["inherit", "inherit", "pipe"],
      ...(process.platform === "win32" ? { windowsHide: true } : {}),
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = redactAuthSecrets(chunk.toString("utf-8"));
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const kind = classifySpawnError(error);
      if (kind === "missing") {
        reject(new Error("failed to launch codex: executable not found in PATH"));
      } else if (kind === "blocked") {
        reject(new Error(`failed to launch codex: executable is blocked (${error.code || "blocked"})`));
      } else {
        reject(error);
      }
    });
    child.on("close", (status, signal) => {
      resolve({ status: typeof status === "number" ? status : 1, signal, stderr });
    });
  });
}

export function buildResumeArgsWithPreservedFlags(originalArgs: string[], sessionId: string): string[] {
  const preserved: string[] = [];
  for (let index = 0; index < originalArgs.length; index++) {
    const arg = originalArgs[index];
    if (arg === "--") break;
    if (arg === "-c" || arg === "--config" || arg === "--model" || arg === "-m") {
      preserved.push(arg);
      const value = originalArgs[index + 1];
      if (value && !value.startsWith("-")) {
        preserved.push(value);
        index += 1;
      }
      continue;
    }
    if (
      arg.startsWith("--config=") ||
      arg.startsWith("--model=") ||
      arg === "--dangerously-bypass-approvals-and-sandbox"
    ) {
      preserved.push(arg);
    }
  }
  return ["resume", sessionId, ...preserved];
}

function codexHomeFromAuthPath(authPath: string): string {
  return dirname(authPath);
}

function hotswapSessionId(): string {
  return `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function runAuthHotswap(options: HotswapOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const lifecycle = options.lifecycle;
  const rawArgs = stripHotswapArg(options.argv);
  const notifyTempResult = lifecycle.resolveNotifyTempContract(rawArgs, env);
  const normalizedArgs = lifecycle.normalizeCodexLaunchArgs(notifyTempResult.passthroughArgs.filter((arg) => arg !== "--direct" && arg !== "--tmux"));
  const config = await readAuthConfig(cwd, home);
  const slots = await listSlots(home);
  if (slots.length === 0) {
    process.stderr.write("[omx auth] no slots configured; run `omx auth add <slot>` first.\n");
    return 1;
  }

  const sessionId = hotswapSessionId();
  const prepared = await lifecycle.prepareCodexHomeForLaunch(cwd, sessionId, env);
  const childCodexHome = prepared.codexHomeOverride || (env.CODEX_HOME && env.CODEX_HOME.trim()) || `${home}/.codex`;
  const liveAuthPath = `${childCodexHome}/auth.json`;
  const metadata = await readAuthMetadata(home);
  const plan = buildRotationPlan(slots, config, metadata.currentSlot);
  let currentSlot = plan.order[0];
  if (!currentSlot) {
    process.stderr.write("[omx auth] no slots configured; run `omx auth add <slot>` first.\n");
    return 1;
  }

  const exhausted = new Set<string>();
  let resumeArgs: string[] | null = null;
  let skipPostLaunch = false;
  try {
    try {
      await lifecycle.preLaunch(cwd, sessionId, notifyTempResult.contract, prepared.codexHomeOverride, true, false);
    } catch (err) {
      if (isSessionPointerLaunchAbort(err)) {
        skipPostLaunch = true;
        process.stderr.write(`[omx auth] session pointer launch aborted: ${err.code}\n`);
      }
      throw err;
    }
    await useSlot(currentSlot, liveAuthPath, home);
    const baseEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(prepared.codexHomeOverride ? { CODEX_HOME: prepared.codexHomeOverride } : {}),
      ...(prepared.sqliteHomeOverride ? { CODEX_SQLITE_HOME: prepared.sqliteHomeOverride } : {}),
    };
    const omxRoot = lifecycle.resolveOmxRootForLaunch(cwd, env);
    if (omxRoot) baseEnv.OMX_ROOT = omxRoot;

    for (let attempt = 0; attempt < plan.order.length; attempt++) {
      const attemptArgs = lifecycle.injectModelInstructionsBypassArgs(
        cwd,
        resumeArgs ?? normalizedArgs,
        baseEnv,
        lifecycle.sessionModelInstructionsPath(cwd, sessionId),
      );
      process.stderr.write(`[omx auth] using slot ${currentSlot}\n`);
      const result = await runCodexDirect(cwd, attemptArgs, baseEnv);
      if (result.status === 0) return 0;
      const authInvalid = isAuthInvalidationError(result.stderr);
      const quota = isQuotaError({ status: result.status, signal: result.signal, stderr: result.stderr }, config);
      if (!quota && !authInvalid) {
        return result.status || 1;
      }

      if (quota) await markSlotQuota(currentSlot, home);
      exhausted.add(currentSlot);
      if (plan.mode === "manual") {
        const reason = authInvalid ? "token invalidated" : "quota detected";
        process.stderr.write(
          `[omx auth] ${reason} for slot ${currentSlot}; rotation=manual, run \`omx auth use <slot>\` or \`omx auth add ${currentSlot} --device-auth\`.\n`,
        );
        return 1;
      }

      const next = nextSlotAfter(plan.order, currentSlot, exhausted);
      if (!next) {
        process.stderr.write(`[omx auth] all slots exhausted or invalid: ${[...exhausted].join(", ")}\n`);
        return 1;
      }
      if (authInvalid) {
        process.stderr.write(
          `[omx auth] token invalidated for slot ${currentSlot}; rotating to slot ${next}. Refresh it later with \`omx auth add ${currentSlot} --device-auth\`.\n`,
        );
        currentSlot = next;
        await useSlot(currentSlot, liveAuthPath, home);
        continue;
      }
      const latest = await findLatestRolloutSession(codexHomeFromAuthPath(liveAuthPath), home);
      if (!latest) {
        process.stderr.write("[omx auth] quota detected but no Codex rollout session was found to resume.\n");
        return 1;
      }
      currentSlot = next;
      await useSlot(currentSlot, liveAuthPath, home);
      resumeArgs = buildResumeArgsWithPreservedFlags(normalizedArgs, latest.id);
      process.stderr.write(`[omx auth] quota detected; rotating to slot ${currentSlot} and resuming ${latest.id}\n`);
    }

    process.stderr.write(`[omx auth] all slots exhausted: ${plan.order.join(", ")}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(`[omx auth] ${redactAuthSecrets(err)}\n`);
    return 1;
  } finally {
    if (!skipPostLaunch) {
      await lifecycle.postLaunch(cwd, sessionId, prepared.codexHomeOverride, true, prepared.projectLocalCodexHomeForCleanup).catch((err) => {
        process.stderr.write(`[omx auth] postLaunch warning: ${redactAuthSecrets(err)}\n`);
      });
    }
    await lifecycle.cleanupRuntimeCodexHome(prepared.runtimeCodexHomeForCleanup, prepared.projectLocalCodexHomeForCleanup).catch((err) => {
      process.stderr.write(`[omx auth] cleanup warning: ${redactAuthSecrets(err)}\n`);
    });
  }
}
