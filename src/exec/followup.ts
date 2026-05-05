import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { isSessionStateUsable, readUsableSessionState } from "../hooks/session.js";

export interface ExecFollowupRecord {
  id: string;
  session_id: string;
  actor: string;
  prompt: string;
  created_at: string;
  delivered_at?: string;
  delivery_event?: "stop-hook";
}

export interface ExecFollowupQueue {
  version: 1;
  session_id: string;
  records: ExecFollowupRecord[];
}

export interface InjectExecFollowupOptions {
  cwd: string;
  sessionId: string;
  prompt: string;
  actor?: string;
  nowIso?: string;
  allowInactiveSession?: boolean;
}

export interface InjectExecFollowupResult {
  queued: ExecFollowupRecord;
  queuePath: string;
}

const QUEUE_FILE = "exec-followups.json";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const QUEUE_LOCK_STALE_MS = 30_000;
const QUEUE_LOCK_RETRY_MS = 10;
const QUEUE_LOCK_MAX_WAIT_MS = 5_000;

function stateDir(cwd: string): string {
  return join(cwd, ".omx", "state");
}

function sessionQueuePath(cwd: string, sessionId: string): string {
  return join(stateDir(cwd), "sessions", sessionId, QUEUE_FILE);
}

function sessionQueueLockPath(queuePath: string): string {
  return `${queuePath}.lock`;
}

function auditLogPath(cwd: string, nowIso: string): string {
  return join(cwd, ".omx", "logs", `exec-followups-${nowIso.slice(0, 10)}.jsonl`);
}

function safeTimestampForPath(nowIso: string): string {
  return nowIso.replace(/[^0-9A-Za-z_-]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error("invalid_session_id");
  }
  return normalized;
}

function normalizePrompt(prompt: string): string {
  const normalized = prompt.trim();
  if (!normalized) throw new Error("missing_prompt");
  return normalized;
}

function normalizeActor(actor?: string): string {
  const normalized = (actor || process.env.USER || process.env.USERNAME || "unknown").trim();
  return normalized || "unknown";
}

async function appendAudit(cwd: string, event: Record<string, unknown>, nowIso: string): Promise<void> {
  const path = auditLogPath(cwd, nowIso);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ ...event, timestamp: nowIso }) + "\n");
}

async function quarantineCorruptQueue(
  path: string,
  sessionId: string,
  options: { cwd: string; nowIso: string; error: unknown },
): Promise<ExecFollowupQueue> {
  const quarantinePath = `${path}.corrupt-${safeTimestampForPath(options.nowIso)}`;
  let quarantined = false;
  try {
    await rename(path, quarantinePath);
    quarantined = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await appendAudit(options.cwd, {
        event: "exec_followup_queue_corrupt_quarantine_failed",
        session_id: sessionId,
        queue_path: path,
        quarantine_path: quarantinePath,
        error: errorMessage(error),
        parse_error: errorMessage(options.error),
      }, options.nowIso);
    }
  }

  await appendAudit(options.cwd, {
    event: "exec_followup_queue_corrupt_recovered",
    session_id: sessionId,
    queue_path: path,
    ...(quarantined ? { quarantine_path: quarantinePath } : {}),
    error: errorMessage(options.error),
  }, options.nowIso);

  const recovered: ExecFollowupQueue = { version: 1, session_id: sessionId, records: [] };
  await writeQueue(path, recovered);
  return recovered;
}

async function readQueue(
  path: string,
  sessionId: string,
  options?: { cwd: string; nowIso: string; recoverCorrupt?: boolean },
): Promise<ExecFollowupQueue> {
  if (!existsSync(path)) {
    return { version: 1, session_id: sessionId, records: [] };
  }
  let parsed: Partial<ExecFollowupQueue>;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<ExecFollowupQueue>;
  } catch (error) {
    if (options?.recoverCorrupt) {
      return await quarantineCorruptQueue(path, sessionId, {
        cwd: options.cwd,
        nowIso: options.nowIso,
        error,
      });
    }
    throw error;
  }
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  return {
    version: 1,
    session_id: typeof parsed.session_id === "string" && parsed.session_id.trim()
      ? parsed.session_id.trim()
      : sessionId,
    records: records.filter((record): record is ExecFollowupRecord => (
      typeof record === "object"
      && record !== null
      && typeof record.id === "string"
      && typeof record.session_id === "string"
      && typeof record.actor === "string"
      && typeof record.prompt === "string"
      && typeof record.created_at === "string"
    )),
  };
}

