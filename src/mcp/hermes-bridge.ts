import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { injectExecFollowup } from "../exec/followup.js";
import { isSessionStateUsable, readUsableSessionState, type SessionState } from "../hooks/session.js";
import {
  getAllSessionScopedStateDirs,
  getBaseStateDir,
  listModeStateFilesWithScopePreference,
  resolveWorkingDirectoryForState,
  validateSessionId,
} from "./state-paths.js";
import { resolveOmxCliEntryPath } from "../utils/paths.js";
import { safeJsonParse } from "../utils/safe-json.js";

export type HermesBridgeFailureCode =
  | "artifact_missing"
  | "artifact_outside_safe_roots"
  | "command_failed"
  | "invalid_input"
  | "mutation_not_allowed"
  | "no_session"
  | "prompt_not_accepted";

export interface HermesBridgeResult<T extends Record<string, unknown> = Record<string, unknown>> {
  ok: boolean;
  code?: HermesBridgeFailureCode;
  error?: string;
  data?: T;
}

export interface HermesSessionSummary {
  session_id: string;
  cwd?: string;
  started_at?: string;
  active: boolean;
  source: "current" | "session_state_dir";
  modes: string[];
}

export interface HermesStatusSessionSummary {
  session_id: string;
  native_session_id?: string;
  cwd?: string;
  started_at?: string;
}

export interface HermesModeStatusSummary {
  mode: string;
  scope: string;
  active?: boolean;
  phase?: string;
  run_outcome?: string;
  lifecycle_outcome?: string;
  updated_at?: string;
  completed_at?: string;
  error?: string;
}

export interface HermesBridgeDeps {
  now?: () => Date;
  spawnProcess?: typeof spawn;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  readUsableSessionState?: typeof readUsableSessionState;
  injectExecFollowup?: typeof injectExecFollowup;
}

const SAFE_ARTIFACT_PREFIXES = [
  ".omx/plans/",
  ".omx/specs/",
  ".omx/goals/",
  ".omx/context/",
  ".omx/reports/",
];
const DEFAULT_ARTIFACT_MAX_BYTES = 128_000;
const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_LINES = 500;

function jsonResult<T extends Record<string, unknown>>(data: T): HermesBridgeResult<T> {
  return { ok: true, data };
}

function failure<T extends Record<string, unknown> = Record<string, unknown>>(
  code: HermesBridgeFailureCode,
  error: string,
): HermesBridgeResult<T> {
  return { ok: false, code, error };
}

