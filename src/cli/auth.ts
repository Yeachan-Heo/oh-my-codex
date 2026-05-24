import { dirname } from "path";
import { spawnPlatformCommandSync, classifySpawnError } from "../utils/platform-command.js";
import { readAuthConfig } from "../auth/config.js";
import { resolveLiveAuthPath } from "../auth/paths.js";
import { redactAuthSecrets } from "../auth/redact.js";
import { addSlotFromAuthFile, listSlots, useSlot } from "../auth/storage.js";

export const AUTH_HELP = `
Usage:
  omx auth add <slot>      Log in with Codex OAuth and store auth.json as a named slot
  omx auth list [--json]   List registered auth slots and local quota metadata
  omx auth use <slot>      Atomically switch live Codex auth.json to a slot
  omx auth --help          Show this help

Auth slots are stored under ~/.omx/auth/<slot>.json with owner-only permissions.
`;

function wantsJson(args: string[]): boolean {
  return args.includes("--json");
}

function runCodexLogin(cwd: string, env: NodeJS.ProcessEnv): void {
  const { result } = spawnPlatformCommandSync("codex", ["login"], {
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
    if (!slot) throw new Error("Usage: omx auth add <slot>");
    const liveAuthPath = resolveLiveAuthPath(cwd, env, home);
    runCodexLogin(cwd, { ...env, CODEX_HOME: dirname(liveAuthPath) });
    const record = await addSlotFromAuthFile(slot, liveAuthPath, home);
    console.log(`Added auth slot ${record.slot}`);
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
