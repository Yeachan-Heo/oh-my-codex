import { homedir } from "os";
import { basename, join, resolve } from "path";
import { lstat, mkdir, stat } from "fs/promises";
import { resolveCodexHomeForLaunch } from "../cli/codex-home.js";

export const AUTH_DIR_MODE = 0o700;
export const AUTH_FILE_MODE = 0o600;

export function resolveOmxAuthDir(home = homedir()): string {
  return join(home, ".omx", "auth");
}

export function resolveAuthMetadataPath(home = homedir()): string {
  return join(resolveOmxAuthDir(home), "slots.json");
}

export function validateSlotName(slot: string): string {
  const trimmed = slot.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error(
      "invalid auth slot name: use 1-64 letters, numbers, '.', '_' or '-' and start with a letter or number",
    );
  }
  if (trimmed === "." || trimmed === ".." || basename(trimmed) !== trimmed) {
    throw new Error("invalid auth slot name: path traversal is not allowed");
  }
  return trimmed;
}

export function resolveSlotPath(slot: string, home = homedir()): string {
  const safeSlot = validateSlotName(slot);
  const authDir = resolveOmxAuthDir(home);
  const candidate = resolve(authDir, `${safeSlot}.json`);
  const expected = join(resolve(authDir), `${safeSlot}.json`);
  if (candidate !== expected) {
    throw new Error("invalid auth slot path");
  }
  return candidate;
}

export function resolveDefaultCodexHome(home = homedir()): string {
  return join(home, ".codex");
}

export function resolveLiveAuthPath(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const codexHome = resolveCodexHomeForLaunch(cwd, env) || resolveDefaultCodexHome(home);
  return join(codexHome, "auth.json");
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: AUTH_DIR_MODE });
  const info = await lstat(dir);
  if (info.isSymbolicLink()) throw new Error(`auth directory must not be a symlink: ${dir}`);
  if (!info.isDirectory()) throw new Error(`auth path is not a directory: ${dir}`);
  if (process.platform !== "win32") {
    const { chmod } = await import("fs/promises");
    await chmod(dir, AUTH_DIR_MODE).catch(() => undefined);
  }
}

export async function assertReadableFile(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(`${label} not found: ${path}`);
    }
    throw err;
  }
}

export async function assertNoSymlink(path: string, label: string): Promise<void> {
  try {
    const { lstat } = await import("fs/promises");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}
