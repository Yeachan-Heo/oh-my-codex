import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  readApprovedExecutionLaunchHintOutcome,
  readPlanningArtifacts,
  type ApprovedRepositoryContextSummary,
  type ApprovedExecutionLaunchHint,
} from '../planning/artifacts.js';
import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { sameFilePath } from '../utils/paths.js';

export interface ApprovedTeamExecutionBinding {
  prd_path: string;
  task: string;
  command?: string;
}

export interface UltragoalCheckpointGuidance {
  goal_id: string;
  goal_title?: string;
  codex_goal_mode: 'aggregate' | 'per_story';
  goals_path: '.omx/ultragoal/goals.json';
  ledger_path: '.omx/ultragoal/ledger.jsonl';
  checkpoint_policy: 'fresh_leader_get_goal_required';
  checkpoint_command_template: string;
  final_checkpoint_command_template: string;
  evidence_requirements: string[];
}

export type PersistedApprovedTeamExecutionBindingReadResult =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding };

export type PersistedApprovedTeamExecutionContinuityState =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'stale'; binding: ApprovedTeamExecutionBinding }
  | { status: 'ambiguous'; binding: ApprovedTeamExecutionBinding }
  | { status: 'valid'; binding: ApprovedTeamExecutionBinding; approvedHint: ApprovedExecutionLaunchHint };

type ApprovedTeamExecutionHintBindingOutcome =
  | { status: 'resolved'; approvedHint: ApprovedExecutionLaunchHint }
  | { status: 'stale' }
  | { status: 'ambiguous' };

export function normalizeApprovedTeamExecutionBinding(
  value: unknown,
): ApprovedTeamExecutionBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const binding = value as Record<string, unknown>;
  if (typeof binding.prd_path !== 'string' || typeof binding.task !== 'string') {
    return null;
  }

  const prdPath = binding.prd_path.trim();
  const task = binding.task.trim();
  if (prdPath === '' || task === '') {
    return null;
  }

  const command = typeof binding.command === 'string'
    ? binding.command.trim()
    : '';

  return {
    prd_path: prdPath,
    task,
    ...(command !== '' ? { command } : {}),
  };
}

export function buildApprovedTeamExecutionBinding(
  approvedHint: ApprovedExecutionLaunchHint,
): ApprovedTeamExecutionBinding {
  return {
    prd_path: approvedHint.sourcePath,
    task: approvedHint.task,
    ...(approvedHint.command ? { command: approvedHint.command } : {}),
  };
}

function renderApprovedRepositoryContextSummary(
  summary: ApprovedRepositoryContextSummary,
): string[] {
  const lines = [
    `- Approved repository context summary source: ${summary.sourcePath}${summary.truncated ? ' (bounded/truncated)' : ''}`,
  ];
  const content = summary.content.trim();
  if (content !== '') {
    lines.push('', content);
  }
  return lines;
}

function readApprovedHintSourceText(
  approvedHint: ApprovedExecutionLaunchHint,
): string {
  try {
    return readFileSync(approvedHint.sourcePath, 'utf-8');
  } catch {
    return '';
  }
}

function detectUltragoalId(text: string): string | null {
  return text.match(/\bG\d{3}[-\w]*/)?.[0] ?? null;
}

function detectUltragoalMode(text: string): 'aggregate' | 'per_story' {
  return /per[- ]story/i.test(text) ? 'per_story' : 'aggregate';
}

