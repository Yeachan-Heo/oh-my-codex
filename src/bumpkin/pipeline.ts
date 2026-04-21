import {
  advance,
  createInitialState,
  isTerminal,
  type UpgradePhase,
  type UpgradeState,
} from './phase-controller.js';
import type { Gate, GateContext } from './gates/types.js';
import type { ModelProvider } from './model/provider.js';
import { planUpgrades, type DependencyRecord, type UpgradeTarget } from './skills/upgrade-planner.js';
import { proposeMechanicalFix, type FailingTest, type LibraryApiDelta } from './skills/mechanical-fixer.js';
import { reviewFix } from './skills/llm-reviewer.js';
import { checkBlastRadius } from './safety/blast-radius.js';
import { checkCategory } from './safety/category-check.js';
import { routeModel, type RouterConfig, type ModelTier } from './model/router.js';
import { type UpgradeRunResult } from './github/pr-opener.js';

export interface PipelineDeps {
  planner: ModelProvider;
  fixer: ModelProvider;
  reviewer: ModelProvider;
  router: RouterConfig;
  gates: ReadonlyArray<Gate>;
  applyUpgrade: (target: UpgradeTarget) => Promise<void>;
  applyFixDiff: (diff: string) => Promise<void>;
  gateContext: GateContext;
  libraryApiDelta: (target: UpgradeTarget) => Promise<LibraryApiDelta>;
  failingTestForGate: (phase: UpgradePhase, gateArtifacts: Record<string, unknown> | undefined) => FailingTest;
  sourceSnippet: (target: UpgradeTarget) => Promise<string>;
  releaseNotes: (target: UpgradeTarget) => Promise<string>;
  expectedSurface: readonly string[];
  diffPaths: () => readonly string[];
  diffLineCount: () => number;
  diffContent?: () => string;
  now?: () => string;
  maxFixAttempts?: number;
}

export interface PipelineInput {
  dependencies: readonly DependencyRecord[];
  repoContext?: string;
}

const GATE_PHASE_ORDER: readonly UpgradePhase[] = [
  'verify-tests',
  'verify-types',
  'verify-build',
  'verify-lint',
  'verify-preview',
  'verify-apisurface',
  'verify-bundle-size',
];

