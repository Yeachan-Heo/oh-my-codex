import { dirname, join } from "path";
import { homedir } from "os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { spawnPlatformCommandSync, classifySpawnError } from "../utils/platform-command.js";
import { readAuthConfig } from "../auth/config.js";
import { resolveLiveAuthPath } from "../auth/paths.js";
import { redactAuthSecrets } from "../auth/redact.js";
import { addSlotFromAuthFile, listSlots, useSlot } from "../auth/storage.js";
import { readTopLevelTomlString, upsertTopLevelTomlString } from "../utils/toml.js";

export const AUTH_HELP = `
Usage:
  omx auth add <slot> [codex login flags]
                Log in with Codex OAuth and store auth.json as a named slot
                Supported flags include: --device-auth, --with-api-key, --with-access-token
  omx auth list [--json]   List registered auth slots and local quota metadata
  omx auth use <slot>      Atomically switch live Codex auth.json to a slot
  omx auth --help          Show this help

Auth slots are stored under ~/.omx/auth/<slot>.json with owner-only permissions.
`;

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}
const DEFAULT_SUBSCRIPTION_MODEL = "gpt-5-codex";
const DEFAULT_SUBSCRIPTION_MODEL_PROVIDER = "openai-chatgpt";


function validateCodexLoginArgs(args: string[]): void {
  const allowed = new Set(["--device-auth", "--with-api-key", "--with-access-token"]);
  for (const arg of args) {
    if (!allowed.has(arg)) {
      throw new Error(`unsupported codex login flag for omx auth add: ${arg}`);
    }
  }
}

function runCodexLogin(cwd: string, env: NodeJS.ProcessEnv, loginArgs: string[] = []): void {
  validateCodexLoginArgs(loginArgs);
  const { result } = spawnPlatformCommandSync("codex", ["login", ...loginArgs], {
    cwd,
    env,
    stdio: "inherit",
    encoding: "utf-8",
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    const kind = classifySpawnError(error);
    if (kind === "missing") throw new Error("failed to launch codex login: executable not found in PATH");
    if (kind === "blocked") throw new Error(`failed to launch codex login: executable is blocked (${error.code || "blocked"})`);
    throw error;
  }
  if (result.status !== 0) {
    throw new Error(`codex login exited with code ${result.status ?? 1}`);
  }
}
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createIsolatedLoginCodexHome(home: string | undefined): Promise<string> {
  const base = join(home || homedir(), ".omx");
  await mkdir(base, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(base, "auth-login-"));
}

async function ensureSubscriptionCodexDefaults(codexHome: string): Promise<void> {
  const configPath = join(codexHome, "config.toml");
  let existing = "";
  try {
    existing = await readFile(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (
    readTopLevelTomlString(existing, "model") !== null ||
    readTopLevelTomlString(existing, "model_provider") !== null
  ) {
    return;
  }

  let updated = upsertTopLevelTomlString(existing, "model", DEFAULT_SUBSCRIPTION_MODEL);
  updated = upsertTopLevelTomlString(updated, "model_provider", DEFAULT_SUBSCRIPTION_MODEL_PROVIDER);
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, updated);
}


export async function authCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const command = args[0];
  const cwd = process.cwd();
  const home = env.HOME;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(AUTH_HELP.trim());
    return;
  }

  if (command === "add") {
    const slot = args[1];
    if (!slot) throw new Error("Usage: omx auth add <slot> [--device-auth|--with-api-key|--with-access-token]");
    const loginArgs = args.slice(2);
    const liveAuthPath = resolveLiveAuthPath(cwd, env, home);
    const hadLiveAuth = await fileExists(liveAuthPath);
    const tempCodexHome = await createIsolatedLoginCodexHome(home);
    try {
      runCodexLogin(cwd, { ...env, CODEX_HOME: tempCodexHome }, loginArgs);
      const tempAuthPath = join(tempCodexHome, "auth.json");
      const record = await addSlotFromAuthFile(slot, tempAuthPath, home);
      await ensureSubscriptionCodexDefaults(dirname(liveAuthPath));
      if (!hadLiveAuth) {
        await useSlot(slot, liveAuthPath, home);
      }
      console.log(`Added auth slot ${record.slot}`);
    } finally {
      await rm(tempCodexHome, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }

  if (command === "list") {
    const slots = await listSlots(home);
    const config = await readAuthConfig(cwd, home);
    if (wantsJson(args)) {
      console.log(JSON.stringify({ slots, config: { rotation: config.rotation, priority: config.priority } }, null, 2));
      return;
    }
    if (slots.length === 0) {
      console.log("No auth slots configured. Run `omx auth add <slot>` first.");
      return;
    }
    for (const slot of slots) {
      const quota = slot.exhaustedAt ? ` exhausted=${slot.exhaustedAt}` : slot.lastQuotaAt ? ` last-quota=${slot.lastQuotaAt}` : "";
      const used = slot.lastUsedAt ? ` last-used=${slot.lastUsedAt}` : "";
      console.log(`${slot.slot}${used}${quota}`);
    }
    return;
  }

  if (command === "use") {
    const slot = args[1];
    if (!slot) throw new Error("Usage: omx auth use <slot>");
    const liveAuthPath = resolveLiveAuthPath(cwd, env, home);
    const record = await useSlot(slot, liveAuthPath, home);
    console.log(`Using auth slot ${record.slot}`);
    return;
  }

  throw new Error(`Unknown auth command: ${command}\n${AUTH_HELP.trim()}`);
}

export function formatAuthError(err: unknown): string {
  return redactAuthSecrets(err);
}
