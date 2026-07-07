import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { omxRoot } from "../utils/paths.js";

export const MISSION_HELP = `omx mission - Run a prompt checklist sequentially through omx exec

Usage:
  omx mission <file> [--dry-run] [--continue-on-error] [--summary <path>] [--slug <name>] [--json] [-- <codex exec args...>]
  omx mission run <file> [options]
  omx mission plan <file> [--json]
  omx mission status <file|slug> [--json] [--summary <path>]
  omx mission mark <file|slug> --task <id> --status <blocked|needs-human-review> [--json] [--summary <path>]
  omx mission resume <file> [--continue-on-error] [--summary <path>] [--json] [-- <codex exec args...>]
  omx mission rerun <file> --task <id> [--summary <path>] [--json] [-- <codex exec args...>]

Input format:
  - One task per non-empty line
  - Markdown bullets, numbered lists, and checkboxes are accepted
  - Markdown headings and HTML comments are ignored

Artifacts:
  .omx/missions/<slug>/summary.json
  .omx/missions/<slug>/ledger.jsonl

Examples:
  omx mission ./mission.md --dry-run
  omx mission status ./mission.md
  omx mission resume ./mission.md -- --model gpt-5
  omx mission mark ./mission.md --task task-002 --status needs-human-review
  omx mission rerun ./mission.md --task task-002
`;

type MissionTaskStatus = "pending" | "planned" | "running" | "passed" | "failed" | "skipped" | "blocked" | "needs-human-review";
type MissionAction = "run" | "plan" | "status" | "mark" | "resume" | "rerun";

export interface MissionTask {
  id: string;
  index: number;
  prompt: string;
  source_line: number;
  status: MissionTaskStatus;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
}

export interface MissionSummary {
  version: 1;
  slug: string;
  input_path: string;
  dry_run: boolean;
  continue_on_error: boolean;
  started_at: string;
  completed_at?: string;
  status: "planned" | "running" | "passed" | "failed" | "blocked" | "needs-human-review";
  counts: Record<"total" | "planned" | "passed" | "failed" | "skipped" | "blocked" | "needs-human-review", number>;
  codex_args: string[];
  tasks: MissionTask[];
}

export interface MissionCommandOptions {
  cwd?: string;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runTask?: (prompt: string, codexArgs: string[]) => Promise<number>;
}

interface ParsedMissionArgs {
  action: MissionAction;
  file: string;
  dryRun: boolean;
  continueOnError: boolean;
  json: boolean;
  slug?: string;
  summaryPath?: string;
  taskId?: string;
  markStatus?: Extract<MissionTaskStatus, "blocked" | "needs-human-review">;
  codexArgs: string[];
}

interface MissionPaths {
  inputPath: string;
  slug: string;
  missionRoot: string;
  summaryPath: string;
  ledgerPath: string;
}

class MissionCommandError extends Error {}

function stripTaskMarker(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]\s+)?\[(?: |x|X)\]\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .trim();
}

export function parseMissionTasks(input: string): MissionTask[] {
  const tasks: MissionTask[] = [];
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    if (/^<!--.*-->$/.test(trimmed)) continue;

    const prompt = stripTaskMarker(raw);
    if (!prompt) continue;
    tasks.push({
      id: `task-${String(tasks.length + 1).padStart(3, "0")}`,
      index: tasks.length + 1,
      prompt,
      source_line: index + 1,
      status: "pending",
    });
  }
  return tasks;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "mission";
}

function readValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new MissionCommandError(`Missing value for ${flag}.`);
  return value;
}

