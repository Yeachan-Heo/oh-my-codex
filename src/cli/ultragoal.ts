import { readFile } from 'node:fs/promises';
import {
  CodexGoalSnapshotError,
  formatCodexGoalReconciliation,
  buildCodexGoalTerminalCleanupNotice,
  readCodexGoalSnapshotInput,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import {
  addUltragoalGoal,
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  readUltragoalPlan,
  recordFinalReviewBlockers,
  startNextUltragoal,
  steerUltragoal,
  summarizeUltragoalPlan,
  type UltragoalItem,
  type UltragoalSteeringAfterPayload,
  type UltragoalSteeringMutationKind,
  type UltragoalSteeringProposal,
  type UltragoalSteeringSource,
  ULTRAGOAL_STEERING_MUTATION_KINDS,
  ULTRAGOAL_STEERING_SOURCES,
  UltragoalError,
} from '../ultragoal/artifacts.js';

export const ULTRAGOAL_HELP = `omx ultragoal - Durable repo-native multi-goal workflow over Codex goal mode

Usage:
  omx ultragoal create-goals [--brief <text> | --brief-file <path> | --from-stdin] [--goal <title::objective>] [--codex-goal-mode <aggregate|per-story>] [--force] [--json]
  omx ultragoal complete-goals [--retry-failed] [--json]
  omx ultragoal add-goal --title <title> --objective <text> [--evidence <text>] [--json]
  omx ultragoal steer --kind <mutation-kind> --evidence <text> --rationale <text> [--target-goal-id <id> | --target-goal-ids <id1,id2,...>] [--title <title>] [--objective <text>] [--json]
  omx ultragoal record-review-blockers --goal-id <id> --title <title> --objective <text> --evidence <review-findings> --codex-goal-json <active-json-or-path> [--json]
  omx ultragoal steer --kind <add_subgoal|split_subgoal|reorder_pending|revise_pending_wording|annotate_ledger|mark_blocked_superseded> --evidence <text> --rationale <text> [--target-goal-id <id>] [--title <text>] [--objective <text>] [--after-json <json-or-path>] [--idempotency-key <key>] [--json]
  omx ultragoal steer --directive-json <json-or-path> [--json]
  omx ultragoal checkpoint --goal-id <id> --status <complete|failed|blocked> [--evidence <text>] [--codex-goal-json <json-or-path>] [--quality-gate-json <json-or-path>] [--json]
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
  Ultragoal does not call /goal clear or hidden thread/goal/clear routes. For
  multiple sequential ultragoal runs in one Codex session/thread, manually run
  /goal clear in the Codex UI before creating the next aggregate goal.
  New plans default to aggregate mode: one Codex goal covers the whole ultragoal
  run while OMX checkpoints G001/G002 stories in the durable ledger. Legacy
  per-story plans retain completed-goal blocker handling when a completed thread
  goal prevents create_goal for the next story.
  Dynamic steering is explicit-only: steer accepts structured fields or directive JSON,
  audits accepted/rejected/deduped results in .omx/ultragoal/ledger.jsonl, and
  rejects broad natural-language mutation requests.
  Repeated identical external authorization blockers become non-retriable
  needs_user_decision stories; complete-goals --retry-failed skips them and prints
  the required external decision instead of looping.
  Final completion is mandatory-gated: run ai-slop-cleaner, rerun verification,
  run $code-review, and pass --quality-gate-json with APPROVE + CLEAR evidence.
  Non-clean final review must use record-review-blockers before update_goal.
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
  const valueTaking = new Set(['--brief', '--brief-file', '--goal', '--goal-id', '--target-goal-id', '--status', '--evidence', '--codex-goal-json', '--codex-goal-mode', '--title', '--objective', '--rationale', '--kind', '--source', '--after-json', '--directive-json', '--directive-file', '--idempotency-key', '--quality-gate-json']);
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

function normalizeCodexGoalMode(raw: string | undefined): 'aggregate' | 'per_story' | undefined {
  if (!raw) return undefined;
  if (raw === 'aggregate') return 'aggregate';
  if (raw === 'per-story' || raw === 'per_story') return 'per_story';
  throw new UltragoalError('Invalid --codex-goal-mode; expected aggregate or per-story.');
}

function printStatus(plan: Awaited<ReturnType<typeof readUltragoalPlan>>): void {
  const summary = summarizeUltragoalPlan(plan);
  if (summary.aggregateComplete) {
    console.log('ultragoal aggregate product: complete');
    console.log(`microgoal ledger bookkeeping (progress-only): ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed, ${summary.reviewBlocked} review-blocked, ${summary.needsUserDecision} needs-user-decision`);
  } else if (summary.artifactComplete) {
    console.log('ultragoal artifact goals: complete');
    console.log(`codex goal reconciliation: not recorded in OMX aggregateCompletion; status is artifact-backed until a fresh Codex goal snapshot is available.`);
    console.log(`microgoal ledger: ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed, ${summary.reviewBlocked} review-blocked, ${summary.needsUserDecision} needs-user-decision`);
  } else {
    console.log(`ultragoal: ${summary.complete}/${summary.total} complete, ${summary.pending} pending, ${summary.inProgress} in progress, ${summary.failed} failed, ${summary.reviewBlocked} review-blocked, ${summary.needsUserDecision} needs-user-decision`);
  }
  for (const goal of plan.goals) {
    const marker = goal.id === plan.activeGoalId ? '*' : '-';
    console.log(`${marker} ${goal.id} [${goal.status}] ${goal.title}`);
  }
}

function blockedDecisionHandoff(plan: Awaited<ReturnType<typeof readUltragoalPlan>>): string | null {
  const blocked = plan.goals.find((goal) => goal.status === 'needs_user_decision' && goal.nonRetriable);
  if (!blocked) return null;
  return [
    'ultragoal: blocked on repeated external authorization; no retryable failed goals remain.',
    `Goal: ${blocked.id} — ${blocked.title}`,
    `Required external decision: ${blocked.requiredExternalDecision ?? 'provide the missing authorization/credential, or explicitly choose a different unblock path'}.`,
    'Do not run complete-goals --retry-failed again until that external state changes or the user explicitly authorizes an unblock path.',
  ].join('\n');
}

async function parseCodexGoalJson(raw: string | undefined): Promise<unknown> {
  if (!raw) return undefined;
  return readCodexGoalSnapshotInput(raw, process.cwd());
}

async function readJsonInput(raw: string | undefined, label = '--quality-gate-json'): Promise<unknown> {
  if (!raw) return undefined;
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
    return JSON.parse(await readFile(trimmed, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UltragoalError(`Invalid ${label}: ${message}`);
  }
}

const STEERING_KINDS = new Set<UltragoalSteeringMutationKind>(ULTRAGOAL_STEERING_MUTATION_KINDS);
const STEERING_SOURCES = new Set<UltragoalSteeringSource>(ULTRAGOAL_STEERING_SOURCES);

type CliSteerResult = Awaited<ReturnType<typeof steerUltragoal>>;

function parseSteeringKind(raw: string | undefined): UltragoalSteeringMutationKind {
  if (!raw) throw new UltragoalError('Missing --kind for structured ultragoal steer.');
  if (!STEERING_KINDS.has(raw as UltragoalSteeringMutationKind)) throw new UltragoalError(`Invalid --kind: ${raw}. Expected one of ${Array.from(STEERING_KINDS).join(', ')}.`);
  return raw as UltragoalSteeringMutationKind;
}

function parseSteeringSource(raw: string | undefined, fallback: UltragoalSteeringSource = 'cli'): UltragoalSteeringSource {
  if (!raw) return fallback;
  if (!STEERING_SOURCES.has(raw as UltragoalSteeringSource)) throw new UltragoalError(`Invalid --source: ${raw}. Expected one of ${Array.from(STEERING_SOURCES).join(', ')}.`);
  return raw as UltragoalSteeringSource;
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UltragoalError(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function normalizeTargetGoalId(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.targetGoalId === 'string' && raw.targetGoalId.trim()) return raw.targetGoalId.trim();
  if (Array.isArray(raw.targetGoalIds)) return raw.targetGoalIds.find((id): id is string => typeof id === 'string' && id.trim().length > 0)?.trim();
  return undefined;
}

function normalizeSteeringProposal(raw: Record<string, unknown>, _fallbackDirectiveText?: string): UltragoalSteeringProposal {
  const kind = parseSteeringKind(typeof raw.kind === 'string' ? raw.kind : undefined);
  const source = parseSteeringSource(typeof raw.source === 'string' ? raw.source : undefined);
  const after = raw.after && typeof raw.after === 'object' && !Array.isArray(raw.after)
    ? raw.after as UltragoalSteeringAfterPayload
    : undefined;
  return {
    kind,
    source,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
    targetGoalId: normalizeTargetGoalId(raw),
    title: typeof raw.title === 'string' ? raw.title : undefined,
    objective: typeof raw.objective === 'string' ? raw.objective : undefined,
    after,
    pendingOrder: Array.isArray(raw.pendingOrder) ? raw.pendingOrder.filter((id): id is string => typeof id === 'string') : undefined,
    idempotencyKey: typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : undefined,
  };
}

async function parseSteeringProposal(args: readonly string[]): Promise<UltragoalSteeringProposal> {
  const directiveFile = readValue(args, '--directive-file');
  const directiveRaw = readValue(args, '--directive-json') ?? (directiveFile ? await readFile(directiveFile, 'utf-8') : undefined);
  if (directiveRaw) {
    const directive = assertPlainObject(await readJsonInput(directiveRaw, '--directive-json'), '--directive-json');
    return normalizeSteeringProposal(directive, directiveRaw.trim().startsWith('{') ? directiveRaw : undefined);
  }

  const freeform = positionalText(args);
  if (freeform) throw new UltragoalError('omx ultragoal steer rejects broad natural-language mutation requests; pass structured fields or --directive-json.');

  const after = await readJsonInput(readValue(args, '--after-json'), '--after-json');
  return normalizeSteeringProposal({
    kind: readValue(args, '--kind'),
    evidence: readValue(args, '--evidence'),
    rationale: readValue(args, '--rationale'),
    targetGoalId: readValue(args, '--target-goal-id') ?? readValue(args, '--goal-id'),
    title: readValue(args, '--title'),
    objective: readValue(args, '--objective'),
    after,
    idempotencyKey: readValue(args, '--idempotency-key'),
  });
}

function buildSteerDirectiveText(args: readonly string[]): string {
  return args.join(' ');
}

function steeringAudit(proposal: UltragoalSteeringProposal, result: CliSteerResult): Record<string, unknown> {
  return {
    kind: result.audit.kind,
    source: result.audit.source,
    targetGoalId: proposal.targetGoalId,
    targetGoalIds: result.audit.targetGoalIds,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    idempotencyKey: proposal.idempotencyKey,
    accepted: result.accepted,
    rejectedReasons: result.rejectedReasons ?? [],
    deduped: Boolean(result.deduped),
  };
}

function printSteerResult(proposal: UltragoalSteeringProposal, result: CliSteerResult, json: boolean): void {
  const audit = steeringAudit(proposal, result);
  if (json) {
    printJson({
      ok: result.accepted,
      accepted: result.accepted,
      rejectedReasons: result.rejectedReasons ?? [],
      deduped: Boolean(result.deduped),
      audit,
      summary: summarizeUltragoalPlan(result.plan),
      planSummary: summarizeUltragoalPlan(result.plan),
      plan: result.plan,
    });
    return;
  }
  const outcome = result.deduped ? 'deduped' : result.accepted ? 'accepted' : 'rejected';
  console.log(`ultragoal steer: ${outcome} ${proposal.kind}`);
  if (result.rejectedReasons?.length) console.log(`rejected: ${result.rejectedReasons.join('; ')}`);
  if (proposal.idempotencyKey) console.log(`idempotency-key: ${proposal.idempotencyKey}`);
  printStatus(result.plan);
}

const ULTRAGOAL_MUTATING_COMMANDS = new Set([
  'create',
  'create-goals',
  'add-goal',
  'steer',
  'record-review-blockers',
  'complete',
  'complete-goals',
  'next',
  'start-next',
  'checkpoint',
]);

function readTeamWorkerIdentity(env: NodeJS.ProcessEnv = process.env): string | null {
  const publicIdentity = typeof env.OMX_TEAM_WORKER === 'string' ? env.OMX_TEAM_WORKER.trim() : '';
  if (publicIdentity) return publicIdentity;
  const internalIdentity = typeof env.OMX_TEAM_INTERNAL_WORKER === 'string' ? env.OMX_TEAM_INTERNAL_WORKER.trim() : '';
  return internalIdentity || null;
}

function assertUltragoalMutationAllowedFromCurrentProcess(command: string): void {
  if (!ULTRAGOAL_MUTATING_COMMANDS.has(command)) return;
  const workerIdentity = readTeamWorkerIdentity();
  if (!workerIdentity) return;
  throw new UltragoalError(
    `Refusing mutating ultragoal command "${command}" from Team worker ${workerIdentity}. `
    + 'Ultragoal state is leader-owned; workers must report checkpoint evidence upward instead of mutating .omx/ultragoal.',
  );
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

    assertUltragoalMutationAllowedFromCurrentProcess(command);

    if (command === 'create' || command === 'create-goals') {
      const briefFile = readValue(rest, '--brief-file');
      const brief = readValue(rest, '--brief')
        ?? (briefFile ? await readFile(briefFile, 'utf-8') : undefined)
        ?? (hasFlag(rest, '--from-stdin') ? await readStdin() : undefined)
        ?? positionalText(rest);
      if (!brief.trim()) throw new UltragoalError('Missing brief text. Pass --brief, --brief-file, --from-stdin, or positional text.');
      const goals = readRepeated(rest, '--goal').map(parseGoalArg);
      const plan = await createUltragoalPlan(cwd, {
        brief,
        goals,
        codexGoalMode: normalizeCodexGoalMode(readValue(rest, '--codex-goal-mode')),
        force: hasFlag(rest, '--force'),
      });
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
      const expectedObjective = plan.codexGoalMode === 'aggregate'
        ? plan.codexObjective
        : activeGoal?.objective;
      const reconciliation = activeGoal || snapshot
        ? reconcileCodexGoalSnapshot(snapshot, {
          expectedObjective: expectedObjective ?? plan.codexObjective ?? '',
          acceptedObjectives: plan.codexGoalMode === 'aggregate' ? plan.codexObjectiveAliases : undefined,
          allowedStatuses: activeGoal && plan.codexGoalMode === 'aggregate' ? ['active'] : ['active', 'complete'],
          requireSnapshot: false,
        })
        : null;
      const codexGoalFallback = reconciliation?.snapshot.unavailableReason === 'db_schema_context_error'
        ? {
          status: 'codex_goal_reconciliation_unavailable',
          reason: reconciliation.snapshot.unavailableReason,
          message: 'Codex goal DB/schema/context is unavailable; artifact-backed Ultragoal status remains available, but strict Codex goal completion reconciliation is deferred.',
        }
        : undefined;
      if (json) printJson({ plan, summary: summarizeUltragoalPlan(plan), reconciliation, codexGoalFallback });
      else {
        printStatus(plan);
        if (codexGoalFallback) console.log(`codex goal fallback: ${codexGoalFallback.message}`);
        if (reconciliation && !reconciliation.ok) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
        else if (reconciliation?.warnings.length) console.log(`codex goal warning: ${formatCodexGoalReconciliation(reconciliation)}`);
      }
      return;
    }

    if (command === 'add-goal') {
      const title = readValue(rest, '--title');
      const objective = readValue(rest, '--objective');
      if (!title?.trim()) throw new UltragoalError('Missing --title.');
      if (!objective?.trim()) throw new UltragoalError('Missing --objective.');
      const result = await addUltragoalGoal(cwd, { title, objective, evidence: readValue(rest, '--evidence') });
      if (json) printJson({ ok: true, plan: result.plan, addedGoal: result.goal, summary: summarizeUltragoalPlan(result.plan) });
      else {
        console.log(`ultragoal added goal: ${result.goal.id}`);
        printStatus(result.plan);
      }
      return;
    }

    if (command === 'steer') {
      const proposalText = readValue(rest, '--proposal');
      const source = readValue(rest, '--source');
      if (proposalText) {
        const parsed = assertPlainObject(await readJsonInput(proposalText, '--proposal'), '--proposal');
        const proposal = normalizeSteeringProposal({ ...parsed, source: source ?? parsed.source }, proposalText);
        const result = await steerUltragoal(cwd, proposal, { directiveText: proposalText });
        printSteerResult(proposal, result, json);
        if (!result.accepted) process.exitCode = 1;
        return;
      }
      const proposal = await parseSteeringProposal(rest);
      if (!proposal.evidence?.trim?.()) throw new UltragoalError('Missing --evidence.');
      if (!proposal.rationale?.trim?.()) throw new UltragoalError('Missing --rationale.');
      proposal.source = parseSteeringSource(source, proposal.source);
      const result = await steerUltragoal(cwd, proposal, { directiveText: buildSteerDirectiveText(rest) });
      printSteerResult(proposal, result, json);
      if (!result.accepted) process.exitCode = 1;
      return;
    }

    if (command === 'record-review-blockers') {
      const goalId = readValue(rest, '--goal-id');
      const title = readValue(rest, '--title');
      const objective = readValue(rest, '--objective');
      const evidence = readValue(rest, '--evidence');
      if (!goalId) throw new UltragoalError('Missing --goal-id.');
      if (!title?.trim()) throw new UltragoalError('Missing --title.');
      if (!objective?.trim()) throw new UltragoalError('Missing --objective.');
      if (!evidence?.trim()) throw new UltragoalError('Missing --evidence.');
      const codexGoal = await parseCodexGoalJson(readValue(rest, '--codex-goal-json'));
      const result = await recordFinalReviewBlockers(cwd, { goalId, title, objective, evidence, codexGoal });
      if (json) printJson({ ok: true, plan: result.plan, blockedGoal: result.blockedGoal, addedGoal: result.addedGoal, summary: summarizeUltragoalPlan(result.plan) });
      else {
        console.log(`ultragoal final review blockers recorded: ${result.blockedGoal.id} -> review_blocked; added ${result.addedGoal.id}`);
        printStatus(result.plan);
      }
      return;
    }

    if (command === 'complete' || command === 'complete-goals' || command === 'next' || command === 'start-next') {
      const result = await startNextUltragoal(cwd, { retryFailed: hasFlag(rest, '--retry-failed') });
      if (!result.goal) {
        const handoff = blockedDecisionHandoff(result.plan);
        if (json) {
          printJson({
            ok: true,
            done: result.done,
            blocked: Boolean(handoff),
            handoff,
            blockedGoals: result.plan.goals.filter((goal) => goal.status === 'needs_user_decision'),
            summary: summarizeUltragoalPlan(result.plan),
          });
        } else console.log(handoff ?? (result.done ? 'ultragoal: all goals complete' : 'ultragoal: no pending goals (use --retry-failed to retry failed goals)'));
        return;
      }
      const instruction = buildCodexGoalInstruction(result.goal, result.plan);
      if (json) printJson({ ok: true, resumed: result.resumed, goal: result.goal, instruction });
      else console.log(instruction);
      return;
    }

    if (command === 'steer') {
      const proposal = await parseSteeringProposal(rest);
      const result = await steerUltragoal(cwd, proposal);
      printSteerResult(proposal, result, json);
      if (!result.accepted) process.exitCode = 1;
      return;
    }

    if (command === 'checkpoint') {
      const goalId = readValue(rest, '--goal-id');
      const status = readValue(rest, '--status');
      if (!goalId) throw new UltragoalError('Missing --goal-id.');
      if (status !== 'complete' && status !== 'failed' && status !== 'blocked') throw new UltragoalError('Missing or invalid --status; expected complete, failed, or blocked.');
      const evidence = readValue(rest, '--evidence');
      const codexGoal = await parseCodexGoalJson(readValue(rest, '--codex-goal-json'));
      const qualityGate = await readJsonInput(readValue(rest, '--quality-gate-json'));
      const plan = await checkpointUltragoal(cwd, { goalId, status, evidence, codexGoal, qualityGate });
      if (json) printJson({ ok: true, plan, summary: summarizeUltragoalPlan(plan) });
      else {
        const goal = plan.goals.find((candidate: UltragoalItem) => candidate.id === goalId);
        console.log(`ultragoal checkpoint: ${goalId} -> ${goal?.status ?? status}`);
        printStatus(plan);
        const summary = summarizeUltragoalPlan(plan);
        if (status === 'complete' && (summary.aggregateComplete || summary.artifactComplete)) {
          console.log(buildCodexGoalTerminalCleanupNotice('Ultragoal completion'));
        }
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
