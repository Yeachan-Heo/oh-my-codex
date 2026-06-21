import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  formatCodexGoalReconciliation,
  buildCompletedCodexGoalRemediation,
  parseCodexGoalSnapshot,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';

export const ULTRAGOAL_DIR = '.omx/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';
const ULTRAGOAL_MUTATION_LOCK = '.mutation.lock';

export type UltragoalStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'review_blocked' | 'needs_user_decision';
export type UltragoalCodexGoalMode = 'aggregate' | 'per_story';
export type UltragoalSteeringStatus = 'superseded' | 'blocked';
export type UltragoalSteeringMutationKind =
  | 'add_subgoal'
  | 'split_subgoal'
  | 'reorder_pending'
  | 'revise_pending_wording'
  | 'annotate_ledger'
  | 'mark_blocked_superseded';
export type UltragoalSteeringSource = 'user_prompt_submit' | 'finding' | 'cli';

export const ULTRAGOAL_STEERING_MUTATION_KINDS: readonly UltragoalSteeringMutationKind[] = [
  'add_subgoal',
  'split_subgoal',
  'reorder_pending',
  'revise_pending_wording',
  'annotate_ledger',
  'mark_blocked_superseded',
];

export const ULTRAGOAL_STEERING_SOURCES: readonly UltragoalSteeringSource[] = [
  'user_prompt_submit',
  'finding',
  'cli',
];

export interface UltragoalSteeringInvariantResult {
  accepted: boolean;
  structuralInvariantAccepted: boolean;
  evidenceBackedNecessity: boolean;
  noEasierCompletion: boolean;
  rejectedReasons: string[];
  reasons?: string[];
}

export interface UltragoalSteeringChildGoal {
  title: string;
  objective: string;
  tokenBudget?: number;
}

export interface UltragoalSteeringAfterPayload {
  title?: string;
  objective?: string;
  pendingGoalIds?: string[];
  children?: UltragoalSteeringChildGoal[];
}

export interface UltragoalSteeringProposal {
  kind: UltragoalSteeringMutationKind;
  source: UltragoalSteeringSource;
  targetGoalId?: string;
  targetGoalIds?: string[];
  evidence: string;
  rationale: string;
  title?: string;
  objective?: string;
  childGoals?: UltragoalSteeringChildGoal[];
  revisedTitle?: string;
  revisedObjective?: string;
  pendingOrder?: string[];
  blockedReason?: string;
  after?: UltragoalSteeringAfterPayload;
  directiveText?: string;
  promptSignature?: string;
  idempotencyKey?: string;
  now?: Date;
}

export interface UltragoalSteeringAudit {
  kind: UltragoalSteeringMutationKind;
  source: UltragoalSteeringSource;
  targetGoalIds: string[];
  before?: unknown;
  after?: unknown;
  evidence: string;
  rationale: string;
  invariant: UltragoalSteeringInvariantResult;
  directiveText?: string;
  promptSignature?: string;
  idempotencyKey?: string;
  deduped?: boolean;
}

export interface SteerUltragoalResult {
  plan: UltragoalPlan;
  accepted: boolean;
  audit: UltragoalSteeringAudit;
  rejectedReasons: string[];
  deduped: boolean;
}



export interface UltragoalItem {
  id: string;
  title: string;
  objective: string;
  status: UltragoalStatus;
  tokenBudget?: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  reviewBlockedAt?: string;
  evidence?: string;
  failureReason?: string;
  steeringStatus?: UltragoalSteeringStatus;
  supersededBy?: string[];
  supersedes?: string[];
  blockedReason?: string;
  blockerSignature?: string;
  blockerOccurrenceCount?: number;
  requiredExternalDecision?: string;
  nonRetriable?: boolean;
  steeringEvidence?: string;
  steeringRationale?: string;
}

export interface UltragoalAggregateCompletion {
  status: 'complete';
  completedAt: string;
  evidence: string;
  codexGoal?: unknown;
}

export interface UltragoalArchitectureInvariantEvidence {
  invariant: string;
  source: string;
  status: 'proved';
  implementationEvidence: string;
  testEvidence: string;
  reviewEvidence: string;
  blockers?: never;
}


export interface UltragoalPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  briefPath: string;
  goalsPath: string;
  ledgerPath: string;
  codexGoalMode?: UltragoalCodexGoalMode;
  codexObjective?: string;
  codexObjectiveAliases?: string[];
  aggregateCompletion?: UltragoalAggregateCompletion;
  activeGoalId?: string;
  goals: UltragoalItem[];
}

export interface UltragoalLedgerEntry {
  ts: string;
  event:
    | 'plan_created'
    | 'goal_started'
    | 'goal_resumed'
    | 'goal_completed'
    | 'goal_blocked'
    | 'goal_failed'
    | 'goal_needs_user_decision'
    | 'goal_retried'
    | 'aggregate_completed'
    | 'aggregate_objective_migrated'
    | 'goal_added'
    | 'steering_accepted'
    | 'steering_rejected'
    | 'final_review_failed'
    | 'goal_review_blocked';
  goalId?: string;
  status?: UltragoalStatus;
  message?: string;
  codexGoal?: unknown;
  evidence?: string;
  qualityGate?: UltragoalQualityGate;
  steering?: UltragoalSteeringAudit;
  before?: unknown;
  after?: unknown;
  mutationKind?: UltragoalSteeringMutationKind;
  idempotencyKey?: string;
  blockerSignature?: string;
  blockerOccurrenceCount?: number;
  requiredExternalDecision?: string;
}

export interface CreateUltragoalOptions {
  brief: string;
  goals?: Array<{ title?: string; objective: string; tokenBudget?: number }>;
  codexGoalMode?: UltragoalCodexGoalMode;
  now?: Date;
  force?: boolean;
}

export interface StartNextOptions {
  now?: Date;
  retryFailed?: boolean;
}

export interface CheckpointOptions {
  goalId: string;
  status: Extract<UltragoalStatus, 'complete' | 'failed'> | 'blocked';
  evidence?: string;
  codexGoal?: unknown;
  qualityGate?: unknown;
  allowActiveFinalCodexGoal?: boolean;
  now?: Date;
}

export interface AddUltragoalGoalOptions {
  title: string;
  objective: string;
  evidence?: string;
  now?: Date;
}

export interface RecordFinalReviewBlockersOptions extends AddUltragoalGoalOptions {
  goalId: string;
  codexGoal?: unknown;
}

export interface UltragoalQualityGate {
  aiSlopCleaner: {
    status: 'passed';
    evidence: string;
  };
  verification: {
    status: 'passed';
    commands: string[];
    evidence: string;
  };
  codeReview: {
    recommendation: 'APPROVE';
    architectStatus: 'CLEAR';
    evidence: string;
    independentReview: {
      codeReviewer: {
        agentRole: 'code-reviewer';
        evidence: string;
      };
      architect: {
        agentRole: 'architect';
        evidence: string;
      };
    };
  };
  architectureInvariantGate: {
    status: 'passed';
    sourceArtifacts: string[];
    invariants: UltragoalArchitectureInvariantEvidence[];
    evidence: string;
  };

}

export class UltragoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

export function ultragoalDir(cwd: string): string {
  return join(cwd, ULTRAGOAL_DIR);
}

export function ultragoalBriefPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_BRIEF);
}

export function ultragoalGoalsPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
}

export function ultragoalLedgerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER);
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

interface MarkdownListItem {
  lineIndex: number;
  indent: number;
  text: string;
  section?: string;
}

function lineIndentWidth(line: string): number {
  return (line.match(/^(\s*)/)?.[1] ?? '').replace(/\t/g, '  ').length;
}

function normalizeSectionLabel(value: string): string | undefined {
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(value)) return undefined;
  const atx = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(value)?.[1];
  const plain = /^([^\s].{1,100}):\s*$/.exec(value)?.[1];
  return (atx ?? plain)?.replace(/[`*_~]/g, '').replace(/:$/, '').trim().toLowerCase();
}

function normalizeIndentedAtxStorySectionLabel(value: string): string | undefined {
  const atx = /^\s{1,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(value)?.[1]
    ?.replace(/[`*_~]/g, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
  return sectionLooksStory(atx) ? atx : undefined;
}

function sectionLooksNonStory(section: string | undefined): boolean {
  return /^(?:acceptance\s+criteria|verification(?:\s+checklist)?|validation(?:\s+checklist)?|checklist|evidence|constraints?|risks?|immediate\s+next\s+actions?|next\s+actions?|follow-?ups?|notes?)$/.test(section ?? '');
}

function sectionLooksStory(section: string | undefined): boolean {
  return /^(?:story|stories|goals?|milestones?|p\d+)$/.test(section ?? '');
}

