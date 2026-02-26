import type { TeamTask } from './state.js';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { getFixLoopInstructions, getVerificationInstructions } from '../verification/verifier.js';

const TEAM_OVERLAY_START = '<!-- OMX:TEAM:WORKER:START -->';
const TEAM_OVERLAY_END = '<!-- OMX:TEAM:WORKER:END -->';
const AGENTS_LOCK_PATH = ['.omx', 'state', 'agents-md.lock'];
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_STALE_MS = 30_000;

function buildVerificationSection(taskDescription: string): string {
  const verification = getVerificationInstructions('standard', taskDescription).trim();
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
2. Load the worker skill instructions from skills/worker/SKILL.md in this repository and follow them
3. Send an ACK to the lead using MCP tool team_send_message (to_worker="leader-fixed") once initialized
4. Resolve canonical team state root in this order:
   - OMX_TEAM_STATE_ROOT env
   - worker identity team_state_root
   - team config/manifest team_state_root
   - local cwd fallback (.omx/state)
5. Read your task from <team_state_root>/team/${teamName}/tasks/task-<id>.json (example: task-1.json)
6. Task id format:
   - State/MCP APIs use task_id: "<id>" (example: "1"), never "task-1"
7. Request a claim via the state API (claimTask); do not directly set status to "in_progress" in the task file
8. Do the work using your tools
9. On completion: write {"status": "completed", "result": "summary of what was done"} to the task file
10. Update your status: write {"state": "idle"} to <team_state_root>/team/${teamName}/workers/{your-name}/status.json
11. Wait for new instructions (the lead will send them via your terminal)
12. Check your mailbox for messages at <team_state_root>/team/${teamName}/mailbox/{your-name}.json
13. For team_* MCP tools, do not pass workingDirectory unless the lead explicitly tells you to

## Rules
- Do NOT edit files outside the paths listed in your task description
- If you need to modify a shared file, report to the lead by writing to your status file with state "blocked"
- ALWAYS write results to the task file before reporting done
- If blocked, write {"state": "blocked", "reason": "..."} to your status file
- Do NOT spawn sub-agents (no spawn_agent). Complete work in this worker session only.
</team_worker_protocol>
${TEAM_OVERLAY_END}`;
}

/**
 * Apply worker overlay to AGENTS.md. Idempotent -- strips existing overlay first.
 */
export async function applyWorkerOverlay(agentsMdPath: string, overlay: string): Promise<void> {
  await withAgentsMdLock(agentsMdPath, async () => {
    // Read existing content, strip any existing overlay, append new overlay
    // Uses the START/END markers to find and replace
    let content = '';
    try {
      content = await readFile(agentsMdPath, 'utf-8');
    } catch {
      // File doesn't exist yet, start empty
    }

    // Strip existing overlay if present
    content = stripOverlayFromContent(content);

    // Append new overlay
    content = content.trimEnd() + '\n\n' + overlay + '\n';

    await writeFile(agentsMdPath, content);
  });
}

/**
 * Strip worker overlay from AGENTS.md content. Idempotent.
 */
export async function stripWorkerOverlay(agentsMdPath: string): Promise<void> {
  await withAgentsMdLock(agentsMdPath, async () => {
    try {
      const content = await readFile(agentsMdPath, 'utf-8');
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
  return before + (after ? '\n\n' + after : '') + '\n';
}

/**
 * Write a team-scoped model instructions file that composes the project's
 * AGENTS.md (if any) with the worker overlay. This avoids mutating the
 * project's AGENTS.md directly.
 *
 * Returns the absolute path to the composed file.
 */
export async function writeTeamWorkerInstructionsFile(
  teamName: string,
  cwd: string,
  overlay: string,
): Promise<string> {
  const projectAgentsPath = join(cwd, 'AGENTS.md');
  let base = '';
  try {
    base = await readFile(projectAgentsPath, 'utf-8');
    // Strip any stale overlays from the base content
    base = stripOverlayFromContent(base);
  } catch {
    // No project AGENTS.md -- compose with overlay only
  }

  const composed = base.trim().length > 0
    ? `${base.trimEnd()}\n\n${overlay}\n`
    : `${overlay}\n`;

  const outPath = join(cwd, '.omx', 'state', 'team', teamName, 'worker-agents.md');
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
  const outPath = join(cwd, '.omx', 'state', 'team', teamName, 'worker-agents.md');
  await rm(outPath, { force: true }).catch(() => {});
}

function lockPathFor(agentsMdPath: string): string {
  return join(dirname(agentsMdPath), ...AGENTS_LOCK_PATH);
}

async function acquireAgentsMdLock(agentsMdPath: string, timeoutMs: number = LOCK_TIMEOUT_MS): Promise<void> {
  const lockPath = lockPathFor(agentsMdPath);
  await mkdir(dirname(lockPath), { recursive: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await mkdir(lockPath, { recursive: false });
      const ownerFile = join(lockPath, LOCK_OWNER_FILE);
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf-8');
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code && code !== 'EEXIST') throw error;

      const stale = await isStaleLock(lockPath);
      if (stale) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  throw new Error('Failed to acquire AGENTS.md lock within timeout');
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const ownerFile = join(lockPath, LOCK_OWNER_FILE);
  try {
    const owner = JSON.parse(await readFile(ownerFile, 'utf-8')) as { pid?: number; ts?: number };
    if (typeof owner.pid !== 'number') return true;
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
  await rm(lockPathFor(agentsMdPath), { recursive: true, force: true }).catch(() => {});
}

async function withAgentsMdLock<T>(agentsMdPath: string, fn: () => Promise<T>): Promise<T> {
  await acquireAgentsMdLock(agentsMdPath);
  try {
    return await fn();
  } finally {
    await releaseAgentsMdLock(agentsMdPath);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  } = {},
): string {
  const taskList = tasks
    .map((t) => {
      let entry = `- **Task ${t.id}**: ${t.subject}\n  Description: ${t.description}\n  Status: ${t.status}`;
      if (t.blocked_by && t.blocked_by.length > 0) {
        entry += `\n  Blocked by: ${t.blocked_by.join(', ')}`;
      }
      return entry;
    })
    .join('\n');

  const teamStateRoot = options.teamStateRoot || '<team_state_root>';
  const leaderCwd = options.leaderCwd || '<leader_cwd>';

  return `# Worker Assignment: ${workerName}

**Team:** ${teamName}
**Role:** ${agentType}
**Worker Name:** ${workerName}

## Your Assigned Tasks

${taskList}

## Instructions

1. Load and follow \`skills/worker/SKILL.md\`
2. Send startup ACK to the lead mailbox using MCP tool \`team_send_message\` with \`to_worker="leader-fixed"\`
3. Start with the first non-blocked task
4. Resolve canonical team state root in this order: \`OMX_TEAM_STATE_ROOT\` env -> worker identity \`team_state_root\` -> config/manifest \`team_state_root\` -> local cwd fallback.
5. Read the task file for your selected task id at \`${teamStateRoot}/team/${teamName}/tasks/task-<id>.json\` (example: \`task-1.json\`)
6. Task id format:
   - State/MCP APIs use \`task_id: "<id>"\` (example: \`"1"\`), not \`"task-1"\`.
7. Request a claim via state API (\`claimTask\`) to claim it
8. Complete the work described in the task
9. Write \`{"status": "completed", "result": "brief summary"}\` to the task file
10. Write \`{"state": "idle"}\` to \`${teamStateRoot}/team/${teamName}/workers/${workerName}/status.json\`
11. Wait for the next instruction from the lead
12. For team_* MCP tools, do not pass \`workingDirectory\` unless the lead explicitly asks (if resolution fails, use leader cwd: \`${leaderCwd}\`)

${buildVerificationSection('each assigned task')}

## Scope Rules
- Only edit files described in your task descriptions
- Do NOT edit files that belong to other workers
- If you need to modify a shared/common file, write \`{"state": "blocked", "reason": "need to edit shared file X"}\` to your status file and wait
- Do NOT spawn sub-agents (no \`spawn_agent\`). Complete work in this worker session.
`;
}

