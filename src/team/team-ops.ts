/**
 * MCP-aligned gateway for all team operations.
 *
 * Both the MCP server (state-server.ts) and the runtime (runtime.ts)
 * import from this module instead of state.ts directly.
 * protocol-adapter.ts wraps cli-agent-mail with OMX function signatures.
 * state.ts remains as the legacy persistence layer.
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
} from './protocol-adapter.js';

// === Constants ===
export { DEFAULT_MAX_WORKERS, ABSOLUTE_MAX_WORKERS } from './protocol-adapter.js';

// === Team lifecycle ===
export { initTeamState as teamInit } from './protocol-adapter.js';
export { readTeamConfig as teamReadConfig } from './protocol-adapter.js';
export { readTeamManifestV2 as teamReadManifest } from './protocol-adapter.js';
export { writeTeamManifestV2 as teamWriteManifest } from './protocol-adapter.js';
export { saveTeamConfig as teamSaveConfig } from './protocol-adapter.js';
export { cleanupTeamState as teamCleanup } from './protocol-adapter.js';
export { migrateV1ToV2 as teamMigrateV1ToV2 } from './protocol-adapter.js';

// === Worker operations ===
export { writeWorkerIdentity as teamWriteWorkerIdentity } from './protocol-adapter.js';
export { readWorkerHeartbeat as teamReadWorkerHeartbeat } from './protocol-adapter.js';
export { updateWorkerHeartbeat as teamUpdateWorkerHeartbeat } from './protocol-adapter.js';
export { readWorkerStatus as teamReadWorkerStatus } from './protocol-adapter.js';
export { writeWorkerInbox as teamWriteWorkerInbox } from './protocol-adapter.js';

// === Task operations ===
export { createTask as teamCreateTask } from './protocol-adapter.js';
export { readTask as teamReadTask } from './protocol-adapter.js';
export { listTasks as teamListTasks } from './protocol-adapter.js';
export { updateTask as teamUpdateTask } from './protocol-adapter.js';
export { claimTask as teamClaimTask } from './protocol-adapter.js';
export { releaseTaskClaim as teamReleaseTaskClaim } from './protocol-adapter.js';
export { transitionTaskStatus as teamTransitionTaskStatus } from './protocol-adapter.js';
export { computeTaskReadiness as teamComputeTaskReadiness } from './protocol-adapter.js';

// === Messaging ===
export { sendDirectMessage as teamSendMessage } from './protocol-adapter.js';
export { broadcastMessage as teamBroadcast } from './protocol-adapter.js';
export { listMailboxMessages as teamListMailbox } from './protocol-adapter.js';
export { markMessageDelivered as teamMarkMessageDelivered } from './protocol-adapter.js';
export { markMessageNotified as teamMarkMessageNotified } from './protocol-adapter.js';

// === Events ===
export { appendTeamEvent as teamAppendEvent } from './protocol-adapter.js';

// === Approvals ===
export { readTaskApproval as teamReadTaskApproval } from './protocol-adapter.js';
export { writeTaskApproval as teamWriteTaskApproval } from './protocol-adapter.js';

// === Summary ===
export { getTeamSummary as teamGetSummary } from './protocol-adapter.js';

// === Shutdown control ===
export { writeShutdownRequest as teamWriteShutdownRequest } from './protocol-adapter.js';
export { readShutdownAck as teamReadShutdownAck } from './protocol-adapter.js';

// === Monitor snapshot ===
export { readMonitorSnapshot as teamReadMonitorSnapshot } from './protocol-adapter.js';
export { writeMonitorSnapshot as teamWriteMonitorSnapshot } from './protocol-adapter.js';

// === Atomic write (shared utility) ===
export { writeAtomic } from './protocol-adapter.js';
