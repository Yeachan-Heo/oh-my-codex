import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';

export interface UltragoalTeamContext {
  kind: 'leader_owned_ultragoal_context';
  goalsPath: '.omx/ultragoal/goals.json';
  ledgerPath: '.omx/ultragoal/ledger.jsonl';
  activeGoalId: string;
  activeGoalTitle?: string;
  codexGoalMode: 'aggregate' | 'per_story';
  checkpointPolicy: 'fresh_leader_get_goal_required';
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
  command_templates: {
    intermediate_story: string;
    final_story: string;
    per_story: string;
    completed_wrong_legacy_goal_blocker: string;
  };
}

const ULTRAGOAL_GOAL_ID_SAFE_PATTERN = /^G\d{3}[-\w]*$/;

export function isSafeUltragoalGoalId(value: string): boolean {
  return ULTRAGOAL_GOAL_ID_SAFE_PATTERN.test(value);
}

function contextStatePath(teamName: string, cwd: string, teamStateRoot?: string | null): string {
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`invalid_team_name:${teamName}`);
  }
  return join(
    teamStateRoot ?? resolveCanonicalTeamStateRoot(cwd),
    'team',
    teamName,
    'ultragoal-context.json',
  );
}

function normalizeCodexGoalMode(value: unknown): 'aggregate' | 'per_story' {
  return value === 'aggregate' ? 'aggregate' : 'per_story';
}

function resolvePlanCodexGoalMode(value: unknown): 'aggregate' | 'per_story' {
  if (typeof value === 'undefined') return 'per_story';
  if (value === 'aggregate' || value === 'per_story') return value;
  throw new InvalidUltragoalTeamContextError('invalid_codex_goal_mode');
}

class InvalidUltragoalTeamContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUltragoalTeamContextError';
  }
}

export function normalizeUltragoalTeamContext(value: unknown): UltragoalTeamContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'leader_owned_ultragoal_context') return null;
  if (raw.goalsPath !== '.omx/ultragoal/goals.json') return null;
  if (raw.ledgerPath !== '.omx/ultragoal/ledger.jsonl') return null;
  if (typeof raw.activeGoalId !== 'string' || raw.activeGoalId.trim() === '') return null;
  const activeGoalId = raw.activeGoalId.trim();
  if (!isSafeUltragoalGoalId(activeGoalId)) return null;
  if (raw.checkpointPolicy !== 'fresh_leader_get_goal_required') return null;
  const activeGoalTitle = typeof raw.activeGoalTitle === 'string' && raw.activeGoalTitle.trim() !== ''
    ? raw.activeGoalTitle.trim()
    : undefined;
  return {
    kind: 'leader_owned_ultragoal_context',
    goalsPath: '.omx/ultragoal/goals.json',
    ledgerPath: '.omx/ultragoal/ledger.jsonl',
    activeGoalId,
    ...(activeGoalTitle ? { activeGoalTitle } : {}),
    codexGoalMode: normalizeCodexGoalMode(raw.codexGoalMode),
    checkpointPolicy: 'fresh_leader_get_goal_required',
  };
}

export async function resolveLeaderOwnedUltragoalContext(cwd: string): Promise<UltragoalTeamContext | null> {
  const goalsJsonPath = join(cwd, '.omx', 'ultragoal', 'goals.json');
  if (!existsSync(goalsJsonPath)) return null;

  try {
    const parsed = JSON.parse(await readFile(goalsJsonPath, 'utf-8')) as Record<string, unknown>;
    const activeGoalId = typeof parsed.activeGoalId === 'string' ? parsed.activeGoalId.trim() : '';
    if (activeGoalId === '') {
      return null;
    }
    if (!isSafeUltragoalGoalId(activeGoalId)) {
      throw new InvalidUltragoalTeamContextError(`unsafe_active_goal_id:${activeGoalId}`);
    }
    const goals = Array.isArray(parsed.goals) ? parsed.goals : [];
    const activeGoal = goals.find((goal) =>
      goal && typeof goal === 'object' && (goal as Record<string, unknown>).id === activeGoalId,
    ) as Record<string, unknown> | undefined;
    if (!activeGoal) {
      throw new InvalidUltragoalTeamContextError(`active_goal_not_found:${activeGoalId}`);
    }
    if (activeGoal.status !== 'in_progress') {
      throw new InvalidUltragoalTeamContextError(`active_goal_not_in_progress:${activeGoalId}`);
    }
    const activeGoalTitle = typeof activeGoal?.title === 'string' && activeGoal.title.trim() !== ''
      ? activeGoal.title.trim()
      : undefined;
    return {
      kind: 'leader_owned_ultragoal_context',
      goalsPath: '.omx/ultragoal/goals.json',
      ledgerPath: '.omx/ultragoal/ledger.jsonl',
      activeGoalId,
      ...(activeGoalTitle ? { activeGoalTitle } : {}),
      codexGoalMode: resolvePlanCodexGoalMode(parsed.codexGoalMode),
      checkpointPolicy: 'fresh_leader_get_goal_required',
    };
  } catch (error) {
    if (error instanceof InvalidUltragoalTeamContextError) {
      throw new Error(`invalid_ultragoal_team_context:${error.message}`);
    }
    throw new Error(`invalid_ultragoal_team_context:malformed_goals_json`);
  }
}