export async function runUpgradePipeline(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<UpgradeRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  let state: UpgradeState = createInitialState({
    maxFixAttempts: deps.maxFixAttempts ?? 3,
    now,
  });

  const gateOutcomes: Array<{ gate: string; pass: boolean; reason: string }> = [];
  const spend: Array<{ tier: ModelTier; tokens: number }> = [];
  let lastReviewerVerdict: 'APPROVE' | 'REJECT' | undefined;
  let lastReviewerRationale: string | undefined;

  const recordSpend = async <T>(
    provider: ModelProvider,
    role: Parameters<typeof routeModel>[0]['role'],
    failureCount: number,
    op: () => Promise<T>,
  ): Promise<T> => {
    const route = routeModel({ role, failureCount }, deps.router);
    const result = await op();
    spend.push({ tier: route.tier, tokens: estimateTokensUsed() });
    return result;
  };

  const plan = await recordSpend(deps.planner, 'upgrade-planner', 0, () =>
    planUpgrades(deps.planner, { dependencies: input.dependencies, repoContext: input.repoContext }),
  );
  if (plan.order.length === 0) throw new Error('planner returned empty order');
  const target = plan.order[0];
  if (!target) throw new Error('planner returned no target');

  state = advance(state, { kind: 'phase-done' }, { now });
  state = advance(state, { kind: 'phase-done' }, { now });

  await deps.applyUpgrade(target);
  state = advance(state, { kind: 'phase-done' }, { now });

  const gateByPhase = new Map<UpgradePhase, Gate>();
  for (let i = 0; i < GATE_PHASE_ORDER.length && i < deps.gates.length; i += 1) {
    const phase = GATE_PHASE_ORDER[i];
    const gate = deps.gates[i];
    if (phase && gate) gateByPhase.set(phase, gate);
  }

  while (!isTerminal(state.phase)) {
    const phase = state.phase;

    if (gateByPhase.has(phase)) {
      const gate = gateByPhase.get(phase);
      if (!gate) throw new Error(`no gate for phase ${phase}`);
      const verdict = await gate.run(deps.gateContext);
      gateOutcomes.push({ gate: gate.name, pass: verdict.pass, reason: verdict.reason });
      if (verdict.pass) {
        state = advance(state, { kind: 'gate-pass' }, { now });
      } else {
        state = advance(state, { kind: 'gate-fail', reason: verdict.reason }, { now });
      }
      continue;
    }

    if (phase === 'fix') {
      if (!state.failedGate) throw new Error('in fix phase with no failedGate');
      const delta = await deps.libraryApiDelta(target);
      const failingTest = deps.failingTestForGate(state.failedGate, undefined);
      const snippet = await deps.sourceSnippet(target);
      const proposal = await recordSpend(deps.fixer, 'breakage-fixer-mechanical', state.fixAttempts, () =>
        proposeMechanicalFix(deps.fixer, {
          failingTest,
          libraryApiDelta: delta,
          sourceSnippet: snippet,
        }),
      );
      try {
        await deps.applyFixDiff(proposal.diff);
        state = advance(state, { kind: 'fix-success' }, { now });
      } catch {
        state = advance(state, { kind: 'fix-fail' }, { now });
      }
      continue;
    }

    if (phase === 'llm-review') {
      const delta = await deps.libraryApiDelta(target);
      const notes = await deps.releaseNotes(target);
      const failingTest = deps.failingTestForGate('verify-tests', undefined);
      const review = await recordSpend(deps.reviewer, 'llm-reviewer', 0, () =>
        reviewFix(deps.reviewer, {
          diff: 'see-workspace',
          failingTestOutput: failingTest.output,
          releaseNotes: notes,
          libraryName: delta.libraryName,
          fromVersion: delta.fromVersion,
          toVersion: delta.toVersion,
        }),
      );
      lastReviewerVerdict = review.verdict;
      lastReviewerRationale = review.rationale;
      if (review.verdict === 'APPROVE') {
        state = advance(state, { kind: 'gate-pass' }, { now });
      } else {
        state = advance(state, { kind: 'review-reject', reason: review.rationale }, { now });
      }
      continue;
    }

    if (phase === 'blast-radius-check') {
      const verdict = checkBlastRadius({
        expectedSurface: deps.expectedSurface,
        diffPaths: deps.diffPaths(),
        diffLineCount: deps.diffLineCount(),
      });
      gateOutcomes.push({ gate: 'blast-radius-check', pass: verdict.pass, reason: verdict.reason });
      if (verdict.pass) {
        state = advance(state, { kind: 'gate-pass' }, { now });
      } else {
        state = advance(state, { kind: 'gate-fail', reason: verdict.reason }, { now });
      }
      continue;
    }

    if (phase === 'category-check') {
      const verdict = checkCategory({
        diffPaths: deps.diffPaths(),
        diffContent: deps.diffContent?.(),
      });
      gateOutcomes.push({ gate: 'category-check', pass: verdict.pass, reason: verdict.reason });
      if (verdict.pass) {
        state = advance(state, { kind: 'gate-pass' }, { now });
      } else {
        state = advance(state, { kind: 'gate-fail', reason: verdict.reason }, { now });
      }
      continue;
    }

    throw new Error(`unexpected phase ${phase}`);
  }

  const safetyCriticalMatches = checkCategory({
    diffPaths: deps.diffPaths(),
    diffContent: deps.diffContent?.(),
  });

  const terminal = state.phase;
  const status: UpgradeRunResult['status'] =
    terminal === 'ship' ? 'ready-to-ship' : terminal === 'escalated' ? 'escalated' : 'failed';

  return {
    target,
    status,
    transitions: state.transitions,
    gateOutcomes,
    reviewerVerdict: lastReviewerVerdict,
    reviewerRationale: lastReviewerRationale,
    escalationReason: state.escalationReason ?? undefined,
    tokenSpend: aggregateSpend(spend),
    diffStats: { files: deps.diffPaths().length, lines: deps.diffLineCount() },
    safetyCriticalPathsTouched: safetyCriticalMatches.matchedPaths,
  };
}

function estimateTokensUsed(): number {
  return 500;
}

function aggregateSpend(entries: ReadonlyArray<{ tier: ModelTier; tokens: number }>): {
  ossTokens: number;
  frontierTokens: number;
} {
  let oss = 0;
  let frontier = 0;
  for (const e of entries) {
    if (e.tier === 'oss') oss += e.tokens;
    else frontier += e.tokens;
  }
  return { ossTokens: oss, frontierTokens: frontier };
}
