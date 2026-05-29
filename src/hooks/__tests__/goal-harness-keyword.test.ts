import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPrimaryKeyword,
  recordSkillActivation,
} from '../keyword-detector.js';

async function withTempState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await mkdtemp(join(tmpdir(), 'omx-goal-harness-keyword-'));
  try {
    return await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

describe('goal-harness keyword integration', () => {
  it('detects explicit goal-harness skill invocation', () => {
    const match = detectPrimaryKeyword('$goal-harness build a single-goal autonomy loop');

    assert.equal(match?.skill, 'goal-harness');
    assert.equal(match?.keyword, '$goal-harness');
  });

  it('seeds goal-harness mode state for hook/status surfaces', async () => {
    await withTempState(async (stateDir) => {
      const state = await recordSkillActivation({
        stateDir,
        text: '$goal-harness build a single-goal autonomy loop',
        sessionId: 'sess-goal-harness',
        threadId: 'thread-1',
        turnId: 'turn-1',
        nowIso: '2026-05-29T00:00:00.000Z',
      });

      assert.ok(state);
      assert.equal(state.skill, 'goal-harness');
      assert.equal(state.initialized_mode, 'goal-harness');
      assert.equal(state.initialized_state_path, '.omx/state/sessions/sess-goal-harness/goal-harness-state.json');

      const modeState = JSON.parse(
        await readFile(join(stateDir, 'sessions', 'sess-goal-harness', 'goal-harness-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(modeState.active, true);
      assert.equal(modeState.mode, 'goal-harness');
      assert.equal(modeState.current_phase, 'intake');
    });
  });
});
