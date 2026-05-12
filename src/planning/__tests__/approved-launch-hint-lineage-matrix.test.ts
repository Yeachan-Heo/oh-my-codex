import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readApprovedExecutionLaunchHint,
  readApprovedExecutionLaunchHintOutcome,
} from '../artifacts.js';

type RalphPlanState = 'none' | 'hidden' | 'ready' | 'nonready' | 'ambiguous';
type RalphQueryKind = 'bare' | 'task' | 'command';
type TeamSignature = 'A' | 'B';
type TeamQueryKind =
  | 'bare'
  | 'task'
  | 'bareSignatureA'
  | 'bareSignatureB'
  | 'taskSignatureA'
  | 'taskSignatureB'
  | 'commandA'
  | 'commandB';
type TeamPlanState =
  | 'none'
  | 'hiddenA'
  | 'readyA'
  | 'nonreadyA'
  | 'readyB'
  | 'nonreadyB'
  | 'readyAB'
  | 'nonreadyAB'
  | 'readyAA'
  | 'nonreadyAA';

interface HintModel {
  command: string;
  task: string;
  ready: boolean;
  signature?: TeamSignature;
}

interface QueryModel {
  task?: string;
  command?: string;
  signature?: TeamSignature;
}

interface ExpectedSelection {
  status: 'absent' | 'ambiguous' | 'resolved';
  stem?: string;
  hint?: HintModel;
}

type HintSelection =
  | { status: 'no-match' }
  | { status: 'ambiguous' }
  | { status: 'unique'; hint: HintModel };

const STEMS = ['alpha', 'beta', 'gamma', 'zeta'] as const;
const RALPH_SHARED_TASK = 'Execute shared Ralph lineage matrix handoff';
const RALPH_COMMAND = `omx ralph ${JSON.stringify(RALPH_SHARED_TASK)}`;
const RALPH_DUPLICATE_COMMAND = `$ralph ${JSON.stringify(RALPH_SHARED_TASK)}`;
const TEAM_SHARED_TASK = 'Execute shared Team lineage matrix handoff';
const TEAM_COMMANDS = {
  A: `omx team 3:executor ${JSON.stringify(TEAM_SHARED_TASK)}`,
  ADuplicate: `$team 3:executor ${JSON.stringify(TEAM_SHARED_TASK)}`,
  B: `$team ralph 5:debugger ${JSON.stringify(TEAM_SHARED_TASK)}`,
} as const;
const RALPH_PLAN_STATES: readonly RalphPlanState[] = [
  'none',
  'hidden',
  'ready',
  'nonready',
  'ambiguous',
] as const;
const TEAM_PLAN_STATES: readonly TeamPlanState[] = [
  'none',
  'hiddenA',
  'readyA',
  'nonreadyA',
  'readyB',
  'nonreadyB',
  'readyAB',
  'nonreadyAB',
  'readyAA',
  'nonreadyAA',
] as const;
const RALPH_QUERY_KINDS: readonly RalphQueryKind[] = ['bare', 'task', 'command'] as const;
const TEAM_QUERY_KINDS: readonly TeamQueryKind[] = [
  'bare',
  'task',
  'bareSignatureA',
  'bareSignatureB',
  'taskSignatureA',
  'taskSignatureB',
  'commandA',
  'commandB',
] as const;

let tempDir = '';

function planPath(cwd: string, stem: string): string {
  return join(cwd, '.omx', 'plans', `prd-${stem}.md`);
}

function createDeterministicRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1_664_525) + 1_013_904_223;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function pickRandom<T>(nextRandom: () => number, values: readonly T[]): T {
  const index = Math.floor(nextRandom() * values.length);
  return values[index]!;
}

function ralphVisibleHints(state: RalphPlanState): HintModel[] {
  switch (state) {
    case 'none':
    case 'hidden':
      return [];
    case 'ready':
      return [{ command: RALPH_COMMAND, task: RALPH_SHARED_TASK, ready: true }];
    case 'nonready':
      return [{ command: RALPH_COMMAND, task: RALPH_SHARED_TASK, ready: false }];
    case 'ambiguous':
      return [
        { command: RALPH_COMMAND, task: RALPH_SHARED_TASK, ready: true },
        { command: RALPH_DUPLICATE_COMMAND, task: RALPH_SHARED_TASK, ready: true },
      ];
  }
}

