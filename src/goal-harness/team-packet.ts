import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendGoalWorkflowLedger,
  readGoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  readGoalHarnessRuntime,
  writeGoalHarnessRuntime,
  GoalHarnessRuntimeError,
  type GoalHarnessTeamLanePlan,
  type GoalHarnessTeamPlan,
  type GoalHarnessRuntimeState,
} from './runtime.js';

export const GOAL_HARNESS_TEAM_PACKET_DIR = 'team-packets';
export const GOAL_HARNESS_TEAM_PACKET_MANIFEST = 'manifest.json';
const GOAL_HARNESS_WORKFLOW = 'goal-harness';

export interface WriteGoalHarnessTeamPacketOptions {
  slug: string;
  planId?: string;
  now?: Date;
}

export interface GoalHarnessTeamPacketLane {
  role: GoalHarnessTeamLanePlan['role'];
  task: string;
  instructionPath: string;
  resultTemplatePath: string;
  expectedEvidence: string[];
  recordTrajectoryCommand: string;
}

export interface GoalHarnessTeamPacket {
  version: 1;
  workflow: 'goal-harness';
  slug: string;
  planId: string;
  phase: GoalHarnessTeamPlan['phase'];
  artifactDir: string;
  manifestPath: string;
  createdAt: string;
  teamLaunchCommand: string;
  leaderInstructions: string[];
  lanes: GoalHarnessTeamPacketLane[];
}

export interface WriteGoalHarnessTeamPacketResult {
  runtime: GoalHarnessRuntimeState;
  plan: GoalHarnessTeamPlan;
  packet: GoalHarnessTeamPacket;
}

function iso(now = new Date()): string {
  return now.toISOString();
}

function safeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '') || 'lane';
}

function latestOrNamedPlan(runtime: GoalHarnessRuntimeState, planId: string | undefined): GoalHarnessTeamPlan {
  if (planId?.trim()) {
    const plan = runtime.teamPlans.find((item) => item.id === planId.trim());
    if (!plan) throw new GoalHarnessRuntimeError(`Unknown goal-harness team plan: ${planId}`);
    return plan;
  }
  const plan = runtime.teamPlans.at(-1);
  if (!plan) throw new GoalHarnessRuntimeError('No goal-harness team plan exists; run team-plan first.');
  return plan;
}

function renderInstruction(plan: GoalHarnessTeamPlan, lane: GoalHarnessTeamLanePlan, resultTemplatePath: string): string {
  return [
    `# Goal Harness Worker Packet: ${lane.role}`,
    '',
    `Plan: ${plan.id}`,
    `Phase: ${plan.phase}`,
    '',
    '## Assigned Lane',
    '',
    lane.task,
    '',
    '## Boundary',
    '',
    lane.instruction,
    '',
    '## Expected Evidence',
    '',
    ...lane.expectedEvidence.map((item) => `- ${item}`),
    '',
    '## Result',
    '',
    `Fill or mirror the result template at \`${resultTemplatePath}\`. Return evidence only; the leader decides whether to record the result as a trajectory.`,
    '',
  ].join('\n');
}

function renderResultTemplate(slug: string, plan: GoalHarnessTeamPlan, lane: GoalHarnessTeamLanePlan): string {
  return [
    '# Goal Harness Worker Result',
    '',
    `- slug: ${slug}`,
    `- plan_id: ${plan.id}`,
    `- role: ${lane.role}`,
    '- status: pass|issues|blocked',
    '- score: 0-100',
    '- novelty_score: 0-100',
    '',
    '## Summary',
    '',
    '<one-paragraph result>',
    '',
    '## Evidence',
    '',
    '- <file, diff, source, command output, or observation>',
    '',
    '## Commands',
    '',
    '- command: <command or inspection>',
    '  status: pass|fail|blocked',
    '  evidence: <observed result>',
    '',
    '## Risks Or Blockers',
    '',
    '- <risk, blocker, or none>',
    '',
    '## Candidate Trajectory',
    '',
    '<what the leader should record if this output is accepted>',
    '',
    '## Goal Boundary Confirmation',
    '',
    '- I did not call create_goal.',
    '- I did not call update_goal.',
    '- I did not mark the whole mission complete.',
    '',
  ].join('\n');
}

