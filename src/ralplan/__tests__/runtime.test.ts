import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getStatePath } from '../../state/paths.js';
import { readModeState } from '../../modes/base.js';
import { runRalplanConsensus } from '../runtime.js';

describe('ralplan runtime', () => {
  it('records typed review lifecycle but blocks release without an official host receipt verifier', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-runtime-host-receipt-'));
    try {
      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft lifecycle evidence' };
        },
        async architectReview() {
          return {
            agent_role: 'architect',
            verdict: 'approve',
            thread_id: 'architect-thread',
            sequence_index: 1,
          };
        },
        async criticReview() {
          return {
            agent_role: 'critic',
            verdict: 'approve',
            thread_id: 'critic-thread',
            sequence_index: 2,
          };
        },
      }, {
        task: 'fail closed without host receipt verifier',
        cwd,
        maxIterations: 1,
        selectedExecutionLane: 'ultragoal',
      });

      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'failed');
      assert.equal(result.error, 'documented_host_consensus_receipt_unavailable');
      assert.equal(result.ralplanConsensusGate.complete, false);
      assert.equal(result.ralplanConsensusGate.blocked_reason, 'documented_host_consensus_receipt_unavailable');
      assert.equal(result.ralplanConsensusGate.ralplan_architect_review?.agent_role, 'architect');
      assert.equal(result.ralplanConsensusGate.ralplan_critic_review?.agent_role, 'critic');
      assert.equal(existsSync(getStatePath('ultragoal', cwd)), false);

      const state = await readModeState('ralplan', cwd);
      assert.equal(state?.current_phase, 'failed');
      assert.match(String(state?.status_message), /official host consensus receipt verifier/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