/**
 * Generate inbox content for a follow-up task assignment.
 */
export function generateTaskAssignmentInbox(
  workerName: string,
  teamName: string,
  taskId: string,
  taskDescription: string,
): string {
  return `# New Task Assignment

**Worker:** ${workerName}
**Task ID:** ${taskId}

## Task Description

${taskDescription}

## Instructions

1. Resolve canonical team state root and read the task file at \`<team_state_root>/team/${teamName}/tasks/task-${taskId}.json\`
2. Task id format:
   - State/MCP APIs use \`task_id: "${taskId}"\` (not \`"task-${taskId}"\`).
3. Request a claim via state API (\`claimTask\`)
4. Complete the work
5. Write \`{"status": "completed", "result": "brief summary"}\` when done
6. Write \`{"state": "idle"}\` to your status file

${buildVerificationSection(taskDescription)}
`;
}

/**
 * Generate inbox content for shutdown.
 */
export function generateShutdownInbox(teamName: string, workerName: string): string {
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

/**
 * Generate the SHORT send-keys trigger message.
 * Always < 200 characters, ASCII-safe.
 */
export function generateTriggerMessage(workerName: string, teamName: string): string {
  return `Read and follow the instructions in .omx/state/team/${teamName}/workers/${workerName}/inbox.md`;
}

/**
 * Generate a SHORT trigger for mailbox notifications.
 * Always < 200 characters, ASCII-safe.
 */
export function generateMailboxTriggerMessage(workerName: string, teamName: string, count: number): string {
  const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
  return `You have ${n} new message(s). Check .omx/state/team/${teamName}/mailbox/${workerName}.json`;
}