function parseMarkdownListItems(lines: readonly string[]): MarkdownListItem[] {
  const items: MarkdownListItem[] = [];
  let section: string | undefined;
  let resetNonStorySection = false;
  let afterBlank = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (!line.trim()) {
      resetNonStorySection ||= sectionLooksNonStory(section);
      afterBlank = true;
      continue;
    }
    const nextSection = normalizeSectionLabel(line)
      ?? (afterBlank ? normalizeIndentedAtxStorySectionLabel(line) : undefined);
    if (nextSection) {
      section = nextSection;
      resetNonStorySection = false;
    }
    afterBlank = false;
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '  ').length;
    if (resetNonStorySection && indent === 0) section = undefined;
    resetNonStorySection = false;
    const text = cleanLine(line);
    if (!text || text.length > 1200) continue;
    items.push({ lineIndex, indent, text, section });
  }
  return items;
}

function selectedItemObjective(parent: MarkdownListItem, lines: readonly string[], nextParentLineIndex?: number): string {
  const parts = [parent.text];
  for (let lineIndex = parent.lineIndex + 1; lineIndex < (nextParentLineIndex ?? lines.length); lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const indent = lineIndentWidth(line);
    if (indent <= parent.indent && sectionLooksNonStory(normalizeSectionLabel(line))) break;
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) && indent <= parent.indent) break;
    if (indent <= parent.indent || !line.trim()) continue;
    const nested = cleanLine(line);
    if (nested && nested.length <= 1200) parts.push(nested);
  }
  return parts.join('\n');
}

function topLevelStoryItems(items: readonly MarkdownListItem[]): MarkdownListItem[] {
  const storyItems = items.filter((item) => !sectionLooksNonStory(item.section));
  if (storyItems.length === 0) return [];
  const storySectionItems = storyItems.filter((item) => sectionLooksStory(item.section));
  const candidates = storySectionItems.length > 0 ? storySectionItems : storyItems;
  const minIndent = Math.min(...candidates.map((item) => item.indent));
  return candidates.filter((item) => item.indent === minIndent);
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeBlockerEvidence(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`"'()[\]{}:,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExternalAuthorizationBlocker {
  signature: string;
  requiredDecision: string;
}

function classifyExternalAuthorizationBlocker(evidence: string | undefined): ExternalAuthorizationBlocker | null {
  const normalized = normalizeBlockerEvidence(evidence);
  if (!normalized) return null;

  const mentionsAuthorization = /\b(auth|authorization|credential|credentials|token|permission|permissions|scope|scopes|access|unauthorized|forbidden|401|403)\b/.test(normalized);
  const mentionsMissingAuthority = /\b(unset|missing|required|requires|without|omit|omits|not set|not available|no read packages|read packages)\b/.test(normalized);
  if (!mentionsAuthorization || !mentionsMissingAuthority) return null;

  const mentionsGhcr = /\b(ghcr|github container registry|read packages|imagepullsecret|package api|anonymous image|container image)\b/.test(normalized);
  if (mentionsGhcr) {
    const has401 = /\b(401|unauthorized|anonymous pull|authentication required)\b/.test(normalized);
    const has403 = /\b(403|forbidden|read packages|package api)\b/.test(normalized);
    const status = [has401 ? 'HTTP_401_ANONYMOUS' : null, has403 ? 'HTTP_403_NO_READ_PACKAGES' : null]
      .filter((part): part is string => Boolean(part))
      .join('+') || 'AUTHORIZATION_REQUIRED';
    return {
      signature: `GHCR_PULL_ACCESS:${status}:GHCR_VISIBILITY_OR_CREDENTIAL_REQUIRED`,
      requiredDecision: 'make the GHCR package public, or provide/authorize a least-privilege read:packages credential and imagePullSecret/SOPS path',
    };
  }

  return {
    signature: 'EXTERNAL_AUTHORIZATION_REQUIRED',
    requiredDecision: 'provide the missing external authorization/credential, or explicitly choose a different unblock path',
  };
}

function sameBlockerOccurrences(entries: readonly UltragoalLedgerEntry[], goalId: string, signature: string): number {
  return entries.filter((entry) => (
    entry.goalId === goalId
    && (entry.event === 'goal_failed' || entry.event === 'goal_needs_user_decision')
    && entry.blockerSignature === signature
  )).length;
}

function clearGoalBlockerFields(goal: UltragoalItem): void {
  goal.blockedReason = undefined;
  goal.blockerSignature = undefined;
  goal.blockerOccurrenceCount = undefined;
  goal.requiredExternalDecision = undefined;
  goal.nonRetriable = undefined;
}


function textMentionsUltragoalPlanArtifact(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized.includes(ULTRAGOAL_DIR.toLowerCase())
    || normalized.includes(ULTRAGOAL_GOALS.toLowerCase())
    || normalized.includes(ULTRAGOAL_LEDGER.toLowerCase());
}

function textMentionsGoalId(value: string | undefined, goalId: string): boolean {
  return (value ?? '').toLowerCase().includes(goalId.toLowerCase());
}

function textHasCompletionValidationEvidence(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  const hasImplementationCompletion = /\b(?:planned work|implementation|deliverables?|scope|task|work)\b/.test(normalized)
    && /\b(?:done|complete|completed|finished|shipped)\b/.test(normalized);
  const hasValidation = /\b(?:validation|verification|tests?|build|lint|review|quality gate|code-review)\b/.test(normalized)
    && /\b(?:passed|complete|completed|clean|green|approve|approved|clear)\b/.test(normalized);
  return hasImplementationCompletion && hasValidation;
}

async function snapshotObjectiveMapsToUltragoalPlan(cwd: string, snapshotObjective: string): Promise<boolean> {
  const actual = normalizeObjective(snapshotObjective).toLowerCase();
  if (textMentionsUltragoalPlanArtifact(actual)) return true;
  if (actual.length < 24) return false;
  try {
    const brief = normalizeObjective(await readFile(ultragoalBriefPath(cwd), 'utf-8')).toLowerCase();
    if (!brief || brief.length < 24) return false;
    return brief.includes(actual) || actual.includes(brief);
  } catch {
    return false;
  }
}

async function canReconcileCompletedTaskScopedAggregateSnapshot(
  cwd: string,
  plan: UltragoalPlan,
  goal: UltragoalItem,
  snapshotObjective: string,
  evidence: string | undefined,
): Promise<boolean> {
  if (codexGoalMode(plan) !== 'aggregate') return false;
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) return false;
  if (!textMentionsUltragoalPlanArtifact(evidence)) return false;
  if (!textMentionsGoalId(evidence, goal.id)) return false;
  if (!textHasCompletionValidationEvidence(evidence)) return false;
  return snapshotObjectiveMapsToUltragoalPlan(cwd, snapshotObjective);
}


function buildCompletedLegacyGoalRemediation(goal: UltragoalItem): string {
  return [
    'If get_goal returns a different completed legacy/thread objective, do not repeat --status complete in this thread.',
    `Record a non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json "<different completed get_goal JSON or path>".`,
    'Then continue only from a Codex goal context with no active/completed conflicting goal, in the same repo/worktree, and create the intended goal there.',
  ].join(' ');
}

function buildUnavailableCodexGoalRemediation(goal: UltragoalItem): string {
  return [
    'If get_goal itself is unavailable due to a Codex DB/schema/context error, such as "no such table: thread_goals", do not repeat --status complete or mark the Codex goal complete from shell state.',
    `Record an auditable non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context>" --codex-goal-json "<unavailable get_goal error JSON or path>".`,
    'Then continue from a Codex goal context where get_goal works and strict completion reconciliation can be proven.',
  ].join(' ');
}

function evidenceDescribesCompletedAggregateMicrogoalLoop(evidence: string | undefined): boolean {
  const normalized = normalizeObjective(evidence ?? '').toLowerCase();
  return normalized.includes('aggregate codex goal')
    && /\bcomplete(?:d)?\b/.test(normalized)
    && normalized.includes('microgoal')
    && /\b(?:unreconcilable|mismatch|loop|already complete|already completed|blocks?)\b/.test(normalized);
}

function isSafeCompletedAggregateBlockerSnapshot(
  plan: UltragoalPlan,
  goal: UltragoalItem,
  snapshot: ReturnType<typeof parseCodexGoalSnapshot>,
  evidence: string | undefined,
): boolean {
  if (codexGoalMode(plan) !== 'aggregate') return false;
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) return false;
  if (snapshot?.status !== 'complete' || !snapshot.objective) return false;
  if (!evidenceDescribesCompletedAggregateMicrogoalLoop(evidence)) return false;
  const actual = normalizeObjective(snapshot.objective);
  return [expectedCodexObjective(plan, goal), ...compatibleCodexObjectives(plan)]
    .some((objective) => normalizeObjective(objective) === actual);
}

function codexGoalMode(plan: UltragoalPlan): UltragoalCodexGoalMode {
  return plan.codexGoalMode ?? 'per_story';
}

