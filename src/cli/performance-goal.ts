import { readFile } from 'node:fs/promises';
import {
  CodexGoalSnapshotError,
  formatCodexGoalReconciliation,
  buildCodexGoalTerminalCleanupNotice,
  readCodexGoalSnapshotInput,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import {
  buildPerformanceGoalInstruction,
  checkpointPerformanceGoal,
  completePerformanceGoal,
  createPerformanceGoal,
  readPerformanceGoal,
  startPerformanceGoal,
  type PerformanceGoalState,
  PerformanceGoalError,
  type PerformanceValidationStatus,
} from '../performance-goal/artifacts.js';

export const PERFORMANCE_GOAL_HELP = `omx performance-goal - Evaluator-gated performance optimization workflow over Codex goal mode

Usage:
  omx performance-goal create --objective <text> --evaluator-command <cmd> --evaluator-contract <text> [--slug <slug>] [--force] [--json]
  omx performance-goal start --slug <slug> [--json]
  omx performance-goal checkpoint --slug <slug> --status <pass|fail|blocked> --evidence <text> [--json]
  omx performance-goal complete --slug <slug> [--evidence <text>] --codex-goal-json <json-or-path> [--json]
  omx performance-goal status --slug <slug> [--codex-goal-json <json-or-path>] [--json]

Aliases:
  create/start/checkpoint/complete/status may be used as shown above.

Artifacts:
  .omx/goals/performance/<slug>/state.json
  .omx/goals/performance/<slug>/evaluator.md
  .omx/goals/performance/<slug>/ledger.jsonl

Codex goal integration:
  This command cannot directly invoke the interactive /goal tool from a shell.
  start writes durable OMX state and prints a model-facing handoff that tells the
  active Codex agent when to call get_goal/create_goal/update_goal safely.
  Performance goals cannot complete until evaluator artifacts have a passing checkpoint.
`;

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
  if (!value || value.startsWith('--')) throw new PerformanceGoalError(`Missing value for ${flag}.`);
  return value;
}

function positionalText(args: readonly string[]): string {
  const valueTaking = new Set(['--objective', '--objective-file', '--evaluator-command', '--evaluator-contract', '--evaluator-contract-file', '--slug', '--status', '--evidence', '--codex-goal-json']);
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

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(state: PerformanceGoalState): void {
  console.log(`performance-goal: ${state.slug} [${state.status}]`);
  console.log(`objective: ${state.objective}`);
  console.log(`evaluator: ${state.evaluator.command}`);
  if (state.lastValidation) {
    console.log(`last validation: ${state.lastValidation.status} — ${state.lastValidation.evidence}`);
  }
  console.log(`state: ${state.artifactPaths.state}`);
  console.log(`ledger: ${state.artifactPaths.ledger}`);
}

function parseValidationStatus(raw: string | undefined): PerformanceValidationStatus {
  if (raw === 'pass' || raw === 'fail' || raw === 'blocked') return raw;
  throw new PerformanceGoalError('Missing or invalid --status; expected pass, fail, or blocked.');
}

export async function performanceGoalCommand(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');
  const cwd = process.cwd();

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(PERFORMANCE_GOAL_HELP);
      return;
    }

    if (command === 'create') {
      const objective = (await readTextArg(rest, '--objective', '--objective-file')) ?? positionalText(rest);
      const evaluatorCommand = readValue(rest, '--evaluator-command');
      const evaluatorContract = await readTextArg(rest, '--evaluator-contract', '--evaluator-contract-file');
      const state = await createPerformanceGoal(cwd, {
        objective,
        evaluatorCommand: evaluatorCommand ?? '',
        evaluatorContract: evaluatorContract ?? '',
        slug: readValue(rest, '--slug'),
        force: hasFlag(rest, '--force'),
      });
      if (json) printJson({ ok: true, state });
      else {
        console.log(`performance goal created: ${state.slug}`);
        console.log(`state: ${state.artifactPaths.state}`);
        console.log(`evaluator: ${state.artifactPaths.evaluator}`);
        console.log(`ledger: ${state.artifactPaths.ledger}`);
      }
      return;
    }

    if (command === 'start') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new PerformanceGoalError('Missing --slug.');
      const result = await startPerformanceGoal(cwd, slug);
      if (json) printJson({ ok: true, state: result.state, instruction: result.instruction });
      else console.log(result.instruction);
      return;
    }

    if (command === 'checkpoint') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new PerformanceGoalError('Missing --slug.');
      const state = await checkpointPerformanceGoal(cwd, {
        slug,
        status: parseValidationStatus(readValue(rest, '--status')),
        evidence: readValue(rest, '--evidence') ?? '',
      });
      if (json) printJson({ ok: true, state });
      else printStatus(state);
      return;
    }

    if (command === 'complete') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new PerformanceGoalError('Missing --slug.');
      const state = await completePerformanceGoal(cwd, {
        slug,
        evidence: readValue(rest, '--evidence'),
        codexGoal: await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd),
      });
      if (json) printJson({ ok: true, state, instruction: buildPerformanceGoalInstruction(state) });
      else {
        printStatus(state);
        console.log(buildCodexGoalTerminalCleanupNotice('Performance-goal completion'));
      }
      return;
    }

    if (command === 'status') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new PerformanceGoalError('Missing --slug.');
      const state = await readPerformanceGoal(cwd, slug);
      const snapshot = await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd);
      const reconciliation = reconcileCodexGoalSnapshot(snapshot, {
        expectedObjective: state.objective,
        allowedStatuses: state.status === 'complete' ? ['complete'] : ['active', 'complete'],
        requireSnapshot: false,
      });
      if (json) printJson({ state, reconciliation });
      else {
        printStatus(state);
        if (!reconciliation.ok || reconciliation.warnings.length) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    throw new PerformanceGoalError(`Unknown performance-goal command: ${command}\n\n${PERFORMANCE_GOAL_HELP}`);
  } catch (error) {
    if (error instanceof PerformanceGoalError || error instanceof CodexGoalSnapshotError) {
      console.error(`[performance-goal] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
