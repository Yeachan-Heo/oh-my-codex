import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode, updateModeState } from '../modes/base.js';
import { readApprovedExecutionLaunchHint, type ApprovedExecutionLaunchHint } from '../planning/artifacts.js';
import { buildFollowupStaffingPlan, resolveAvailableAgentTypes } from '../team/followup-planner.js';
import { buildRalphApprovedContextLines } from './ralph.js';
import {
  createCheckpoint,
  createRuningTeamSession,
  ingestTeamEvidence,
  listRuningTeamSessions,
  readRuningTeamSession,
  runingTeamPaths,
  assertRuningTeamCompletionReady,
  transitionRuningTeamSession,
  updateRuningTeamSession,
  writeFinalSynthesis,
} from '../runingteam/runtime.js';
import { ensureTmuxHookInitialized } from './tmux-hook.js';

export const RUNINGTEAM_APPEND_ENV = 'OMX_RUNINGTEAM_APPEND_INSTRUCTIONS_FILE';
const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir']);
const RUNINGTEAM_OMX_FLAGS = new Set(['--launch', '--no-launch', '--json']);

export const RUNINGTEAM_HELP = `omx runingteam - Launch Codex with RuningTeam dynamic planning mode active

Usage:
  omx runingteam [task text...]
  omx runingteam [runingteam-options] [codex-args...] [task text...]
  omx runingteam create "<task>"
  omx runingteam status <session> [--json]
  omx runingteam checkpoint <session> [--force]
  omx runingteam revise <session>
  omx runingteam finalize <session>
  omx runingteam cancel <session>

Options:
  --help, -h     Show this help message
  --launch       Force interactive Codex launch after creating/activating state
  --no-launch    Create a controller session only; do not launch Codex

Launch shortcuts:
  omx --runingteam [--madmax] [task text...]
  omx --runingteam --madmax

RuningTeam is a first-class dynamic planning + team orchestration mode. It
replaces the manual ralplan -> team chain with a checkpoint-gated controller:
Plan vN -> team batch -> evidence -> critic -> planner revision -> next batch.
`;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function requireSession(args: string[]): string {
  const session = args.find((arg) => !arg.startsWith('--'));
  if (!session) throw new Error('Missing RuningTeam session id');
  return session;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function extractRuningTeamTaskDescription(args: readonly string[], fallbackTask?: string): string {
  const words: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--') {
      for (let j = i + 1; j < args.length; j++) words.push(args[j]);
      break;
    }
    if (token.startsWith('--') && token.includes('=')) { i++; continue; }
    if (token.startsWith('-') && VALUE_TAKING_FLAGS.has(token)) { i += 2; continue; }
    if (token.startsWith('-')) { i++; continue; }
    words.push(token);
    i++;
  }
  return words.join(' ') || fallbackTask || 'runingteam-cli-launch';
}

export function filterRuningTeamCodexArgs(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (const token of args) {
    if (RUNINGTEAM_OMX_FLAGS.has(token.toLowerCase())) continue;
    filtered.push(token);
  }
  return filtered;
}

function resolveApprovedRuningTeamExecutionHint(
  candidate: ApprovedExecutionLaunchHint | null,
  explicitTask: string,
): ApprovedExecutionLaunchHint | null {
  if (!candidate) return null;
  if (explicitTask === 'runingteam-cli-launch') return candidate;
  return candidate.task.trim() === explicitTask.trim() ? candidate : null;
}

function readMatchedApprovedRuningTeamExecutionHint(cwd: string, explicitTask: string): ApprovedExecutionLaunchHint | null {
  return resolveApprovedRuningTeamExecutionHint(
    readApprovedExecutionLaunchHint(
      cwd,
      'team',
      explicitTask === 'runingteam-cli-launch' ? {} : { task: explicitTask },
    ),
    explicitTask,
  );
}