function isResolvedStatus(status: UltragoalStatus): boolean {
  return status === 'complete' || status === 'review_blocked';
}

function isScheduleEligibleGoal(goal: UltragoalItem): boolean {
  return goal.steeringStatus !== 'superseded' && goal.steeringStatus !== 'blocked';
}

export const ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE =
  `Complete the durable ultragoal plan in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}, including later accepted/appended stories, under the original brief constraints; use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the audit trail.`;

function aggregateCodexObjective(_goals: readonly UltragoalItem[]): string {
  if (ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE.length <= 4000) return ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE;
  throw new UltragoalError('Generated aggregate Codex objective exceeds the 4,000 character goal limit.');
}

function isLegacyEnumeratedAggregateObjective(objective: string | undefined): boolean {
  if (!objective) return false;
  return (
    objective.startsWith(`Complete all ultragoal stories in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}: `)
    || objective === `Complete all ultragoal stories listed in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}. Use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the durable audit trail.`
  );
}

function compatibleCodexObjectives(plan: UltragoalPlan): string[] {
  return (plan.codexObjectiveAliases ?? [])
    .filter((objective) => isLegacyEnumeratedAggregateObjective(objective));
}

function expectedCodexObjective(plan: UltragoalPlan, goal: UltragoalItem): string {
  return codexGoalMode(plan) === 'aggregate'
    ? (plan.codexObjective ?? aggregateCodexObjective(plan.goals))
    : goal.objective;
}

function isSupersededResolved(goal: UltragoalItem, plan: UltragoalPlan): boolean {
  if (goal.steeringStatus !== 'superseded') return false;
  const replacements = goal.supersededBy ?? [];
  if (replacements.length === 0) return false;
  return replacements.every((id) => {
    const replacement = plan.goals.find((candidate) => candidate.id === id);
    return replacement !== undefined && isResolvedStatus(replacement.status);
  });
}

function isCompletionBlocking(goal: UltragoalItem, plan: UltragoalPlan): boolean {
  if (goal.steeringStatus === 'superseded') return !isSupersededResolved(goal, plan);
  if (goal.steeringStatus === 'blocked') return true;
  return !isResolvedStatus(goal.status);
}

function isCompletionBlockingForFinalCandidate(candidate: UltragoalItem, finalCandidate: UltragoalItem, plan: UltragoalPlan): boolean {
  if (candidate.id === finalCandidate.id) return false;
  if (candidate.steeringStatus === 'superseded') {
    const replacements = candidate.supersededBy ?? [];
    if (replacements.length === 0) return true;
    return !replacements.every((id) => {
      if (id === finalCandidate.id) return true;
      const replacement = plan.goals.find((goal) => goal.id === id);
      return replacement !== undefined && isResolvedStatus(replacement.status);
    });
  }
  return isCompletionBlocking(candidate, plan);
}

function isScheduleEligible(goal: UltragoalItem): boolean {
  return goal.steeringStatus !== 'superseded' && goal.steeringStatus !== 'blocked';
}

export function isFinalRunCompletionCandidate(plan: UltragoalPlan, goal: UltragoalItem): boolean {
  return plan.goals.every((candidate) => !isCompletionBlockingForFinalCandidate(candidate, goal, plan));
}

export function isUltragoalDone(plan: UltragoalPlan): boolean {
  if (plan.aggregateCompletion?.status === 'complete') return true;
  if (plan.goals.length === 0) return true;
  if (plan.goals.some((goal) => isCompletionBlocking(goal, plan))) return false;
  const latestNonReviewBlocked = [...plan.goals].reverse().find((goal) => goal.status !== 'review_blocked' && goal.steeringStatus !== 'superseded');
  return latestNonReviewBlocked?.status === 'complete';
}

function titleFromObjective(objective: string, fallback: string): string {
  const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}

export function deriveGoalCandidates(brief: string): Array<{ title: string; objective: string }> {
  const lines = brief.split(/\r?\n/);
  const parsedItems = parseMarkdownListItems(lines);
  const parentItems = topLevelStoryItems(parsedItems);
  const listGoals = parentItems
    .map((item, index) => selectedItemObjective(item, lines, parentItems[index + 1]?.lineIndex))
    .filter((objective, index, all) => all.findIndex((candidate) => candidate === objective) === index);
  const bulletGoals = (listGoals.length > 0 || parsedItems.length > 0 ? listGoals : lines
    .map((line) => ({ original: line, cleaned: cleanLine(line) }))
    .filter(({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200)
    .filter(({ original, cleaned }, index, all) => (
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original)
      && all.findIndex((candidate) => candidate.cleaned === cleaned) === index
    ))
    .map(({ cleaned }) => cleaned));

  const objectives = bulletGoals.length > 0
    ? bulletGoals
    : parsedItems.length > 0
      ? [brief.trim() || 'Complete the requested project objective.']
      : brief
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#'));

  const selected = objectives.length > 0 ? objectives : [brief.trim() || 'Complete the requested project objective.'];
  return selected.map((objective, index) => ({
    title: titleFromObjective(objective, `Goal ${index + 1}`),
    objective,
  }));
}

function normalizeGoalId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return `G${String(index + 1).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUltragoalMutationLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const lockPath = join(ultragoalDir(cwd), ULTRAGOAL_MUTATION_LOCK);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: iso() }));
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      await sleep(Math.min(25 + attempt * 5, 250));
    }
  }
  if (!handle) {
    throw new UltragoalError(`Timed out waiting for ultragoal mutation lock at ${repoRelative(cwd, lockPath)}.`);
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function appendLedger(cwd: string, entry: UltragoalLedgerEntry): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const path = ultragoalLedgerPath(cwd);
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omx ultragoal create-goals ...\` first.`);
  }
  const parsed = JSON.parse(raw) as UltragoalPlan;
  if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${repoRelative(cwd, path)}.`);
  }
  if (codexGoalMode(parsed) === 'aggregate' && isLegacyEnumeratedAggregateObjective(parsed.codexObjective)) {
    const previousObjective = parsed.codexObjective;
    const now = iso();
    parsed.codexObjective = aggregateCodexObjective(parsed.goals);
    parsed.codexObjectiveAliases = Array.from(new Set([...(parsed.codexObjectiveAliases ?? []), previousObjective].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    parsed.updatedAt = now;
    await writePlan(cwd, parsed);
    await appendLedger(cwd, {
      ts: now,
      event: 'aggregate_objective_migrated',
      message: 'Migrated legacy enumerated aggregate Codex objective to the stable pointer objective.',
      before: { codexObjective: previousObjective },
      after: { codexObjective: parsed.codexObjective },
    });
  }
  return parsed;
}

async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const path = ultragoalGoalsPath(cwd);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(plan, null, 2)}\n`);
  await rename(tmpPath, path);
}

export async function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  if (!options.force && existsSync(ultragoalGoalsPath(cwd))) {
    throw new UltragoalError(`Refusing to overwrite existing ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}; pass --force to recreate it.`);
  }
  const now = iso(options.now);
  const sourceGoals: Array<{ title?: string; objective: string; tokenBudget?: number }> = options.goals?.length
    ? options.goals
    : deriveGoalCandidates(options.brief);
  const candidates = sourceGoals
    .map((goal, index): UltragoalItem => ({
      id: normalizeGoalId(goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`), index),
      title: goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
      objective: goal.objective.trim(),
      status: 'pending',
      tokenBudget: goal.tokenBudget,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }));

  const plan: UltragoalPlan = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    briefPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`,
    goalsPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`,
    ledgerPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`,
    codexGoalMode: options.codexGoalMode ?? 'aggregate',
    goals: candidates,
  };
  if (plan.codexGoalMode === 'aggregate') plan.codexObjective = aggregateCodexObjective(candidates);

  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalBriefPath(cwd), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
  await writePlan(cwd, plan);
  await writeFile(ultragoalLedgerPath(cwd), '');
  await appendLedger(cwd, { ts: now, event: 'plan_created', message: `${candidates.length} goal(s) created` });
  return plan;
  });
}

export function summarizeUltragoalPlan(plan: UltragoalPlan): { total: number; pending: number; inProgress: number; complete: number; failed: number; reviewBlocked: number; needsUserDecision: number; superseded: number; steeringBlocked: number; aggregateComplete: boolean; artifactComplete: boolean; activeGoalId?: string } {
  return {
    total: plan.goals.length,
    pending: plan.goals.filter((goal) => goal.status === 'pending').length,
    inProgress: plan.goals.filter((goal) => goal.status === 'in_progress').length,
    complete: plan.goals.filter((goal) => goal.status === 'complete').length,
    failed: plan.goals.filter((goal) => goal.status === 'failed').length,
    reviewBlocked: plan.goals.filter((goal) => goal.status === 'review_blocked').length,
    needsUserDecision: plan.goals.filter((goal) => goal.status === 'needs_user_decision').length,
    superseded: plan.goals.filter((goal) => goal.steeringStatus === 'superseded').length,
    steeringBlocked: plan.goals.filter((goal) => goal.steeringStatus === 'blocked').length,
    aggregateComplete: plan.aggregateCompletion?.status === 'complete',
    artifactComplete: isUltragoalDone(plan),
    activeGoalId: plan.activeGoalId,
  };
}

function assertNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new UltragoalError(`Missing ${label}.`);
  return trimmed;
}

export function parseUltragoalSteeringDirective(raw: string): UltragoalSteeringProposal | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 5) return null;
  try {
    const parsed = JSON.parse(trimmed) as UltragoalSteeringProposal;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.kind || typeof parsed.kind !== 'string') return null;
    if (!parsed.source || typeof parsed.source !== 'string') return null;
    if (!parsed.evidence || typeof parsed.evidence !== 'string') return null;
    if (!parsed.rationale || typeof parsed.rationale !== 'string') return null;
    if (!ULTRAGOAL_STEERING_MUTATION_KINDS.includes(parsed.kind as UltragoalSteeringMutationKind)) return null;
    if (!ULTRAGOAL_STEERING_SOURCES.includes(parsed.source as UltragoalSteeringSource)) return null;
    return parsed;
  } catch {
    return null;
  }
}


function appendGoalToPlan(plan: UltragoalPlan, options: AddUltragoalGoalOptions, nowOverride?: string): UltragoalItem {
  const now = nowOverride ?? iso(options.now);
  const title = assertNonEmpty(options.title, '--title');
  const objective = assertNonEmpty(options.objective, '--objective');
  const goal: UltragoalItem = {
    id: normalizeGoalId(title, plan.goals.length),
    title,
    objective,
    status: 'pending',
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    evidence: options.evidence,
  };
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

export async function addUltragoalGoal(cwd: string, options: AddUltragoalGoalOptions): Promise<{ plan: UltragoalPlan; goal: UltragoalItem }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  const goal = appendGoalToPlan(plan, options);
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: goal.title,
  });
  return { plan, goal };
  });
}


function proposalTargetIds(proposal: UltragoalSteeringProposal): string[] {
  return proposal.targetGoalIds?.length ? proposal.targetGoalIds : (proposal.targetGoalId ? [proposal.targetGoalId] : []);
}

