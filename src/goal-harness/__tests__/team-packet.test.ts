import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalHarnessRun } from '../artifacts.js';
import {
  buildGoalHarnessTeamPlan,
  readGoalHarnessRuntime,
  recordGoalHarnessLeaderStep,
} from '../runtime.js';
import { writeGoalHarnessTeamPacket } from '../team-packet.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-goal-harness-team-packet-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('goal-harness team worker packets', () => {
  it('writes durable lane instructions and result templates for optional Team sessions', async () => {
    await withTempRepo(async (cwd) => {
      await createGoalHarnessRun(cwd, {
        objective: 'Use Team worker sessions to pressure-test a Codex goal-native harness.',
        slug: 'packet',
        now: new Date('2026-05-29T01:00:00Z'),
      });
      await recordGoalHarnessLeaderStep(cwd, {
        slug: 'packet',
        outcome: 'needs_team_pressure',
        evidence: 'The leader needs independent worker pressure before committing.',
        now: new Date('2026-05-29T01:01:00Z'),
      });
      const plan = await buildGoalHarnessTeamPlan(cwd, {
        slug: 'packet',
        task: 'Pressure-test the goal-harness team integration.',
        now: new Date('2026-05-29T01:02:00Z'),
      });

      const result = await writeGoalHarnessTeamPacket(cwd, {
        slug: 'packet',
        planId: plan.plan.id,
        now: new Date('2026-05-29T01:03:00Z'),
      });

      assert.equal(result.packet.planId, plan.plan.id);
      assert.equal(result.packet.lanes.length, 3);
      assert.match(result.packet.teamLaunchCommand, /omx team 3:executor/);
      assert.match(result.packet.teamLaunchCommand, /manifest\.json/);

      const manifest = JSON.parse(await readFile(join(cwd, result.packet.manifestPath), 'utf-8')) as {
        lanes: { role: string; instructionPath: string; resultTemplatePath: string; recordTrajectoryCommand: string }[];
        leaderInstructions: string[];
      };
      assert.equal(manifest.lanes[0]?.role, 'researcher');
      assert.match(manifest.lanes[0]?.recordTrajectoryCommand ?? '', /--source worker --role researcher/);
      assert.equal(manifest.leaderInstructions.some((item) => /leader owns the Codex goal/i.test(item)), true);

      const instruction = await readFile(join(cwd, manifest.lanes[0]?.instructionPath ?? ''), 'utf-8');
      assert.match(instruction, /You do not own the Codex goal/);
      assert.match(instruction, /Do not call create_goal/);
      assert.match(instruction, /Do not call update_goal/);
      assert.match(instruction, /Return evidence only/);

      const template = await readFile(join(cwd, manifest.lanes[0]?.resultTemplatePath ?? ''), 'utf-8');
      assert.match(template, /Goal Harness Worker Result/);
      assert.match(template, /Candidate Trajectory/);
      assert.match(template, /I did not call create_goal/);

      const runtime = await readGoalHarnessRuntime(cwd, 'packet');
      assert.equal(runtime.teamPlans[0]?.packetManifestPath, result.packet.manifestPath);
      assert.equal(runtime.teamPlans[0]?.packetPath, result.packet.artifactDir);

      const ledger = await readFile(join(cwd, '.omx/goals/goal-harness/packet/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"team_packet_built"/);
      assert.match(ledger, /"laneCount":3/);
    });
  });
});
