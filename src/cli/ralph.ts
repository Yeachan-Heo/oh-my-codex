import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startMode, updateModeState } from '../modes/base.js';
import { readApprovedExecutionLaunchHint, type ApprovedExecutionLaunchHint } from '../planning/artifacts.js';
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
  --no-deslop         Skip the final ai-slop-cleaner pass

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
const RALPH_OMX_FLAGS = new Set(['--prd', '--no-deslop']);
const RALPH_APPEND_ENV = 'OMX_RALPH_APPEND_INSTRUCTIONS_FILE';

export function extractRalphTaskDescription(args: readonly string[], fallbackTask?: string): string {
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
  return words.join(' ') || fallbackTask || 'ralph-cli-launch';
}

function buildRalphApprovedContextLines(approvedHint: ApprovedExecutionLaunchHint | null): string[] {
  if (!approvedHint) return [];
  const lines = [
    'Approved planning handoff context:',
    `- approved plan: ${approvedHint.sourcePath}`,
  ];
  if (approvedHint.testSpecPaths.length > 0) {
    lines.push(`- test specs: ${approvedHint.testSpecPaths.join(', ')}`);
  }
  if (approvedHint.deepInterviewSpecPaths.length > 0) {
    lines.push(`- deep-interview specs: ${approvedHint.deepInterviewSpecPaths.join(', ')}`);
    lines.push('- Carry forward the approved deep-interview requirements and constraints during Ralph execution and final verification.');
  }
  return lines;
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

interface RalphSessionFiles {
  instructionsPath: string;
  changedFilesPath: string;
}

export function buildRalphChangedFilesSeedContents(): string {
  return [
    '# Ralph changed files for the mandatory final ai-slop-cleaner pass',
    '# Add one repo-relative path per line as Ralph edits files during the session.',
    '# Step 7.5 must keep ai-slop-cleaner strictly scoped to the paths listed here.',
  ].join('\n');
}

export function buildRalphAppendInstructions(
  task: string,
  options: { changedFilesPath: string; noDeslop: boolean; approvedHint?: ApprovedExecutionLaunchHint | null },
): string {
  return [
    '<ralph_native_subagents>',
    'You are in OMX Ralph persistence mode.',
    `Primary task: ${task}`,
    'Parallelism guidance:',
    '- Prefer Codex native subagents for independent parallel subtasks.',
    '- Treat `.omx/state/subagent-tracking.json` as the native subagent activity ledger for this session.',
    '- Do not declare the task complete, and do not transition into final verification/completion, while active native subagent threads are still running.',
    '- Before closing a verification wave, confirm that active native subagent threads have drained.',
    ...buildRalphApprovedContextLines(options.approvedHint ?? null),
    'Final deslop guidance:',
    options.noDeslop
      ? '- `--no-deslop` is active for this Ralph run, so skip the mandatory ai-slop-cleaner final pass and use the latest successful pre-deslop verification evidence.'
      : `- Step 7.5 must run oh-my-codex:ai-slop-cleaner in standard mode on changed files only, using the repo-relative paths listed in \`${options.changedFilesPath}\`.`,
    options.noDeslop
      ? '- Do not run ai-slop-cleaner unless the user explicitly re-enables the deslop pass.'
      : '- Keep the cleaner scope bounded to that file list; do not widen the pass to the full codebase or unrelated files.',
    options.noDeslop
      ? '- Step 7.6 stays satisfied by the latest successful pre-deslop verification evidence because this run opted out of the deslop pass.'
      : '- Step 7.6 must rerun the current tests/build/lint verification after ai-slop-cleaner; if regression fails, roll back cleaner changes or fix and retry before completion.',
    '</ralph_native_subagents>',
  ].join('\n');
}

async function writeRalphSessionFiles(
  cwd: string,
  task: string,
  options: { noDeslop: boolean; approvedHint?: ApprovedExecutionLaunchHint | null },
): Promise<RalphSessionFiles> {
  const dir = join(cwd, '.omx', 'ralph');
  await mkdir(dir, { recursive: true });
  const instructionsPath = join(dir, 'session-instructions.md');
  const changedFilesPath = join(dir, 'changed-files.txt');
  await writeFile(changedFilesPath, `${buildRalphChangedFilesSeedContents()}\n`);
  await writeFile(
    instructionsPath,
    `${buildRalphAppendInstructions(task, { changedFilesPath: '.omx/ralph/changed-files.txt', noDeslop: options.noDeslop, approvedHint: options.approvedHint ?? null })}\n`,
  );
  return { instructionsPath, changedFilesPath: '.omx/ralph/changed-files.txt' };
}

export async function ralphCommand(args: string[]): Promise<void> {
  const normalizedArgs = normalizeRalphCliArgs(args);
  const cwd = process.cwd();
  if (normalizedArgs[0] === '--help' || normalizedArgs[0] === '-h') {
    console.log(RALPH_HELP);
    return;
  }
  const artifacts = await ensureCanonicalRalphArtifacts(cwd);
  const approvedHint = readApprovedExecutionLaunchHint(cwd, 'ralph');
  const explicitTask = extractRalphTaskDescription(normalizedArgs);
  const task = explicitTask === 'ralph-cli-launch' ? approvedHint?.task ?? explicitTask : explicitTask;
  const noDeslop = normalizedArgs.some((arg) => arg.toLowerCase() === '--no-deslop');
  const availableAgentTypes = await resolveAvailableAgentTypes(cwd);
  const staffingPlan = buildFollowupStaffingPlan('ralph', task, availableAgentTypes);
  await startMode('ralph', task, 50);
  const sessionFiles = await writeRalphSessionFiles(cwd, task, { noDeslop, approvedHint });
  await updateModeState('ralph', {
    current_phase: 'starting',
    canonical_progress_path: artifacts.canonicalProgressPath,
    available_agent_types: availableAgentTypes,
    staffing_summary: staffingPlan.staffingSummary,
    staffing_allocations: staffingPlan.allocations,
    native_subagents_enabled: true,
    native_subagent_tracking_path: '.omx/state/subagent-tracking.json',
    native_subagent_policy: 'Parallel Codex subagents are allowed for independent work, but phase completion must wait for active native subagent threads to finish.',
    deslop_enabled: !noDeslop,
    deslop_opt_out: noDeslop,
    deslop_changed_files_path: sessionFiles.changedFilesPath,
    deslop_scope: 'changed-files-only',
    approved_plan_path: approvedHint?.sourcePath,
    approved_test_spec_paths: approvedHint?.testSpecPaths ?? [],
    approved_deep_interview_spec_paths: approvedHint?.deepInterviewSpecPaths ?? [],
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
  const codexArgsBase = filterRalphCodexArgs(normalizedArgs);
  const codexArgs = explicitTask === 'ralph-cli-launch' && approvedHint?.task
    ? [...codexArgsBase, approvedHint.task]
    : codexArgsBase;
  const appendixPath = sessionFiles.instructionsPath;
  const previousAppendixEnv = process.env[RALPH_APPEND_ENV];
  process.env[RALPH_APPEND_ENV] = appendixPath;
  try {
    await launchWithHud(codexArgs);
  } finally {
    if (typeof previousAppendixEnv === 'string') process.env[RALPH_APPEND_ENV] = previousAppendixEnv;
    else delete process.env[RALPH_APPEND_ENV];
  }
}