function steeringTargets(plan: UltragoalPlan, proposal: UltragoalSteeringProposal): UltragoalItem[] {
  return proposalTargetIds(proposal).map((id) => {
    const goal = plan.goals.find((candidate) => candidate.id === id);
    if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${id}`);
    return goal;
  });
}

function mentionsWeakenedCompletion(...values: Array<string | undefined>): boolean {
  const normalized = values.filter(Boolean).join(' ').toLowerCase();
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/.test(normalized)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/.test(normalized);
}

function hasProtectedSteeringPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const protectedKeys = new Set([
    'aggregateCompletion',
    'brief',
    'briefPath',
    'codexObjective',
    'constraints',
    'completedAt',
    'qualityGate',
    'status',
  ]);
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (protectedKeys.has(key)) return true;
      if (key.toLowerCase().includes('complete')) return true;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function protectedIntentText(proposal: UltragoalSteeringProposal): string {
  const after = proposal.after as UltragoalSteeringAfterPayload | undefined;
  const childTexts = rawChildGoalsFromProposal(proposal).flatMap((child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return [];
    const candidate = child as { title?: unknown; objective?: unknown };
    return [candidate.title, candidate.objective];
  });
  return [
    proposal.title,
    proposal.objective,
    proposal.revisedTitle,
    proposal.revisedObjective,
    after?.title,
    after?.objective,
    proposal.rationale,
    proposal.directiveText,
    ...childTexts,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}

function rawChildGoalsFromProposal(proposal: UltragoalSteeringProposal): unknown[] {
  if (Array.isArray(proposal.childGoals) && proposal.childGoals.length > 0) return proposal.childGoals;
  const after = proposal.after as { children?: unknown[] } | undefined;
  return Array.isArray(after?.children) ? after.children : [];
}

function isValidSteeringChildGoal(value: unknown): value is UltragoalSteeringChildGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { title?: unknown; objective?: unknown };
  return typeof candidate.title === 'string'
    && candidate.title.trim().length > 0
    && typeof candidate.objective === 'string'
    && candidate.objective.trim().length > 0;
}

function childGoalsFromProposal(proposal: UltragoalSteeringProposal): UltragoalSteeringChildGoal[] {
  return rawChildGoalsFromProposal(proposal).filter(isValidSteeringChildGoal);
}

function pendingOrderFromProposal(proposal: UltragoalSteeringProposal): string[] {
  if (proposal.pendingOrder?.length) return proposal.pendingOrder;
  const after = proposal.after as { pendingGoalIds?: string[] } | undefined;
  return Array.isArray(after?.pendingGoalIds) ? after.pendingGoalIds : [];
}

function revisedTitleFromProposal(proposal: UltragoalSteeringProposal): string | undefined {
  if (proposal.revisedTitle?.trim()) return proposal.revisedTitle;
  const after = proposal.after as { title?: string } | undefined;
  return after?.title ?? proposal.title;
}

function revisedObjectiveFromProposal(proposal: UltragoalSteeringProposal): string | undefined {
  if (proposal.revisedObjective?.trim()) return proposal.revisedObjective;
  const after = proposal.after as { objective?: string } | undefined;
  return after?.objective ?? proposal.objective;
}

export function validateUltragoalSteeringProposal(plan: UltragoalPlan, proposal: UltragoalSteeringProposal): UltragoalSteeringInvariantResult {
  const rejectedReasons: string[] = [];
  const evidenceBackedNecessity = Boolean(proposal.evidence?.trim()) && Boolean(proposal.rationale?.trim());
  if (!ULTRAGOAL_STEERING_MUTATION_KINDS.includes(proposal.kind)) rejectedReasons.push(`Invalid steering mutation kind: ${String(proposal.kind)}.`);
  if (!ULTRAGOAL_STEERING_SOURCES.includes(proposal.source)) rejectedReasons.push(`Invalid steering source: ${String(proposal.source)}.`);
  if (!evidenceBackedNecessity) rejectedReasons.push('Steering requires non-empty evidence and rationale.');
  if (hasProtectedSteeringPayload(proposal.after)) rejectedReasons.push('Steering payload must not edit protected objective, constraint, quality gate, or completion fields.');
  if (/\b(?:skip|bypass|weaken|remove)\b.*\b(?:test|tests|review|verification|quality gate|complete|completion)\b|\bauto[- ]?complete\b/.test(protectedIntentText(proposal))) {
    rejectedReasons.push('Steering must not weaken completion, quality gates, tests, reviews, or auto-complete work.');
  }
  if (plan.aggregateCompletion?.status === 'complete') rejectedReasons.push('Cannot steer an already completed aggregate ultragoal plan.');

  let targets: UltragoalItem[] = [];
  try {
    targets = steeringTargets(plan, proposal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rejectedReasons.push(message.replace(/^Unknown ultragoal id:/, 'unknown ultragoal id:'));
  }
  const target = targets[0];
  if ((proposal.kind === 'split_subgoal' || proposal.kind === 'revise_pending_wording' || proposal.kind === 'mark_blocked_superseded') && !target) {
    rejectedReasons.push(`${proposal.kind} requires a target goal id.`);
  }
  if ((proposal.kind === 'split_subgoal' || proposal.kind === 'revise_pending_wording') && target?.status !== 'pending') {
    rejectedReasons.push(`${proposal.kind} can only target a pending goal.`);
  }

  if (proposal.kind === 'add_subgoal') {
    if (!proposal.title?.trim() || !proposal.objective?.trim()) rejectedReasons.push('add_subgoal requires title and objective.');
  }
  if (proposal.kind === 'split_subgoal') {
    const rawChildren = rawChildGoalsFromProposal(proposal);
    if (rawChildren.length === 0) rejectedReasons.push('split_subgoal requires replacement child goals.');
    if (rawChildren.some((child) => !isValidSteeringChildGoal(child))) rejectedReasons.push('split_subgoal children require title and objective.');
  }
  if (proposal.kind === 'mark_blocked_superseded') {
    const rawChildren = rawChildGoalsFromProposal(proposal);
    if (rawChildren.some((child) => !isValidSteeringChildGoal(child))) rejectedReasons.push('mark_blocked_superseded replacement children require title and objective.');
  }
  if (proposal.kind === 'reorder_pending') {
    const requested = pendingOrderFromProposal(proposal);
    const pending = plan.goals.filter((goal) => goal.status === 'pending' && isScheduleEligible(goal)).map((goal) => goal.id);
    if (requested.length === 0) rejectedReasons.push('reorder_pending requires at least one pending goal id.');
    if (new Set(requested).size !== requested.length) rejectedReasons.push('duplicate goal id in pendingOrder.');
    if (requested.some((id) => !pending.includes(id))) rejectedReasons.push('pendingOrder contains non-pending or unknown goal.');
  }
  if (proposal.kind === 'revise_pending_wording') {
    if (!revisedTitleFromProposal(proposal)?.trim() && !revisedObjectiveFromProposal(proposal)?.trim()) rejectedReasons.push('revise_pending_wording requires title or objective.');
  }
  if (proposal.kind === 'annotate_ledger' && !proposal.evidence?.trim()) rejectedReasons.push('annotate_ledger requires evidence.');

  const accepted = rejectedReasons.length === 0;
  const noEasierCompletion = !mentionsWeakenedCompletion(protectedIntentText(proposal));
  return {
    structuralInvariantAccepted: accepted,
    evidenceBackedNecessity,
    noEasierCompletion,
    accepted,
    rejectedReasons,
    reasons: rejectedReasons,
  };
}

export const validateSteeringProposal = validateUltragoalSteeringProposal;

async function readSteeringLedgerEntries(cwd: string): Promise<UltragoalLedgerEntry[]> {
  try {
    const raw = await readFile(ultragoalLedgerPath(cwd), 'utf-8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as UltragoalLedgerEntry);
  } catch {
    return [];
  }
}

function cloneForAudit<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function moveGoalsAfterTarget(plan: UltragoalPlan, targetId: string, movedIds: string[]): void {
  const moved = movedIds.map((id) => plan.goals.find((goal) => goal.id === id)).filter((goal): goal is UltragoalItem => Boolean(goal));
  if (moved.length === 0) return;
  plan.goals = plan.goals.filter((goal) => !movedIds.includes(goal.id));
  const targetIndex = plan.goals.findIndex((goal) => goal.id === targetId);
  plan.goals.splice(targetIndex >= 0 ? targetIndex + 1 : plan.goals.length, 0, ...moved);
}

function applySteeringMutation(plan: UltragoalPlan, proposal: UltragoalSteeringProposal, now: string): { before?: unknown; after?: unknown } {
  const targets = steeringTargets(plan, proposal);
  const target = targets[0];
  if (proposal.kind === 'add_subgoal') {
    const goal = appendGoalToPlan(plan, { title: proposal.title ?? '', objective: proposal.objective ?? '', evidence: proposal.evidence, now: new Date(now) });
    return { before: undefined, after: cloneForAudit(goal) };
  }
  if (proposal.kind === 'split_subgoal') {
    const before = cloneForAudit(target);
    const children = childGoalsFromProposal(proposal).map((child) => appendGoalToPlan(plan, { ...child, evidence: proposal.evidence, now: new Date(now) }));
    target.steeringStatus = 'superseded';
    target.supersededBy = children.map((child) => child.id);
    moveGoalsAfterTarget(plan, target.id, children.map((child) => child.id));
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    for (const child of children) child.supersedes = [target.id];
    if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
    plan.updatedAt = now;
    return { before, after: { target: cloneForAudit(target), children: cloneForAudit(children) } };
  }
  if (proposal.kind === 'reorder_pending') {
    const before = plan.goals.map((goal) => goal.id);
    const requested = pendingOrderFromProposal(proposal);
    const requestedSet = new Set(requested);
    const requestedGoals = requested.map((id) => plan.goals.find((goal) => goal.id === id)).filter((goal): goal is UltragoalItem => Boolean(goal));
    const remaining = plan.goals.filter((goal) => !requestedSet.has(goal.id));
    plan.goals = [...requestedGoals, ...remaining];
    plan.updatedAt = now;
    return { before, after: plan.goals.map((goal) => goal.id) };
  }
  if (proposal.kind === 'revise_pending_wording') {
    const before = cloneForAudit(target);
    const revisedTitle = revisedTitleFromProposal(proposal);
    const revisedObjective = revisedObjectiveFromProposal(proposal);
    if (revisedTitle?.trim()) target.title = revisedTitle.trim();
    if (revisedObjective?.trim()) target.objective = revisedObjective.trim();
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    plan.updatedAt = now;
    return { before, after: cloneForAudit(target) };
  }
  if (proposal.kind === 'annotate_ledger') {
    return { before: undefined, after: { evidence: proposal.evidence, rationale: proposal.rationale } };
  }
  if (proposal.kind === 'mark_blocked_superseded') {
    const before = cloneForAudit(target);
    const children = childGoalsFromProposal(proposal);
    if (children.length > 0) {
      const replacements = children.map((child) => appendGoalToPlan(plan, { ...child, evidence: proposal.evidence, now: new Date(now) }));
      target.steeringStatus = 'superseded';
      target.supersededBy = replacements.map((child) => child.id);
      moveGoalsAfterTarget(plan, target.id, replacements.map((child) => child.id));
      target.steeringEvidence = proposal.evidence;
      target.steeringRationale = proposal.rationale;
      target.updatedAt = now;
      for (const replacement of replacements) replacement.supersedes = [target.id];
      if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
      plan.updatedAt = now;
      return { before, after: { target: cloneForAudit(target), children: cloneForAudit(replacements) } };
    }
    if (plan.activeGoalId === target.id) delete plan.activeGoalId;
    target.steeringStatus = 'blocked';
    target.blockedReason = proposal.blockedReason ?? proposal.rationale;
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
    plan.updatedAt = now;
    return { before, after: cloneForAudit(target) };
  }
  return {};
}

export async function steerUltragoal(cwd: string, proposal: UltragoalSteeringProposal, options: { now?: Date; directiveText?: string } = {}): Promise<SteerUltragoalResult> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlan(cwd);
  const existing = proposal.idempotencyKey
    ? (await readSteeringLedgerEntries(cwd)).find((entry) => entry.event === 'steering_accepted' && (entry.idempotencyKey === proposal.idempotencyKey || entry.steering?.idempotencyKey === proposal.idempotencyKey) && entry.steering)
    : undefined;
  if (existing?.steering) {
    return { plan, accepted: true, audit: { ...existing.steering, deduped: true }, rejectedReasons: [], deduped: true };
  }

  let invariant = validateUltragoalSteeringProposal(plan, proposal);
  const now = iso(options.now ?? proposal.now);
  const beforePlan = cloneForAudit(plan);
  let mutation: { before?: unknown; after?: unknown } = {};
  if (invariant.accepted) {
    try {
      mutation = applySteeringMutation(plan, proposal, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedReasons = [...invariant.rejectedReasons, `Steering mutation failed: ${message}`];
      invariant = {
        ...invariant,
        accepted: false,
        structuralInvariantAccepted: false,
        rejectedReasons,
        reasons: rejectedReasons,
      };
    }
  }
  const audit: UltragoalSteeringAudit = {
    kind: proposal.kind,
    source: proposal.source,
    targetGoalIds: proposalTargetIds(proposal),
    before: mutation.before ?? beforePlan,
    after: mutation.after,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    invariant,
    directiveText: options.directiveText ?? proposal.directiveText,
    promptSignature: proposal.promptSignature,
    idempotencyKey: proposal.idempotencyKey,
  };

  if (invariant.accepted) await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: invariant.accepted ? 'steering_accepted' : 'steering_rejected',
    goalId: proposalTargetIds(proposal)[0],
    evidence: proposal.evidence,
    message: proposal.rationale,
    steering: audit,
    mutationKind: proposal.kind,
    before: audit.before,
    after: audit.after,
  });

  return { plan, accepted: invariant.accepted, audit, rejectedReasons: invariant.rejectedReasons, deduped: false };
  });
}

function normalizeInvariantText(value: string): string {
  return value.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
interface RequiredArchitectureInvariant {
  invariant: string;
  sourceArtifact: string;
  source: string;
}

function requiredInvariantSourceKey(invariant: RequiredArchitectureInvariant): string {
  return `${normalizeInvariantText(invariant.invariant)}\u0000${invariant.sourceArtifact}`;
}

function uniqueRequiredArchitectureInvariants(invariants: readonly RequiredArchitectureInvariant[]): RequiredArchitectureInvariant[] {
  const seen = new Set<string>();
  const unique: RequiredArchitectureInvariant[] = [];
  for (const invariant of invariants) {
    const key = requiredInvariantSourceKey(invariant);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(invariant);
  }
  return unique;
}

function architectureInvariantSectionSlug(label: string): string {
  return label
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'architecture-invariants';
}

function normalizeSourceArtifact(value: string): string {
  return value.trim().split('#', 1)[0]?.replace(/\\/g, '/') ?? '';
}

function sourceReferencesArtifact(source: string, artifact: string): boolean {
  return normalizeSourceArtifact(source) === normalizeSourceArtifact(artifact);
}

function sourceReferencesAnyArtifact(source: string, artifacts: readonly string[]): boolean {
  return artifacts.some((artifact) => sourceReferencesArtifact(source, artifact));
}

function invariantFromInlineDeclaration(line: string): string | undefined {
  const trimmed = cleanLine(line).replace(/^['"]|['"]$/g, '').trim();
  const match = /\b(?:(?:non-negotiable|required)\s+)?(?:architecture|architectural|domain)\s+(?:invariants?|constraints?|non-negotiables?)\s*:\s*(.+)$/i.exec(trimmed)
    ?? /\bnon-negotiables?\s+(?:architecture|architectural|domain)\s+(?:invariants?|constraints?)\s*:\s*(.+)$/i.exec(trimmed);
  const invariant = match?.[1]?.trim().replace(/[.;]\s*$/, '').trim();
  return invariant || undefined;
}

function extractArchitectureInvariantsFromArtifact(text: string, sourceArtifact: string, sourcePrefix?: string): RequiredArchitectureInvariant[] {
  const lines = text.split(/\r?\n/);
  const invariants: RequiredArchitectureInvariant[] = [];
  let inInvariantSection = false;
  let sectionSlug = 'architecture-invariants';
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const label = heading[1] ?? '';
      const normalizedLabel = label.toLowerCase();
      inInvariantSection = /\b(?:architecture|architectural|domain|non-negotiable)\b/.test(normalizedLabel) && /\binvariants?\b|\bconstraints?\b|\bnon-negotiables?\b/.test(normalizedLabel);
      if (inInvariantSection) sectionSlug = architectureInvariantSectionSlug(label);
      continue;
    }
    const inline = invariantFromInlineDeclaration(line);
    if (inline) {
      invariants.push({ invariant: inline, sourceArtifact, source: `${sourceArtifact}#${sourcePrefix ?? 'inline-architecture-invariant'}` });
      continue;
    }
    if (!inInvariantSection) continue;
    const item = cleanLine(line);
    if (!item || item === line.trim()) continue;
    invariants.push({ invariant: item, sourceArtifact, source: `${sourceArtifact}#${sourcePrefix ? `${sourcePrefix}-${sectionSlug}` : sectionSlug}` });
  }
  return uniqueRequiredArchitectureInvariants(invariants.map((item) => ({ ...item, invariant: item.invariant.trim() })).filter((item) => item.invariant));
}

