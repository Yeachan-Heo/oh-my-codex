import type { TeamTask } from "./state.js";
import { existsSync } from "fs";
import { mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { execFileSync } from "child_process";
import {
  getFixLoopInstructions,
  getVerificationInstructions,
} from "../verification/verifier.js";
import { codexHome, listInstalledSkillDirectories } from "../utils/paths.js";
import { sleep } from "../utils/sleep.js";
import type { ApprovedRepositoryContextSummary } from "../planning/artifacts.js";
import type { TeamReminderDirective } from "./reminder-intents.js";
import type { TaskHintSummary } from "./repo-aware-decomposition.js";

const TEAM_OVERLAY_START = "<!-- OMX:TEAM:WORKER:START -->";
const TEAM_OVERLAY_END = "<!-- OMX:TEAM:WORKER:END -->";
const SKILL_REFERENCE_PATTERN = /\/skills\/([^/\s`]+)\/SKILL\.md\b/g;
const AGENTS_LOCK_PATH = [".omx", "state", "agents-md.lock"];
const LOCK_OWNER_FILE = "owner.json";
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_STALE_MS = 30_000;

interface WorkerRootAgentsOptions {
  teamName: string;
  workerName: string;
  workerRole: string;
  rolePromptContent: string;
  teamStateRoot: string;
  leaderCwd: string;
  worktreePath: string;
}

interface WorkerRootAgentsBackup {
  existed: boolean;
  tracked: boolean;
  previousContent?: string;
  skipWorktreeApplied?: boolean;
}

function buildWorkerRootAgentsBackupPath(
  teamStateRoot: string,
  teamName: string,
  workerName: string,
  worktreePath: string,
): string {
  const gitPath = tryReadGitValue(worktreePath, [
    "rev-parse",
    "--git-path",
    "omx/root-agents-backup.json",
  ]);
  return gitPath
    ? gitPath
    : join(
        teamStateRoot,
        "team",
        teamName,
        "workers",
        workerName,
        "root-agents-backup.json",
      );
}

export function generateWorkerRootAgentsContent(
  options: WorkerRootAgentsOptions,
): string {
  return `# Team Worker Runtime Instructions

This file is generated for a live OMX team worker run and is disposable.

## Worker Identity
- Team: ${options.teamName}
- Worker: ${options.workerName}
- Role: ${options.workerRole}
- Leader cwd: ${options.leaderCwd}
- Worktree root: ${options.worktreePath}
- Team state root: ${options.teamStateRoot}
- Inbox path: ${options.teamStateRoot}/team/${options.teamName}/workers/${options.workerName}/inbox.md
- Mailbox path: ${options.teamStateRoot}/team/${options.teamName}/mailbox/${options.workerName}.json
- Leader mailbox path: ${options.teamStateRoot}/team/${options.teamName}/mailbox/leader-fixed.json
- Task directory: ${options.teamStateRoot}/team/${options.teamName}/tasks
- Worker status path: ${options.teamStateRoot}/team/${options.teamName}/workers/${options.workerName}/status.json
- Worker identity path: ${options.teamStateRoot}/team/${options.teamName}/workers/${options.workerName}/identity.json

## Protocol
1. Read your inbox at \`${options.teamStateRoot}/team/${options.teamName}/workers/${options.workerName}/inbox.md\`.
2. Load the worker skill from the first existing path:
   - \`${"${CODEX_HOME:-~/.codex}"}/skills/worker/SKILL.md\`
   - \`${options.leaderCwd}/.codex/skills/worker/SKILL.md\`
   - \`${options.leaderCwd}/skills/worker/SKILL.md\`
3. Send startup ACK before task work:

   \`omx team api send-message --input "{\"team_name\":\"${options.teamName}\",\"from_worker\":\"${options.workerName}\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK: ${options.workerName} initialized\"}" --json\`

4. Resolve canonical team state root in this order: \`OMX_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> local cwd fallback.
5. Read task files from \`${options.teamStateRoot}/team/${options.teamName}/tasks/task-<id>.json\` using bare \`task_id\` values in APIs.
6. Use claim-safe lifecycle APIs only:
   - \`omx team api claim-task --json\`
   - \`omx team api transition-task-status --json\`
   - \`omx team api release-task-claim --json\` only for rollback to pending
7. Use mailbox delivery flow:
   - \`omx team api mailbox-list --input "{\"team_name\":\"${options.teamName}\",\"worker\":\"${options.workerName}\"}" --json\`
   - \`omx team api mailbox-mark-delivered --input "{\"team_name\":\"${options.teamName}\",\"worker\":\"${options.workerName}\",\"message_id\":\"<MESSAGE_ID>\"}" --json\`
8. Preserve leader steering via inbox/mailbox nudges; task payload stays in inbox/task JSON, not this file.
9. Do not pass \`workingDirectory\` to legacy team_* MCP tools; use \`omx team api\` CLI interop.

## Message Protocol
- Always include \`from_worker: "${options.workerName}"\`
- Send leader messages to \`to_worker: "leader-fixed"\`

## Scope Rules
- Follow task-specific edit scope from inbox/task JSON only.
- If blocked on a shared file, update status with a blocked reason and report upward.

<!-- OMX:TEAM:ROLE:START -->
<team_worker_role>
You are operating as the **${options.workerRole}** role for this team run. Apply the following role-local guidance.

${options.rolePromptContent.trim()}
</team_worker_role>
<!-- OMX:TEAM:ROLE:END -->
`;
}

function tryReadGitValue(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function isTracked(worktreePath: string, fileName: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", fileName], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureGitInfoExcludePattern(
  worktreePath: string,
  pattern: string,
): Promise<void> {
  const excludePath = tryReadGitValue(worktreePath, [
    "rev-parse",
    "--git-path",
    "info/exclude",
  ]);
  if (!excludePath) return;
  const existing = existsSync(excludePath)
    ? await readFile(excludePath, "utf-8")
    : "";
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  if (lines.has(pattern)) return;
  const next = `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${pattern}\n`;
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, next, "utf-8");
}

export async function writeWorkerWorktreeRootAgentsFile(
  options: WorkerRootAgentsOptions,
): Promise<string> {
  const agentsPath = join(options.worktreePath, "AGENTS.md");
  const tracked = isTracked(options.worktreePath, "AGENTS.md");
  const existed = existsSync(agentsPath);
  const previousContent = existed
    ? await readFile(agentsPath, "utf-8")
    : undefined;
  let skipWorktreeApplied = false;

  if (tracked) {
    try {
      execFileSync("git", ["update-index", "--skip-worktree", "AGENTS.md"], {
        cwd: options.worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
      skipWorktreeApplied = true;
    } catch {
      skipWorktreeApplied = false;
    }
  } else {
    await ensureGitInfoExcludePattern(options.worktreePath, "AGENTS.md");
  }

  const backup: WorkerRootAgentsBackup = {
    existed,
    tracked,
    previousContent,
    skipWorktreeApplied,
  };
  const backupPath = buildWorkerRootAgentsBackupPath(
    options.teamStateRoot,
    options.teamName,
    options.workerName,
    options.worktreePath,
  );
  await mkdir(dirname(backupPath), { recursive: true });
  await writeFile(backupPath, JSON.stringify(backup, null, 2), "utf-8");
  await writeFile(
    agentsPath,
    generateWorkerRootAgentsContent(options),
    "utf-8",
  );
  return agentsPath;
}

export async function removeWorkerWorktreeRootAgentsFile(
  teamName: string,
  workerName: string,
  teamStateRoot: string,
  worktreePath: string,
): Promise<void> {
  const agentsPath = join(worktreePath, "AGENTS.md");
  const backupPath = buildWorkerRootAgentsBackupPath(
    teamStateRoot,
    teamName,
    workerName,
    worktreePath,
  );
  let backup: WorkerRootAgentsBackup | null = null;

  try {
    backup = JSON.parse(
      await readFile(backupPath, "utf-8"),
    ) as WorkerRootAgentsBackup;
  } catch {
    backup = null;
  }

  if (!backup) {
    return;
  }

  if (backup.tracked && backup.skipWorktreeApplied) {
    try {
      execFileSync("git", ["update-index", "--no-skip-worktree", "AGENTS.md"], {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    } catch {
      // Best-effort cleanup only.
    }
  }

  if (backup.existed) {
    await writeFile(agentsPath, backup.previousContent ?? "", "utf-8");
  } else {
    await rm(agentsPath, { force: true }).catch(() => {});
  }

  await rm(backupPath, { force: true }).catch(() => {});
}

function buildVerificationSection(taskDescription: string): string {
  const verification = getVerificationInstructions(
    "standard",
    taskDescription,
  ).trim();
  const fixLoop = getFixLoopInstructions().trim();
  return `
## Verification Requirements

${verification}

${fixLoop}

When marking completion, include structured verification evidence in your task result:
- \`Verification:\`
- One or more PASS/FAIL checks with command/output references
`;
}

/**
 * Generate generic AGENTS.md overlay for team workers.
 * This is the SAME for all workers -- no per-worker identity.
 * Per-worker context goes in the inbox file.
 */
export function generateWorkerOverlay(teamName: string): string {
  return `${TEAM_OVERLAY_START}
<team_worker_protocol>
You are a team worker in team "${teamName}". Your identity and assigned tasks are in your inbox file.

## Protocol
1. Read your inbox file at the path provided in your first instruction
2. Load the worker skill instructions from the first path that exists:
   - \`${"${CODEX_HOME:-~/.codex}"}/skills/worker/SKILL.md\`
   - \`<leader_cwd>/.codex/skills/worker/SKILL.md\`
   - \`<leader_cwd>/skills/worker/SKILL.md\` (repo fallback)
3. Send an ACK to the lead using CLI interop \`omx team api send-message --json\` (to_worker="leader-fixed") once initialized
4. Resolve canonical team state root in this order:
   - OMX_TEAM_STATE_ROOT env
   - worker identity team_state_root
   - team config/manifest team_state_root
   - local cwd fallback (.omx/state)
5. Read your task from <team_state_root>/team/${teamName}/tasks/task-<id>.json (example: task-1.json)
6. Task id format:
   - State/MCP APIs use task_id: "<id>" (example: "1"), never "task-1"
7. Request a claim via CLI interop (\`omx team api claim-task --json\`); do not directly set lifecycle fields in the task file
8. Do the work using your tools
9. After completing work, commit your changes before reporting completion:
   \`git add -A && git commit -m "task: <task-subject>"\`
   This ensures your changes are available for incremental integration into the leader branch.
10. On completion/failure, use lifecycle transition APIs:
   - \`omx team api transition-task-status --json\` with from \`"in_progress"\` to \`"completed"\` or \`"failed"\`
   - Include \`result\` (for completed) or \`error\` (for failed) in the transition patch
11. Use \`omx team api release-task-claim --json\` only for rollback/requeue to \`pending\` (not for completion)
12. Update your status: write {"state": "idle", "updated_at": "<current ISO timestamp>"} to <team_state_root>/team/${teamName}/workers/{your-name}/status.json
13. Wait for new instructions (the lead will send them via your terminal)
14. Check your mailbox for messages at <team_state_root>/team/${teamName}/mailbox/{your-name}.json
15. For legacy team_* MCP tools (hard-deprecated), switch to \`omx team api\` CLI interop; do not pass workingDirectory unless the lead explicitly tells you to

## Message Protocol
When calling \`omx team api send-message\`, you MUST always include:
- from_worker: "<your-worker-name>" (your identity — check your inbox file for your worker name, never omit this)
- to_worker: "leader-fixed" (to message the leader) or "worker-N" (for peers)

## Startup Handshake (Required)
Before doing any task work, send exactly one startup ACK to the leader.
Keep the body short and deterministic so all worker CLIs (Codex/Claude) behave consistently.

Example:
omx team api send-message --input "{\"team_name\":\"${teamName}\",\"from_worker\":\"<your-worker-name>\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK: <your-worker-name> initialized\"}" --json

CRITICAL: Never omit from_worker. The MCP server cannot auto-detect your identity.

When your mailbox receives a message, process delivery explicitly:
1. Read: \`omx team api mailbox-list --input "{\"team_name\":\"${teamName}\",\"worker\":\"<your-worker-name>\"}" --json\`
2. Mark delivered: \`omx team api mailbox-mark-delivered --input "{\"team_name\":\"${teamName}\",\"worker\":\"<your-worker-name>\",\"message_id\":\"<MESSAGE_ID>\"}" --json\`
3. If you reply, include concrete progress and keep executing your assigned work or the next feasible task after replying.

## Rules
- Do NOT edit files outside the paths listed in your task description
- If you need to modify a shared file, report to the lead by writing to your status file with state "blocked"
- Do NOT write lifecycle fields (\`status\`, \`owner\`, \`result\`, \`error\`) directly in task files; use claim-safe lifecycle APIs
- If blocked, write {"state": "blocked", "reason": "..."} to your status file
- You may spawn Codex native subagents when parallel execution improves throughput.
- Use subagents only for independent, bounded subtasks that can run safely within this worker pane.
</team_worker_protocol>
${TEAM_OVERLAY_END}`;
}

/**
 * Apply worker overlay to AGENTS.md. Idempotent -- strips existing overlay first.
 */
export async function applyWorkerOverlay(
  agentsMdPath: string,
  overlay: string,
): Promise<void> {
  await withAgentsMdLock(agentsMdPath, async () => {
    // Read existing content, strip any existing overlay, append new overlay
    // Uses the START/END markers to find and replace
    let content = "";
    try {
      content = await readFile(agentsMdPath, "utf-8");
    } catch {
      // File doesn't exist yet, start empty
    }

    // Strip existing overlay if present
    content = stripOverlayFromContent(content);

    // Append new overlay
    content = content.trimEnd() + "\n\n" + overlay + "\n";

    await writeFile(agentsMdPath, content);
  });
}

/**
 * Strip worker overlay from AGENTS.md content. Idempotent.
 */
export async function stripWorkerOverlay(agentsMdPath: string): Promise<void> {
  await withAgentsMdLock(agentsMdPath, async () => {
    try {
      const content = await readFile(agentsMdPath, "utf-8");
      const stripped = stripOverlayFromContent(content);
      if (stripped !== content) {
        await writeFile(agentsMdPath, stripped);
      }
    } catch {
      // File doesn't exist, nothing to strip
    }
  });
}

function stripOverlayFromContent(content: string): string {
  const startIdx = content.indexOf(TEAM_OVERLAY_START);
  const endIdx = content.indexOf(TEAM_OVERLAY_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + TEAM_OVERLAY_END.length).trimStart();
  return before + (after ? "\n\n" + after : "") + "\n";
}

function dropShadowedSkillReferenceLines(
  content: string,
  shadowedSkillNames: ReadonlySet<string>,
): string {
  if (shadowedSkillNames.size === 0) return content;

  const lines = content.split("\n");
  const keptLines = lines.filter((line) => {
    SKILL_REFERENCE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SKILL_REFERENCE_PATTERN.exec(line)) !== null) {
      if (shadowedSkillNames.has(match[1] || "")) {
        return false;
      }
    }
    return true;
  });

  return keptLines.join("\n");
}

/**
 * Write a team-scoped model instructions file that composes user-level
 * CODEX_HOME AGENTS.md, the project's AGENTS.md (if any), and the worker
 * overlay. This avoids mutating the source AGENTS.md files directly.
 *
 * Returns the absolute path to the composed file.
 */
export async function writeTeamWorkerInstructionsFile(
  teamName: string,
  cwd: string,
  overlay: string,
): Promise<string> {
  const baseParts: string[] = [];
  const userAgentsPath = join(codexHome(), "AGENTS.md");
  const sourcePaths = [userAgentsPath, join(cwd, "AGENTS.md")];
  const seenPaths = new Set<string>();
  const installedSkills = await listInstalledSkillDirectories(cwd);
  const projectSkillNames = new Set(
    installedSkills
      .filter((skill) => skill.scope === "project")
      .map((skill) => skill.name),
  );

  for (const sourcePath of sourcePaths) {
    if (seenPaths.has(sourcePath)) continue;
    seenPaths.add(sourcePath);

    let content = "";
    try {
      content = await readFile(sourcePath, "utf-8");
    } catch {
      continue;
    }

    content = stripOverlayFromContent(content).trim();
    if (sourcePath === userAgentsPath) {
      content = dropShadowedSkillReferenceLines(
        content,
        projectSkillNames,
      ).trim();
    }
    if (!content) continue;
    baseParts.push(content);
  }

  const base = baseParts.join("\n\n");
  const composed =
    base.trim().length > 0 ? `${base}\n\n${overlay}\n` : `${overlay}\n`;

  const outPath = join(
    cwd,
    ".omx",
    "state",
    "team",
    teamName,
    "worker-agents.md",
  );
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, composed);
  return outPath;
}

/**
 * Compose a per-worker startup instructions file by layering the team worker
 * instructions with the resolved role prompt content.
 */
export async function writeWorkerRoleInstructionsFile(
  teamName: string,
  workerName: string,
  cwd: string,
  baseInstructionsPath: string,
  workerRole: string,
  rolePromptContent: string,
): Promise<string> {
  const base = await readFile(baseInstructionsPath, "utf-8").catch(() => "");
  const roleOverlay = `
<!-- OMX:TEAM:ROLE:START -->
<team_worker_role>
You are operating as the **${workerRole}** role for this team run. Apply the following role-local guidance in addition to the team worker protocol.

${rolePromptContent.trim()}
</team_worker_role>
<!-- OMX:TEAM:ROLE:END -->
`;
  const composed =
    base.trim().length > 0
      ? `${base.trimEnd()}

${roleOverlay}`
      : roleOverlay.trimStart();
  const outPath = join(
    cwd,
    ".omx",
    "state",
    "team",
    teamName,
    "workers",
    workerName,
    "AGENTS.md",
  );
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, composed);
  return outPath;
}

/**
 * Remove the team-scoped model instructions file.
 */
export async function removeTeamWorkerInstructionsFile(
  teamName: string,
  cwd: string,
): Promise<void> {
  const outPath = join(
    cwd,
    ".omx",
    "state",
    "team",
    teamName,
    "worker-agents.md",
  );
  await rm(outPath, { force: true }).catch(() => {});
}

function lockPathFor(agentsMdPath: string): string {
  return join(dirname(agentsMdPath), ...AGENTS_LOCK_PATH);
}

async function acquireAgentsMdLock(
  agentsMdPath: string,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): Promise<void> {
  const lockPath = lockPathFor(agentsMdPath);
  await mkdir(dirname(lockPath), { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath, { recursive: false });
      const ownerFile = join(lockPath, LOCK_OWNER_FILE);
      await writeFile(
        ownerFile,
        JSON.stringify({ pid: process.pid, ts: Date.now() }),
        "utf-8",
      );
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== "EEXIST") throw error;

      const stale = await isStaleLock(lockPath);
      if (stale) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  throw new Error("Failed to acquire AGENTS.md lock within timeout");
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const ownerFile = join(lockPath, LOCK_OWNER_FILE);
  try {
    const owner = JSON.parse(await readFile(ownerFile, "utf-8")) as {
      pid?: number;
      ts?: number;
    };
    if (typeof owner.pid !== "number") return true;
    try {
      process.kill(owner.pid, 0);
    } catch {
      return true;
    }
    return false;
  } catch {
    try {
      const lockStat = await stat(lockPath);
      return Date.now() - lockStat.mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
}

async function releaseAgentsMdLock(agentsMdPath: string): Promise<void> {
  await rm(lockPathFor(agentsMdPath), { recursive: true, force: true }).catch(
    () => {},
  );
}

async function withAgentsMdLock<T>(
  agentsMdPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireAgentsMdLock(agentsMdPath);
  try {
    return await fn();
  } finally {
    await releaseAgentsMdLock(agentsMdPath);
  }
}


function renderDelegationContract(task: TeamTask): string {
  const plan = task.delegation;
  if (!plan || plan.mode === "none") return "";

  const threshold = plan.spawn_before_serial_search_threshold ?? 3;
  const maxParallel = plan.max_parallel_subtasks ?? 2;
  const childModel = plan.child_model ?? "gpt-5.4-mini";
  const candidates = (plan.subtask_candidates ?? [])
    .map((candidate) => `- ${candidate}`)
    .join("\n");
  const requiredProbe = plan.required_parallel_probe
    ? "- A parallel probe is required unless there is a documented skip reason.\n"
    : "";
  const skipLine = plan.skip_allowed_reason_required
    ? "- If skipped, include `Subagent skip reason:` in your result and explain why serial work was safer or sufficient.\n"
    : "";
  const reportFormat = plan.child_report_format ?? "bullets";

  return `
### Native Subagent Delegation Contract — Task ${task.id}

- Delegation mode: ${plan.mode}
- Before doing more than ${threshold} serial repo-search/read commands, spawn up to ${maxParallel} Codex native subagents using model ${childModel}, wait for them, then integrate their findings before continuing.
${requiredProbe}- Keep subagent work independent, bounded, and inside this worker's task scope.
- Use child report format: ${reportFormat}.
${skipLine}${candidates ? `\nRole/probe subtask candidates:\n${candidates}\n` : ""}
Subagent evidence reporting fields:
- Subagents spawned: <count and task names>
- Subagent model: ${childModel}
- Findings integrated: <brief bullets>
- Serial searches before spawn: <number>

Delegation compliance evidence (required for completion):
- Include exactly one of these lines in the task completion \`result\` passed to \`omx team api transition-task-status\`:
  - \`Subagent spawn evidence: <count, child task names/thread ids, and what findings were integrated>\`
  - \`Subagent skip reason: <why serial execution was safer/sufficient>\`
- Completion is rejected with \`missing_delegation_compliance_evidence\` when this broad-task evidence is absent.
`;
}

function renderDelegationContracts(tasks: TeamTask[]): string {
  const sections = tasks.map(renderDelegationContract).filter((section) => section.trim().length > 0);
  if (sections.length === 0) return "";
  return `
## Native Subagent Delegation Contract

${sections.join("\n")}`;
}

/**
 * Generate initial inbox file content for worker bootstrap.
 * This is written to .omx/state/team/{team}/workers/{worker}/inbox.md by the lead.
 */
export function generateInitialInbox(
  workerName: string,
  teamName: string,
  agentType: string,
  tasks: TeamTask[],
  options: {
    teamStateRoot?: string;
    leaderCwd?: string;
    workerRole?: string;
    rolePromptContent?: string;
    worktreeRootAgentsCanonical?: boolean;
    taskHints?: Record<string, TaskHintSummary>;
    approvedContextSummary?: ApprovedRepositoryContextSummary;
  } = {},
): string {
  const taskList = tasks
    .map((t) => {
      let entry = `- **Task ${t.id}**: ${t.subject}\n  Description: ${t.description}\n  Status: ${t.status}`;
      if (t.blocked_by && t.blocked_by.length > 0) {
        entry += `\n  Blocked by: ${t.blocked_by.join(", ")}`;
      }
      if (t.depends_on && t.depends_on.length > 0 && !t.blocked_by?.length) {
        entry += `\n  Depends on: ${t.depends_on.join(", ")}`;
      }
      if (t.role) {
        entry += `\n  Role: ${t.role}`;
      }
      const hint = options.taskHints?.[t.id];
      const filePaths = hint?.filePaths ?? t.filePaths;
      const domains = hint?.domains ?? t.domains;
      const lane = hint?.lane ?? t.lane;
      const allocationReason = hint?.allocation_reason ?? t.allocation_reason;
      if (filePaths?.length) {
        entry += `\n  File paths: ${filePaths.join(", ")}`;
      }
      if (domains?.length) {
        entry += `\n  Domains: ${domains.join(", ")}`;
      }
      if (lane) {
        entry += `\n  Lane: ${lane}`;
      }
      if (allocationReason) {
        entry += `\n  Allocation reason: ${allocationReason}`;
      }
      return entry;
    })
    .join("\n");

  const teamStateRoot = options.teamStateRoot || "<team_state_root>";
  const leaderCwd = options.leaderCwd || "<leader_cwd>";
  const displayRole = options.workerRole ?? agentType;
  const delegationSection = renderDelegationContracts(tasks);

  const approvedContextSection = options.approvedContextSummary
    ? `
## Approved Repository Context Summary

Source: ${options.approvedContextSummary.sourcePath}${options.approvedContextSummary.truncated ? ' (bounded/truncated)' : ''}

${options.approvedContextSummary.content}
`
    : "";

  const specializationSection = options.worktreeRootAgentsCanonical === true
    ? ""
    : options.rolePromptContent
      ? `\n## Your Specialization\n\nYou are operating as a **${displayRole}** agent. Follow these behavioral guidelines:\n\n${options.rolePromptContent}\n`
      : "";

  return `# Worker Assignment: ${workerName}

**Team:** ${teamName}
**Role:** ${displayRole}
**Worker Name:** ${workerName}

## Your Assigned Tasks

${taskList}
${approvedContextSection}
## Instructions

1. Load and follow the worker skill from the first existing path:
   - \`${"${CODEX_HOME:-~/.codex}"}/skills/worker/SKILL.md\`
   - \`${leaderCwd}/.codex/skills/worker/SKILL.md\`
   - \`${leaderCwd}/skills/worker/SKILL.md\` (repo fallback)
2. Send startup ACK to the lead mailbox BEFORE any task work (run this exact command):

   \`omx team api send-message --input "{\"team_name\":\"${teamName}\",\"from_worker\":\"${workerName}\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK: ${workerName} initialized\"}" --json\`

3. Start with the first non-blocked task
4. Resolve canonical team state root in this order: \`OMX_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> local cwd fallback.
5. Read the task file for your selected task id at \`${teamStateRoot}/team/${teamName}/tasks/task-<id>.json\` (example: \`task-1.json\`)
6. Task id format:
   - State/MCP APIs use \`task_id: "<id>"\` (example: \`"1"\`), not \`"task-1"\`.
7. Request a claim via CLI interop (\`omx team api claim-task --json\`) to claim it
8. Complete the work described in the task
9. After completing work, commit your changes before reporting completion:
   \`git add -A && git commit -m "task: <task-subject>"\`
   This ensures your changes are available for incremental integration into the leader branch.
10. Complete/fail it via lifecycle transition API (\`omx team api transition-task-status --json\`) from \`"in_progress"\` to \`"completed"\` or \`"failed"\` (include \`result\`/\`error\`)
11. Use \`omx team api release-task-claim --json\` only for rollback to \`pending\`
12. Write \`{"state": "idle", "updated_at": "<current ISO timestamp>"}\` to \`${teamStateRoot}/team/${teamName}/workers/${workerName}/status.json\`
13. Wait for the next instruction from the lead
14. For legacy team_* MCP tools (hard-deprecated), use \`omx team api\`; do not pass \`workingDirectory\` unless the lead explicitly asks (if resolution fails, use leader cwd: \`${leaderCwd}\`)

## Mailbox Delivery Protocol (Required)
When you are notified about mailbox messages, always follow this exact flow:

1. List mailbox:
   \`omx team api mailbox-list --input "{\"team_name\":\"${teamName}\",\"worker\":\"${workerName}\"}" --json\`
2. For each undelivered message, mark delivery:
   \`omx team api mailbox-mark-delivered --input "{\"team_name\":\"${teamName}\",\"worker\":\"${workerName}\",\"message_id\":\"<MESSAGE_ID>\"}" --json\`

Use terse ACK bodies (single line) for consistent parsing across Codex and Claude workers.
After any mailbox reply, continue executing your assigned work or the next feasible task; do not stop after sending the reply.

## Message Protocol
When using \`omx team api send-message\`, ALWAYS include from_worker with YOUR worker name:
- from_worker: "${workerName}"
- to_worker: "leader-fixed" (for leader) or "worker-N" (for peers)

Example: omx team api send-message --input "{\"team_name\":\"${teamName}\",\"from_worker\":\"${workerName}\",\"to_worker\":\"leader-fixed\",\"body\":\"ACK: initialized\"}" --json

${delegationSection}
${buildVerificationSection("each assigned task")}

## Scope Rules
- Only edit files described in your task descriptions
- Do NOT edit files that belong to other workers
- If you need to modify a shared/common file, write \`{"state": "blocked", "reason": "need to edit shared file X"}\` to your status file and wait
- You may spawn Codex native subagents when parallel execution improves throughput.
- Use subagents only for independent, bounded subtasks that can run safely within this worker pane.
${specializationSection}`;
}

/**
 * Generate inbox content for a follow-up task assignment.
 */
export function generateTaskAssignmentInbox(
  workerName: string,
  teamName: string,
  task: TeamTask,
): string;
export function generateTaskAssignmentInbox(
  workerName: string,
  teamName: string,
  taskId: string,
  taskDescription: string,
): string;
export function generateTaskAssignmentInbox(
  workerName: string,
  teamName: string,
  taskOrId: TeamTask | string,
  taskDescriptionArg?: string,
): string {
  const task = typeof taskOrId === "string"
    ? { id: taskOrId, description: taskDescriptionArg ?? "" }
    : taskOrId;
  const taskId = task.id;
  const taskDescription = task.description;
  const delegationSection = renderDelegationContracts([task as TeamTask]);

  return `# New Task Assignment

**Worker:** ${workerName}
**Task ID:** ${taskId}

## Task Description

${taskDescription}

## Instructions

1. Resolve canonical team state root and read the task file at \`<team_state_root>/team/${teamName}/tasks/task-${taskId}.json\`
2. Task id format:
   - State/MCP APIs use \`task_id: "${taskId}"\` (not \`"task-${taskId}"\`).
3. Request a claim via CLI interop (\`omx team api claim-task --json\`)
4. Complete the work
5. After completing work, commit your changes before reporting completion:
   \`git add -A && git commit -m "task: <task-subject>"\`
   This ensures your changes are available for incremental integration into the leader branch.
6. Complete/fail via lifecycle transition API (\`omx team api transition-task-status --json\`) from \`"in_progress"\` to \`"completed"\` or \`"failed"\` (include \`result\`/\`error\`)
7. Use \`omx team api release-task-claim --json\` only for rollback to \`pending\`
8. Write \`{"state": "idle", "updated_at": "<current ISO timestamp>"}\` to your status file

${delegationSection}
${buildVerificationSection(taskDescription)}
`;
}

/**
 * Generate inbox content for shutdown.
 */
export function generateShutdownInbox(
  teamName: string,
  workerName: string,
): string {
  return `# Shutdown Request

All tasks are complete. Please wrap up any remaining work and respond with a shutdown acknowledgement.

## Shutdown Ack Protocol
1. Write your decision to:
   \`<team_state_root>/team/${teamName}/workers/${workerName}/shutdown-ack.json\`
2. Format:
   - Accept:
     \`{\"status\":\"accept\",\"reason\":\"ok\",\"updated_at\":\"<iso>\"}\`
   - Reject:
     \`{\"status\":\"reject\",\"reason\":\"still working\",\"updated_at\":\"<iso>\"}\`
3. After writing the ack, exit your Codex session.

Type \`exit\` or press Ctrl+C to end your Codex session.
`;
}

function buildInstructionPath(...parts: string[]): string {
  return join(...parts).replaceAll("\\", "/");
}

/**
 * Generate the SHORT send-keys trigger message.
 * Always < 200 characters, ASCII-safe.
 */
export function generateTriggerMessage(
  workerName: string,
  teamName: string,
  teamStateRoot: string = ".omx/state",
): string {
  return buildTriggerDirective(workerName, teamName, teamStateRoot).text;
}

export function buildTriggerDirective(
  workerName: string,
  teamName: string,
  teamStateRoot: string = ".omx/state",
): TeamReminderDirective {
  const inboxPath = buildInstructionPath(
    teamStateRoot,
    "team",
    teamName,
    "workers",
    workerName,
    "inbox.md",
  );
  if (teamStateRoot !== ".omx/state") {
    return {
      intent: "followup-relaunch",
      text: `Read ${inboxPath}, work now, report progress, continue assigned work or next feasible task.`,
    };
  }
  return {
    intent: "followup-relaunch",
    text: `Read ${inboxPath}, start work now, report concrete progress, then continue assigned work or next feasible task.`,
  };
}

/**
 * Generate a SHORT trigger for mailbox notifications.
 * Always < 200 characters, ASCII-safe.
 */
export function generateMailboxTriggerMessage(
  workerName: string,
  teamName: string,
  count: number,
  teamStateRoot: string = ".omx/state",
): string {
  return buildMailboxTriggerDirective(workerName, teamName, count, teamStateRoot).text;
}

export function buildMailboxTriggerDirective(
  workerName: string,
  teamName: string,
  count: number,
  teamStateRoot: string = ".omx/state",
): TeamReminderDirective {
  const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  const mailboxPath = buildInstructionPath(
    teamStateRoot,
    "team",
    teamName,
    "mailbox",
    workerName + ".json",
  );
  if (teamStateRoot !== ".omx/state") {
    return {
      intent: "pending-mailbox-review",
      text: `${n} new msg(s): read ${mailboxPath}, act, report progress, continue assigned work or next feasible task.`,
    };
  }
  return {
    intent: "pending-mailbox-review",
    text: `You have ${n} new message(s). Read ${mailboxPath}, act now, reply with concrete progress, then continue assigned work or next feasible task.`,
  };
}

export function generateLeaderMailboxTriggerMessage(
  teamName: string,
  fromWorker: string,
  teamStateRoot: string = ".omx/state",
): string {
  return buildLeaderMailboxTriggerDirective(teamName, fromWorker, teamStateRoot).text;
}

export function buildLeaderMailboxTriggerDirective(
  teamName: string,
  fromWorker: string,
  teamStateRoot: string = ".omx/state",
): TeamReminderDirective {
  const mailboxPath = buildInstructionPath(
    teamStateRoot,
    "team",
    teamName,
    "mailbox",
    "leader-fixed.json",
  );
  if (teamStateRoot !== ".omx/state") {
    return {
      intent: "pending-mailbox-review",
      text: `Read ${mailboxPath}; new msg from ${fromWorker}. Review it; decide next step.`,
    };
  }
  return {
    intent: "pending-mailbox-review",
    text: `Read ${mailboxPath}; ${fromWorker} sent a new message. Review it and decide the next concrete step.`,
  };
}