export function buildUltragoalCheckpointGuidance(
  approvedHint: ApprovedExecutionLaunchHint | null | undefined,
): UltragoalCheckpointGuidance | null {
  if (!approvedHint || approvedHint.mode !== 'team') {
    return null;
  }

  const sourceText = readApprovedHintSourceText(approvedHint);
  const detectionText = [
    approvedHint.task,
    approvedHint.command ?? '',
    sourceText,
  ].join('\n');
  if (!/ultragoal|\.omx\/ultragoal/i.test(detectionText)) {
    return null;
  }

  const goalId = detectUltragoalId(detectionText);
  const goalIdDisplay = goalId ?? '<read .omx/ultragoal/goals.json first>';
  return {
    goal_id: goalIdDisplay,
    codex_goal_mode: detectUltragoalMode(detectionText),
    goals_path: '.omx/ultragoal/goals.json',
    ledger_path: '.omx/ultragoal/ledger.jsonl',
    checkpoint_policy: 'fresh_leader_get_goal_required',
    checkpoint_command_template: '<leader must read verified .omx/ultragoal/goals.json context before constructing checkpoint command>',
    final_checkpoint_command_template: '<leader must read verified .omx/ultragoal/goals.json context and pass final quality gates before constructing checkpoint command>',
    evidence_requirements: [
      'team tasks are terminal',
      'verification passed',
      goalId ? `evidence mentions ${goalId}` : 'leader resolved the active goal ID from .omx/ultragoal/goals.json',
      'evidence mentions .omx/ultragoal artifacts',
      'leader captured a fresh get_goal snapshot',
    ],
  };
}

export function renderLeaderOwnedUltragoalContext(
  guidance: UltragoalCheckpointGuidance | null | undefined,
): string[] {
  if (!guidance) return [];
  return [
    '',
    '- Approved-plan Ultragoal hint:',
    '  - source: approved Team handoff text; leader must verify `.omx/ultragoal/goals.json` before checkpointing.',
    `  - goals_path: ${guidance.goals_path}`,
    `  - ledger_path: ${guidance.ledger_path}`,
    `  - hinted_goal_id: ${guidance.goal_id}`,
    `  - codex_goal_mode: ${guidance.codex_goal_mode}`,
    `  - checkpoint_policy: ${guidance.checkpoint_policy}`,
    '  - Team workers provide task/evidence updates only; workers do not own ultragoal goal state or create worker ultragoal ledgers.',
    '  - No checkpoint command is emitted from approved-plan hints; concrete commands require verified leader-owned Ultragoal context.',
    '  - Final aggregate story requires final quality gates before update_goal, then fresh get_goal and --quality-gate-json.',
  ];
}

export function buildApprovedTeamHandoffSection(
  approvedHint: ApprovedExecutionLaunchHint | null | undefined,
): string | undefined {
  if (!approvedHint || approvedHint.mode !== 'team') {
    return undefined;
  }

  const lines = [`- Approved plan: ${approvedHint.sourcePath}`];
  if (approvedHint.testSpecPaths.length > 0) {
    lines.push(`- Test specs: ${approvedHint.testSpecPaths.join(', ')}`);
  }
  if (approvedHint.repositoryContextSummary) {
    lines.push(...renderApprovedRepositoryContextSummary(approvedHint.repositoryContextSummary));
  }
  lines.push(...renderLeaderOwnedUltragoalContext(buildUltragoalCheckpointGuidance(approvedHint)));

  lines.push('- Use the approved plan and matching test specs as the execution baseline.');
  return lines.join('\n');
}

function assertSafeTeamName(teamName: string): void {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`invalid_team_name:${teamName}`);
  }
}

function approvedTeamExecutionBindingPath(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): string {
  assertSafeTeamName(teamName);
  const stateRoot = resolve(teamStateRoot ?? resolveCanonicalTeamStateRoot(cwd));
  return join(stateRoot, 'team', teamName, 'approved-execution.json');
}

