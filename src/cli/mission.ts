import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { omxRoot } from "../utils/paths.js";

export const MISSION_HELP = `omx mission - Run a prompt checklist sequentially through omx exec

Usage:
  omx mission <file> [--dry-run] [--continue-on-error] [--summary <path>] [--slug <name>] [--json] [-- <codex exec args...>]
  omx mission run <file> [options]
  omx mission plan <file> [--json]

Input format:
  - One task per non-empty line
  - Markdown bullets, numbered lists, and checkboxes are accepted
  - Markdown headings and HTML comments are ignored

Artifacts:
  .omx/missions/<slug>/summary.json
  .omx/missions/<slug>/ledger.jsonl

Examples:
  omx mission ./mission.md --dry-run
  omx mission run ./prompts.txt --continue-on-error -- --model gpt-5
`;

type MissionTaskStatus = "pending" | "planned" | "running" | "passed" | "failed" | "skipped";

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
  status: "planned" | "running" | "passed" | "failed";
  counts: Record<"total" | "planned" | "passed" | "failed" | "skipped", number>;
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
  file: string;
  dryRun: boolean;
  continueOnError: boolean;
  json: boolean;
  slug?: string;
  summaryPath?: string;
  codexArgs: string[];
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
  if (command === "run") rest = rest.slice(1);
  else if (command === "plan") rest = ["--dry-run", ...rest.slice(1)];

  const separator = rest.indexOf("--");
  const commandArgs = separator >= 0 ? rest.slice(0, separator) : rest;
  const codexArgs = separator >= 0 ? rest.slice(separator + 1) : [];

  let file: string | undefined;
  let dryRun = false;
  let continueOnError = false;
  let json = false;
  let slug: string | undefined;
  let summaryPath: string | undefined;

  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index] ?? "";
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--continue-on-error") {
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
    if (arg.startsWith("--")) throw new MissionCommandError(`Unknown mission option: ${arg}`);
    if (!file) {
      file = arg;
      continue;
    }
    throw new MissionCommandError(`Unexpected mission argument: ${arg}`);
  }

  if (!file) throw new MissionCommandError(`Missing mission input file.\n\n${MISSION_HELP}`);
  return { file, dryRun, continueOnError, json, slug, summaryPath, codexArgs };
}

function missionCounts(tasks: MissionTask[]): MissionSummary["counts"] {
  return {
    total: tasks.length,
    planned: tasks.filter((task) => task.status === "planned").length,
    passed: tasks.filter((task) => task.status === "passed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    skipped: tasks.filter((task) => task.status === "skipped").length,
  };
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

export async function missionCommand(args: string[], options: MissionCommandOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));

  try {
    const parsed = parseMissionArgs(args);
    const inputPath = isAbsolute(parsed.file) ? parsed.file : resolve(cwd, parsed.file);
    const input = await readFile(inputPath, "utf-8");
    const tasks = parseMissionTasks(input);
    if (tasks.length === 0) throw new MissionCommandError(`No runnable mission tasks found in ${parsed.file}.`);

    const baseSlug = parsed.slug ?? slugify(basename(inputPath, extname(inputPath)));
    const slug = slugify(baseSlug);
    const missionRoot = join(omxRoot(cwd), "missions", slug);
    const summaryPath = parsed.summaryPath
      ? (isAbsolute(parsed.summaryPath) ? parsed.summaryPath : resolve(cwd, parsed.summaryPath))
      : join(missionRoot, "summary.json");
    const ledgerPath = join(missionRoot, "ledger.jsonl");
    const startedAt = now().toISOString();
    const summary: MissionSummary = {
      version: 1,
      slug,
      input_path: inputPath,
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
      await persistSummary(summaryPath, summary);
      await appendLedger(ledgerPath, { event: "mission_planned", at: summary.completed_at, slug, total: tasks.length, summary_path: summaryPath });
      if (parsed.json) stdout(JSON.stringify({ ok: true, summary_path: summaryPath, ledger_path: ledgerPath, summary }, null, 2));
      else {
        stdout(`mission planned: ${slug} (${tasks.length} tasks)`);
        for (const task of summary.tasks) stdout(`[planned] ${task.id} line ${task.source_line}: ${task.prompt}`);
        stdout(`summary: ${summaryPath}`);
        stdout(`ledger: ${ledgerPath}`);
      }
      return;
    }

    const runTask = options.runTask;
    if (!runTask) throw new MissionCommandError("Mission execution requires a task runner; use --dry-run for parser/plan validation.");

    await persistSummary(summaryPath, summary);
    await appendLedger(ledgerPath, { event: "mission_started", at: startedAt, slug, total: tasks.length, summary_path: summaryPath });

    let failed = false;
    for (const task of summary.tasks) {
      if (failed && !parsed.continueOnError) {
        task.status = "skipped";
        continue;
      }
      task.status = "running";
      task.started_at = now().toISOString();
      summary.counts = missionCounts(summary.tasks);
      await persistSummary(summaryPath, summary);
      await appendLedger(ledgerPath, { event: "task_started", at: task.started_at, slug, task_id: task.id, index: task.index, prompt: task.prompt });
      stdout(`[running] ${task.id}/${summary.tasks.length}: ${task.prompt}`);

      const exitCode = await runTask(task.prompt, parsed.codexArgs);
      task.exit_code = exitCode;
      task.completed_at = now().toISOString();
      task.status = exitCode === 0 ? "passed" : "failed";
      if (exitCode !== 0) failed = true;
      summary.counts = missionCounts(summary.tasks);
      await persistSummary(summaryPath, summary);
      await appendLedger(ledgerPath, { event: "task_completed", at: task.completed_at, slug, task_id: task.id, status: task.status, exit_code: exitCode });
      stdout(`[${task.status}] ${task.id}/${summary.tasks.length}: exit ${exitCode}`);
    }

    summary.status = summary.tasks.some((task) => task.status === "failed") ? "failed" : "passed";
    summary.completed_at = now().toISOString();
    summary.counts = missionCounts(summary.tasks);
    await persistSummary(summaryPath, summary);
    await appendLedger(ledgerPath, { event: "mission_completed", at: summary.completed_at, slug, status: summary.status, counts: summary.counts });

    if (parsed.json) stdout(JSON.stringify({ ok: summary.status === "passed", summary_path: summaryPath, ledger_path: ledgerPath, summary }, null, 2));
    else {
      stdout(`mission ${summary.status}: ${slug}`);
      stdout(`summary: ${summaryPath}`);
      stdout(`ledger: ${ledgerPath}`);
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