function recordTrajectoryCommand(slug: string, lane: GoalHarnessTeamLanePlan): string {
  return [
    'omx goal-harness record-trajectory',
    `--slug ${slug}`,
    '--source worker',
    `--role ${lane.role}`,
    '--summary "<worker result summary>"',
    '--evidence "<concrete worker evidence>"',
    '--score <0-100>',
    '--novelty-score <0-100>',
  ].join(' ');
}

export async function writeGoalHarnessTeamPacket(
  cwd: string,
  options: WriteGoalHarnessTeamPacketOptions,
): Promise<WriteGoalHarnessTeamPacketResult> {
  const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, options.slug);
  const runtime = await readGoalHarnessRuntime(cwd, run.slug);
  const plan = latestOrNamedPlan(runtime, options.planId);
  const createdAt = iso(options.now);
  const artifactDir = `${run.artifactDir}/${GOAL_HARNESS_TEAM_PACKET_DIR}/${safeFileSegment(plan.id)}`;
  const manifestPath = `${artifactDir}/${GOAL_HARNESS_TEAM_PACKET_MANIFEST}`;
  await mkdir(join(cwd, artifactDir), { recursive: true });

  const lanes: GoalHarnessTeamPacketLane[] = [];
  for (const [index, lane] of plan.lanes.entries()) {
    const prefix = `${String(index + 1).padStart(2, '0')}-${safeFileSegment(lane.role)}`;
    const instructionPath = `${artifactDir}/${prefix}-instruction.md`;
    const resultTemplatePath = `${artifactDir}/${prefix}-result.md`;
    await writeFile(join(cwd, instructionPath), renderInstruction(plan, lane, resultTemplatePath), 'utf-8');
    await writeFile(join(cwd, resultTemplatePath), renderResultTemplate(run.slug, plan, lane), 'utf-8');
    lanes.push({
      role: lane.role,
      task: lane.task,
      instructionPath,
      resultTemplatePath,
      expectedEvidence: lane.expectedEvidence,
      recordTrajectoryCommand: recordTrajectoryCommand(run.slug, lane),
    });
  }

  const teamLaunchTask = `Goal Harness ${run.slug} ${plan.id}: read ${manifestPath}; each worker claims one lane packet, follows the goal boundary, and returns evidence only.`;
  const packet: GoalHarnessTeamPacket = {
    version: 1,
    workflow: GOAL_HARNESS_WORKFLOW,
    slug: run.slug,
    planId: plan.id,
    phase: plan.phase,
    artifactDir,
    manifestPath,
    createdAt,
    teamLaunchCommand: `omx team ${lanes.length}:executor ${JSON.stringify(teamLaunchTask)}`,
    leaderInstructions: [
      'Launch Team only when independent worker pressure is worth the coordination cost.',
      'Give workers the manifest path and assign at most one lane per worker.',
      'Workers must return evidence only and must not call create_goal or update_goal.',
      'Record accepted worker results with each lane recordTrajectoryCommand.',
      'The leader owns the Codex goal and final completion gate.',
    ],
    lanes,
  };
  await writeFile(join(cwd, manifestPath), `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');

  plan.packetPath = artifactDir;
  plan.packetManifestPath = manifestPath;
  runtime.updatedAt = createdAt;
  await writeGoalHarnessRuntime(cwd, runtime);
  await appendGoalWorkflowLedger(cwd, run, {
    ts: createdAt,
    event: 'team_packet_built',
    status: run.status,
    message: `Goal harness team packet built: ${plan.id}`,
    evidence: `Worker packet manifest: ${manifestPath}`,
    metadata: {
      planId: plan.id,
      artifactDir,
      manifestPath,
      laneCount: lanes.length,
      lanes: lanes.map((lane) => lane.role),
    },
  });

  return { runtime, plan, packet };
}
