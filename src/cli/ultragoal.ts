import { readFile } from 'node:fs/promises';
import {
  CodexGoalSnapshotError,
  formatCodexGoalReconciliation,
  readCodexGoalSnapshotInput,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import {
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  readUltragoalPlan,
  startNextUltragoal,
  summarizeUltragoalPlan,
  type UltragoalItem,
  UltragoalError,
} from '../ultragoal/artifacts.js';

export const ULTRAGOAL_HELP = `omx ultragoal - Durable repo-native multi-goal workflow over Codex goal mode

Usage:
  omx ultragoal create-goals [--brief <text> | --brief-file <path> | --from-stdin] [--goal <title::objective>] [--force] [--json]
  omx ultragoal complete-goals [--retry-failed] [--json]
  omx ultragoal checkpoint --goal-id <id> --status <complete|failed|blocked> [--evidence <text>] [--codex-goal-json <json-or-path>] [--json]
  omx ultragoal status [--codex-goal-json <json-or-path>] [--json]

Aliases:
  create -> create-goals, complete|next|start-next -> complete-goals

Artifacts:
  .omx/ultragoal/brief.md
  .omx/ultragoal/goals.json
  .omx/ultragoal/ledger.jsonl

Codex goal integration:
  This command cannot directly invoke the interactive /goal tool from a shell.
  complete-goals writes durable state and prints a model-facing handoff that tells
  the active Codex agent when to call get_goal/create_goal/update_goal safely.
  If a completed legacy thread goal blocks create_goal for the next ultragoal,
  checkpoint --status blocked records that non-terminal blocker and the handoff
  should continue in a fresh Codex thread for the same repo/worktree.
`;

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function readValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readRepeated(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  const prefix = `${flag}=`;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === flag && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }
  return values;
}

function parseGoalArg(raw: string): { title?: string; objective: string; tokenBudget?: number } {
  const [title, ...rest] = raw.split('::');
  if (rest.length === 0) return { objective: raw.trim() };
  return { title: title.trim(), objective: rest.join('::').trim() };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

function positionalText(args: readonly string[]): string {
  const valueTaking = new Set(['--brief', '--brief-file', '--goal', '--goal-id', '--status', '--evidence', '--codex-goal-json']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueTaking.has(arg)) { i += 1; continue; }
    if (arg.startsWith('--')) continue;
    words.push(arg);
  }
  return words.join(' ').trim();
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(plan: Awaited<ReturnType<typeof readUltragoalPlan>>): void {
  const summary = summarizeUltragoalPlan(plan);
  console.log(`ultragoal: ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed`);
  for (const goal of plan.goals) {
    const marker = goal.id === plan.activeGoalId ? '*' : '-';
    console.log(`${marker} ${goal.id} [${goal.status}] ${goal.title}`);
  }
}

async function parseCodexGoalJson(raw: string | undefined): Promise<unknown> {
  if (!raw) return undefined;
  return readCodexGoalSnapshotInput(raw, process.cwd());
}

export async function ultragoalCommand(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');
  const cwd = process.cwd();

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(ULTRAGOAL_HELP);
      return;
    }

    if (command === 'create' || command === 'create-goals') {
      const briefFile = readValue(rest, '--brief-file');
      const brief = readValue(rest, '--brief')
        ?? (briefFile ? await readFile(briefFile, 'utf-8') : undefined)
        ?? (hasFlag(rest, '--from-stdin') ? await readStdin() : undefined)
        ?? positionalText(rest);
      if (!brief.trim()) throw new UltragoalError('Missing brief text. Pass --brief, --brief-file, --from-stdin, or positional text.');
      const goals = readRepeated(rest, '--goal').map(parseGoalArg);
      const plan = await createUltragoalPlan(cwd, { brief, goals, force: hasFlag(rest, '--force') });
      if (json) printJson({ ok: true, plan, summary: summarizeUltragoalPlan(plan) });
      else {
        console.log(`ultragoal plan created: ${plan.goals.length} goal(s)`);
        console.log(`brief: ${plan.briefPath}`);
        console.log(`goals: ${plan.goalsPath}`);
        console.log(`ledger: ${plan.ledgerPath}`);
      }
      return;
    }

    if (command === 'status') {
      const plan = await readUltragoalPlan(cwd);
      const snapshot = await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd);
      const activeGoal = plan.goals.find((goal) => goal.id === plan.activeGoalId || goal.status === 'in_progress');
      const reconciliation = activeGoal
        ? reconcileCodexGoalSnapshot(snapshot, {
          expectedObjective: activeGoal.objective,
          allowedStatuses: ['active', 'complete'],
          requireSnapshot: false,
        })
        : null;
      if (json) printJson({ plan, summary: summarizeUltragoalPlan(plan), reconciliation });
      else {
        printStatus(plan);
        if (reconciliation && !reconciliation.ok) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
        else if (reconciliation?.warnings.length) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    if (command === 'complete' || command === 'complete-goals' || command === 'next' || command === 'start-next') {
      const result = await startNextUltragoal(cwd, { retryFailed: hasFlag(rest, '--retry-failed') });
      if (!result.goal) {
        if (json) printJson({ ok: true, done: result.done, summary: summarizeUltragoalPlan(result.plan) });
        else console.log(result.done ? 'ultragoal: all goals complete' : 'ultragoal: no pending goals (use --retry-failed to retry failed goals)');
        return;
      }
      const instruction = buildCodexGoalInstruction(result.goal, result.plan);
      if (json) printJson({ ok: true, resumed: result.resumed, goal: result.goal, instruction });
      else console.log(instruction);
      return;
    }

    if (command === 'checkpoint') {
      const goalId = readValue(rest, '--goal-id');
      const status = readValue(rest, '--status');
      if (!goalId) throw new UltragoalError('Missing --goal-id.');
      if (status !== 'complete' && status !== 'failed' && status !== 'blocked') throw new UltragoalError('Missing or invalid --status; expected complete, failed, or blocked.');
      const evidence = readValue(rest, '--evidence');
      const codexGoal = await parseCodexGoalJson(readValue(rest, '--codex-goal-json'));
      const plan = await checkpointUltragoal(cwd, { goalId, status, evidence, codexGoal });
      if (json) printJson({ ok: true, plan, summary: summarizeUltragoalPlan(plan) });
      else {
        const goal = plan.goals.find((candidate: UltragoalItem) => candidate.id === goalId);
        console.log(`ultragoal checkpoint: ${goalId} -> ${goal?.status ?? status}`);
        printStatus(plan);
      }
      return;
    }

    throw new UltragoalError(`Unknown ultragoal command: ${command}\n\n${ULTRAGOAL_HELP}`);
  } catch (error) {
    if (error instanceof UltragoalError || error instanceof CodexGoalSnapshotError) {
      console.error(`[ultragoal] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