function extractArchitectureInvariantsFromBrief(brief: string): RequiredArchitectureInvariant[] {
  return extractArchitectureInvariantsFromArtifact(brief, `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`);
}

function extractArchitectureInvariantsFromAcceptedSteering(entries: readonly UltragoalLedgerEntry[]): RequiredArchitectureInvariant[] {
  const invariants: RequiredArchitectureInvariant[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.event !== 'steering_accepted' || !entry.steering?.invariant.accepted) continue;
    const sourcePrefix = `steering-${index + 1}`;
    const steering = entry.steering;
    const texts = [
      entry.evidence,
      entry.message,
      steering.evidence,
      steering.rationale,
      steering.directiveText,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    for (const text of texts) {
      invariants.push(...extractArchitectureInvariantsFromArtifact(text, `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`, sourcePrefix));
    }
  }
  return uniqueRequiredArchitectureInvariants(invariants);
}

async function collectRequiredArchitectureInvariants(cwd: string): Promise<RequiredArchitectureInvariant[]> {
  const briefInvariants = extractArchitectureInvariantsFromBrief(await readFile(ultragoalBriefPath(cwd), 'utf-8'));
  const steeringInvariants = extractArchitectureInvariantsFromAcceptedSteering(await readSteeringLedgerEntries(cwd));
  return uniqueRequiredArchitectureInvariants([...briefInvariants, ...steeringInvariants]);
}


function validateArchitectureInvariantGate(gate: Partial<UltragoalQualityGate>, requiredInvariants: readonly RequiredArchitectureInvariant[]): void {
  const invariantGate = gate.architectureInvariantGate;
  if (!invariantGate || typeof invariantGate !== 'object') {
    throw new UltragoalError('Final quality gate is missing architectureInvariantGate evidence; include derived architecture/domain invariants, source artifacts, implementation/test/review evidence, or record final blockers for unproved invariants.');
  }
  if (invariantGate.status !== 'passed') {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.status="passed"; record blocker-resolution work for unproved invariants.');
  }
  if (!Array.isArray(invariantGate.sourceArtifacts)) {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.sourceArtifacts.');
  }
  const sourceArtifacts = invariantGate.sourceArtifacts.map((source) => assertNonEmpty(source, 'architectureInvariantGate.sourceArtifacts[]'));
  for (const required of requiredInvariants) {
    if (!sourceArtifacts.some((source) => sourceReferencesArtifact(source, required.sourceArtifact))) {
      throw new UltragoalError(`Final architecture-invariant gate sourceArtifacts must include required invariant source artifact: ${required.sourceArtifact}`);
    }
  }
  assertNonEmpty(invariantGate.evidence, 'architectureInvariantGate.evidence');
  if (!Array.isArray(invariantGate.invariants)) {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.invariants.');
  }
  const provided = new Map<string, UltragoalArchitectureInvariantEvidence[]>();
  for (const invariant of invariantGate.invariants) {
    if (!invariant || typeof invariant !== 'object') throw new UltragoalError('Final architecture-invariant gate invariants must be objects.');
    const record = invariant as Partial<UltragoalArchitectureInvariantEvidence> & { blockers?: unknown };
    const text = assertNonEmpty(record.invariant, 'architectureInvariantGate.invariants[].invariant');
    const source = assertNonEmpty(record.source, 'architectureInvariantGate.invariants[].source');
    if (!sourceReferencesAnyArtifact(source, sourceArtifacts)) {
      throw new UltragoalError(`Final architecture invariant "${text}" source must reference one of architectureInvariantGate.sourceArtifacts; decorative provenance labels are not sufficient.`);
    }
    if (record.status !== 'proved') throw new UltragoalError(`Final architecture invariant "${text}" is not proved; record blocker-resolution work before final completion.`);
    if (record.blockers !== undefined) throw new UltragoalError(`Final architecture invariant "${text}" has blockers; record blocker-resolution work before final completion.`);
    assertNonEmpty(record.implementationEvidence, 'architectureInvariantGate.invariants[].implementationEvidence');
    assertNonEmpty(record.testEvidence, 'architectureInvariantGate.invariants[].testEvidence');
    assertNonEmpty(record.reviewEvidence, 'architectureInvariantGate.invariants[].reviewEvidence');
    const key = normalizeInvariantText(text);
    const records = provided.get(key) ?? [];
    records.push(record as UltragoalArchitectureInvariantEvidence);
    provided.set(key, records);
  }
  for (const required of requiredInvariants) {
    const matches = provided.get(normalizeInvariantText(required.invariant)) ?? [];
    if (matches.length === 0) {
      throw new UltragoalError(`Final architecture-invariant gate is missing proof for required invariant from ${required.sourceArtifact}: ${required.invariant}`);
    }
    if (!matches.some((record) => sourceReferencesArtifact(record.source, required.sourceArtifact))) {
      throw new UltragoalError(`Final architecture-invariant gate proof for required invariant must reference ${required.sourceArtifact}: ${required.invariant}`);
    }
  }
}