function normalizeString(value: unknown, name: string, options: { required?: boolean } = {}): string | undefined {
  if (value == null) {
    if (options.required) throw new Error(`${name} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && options.required) throw new Error(`${name} must be non-empty`);
  return trimmed || undefined;
}

function requireMutation(args: Record<string, unknown>): void {
  if (args.allow_mutation !== true) {
    throw new Error("mutating Hermes bridge tools require allow_mutation: true");
  }
}

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (value == null) return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return safeJsonParse<T | null>(await readFile(path, "utf-8"), null);
  } catch {
    return null;
  }
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function projectSessionStatus(session: SessionState | null): HermesStatusSessionSummary | null {
  if (!session) return null;
  return {
    session_id: session.session_id,
    ...(optionalString(session.native_session_id) ? { native_session_id: optionalString(session.native_session_id) } : {}),
    ...(optionalString(session.cwd) ? { cwd: optionalString(session.cwd) } : {}),
    ...(optionalString(session.started_at) ? { started_at: optionalString(session.started_at) } : {}),
  };
}

function projectModeStatus(mode: string, scope: string, state: unknown): HermesModeStatusSummary {
  const raw = state && typeof state === "object" && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {};
  return {
    mode,
    scope,
    ...(optionalBoolean(raw.active) !== undefined ? { active: optionalBoolean(raw.active) } : {}),
    ...(optionalString(raw.current_phase) ? { phase: optionalString(raw.current_phase) } : {}),
    ...(optionalString(raw.phase) && !optionalString(raw.current_phase) ? { phase: optionalString(raw.phase) } : {}),
    ...(optionalString(raw.run_outcome) ? { run_outcome: optionalString(raw.run_outcome) } : {}),
    ...(optionalString(raw.lifecycle_outcome) ? { lifecycle_outcome: optionalString(raw.lifecycle_outcome) } : {}),
    ...(optionalString(raw.updated_at) ? { updated_at: optionalString(raw.updated_at) } : {}),
    ...(optionalString(raw.completed_at) ? { completed_at: optionalString(raw.completed_at) } : {}),
    ...(optionalString(raw.error) ? { error: optionalString(raw.error) } : {}),
  };
}

async function listModeNamesInStateDir(stateDir: string): Promise<string[]> {
  if (!existsSync(stateDir)) return [];
  const entries = await readdir(stateDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith("-state.json"))
    .map((entry) => entry.name.slice(0, -"-state.json".length))
    .sort();
}

function sessionIdFromSessionStateDir(path: string): string | null {
  const name = basename(path);
  try {
    return validateSessionId(name) ?? null;
  } catch {
    return null;
  }
}

async function summarizeCurrentSession(cwd: string, deps: HermesBridgeDeps): Promise<HermesSessionSummary | null> {
  const reader = deps.readUsableSessionState ?? readUsableSessionState;
  const current = await reader(cwd);
  if (!current || !isSessionStateUsable(current, cwd)) return null;
  return {
    session_id: current.session_id,
    cwd: current.cwd,
    started_at: current.started_at,
    active: true,
    source: "current",
    modes: await listModeNamesInStateDir(join(getBaseStateDir(cwd), "sessions", current.session_id)),
  };
}

export async function hermesListSessions(
  args: Record<string, unknown>,
  deps: HermesBridgeDeps = {},
): Promise<HermesBridgeResult<{ sessions: HermesSessionSummary[] }>> {
  try {
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const sessions = new Map<string, HermesSessionSummary>();
    const current = await summarizeCurrentSession(cwd, deps);
    if (current) sessions.set(current.session_id, current);

    for (const dir of await getAllSessionScopedStateDirs(cwd)) {
      const sessionId = sessionIdFromSessionStateDir(dir);
      if (!sessionId || sessions.has(sessionId)) continue;
      sessions.set(sessionId, {
        session_id: sessionId,
        active: false,
        source: "session_state_dir",
        modes: await listModeNamesInStateDir(dir),
      });
    }

    return jsonResult({ sessions: [...sessions.values()].sort((a, b) => a.session_id.localeCompare(b.session_id)) });
  } catch (error) {
    return failure("invalid_input", error instanceof Error ? error.message : String(error));
  }
}

export async function hermesReadStatus(
  args: Record<string, unknown>,
  deps: HermesBridgeDeps = {},
): Promise<HermesBridgeResult<{ session: HermesStatusSessionSummary | null; modes: HermesModeStatusSummary[] }>> {
  try {
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const sessionId = validateSessionId(normalizeString(args.session_id, "session_id"));
    const rawSession = sessionId ? null : await (deps.readUsableSessionState ?? readUsableSessionState)(cwd);
    const session = projectSessionStatus(rawSession);
    if (sessionId && !existsSync(join(getBaseStateDir(cwd), "sessions", sessionId))) {
      return failure("no_session", `No OMX session state directory exists for ${sessionId}`);
    }
    const refs = await listModeStateFilesWithScopePreference(cwd, sessionId);
    const modes: HermesModeStatusSummary[] = [];
    for (const ref of refs) {
      modes.push(projectModeStatus(ref.mode, ref.scope, await readJsonFile(ref.path)));
    }
    return jsonResult({ session, modes });
  } catch (error) {
    return failure("invalid_input", error instanceof Error ? error.message : String(error));
  }
}

export async function hermesSendPrompt(
  args: Record<string, unknown>,
  deps: HermesBridgeDeps = {},
): Promise<HermesBridgeResult<{ followup_id: string; session_id: string; queue_path: string }>> {
  try {
    requireMutation(args);
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const sessionId = normalizeString(args.session_id, "session_id", { required: true })!;
    validateSessionId(sessionId);
    const prompt = normalizeString(args.prompt, "prompt", { required: true })!;
    const actor = normalizeString(args.actor, "actor") ?? "hermes-mcp";
    const inject = deps.injectExecFollowup ?? injectExecFollowup;
    const result = await inject({ cwd, sessionId, prompt, actor });
    return jsonResult({
      followup_id: result.queued.id,
      session_id: result.queued.session_id,
      queue_path: result.queuePath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("job_not_input_accepting")) return failure("prompt_not_accepted", message);
    if (message.includes("allow_mutation")) return failure("mutation_not_allowed", message);
    return failure("invalid_input", message);
  }
}

export async function hermesStartSession(
  args: Record<string, unknown>,
  deps: HermesBridgeDeps = {},
): Promise<HermesBridgeResult<{ pid: number; command: string; args: string[]; workingDirectory: string }>> {
  try {
    requireMutation(args);
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory", { required: true }));
    const prompt = normalizeString(args.prompt, "prompt", { required: true })!;
    const worktreeName = normalizeString(args.worktreeName, "worktreeName");
    if (worktreeName && (!/^[A-Za-z0-9._/-]{1,128}$/.test(worktreeName) || worktreeName.includes("..") || worktreeName.startsWith("/"))) {
      throw new Error("worktreeName must be a relative safe worktree name");
    }
    const command = (deps.resolveOmxCliEntryPath ?? resolveOmxCliEntryPath)({ cwd }) ?? "omx";
    const launchArgs = ["--tmux", worktreeName ? `--worktree=${worktreeName}` : "--worktree", prompt];
    const child = (deps.spawnProcess ?? spawn)(command, launchArgs, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, OMX_HERMES_MCP_BRIDGE: "1" },
    }) as ChildProcess;
    child.unref();
    if (!child.pid) return failure("command_failed", "OMX session launcher did not report a pid");
    return jsonResult({ pid: child.pid, command, args: launchArgs, workingDirectory: cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("allow_mutation")) return failure("mutation_not_allowed", message);
    return failure("invalid_input", message);
  }
}

function normalizeArtifactRelativePath(pathValue: unknown): string {
  const raw = normalizeString(pathValue, "path", { required: true })!;
  if (isAbsolute(raw)) throw new Error("artifact path must be relative");
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("../") || normalized === ".." || normalized.includes("\0")) {
    throw new Error("artifact path must not traverse directories");
  }
  if (!SAFE_ARTIFACT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`artifact path must be under ${SAFE_ARTIFACT_PREFIXES.join(", ")}`);
  }
  return normalized;
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveSafeArtifactPath(cwd: string, rel: string): Promise<string> {
  const cwdRealPath = await realpath(cwd);
  const full = resolve(cwd, rel);
  const relativeToCwd = relative(resolve(cwd), full);
  if (relativeToCwd.startsWith("..") || isAbsolute(relativeToCwd)) {
    throw new Error("artifact resolved outside working directory");
  }

  let artifactRealPath: string;
  try {
    artifactRealPath = await realpath(full);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("artifact_missing");
    throw error;
  }

  if (!isInsideDirectory(cwdRealPath, artifactRealPath)) {
    throw new Error("artifact resolved outside working directory");
  }

  for (const prefix of SAFE_ARTIFACT_PREFIXES) {
    const rootRealPath = await realpath(resolve(cwd, prefix)).catch(() => null);
    if (rootRealPath && isInsideDirectory(rootRealPath, artifactRealPath)) return artifactRealPath;
  }

  throw new Error(`artifact path must be under ${SAFE_ARTIFACT_PREFIXES.join(", ")}`);
}

async function collectFiles(root: string, cwd: string, limit: number, out: Array<{ path: string; bytes: number }>): Promise<void> {
  if (out.length >= limit || !existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= limit) return;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, cwd, limit, out);
    } else if (entry.isFile()) {
      const rel = relative(cwd, full).replace(/\\/g, "/");
      try {
        const content = await readFile(full);
        out.push({ path: rel, bytes: content.byteLength });
      } catch {
        // Ignore unreadable artifacts.
      }
    }
  }
}

export async function hermesListArtifacts(
  args: Record<string, unknown>,
): Promise<HermesBridgeResult<{ artifacts: Array<{ path: string; bytes: number }> }>> {
  try {
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const limit = normalizePositiveInteger(args.limit, 100, 500);
    const artifacts: Array<{ path: string; bytes: number }> = [];
    for (const prefix of [".omx/plans", ".omx/specs", ".omx/goals", ".omx/context", ".omx/reports"]) {
      await collectFiles(join(cwd, prefix), cwd, limit, artifacts);
    }
    return jsonResult({ artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)) });
  } catch (error) {
    return failure("invalid_input", error instanceof Error ? error.message : String(error));
  }
}

export async function hermesReadArtifact(
  args: Record<string, unknown>,
): Promise<HermesBridgeResult<{ path: string; content: string; truncated: boolean }>> {
  try {
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const rel = normalizeArtifactRelativePath(args.path);
    const full = await resolveSafeArtifactPath(cwd, rel);
    const maxBytes = normalizePositiveInteger(args.max_bytes, DEFAULT_ARTIFACT_MAX_BYTES, 1_000_000);
    const raw = await readFile(full);
    const truncated = raw.byteLength > maxBytes;
    return jsonResult({ path: rel, content: raw.subarray(0, maxBytes).toString("utf-8"), truncated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "artifact_missing") return failure("artifact_missing", message);
    if (message.includes("artifact path") || message.includes("outside working directory")) {
      return failure("artifact_outside_safe_roots", message);
    }
    return failure("invalid_input", message);
  }
}

export async function hermesReadTail(
  args: Record<string, unknown>,
): Promise<HermesBridgeResult<{ tail: string[]; path: string }>> {
  try {
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const lines = normalizePositiveInteger(args.lines, DEFAULT_TAIL_LINES, MAX_TAIL_LINES);
    const path = join(cwd, ".omx", "logs", "session-history.jsonl");
    if (!existsSync(path)) return jsonResult({ tail: [], path });
    const content = await readFile(path, "utf-8");
    return jsonResult({ tail: content.split(/\r?\n/).filter(Boolean).slice(-lines), path });
  } catch (error) {
    return failure("invalid_input", error instanceof Error ? error.message : String(error));
  }
}

export async function hermesReportStatus(
  args: Record<string, unknown>,
  deps: HermesBridgeDeps = {},
): Promise<HermesBridgeResult<{ path: string; report: Record<string, unknown> }>> {
  try {
    requireMutation(args);
    const cwd = resolveWorkingDirectoryForState(normalizeString(args.workingDirectory, "workingDirectory"));
    const sessionId = validateSessionId(normalizeString(args.session_id, "session_id"));
    const status = normalizeString(args.status, "status", { required: true })!;
    if (!["running", "blocked", "failed", "complete"].includes(status)) {
      throw new Error("status must be one of running, blocked, failed, complete");
    }
    const summary = normalizeString(args.summary, "summary");
    const prUrl = normalizeString(args.pr_url, "pr_url");
    const blocker = normalizeString(args.blocker, "blocker");
    const report = {
      status,
      updated_at: (deps.now ?? (() => new Date()))().toISOString(),
      ...(summary ? { summary } : {}),
      ...(prUrl ? { pr_url: prUrl } : {}),
      ...(blocker ? { blocker } : {}),
    };
    const stateDir = sessionId ? join(getBaseStateDir(cwd), "sessions", sessionId) : getBaseStateDir(cwd);
    const path = join(stateDir, "hermes-coordination.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n");
    return jsonResult({ path, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("allow_mutation")) return failure("mutation_not_allowed", message);
    return failure("invalid_input", message);
  }
}