function parseMissionArgs(args: string[]): ParsedMissionArgs {
  let rest = [...args];
  const command = rest[0];
  if (command === "help" || command === "--help" || command === "-h") {
    throw new MissionCommandError(MISSION_HELP);
  }

  let action: MissionAction = "run";
  if (command === "run") rest = rest.slice(1);
  else if (command === "plan") {
    action = "plan";
    rest = rest.slice(1);
  } else if (command === "status" || command === "mark" || command === "resume" || command === "rerun") {
    action = command;
    rest = rest.slice(1);
  }

  const separator = rest.indexOf("--");
  const commandArgs = separator >= 0 ? rest.slice(0, separator) : rest;
  const codexArgs = separator >= 0 ? rest.slice(separator + 1) : [];

  let file: string | undefined;
  let dryRun = action === "plan";
  let continueOnError = false;
  let json = false;
  let slug: string | undefined;
  let summaryPath: string | undefined;
  let taskId: string | undefined;
  let markStatus: Extract<MissionTaskStatus, "blocked" | "needs-human-review"> | undefined;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index] ?? "";
    if (arg === "--dry-run") {
      if (action !== "run") throw new MissionCommandError(`--dry-run is only supported for mission run/plan.`);
      dryRun = true;
      continue;
    }
    if (arg === "--continue-on-error") {
      if (action === "status") throw new MissionCommandError(`--continue-on-error is not supported for mission status.`);
      continueOnError = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--summary=")) {
      summaryPath = arg.slice("--summary=".length);
      continue;
    }
    if (arg === "--summary") {
      summaryPath = readValue(commandArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--slug=")) {
      slug = arg.slice("--slug=".length);
      continue;
    }
    if (arg === "--slug") {
      slug = readValue(commandArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--task=")) {
      taskId = arg.slice("--task=".length);
      continue;
    }
    if (arg === "--task") {
      taskId = readValue(commandArgs, index, arg);
      index += 1;
      continue;
    }
    if (arg.startsWith("--status=")) {
      const value = arg.slice("--status=".length);
      if (value !== "blocked" && value !== "needs-human-review") throw new MissionCommandError(`Unsupported mission mark status: ${value}`);
      markStatus = value;
      continue;
    }
    if (arg === "--status") {
      const value = readValue(commandArgs, index, arg);
      if (value !== "blocked" && value !== "needs-human-review") throw new MissionCommandError(`Unsupported mission mark status: ${value}`);
      markStatus = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new MissionCommandError(`Unknown mission option: ${arg}`);
    if (!file) {
      file = arg;
      continue;
    }
    throw new MissionCommandError(`Unexpected mission argument: ${arg}`);
  }

  if (!file) throw new MissionCommandError(`Missing mission input file.\n\n${MISSION_HELP}`);
  if (action !== "rerun" && action !== "mark" && taskId) throw new MissionCommandError(`--task is only supported for mission mark/rerun.`);
  if (action === "rerun" && !taskId) throw new MissionCommandError(`mission rerun requires --task <id>.`);
  if (action !== "mark" && markStatus) throw new MissionCommandError(`--status is only supported for mission mark.`);
  if (action === "mark" && (!taskId || !markStatus)) throw new MissionCommandError(`mission mark requires --task <id> --status <blocked|needs-human-review>.`);
  return { action, file, dryRun, continueOnError, json, slug, summaryPath, taskId, markStatus, codexArgs };
}

function missionCounts(tasks: MissionTask[]): MissionSummary["counts"] {
  return {
    total: tasks.length,
    planned: tasks.filter((task) => task.status === "planned").length,
    passed: tasks.filter((task) => task.status === "passed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    skipped: tasks.filter((task) => task.status === "skipped").length,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    "needs-human-review": tasks.filter((task) => task.status === "needs-human-review").length,
  };
}

function missionStatus(tasks: MissionTask[]): MissionSummary["status"] {
  if (tasks.some((task) => task.status === "running")) return "running";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "needs-human-review")) return "needs-human-review";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.length > 0 && tasks.every((task) => task.status === "passed")) return "passed";
  return "planned";
}

