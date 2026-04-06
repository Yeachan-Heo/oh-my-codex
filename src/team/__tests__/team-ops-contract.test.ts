import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as teamOps from '../team-ops.js';
import * as state from '../state.js';

const EXPECTED_STATE_RE_EXPORTS = {
  DEFAULT_MAX_WORKERS: 'DEFAULT_MAX_WORKERS',
  ABSOLUTE_MAX_WORKERS: 'ABSOLUTE_MAX_WORKERS',
  teamInit: 'initTeamState',
  teamReadConfig: 'readTeamConfig',
  teamReadManifest: 'readTeamManifestV2',
  teamWriteManifest: 'writeTeamManifestV2',
  teamSaveConfig: 'saveTeamConfig',
  teamCleanup: 'cleanupTeamState',
  teamMigrateV1ToV2: 'migrateV1ToV2',
  teamNormalizePolicy: 'normalizeTeamPolicy',
  teamNormalizeGovernance: 'normalizeTeamGovernance',
  teamWriteWorkerIdentity: 'writeWorkerIdentity',
  teamReadWorkerHeartbeat: 'readWorkerHeartbeat',
  teamUpdateWorkerHeartbeat: 'updateWorkerHeartbeat',
  teamReadWorkerStatus: 'readWorkerStatus',
  teamWriteWorkerInbox: 'writeWorkerInbox',
  teamCreateTask: 'createTask',
  teamReadTask: 'readTask',
  teamListTasks: 'listTasks',
  teamUpdateTask: 'updateTask',
  teamClaimTask: 'claimTask',
  teamReleaseTaskClaim: 'releaseTaskClaim',
  teamReclaimExpiredTaskClaim: 'reclaimExpiredTaskClaim',
  teamTransitionTaskStatus: 'transitionTaskStatus',
  teamComputeTaskReadiness: 'computeTaskReadiness',
  teamSendMessage: 'sendDirectMessage',
  teamBroadcast: 'broadcastMessage',
  teamListMailbox: 'listMailboxMessages',
  teamMarkMessageDelivered: 'markMessageDelivered',
  teamMarkMessageNotified: 'markMessageNotified',
  teamEnqueueDispatchRequest: 'enqueueDispatchRequest',
  teamListDispatchRequests: 'listDispatchRequests',
  teamReadDispatchRequest: 'readDispatchRequest',
  teamTransitionDispatchRequest: 'transitionDispatchRequest',
  teamMarkDispatchRequestNotified: 'markDispatchRequestNotified',
  teamMarkDispatchRequestDelivered: 'markDispatchRequestDelivered',
  teamAppendEvent: 'appendTeamEvent',
  teamReadTaskApproval: 'readTaskApproval',
  teamWriteTaskApproval: 'writeTaskApproval',
  teamGetSummary: 'getTeamSummary',
  teamWriteShutdownRequest: 'writeShutdownRequest',
  teamReadShutdownAck: 'readShutdownAck',
  teamReadMonitorSnapshot: 'readMonitorSnapshot',
  teamWriteMonitorSnapshot: 'writeMonitorSnapshot',
  teamReadPhase: 'readTeamPhase',
  teamWritePhase: 'writeTeamPhase',
  teamReadLeaderAttention: 'readTeamLeaderAttention',
  teamWriteLeaderAttention: 'writeTeamLeaderAttention',
  teamMarkLeaderSessionStopped: 'markTeamLeaderSessionStopped',
  teamMarkOwnedTeamsLeaderSessionStopped: 'markOwnedTeamsLeaderSessionStopped',
  teamWriteWorkerStatus: 'writeWorkerStatus',
  teamWithScalingLock: 'withScalingLock',
  resolveDispatchLockTimeoutMs: 'resolveDispatchLockTimeoutMs',
  writeAtomic: 'writeAtomic',
} as const;

function parseStateReExports(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const match of source.matchAll(/export\s*\{([^}]+)\}\s*from\s*'\.\/state\.js';/g)) {
    const specifiers = match[1]
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    for (const specifier of specifiers) {
      const aliasMatch = specifier.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        map[aliasMatch[2]] = aliasMatch[1];
      } else {
        map[specifier] = specifier;
      }
    }
  }
  return map;
}

describe('team/team-ops module contract', () => {
  it('keeps API gateway re-export map aligned with the expected state surface', async () => {
    const src = await readFile(join(process.cwd(), 'src/team/team-ops.ts'), 'utf8');
    const actual = parseStateReExports(src);
    assert.deepEqual(actual, EXPECTED_STATE_RE_EXPORTS);
  });

  it('re-exported bindings resolve to the exact state-layer implementations', () => {
    const teamOpsModule = teamOps as Record<string, unknown>;
    const stateModule = state as Record<string, unknown>;

    for (const [alias, stateName] of Object.entries(EXPECTED_STATE_RE_EXPORTS)) {
      assert.equal(
        teamOpsModule[alias],
        stateModule[stateName],
        `Expected team-ops export ${alias} to re-export state.${stateName}`,
      );
    }
  });
});
