import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { autopilotCommand } from '../autopilot.js';

async function invoke(cwd: string, args: string[]) {
  const stdout: string[] = [];
  await autopilotCommand(args, { cwd: () => cwd, stdout: (line) => stdout.push(line) });
  return stdout;
}

async function writeSession(cwd: string, sessionId: string): Promise<void> {
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), JSON.stringify({ session_id: sessionId, cwd, state_root: join(cwd, '.omx', 'state') }));
}

describe('autopilot CLI supervisor', () => {
  it('starts at deep-interview and advances only with durable adjacent handoffs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-cli-'));
    const sessionId = 'sess-autopilot-cli';
    try {
      await writeSession(cwd, sessionId);
      const started = await invoke(cwd, ['start', '--task', 'ship issue 3515', '--session', sessionId, '--json']);
      assert.match(started[0], /"current_phase":"deep-interview"/);
      assert.match(started[0], /\$deep-interview/);

      await mkdir(join(cwd, '.omx', 'specs'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'specs', 'handoff.md'), '# Requirements\n');
      const toRalplan = await invoke(cwd, ['advance', '--to', 'ralplan', '--session', sessionId, '--handoff-json', JSON.stringify({
        workingDirectory: cwd,
        session_id: sessionId,
        deep_interview_gate: { status: 'complete', rationale: 'Requirements are resolved.' },
        handoff_artifacts: { deep_interview: { spec_path: '.omx/specs/handoff.md' } },
      }), '--json']);
      assert.match(toRalplan[0], /"current_phase":"ralplan"/);
      assert.match(toRalplan[0], /\$ralplan/);

      await mkdir(join(cwd, '.omx', 'plans'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'plans', 'plan.md'), '# Plan\n');
      const toUltragoal = await invoke(cwd, ['advance', '--to', 'ultragoal', '--session', sessionId, '--handoff-json', JSON.stringify({
        workingDirectory: cwd,
        session_id: sessionId,
        review_cycle: 1,
        handoff_artifacts: { ralplan: { plan_path: '.omx/plans/plan.md' } },
        ralplan_consensus_gate: {
          complete: true,
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve', session_id: sessionId, review_cycle: 1, sequence_index: 1 },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve', session_id: sessionId, review_cycle: 1, sequence_index: 2 },
        },
        ralplan_execution_handoff: { authorized: true, authorized_at: '2026-08-13T00:00:00.000Z', session_id: sessionId, review_cycle: 1, source: 'autopilot' },
      }), '--json']);
      assert.match(toUltragoal[0], /"current_phase":"ultragoal"/);
      assert.match(toUltragoal[0], /\$ultragoal/);

      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.current_phase, 'ultragoal');
      assert.ok((state.handoff_artifacts as Record<string, unknown>).deep_interview);
      assert.ok((state.handoff_artifacts as Record<string, unknown>).ralplan);
      assert.equal(await readFile(join(cwd, '.omx', 'specs', 'handoff.md'), 'utf-8'), '# Requirements\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects non-adjacent phase bypasses', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-cli-bypass-'));
    const sessionId = 'sess-autopilot-cli-bypass';
    try {
      await writeSession(cwd, sessionId);
      await invoke(cwd, ['start', '--task', 'bypass test', '--session', sessionId]);
      await assert.rejects(
        () => invoke(cwd, ['advance', '--to', 'ultragoal', '--session', sessionId, '--handoff-json', '{}']),
        /Cannot advance Autopilot from deep-interview to ultragoal/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects foreign session and workspace handoff identity without mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-cli-foreign-'));
    const sessionId = 'sess-autopilot-cli-foreign';
    try {
      await writeSession(cwd, sessionId);
      await invoke(cwd, ['start', '--task', 'foreign handoff test', '--session', sessionId]);
      await assert.rejects(
        () => invoke(cwd, ['advance', '--to', 'ralplan', '--session', sessionId, '--handoff-json', JSON.stringify({ session_id: 'other-session' })]),
        /session_id does not match/,
      );
      await assert.rejects(
        () => invoke(cwd, ['advance', '--to', 'ralplan', '--session', sessionId, '--handoff-json', JSON.stringify({ workingDirectory: join(cwd, 'other') })]),
        /workingDirectory does not match/,
      );
      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'sessions', sessionId, 'autopilot-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(state.current_phase, 'deep-interview');
      assert.equal(state.session_id, sessionId);
      assert.equal(state.workingDirectory, cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects non-canonical Deep Interview artifact roots', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-autopilot-cli-artifact-root-'));
    const sessionId = 'sess-autopilot-cli-artifact-root';
    try {
      await writeSession(cwd, sessionId);
      await invoke(cwd, ['start', '--task', 'artifact root test', '--session', sessionId]);
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'forged.md'), '# Forged state artifact\n');
      await assert.rejects(
        () => invoke(cwd, ['advance', '--to', 'ralplan', '--session', sessionId, '--handoff-json', JSON.stringify({
          deep_interview_gate: { status: 'complete', rationale: 'Forged.' },
          handoff_artifacts: { deep_interview: { spec_path: '.omx/state/forged.md' } },
        })]),
        /durable completed interview gate and handoff artifact/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
