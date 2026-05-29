import { readFile } from 'node:fs/promises';
import {
  CodexGoalSnapshotError,
  formatCodexGoalReconciliation,
  readCodexGoalSnapshotInput,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import {
  readGoalWorkflowRun,
} from '../goal-workflows/artifacts.js';
import {
  createGoalHarnessRun,
  GOAL_HARNESS_WORKFLOW,
  startGoalHarnessRun,
} from '../goal-harness/artifacts.js';
import {
  completeGoalHarnessRun,
  runGoalHarnessCompletionGate,
  syncGoalHarnessCodexGoalSnapshot,
} from '../goal-harness/completion.js';
import {
  buildGoalHarnessAnnealingChallenge,
  buildRefinedGoalPrompt,
  buildWorkerBoundaryInstruction,
  evaluateGoalHarnessCompletionGate,
  type CompletionGateEvidence,
  type GoalHarnessPhase,
  type GoalHarnessWorkerRole,
} from '../goal-harness/policy.js';
import {
  buildGoalHarnessDeepInterview,
  buildGoalHarnessRalplan,
  renderGoalHarnessDeepInterviewMarkdown,
  renderGoalHarnessRalplanMarkdown,
  writeGoalHarnessDeepInterview,
  writeGoalHarnessRalplan,
} from '../goal-harness/planning.js';
import {
  buildGoalHarnessPerturbation,
} from '../goal-harness/perturbation.js';
import {
  advanceGoalHarnessPhase,
  buildGoalHarnessTeamPlan,
  buildGoalHarnessNextAction,
  GoalHarnessRuntimeError,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
  recordGoalHarnessTrajectory,
  selectGoalHarnessTrajectory,
  type GoalHarnessLeaderStepOutcome,
  type GoalHarnessTrajectorySource,
  type GoalHarnessTrajectoryStatus,
} from '../goal-harness/runtime.js';
import {
  buildGoalHarnessArtifactAwareNextAction,
  buildGoalHarnessStatusSummary,
} from '../goal-harness/status.js';
import {
  writeGoalHarnessTeamPacket,
} from '../goal-harness/team-packet.js';
import {
  importGoalHarnessWorkerResult,
} from '../goal-harness/team-result.js';

export const GOAL_HARNESS_HELP = `omx goal-harness - Lightweight Codex goal-native OMX harness with annealing backpressure

Usage:
  omx goal-harness refine [--objective <text> | --objective-file <path>] [--json]
  omx goal-harness interview [--slug <slug> | --objective <text> | --objective-file <path>] [--json]
  omx goal-harness plan [--slug <slug> | --objective <text> | --objective-file <path>] [--json]
  omx goal-harness create [--objective <text> | --objective-file <path>] [--slug <slug>] [--force] [--json]
  omx goal-harness start --slug <slug> [--json]
  omx goal-harness status --slug <slug> [--json]
  omx goal-harness sync-goal --slug <slug> --codex-goal-json <json-or-path> [--evidence <text>] [--json]
  omx goal-harness summary --slug <slug> [--json]
  omx goal-harness next --slug <slug> [--json]
  omx goal-harness advance --slug <slug> --phase <early|middle|late|stuck> [--evidence <text>] [--json]
  omx goal-harness step --slug <slug> --outcome <progress|blocked|ready-for-late-gate|needs-team-pressure> --evidence <text> [--action <text>] [--next-action <text>] [--json]
  omx goal-harness perturb --slug <slug> [--blocker <text>] [--json]
  omx goal-harness record-trajectory --slug <slug> --summary <text> --evidence <text> [--source <leader|worker>] [--role <role>] [--score <0-100>] [--novelty-score <0-100>] [--status <candidate|accepted|rejected|blocked>] [--id <id>] [--json]
  omx goal-harness select --slug <slug> --trajectory-id <id> --evidence <text> [--json]
  omx goal-harness team-plan --slug <slug> [--task <text>] [--json]
  omx goal-harness team-packet --slug <slug> [--plan-id <id>] [--json]
  omx goal-harness import-worker-result --slug <slug> --result <path> [--id <id>] [--status <candidate|accepted|rejected|blocked>] [--json]
  omx goal-harness challenge [--objective <text>] [--phase <early|middle|late|stuck>] [--json]
  omx goal-harness worker-instruction --role <researcher|implementer|tester|critic|architect|replanner> --task <text> [--context <text>] [--json]
  omx goal-harness gate [--slug <slug>] --evidence-json <json-or-path> [--json]
  omx goal-harness complete --slug <slug> --codex-goal-json <json-or-path> [--evidence <text>] [--json]

Boundary:
  The leader owns the single Codex goal. Workers never call create_goal or update_goal.
  The harness emits model-facing handoffs and completion gates; shell commands do not
  mutate hidden Codex goal state.
`;

export class GoalHarnessCommandError extends Error {}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function readValue(args: readonly string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new GoalHarnessCommandError(`Missing value for ${flag}.`);
  return value;
}

function positionalText(args: readonly string[]): string {
  const valueTaking = new Set(['--objective', '--objective-file', '--slug', '--phase', '--role', '--task', '--context', '--evidence', '--evidence-json', '--codex-goal-json', '--summary', '--source', '--score', '--novelty-score', '--status', '--id', '--trajectory-id', '--outcome', '--action', '--next-action', '--plan-id', '--result', '--blocker']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (valueTaking.has(arg)) { i += 1; continue; }
    if (arg.startsWith('--')) continue;
    words.push(arg);
  }
  return words.join(' ').trim();
}

async function readTextArg(args: readonly string[], valueFlag: string, fileFlag: string): Promise<string | undefined> {
  const direct = readValue(args, valueFlag);
  if (direct !== undefined) return direct;
  const file = readValue(args, fileFlag);
  return file ? readFile(file, 'utf-8') : undefined;
}

async function readJsonArg(raw: string | undefined): Promise<unknown> {
  if (!raw) throw new GoalHarnessCommandError('Missing --evidence-json.');
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return JSON.parse(await readFile(trimmed, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GoalHarnessCommandError(`Invalid --evidence-json: ${message}`);
  }
}

function parsePhase(raw: string | undefined): GoalHarnessPhase {
  if (!raw) return 'late';
  if (raw === 'early' || raw === 'middle' || raw === 'late' || raw === 'stuck') return raw;
  throw new GoalHarnessCommandError('Invalid --phase; expected early, middle, late, or stuck.');
}

function parseRole(raw: string | undefined): GoalHarnessWorkerRole {
  if (
    raw === 'researcher'
    || raw === 'implementer'
    || raw === 'tester'
    || raw === 'critic'
    || raw === 'architect'
    || raw === 'replanner'
  ) return raw;
  throw new GoalHarnessCommandError('Missing or invalid --role.');
}

function parseSource(raw: string | undefined): GoalHarnessTrajectorySource {
  if (!raw) return 'leader';
  if (raw === 'leader' || raw === 'worker') return raw;
  throw new GoalHarnessCommandError('Invalid --source; expected leader or worker.');
}

function parseTrajectoryStatus(raw: string | undefined): GoalHarnessTrajectoryStatus | undefined {
  if (!raw) return undefined;
  if (raw === 'candidate' || raw === 'accepted' || raw === 'rejected' || raw === 'blocked') return raw;
  throw new GoalHarnessCommandError('Invalid --status; expected candidate, accepted, rejected, or blocked.');
}

function parseLeaderStepOutcome(raw: string | undefined): GoalHarnessLeaderStepOutcome {
  const normalized = raw?.replace(/-/g, '_');
  if (
    normalized === 'progress'
    || normalized === 'blocked'
    || normalized === 'ready_for_late_gate'
    || normalized === 'needs_team_pressure'
  ) return normalized;
  throw new GoalHarnessCommandError('Missing or invalid --outcome; expected progress, blocked, ready-for-late-gate, or needs-team-pressure.');
}

function parseOptionalNumber(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new GoalHarnessCommandError(`Invalid ${label}; expected a number.`);
  return parsed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printRefinement(refinement: ReturnType<typeof buildRefinedGoalPrompt>): void {
  console.log('goal-harness refined objective:');
  console.log(refinement.objective);
  console.log('');
  console.log(`route: ${refinement.route.route} (${refinement.route.reason})`);
  console.log(`recommended skills: ${refinement.route.recommendedSkills.join(', ') || 'none'}`);
}

export async function goalHarnessCommand(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');
  const cwd = process.cwd();

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(GOAL_HARNESS_HELP);
      return;
    }

    if (command === 'refine') {
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      if (!objective.trim()) throw new GoalHarnessCommandError('Missing objective.');
      const refinement = buildRefinedGoalPrompt(objective);
      if (json) printJson({ ok: true, refinement });
      else printRefinement(refinement);
      return;
    }

    if (command === 'interview') {
      const slug = readValue(rest, '--slug');
      if (slug) {
        const result = await writeGoalHarnessDeepInterview(cwd, slug);
        if (json) printJson({ ok: true, ...result });
        else {
          console.log(`deep interview: ${result.artifactPath}`);
          console.log(renderGoalHarnessDeepInterviewMarkdown(result.artifact));
        }
        return;
      }
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      if (!objective.trim()) throw new GoalHarnessCommandError('Missing objective or --slug.');
      const interview = buildGoalHarnessDeepInterview(objective);
      if (json) printJson({ ok: true, interview });
      else console.log(renderGoalHarnessDeepInterviewMarkdown(interview));
      return;
    }

    if (command === 'plan') {
      const slug = readValue(rest, '--slug');
      if (slug) {
        const result = await writeGoalHarnessRalplan(cwd, slug);
        if (json) printJson({ ok: true, ...result });
        else {
          console.log(`ralplan: ${result.artifactPath}`);
          console.log(renderGoalHarnessRalplanMarkdown(result.artifact));
        }
        return;
      }
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      if (!objective.trim()) throw new GoalHarnessCommandError('Missing objective or --slug.');
      const plan = buildGoalHarnessRalplan(objective);
      if (json) printJson({ ok: true, plan });
      else console.log(renderGoalHarnessRalplanMarkdown(plan));
      return;
    }

    if (command === 'create') {
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      if (!objective.trim()) throw new GoalHarnessCommandError('Missing objective.');
      const result = await createGoalHarnessRun(cwd, {
        objective,
        slug: readValue(rest, '--slug'),
        force: hasFlag(rest, '--force'),
      });
      if (json) printJson({ ok: true, ...result });
      else {
        console.log(`goal-harness created: ${result.run.slug}`);
        console.log(`status: ${result.run.statusPath}`);
        console.log(`mission: ${result.missionPath}`);
        console.log(`route: ${result.refinement.route.route}`);
        console.log('');
        printRefinement(result.refinement);
      }
      return;
    }

    if (command === 'start') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await startGoalHarnessRun(cwd, slug);
      if (json) printJson({ ok: true, ...result });
      else console.log(result.instruction);
      return;
    }

    if (command === 'status') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const runtime = await readGoalHarnessRuntime(cwd, slug);
      const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
      const nextAction = buildGoalHarnessArtifactAwareNextAction(cwd, run, runtime);
      const snapshotInput = readValue(rest, '--codex-goal-json');
      const snapshot = await readCodexGoalSnapshotInput(snapshotInput, cwd);
      const reconciliation = snapshotInput
        ? reconcileCodexGoalSnapshot(snapshot, {
            expectedObjective: run.objective,
            allowedStatuses: run.status === 'complete' ? ['complete'] : ['active', 'complete'],
            requireSnapshot: false,
          })
        : undefined;
      if (json) printJson({ ok: true, run, runtime, nextAction, reconciliation });
      else {
        console.log(`goal-harness: ${runtime.slug} [${runtime.phase}]`);
        console.log(`workflow status: ${run.status}`);
        console.log(`route: ${runtime.route.route}`);
        console.log(`trajectories: ${runtime.trajectories.length}`);
        console.log(`leader steps: ${runtime.leaderSteps.length}`);
        console.log(`team plans: ${runtime.teamPlans.length}`);
        console.log(`last gate: ${runtime.lastCompletionGate ? (runtime.lastCompletionGate.allowed ? 'passed' : 'failed') : 'none'}`);
        console.log(`codex goal: ${runtime.lastCodexGoalSnapshot ? `${runtime.lastCodexGoalSnapshot.status ?? 'unknown'} (${runtime.lastCodexGoalSnapshot.artifactPath})` : 'none'}`);
        if (runtime.lastCodexGoalSnapshot?.tokenBudget !== undefined) console.log(`token budget: ${runtime.lastCodexGoalSnapshot.tokenBudget}`);
        if (runtime.lastCodexGoalSnapshot?.remainingTokens !== undefined && runtime.lastCodexGoalSnapshot.remainingTokens !== null) console.log(`remaining tokens: ${runtime.lastCodexGoalSnapshot.remainingTokens}`);
        console.log(`active trajectory: ${runtime.activeTrajectoryId ?? 'none'}`);
        console.log(`next: ${nextAction.action}`);
        if (reconciliation && (!reconciliation.ok || reconciliation.warnings.length)) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    if (command === 'summary') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const summary = await buildGoalHarnessStatusSummary(cwd, slug);
      if (json) printJson({ ok: true, ...summary });
      else {
        console.log(`goal-harness summary: ${summary.aggregate.slug} [${summary.aggregate.workflowStatus}]`);
        console.log(`aggregate: ${summary.aggregate.completedStages}/${summary.aggregate.totalStages}`);
        console.log(`phase: ${summary.aggregate.phase}`);
        console.log('stages:');
        for (const stage of summary.aggregate.stages) {
          const detail = stage.detail ? ` - ${stage.detail}` : '';
          const artifact = stage.artifactPath ? ` (${stage.artifactPath})` : '';
          console.log(`- ${stage.status}: ${stage.label}${artifact}${detail}`);
        }
        console.log(`next: ${summary.aggregate.nextAction.action}`);
      }
      return;
    }

    if (command === 'sync-goal') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await syncGoalHarnessCodexGoalSnapshot(cwd, {
        slug,
        evidence: readValue(rest, '--evidence'),
        codexGoal: await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd),
      });
      if (json) printJson({ ok: result.reconciliation.ok, ...result, nextAction: buildGoalHarnessNextAction(result.runtime) });
      else {
        console.log(`codex goal synced: ${result.run.slug}`);
        console.log(`artifact: ${result.record.artifactPath}`);
        console.log(`status: ${result.record.snapshot.status ?? 'unknown'}`);
        if (result.record.snapshot.tokenBudget !== undefined) console.log(`token budget: ${result.record.snapshot.tokenBudget}`);
        if (result.record.snapshot.remainingTokens !== undefined && result.record.snapshot.remainingTokens !== null) console.log(`remaining tokens: ${result.record.snapshot.remainingTokens}`);
        if (!result.reconciliation.ok || result.reconciliation.warnings.length > 0) console.log(`codex goal warning: ${formatCodexGoalReconciliation(result.reconciliation)}`);
      }
      return;
    }

    if (command === 'next') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const runtime = await readGoalHarnessRuntime(cwd, slug);
      const run = await readGoalWorkflowRun(cwd, GOAL_HARNESS_WORKFLOW, slug);
      const nextAction = buildGoalHarnessArtifactAwareNextAction(cwd, run, runtime);
      if (json) printJson({ ok: true, nextAction, runtime });
      else {
        console.log(nextAction.action);
        console.log(`reason: ${nextAction.reason}`);
        if (nextAction.recommendedCommand) console.log(`command: ${nextAction.recommendedCommand}`);
      }
      return;
    }

    if (command === 'advance') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const phase = readValue(rest, '--phase');
      if (!phase) throw new GoalHarnessCommandError('Missing --phase.');
      const runtime = await advanceGoalHarnessPhase(cwd, {
        slug,
        phase: parsePhase(phase),
        evidence: readValue(rest, '--evidence'),
      });
      if (json) printJson({ ok: true, runtime, nextAction: buildGoalHarnessNextAction(runtime) });
      else console.log(`goal-harness advanced: ${runtime.slug} -> ${runtime.phase}`);
      return;
    }

    if (command === 'step') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await recordGoalHarnessLeaderStep(cwd, {
        slug,
        action: readValue(rest, '--action'),
        outcome: parseLeaderStepOutcome(readValue(rest, '--outcome')),
        evidence: readValue(rest, '--evidence'),
        nextAction: readValue(rest, '--next-action'),
      });
      const nextAction = buildGoalHarnessNextAction(result.runtime);
      if (json) printJson({ ok: true, ...result, nextAction });
      else {
        console.log(`leader step recorded: ${result.step.id} [${result.step.outcome}]`);
        console.log(`phase: ${result.step.phase} -> ${result.runtime.phase}`);
        console.log(`next: ${nextAction.action}`);
        if (nextAction.recommendedCommand) console.log(`command: ${nextAction.recommendedCommand}`);
      }
      return;
    }

    if (command === 'record-trajectory') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const summary = readValue(rest, '--summary') ?? positionalText(rest);
      const result = await recordGoalHarnessTrajectory(cwd, {
        slug,
        id: readValue(rest, '--id'),
        source: parseSource(readValue(rest, '--source')),
        role: readValue(rest, '--role') ? parseRole(readValue(rest, '--role')) : undefined,
        summary,
        evidence: readValue(rest, '--evidence'),
        score: parseOptionalNumber(readValue(rest, '--score'), '--score'),
        noveltyScore: parseOptionalNumber(readValue(rest, '--novelty-score'), '--novelty-score'),
        status: parseTrajectoryStatus(readValue(rest, '--status')),
      });
      if (json) printJson({ ok: true, ...result, nextAction: buildGoalHarnessNextAction(result.runtime) });
      else {
        console.log(`trajectory recorded: ${result.trajectory.id} [${result.trajectory.status}]`);
        console.log(`next: ${buildGoalHarnessNextAction(result.runtime).action}`);
      }
      return;
    }

    if (command === 'perturb') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await buildGoalHarnessPerturbation(cwd, {
        slug,
        blocker: readValue(rest, '--blocker') ?? positionalText(rest),
      });
      const nextAction = buildGoalHarnessNextAction(result.runtime);
      if (json) printJson({ ok: true, ...result, nextAction });
      else {
        console.log(`perturbation: ${result.summary.id}`);
        console.log(`artifact: ${result.summary.artifactPath}`);
        console.log(`blocker: ${result.summary.blocker}`);
        console.log(`team plan: ${result.artifact.teamPlanCommand}`);
        console.log(`next: ${nextAction.action}`);
      }
      return;
    }

    if (command === 'select') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const trajectoryId = readValue(rest, '--trajectory-id');
      if (!trajectoryId) throw new GoalHarnessCommandError('Missing --trajectory-id.');
      const evidence = readValue(rest, '--evidence');
      if (!evidence) throw new GoalHarnessCommandError('Missing --evidence.');
      const runtime = await selectGoalHarnessTrajectory(cwd, { slug, trajectoryId, evidence });
      if (json) printJson({ ok: true, runtime, nextAction: buildGoalHarnessNextAction(runtime) });
      else console.log(`trajectory selected: ${runtime.activeTrajectoryId}`);
      return;
    }

    if (command === 'team-plan') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await buildGoalHarnessTeamPlan(cwd, {
        slug,
        task: readValue(rest, '--task') ?? positionalText(rest),
      });
      if (json) printJson({ ok: true, ...result, nextAction: buildGoalHarnessNextAction(result.runtime) });
      else {
        console.log(`team plan: ${result.plan.id} [${result.plan.phase}]`);
        console.log(`launch hint: ${result.plan.launchHint}`);
        for (const lane of result.plan.lanes) {
          console.log('');
          console.log(`## ${lane.role}`);
          console.log(lane.instruction);
        }
      }
      return;
    }

    if (command === 'team-packet') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await writeGoalHarnessTeamPacket(cwd, {
        slug,
        planId: readValue(rest, '--plan-id'),
      });
      if (json) printJson({ ok: true, ...result, nextAction: buildGoalHarnessNextAction(result.runtime) });
      else {
        console.log(`team packet: ${result.packet.manifestPath}`);
        console.log(`launch: ${result.packet.teamLaunchCommand}`);
        console.log('lanes:');
        for (const lane of result.packet.lanes) {
          console.log(`- ${lane.role}: ${lane.instructionPath}`);
          console.log(`  result: ${lane.resultTemplatePath}`);
        }
      }
      return;
    }

    if (command === 'import-worker-result') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const resultPath = readValue(rest, '--result');
      if (!resultPath) throw new GoalHarnessCommandError('Missing --result.');
      const result = await importGoalHarnessWorkerResult(cwd, {
        slug,
        resultPath,
        id: readValue(rest, '--id'),
        status: parseTrajectoryStatus(readValue(rest, '--status')),
      });
      if (json) printJson({ ok: true, ...result, nextAction: buildGoalHarnessNextAction(result.runtime) });
      else {
        console.log(`worker result imported: ${result.trajectory.id} [${result.trajectory.status}]`);
        console.log(`role: ${result.parsed.role}`);
        console.log(`result: ${result.parsed.resultPath}`);
        console.log(`next: ${buildGoalHarnessNextAction(result.runtime).action}`);
      }
      return;
    }

    if (command === 'challenge') {
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      const refinement = objective.trim() ? buildRefinedGoalPrompt(objective) : undefined;
      const challenge = buildGoalHarnessAnnealingChallenge(parsePhase(readValue(rest, '--phase')), refinement?.route.route ?? 'goal_only');
      if (json) printJson({ ok: true, challenge, ...(refinement ? { route: refinement.route } : {}) });
      else {
        console.log(`${challenge.label} (${challenge.strategy})`);
        console.log(`worker lanes: ${challenge.workerLanes.join(', ')}`);
        console.log(`max alternatives: ${challenge.maxAlternativeStrategies}`);
        console.log(`max critic passes: ${challenge.maxCriticPasses}`);
        console.log('required probes:');
        for (const probe of challenge.requiredProbes) console.log(`- ${probe}`);
        console.log(`stop rule: ${challenge.stopRule}`);
      }
      return;
    }

    if (command === 'worker-instruction') {
      const role = parseRole(readValue(rest, '--role'));
      const task = readValue(rest, '--task') ?? positionalText(rest);
      if (!task.trim()) throw new GoalHarnessCommandError('Missing --task.');
      const instruction = buildWorkerBoundaryInstruction({
        role,
        task,
        context: readValue(rest, '--context'),
      });
      if (json) printJson({ ok: true, role, instruction });
      else console.log(instruction);
      return;
    }

    if (command === 'complete') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new GoalHarnessCommandError('Missing --slug.');
      const result = await completeGoalHarnessRun(cwd, {
        slug,
        evidence: readValue(rest, '--evidence'),
        codexGoal: await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd),
      });
      if (json) printJson({ ok: true, ...result });
      else {
        console.log(`goal-harness complete: ${result.run.slug}`);
        console.log(`codex goal snapshot: ${result.record.artifactPath}`);
        console.log('Codex goal reconciliation: matched a fresh complete get_goal snapshot; OMX workflow completion is now durable.');
      }
      return;
    }

    if (command === 'gate') {
      const evidence = await readJsonArg(readValue(rest, '--evidence-json')) as CompletionGateEvidence;
      const slug = readValue(rest, '--slug');
      if (slug) {
        const result = await runGoalHarnessCompletionGate(cwd, { slug, evidence });
        if (json) printJson({ ok: result.decision.allowed, ...result });
        else {
          console.log(`completion allowed: ${result.decision.allowed ? 'yes' : 'no'}`);
          console.log(`artifact: ${result.record.artifactPath}`);
          console.log(`workflow status: ${result.run.status}`);
          if (result.decision.missing.length > 0) console.log(`missing: ${result.decision.missing.join(', ')}`);
          if (result.decision.blockers.length > 0) console.log(`blockers: ${result.decision.blockers.join(', ')}`);
          console.log(`next: ${result.decision.nextAction}`);
        }
        return;
      }
      const decision = evaluateGoalHarnessCompletionGate(evidence);
      if (json) printJson({ ok: decision.allowed, decision });
      else {
        console.log(`completion allowed: ${decision.allowed ? 'yes' : 'no'}`);
        if (decision.missing.length > 0) console.log(`missing: ${decision.missing.join(', ')}`);
        if (decision.blockers.length > 0) console.log(`blockers: ${decision.blockers.join(', ')}`);
        console.log(`next: ${decision.nextAction}`);
      }
      return;
    }

    throw new GoalHarnessCommandError(`Unknown goal-harness command: ${command}\n\n${GOAL_HARNESS_HELP}`);
  } catch (error) {
    if (error instanceof GoalHarnessCommandError || error instanceof GoalHarnessRuntimeError || error instanceof CodexGoalSnapshotError) {
      console.error(`[goal-harness] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
