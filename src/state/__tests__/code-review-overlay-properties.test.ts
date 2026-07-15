import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isTrackedWorkflowMode,
} from '../workflow-transition.js';
import {
  listActiveSkills,
  type SkillActiveEntry,
  type SkillActiveStateLike,
} from '../skill-active.js';

interface OverlayMergeInput {
  authoritativeState: SkillActiveStateLike | null;
  rootState?: SkillActiveStateLike | null;
  overlay: SkillActiveEntry;
  sessionId?: string;
  rootThreadId?: string;
  nowIso: string;
}

type OverlayMerge = (input: OverlayMergeInput) => SkillActiveStateLike;

async function loadOverlayMerge(): Promise<OverlayMerge> {
  const module = await import('../skill-active.js') as unknown as {
    mergeSessionAwareSkillOverlay?: OverlayMerge;
  };
  assert.equal(
    typeof module.mergeSessionAwareSkillOverlay,
    'function',
    'skill-active must expose the session-aware overlay merge/removal helper',
  );
  return module.mergeSessionAwareSkillOverlay as OverlayMerge;
}

const SESSION_ID = 'sess-overlay-properties';
const THREAD_ID = 'thread-overlay-properties';
const START = '2026-07-14T00:00:00.000Z';
const UPDATE = '2026-07-14T00:01:00.000Z';

function entry(skill: string, overrides: Partial<SkillActiveEntry> = {}): SkillActiveEntry {
  return {
    skill,
    phase: skill === 'code-review' ? 'reviewing' : 'planning',
    active: true,
    activated_at: START,
    updated_at: START,
    session_id: SESSION_ID,
    thread_id: THREAD_ID,
    ...overrides,
  };
}

function canonical(entries: SkillActiveEntry[], overrides: SkillActiveStateLike = {}): SkillActiveStateLike {
  const primary = entries[0];
  return {
    version: 1,
    active: entries.length > 0,
    skill: primary?.skill ?? '',
    keyword: primary ? `$${primary.skill}` : '',
    phase: primary?.phase ?? '',
    activated_at: primary?.activated_at ?? START,
    updated_at: START,
    session_id: SESSION_ID,
    thread_id: THREAD_ID,
    active_skills: entries,
    ...overrides,
  };
}

function reviewOverlay(overrides: Partial<SkillActiveEntry> = {}): SkillActiveEntry {
  return entry('code-review', {
    review_id: 'review-1',
    root_thread_id: THREAD_ID,
    status: 'active',
    scope: 'session',
    deadline_at: '2026-07-14T00:30:00.000Z',
    ...overrides,
  } as Partial<SkillActiveEntry>);
}

