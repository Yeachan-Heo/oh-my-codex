/**
 * MCP-aligned gateway for all team operations.
 *
 * Both the MCP server (state-server.ts) and the runtime (runtime.ts)
 * import from this module instead of state.ts directly.
 * state.ts remains the private persistence layer.
 *
 * Every exported function here corresponds to (or backs) an MCP tool
 * with the same semantic name, ensuring the runtime contract matches
 * the external MCP surface.
 */

// === Types (re-exported) ===
export type {
  TeamConfig,
  WorkerInfo,
  WorkerHeartbeat,
  WorkerStatus,
  TeamTask,
  TeamTaskV2,
  TeamTaskClaim,
  TeamManifestV2,
  TeamLeader,
  TeamPolicy,
  PermissionsSnapshot,
  TeamEvent,
  TeamMailboxMessage,
  TeamMailbox,
  TaskApprovalRecord,
  TaskReadiness,
  ClaimTaskResult,
  TransitionTaskResult,
  ReleaseTaskClaimResult,
  TeamSummary,
  ShutdownAck,
  TeamMonitorSnapshotState,
} from './state.js';

// === Constants ===
export { DEFAULT_MAX_WORKERS, ABSOLUTE_MAX_WORKERS } from './state.js';

// === Team lifecycle ===
export { initTeamState as teamInit } from './state.js';
export { readTeamConfig as teamReadConfig } from './state.js';
export { readTeamManifestV2 as teamReadManifest } from './state.js';
export { writeTeamManifestV2 as teamWriteManifest } from './state.js';
export { saveTeamConfig as teamSaveConfig } from './state.js';
export { cleanupTeamState as teamCleanup } from './state.js';
export { migrateV1ToV2 as teamMigrateV1ToV2 } from './state.js';

// === Worker operations ===
export { writeWorkerIdentity as teamWriteWorkerIdentity } from './state.js';
export { readWorkerHeartbeat as teamReadWorkerHeartbeat } from './state.js';
export { updateWorkerHeartbeat as teamUpdateWorkerHeartbeat } from './state.js';
export { readWorkerStatus as teamReadWorkerStatus } from './state.js';
export { writeWorkerInbox as teamWriteWorkerInbox } from './state.js';

// === Task operations ===
export { createTask as teamCreateTask } from './state.js';
export { readTask as teamReadTask } from './state.js';
export { listTasks as teamListTasks } from './state.js';
export { updateTask as teamUpdateTask } from './state.js';
export { claimTask as teamClaimTask } from './state.js';
export { releaseTaskClaim as teamReleaseTaskClaim } from './state.js';
export { transitionTaskStatus as teamTransitionTaskStatus } from './state.js';
export { computeTaskReadiness as teamComputeTaskReadiness } from './state.js';

// === Messaging ===
export { sendDirectMessage as teamSendMessage } from './state.js';
export { broadcastMessage as teamBroadcast } from './state.js';
export { listMailboxMessages as teamListMailbox } from './state.js';
export { markMessageDelivered as teamMarkMessageDelivered } from './state.js';
export { markMessageNotified as teamMarkMessageNotified } from './state.js';

// === Events ===
export { appendTeamEvent as teamAppendEvent } from './state.js';

// === Approvals ===
export { readTaskApproval as teamReadTaskApproval } from './state.js';
export { writeTaskApproval as teamWriteTaskApproval } from './state.js';

// === Summary ===
export { getTeamSummary as teamGetSummary } from './state.js';

// === Shutdown control ===
export { writeShutdownRequest as teamWriteShutdownRequest } from './state.js';
export { readShutdownAck as teamReadShutdownAck } from './state.js';

// === Monitor snapshot ===
export { readMonitorSnapshot as teamReadMonitorSnapshot } from './state.js';
export { writeMonitorSnapshot as teamWriteMonitorSnapshot } from './state.js';

// === Atomic write (shared utility) ===
export { writeAtomic } from './state.js';
