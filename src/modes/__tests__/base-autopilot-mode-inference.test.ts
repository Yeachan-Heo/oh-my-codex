import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeStateForActiveDecision } from '../base.js';

async function writeAutopilotStateExactSession(
  wd: string,
  sessionId: string,
  state: Record<string, unknown>,
): Promise<void> {
  const stateDir = join(wd, '.omx', 'state', 'sessions', sessionId);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify(state, null, 2));
}

async function writeAutopilotStateRoot(wd: string, state: Record<string, unknown>): Promise<void> {
  const stateDir = join(wd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'autopilot-state.json'), JSON.stringify(state, null, 2));
}

describe('modes/base autopilot mode inference', () => {
  it('infers mode autopilot for exact-session state without explicit mode marker', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-autopilot-mode-infer-'));
    try {
      const sessionId = 'test-session-123';
      await writeAutopilotStateExactSession(wd, sessionId, {
        active: true,
        current_phase: 'ultragoal',
        iteration: 1,
        max_iterations: 50,
        started_at: new Date().toISOString(),
        // Note: no explicit mode field
      });

      const state = await readModeStateForActiveDecision('autopilot', sessionId, wd);

      assert.ok(state, 'should read state');
      assert.equal(state?.mode, 'autopilot', 'should infer mode as autopilot for exact-session');
      assert.equal(state?.active, true);
      assert.equal(state?.current_phase, 'ultragoal');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not infer mode for root state without explicit mode marker', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-autopilot-no-infer-root-'));
    try {
      await writeAutopilotStateRoot(wd, {
        active: true,
        current_phase: 'ultragoal',
        iteration: 1,
        max_iterations: 50,
        started_at: new Date().toISOString(),
        // Note: no explicit mode field, and no sessionId
      });

      const state = await readModeStateForActiveDecision('autopilot', undefined, wd);

      assert.ok(state, 'should read state');
      // Root state without mode should not be inferred to autopilot
      assert.equal(state?.mode, undefined, 'should not infer mode for root state');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('preserves explicit mode marker on exact-session state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-autopilot-preserve-explicit-'));
    try {
      const sessionId = 'test-session-456';
      await writeAutopilotStateExactSession(wd, sessionId, {
        active: true,
        mode: 'ultrawork',
        current_phase: 'planning',
        iteration: 1,
        max_iterations: 50,
        started_at: new Date().toISOString(),
      });

      const state = await readModeStateForActiveDecision('autopilot', sessionId, wd);

      assert.ok(state, 'should read state');
      assert.equal(state?.mode, 'ultrawork', 'should preserve explicit mode marker');
      assert.equal(state?.current_phase, 'planning');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('enables executor handoff when autopilot mode is correctly inferred', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-autopilot-handoff-'));
    try {
      const sessionId = 'executor-handoff-session';
      // State without mode marker simulates exact-session created before mode tracking
      await writeAutopilotStateExactSession(wd, sessionId, {
        active: true,
        current_phase: 'ultragoal',
        iteration: 1,
        max_iterations: 50,
        started_at: new Date().toISOString(),
        state: {
          outcome: 'pending',
        },
      });

      const state = await readModeStateForActiveDecision('autopilot', sessionId, wd);

      assert.ok(state, 'should read state');
      assert.equal(state?.mode, 'autopilot', 'should infer autopilot mode');
      assert.equal(state?.active, true, 'should be active');
      // With mode properly inferred, autopilotSupervised would be true in src/cli/ultragoal.ts
      // allowing executor handoff and Team-preserving guidance
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
