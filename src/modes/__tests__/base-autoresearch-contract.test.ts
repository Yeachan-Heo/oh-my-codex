import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode, updateModeState } from '../base.js';
import { listActiveSkills, readVisibleSkillActiveState } from '../../state/skill-active.js';

describe('modes/base deep-interview contract integration', () => {
  it('startMode persists deep-interview state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-deep-interview-contract-'));
    try {
      const started = await startMode('deep-interview', 'clarify a vague request', 3, wd);
      assert.equal(started.mode, 'deep-interview');
      assert.equal(started.active, true);
      assert.equal(started.current_phase, 'starting');
      const persisted = await readModeState('deep-interview', wd);
      assert.equal(persisted?.mode, 'deep-interview');
      assert.equal(persisted?.task_description, 'clarify a vague request');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('modes/base autoresearch contract integration', () => {
  it('startMode auto-completes deep-interview when starting ralplan with completion gate evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-interview-ralplan-handoff-'));
    try {
      await startMode('deep-interview', 'clarify contract', 3, wd);
      await updateModeState('deep-interview', {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Requirements are clarified and ready for ralplan consensus.',
        },
      }, wd);
      const started = await startMode('ralplan', 'plan contract', 5, wd);
      assert.equal(started.mode, 'ralplan');
      assert.equal(started.active, true);
      assert.equal(started.transition_message, 'mode transiting: deep-interview -> ralplan');

      const completed = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'deep-interview-state.json'), 'utf-8'),
      ) as { active?: boolean; current_phase?: string; completed_at?: string };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
      assert.equal(typeof completed.completed_at, 'string');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode allows the approved team + ralph overlap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-team-ralph-overlap-'));
    try {
      await startMode('team', 'demo team', 5, wd);
      const started = await startMode('ralph', 'demo ralph', 5, wd);
      assert.equal(started.mode, 'ralph');
      assert.equal(started.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode blocks autoresearch when ralph is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-contract-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      await assert.rejects(
        () => startMode('autoresearch', 'demo mission', 1, wd),
        /Cannot start autoresearch: ralph is already active/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode allows ultrawork overlap with any tracked mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-ultrawork-allow-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      const started = await startMode('ultrawork', 'demo mission', 1, wd);
      assert.equal(started.mode, 'ultrawork');
      assert.equal(started.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode blocks execution-to-planning rollback auto-complete', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-rollback-deny-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      await assert.rejects(
        () => startMode('ralplan', 'plan again', 5, wd),
        /Execution-to-planning rollback auto-complete is not allowed/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode persists autoresearch state when no exclusive conflict exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-contract-'));
    try {
      const started = await startMode('autoresearch', 'demo mission', 1, wd);
      assert.equal(started.mode, 'autoresearch');
      assert.equal(started.active, true);
      assert.equal(started.current_phase, 'starting');
      const persisted = await readModeState('autoresearch', wd);
      assert.equal(persisted?.mode, 'autoresearch');
      assert.equal(persisted?.task_description, 'demo mission');

      const canonical = await readVisibleSkillActiveState(wd);
      assert.deepEqual(
        listActiveSkills(canonical ?? {}).map(({ skill, phase }) => ({ skill, phase })),
        [{ skill: 'autoresearch', phase: 'starting' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState syncs canonical autoresearch completion', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-canonical-'));
    try {
      await startMode('autoresearch', 'demo mission', 1, wd);
      await updateModeState('autoresearch', {
        active: false,
        current_phase: 'complete',
        completed_at: '2026-04-11T00:00:00.000Z',
      }, wd);

      const canonical = await readVisibleSkillActiveState(wd);
      assert.ok(canonical);
      assert.equal(canonical?.active, false);
      assert.deepEqual(listActiveSkills(canonical ?? {}), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
