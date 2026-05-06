import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { injectExecFollowup } from "../exec/followup.js";

export interface ImagegenContinuationRecord {
  version: 1;
  id: string;
  session_id: string;
  artifact_name: string;
  created_at: string;
  after: string;
  status: "pending";
  generated_images_dir?: string;
  work_dir?: string;
  resume_instruction: string;
}

export interface PrepareImagegenContinuationOptions {
  cwd: string;
  sessionId: string;
  artifactName: string;
  generatedImagesDir?: string;
  workDir?: string;
  after?: string;
  resumeInstruction?: string;
  actor?: string;
  nowIso?: string;
}

export interface PrepareImagegenContinuationResult {
  record: ImagegenContinuationRecord;
  pendingPath: string;
  followupId: string;
  queuePath: string;
}

export interface ParsedImagegenContinuationArgs {
  sessionId: string;
  artifactName: string;
  generatedImagesDir?: string;
  workDir?: string;
  after?: string;
  resumeInstruction?: string;
  actor?: string;
  json: boolean;
}

const DEFAULT_ACTOR = "omx-imagegen";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function sessionImagegenPendingPath(cwd: string, sessionId: string): string {
  return join(cwd, ".omx", "state", "sessions", sessionId, "imagegen-pending.json");
}

function normalizeRequired(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`Missing required ${name}`);
  return normalized;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = normalizeRequired(sessionId, "session id");
  if (!SESSION_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid session id. Expected 1-128 alphanumeric, underscore, or dash characters.");
  }
  return normalized;
}