function teamVisibleHints(state: TeamPlanState): HintModel[] {
  switch (state) {
    case 'none':
    case 'hiddenA':
      return [];
    case 'readyA':
      return [{ command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: true, signature: 'A' }];
    case 'nonreadyA':
      return [{ command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: false, signature: 'A' }];
    case 'readyB':
      return [{ command: TEAM_COMMANDS.B, task: TEAM_SHARED_TASK, ready: true, signature: 'B' }];
    case 'nonreadyB':
      return [{ command: TEAM_COMMANDS.B, task: TEAM_SHARED_TASK, ready: false, signature: 'B' }];
    case 'readyAB':
      return [
        { command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: true, signature: 'A' },
        { command: TEAM_COMMANDS.B, task: TEAM_SHARED_TASK, ready: true, signature: 'B' },
      ];
    case 'nonreadyAB':
      return [
        { command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: false, signature: 'A' },
        { command: TEAM_COMMANDS.B, task: TEAM_SHARED_TASK, ready: false, signature: 'B' },
      ];
    case 'readyAA':
      return [
        { command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: true, signature: 'A' },
        { command: TEAM_COMMANDS.ADuplicate, task: TEAM_SHARED_TASK, ready: true, signature: 'A' },
      ];
    case 'nonreadyAA':
      return [
        { command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: false, signature: 'A' },
        { command: TEAM_COMMANDS.ADuplicate, task: TEAM_SHARED_TASK, ready: false, signature: 'A' },
      ];
  }
}

