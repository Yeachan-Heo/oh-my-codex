import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

type Hint = { id: string; task: string; command: string };
type PathState = 'missing' | 'parseable' | 'malformed';
type SessionVisibility = 'active' | 'inactive' | 'malformed' | 'missing';
type RootVisibility = 'active' | 'inactive' | 'malformed' | 'missing';
type TeamFollowupState = {
  task_description?: string;
  agent_count?: number;
};

const MODEL_DOC = readFileSync(
  new URL('../../../docs/reference/launch-lifecycle-model.md', import.meta.url),
  'utf8',
);

function planningCompleteBaseline(prdCount: number, testSpecCount: number): boolean {
  return prdCount > 0 && testSpecCount > 0;
}

function artifactSlug(path: string, prefixPattern: RegExp): string | null {
  const file = path.split('/').pop() ?? path;
  const match = file.match(prefixPattern);
  return match?.groups?.slug ?? null;
}

function latestPlanningSelectionBaseline(
  prds: readonly string[],
  testSpecs: readonly string[],
): { prd: string | null; testSpecs: string[] } {
  const prd = prds.length > 0 ? prds[prdCountLastIndex(prds)] : null;
  const slug = prd ? artifactSlug(prd, /^prd-(?<slug>.*)\.md$/i) : null;
  return {
    prd,
    testSpecs: slug
      ? testSpecs.filter((path) => artifactSlug(path, /^test-?spec-(?<slug>.*)\.md$/i) === slug)
      : [],
  };
}

function prdCountLastIndex<T>(items: readonly T[]): number {
  return items.length - 1;
}

function projectBaselineHint<T>(hints: readonly T[]): T | null {
  return hints.length > 0 ? hints[hints.length - 1]! : null;
}

function readModeStateBaseline(paths: readonly PathState[]): 'state' | null {
  for (const path of paths) {
    if (path === 'missing') {
      continue;
    }
    if (path === 'parseable') {
      return 'state';
    }
    if (path === 'malformed') {
      return null;
    }
  }
  return null;
}

function resolveShortTeamFollowupBaseline(
  shortFollowup: boolean,
  approvedHint: Hint | null,
  rootState: TeamFollowupState | null,
): { task: string; workerCount: number } | null {
  if (!shortFollowup || !approvedHint) {
    return null;
  }
  if (
    rootState
    && rootState.task_description === approvedHint.task
    && typeof rootState.agent_count === 'number'
  ) {
    return {
      task: rootState.task_description,
      workerCount: rootState.agent_count,
    };
  }
  return {
    task: approvedHint.task,
    workerCount: 3,
  };
}

function launchRalphBaseline(input: 'help' | 'invalid-prd-gate' | 'runnable'): string[] {
  if (input === 'help') {
    return ['help'];
  }
  if (input === 'invalid-prd-gate') {
    return ['idle', 'invalid-prd-gate'];
  }
  return ['idle', 'artifacts-ready', 'mode-started', 'session-files-written', 'mode-updated(starting)', 'hud-launched'];
}

function launchTeamBaseline(command: 'api' | 'status' | 'await' | 'resume' | 'shutdown' | 'launch'): string[] {
  switch (command) {
    case 'launch':
      return ['parsed', 'execution-planned', 'runtime-started', 'mode-state-synced', 'summary-rendered'];
    case 'resume':
      return ['runtime-resumed', 'mode-state-synced', 'summary-rendered'];
    default:
      return [command];
  }
}

function* lcg(seed: number): Generator<number> {
  let state = seed >>> 0;
  while (true) {
    state = (1664525 * state + 1013904223) >>> 0;
    yield state;
  }
}