export async function readPersistedApprovedTeamExecutionBindingState(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<PersistedApprovedTeamExecutionBindingReadResult> {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  if (!existsSync(path)) {
    return { status: 'missing' };
  }

  try {
    const raw = await readFile(path, 'utf-8');
    const binding = normalizeApprovedTeamExecutionBinding(JSON.parse(raw) as unknown);
    return binding ? { status: 'valid', binding } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export function readPersistedApprovedTeamExecutionBindingStateSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): PersistedApprovedTeamExecutionBindingReadResult {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  if (!existsSync(path)) {
    return { status: 'missing' };
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const binding = normalizeApprovedTeamExecutionBinding(JSON.parse(raw) as unknown);
    return binding ? { status: 'valid', binding } : { status: 'malformed' };
  } catch {
    return { status: 'malformed' };
  }
}

export async function readPersistedApprovedTeamExecutionBinding(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<ApprovedTeamExecutionBinding | null> {
  const state = await readPersistedApprovedTeamExecutionBindingState(teamName, cwd, teamStateRoot);
  return state.status === 'valid' ? state.binding : null;
}

export function readPersistedApprovedTeamExecutionBindingSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): ApprovedTeamExecutionBinding | null {
  const state = readPersistedApprovedTeamExecutionBindingStateSync(teamName, cwd, teamStateRoot);
  return state.status === 'valid' ? state.binding : null;
}

export async function writePersistedApprovedTeamExecutionBinding(
  teamName: string,
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
  teamStateRoot?: string | null,
): Promise<void> {
  const path = approvedTeamExecutionBindingPath(teamName, cwd, teamStateRoot);
  const normalized = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalized) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

function readApprovedTeamExecutionHintOutcomeForPrdPath(
  cwd: string,
  binding: ApprovedTeamExecutionBinding,
  prdPath: string,
): ApprovedTeamExecutionHintBindingOutcome {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, 'team', {
    prdPath,
    task: binding.task,
    command: binding.command,
  });
  if (outcome.status === 'resolved') {
    return { status: 'resolved', approvedHint: outcome.hint };
  }
  if (outcome.status === 'ambiguous') {
    return { status: 'ambiguous' };
  }
  return { status: 'stale' };
}

export function readApprovedTeamExecutionHintOutcomeFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedTeamExecutionHintBindingOutcome | null {
  const normalized = normalizeApprovedTeamExecutionBinding(binding);
  if (!normalized) {
    return null;
  }

  const direct = readApprovedTeamExecutionHintOutcomeForPrdPath(cwd, normalized, normalized.prd_path);
  if (direct.status !== 'stale') {
    return direct;
  }

  const matchedPrdPath = readPlanningArtifacts(cwd).prdPaths.find((candidatePath) =>
    sameFilePath(candidatePath, normalized.prd_path));
  if (!matchedPrdPath || matchedPrdPath === normalized.prd_path) {
    return direct;
  }

  return readApprovedTeamExecutionHintOutcomeForPrdPath(cwd, normalized, matchedPrdPath);
}

export function readApprovedTeamExecutionHintFromBinding(
  cwd: string,
  binding: ApprovedTeamExecutionBinding | null | undefined,
): ApprovedExecutionLaunchHint | null {
  const outcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, binding);
  return outcome?.status === 'resolved' ? outcome.approvedHint : null;
}

export async function resolvePersistedApprovedTeamExecutionContinuityState(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<PersistedApprovedTeamExecutionContinuityState> {
  const state = await readPersistedApprovedTeamExecutionBindingState(teamName, cwd, teamStateRoot);
  if (state.status === 'missing' || state.status === 'malformed') {
    return state;
  }

  const approvedHintOutcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, state.binding);
  if (!approvedHintOutcome || approvedHintOutcome.status === 'stale') {
    return { status: 'stale', binding: state.binding };
  }
  if (approvedHintOutcome.status === 'ambiguous') {
    return { status: 'ambiguous', binding: state.binding };
  }
  return { status: 'valid', binding: state.binding, approvedHint: approvedHintOutcome.approvedHint };
}

export function resolvePersistedApprovedTeamExecutionContinuityStateSync(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): PersistedApprovedTeamExecutionContinuityState {
  const state = readPersistedApprovedTeamExecutionBindingStateSync(teamName, cwd, teamStateRoot);
  if (state.status === 'missing' || state.status === 'malformed') {
    return state;
  }

  const approvedHintOutcome = readApprovedTeamExecutionHintOutcomeFromBinding(cwd, state.binding);
  if (!approvedHintOutcome || approvedHintOutcome.status === 'stale') {
    return { status: 'stale', binding: state.binding };
  }
  if (approvedHintOutcome.status === 'ambiguous') {
    return { status: 'ambiguous', binding: state.binding };
  }
  return { status: 'valid', binding: state.binding, approvedHint: approvedHintOutcome.approvedHint };
}