async function persistSummary(summaryPath: string, summary: MissionSummary): Promise<void> {
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

async function appendLedger(ledgerPath: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(ledgerPath), { recursive: true });
  const existing = await readFile(ledgerPath, "utf-8").catch(() => "");
  await writeFile(ledgerPath, `${existing}${JSON.stringify(event)}\n`, "utf-8");
}

function resolveMissionPaths(cwd: string, parsed: ParsedMissionArgs): MissionPaths {
  const looksLikePath = parsed.file.includes("/") || parsed.file.includes("\\") || parsed.file.endsWith(".md") || parsed.file.endsWith(".txt");
  const inputPath = isAbsolute(parsed.file) ? parsed.file : resolve(cwd, parsed.file);
  const baseSlug = parsed.slug ?? ((parsed.action === "status" || parsed.action === "mark") && !looksLikePath ? parsed.file : slugify(basename(inputPath, extname(inputPath))));
  const slug = slugify(baseSlug);
  const missionRoot = join(omxRoot(cwd), "missions", slug);
  const summaryPath = parsed.summaryPath
    ? (isAbsolute(parsed.summaryPath) ? parsed.summaryPath : resolve(cwd, parsed.summaryPath))
    : join(missionRoot, "summary.json");
  const ledgerPath = join(missionRoot, "ledger.jsonl");
  return { inputPath, slug, missionRoot, summaryPath, ledgerPath };
}

async function readSummary(summaryPath: string): Promise<MissionSummary> {
  let raw: string;
  try {
    raw = await readFile(summaryPath, "utf-8");
  } catch {
    throw new MissionCommandError(`No mission summary found at ${summaryPath}.`);
  }
  let summary: MissionSummary;
  try {
    summary = JSON.parse(raw) as MissionSummary;
  } catch {
    throw new MissionCommandError(`Invalid mission summary at ${summaryPath}.`);
  }
  if (summary.version !== 1 || !Array.isArray(summary.tasks)) {
    throw new MissionCommandError(`Invalid mission summary at ${summaryPath}.`);
  }
  return summary;
}

function syncSummary(summary: MissionSummary, updates: Partial<Pick<MissionSummary, "status" | "dry_run" | "continue_on_error" | "codex_args">>): void {
  Object.assign(summary, updates);
  summary.counts = missionCounts(summary.tasks);
}

async function runSelectedTasks(
  summary: MissionSummary,
  paths: MissionPaths,
  parsed: ParsedMissionArgs,
  now: () => Date,
  stdout: (line: string) => void,
  runTask: (prompt: string, codexArgs: string[]) => Promise<number>,
  shouldRun: (task: MissionTask) => boolean,
): Promise<void> {
  let failed = false;
  for (const task of summary.tasks) {
    if (!shouldRun(task)) continue;
    if (failed && !parsed.continueOnError) {
      task.status = "skipped";
      delete task.started_at;
      delete task.completed_at;
      delete task.exit_code;
      continue;
    }

    task.status = "running";
    task.started_at = now().toISOString();
    delete task.completed_at;
    delete task.exit_code;
    syncSummary(summary, { status: "running" });
    await persistSummary(paths.summaryPath, summary);
    await appendLedger(paths.ledgerPath, { event: "task_started", at: task.started_at, slug: summary.slug, task_id: task.id, index: task.index, prompt: task.prompt });
    stdout(`[running] ${task.id}/${summary.tasks.length}: ${task.prompt}`);

    const exitCode = await runTask(task.prompt, parsed.codexArgs);
    task.exit_code = exitCode;
    task.completed_at = now().toISOString();
    task.status = exitCode === 0 ? "passed" : "failed";
    if (exitCode !== 0) failed = true;
    syncSummary(summary, { status: missionStatus(summary.tasks) });
    await persistSummary(paths.summaryPath, summary);
    await appendLedger(paths.ledgerPath, { event: "task_completed", at: task.completed_at, slug: summary.slug, task_id: task.id, status: task.status, exit_code: exitCode });
    stdout(`[${task.status}] ${task.id}/${summary.tasks.length}: exit ${exitCode}`);
  }
}

