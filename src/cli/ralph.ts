import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode, updateModeState } from '../modes/base.js';
import { ensureCanonicalRalphArtifacts } from '../ralph/persistence.js';
import {
  buildFollowupStaffingPlan,
  resolveAvailableAgentTypes,
} from '../team/followup-planner.js';

export const RALPH_HELP = `omx ralph - Launch Codex with ralph persistence mode active

Usage:
  omx ralph [task text...]
  omx ralph --prd "<task text>"
  omx ralph [ralph-options] [codex-args...] [task text...]

Options:
  --help, -h           Show this help message
  --prd <task text>    PRD mode shortcut: mark the task text explicitly
  --prd=<task text>    Same as --prd "<task text>"

PRD mode:
  Ralph initializes persistence artifacts in .omx/ so PRD and progress
  state can survive across Codex sessions. Provide task text either as
  positional words or with --prd.

Common patterns:
  omx ralph "Fix flaky notify-hook tests"
  omx ralph --prd "Ship release checklist automation"
  omx ralph --model gpt-5 "Refactor state hydration"
  omx ralph -- --task-with-leading-dash
`;

const VALUE_TAKING_FLAGS = new Set(['--model', '--provider', '--config', '-c', '-i', '--images-dir']);
const RALPH_OMX_FLAGS = new Set(['--prd']);
const RALPH_APPEND_ENV = 'OMX_RALPH_APPEND_INSTRUCTIONS_FILE';

export function extractRalphTaskDescription(args: readonly string[]): string {
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
  return words.join(' ') || 'ralph-cli-launch';
}

export function normalizeRalphCliArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === '--prd') {
      const next = args[i + 1];
      if (next && next !== '--' && !next.startsWith('-')) {
        normalized.push(next);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (token.startsWith('--prd=')) {
      const value = token.slice('--prd='.length);
      if (value.length > 0) normalized.push(value);
      i++;
      continue;
    }
    normalized.push(token);
    i++;
  }
  return normalized;
}

export function filterRalphCodexArgs(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (const token of args) {
    if (RALPH_OMX_FLAGS.has(token.toLowerCase())) continue;
    filtered.push(token);
  }
  return filtered;
}

function buildRalphAppendInstructions(task: string): string {
  return [
    '<ralph_native_subagents>',
    'You are in OMX Ralph persistence mode.',
    `Primary task: ${task}`,
    'Parallelism guidance:',
    '- Prefer Codex native subagents for independent parallel subtasks.',
    '- Treat `.omx/state/subagent-tracking.json` as the native subagent activity ledger for this session.',
    '- Do not declare the task complete, and do not transition into final verification/completion, while active native subagent threads are still running.',
    '- Before closing a verification wave, confirm that active native subagent threads have drained.',
    '</ralph_native_subagents>',
  ].join('\n');
}

async function writeRalphAppendInstructionsFile(cwd: string, task: string): Promise<string> {
  const dir = join(cwd, '.omx', 'ralph');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'session-instructions.md');
  await writeFile(path, `${buildRalphAppendInstructions(task)}\n`);
  return path;
}

export async function ralphCommand(args: string[]): Promise<void> {
  const normalizedArgs = normalizeRalphCliArgs(args);
  const cwd = process.cwd();
  if (normalizedArgs[0] === '--help' || normalizedArgs[0] === '-h') {
    console.log(RALPH_HELP);
    return;
  }
  const artifacts = await ensureCanonicalRalphArtifacts(cwd);
  const task = extractRalphTaskDescription(normalizedArgs);
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('ralph', task, availableAgentTypes);
  await startMode('ralph', task, 50);
  await updateModeState('ralph', {
    current_phase: 'starting',
    canonical_progress_path: artifacts.canonicalProgressPath,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
    native_subagents_enabled: true,
    native_subagent_tracking_path: '.omx/state/subagent-tracking.json',
    native_subagent_policy: 'Parallel Codex subagents are allowed for independent work, but phase completion must wait for active native subagent threads to finish.',
    ...(artifacts.canonicalPrdPath ? { canonical_prd_path: artifacts.canonicalPrdPath } : {}),
  });
  if (artifacts.migratedPrd) {
    console.log('[ralph] Migrated legacy PRD -> ' + artifacts.canonicalPrdPath);
  }
  if (artifacts.migratedProgress) {
    console.log('[ralph] Migrated legacy progress -> ' + artifacts.canonicalProgressPath);
  }
  console.log('[ralph] Ralph persistence mode active. Launching Codex...');
  console.log(`[ralph] available_agent_types: ${staffingPlan.rosterSummary}`);
  console.log(`[ralph] staffing_plan: ${staffingPlan.staffingSummary}`);
  const { launchWithHud } = await import('./index.js');
  const codexArgs = filterRalphCodexArgs(normalizedArgs);
  const appendixPath = await writeRalphAppendInstructionsFile(cwd, task);
  const previousAppendixEnv = process.env[RALPH_APPEND_ENV];
  process.env[RALPH_APPEND_ENV] = appendixPath;
  try {
    await launchWithHud(codexArgs);
  } finally {
    if (typeof previousAppendixEnv === 'string') process.env[RALPH_APPEND_ENV] = previousAppendixEnv;
    else delete process.env[RALPH_APPEND_ENV];
  }
}