function normalizeIsoOrNow(value: string | undefined, nowIso: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.toLowerCase() === "now") return nowIso;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --after timestamp: ${value}`);
  }
  return new Date(parsed).toISOString();
}

function defaultResumeInstruction(
  record: Omit<ImagegenContinuationRecord, "resume_instruction">,
  pendingPath: string,
): string {
  const generatedDir = record.generated_images_dir || "$CODEX_HOME/generated_images/<session>";
  const workDir = record.work_dir || ".omx imagegen artifact workspace";
  return [
    `Resume the interrupted Ralph visual/imagegen workflow for artifact "${record.artifact_name}".`,
    `Read pending imagegen metadata at ${pendingPath} if needed.`,
    `Locate the newest generated image in ${generatedDir} created after ${record.after}.`,
    `Copy it into ${workDir}, preserve the raw artifact, then run the required crop/post-process and visual QA/visual-verdict gate before any next edit.`,
    "Update Ralph progress/checkpoint state with fresh verification evidence, then continue the workflow instead of stopping solely because image generation completed.",
  ].join("\n");
}

export async function prepareImagegenContinuation(
  options: PrepareImagegenContinuationOptions,
): Promise<PrepareImagegenContinuationResult> {
  const sessionId = normalizeSessionId(options.sessionId);
  const artifactName = normalizeRequired(options.artifactName, "artifact name");
  const nowIso = options.nowIso ?? new Date().toISOString();
  const after = normalizeIsoOrNow(options.after, nowIso);
  const pendingPath = sessionImagegenPendingPath(options.cwd, sessionId);

  const baseRecord: Omit<ImagegenContinuationRecord, "resume_instruction"> = {
    version: 1,
    id: randomUUID(),
    session_id: sessionId,
    artifact_name: artifactName,
    created_at: nowIso,
    after,
    status: "pending",
    ...(options.generatedImagesDir?.trim() ? { generated_images_dir: options.generatedImagesDir.trim() } : {}),
    ...(options.workDir?.trim() ? { work_dir: options.workDir.trim() } : {}),
  };
  const record: ImagegenContinuationRecord = {
    ...baseRecord,
    resume_instruction: options.resumeInstruction?.trim() || defaultResumeInstruction(baseRecord, pendingPath),
  };

  await mkdir(dirname(pendingPath), { recursive: true });
  await writeFile(pendingPath, JSON.stringify(record, null, 2) + "\n", "utf-8");

  const followup = await injectExecFollowup({
    cwd: options.cwd,
    sessionId,
    actor: options.actor?.trim() || DEFAULT_ACTOR,
    prompt: record.resume_instruction,
    nowIso,
    allowInactiveSession: true,
  });

  return {
    record,
    pendingPath,
    followupId: followup.queued.id,
    queuePath: followup.queuePath,
  };
}

function readFileForCli(path: string): string {
  return readFileSync(path, "utf-8");
}

export function parseImagegenContinuationArgs(args: string[]): ParsedImagegenContinuationArgs {
  const [subcommand, sessionIdRaw, ...rest] = args;
  if (subcommand !== "continuation" && subcommand !== "prepare") {
    throw new Error(IMAGEGEN_CONTINUATION_USAGE);
  }
  const sessionId = normalizeSessionId(sessionIdRaw ?? "");

  let artifactName = "";
  let generatedImagesDir: string | undefined;
  let workDir: string | undefined;
  let after: string | undefined;
  let resumeInstruction: string | undefined;
  let actor: string | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    const readValue = (flag: string): string => {
      const value = rest[i + 1];
      if (!value) throw new Error(`Missing value after ${flag}`);
      i += 1;
      return value;
    };

    if (arg === "--json") {
      json = true;
    } else if (arg === "--artifact" || arg === "--artifact-name") {
      artifactName = readValue(arg);
    } else if (arg.startsWith("--artifact=")) {
      artifactName = arg.slice("--artifact=".length);
    } else if (arg.startsWith("--artifact-name=")) {
      artifactName = arg.slice("--artifact-name=".length);
    } else if (arg === "--generated-dir" || arg === "--generated-images-dir") {
      generatedImagesDir = readValue(arg);
    } else if (arg.startsWith("--generated-dir=")) {
      generatedImagesDir = arg.slice("--generated-dir=".length);
    } else if (arg.startsWith("--generated-images-dir=")) {
      generatedImagesDir = arg.slice("--generated-images-dir=".length);
    } else if (arg === "--work-dir") {
      workDir = readValue(arg);
    } else if (arg.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else if (arg === "--after") {
      after = readValue(arg);
    } else if (arg.startsWith("--after=")) {
      after = arg.slice("--after=".length);
    } else if (arg === "--resume-instruction" || arg === "--prompt") {
      resumeInstruction = readValue(arg);
    } else if (arg.startsWith("--resume-instruction=")) {
      resumeInstruction = arg.slice("--resume-instruction=".length);
    } else if (arg.startsWith("--prompt=")) {
      resumeInstruction = arg.slice("--prompt=".length);
    } else if (arg === "--resume-instruction-file" || arg === "--prompt-file") {
      resumeInstruction = readFileForCli(readValue(arg));
    } else if (arg.startsWith("--resume-instruction-file=")) {
      resumeInstruction = readFileForCli(arg.slice("--resume-instruction-file=".length));
    } else if (arg.startsWith("--prompt-file=")) {
      resumeInstruction = readFileForCli(arg.slice("--prompt-file=".length));
    } else if (arg === "--actor") {
      actor = readValue(arg);
    } else if (arg.startsWith("--actor=")) {
      actor = arg.slice("--actor=".length);
    } else {
      throw new Error(`Unknown imagegen continuation argument: ${arg}`);
    }
  }

  return {
    sessionId,
    artifactName: normalizeRequired(artifactName, "--artifact"),
    generatedImagesDir,
    workDir,
    after,
    resumeInstruction,
    actor,
    json,
  };
}

export const IMAGEGEN_CONTINUATION_USAGE = [
  "Usage:",
  "  omx imagegen continuation <session-id> --artifact <name> [--generated-dir <path>] [--work-dir <path>] [--after <iso|now>] [--prompt <text>|--prompt-file <path>] [--json]",
  "",
  "Queues a Stop-hook follow-up for a built-in image_gen call that cannot continue in-turn.",
].join("\n");

export async function imagegenCommand(args: string[], cwd = process.cwd()): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log(IMAGEGEN_CONTINUATION_USAGE);
    return;
  }
  const parsed = parseImagegenContinuationArgs(args);
  const result = await prepareImagegenContinuation({
    cwd,
    sessionId: parsed.sessionId,
    artifactName: parsed.artifactName,
    generatedImagesDir: parsed.generatedImagesDir,
    workDir: parsed.workDir,
    after: parsed.after,
    resumeInstruction: parsed.resumeInstruction,
    actor: parsed.actor,
  });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: true,
      pending_path: result.pendingPath,
      followup_id: result.followupId,
      queue_path: result.queuePath,
      record: result.record,
    }, null, 2));
    return;
  }

  console.log([
    `Queued imagegen continuation ${result.record.id} for session ${result.record.session_id}.`,
    `Pending: ${result.pendingPath}`,
    `Follow-up: ${result.followupId}`,
    `Queue: ${result.queuePath}`,
    "Delivery: next Stop hook checkpoint after the image generation turn.",
  ].join("\n"));
}
