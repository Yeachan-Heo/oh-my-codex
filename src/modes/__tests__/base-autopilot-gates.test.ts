import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cancelMode, updateModeState } from '../base.js';

async function writeAutopilotState(wd: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(wd, '.omx', 'state'), { recursive: true });
  await writeFile(join(wd, '.omx', 'state', 'autopilot-state.json'), JSON.stringify({
    active: true,
    mode: 'autopilot',
    iteration: 1,
    max_iterations: 10,
    started_at: '2026-06-09T00:00:00.000Z',
    ...state,
  }, null, 2));
}

describe('modes/base Autopilot gate integration', () => {
  it('updateModeState rejects direct deep-interview to ultragoal skips', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-deep-skip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'deep-interview' });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'ultragoal' }, wd),
        /Cannot skip Autopilot ralplan gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects direct deep-interview to ultragoal skips even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-deep-skip-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'deep-interview' });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'ultragoal',
          pipeline_stage_index: 2,
        }, wd),
        /Cannot skip Autopilot ralplan gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to code-review skips', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-skip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'code-review' }, wd),
        /Cannot skip Autopilot ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to code-review skips even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-skip-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'code-review',
          pipeline_stage_results: {},
        }, wd),
        /Cannot skip Autopilot ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan completion before ultragoal', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-complete-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', { active: false, current_phase: 'complete' }, wd),
        /Cannot complete Autopilot before ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to ultragoal without tracker-backed native consensus', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-no-native-'));
    try {
      await writeAutopilotState(wd, {
        current_phase: 'ralplan',
        state: {
          handoff_artifacts: {
            ralplan: {
              ralplan_consensus_gate: {
                complete: true,
                evidence_kind: 'codex_exec',
              },
            },
          },
        },
      });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'ultragoal' }, wd),
        /Cannot transition ralplan -> ultragoal/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to ultragoal without native consensus even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-no-native-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, {
        current_phase: 'ralplan',
        state: {
          handoff_artifacts: {
            ralplan: {
              ralplan_consensus_gate: {
                complete: true,
                evidence_kind: 'codex_exec',
              },
            },
          },
        },
      });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'ultragoal',
          pipeline_stage_index: 2,
          pipeline_stage_results: {},
        }, wd),
        /Cannot transition ralplan -> ultragoal/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState does not persist user-supplied trustedPipelineProgress as state data', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-trusted-field-strip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ultraqa' });
      await updateModeState('autopilot', {
        current_phase: 'ultraqa',
        trustedPipelineProgress: true,
      }, wd);

      const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(raw, 'trustedPipelineProgress'), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancelMode allows Autopilot cancellation from a gated implementation phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-cancel-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ultragoal' });
      await cancelMode('autopilot', wd);

      const raw = JSON.parse(await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.active, false);
      assert.equal(raw.current_phase, 'cancelled');
      assert.equal(raw.run_outcome, 'cancelled');
      assert.ok(typeof raw.completed_at === 'string' && raw.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