export async function writePersistedTeamUltragoalContext(
  teamName: string,
  cwd: string,
  context: UltragoalTeamContext | null | undefined,
  teamStateRoot?: string | null,
): Promise<void> {
  const path = contextStatePath(teamName, cwd, teamStateRoot);
  const normalized = normalizeUltragoalTeamContext(context);
  if (!normalized) {
    await rm(path, { force: true }).catch(() => {});
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
}

export async function readPersistedTeamUltragoalContext(
  teamName: string,
  cwd: string,
  teamStateRoot?: string | null,
): Promise<UltragoalTeamContext | null> {
  const path = contextStatePath(teamName, cwd, teamStateRoot);
  if (!existsSync(path)) return null;
  try {
    return normalizeUltragoalTeamContext(JSON.parse(await readFile(path, 'utf-8')) as unknown);
  } catch {
    return null;
  }
}

export function buildUltragoalCheckpointGuidance(
  context: UltragoalTeamContext,
): UltragoalCheckpointGuidance {
  const goalId = context.activeGoalId;
  const intermediateStoryCommand = `omx ultragoal checkpoint --goal-id ${goalId} --status complete --evidence "<team evidence mentioning .omx/ultragoal and ${goalId}>" --codex-goal-json <fresh-active-get_goal-json-or-path>`;
  const finalStoryCommand = `omx ultragoal checkpoint --goal-id ${goalId} --status complete --evidence "<team evidence mentioning .omx/ultragoal and ${goalId}>" --codex-goal-json <fresh-complete-get_goal-json-or-path> --quality-gate-json <quality-gate-json-or-path>`;
  return {
    goal_id: goalId,
    ...(context.activeGoalTitle ? { goal_title: context.activeGoalTitle } : {}),
    codex_goal_mode: context.codexGoalMode,
    goals_path: context.goalsPath,
    ledger_path: context.ledgerPath,
    checkpoint_policy: context.checkpointPolicy,
    checkpoint_command_template: intermediateStoryCommand,
    final_checkpoint_command_template: finalStoryCommand,
    evidence_requirements: [
      'team tasks are terminal',
      'verification passed',
      `evidence mentions ${goalId}`,
      'evidence mentions .omx/ultragoal artifacts',
      'leader captured fresh get_goal JSON before checkpointing',
    ],
    command_templates: {
      intermediate_story: intermediateStoryCommand,
      final_story: finalStoryCommand,
      per_story: `omx ultragoal checkpoint --goal-id ${goalId} --status complete --evidence "<team evidence mentioning .omx/ultragoal and ${goalId}>" --codex-goal-json <fresh-matching-get_goal-json-or-path>`,
      completed_wrong_legacy_goal_blocker: `omx ultragoal checkpoint --goal-id ${goalId} --status blocked --evidence "<completed legacy Codex goal blocks this ultragoal story>" --codex-goal-json <fresh-completed-wrong-get_goal-json-or-path>`,
    },
  };
}

export function renderLeaderOwnedUltragoalContextSection(
  context: UltragoalTeamContext | null | undefined,
): string | undefined {
  if (!context) return undefined;
  const guidance = buildUltragoalCheckpointGuidance(context);
  return [
    '### Leader-owned Ultragoal context',
    '',
    `- Context kind: ${context.kind}`,
    `- Active goal: ${context.activeGoalId}${context.activeGoalTitle ? ` (${context.activeGoalTitle})` : ''}`,
    `- Codex goal mode: ${context.codexGoalMode}`,
    `- Goals path: ${context.goalsPath}`,
    `- Ledger path: ${context.ledgerPath}`,
    `- Checkpoint policy: ${context.checkpointPolicy}`,
    '- Team tasks/evidence feed leader checkpointing; workers do not own Ultragoal goal state.',
    '- Workers must not create worker Ultragoal ledgers, mutate `.omx/ultragoal`, auto-launch Team from Ultragoal, or claim shell commands changed Codex goal state.',
    `- Leader checkpoint command shape: ${guidance.command_templates.intermediate_story}`,
    '- Final aggregate stories require leader final quality gates before `update_goal({status: "complete"})`, then a fresh `get_goal` snapshot and `--quality-gate-json`.',
  ].join('\n');
}

export function renderUltragoalCheckpointGuidanceText(
  context: UltragoalTeamContext | null | undefined,
): string[] {
  if (!context) return [];
  const guidance = buildUltragoalCheckpointGuidance(context);
  return [
    'ultragoal_checkpoint_guidance:',
    `  goal_id: ${guidance.goal_id}`,
    ...(guidance.goal_title ? [`  goal_title: ${guidance.goal_title}`] : []),
    `  codex_goal_mode: ${guidance.codex_goal_mode}`,
    `  goals_path: ${guidance.goals_path}`,
    `  ledger_path: ${guidance.ledger_path}`,
    `  checkpoint_policy: ${guidance.checkpoint_policy}`,
    '  worker_boundary: workers do not own Ultragoal goal state or mutate .omx/ultragoal artifacts',
    `  evidence_requirements: ${guidance.evidence_requirements.join('; ')}`,
    `  intermediate_story: ${guidance.command_templates.intermediate_story}`,
    `  final_story: ${guidance.command_templates.final_story}`,
    `  per_story: ${guidance.command_templates.per_story}`,
    `  completed_wrong_legacy_goal_blocker: ${guidance.command_templates.completed_wrong_legacy_goal_blocker}`,
  ];
}