function printStatus(summary: MissionSummary, summaryPath: string, json: boolean, stdout: (line: string) => void): void {
  if (json) {
    stdout(JSON.stringify({ ok: summary.status === "passed", summary_path: summaryPath, summary }, null, 2));
    return;
  }
  stdout(`mission status: ${summary.slug} [${summary.status}]`);
  stdout(`tasks: ${summary.counts.passed}/${summary.counts.total} passed, ${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ${summary.counts.blocked} blocked, ${summary.counts["needs-human-review"]} needs-human-review, ${summary.counts.planned} planned`);
  for (const task of summary.tasks) stdout(`[${task.status}] ${task.id} line ${task.source_line}: ${task.prompt}`);
  stdout(`summary: ${summaryPath}`);
}

export async function missionCommand(args: string[], options: MissionCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  try {
    const parsed = parseMissionArgs(args);
    const paths = resolveMissionPaths(cwd, parsed);

    if (parsed.action === "status") {
      const summary = await readSummary(paths.summaryPath);
      syncSummary(summary, { status: missionStatus(summary.tasks) });
      printStatus(summary, paths.summaryPath, parsed.json, stdout);
      return;
    }

    if (parsed.action === "mark") {
      const summary = await readSummary(paths.summaryPath);
      const task = summary.tasks.find((candidate) => candidate.id === parsed.taskId);
      if (!task) throw new MissionCommandError(`No mission task found for --task ${parsed.taskId}.`);
      task.status = parsed.markStatus ?? task.status;
      task.completed_at = now().toISOString();
      delete task.exit_code;
      syncSummary(summary, { status: missionStatus(summary.tasks) });
      await persistSummary(paths.summaryPath, summary);
      await appendLedger(paths.ledgerPath, { event: "task_marked", at: task.completed_at, slug: summary.slug, task_id: task.id, status: task.status });
      if (parsed.json) stdout(JSON.stringify({ ok: true, summary_path: paths.summaryPath, ledger_path: paths.ledgerPath, summary }, null, 2));
      else {
        stdout(`mission task marked ${task.status}: ${summary.slug} ${task.id}`);
        stdout(`summary: ${paths.summaryPath}`);
        stdout(`ledger: ${paths.ledgerPath}`);
      }
      return;
    }

    if (parsed.action === "resume" || parsed.action === "rerun") {
      const summary = await readSummary(paths.summaryPath);
      const runTask = options.runTask;
      if (!runTask) throw new MissionCommandError("Mission execution requires a task runner; use status for read-only inspection.");
      if (parsed.action === "rerun" && !summary.tasks.some((task) => task.id === parsed.taskId)) {
        throw new MissionCommandError(`No mission task found for --task ${parsed.taskId}.`);
      }

      summary.input_path = paths.inputPath;
      summary.dry_run = false;
      summary.continue_on_error = parsed.continueOnError;
      summary.codex_args = parsed.codexArgs;
      summary.status = "running";
      delete summary.completed_at;
      for (const task of summary.tasks) {
        if (task.status === "running") task.status = "pending";
      }
      syncSummary(summary, { status: "running" });
      await persistSummary(paths.summaryPath, summary);
      await appendLedger(paths.ledgerPath, { event: parsed.action === "resume" ? "mission_resumed" : "mission_rerun_started", at: now().toISOString(), slug: summary.slug, summary_path: paths.summaryPath, task_id: parsed.taskId });

      const shouldRun = parsed.action === "resume"
        ? (task: MissionTask) => task.status !== "passed" && task.status !== "blocked" && task.status !== "needs-human-review"
        : (task: MissionTask) => task.id === parsed.taskId;
      await runSelectedTasks(summary, paths, parsed, now, stdout, runTask, shouldRun);
      summary.status = missionStatus(summary.tasks);
      summary.completed_at = now().toISOString();
      summary.counts = missionCounts(summary.tasks);
      await persistSummary(paths.summaryPath, summary);
      await appendLedger(paths.ledgerPath, { event: "mission_completed", at: summary.completed_at, slug: summary.slug, status: summary.status, counts: summary.counts });
      if (parsed.json) stdout(JSON.stringify({ ok: summary.status === "passed", summary_path: paths.summaryPath, ledger_path: paths.ledgerPath, summary }, null, 2));
      else {
        stdout(`mission ${parsed.action} ${summary.status}: ${summary.slug}`);
        stdout(`summary: ${paths.summaryPath}`);
        stdout(`ledger: ${paths.ledgerPath}`);
      }
      if (summary.status !== "passed") process.exitCode = 1;
      return;
    }

    const input = await readFile(paths.inputPath, "utf-8");
    const tasks = parseMissionTasks(input);
    if (tasks.length === 0) throw new MissionCommandError(`No runnable mission tasks found in ${parsed.file}.`);

    const startedAt = now().toISOString();
    const summary: MissionSummary = {
      version: 1,
      slug: paths.slug,
      input_path: paths.inputPath,
      dry_run: parsed.dryRun,
      continue_on_error: parsed.continueOnError,
      started_at: startedAt,
      status: parsed.dryRun ? "planned" : "running",
      counts: missionCounts(tasks),
      codex_args: parsed.codexArgs,
      tasks,
    };

    if (parsed.dryRun) {
      for (const task of summary.tasks) task.status = "planned";
      summary.counts = missionCounts(summary.tasks);
      summary.completed_at = now().toISOString();
      await persistSummary(paths.summaryPath, summary);
      await appendLedger(paths.ledgerPath, { event: "mission_planned", at: summary.completed_at, slug: paths.slug, total: tasks.length, summary_path: paths.summaryPath });
      if (parsed.json) stdout(JSON.stringify({ ok: true, summary_path: paths.summaryPath, ledger_path: paths.ledgerPath, summary }, null, 2));
      else {
        stdout(`mission planned: ${paths.slug} (${tasks.length} tasks)`);
        for (const task of summary.tasks) stdout(`[planned] ${task.id} line ${task.source_line}: ${task.prompt}`);
        stdout(`summary: ${paths.summaryPath}`);
        stdout(`ledger: ${paths.ledgerPath}`);
      }
      return;
    }

    const runTask = options.runTask;
    if (!runTask) throw new MissionCommandError("Mission execution requires a task runner; use --dry-run for parser/plan validation.");

    await persistSummary(paths.summaryPath, summary);
    await appendLedger(paths.ledgerPath, { event: "mission_started", at: startedAt, slug: paths.slug, total: tasks.length, summary_path: paths.summaryPath });
    await runSelectedTasks(summary, paths, parsed, now, stdout, runTask, () => true);

    summary.status = missionStatus(summary.tasks);
    summary.completed_at = now().toISOString();
    summary.counts = missionCounts(summary.tasks);
    await persistSummary(paths.summaryPath, summary);
    await appendLedger(paths.ledgerPath, { event: "mission_completed", at: summary.completed_at, slug: paths.slug, status: summary.status, counts: summary.counts });

    if (parsed.json) stdout(JSON.stringify({ ok: summary.status === "passed", summary_path: paths.summaryPath, ledger_path: paths.ledgerPath, summary }, null, 2));
    else {
      stdout(`mission ${summary.status}: ${paths.slug}`);
      stdout(`summary: ${paths.summaryPath}`);
      stdout(`ledger: ${paths.ledgerPath}`);
    }
    if (summary.status === "failed") process.exitCode = 1;
  } catch (error) {
    if (error instanceof MissionCommandError) {
      if (error.message === MISSION_HELP) stdout(MISSION_HELP);
      else stderr(`[mission] ${error.message}`);
      if (error.message !== MISSION_HELP) process.exitCode = 1;
      return;
    }
    throw error;
  }
}
