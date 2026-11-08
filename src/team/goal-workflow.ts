import type { TeamTask } from "./state.js";

export interface TeamWorkerGoalInstruction {
  teamName: string;
  workerName: string;
  objective: string;
  taskIds: string[];
  taskReferences: Array<{
    id: string;
    subject: string;
    status: TeamTask["status"];
    claimOwner?: string;
    claimLeasedUntil?: string;
  }>;
}

export function buildTeamWorkerGoalInstruction(
  teamName: string,
  workerName: string,
  tasks: TeamTask[],
  options: { teamStateRoot?: string; objective?: string } = {},
): TeamWorkerGoalInstruction | undefined {
  if (tasks.length === 0) return undefined;

  void options.teamStateRoot;
  const taskIds = tasks.map((task) => task.id);
  const objective = options.objective ??
    `Complete assigned OMX team task${taskIds.length === 1 ? "" : "s"} ${taskIds.join(", ")} for ${teamName} with verified evidence, preserving leader-owned audit.`;

  return {
    teamName,
    workerName,
    objective,
    taskIds,
    taskReferences: tasks.map((task) => ({
      id: task.id,
      subject: task.subject,
      status: task.status,
      claimOwner: task.claim?.owner,
      claimLeasedUntil: task.claim?.leased_until,
    })),
  };
}

export function renderTeamWorkerGoalInstruction(
  instruction: TeamWorkerGoalInstruction | undefined,
): string {
  if (!instruction) return "";

  const taskLines = instruction.taskReferences
    .map((task) => {
      const claim = task.claimOwner
        ? `; active claim owner: ${task.claimOwner}${task.claimLeasedUntil ? ` until ${task.claimLeasedUntil}` : ""}`
        : "; claim required before work";
      return `- Task ${task.id}: ${task.subject} (status: ${task.status}${claim})`;
    })
    .join("\n");

  return `
## Scrum / Team Goal Workflow

Objective: ${instruction.objective}

Durable OMX source of truth:
- Existing team task files, task claims, lifecycle events, and leader audit remain the durable artifacts.
- This section is a logical Codex goal handoff only; it does not create separate per-worker goal JSON or leader-audit artifacts.

Source-of-truth rules:
- Existing team task files and claim lifecycle remain authoritative; this worker goal must reference task IDs ${instruction.taskIds.join(", ")} instead of creating a duplicate task list.
- Claim unclaimed tasks with \`omx team api claim-task\` before editing; for a leader-preclaimed assignment, use the handed-off claim token instead of re-claiming. Use the task file claim/status as the current assignment record.
- Record completion evidence through \`omx team api transition-task-status\`; leader audit owns aggregate team completion.

Assigned task/claim references:
${taskLines}

Codex goal handoff guidance (truthful fallback only):
1. If goal tools are available in this worker thread, call \`get_goal\` before creating or completing a goal.
2. Call \`create_goal\` only when no active goal exists and the explicit worker objective above should become this thread's active objective.
3. Do not claim OMX shell commands mutated Codex goal state; shell/team APIs persist only OMX artifacts and task state.
4. Call \`update_goal({status: "complete"})\` only after assigned task transitions are complete and verification evidence is present for leader audit.
`;
}