function selectUniqueHint(
  visibleHints: readonly HintModel[],
  query: QueryModel,
  signatureFilter?: TeamSignature,
): HintSelection {
  const matches = visibleHints.filter((hint) => {
    if (query.command) {
      return hint.command === query.command;
    }
    if (query.task && hint.task.trim() !== query.task.trim()) {
      return false;
    }
    if (signatureFilter && hint.signature !== signatureFilter) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) {
    return { status: 'no-match' };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous' };
  }
  return { status: 'unique', hint: matches[0]! };
}

function reusableRalphHints(state: RalphPlanState): HintModel[] {
  return ralphVisibleHints(state).filter((hint) => hint.ready);
}

function resolveExpectedRalphSelection(
  stems: readonly string[],
  states: readonly RalphPlanState[],
  query: QueryModel,
): ExpectedSelection {
  if (!query.task && !query.command) {
    const latestIndex = states.length - 1;
    const latestSelection = selectUniqueHint(reusableRalphHints(states[latestIndex]!), query);
    if (latestSelection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    return latestSelection.status === 'unique'
      ? { status: 'resolved', stem: stems[latestIndex]!, hint: latestSelection.hint }
      : { status: 'absent' };
  }

  for (let index = states.length - 1; index >= 0; index -= 1) {
    const selection = selectUniqueHint(reusableRalphHints(states[index]!), query);
    if (selection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (selection.status === 'unique') {
      return { status: 'resolved', stem: stems[index]!, hint: selection.hint };
    }
  }

  return { status: 'absent' };
}

function reusableTeamHints(state: TeamPlanState): HintModel[] {
  return teamVisibleHints(state).filter((hint) => hint.ready);
}

function resolveExpectedTeamSelection(
  stems: readonly string[],
  states: readonly TeamPlanState[],
  query: QueryModel,
): ExpectedSelection {
  const requestedSignature = query.command ? undefined : query.signature;

  if (!query.task && !query.command) {
    const latestIndex = states.length - 1;
    const latestSelection = selectUniqueHint(
      reusableTeamHints(states[latestIndex]!),
      query,
      requestedSignature,
    );
    if (latestSelection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    return latestSelection.status === 'unique'
      ? { status: 'resolved', stem: stems[latestIndex]!, hint: latestSelection.hint }
      : { status: 'absent' };
  }

  let lineageSignature: TeamSignature | null = null;
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const selection = selectUniqueHint(
      reusableTeamHints(states[index]!),
      query,
      requestedSignature ?? (
        query.task && !query.command
          ? lineageSignature ?? undefined
          : undefined
      ),
    );
    if (selection.status === 'ambiguous') {
      return { status: 'ambiguous' };
    }
    if (selection.status !== 'unique') {
      continue;
    }
    if (query.task && !query.command) {
      lineageSignature ??= selection.hint.signature ?? null;
    }
    return { status: 'resolved', stem: stems[index]!, hint: selection.hint };
  }

  return { status: 'absent' };
}

function ralphQueryModel(kind: RalphQueryKind): QueryModel {
  switch (kind) {
    case 'bare':
      return {};
    case 'task':
      return { task: RALPH_SHARED_TASK };
    case 'command':
      return { task: RALPH_SHARED_TASK, command: RALPH_COMMAND };
  }
}

function teamQueryModel(kind: TeamQueryKind): QueryModel {
  switch (kind) {
    case 'bare':
      return {};
    case 'task':
      return { task: TEAM_SHARED_TASK };
    case 'bareSignatureA':
      return { signature: 'A' };
    case 'bareSignatureB':
      return { signature: 'B' };
    case 'taskSignatureA':
      return { task: TEAM_SHARED_TASK, signature: 'A' };
    case 'taskSignatureB':
      return { task: TEAM_SHARED_TASK, signature: 'B' };
    case 'commandA':
      return { task: TEAM_SHARED_TASK, command: TEAM_COMMANDS.A };
    case 'commandB':
      return { task: TEAM_SHARED_TASK, command: TEAM_COMMANDS.B };
  }
}

function ralphQueryOptions(
  kind: RalphQueryKind,
): Parameters<typeof readApprovedExecutionLaunchHintOutcome>[2] {
  switch (kind) {
    case 'bare':
      return {};
    case 'task':
      return { task: RALPH_SHARED_TASK };
    case 'command':
      return { task: RALPH_SHARED_TASK, command: RALPH_COMMAND };
  }
}

function teamQueryOptions(
  kind: TeamQueryKind,
): Parameters<typeof readApprovedExecutionLaunchHintOutcome>[2] {
  switch (kind) {
    case 'bare':
      return {};
    case 'task':
      return { task: TEAM_SHARED_TASK };
    case 'bareSignatureA':
      return { workerCount: 3, agentType: 'executor', linkedRalph: false };
    case 'bareSignatureB':
      return { workerCount: 5, agentType: 'debugger', linkedRalph: true };
    case 'taskSignatureA':
      return { task: TEAM_SHARED_TASK, workerCount: 3, agentType: 'executor', linkedRalph: false };
    case 'taskSignatureB':
      return { task: TEAM_SHARED_TASK, workerCount: 5, agentType: 'debugger', linkedRalph: true };
    case 'commandA':
      return { task: TEAM_SHARED_TASK, command: TEAM_COMMANDS.A };
    case 'commandB':
      return { task: TEAM_SHARED_TASK, command: TEAM_COMMANDS.B };
  }
}

async function setup(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'omx-approved-lineage-matrix-'));
}

async function cleanup(): Promise<void> {
  if (tempDir && existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writePlanFiles(
  cwd: string,
  stem: string,
  lines: readonly string[],
  withTestSpec: boolean,
): Promise<void> {
  const plansDir = join(cwd, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  await writeFile(planPath(cwd, stem), `${lines.join('\n')}\n`);
  if (withTestSpec) {
    await writeFile(join(plansDir, `test-spec-${stem}.md`), '# Test Spec\n');
  }
}

async function writeRalphPlanState(
  cwd: string,
  stem: string,
  state: RalphPlanState,
): Promise<void> {
  const lines = ['# PRD', ''];
  switch (state) {
    case 'none':
      lines.push('No matching Ralph launch hint here.');
      break;
    case 'hidden':
      lines.push(`    ${RALPH_COMMAND}`);
      break;
    case 'ready':
      lines.push(`Launch via ${RALPH_COMMAND}`);
      break;
    case 'nonready':
      lines.push(`Launch via ${RALPH_COMMAND}`);
      break;
    case 'ambiguous':
      lines.push(`Launch via ${RALPH_COMMAND}`);
      lines.push(`Launch via ${RALPH_DUPLICATE_COMMAND}`);
      break;
  }
  await writePlanFiles(cwd, stem, lines, state === 'hidden' || state === 'ready' || state === 'ambiguous');
}

async function writeTeamPlanState(
  cwd: string,
  stem: string,
  state: TeamPlanState,
): Promise<void> {
  const lines = ['# PRD', ''];
  switch (state) {
    case 'none':
      lines.push('No matching Team launch hint here.');
      break;
    case 'hiddenA':
      lines.push('```sh');
      lines.push(TEAM_COMMANDS.A);
      lines.push('```');
      break;
    case 'readyA':
    case 'nonreadyA':
      lines.push(`Launch via ${TEAM_COMMANDS.A}`);
      break;
    case 'readyB':
    case 'nonreadyB':
      lines.push(`Launch via ${TEAM_COMMANDS.B}`);
      break;
    case 'readyAB':
    case 'nonreadyAB':
      lines.push(`Launch via ${TEAM_COMMANDS.A}`);
      lines.push(`Launch via ${TEAM_COMMANDS.B}`);
      break;
    case 'readyAA':
    case 'nonreadyAA':
      lines.push(`Launch via ${TEAM_COMMANDS.A}`);
      lines.push(`Launch via ${TEAM_COMMANDS.ADuplicate}`);
      break;
  }
  const withTestSpec = state.startsWith('ready') || state === 'hiddenA';
  await writePlanFiles(cwd, stem, lines, withTestSpec);
}

async function writeRalphScenario(
  cwd: string,
  states: readonly RalphPlanState[],
): Promise<void> {
  await Promise.all(states.map((state, index) => writeRalphPlanState(cwd, STEMS[index]!, state)));
}

async function writeTeamScenario(
  cwd: string,
  states: readonly TeamPlanState[],
): Promise<void> {
  await Promise.all(states.map((state, index) => writeTeamPlanState(cwd, STEMS[index]!, state)));
}

function assertExpectedSelection(
  cwd: string,
  label: string,
  mode: 'team' | 'ralph',
  options: Parameters<typeof readApprovedExecutionLaunchHintOutcome>[2],
  expected: ExpectedSelection,
): void {
  const outcome = readApprovedExecutionLaunchHintOutcome(cwd, mode, options);
  const hint = readApprovedExecutionLaunchHint(cwd, mode, options);

  assert.equal(outcome.status, expected.status, `${label}: unexpected outcome status`);
  if (expected.status !== 'resolved') {
    assert.equal(hint, null, `${label}: reusable hint must fail closed`);
    return;
  }
  if (outcome.status !== 'resolved') {
    throw new Error(`${label}: expected a resolved outcome`);
  }

  assert.equal(
    outcome.hint.sourcePath,
    planPath(cwd, expected.stem!),
    `${label}: unexpected selected PRD`,
  );
  assert.equal(
    outcome.hint.command,
    expected.hint?.command,
    `${label}: unexpected selected command`,
  );
  assert.deepEqual(
    outcome.hint.testSpecPaths.length > 0,
    true,
    `${label}: unexpected baseline readiness`,
  );
  if (mode === 'team') {
    assert.equal(
      outcome.hint.workerCount,
      expected.hint?.signature === 'A' ? 3 : 5,
      `${label}: unexpected worker count`,
    );
    assert.equal(
      outcome.hint.agentType,
      expected.hint?.signature === 'A' ? 'executor' : 'debugger',
      `${label}: unexpected agent type`,
    );
    assert.equal(
      outcome.hint.linkedRalph,
      expected.hint?.signature === 'B',
      `${label}: unexpected linked Ralph flag`,
    );
  }

  if (expected.hint?.ready) {
    assert.ok(hint, `${label}: expected reusable follow-up hint`);
    assert.equal(
      hint?.sourcePath,
      planPath(cwd, expected.stem!),
      `${label}: unexpected reusable hint source`,
    );
  } else {
    assert.equal(hint, null, `${label}: nonready result must stay repair-only`);
  }
}

describe('approved launch hint lineage matrix', () => {
  beforeEach(async () => { await setup(); });
  afterEach(async () => { await cleanup(); });

  it('matches the Ralph oracle across exhaustive two-plan state-machine checks', async () => {
    const stems = STEMS.slice(0, 2);
    for (const queryKind of RALPH_QUERY_KINDS) {
      for (const olderState of RALPH_PLAN_STATES) {
        for (const latestState of RALPH_PLAN_STATES) {
          const cwd = join(tempDir, `ralph-${queryKind}-${olderState}-${latestState}`);
          const states = [olderState, latestState] as const;
          await writeRalphScenario(cwd, states);
          const expected = resolveExpectedRalphSelection(stems, states, ralphQueryModel(queryKind));
          assertExpectedSelection(
            cwd,
            `ralph query=${queryKind} older=${olderState} latest=${latestState}`,
            'ralph',
            ralphQueryOptions(queryKind),
            expected,
          );
        }
      }
    }
  });

  it('matches the Team oracle across exhaustive two-plan state-machine checks', async () => {
    const stems = STEMS.slice(0, 2);
    for (const queryKind of TEAM_QUERY_KINDS) {
      for (const olderState of TEAM_PLAN_STATES) {
        for (const latestState of TEAM_PLAN_STATES) {
          const cwd = join(tempDir, `team-${queryKind}-${olderState}-${latestState}`);
          const states = [olderState, latestState] as const;
          await writeTeamScenario(cwd, states);
          const expected = resolveExpectedTeamSelection(stems, states, teamQueryModel(queryKind));
          assertExpectedSelection(
            cwd,
            `team query=${queryKind} older=${olderState} latest=${latestState}`,
            'team',
            teamQueryOptions(queryKind),
            expected,
          );
        }
      }
    }
  });

  it('matches deterministic multi-plan property checks against the Ralph oracle', async () => {
    const nextRandom = createDeterministicRandom(0x2236);
    for (let index = 0; index < 48; index += 1) {
      const states = STEMS.map(() => pickRandom(nextRandom, RALPH_PLAN_STATES));
      const cwd = join(tempDir, `ralph-random-${index}`);
      await writeRalphScenario(cwd, states);
      for (const queryKind of RALPH_QUERY_KINDS) {
        const expected = resolveExpectedRalphSelection(STEMS, states, ralphQueryModel(queryKind));
        assertExpectedSelection(
          cwd,
          `ralph random=${index} query=${queryKind} states=${states.join(',')}`,
          'ralph',
          ralphQueryOptions(queryKind),
          expected,
        );
      }
    }
  });

  it('matches deterministic multi-plan property checks against the Team oracle', async () => {
    const nextRandom = createDeterministicRandom(0x2241);
    for (let index = 0; index < 48; index += 1) {
      const states = STEMS.map(() => pickRandom(nextRandom, TEAM_PLAN_STATES));
      const cwd = join(tempDir, `team-random-${index}`);
      await writeTeamScenario(cwd, states);
      for (const queryKind of TEAM_QUERY_KINDS) {
        const expected = resolveExpectedTeamSelection(STEMS, states, teamQueryModel(queryKind));
        assertExpectedSelection(
          cwd,
          `team random=${index} query=${queryKind} states=${states.join(',')}`,
          'team',
          teamQueryOptions(queryKind),
          expected,
        );
      }
    }
  });

  it('treats newer no-baseline Ralph siblings as absent for bare lookups', async () => {
    const cwd = join(tempDir, 'ralph-three-plan-skip');
    await writeRalphScenario(cwd, ['ready', 'nonready', 'nonready']);
    assertExpectedSelection(
      cwd,
      'ralph three-plan no-baseline bare',
      'ralph',
      {},
      { status: 'absent' },
    );
  });

  it('counts same-lineage ambiguity only among baseline-ready Team candidates', async () => {
    const cwd = join(tempDir, 'team-three-plan-ambiguous');
    await writeTeamScenario(cwd, ['readyA', 'nonreadyAA', 'nonreadyA']);
    assertExpectedSelection(
      cwd,
      'team three-plan baseline-only ambiguity',
      'team',
      { task: TEAM_SHARED_TASK },
      {
        status: 'resolved',
        stem: 'alpha',
        hint: { command: TEAM_COMMANDS.A, task: TEAM_SHARED_TASK, ready: true, signature: 'A' },
      },
    );
  });

  it('keeps hidden lineage candidates invisible even for exact-command lookups', async () => {
    {
      const cwd = join(tempDir, 'ralph-hidden-command');
      await writeRalphScenario(cwd, ['hidden', 'nonready']);
      assertExpectedSelection(
        cwd,
        'ralph hidden exact command',
        'ralph',
        ralphQueryOptions('command'),
        { status: 'absent' },
      );
    }

    {
      const cwd = join(tempDir, 'team-hidden-command');
      await writeTeamScenario(cwd, ['hiddenA', 'nonreadyA']);
      assertExpectedSelection(
        cwd,
        'team hidden exact command',
        'team',
        teamQueryOptions('commandA'),
        { status: 'absent' },
      );
    }
  });
});
