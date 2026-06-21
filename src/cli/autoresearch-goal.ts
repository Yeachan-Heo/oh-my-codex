import { readFile } from 'node:fs/promises';
import {
  AutoresearchGoalError,
  buildAutoresearchGoalHandoff,
  reconcileAutoresearchCodexGoalSnapshot,
  completeAutoresearchGoal,
  createAutoresearchGoal,
  readAutoresearchGoal,
  readAutoresearchGoalCompletion,
  recordAutoresearchGoalVerdict,
  type AutoresearchGoalVerdict,
} from '../autoresearch/goal.js';
import {
  CodexGoalSnapshotError,
  formatCodexGoalReconciliation,
  buildCodexGoalTerminalCleanupNotice,
  readCodexGoalSnapshotInput,
} from '../goal-workflows/codex-goal-snapshot.js';

export const AUTORESEARCH_GOAL_HELP = `omx autoresearch-goal - Durable professor-critic research workflow over Codex goal mode

Usage:
  omx autoresearch-goal create --topic <text> --rubric <text|path> [--critic-command <cmd>] [--slug <slug>] [--force] [--json]
  omx autoresearch-goal handoff --slug <slug> [--json]
  omx autoresearch-goal verdict --slug <slug> --verdict <pass|fail|blocked> --evidence <text> [--summary <text>] [--artifact <path>] [--json]
  omx autoresearch-goal complete --slug <slug> --codex-goal-json <json-or-path> [--json]
  omx autoresearch-goal status --slug <slug> [--codex-goal-json <json-or-path>] [--json]

Artifacts:
  .omx/goals/autoresearch/<slug>/mission.json
  .omx/goals/autoresearch/<slug>/rubric.md
  .omx/goals/autoresearch/<slug>/ledger.jsonl
  .omx/goals/autoresearch/<slug>/completion.json

Goal-mode boundary:
  This command does not revive deprecated omx autoresearch and does not mutate hidden Codex /goal state.
  It writes durable OMX artifacts and prints a model-facing handoff for get_goal/create_goal/update_goal.
  Completion is blocked until professor-critic validation records verdict=pass.
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
  if (!value || value.startsWith('--')) throw new AutoresearchGoalError(`Missing value for ${flag}.`);
  return value;
}

async function readMaybeFile(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  if (value.startsWith('@')) return readFile(value.slice(1), 'utf-8');
  return value;
}

function positionalText(args: readonly string[]): string {
  const valueTaking = new Set(['--topic', '--rubric', '--critic-command', '--slug', '--verdict', '--evidence', '--summary', '--artifact', '--codex-goal-json']);
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

function parseVerdict(value: string | undefined): AutoresearchGoalVerdict {
  if (value === 'pass' || value === 'fail' || value === 'blocked') return value;
  throw new AutoresearchGoalError('Missing or invalid --verdict; expected pass, fail, or blocked.');
}

export async function autoresearchGoalCommand(args: string[]): Promise<void> {
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const json = hasFlag(rest, '--json');
  const cwd = process.cwd();

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      console.log(AUTORESEARCH_GOAL_HELP);
      return;
    }

    if (command === 'create' || command === 'init') {
      const topic = readValue(rest, '--topic') ?? positionalText(rest);
      const rubric = await readMaybeFile(readValue(rest, '--rubric'));
      const mission = await createAutoresearchGoal(cwd, {
        topic: topic ?? '',
        rubric: rubric ?? '',
        slug: readValue(rest, '--slug'),
        criticCommand: readValue(rest, '--critic-command'),
        force: hasFlag(rest, '--force'),
      });
      if (json) printJson({ ok: true, mission });
      else {
        console.log(`autoresearch-goal created: ${mission.slug}`);
        console.log(`mission: ${mission.mission_path}`);
        console.log(`rubric: ${mission.rubric_path}`);
        console.log(`ledger: ${mission.ledger_path}`);
      }
      return;
    }

    if (command === 'handoff' || command === 'start') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new AutoresearchGoalError('Missing --slug.');
      const instruction = await buildAutoresearchGoalHandoff(cwd, slug);
      if (json) printJson({ ok: true, instruction });
      else console.log(instruction);
      return;
    }

    if (command === 'verdict' || command === 'checkpoint') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new AutoresearchGoalError('Missing --slug.');
      const result = await recordAutoresearchGoalVerdict(cwd, {
        slug,
        verdict: parseVerdict(readValue(rest, '--verdict')),
        evidence: readValue(rest, '--evidence') ?? '',
        summary: readValue(rest, '--summary'),
        artifactPath: readValue(rest, '--artifact'),
      });
      if (json) printJson({ ok: true, ...result });
      else console.log(`autoresearch-goal verdict: ${result.mission.slug} -> ${result.completion.verdict}`);
      return;
    }

    if (command === 'complete') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new AutoresearchGoalError('Missing --slug.');
      const result = await completeAutoresearchGoal(cwd, slug, {
        codexGoal: await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd),
      });
      if (json) printJson({ ok: true, ...result });
      else {
        console.log(`autoresearch-goal complete: ${result.mission.slug}`);
        console.log('Codex goal reconciliation: matched a fresh complete get_goal snapshot; OMX mission completion is now durable.');
        console.log(buildCodexGoalTerminalCleanupNotice('Autoresearch-goal completion'));
      }
      return;
    }

    if (command === 'status') {
      const slug = readValue(rest, '--slug');
      if (!slug) throw new AutoresearchGoalError('Missing --slug.');
      const mission = await readAutoresearchGoal(cwd, slug);
      const completion = await readAutoresearchGoalCompletion(cwd, slug);
      const snapshot = await readCodexGoalSnapshotInput(readValue(rest, '--codex-goal-json'), cwd);
      const reconciliation = reconcileAutoresearchCodexGoalSnapshot(snapshot, mission, {
        requireSnapshot: false,
        requireComplete: mission.status === 'complete',
      });
      if (json) printJson({ mission, completion, reconciliation });
      else {
        console.log(`autoresearch-goal: ${mission.slug} [${mission.status}] ${mission.topic}`);
        console.log(`completion: ${completion ? `${completion.verdict} (${completion.recorded_at})` : 'missing'}`);
        if (!reconciliation.ok || reconciliation.warnings.length) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    throw new AutoresearchGoalError(`Unknown autoresearch-goal command: ${command}\n\n${AUTORESEARCH_GOAL_HELP}`);
  } catch (error) {
    if (error instanceof AutoresearchGoalError || error instanceof CodexGoalSnapshotError) {
      console.error(`[autoresearch-goal] ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