export function buildRuningTeamAppendInstructions(
  task: string,
  options: { sessionId?: string; approvedHint?: ApprovedExecutionLaunchHint | null },
): string {
  return [
    '<runingteam_dynamic_planning>',
    'You are in OMX RuningTeam mode.',
    `Primary task: ${task}`,
    options.sessionId ? `RuningTeam controller session: ${options.sessionId}` : null,
    '',
    'Operating contract:',
    '- Treat RuningTeam as the first-class dynamic planning system; do not require a separate `$ralplan` before using it.',
    '- Use checkpoint-gated planning: Plan vN -> team batch -> evidence collection -> Critic review -> Planner revision -> Plan vN+1.',
    '- Mutate the plan only at checkpoints, never while workers are actively executing a batch.',
    '- Prefer existing OMX team state/events/locks/mailbox surfaces; do not invent a separate orchestration root unless explicitly needed.',
    '- Use machine-readable worker evidence where possible: claim, files_changed, tests_run, blockers, next_needed.',
    '- Enforce lane ownership, acceptance criteria lock, final verification, and a final synthesis before completion.',
    '- If the user asks to implement, drive `omx team`/worker lanes from the current checkpoint plan and reconcile evidence before final approval.',
    '- If no task was supplied at launch, ask for the task in one concise question, then start the RuningTeam loop.',
    ...buildRalphApprovedContextLines(options.approvedHint ?? null),
    '</runingteam_dynamic_planning>',
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

export async function ensureRuningTeamTmuxHookAllowed(cwd: string): Promise<boolean> {
  await ensureTmuxHookInitialized(cwd).catch(() => {});
  const configPath = join(cwd, '.omx', 'tmux-hook.json');
  if (!existsSync(configPath)) return false;

  const raw = await readFile(configPath, 'utf-8').catch(() => '');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const existingModes = Array.isArray(parsed.allowed_modes)
    ? parsed.allowed_modes.filter((mode): mode is string => typeof mode === 'string' && mode.trim() !== '').map((mode) => mode.trim())
    : [];
  if (existingModes.includes('runingteam')) return false;

  const allowedModes = existingModes.length > 0
    ? [...existingModes, 'runingteam']
    : ['ralph', 'ultrawork', 'team', 'runingteam'];
  await writeFile(configPath, `${JSON.stringify({ ...parsed, allowed_modes: allowedModes }, null, 2)}\n`, 'utf-8');
  return true;
}

async function writeRuningTeamSessionInstructions(
  cwd: string,
  task: string,
  options: { sessionId?: string; approvedHint?: ApprovedExecutionLaunchHint | null },
): Promise<string> {
  const dir = join(cwd, '.omx', 'runingteam');
  await mkdir(dir, { recursive: true });
  const instructionsPath = join(dir, 'session-instructions.md');
  await writeFile(instructionsPath, `${buildRuningTeamAppendInstructions(task, options)}\n`);
  return instructionsPath;
}

async function launchRuningTeamCodex(args: string[], cwd: string): Promise<void> {
  const explicitTask = extractRuningTeamTaskDescription(args);
  const approvedHint = readMatchedApprovedRuningTeamExecutionHint(cwd, explicitTask);
  const task = explicitTask === 'runingteam-cli-launch' ? approvedHint?.task ?? explicitTask : explicitTask;
  const controllerSession = task === 'runingteam-cli-launch' ? null : await createRuningTeamSession(task, cwd);
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('team', task, availableAgentTypes);
  await startMode('runingteam', task, 50, cwd);
  await updateModeState('runingteam', {
    current_phase: 'planning',
    controller_session_id: controllerSession?.session_id,
    controller_state_path: controllerSession ? runingTeamPaths(cwd, controllerSession.session_id).root : undefined,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
    dynamic_planning_enabled: true,
    checkpoint_gated: true,
    final_synthesis_required: true,
    keep_active_after_launch: true,
    approved_plan_path: approvedHint?.sourcePath,
    approved_test_spec_paths: approvedHint?.testSpecPaths ?? [],
    approved_deep_interview_spec_paths: approvedHint?.deepInterviewSpecPaths ?? [],
  }, cwd);
  await ensureRuningTeamTmuxHookAllowed(cwd);
  const instructionsPath = await writeRuningTeamSessionInstructions(cwd, task, {
    sessionId: controllerSession?.session_id,
    approvedHint,
  });
  if (controllerSession) {
    console.log(`RuningTeam session created: ${controllerSession.session_id}`);
    console.log(`State: ${runingTeamPaths(cwd, controllerSession.session_id).root}`);
  }
  console.log('[runingteam] Dynamic planning mode active. Launching Codex...');
  console.log(`[runingteam] available_agent_types: ${staffingPlan.rosterSummary}`);
  console.log(`[runingteam] staffing_plan: ${staffingPlan.staffingSummary}`);
  const { launchWithHud } = await import('./index.js');
  const codexArgsBase = filterRuningTeamCodexArgs(args);
  const codexArgs = explicitTask === 'runingteam-cli-launch' && approvedHint?.task
    ? [...codexArgsBase, approvedHint.task]
    : codexArgsBase;
  const previousAppendixEnv = process.env[RUNINGTEAM_APPEND_ENV];
  process.env[RUNINGTEAM_APPEND_ENV] = instructionsPath;
  try {
    await launchWithHud(codexArgs);
  } finally {
    if (typeof previousAppendixEnv === 'string') process.env[RUNINGTEAM_APPEND_ENV] = previousAppendixEnv;
    else delete process.env[RUNINGTEAM_APPEND_ENV];
  }
}

export async function runingTeamCommand(args: string[], cwd = process.cwd()): Promise<void> {
  const subcommand = args[0];
  if (subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    console.log(RUNINGTEAM_HELP.trim());
    return;
  }

  if (!subcommand || subcommand === '--launch' || !['create', 'status', 'checkpoint', 'revise', 'finalize', 'cancel'].includes(subcommand)) {
    if (hasFlag(args, '--no-launch') || subcommand === 'create') {
      const taskArgs = subcommand === 'create' ? args.slice(1) : args.filter((arg) => arg !== '--no-launch');
      const task = taskArgs.join(' ').trim();
      if (!task) throw new Error('Missing RuningTeam task');
      const session = await createRuningTeamSession(task, cwd);
      console.log(`RuningTeam session created: ${session.session_id}`);
      console.log(`State: ${runingTeamPaths(cwd, session.session_id).root}`);
      return;
    }
    await launchRuningTeamCodex(args.filter((arg) => arg !== '--launch'), cwd);
    return;
  }

  if (subcommand === 'create') {
    const task = args.slice(1).join(' ').trim();
    if (!task) throw new Error('Missing RuningTeam task');
    const session = await createRuningTeamSession(task, cwd);
    console.log(`RuningTeam session created: ${session.session_id}`);
    console.log(`State: ${runingTeamPaths(cwd, session.session_id).root}`);
    return;
  }

  if (subcommand === 'status') {
    const json = hasFlag(args, '--json');
    const sessionId = args[1]?.startsWith('--') ? undefined : args[1];
    if (sessionId) {
      const session = await readRuningTeamSession(cwd, sessionId);
      const summary = {
        ...session,
        final_synthesis_present: existsSync(runingTeamPaths(cwd, sessionId).finalSynthesis),
      };
      if (json) printJson(summary);
      else console.log(`${summary.session_id}: ${summary.status} iteration=${summary.iteration} plan=${summary.plan_version} team=${summary.team_name ?? '-'}`);
      return;
    }
    const sessions = await listRuningTeamSessions(cwd);
    if (json) printJson({ sessions });
    else if (sessions.length === 0) console.log('No RuningTeam sessions.');
    else for (const session of sessions) console.log(`${session.session_id}: ${session.status} iteration=${session.iteration} plan=${session.plan_version}`);
    return;
  }

  if (subcommand === 'checkpoint') {
    const sessionId = requireSession(args.slice(1));
    await ingestTeamEvidence(cwd, sessionId).catch(() => []);
    const checkpoint = await createCheckpoint(cwd, sessionId, { force: hasFlag(args, '--force') });
    console.log(`RuningTeam checkpoint ${checkpoint.iteration} created for ${sessionId}`);
    return;
  }

  if (subcommand === 'revise') {
    const sessionId = requireSession(args.slice(1));
    await updateRuningTeamSession(cwd, sessionId, { status: 'revising' });
    console.log(`RuningTeam revision gate opened for ${sessionId}`);
    return;
  }

  if (subcommand === 'finalize') {
    const sessionId = requireSession(args.slice(1));
    const paths = runingTeamPaths(cwd, sessionId);
    try {
      await assertRuningTeamCompletionReady(cwd, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'complete_requires_final_synthesis') {
        throw new Error('RuningTeam cannot complete without final-synthesis.md');
      }
      if (message === 'complete_requires_final_synthesis_ready_verdict') {
        throw new Error('RuningTeam cannot complete without FINAL_SYNTHESIS_READY verdict evidence');
      }
      throw err;
    }
    await transitionRuningTeamSession(cwd, sessionId, 'complete');
    const synthesis = await readFile(paths.finalSynthesis, 'utf-8');
    console.log(`RuningTeam complete: ${sessionId}\n${synthesis.trimEnd()}`);
    return;
  }

  if (subcommand === 'cancel') {
    const sessionId = requireSession(args.slice(1));
    await updateRuningTeamSession(cwd, sessionId, { status: 'cancelled', terminal_reason: 'cancelled by user' });
    console.log(`RuningTeam cancelled: ${sessionId}`);
  }
}

export { writeFinalSynthesis };