async function writeQueue(path: string, queue: ExecFollowupQueue): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(queue, null, 2) + "\n");
  await rename(tempPath, path);
}

async function withQueueLock<T>(queuePath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(queuePath), { recursive: true });
  const lockPath = sessionQueueLockPath(queuePath);
  const start = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }, null, 2));
      try {
        return await operation();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > QUEUE_LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }

      if (Date.now() - start > QUEUE_LOCK_MAX_WAIT_MS) {
        throw new Error("exec_followup_queue_lock_timeout");
      }
      await sleep(QUEUE_LOCK_RETRY_MS);
    }
  }
}

export async function injectExecFollowup(
  options: InjectExecFollowupOptions,
): Promise<InjectExecFollowupResult> {
  const sessionId = normalizeSessionId(options.sessionId);
  const prompt = normalizePrompt(options.prompt);
  const actor = normalizeActor(options.actor);
  const nowIso = options.nowIso ?? new Date().toISOString();

  const active = await readUsableSessionState(options.cwd);
  const activeUsable = active && isSessionStateUsable(active, options.cwd);
  if (!activeUsable && !options.allowInactiveSession) {
    throw new Error("job_not_input_accepting:no_active_exec_session");
  }
  if (
    activeUsable
    && active.session_id !== sessionId
    && active.native_session_id !== sessionId
    && !options.allowInactiveSession
  ) {
    throw new Error(`job_not_input_accepting:session_mismatch:${active.session_id}`);
  }

  const canonicalSessionId = activeUsable && (active.session_id === sessionId || active.native_session_id === sessionId)
    ? active.session_id
    : sessionId;
  const queuePath = sessionQueuePath(options.cwd, canonicalSessionId);
  const queued: ExecFollowupRecord = {
    id: randomUUID(),
    session_id: canonicalSessionId,
    actor,
    prompt,
    created_at: nowIso,
  };
  await withQueueLock(queuePath, async () => {
    const queue = await readQueue(queuePath, canonicalSessionId, {
      cwd: options.cwd,
      nowIso,
      recoverCorrupt: true,
    });
    queue.session_id = canonicalSessionId;
    queue.records.push(queued);
    await writeQueue(queuePath, queue);
  });
  await appendAudit(options.cwd, {
    event: "exec_followup_queued",
    followup_id: queued.id,
    session_id: canonicalSessionId,
    actor,
    prompt,
  }, nowIso);
  return { queued, queuePath };
}

export async function readPendingExecFollowups(
  cwd: string,
  sessionId: string,
): Promise<{ queuePath: string; pending: ExecFollowupRecord[] }> {
  const canonicalSessionId = normalizeSessionId(sessionId);
  const queuePath = sessionQueuePath(cwd, canonicalSessionId);
  const queue = await readQueue(queuePath, canonicalSessionId, {
    cwd,
    nowIso: new Date().toISOString(),
    recoverCorrupt: true,
  });
  return {
    queuePath,
    pending: queue.records.filter((record) => !record.delivered_at),
  };
}