function validateQualityGate(value: unknown, requiredInvariants: readonly RequiredArchitectureInvariant[] = []): UltragoalQualityGate {
  if (!value || typeof value !== 'object') {
    throw new UltragoalError('Final ultragoal completion requires --quality-gate-json with ai-slop-cleaner, verification, code-review, and architecture-invariant evidence.');
  }
  const gate = value as Partial<UltragoalQualityGate>;
  const cleaner = gate.aiSlopCleaner;
  const verification = gate.verification;
  const review = gate.codeReview;
  if (!cleaner || typeof cleaner !== 'object') throw new UltragoalError('Final quality gate is missing aiSlopCleaner evidence.');
  if (cleaner.status !== 'passed') {
    throw new UltragoalError('Final quality gate requires aiSlopCleaner.status="passed"; run ai-slop-cleaner even when it is a no-op.');
  }
  assertNonEmpty(cleaner.evidence, 'aiSlopCleaner.evidence');
  if (!verification || typeof verification !== 'object') throw new UltragoalError('Final quality gate is missing verification evidence.');
  if (verification.status !== 'passed') throw new UltragoalError('Final quality gate requires verification.status="passed".');
  if (!Array.isArray(verification.commands) || verification.commands.length === 0 || verification.commands.some((command) => typeof command !== 'string' || command.trim() === '')) {
    throw new UltragoalError('Final quality gate requires non-empty verification.commands.');
  }
  assertNonEmpty(verification.evidence, 'verification.evidence');
  if (!review || typeof review !== 'object') throw new UltragoalError('Final quality gate is missing codeReview evidence.');
  if (review.recommendation !== 'APPROVE') {
    throw new UltragoalError('Final code-review must be clean: codeReview.recommendation must be APPROVE; use record-review-blockers for COMMENT or REQUEST CHANGES.');
  }
  if (review.architectStatus !== 'CLEAR') {
    throw new UltragoalError('Final code-review must be clean: codeReview.architectStatus must be CLEAR; use record-review-blockers for WATCH or BLOCK.');
  }
  assertNonEmpty(review.evidence, 'codeReview.evidence');
  const independentReview = (review as Partial<UltragoalQualityGate['codeReview']>).independentReview;
  if (!independentReview || typeof independentReview !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: codeReview.independentReview must include completed code-reviewer and architect subagent evidence; use record-review-blockers instead of self-approving.');
  }
  const codeReviewer = independentReview.codeReviewer;
  if (!codeReviewer || typeof codeReviewer !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: missing codeReview.independentReview.codeReviewer evidence from the code-reviewer subagent.');
  }
  if (codeReviewer.agentRole !== 'code-reviewer') {
    throw new UltragoalError('Final code-review must use an independent code-reviewer subagent; self-review or default/authoring-lane review cannot approve the ultragoal gate.');
  }
  assertNonEmpty(codeReviewer.evidence, 'codeReview.independentReview.codeReviewer.evidence');
  const architect = independentReview.architect;
  if (!architect || typeof architect !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: missing codeReview.independentReview.architect evidence from the architect subagent.');
  }
  if (architect.agentRole !== 'architect') {
    throw new UltragoalError('Final code-review must use an independent architect subagent; self-review or default/authoring-lane review cannot approve the ultragoal gate.');
  }
  assertNonEmpty(architect.evidence, 'codeReview.independentReview.architect.evidence');
  validateArchitectureInvariantGate(gate, requiredInvariants);
  return gate as UltragoalQualityGate;
}

