import type { TeamTask } from './state.js';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

const TEAM_OVERLAY_START = '<!-- OMX:TEAM:WORKER:START -->';
const TEAM_OVERLAY_END = '<!-- OMX:TEAM:WORKER:END -->';
const AGENTS_LOCK_PATH = ['.omx', 'state', 'agents-md.lock'];
const LOCK_OWNER_FILE = 'owner.json';
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_STALE_MS = 30_000;

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
4. Read your task from .omx/state/team/${teamName}/tasks/task-<id>.json (example: task-1.json)
5. Task id format:
   - State/MCP APIs use task_id: "<id>" (example: "1"), never "task-1"
6. Request a claim via the state API (claimTask); do not directly set status to "in_progress" in the task file
7. Do the work using your tools
8. On completion: write {"status": "completed", "result": "summary of what was done"} to the task file
9. Update your status: write {"state": "idle"} to .omx/state/team/${teamName}/workers/{your-name}/status.json
10. Wait for new instructions (the lead will send them via your terminal)
11. Check your mailbox for messages at .omx/state/team/${teamName}/mailbox/{your-name}.json

## Rules
- Do NOT edit files outside the paths listed in your task description
- If you need to modify a shared file, report to the lead by writing to your status file with state "blocked"
- ALWAYS write results to the task file before reporting done
- If blocked, write {"state": "blocked", "reason": "..."} to your status file
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
4. Read the task file for your selected task id at \`.omx/state/team/${teamName}/tasks/task-<id>.json\` (example: \`task-1.json\`)
5. Task id format:
   - State/MCP APIs use \`task_id: "<id>"\` (example: \`"1"\`), not \`"task-1"\`.
6. Request a claim via state API (\`claimTask\`) to claim it
7. Complete the work described in the task
8. Write \`{"status": "completed", "result": "brief summary"}\` to the task file
9. Write \`{"state": "idle"}\` to \`.omx/state/team/${teamName}/workers/${workerName}/status.json\`
10. Wait for the next instruction from the lead

## Scope Rules
- Only edit files described in your task descriptions
- Do NOT edit files that belong to other workers
- If you need to modify a shared/common file, write \`{"state": "blocked", "reason": "need to edit shared file X"}\` to your status file and wait
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

1. Read the task file at \`.omx/state/team/${teamName}/tasks/task-${taskId}.json\`
2. Task id format:
   - State/MCP APIs use \`task_id: "${taskId}"\` (not \`"task-${taskId}"\`).
3. Request a claim via state API (\`claimTask\`)
4. Complete the work
5. Write \`{"status": "completed", "result": "brief summary"}\` when done
6. Write \`{"state": "idle"}\` to your status file
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
   \`.omx/state/team/${teamName}/workers/${workerName}/shutdown-ack.json\`
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