export async function markExecFollowupsDelivered(
  cwd: string,
  sessionId: string,
  followupIds: string[],
  options: { nowIso?: string; deliveryEvent?: "stop-hook" } = {},
): Promise<void> {
  const canonicalSessionId = normalizeSessionId(sessionId);
  const nowIso = options.nowIso ?? new Date().toISOString();
  const queuePath = sessionQueuePath(cwd, canonicalSessionId);
  await withQueueLock(queuePath, async () => {
    const queue = await readQueue(queuePath, canonicalSessionId, {
      cwd,
      nowIso,
      recoverCorrupt: true,
    });
    const ids = new Set(followupIds);
    let changed = false;
    for (const record of queue.records) {
      if (!ids.has(record.id) || record.delivered_at) continue;
      record.delivered_at = nowIso;
      record.delivery_event = options.deliveryEvent ?? "stop-hook";
      changed = true;
      await appendAudit(cwd, {
        event: "exec_followup_delivered",
        followup_id: record.id,
        session_id: canonicalSessionId,
        actor: record.actor,
        delivery_event: record.delivery_event,
      }, nowIso);
    }
    if (changed) await writeQueue(queuePath, queue);
  });
}

export async function buildExecFollowupStopOutput(
  cwd: string,
  sessionId: string | undefined | null,
): Promise<Record<string, unknown> | null> {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId) return null;
  const { pending } = await readPendingExecFollowups(cwd, normalizedSessionId);
  if (pending.length === 0) return null;

  const ids = pending.map((record) => record.id);
  await markExecFollowupsDelivered(cwd, normalizedSessionId, ids, {
    deliveryEvent: "stop-hook",
  });

  const rendered = pending.map((record, index) => (
    `Follow-up ${index + 1} (${record.id}) from ${record.actor} at ${record.created_at}:\n${record.prompt}`
  )).join("\n\n");
  const systemMessage =
    `OMX exec has ${pending.length} queued follow-up instruction${pending.length === 1 ? "" : "s"} for this non-interactive job. ` +
    "Treat them as the newest user instructions, continue the same run, and include the follow-up id(s) in your final audit summary.\n\n" +
    rendered;

  return {
    decision: "block",
    reason: `exec_followup_pending:${ids.join(",")}`,
    systemMessage,
  };
}

export function formatInjectExecFollowupSuccess(result: InjectExecFollowupResult): string {
  return [
    `Queued exec follow-up ${result.queued.id} for session ${result.queued.session_id}.`,
    `Queue: ${result.queuePath}`,
    "Delivery: next Stop hook checkpoint; no tmux pane input was sent.",
  ].join("\n");
}

export function parseExecInjectArgs(args: string[]): {
  sessionId: string;
  prompt: string;
  actor?: string;
  json: boolean;
} {
  const [, sessionIdRaw, ...rest] = args;
  const sessionId = sessionIdRaw?.trim();
  if (!sessionId) throw new Error("Usage: omx exec inject <session-id> --prompt <text> [--actor <name>] [--json]");

  let prompt = "";
  let actor: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--prompt") {
      const value = rest[i + 1];
      if (!value) throw new Error("Missing value after --prompt");
      prompt = value;
      i += 1;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
    } else if (arg === "--prompt-file") {
      const value = rest[i + 1];
      if (!value) throw new Error("Missing path after --prompt-file");
      prompt = readFileSyncForCli(value);
      i += 1;
    } else if (arg.startsWith("--prompt-file=")) {
      prompt = readFileSyncForCli(arg.slice("--prompt-file=".length));
    } else if (arg === "--actor") {
      const value = rest[i + 1];
      if (!value) throw new Error("Missing value after --actor");
      actor = value;
      i += 1;
    } else if (arg.startsWith("--actor=")) {
      actor = arg.slice("--actor=".length);
    } else if (!arg.startsWith("-") && !prompt) {
      prompt = [arg, ...rest.slice(i + 1)].join(" ");
      break;
    } else {
      throw new Error(`Unknown exec inject argument: ${arg}`);
    }
  }
  return { sessionId, prompt, actor, json };
}

function readFileSyncForCli(path: string): string {
  return readFileSync(path, "utf-8");
}

export async function execInjectCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const parsed = parseExecInjectArgs(args);
  const result = await injectExecFollowup({
    cwd,
    sessionId: parsed.sessionId,
    prompt: parsed.prompt,
    actor: parsed.actor,
  });
  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      queued: result.queued,
      queue_path: result.queuePath,
    }, null, 2));
  } else {
    console.log(formatInjectExecFollowupSuccess(result));
  }
}