describe('launch-lifecycle-model reference', () => {
  it('documents the baseline projection operators used by this executable model', () => {
    assert.match(MODEL_DOC, /PlanningComplete_B/);
    assert.match(MODEL_DOC, /LatestPlanningSelection_B/);
    assert.match(MODEL_DOC, /Proj_B_Hint/);
    assert.match(MODEL_DOC, /ReadModeState_B/);
    assert.match(MODEL_DOC, /ResolveShortTeamFollowup_B/);
    assert.match(MODEL_DOC, /LaunchRalph_B/);
    assert.match(MODEL_DOC, /LaunchTeamCLI_B/);
  });

  it('exhaustively model-checks baseline planning completeness over the finite artifact-count domain', () => {
    for (let prdCount = 0; prdCount <= 3; prdCount += 1) {
      for (let testSpecCount = 0; testSpecCount <= 3; testSpecCount += 1) {
        assert.equal(
          planningCompleteBaseline(prdCount, testSpecCount),
          prdCount > 0 && testSpecCount > 0,
          `unexpected baseline planning completeness for prdCount=${prdCount}, testSpecCount=${testSpecCount}`,
        );
      }
    }
  });

  it('exhaustively model-checks latest-planning selection and hint collapse semantics', () => {
    const hints: Hint[] = [
      { id: 'a', task: 'task-a', command: 'omx ralph "task-a"' },
      { id: 'b', task: 'task-b', command: 'omx ralph "task-b"' },
      { id: 'c', task: 'task-c', command: 'omx ralph "task-c"' },
    ];
    const prdPaths = [
      '/repo/.omx/plans/prd-alpha.md',
      '/repo/.omx/plans/prd-beta.md',
      '/repo/.omx/plans/prd-gamma.md',
    ];
    const testSpecPaths = [
      '/repo/.omx/plans/test-spec-alpha.md',
      '/repo/.omx/plans/test-spec-beta.md',
      '/repo/.omx/plans/test-spec-delta.md',
    ];

    for (let prdCount = 0; prdCount <= prdPaths.length; prdCount += 1) {
      const prds = prdPaths.slice(0, prdCount);
      const selection = latestPlanningSelectionBaseline(prds, testSpecPaths);
      assert.equal(selection.prd, prdCount === 0 ? null : prds[prdCount - 1]);
      const expectedSlug = selection.prd ? artifactSlug(selection.prd, /^prd-(?<slug>.*)\.md$/i) : null;
      const expectedSpecs = expectedSlug
        ? testSpecPaths.filter((path) => artifactSlug(path, /^test-?spec-(?<slug>.*)\.md$/i) === expectedSlug)
        : [];
      assert.deepEqual(selection.testSpecs, expectedSpecs);
    }

    for (let hintCount = 0; hintCount <= hints.length; hintCount += 1) {
      const selected = projectBaselineHint(hints.slice(0, hintCount));
      assert.equal(selected, hintCount === 0 ? null : hints[hintCount - 1]);
    }
  });

  it('exhaustively model-checks that malformed higher-precedence scoped state masks lower fallback in the committed baseline', () => {
    const states: PathState[] = ['missing', 'parseable', 'malformed'];
    for (const first of states) {
      for (const second of states) {
        const actual = readModeStateBaseline([first, second]);
        if (first === 'parseable') {
          assert.equal(actual, 'state');
          continue;
        }
        if (first === 'malformed') {
          assert.equal(actual, null);
          continue;
        }
        if (second === 'parseable') {
          assert.equal(actual, 'state');
        } else {
          assert.equal(actual, null);
        }
      }
    }
  });

  it('property-checks that committed short team follow-up resolution depends only on root state, not session state', () => {
    const approvedHint: Hint = {
      id: 'approved',
      task: 'ship feature',
      command: 'omx team 3:executor "ship feature"',
    };
    const sessionStates: SessionVisibility[] = ['active', 'inactive', 'malformed', 'missing'];
    const rootStates: RootVisibility[] = ['active', 'inactive', 'malformed', 'missing'];
    const rootPayloads: Record<RootVisibility, TeamFollowupState | null> = {
      active: { task_description: 'ship feature', agent_count: 5 },
      inactive: { task_description: 'other task', agent_count: 2 },
      malformed: null,
      missing: null,
    };

    for (const session of sessionStates) {
      for (const root of rootStates) {
        const resolved = resolveShortTeamFollowupBaseline(true, approvedHint, rootPayloads[root]);
        if (root === 'active') {
          assert.deepEqual(resolved, { task: 'ship feature', workerCount: 5 });
        } else {
          assert.deepEqual(resolved, { task: 'ship feature', workerCount: 3 }, `session=${session} root=${root}`);
        }
      }
    }
  });

  it('model-checks the baseline Ralph and Team transition graphs for totality and order', () => {
    assert.deepEqual(launchRalphBaseline('help'), ['help']);
    assert.deepEqual(launchRalphBaseline('invalid-prd-gate'), ['idle', 'invalid-prd-gate']);
    assert.deepEqual(
      launchRalphBaseline('runnable'),
      ['idle', 'artifacts-ready', 'mode-started', 'session-files-written', 'mode-updated(starting)', 'hud-launched'],
    );

    assert.deepEqual(launchTeamBaseline('launch'), ['parsed', 'execution-planned', 'runtime-started', 'mode-state-synced', 'summary-rendered']);
    assert.deepEqual(launchTeamBaseline('resume'), ['runtime-resumed', 'mode-state-synced', 'summary-rendered']);
    assert.deepEqual(launchTeamBaseline('status'), ['status']);
  });

  it('property-checks baseline last-hint collapse over generated hint sequences', () => {
    const random = lcg(0x22f1656c);
    for (let caseIndex = 0; caseIndex < 64; caseIndex += 1) {
      const hintCount = (random.next().value as number) % 6;
      const generatedHints: Hint[] = Array.from({ length: hintCount }, (_, index) => ({
        id: `hint-${caseIndex}-${index}`,
        task: `task-${(random.next().value as number) % 7}`,
        command: `omx ralph ${JSON.stringify(`task-${index}`)}`,
      }));
      const selected = projectBaselineHint(generatedHints);
      assert.equal(selected, hintCount === 0 ? null : generatedHints[hintCount - 1]);
    }
  });
});
