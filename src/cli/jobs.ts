import {
  listTrackedJobs,
  lookupTrackedJob,
} from "../notifications/job-registry.js";
import type { TrackedJob } from "../notifications/types.js";

const JOBS_HELP = `Usage:
  omx jobs [--json]
  omx job <name> [--json]`;

export interface JobsCommandDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  list?: typeof listTrackedJobs;
  get?: typeof lookupTrackedJob;
}

function formatJobSummary(job: TrackedJob): string {
  const parts = [job.jobName, job.status];
  if (job.startedAt) {
    parts.push(`started ${job.startedAt}`);
  }
  if (job.discord?.threadId) {
    parts.push("thread attached");
  } else if (job.artifacts?.outputs && job.artifacts.outputs.length > 0) {
    parts.push("outputs present");
  }
  return `- ${parts.join(" | ")}`;
}

function formatJobDetail(job: TrackedJob): string {
  const lines = [
    `job: ${job.jobName}`,
    `status: ${job.status}`,
    `started: ${job.startedAt}`,
  ];
  if (job.finishedAt) {
    lines.push(`finished: ${job.finishedAt}`);
  }
  if (typeof job.pid === "number") {
    lines.push(`pid: ${job.pid}`);
  }
  if (job.artifacts?.promptPath) {
    lines.push(`prompt: ${job.artifacts.promptPath}`);
  }
  if (job.artifacts?.logPath) {
    lines.push(`log: ${job.artifacts.logPath}`);
  }
  if (job.discord?.channelId) {
    lines.push(`channel: ${job.discord.channelId}`);
  }
  if (job.discord?.threadId) {
    lines.push(`thread: ${job.discord.threadId}`);
  }
  if (job.artifacts?.outputs && job.artifacts.outputs.length > 0) {
    lines.push("outputs:");
    for (const output of job.artifacts.outputs) {
      lines.push(`- ${output}`);
    }
  }
  return lines.join("\n");
}

function parseJobsFlags(args: string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown jobs argument: ${arg}`);
  }
  return { json };
}

function parseJobArgs(args: string[]): { json: boolean; jobName?: string } {
  let json = false;
  let jobName: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!jobName && !arg.startsWith("-")) {
      jobName = arg;
      continue;
    }
    throw new Error(`Unknown job argument: ${arg}`);
  }

  return { json, jobName };
}

export async function jobsCommand(
  args: string[],
  deps: JobsCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const list = deps.list ?? listTrackedJobs;

  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    stdout(JOBS_HELP);
    return;
  }

  const { json } = parseJobsFlags(args);
  const jobs = list();

  if (json) {
    stdout(JSON.stringify({ jobs }, null, 0));
    return;
  }

  if (jobs.length === 0) {
    stdout("No tracked jobs.");
    return;
  }

  stdout("tracked jobs");
  for (const job of jobs) {
    stdout(formatJobSummary(job));
  }
}

export async function jobCommand(
  args: string[],
  deps: JobsCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const get = deps.get ?? lookupTrackedJob;

  if (args.length === 0 || args.includes("--help") || args.includes("-h") || args.includes("help")) {
    stdout(JOBS_HELP);
    return;
  }

  const { json, jobName } = parseJobArgs(args);
  if (!jobName) {
    throw new Error(`Missing job name.\n${JOBS_HELP}`);
  }

  const job = get(jobName);
  if (!job) {
    const errorBody = JSON.stringify({ error: `Unknown tracked job: ${jobName}` }, null, json ? 0 : 2);
    stderr(errorBody);
    process.exitCode = 1;
    return;
  }

  if (json) {
    stdout(JSON.stringify(job, null, 0));
    return;
  }

  stdout(formatJobDetail(job));
}