export async function startNextUltragoal(cwd: string, options: StartNextOptions = {}): Promise<{ plan: UltragoalPlan; goal: UltragoalItem | null; resumed: boolean; done: boolean }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlan(cwd);
  const now = iso(options.now);
  if (plan.aggregateCompletion?.status === 'complete') return { plan, goal: null, resumed: false, done: true };
  const existing = plan.goals.find((goal) => goal.status === 'in_progress' && isScheduleEligibleGoal(goal));
  if (existing) {
    await appendLedger(cwd, { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' });
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((goal) => goal.status === 'pending' && isScheduleEligible(goal));
  if (!next && options.retryFailed) {
    next = plan.goals.find((goal) => goal.status === 'failed' && !goal.nonRetriable && isScheduleEligible(goal));
    if (next) await appendLedger(cwd, { ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason });
  }
  if (!next) return { plan, goal: null, resumed: false, done: isUltragoalDone(plan) };

  next.status = 'in_progress';
  next.attempt += 1;
  next.startedAt = now;
  next.failedAt = undefined;
  next.failureReason = undefined;
  clearGoalBlockerFields(next);
  next.updatedAt = now;
  plan.activeGoalId = next.id;
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, { ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` });
  return { plan, goal: next, resumed: false, done: false };
  });
}

export async function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  const now = iso(options.now);
  if (options.status === 'blocked') {
    if (goal.status !== 'in_progress') {
      throw new UltragoalError(`Cannot record a blocked checkpoint for ${goal.id} while it is ${goal.status}; start or resume the ultragoal before recording a non-terminal blocker.`);
    }
    const snapshot = options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal);
    if (snapshot?.unavailableReason === 'db_schema_context_error') {
      goal.updatedAt = now;
      goal.failureReason = assertNonEmpty(options.evidence, '--evidence');
      plan.activeGoalId = goal.id;
      plan.updatedAt = now;
      await writePlan(cwd, plan);
      await appendLedger(cwd, {
        ts: now,
        event: 'goal_blocked',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        message: 'Codex get_goal was unavailable due to a DB/schema/context error; strict completion reconciliation is deferred until get_goal works.',
      });
      return plan;
    }
    if (!snapshot?.available) {
      throw new UltragoalError('Blocked ultragoal checkpoints require either a get_goal snapshot for the completed legacy Codex goal that blocked create_goal, or an unavailable get_goal error JSON for a Codex DB/schema/context failure; pass --codex-goal-json.');
    }
    if (snapshot.status !== 'complete') {
      throw new UltragoalError(`Cannot record a blocked ultragoal checkpoint while the existing Codex goal is ${snapshot.status ?? 'unknown'}; strict objective mismatch protection remains required for active or incomplete goals.`);
    }
    if (!snapshot.objective) {
      throw new UltragoalError('Blocked ultragoal checkpoint Codex snapshot is missing objective text.');
    }
    const safeCompletedAggregateBlocker = isSafeCompletedAggregateBlockerSnapshot(plan, goal, snapshot, options.evidence);
    const blockedSnapshotMatchesExpected = [expectedCodexObjective(plan, goal), ...compatibleCodexObjectives(plan)]
      .some((objective) => normalizeObjective(objective) === normalizeObjective(snapshot.objective ?? ''));
    if (!safeCompletedAggregateBlocker && blockedSnapshotMatchesExpected) {
      throw new UltragoalError('Blocked ultragoal checkpoint is only for a different completed legacy Codex goal unless an aggregate Codex goal is already complete and unreconcilable while the active repo-native microgoal remains in progress.');
    }
    goal.updatedAt = now;
    if (safeCompletedAggregateBlocker) goal.failureReason = assertNonEmpty(options.evidence, '--evidence');
    plan.activeGoalId = goal.id;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'goal_blocked',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      message: safeCompletedAggregateBlocker
        ? 'Completed aggregate Codex goal is already terminal while the repo-native microgoal remains in progress; recorded a non-terminal safe-recovery blocker to avoid repeating an impossible checkpoint loop.'
        : undefined,
    });
    return plan;
  }
  let aggregateCompletion: UltragoalAggregateCompletion | undefined;
  if (options.status === 'complete') {
    const expectedObjective = expectedCodexObjective(plan, goal);
    const aggregateMode = codexGoalMode(plan) === 'aggregate';
    const finalRunCheckpoint = isFinalRunCompletionCandidate(plan, goal);
    const snapshot = options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal);
    const reconciliation = reconcileCodexGoalSnapshot(
      snapshot,
      {
        expectedObjective,
        acceptedObjectives: aggregateMode ? compatibleCodexObjectives(plan) : undefined,
        allowedStatuses: aggregateMode
          ? (finalRunCheckpoint && !options.allowActiveFinalCodexGoal ? ['complete'] : ['active'])
          : ['complete'],
        requireSnapshot: true,
        requireComplete: !aggregateMode || (finalRunCheckpoint && !options.allowActiveFinalCodexGoal),
      },
    );
    if (!reconciliation.ok) {
      const completedTaskScopedAggregateSnapshot = snapshot?.available
        && snapshot.status === 'complete'
        && Boolean(snapshot.objective)
        && normalizeObjective(snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
        && await canReconcileCompletedTaskScopedAggregateSnapshot(cwd, plan, goal, snapshot.objective ?? '', options.evidence);
      if (completedTaskScopedAggregateSnapshot) {
        aggregateCompletion = {
          status: 'complete',
          completedAt: now,
          evidence: assertNonEmpty(options.evidence, '--evidence'),
          codexGoal: options.codexGoal,
        };
      } else {
        const taskScopedRequirement = aggregateMode && snapshot?.status === 'complete' && Boolean(snapshot.objective)
          ? ' Completed task-scoped aggregate reconciliation requires the checkpoint goal to be the active in-progress OMX goal, evidence that names that active OMX goal id, names .omx/ultragoal/goals.json or ledger.jsonl, includes completed implementation plus validation/review evidence, and a get_goal objective that maps to the ultragoal brief/artifact.'
          : '';
        const remediation = reconciliation.snapshot.available
          && reconciliation.snapshot.status === 'complete'
          && Boolean(reconciliation.snapshot.objective)
          && normalizeObjective(reconciliation.snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
          ? ` ${buildCompletedLegacyGoalRemediation(goal)}`
          : reconciliation.snapshot.unavailableReason === 'db_schema_context_error'
            ? ` ${buildUnavailableCodexGoalRemediation(goal)}`
          : '';
        throw new UltragoalError(`${formatCodexGoalReconciliation(reconciliation)}${taskScopedRequirement}${remediation}`);
      }
    }
    if (finalRunCheckpoint && !options.allowActiveFinalCodexGoal) goal.evidence = options.evidence;
  }
  const requiredArchitectureInvariants = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalCodexGoal))
    ? await collectRequiredArchitectureInvariants(cwd)
    : [];
  const qualityGate = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalCodexGoal))
    ? validateQualityGate(options.qualityGate, requiredArchitectureInvariants)
    : undefined;
  if (aggregateCompletion) {
    plan.aggregateCompletion = aggregateCompletion;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'aggregate_completed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      qualityGate,
      message: 'Aggregate ultragoal plan completed via task-scoped Codex goal snapshot; microgoal ledger progress remains independent.',
    });
    return plan;
  }
  goal.status = options.status;
  goal.updatedAt = now;
  if (options.status === 'complete') {
    goal.completedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    clearGoalBlockerFields(goal);
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  } else {
    const blocker = classifyExternalAuthorizationBlocker(options.evidence);
    const previousEntries = blocker ? await readSteeringLedgerEntries(cwd) : [];
    const occurrenceCount = blocker ? sameBlockerOccurrences(previousEntries, goal.id, blocker.signature) + 1 : 0;
    const shouldCircuitBreak = blocker !== null && occurrenceCount >= 3;
    goal.failedAt = now;
    goal.failureReason = options.evidence;
    goal.blockerSignature = blocker?.signature;
    goal.blockerOccurrenceCount = blocker ? occurrenceCount : undefined;
    goal.requiredExternalDecision = blocker?.requiredDecision;
    goal.nonRetriable = shouldCircuitBreak || undefined;
    if (shouldCircuitBreak) {
      goal.status = 'needs_user_decision';
      goal.blockedReason = options.evidence;
    }
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  }
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  const blockerEvent = goal.status === 'needs_user_decision';
  await appendLedger(cwd, {
    ts: now,
    event: options.status === 'complete' ? 'goal_completed' : blockerEvent ? 'goal_needs_user_decision' : 'goal_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
    qualityGate,
    blockerSignature: goal.blockerSignature,
    blockerOccurrenceCount: goal.blockerOccurrenceCount,
    requiredExternalDecision: goal.requiredExternalDecision,
    message: blockerEvent
      ? `Blocked on repeated external authorization. Required decision: ${goal.requiredExternalDecision}.`
      : undefined,
  });
  return plan;
  });
}

export async function recordFinalReviewBlockers(cwd: string, options: RecordFinalReviewBlockersOptions): Promise<{ plan: UltragoalPlan; blockedGoal: UltragoalItem; addedGoal: UltragoalItem }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlan(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  assertNonEmpty(options.evidence, '--evidence');
  if (goal.status !== 'in_progress') {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id} while it is ${goal.status}; start or resume the ultragoal first.`);
  }
  if (!isFinalRunCompletionCandidate(plan, goal)) {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id}; it is not the only unresolved ultragoal story.`);
  }

  const now = iso(options.now);
  const expectedObjective = expectedCodexObjective(plan, goal);
  const aggregateMode = codexGoalMode(plan) === 'aggregate';
  const reconciliation = reconcileCodexGoalSnapshot(
    options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal),
    {
      expectedObjective,
      acceptedObjectives: aggregateMode ? compatibleCodexObjectives(plan) : undefined,
      allowedStatuses: ['active'],
      requireSnapshot: true,
      requireComplete: false,
    },
  );
  if (!reconciliation.ok) {
    throw new UltragoalError(formatCodexGoalReconciliation(reconciliation));
  }

  const addedGoal = appendGoalToPlan(plan, { ...options, now: options.now });
  goal.status = 'review_blocked';
  goal.reviewBlockedAt = now;
  goal.updatedAt = now;
  goal.completedAt = undefined;
  goal.failedAt = undefined;
  goal.failureReason = undefined;
  goal.evidence = options.evidence;
  if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  plan.updatedAt = now;

  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'final_review_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
    message: aggregateMode
      ? 'Final aggregate code-review was not clean; blocker story was appended while Codex goal remains active.'
      : 'Final per-story code-review was not clean; blocker story was appended and may require an available Codex goal context.',
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: addedGoal.id,
    status: addedGoal.status,
    evidence: options.evidence,
    message: addedGoal.title,
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_review_blocked',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
  });
  return { plan, blockedGoal: goal, addedGoal };
  });
}

export function buildCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  if (codexGoalMode(plan) === 'aggregate') return buildAggregateCodexGoalInstruction(goal, plan);
  return buildPerStoryCodexGoalInstruction(goal, plan);
}

function buildPerStoryCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const createPayload = {
    objective: goal.objective,
    ...(goal.tokenBudget ? { token_budget: goal.tokenBudget } : {}),
  };
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  return [
    'Ultragoal active-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Codex goal integration constraints:',
    '- First call get_goal. If no active goal exists, call create_goal with the payload below.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Ultragoal preflight')}`,
    '- If a different active Codex goal exists, finish/checkpoint that goal before starting this ultragoal.',
    '- Ultragoal cannot call /goal clear from the model/shell tool surface. For another per-story goal in the same session/thread after a completed Codex goal, manually run /goal clear in the Codex UI before creating the next goal.',
    '- If get_goal returns a different completed legacy/thread goal and create_goal rejects because this thread already has a completed goal, continue only from a Codex goal context with no active/completed conflicting goal in the same repo/worktree and create the payload there.',
    `- To preserve the durable ledger before switching threads, record the non-terminal blocker without failing this goal: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json "<get_goal JSON or path>"`,
    '- Work only this goal until its completion audit passes.',
    finalStory
      ? '- Final mandatory quality gate: run ai-slop-cleaner on changed files even when it is a no-op, rerun verification, then run $code-review.'
      : '- This is not the final ultragoal story; do not run the final ai-slop-cleaner/$code-review gate yet.',
    finalStory
      ? '- Final $code-review is clean only when it is APPROVE with architect status CLEAR and includes independentReview evidence from both code-reviewer and architect subagents.'
      : null,
    finalStory
      ? '- If final $code-review is non-clean, missing independentReview evidence, or independent delegation is unavailable/skipped/failed, do not call update_goal. Record blockers with:'
      : '- After the goal is actually complete, call update_goal({status: "complete"}), call get_goal again for a fresh completion snapshot, then checkpoint the ledger with:',
    finalStory
      ? `  omx ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json "<active get_goal JSON or path>"`
      : `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh get_goal JSON or path>"`,
    finalStory
      ? '- In legacy per-story mode, the blocker story may require an available Codex goal context because this story remains an active incomplete Codex goal; do not claim it is complete.'
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR + independent code-reviewer and architect subagent evidence), call update_goal({status: "complete"}), call get_goal again, then checkpoint with --quality-gate-json:'
      : null,
    finalStory
      ? `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh complete get_goal JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : null,
    finalStory
      ? '- After the final checkpoint command succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.'
      : null,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Objective:',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}

function buildAggregateCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan): string {
  const objective = plan.codexObjective ?? aggregateCodexObjective(plan.goals);
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  const createPayload = { objective };
  const checkpointStatus = finalStory ? 'complete' : 'active';
  return [
    'Ultragoal aggregate-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Codex goal integration constraints:',
    '- Codex goal = the whole ultragoal run; OMX G001/G002/etc. = ledger stories.',
    '- First call get_goal. If no active goal exists, call create_goal with the aggregate payload below.',
    '- If get_goal reports the same aggregate objective as active, continue this OMX story without creating a new Codex goal.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Ultragoal preflight')}`,
    '- If a different active or incomplete Codex goal exists, finish/checkpoint that goal before starting this ultragoal; do not replace hidden Codex state from the shell.',
    '- Ultragoal does not call /goal clear. After a completed aggregate run, manually run /goal clear in the Codex UI before starting another ultragoal run in the same session/thread.',
    finalStory
      ? '- This is the final pending story: run the mandatory final ai-slop-cleaner pass, rerun verification, and run $code-review before any update_goal call.'
      : '- This is not the final story: do not call update_goal yet; the aggregate Codex goal must remain active while later OMX stories remain.',
    finalStory
      ? '- Final $code-review is clean only when it is APPROVE with architect status CLEAR and includes independentReview evidence from both code-reviewer and architect subagents.'
      : null,
    finalStory
      ? '- If final $code-review is non-clean, missing independentReview evidence, or independent delegation is unavailable/skipped/failed, do not call update_goal. Record durable blocker work first:'
      : null,
    finalStory
      ? `  omx ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json "<active get_goal JSON or path>"`
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR + independent code-reviewer and architect subagent evidence), call update_goal({status: "complete"}), call get_goal again for a fresh complete snapshot, then checkpoint with --quality-gate-json.'
      : null,
    finalStory
      ? '- After the final checkpoint command succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.'
      : null,
    `- Checkpoint this OMX story with a fresh get_goal snapshot whose objective matches the aggregate payload and whose status is ${checkpointStatus}:`,
    finalStory
      ? `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh complete get_goal JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh get_goal JSON or path>"`,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Aggregate objective:',
    objective,
    '',
    'Current OMX story objective:',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}
