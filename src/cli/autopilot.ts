import { readFile } from 'node:fs/promises';
import {
  readModeState,
  readModeStateForExplicitSession,
  startMode,
  updateAutopilotPipelineState,
} from '../modes/base.js';
import { deriveAutopilotChildPhase } from '../autopilot/fsm.js';

export const AUTOPILOT_HELP = `omx autopilot - canonical supervised deep-interview -> ralplan -> ultragoal workflow

Usage:
  omx autopilot start --task <text> [--session <id>] [--json]
  omx autopilot status [--session <id>] [--json]
  omx autopilot next [--session <id>] [--json]
  omx autopilot advance --to <ralplan|ultragoal> --handoff-json <json-or-path> [--session <id>] [--json]

The supervisor owns one session-scoped autopilot-state.json. Child stages remain
supervised phases; advance validates durable artifacts and cannot skip stages.
Cancel and state clear remain available through their normal exact-session paths.
`;

interface AutopilotCommandDependencies {
  cwd?: () => string;
  stdout?: (line: string) => void;
}

function value(args: readonly string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
  return result;
}

function positionalTask(args: readonly string[]): string {
  const valueFlags = new Set(['--task', '--session', '--to', '--handoff-json']);
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (valueFlags.has(args[i])) { i += 1; continue; }
    if (!args[i].startsWith('--')) words.push(args[i]);
  }
  return words.join(' ').trim();
}

async function jsonInput(raw: string, cwd: string): Promise<Record<string, unknown>> {
  const text = raw.trim().startsWith('{') ? raw : await readFile(raw, 'utf-8');
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--handoff-json must resolve to a JSON object.');
  return parsed as Record<string, unknown>;
}

function assertBoundHandoffIdentity(handoff: Record<string, unknown>, cwd: string, sessionId?: string): void {
  if (typeof handoff.session_id === 'string' && handoff.session_id !== sessionId) {
    throw new Error('Autopilot handoff session_id does not match the selected session.');
  }
  if (typeof handoff.workingDirectory === 'string' && handoff.workingDirectory !== cwd) {
    throw new Error('Autopilot handoff workingDirectory does not match the selected workspace.');
  }
  handoff.session_id = sessionId;
  handoff.workingDirectory = cwd;
}

async function readAutopilot(cwd: string, sessionId?: string) {
  return sessionId
    ? readModeStateForExplicitSession('autopilot', sessionId, cwd)
    : readModeState('autopilot', cwd);
}

function instruction(state: Record<string, unknown>): string {
  const phase = deriveAutopilotChildPhase(state);
  const task = typeof state.task_description === 'string' ? state.task_description : '';
  if (phase === 'deep-interview') return `$deep-interview ${JSON.stringify(task)}`;
  if (phase === 'ralplan') return `$ralplan ${JSON.stringify(task)}`;
  if (phase === 'ultragoal') return `$ultragoal ${JSON.stringify(task)}`;
  return `Autopilot phase ${String(state.current_phase ?? 'unknown')} has no child-stage instruction.`;
}

export async function autopilotCommand(args: string[], deps: AutopilotCommandDependencies = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const cwd = (deps.cwd ?? process.cwd)();
  const command = args[0] ?? 'help';
  const rest = args.slice(1);
  const sessionId = value(rest, '--session');
  const json = rest.includes('--json');

  if (command === 'help' || command === '--help' || command === '-h') {
    stdout(AUTOPILOT_HELP);
    return;
  }

  if (command === 'start') {
    const task = value(rest, '--task') ?? positionalTask(rest);
    if (!task) throw new Error('Missing --task.');
    const state = await startMode('autopilot', task, 3, cwd, sessionId);
    const initialized = await updateAutopilotPipelineState({
      ...state,
      active: true,
      current_phase: 'deep-interview',
      session_id: sessionId,
      workingDirectory: cwd,
      phase_cycle: ['deep-interview', 'ralplan', 'ultragoal'],
      handoff_artifacts: {},
      deep_interview_gate: { status: 'required' },
      review_cycle: 0,
    }, cwd, sessionId);
    if (json) stdout(JSON.stringify({ ok: true, state: initialized, instruction: instruction(initialized) }));
    else stdout(instruction(initialized));
    return;
  }

  const state = await readAutopilot(cwd, sessionId);
  if (!state) throw new Error('No Autopilot state found. Run `omx autopilot start --task <text>` first.');

  if (command === 'status' || command === 'next') {
    const nextInstruction = instruction(state);
    if (json) stdout(JSON.stringify({ state, instruction: nextInstruction }));
    else stdout(command === 'next' ? nextInstruction : `autopilot: ${state.current_phase}\n${nextInstruction}`);
    return;
  }

  if (command === 'advance') {
    const to = value(rest, '--to');
    if (to !== 'ralplan' && to !== 'ultragoal') throw new Error('--to must be ralplan or ultragoal.');
    const rawHandoff = value(rest, '--handoff-json');
    if (!rawHandoff) throw new Error('Missing --handoff-json.');
    const handoff = await jsonInput(rawHandoff, cwd);
    assertBoundHandoffIdentity(handoff, cwd, sessionId);
    const updated = await updateAutopilotPipelineState({
      ...handoff,
      active: true,
      current_phase: to,
    }, cwd, sessionId);
    if (json) stdout(JSON.stringify({ ok: true, state: updated, instruction: instruction(updated) }));
    else stdout(instruction(updated));
    return;
  }

  throw new Error(`Unknown autopilot command: ${command}\n${AUTOPILOT_HELP}`);
}