describe('code-review overlay transition properties', () => {
  it('covers tracked, repeated, completion, tracked-to-tracked, terminal, stale-root, and isolated contexts', async () => {
    const merge = await loadOverlayMerge();
    const ralplan = entry('ralplan');
    const cases: Array<{
      name: string;
      input: OverlayMergeInput;
      expectedSkills?: string[];
      expectedError?: RegExp;
    }> = [
      {
        name: 'tracked -> overlay',
        input: { authoritativeState: canonical([ralplan]), overlay: reviewOverlay(), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['ralplan', 'code-review'],
      },
      {
        name: 'repeated overlay',
        input: { authoritativeState: canonical([ralplan, reviewOverlay()]), overlay: reviewOverlay({ updated_at: UPDATE }), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['ralplan', 'code-review'],
      },
      {
        name: 'overlay completion',
        input: { authoritativeState: canonical([ralplan, reviewOverlay()]), overlay: reviewOverlay({ active: false, status: 'completed', phase: 'completed' } as Partial<SkillActiveEntry>), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['ralplan'],
      },
      {
        name: 'tracked -> tracked',
        input: { authoritativeState: canonical([ralplan]), overlay: entry('ultrawork'), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['ralplan', 'ultrawork'],
      },
      {
        name: 'terminal tracked state',
        input: { authoritativeState: canonical([ralplan], { active: false, phase: 'completed', completed_at: START }), overlay: reviewOverlay(), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['code-review'],
      },
      {
        name: 'stale root copy',
        input: { authoritativeState: canonical([ralplan]), rootState: canonical([entry('autopilot', { session_id: 'stale-session', thread_id: 'stale-thread' })], { session_id: 'stale-session', thread_id: 'stale-thread' }), overlay: reviewOverlay(), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedSkills: ['ralplan', 'code-review'],
      },
      {
        name: 'different session',
        input: { authoritativeState: canonical([ralplan], { session_id: 'other-session', active_skills: [entry('ralplan', { session_id: 'other-session' })] }), overlay: reviewOverlay(), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedError: /canonical.*session/i,
      },
      {
        name: 'different root thread',
        input: { authoritativeState: canonical([ralplan], { thread_id: 'other-thread', active_skills: [entry('ralplan', { thread_id: 'other-thread' })] }), overlay: reviewOverlay(), sessionId: SESSION_ID, rootThreadId: THREAD_ID, nowIso: UPDATE },
        expectedError: /canonical.*thread/i,
      },
    ];

    for (const testCase of cases) {
      if (testCase.expectedError) {
        assert.throws(() => merge(testCase.input), testCase.expectedError, testCase.name);
        continue;
      }
      const result = merge(testCase.input);
      assert.deepEqual(listActiveSkills(result).map((item) => item.skill), testCase.expectedSkills, testCase.name);
    }
  });

  it('preserves review matching fields, backfills review_start once, and keeps the tracked active pointer authoritative', async () => {
    const merge = await loadOverlayMerge();
    const base = canonical([
      entry('ralplan'),
      reviewOverlay({ review_start: undefined } as Partial<SkillActiveEntry>),
    ], {
      skill: 'code-review',
      phase: 'reviewing',
    });
    const first = merge({
      authoritativeState: base,
      overlay: reviewOverlay({ updated_at: UPDATE }),
      sessionId: SESSION_ID,
      rootThreadId: THREAD_ID,
      nowIso: UPDATE,
    });
    const second = merge({
      authoritativeState: first,
      overlay: reviewOverlay({ updated_at: '2026-07-14T00:02:00.000Z' }),
      sessionId: SESSION_ID,
      rootThreadId: THREAD_ID,
      nowIso: '2026-07-14T00:02:00.000Z',
    });
    const overlay = listActiveSkills(second).find((item) => item.skill === 'code-review') as SkillActiveEntry & Record<string, unknown>;

    assert.deepEqual({
      review_id: overlay.review_id,
      session_id: overlay.session_id,
      root_thread_id: overlay.root_thread_id,
      status: overlay.status,
      scope: overlay.scope,
      deadline_at: overlay.deadline_at,
      review_start: overlay.review_start,
      primary: second.skill,
      originalMutated: (base.active_skills?.[1] as SkillActiveEntry & Record<string, unknown>).review_start,
    }, {
      review_id: 'review-1',
      session_id: SESSION_ID,
      root_thread_id: THREAD_ID,
      status: 'active',
      scope: 'session',
      deadline_at: '2026-07-14T00:30:00.000Z',
      review_start: UPDATE,
      primary: 'ralplan',
      originalMutated: undefined,
    });
  });

  it('keeps an empty terminal overlay inactive without erasing prior terminal timestamps', async () => {
    const merge = await loadOverlayMerge();
    const result = merge({
      authoritativeState: canonical([reviewOverlay()], {
        completed_at: START,
        stopped_at: START,
      }),
      overlay: reviewOverlay({
        active: false,
        status: 'completed',
        phase: 'completed',
      } as Partial<SkillActiveEntry>),
      sessionId: SESSION_ID,
      rootThreadId: THREAD_ID,
      nowIso: UPDATE,
    });

    assert.equal(result.active, false);
    assert.deepEqual(result.active_skills, []);
    assert.equal(result.completed_at, START);
    assert.equal(result.stopped_at, START);
  });

  it('rejects active and terminal overlays when the review identity changes', async () => {
    const merge = await loadOverlayMerge();
    const base = canonical([
      entry('ralplan'),
      reviewOverlay({ review_start: START }),
    ]);
    const before = JSON.stringify(base);
    const cases = [
      {
        name: 'active replacement',
        overlay: reviewOverlay({ review_id: 'review-2' }),
      },
      {
        name: 'terminal replacement',
        overlay: reviewOverlay({
          review_id: 'review-2',
          active: false,
          status: 'completed',
          phase: 'completed',
        } as Partial<SkillActiveEntry>),
      },
    ];

    const outcomes = cases.map((testCase) => {
      try {
        const result = merge({
          authoritativeState: base,
          overlay: testCase.overlay,
          sessionId: SESSION_ID,
          rootThreadId: THREAD_ID,
          nowIso: UPDATE,
        });
        const review = listActiveSkills(result).find((item) => item.skill === 'code-review');
        return {
          name: testCase.name,
          threw: false,
          skills: listActiveSkills(result).map((item) => item.skill),
          reviewId: review?.review_id ?? null,
          reviewStart: review?.review_start ?? null,
          stateUnchanged: JSON.stringify(base) === before,
        };
      } catch (error) {
        return {
          name: testCase.name,
          threw: true,
          actionableConflict: /review identity.*review_id/i.test(error instanceof Error ? error.message : String(error)),
          stateUnchanged: JSON.stringify(base) === before,
        };
      }
    });

    assert.deepEqual(outcomes, [
      {
        name: 'active replacement',
        threw: true,
        actionableConflict: true,
        stateUnchanged: true,
      },
      {
        name: 'terminal replacement',
        threw: true,
        actionableConflict: true,
        stateUnchanged: true,
      },
    ]);
  });

  it('preserves, de-duplicates, terminalizes idempotently, and isolates fixed-seed event sequences', async () => {
    const merge = await loadOverlayMerge();
    const seeds = [0x1a2b3c4d, 0x5eed1234, 0x7fffffed];

    for (const seed of seeds) {
      let value = seed >>> 0;
      let state = canonical([entry('ralplan')]);
      const sequence: string[] = [];
      for (let index = 0; index < 24; index += 1) {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
        const action = ['start', 'repeat', 'complete', 'foreign'][value % 4]!;
        sequence.push(action);
        try {
          if (action === 'foreign') {
            assert.throws(() => merge({
              authoritativeState: state,
              overlay: reviewOverlay({ session_id: 'foreign-session' }),
              sessionId: SESSION_ID,
              rootThreadId: THREAD_ID,
              nowIso: UPDATE,
            }), /overlay.*session/i);
          } else {
            state = merge({
              authoritativeState: state,
              overlay: action === 'complete'
                ? reviewOverlay({ active: false, status: 'completed', phase: 'completed' } as Partial<SkillActiveEntry>)
                : reviewOverlay(),
              sessionId: SESSION_ID,
              rootThreadId: THREAD_ID,
              nowIso: UPDATE,
            });
          }

          const active = listActiveSkills(state);
          assert.equal(active.filter((item) => item.skill === 'ralplan').length, 1);
          assert.ok(active.filter((item) => item.skill === 'code-review').length <= 1);
          assert.ok(active.every((item) => !item.session_id || item.session_id === SESSION_ID));
          assert.equal(state.skill, 'ralplan');
          assert.ok(active.filter((item) => isTrackedWorkflowMode(item.skill)).length >= 1);
        } catch (error) {
          const minimized = sequence.slice(0, index + 1);
          throw new Error(`seed=${seed} minimized_sequence=${JSON.stringify(minimized)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  });
});
