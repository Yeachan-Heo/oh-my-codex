import { appendFile, readFile, writeFile, mkdir, rm, rename, readdir, stat } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { omxStateDir } from '../utils/paths.js';

export interface TeamConfig {
  name: string;
  task: string;
  agent_type: string;
  worker_count: number;
  max_workers: number; // default 6, configurable up to 20
  workers: WorkerInfo[];
  created_at: string;
  tmux_session: string; // "omx-team-{name}"
  next_task_id: number;
}

export interface WorkerInfo {
  name: string; // "worker-1"
  index: number; // tmux window index (1-based)
  role: string; // agent type
  assigned_tasks: string[]; // task IDs
  pid?: number;
  pane_id?: string;
}

export interface WorkerHeartbeat {
  pid: number;
  last_turn_at: string;
  turn_count: number;
  alive: boolean;
}

export interface WorkerStatus {
  state: 'idle' | 'working' | 'blocked' | 'done' | 'failed' | 'unknown';
  current_task_id?: string;
  reason?: string;
  updated_at: string;
}

export interface TeamTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'blocked' | 'in_progress' | 'completed' | 'failed';
  requires_code_change?: boolean;
  owner?: string; // worker name
  result?: string; // completion summary
  error?: string; // failure reason
  blocked_by?: string[]; // task IDs
  depends_on?: string[]; // task IDs
  version?: number;
  claim?: TeamTaskClaim;
  created_at: string;
  completed_at?: string;
}

export interface TeamTaskClaim {
  owner: string;
  token: string;
  leased_until: string;
}

export interface TeamTaskV2 extends TeamTask {
  version: number;
}

export interface TeamLeader {
  session_id: string;
  thread_id?: string;
  worker_id: string;
  role: string;
}

export interface TeamPolicy {
  display_mode: 'split_pane' | 'auto';
  delegation_only: boolean;
  plan_approval_required: boolean;
  nested_teams_allowed: boolean;
  one_team_per_leader_session: boolean;
  cleanup_requires_all_workers_inactive: boolean;
}

export interface PermissionsSnapshot {
  approval_mode: string;
  sandbox_mode: string;
  network_access: boolean;
}

export interface TeamManifestV2 {
  schema_version: 2;
  name: string;
  task: string;
  leader: TeamLeader;
  policy: TeamPolicy;
  permissions_snapshot: PermissionsSnapshot;
  tmux_session: string;
  worker_count: number;
  workers: WorkerInfo[];
  next_task_id: number;
  created_at: string;
}

export interface TeamEvent {
  event_id: string;
  team: string;
  type:
    | 'task_completed'
    | 'worker_idle'
    | 'worker_stopped'
    | 'message_received'
    | 'shutdown_ack'
    | 'approval_decision';
  worker: string;
  task_id?: string;
  message_id?: string | null;
  reason?: string;
  created_at: string;
}

export interface TeamMailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

export interface TeamMailbox {
  worker: string;
  messages: TeamMailboxMessage[];
}

export interface TaskApprovalRecord {
  task_id: string;
  required: boolean;
  status: 'pending' | 'approved' | 'rejected';
  reviewer: string;
  decision_reason: string;
  decided_at: string;
}

interface TeamSummarySnapshot {
  workerTurnCountByName: Record<string, number>;
  workerTaskByName: Record<string, string>;
}

export type TaskReadiness =
  | { ready: true }
  | { ready: false; reason: 'blocked_dependency'; dependencies: string[] };

export type ClaimTaskResult =
  | { ok: true; task: TeamTaskV2; claimToken: string }
  | { ok: false; error: 'claim_conflict' | 'blocked_dependency' | 'task_not_found'; dependencies?: string[] };

export type TransitionTaskResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'invalid_transition' | 'task_not_found' };

export type ReleaseTaskClaimResult =
  | { ok: true; task: TeamTaskV2 }
  | { ok: false; error: 'claim_conflict' | 'task_not_found' };

export interface TeamSummary {
  teamName: string;
  workerCount: number;
  tasks: {
    total: number;
    pending: number;
    blocked: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  workers: Array<{ name: string; alive: boolean; lastTurnAt: string | null; turnsWithoutProgress: number }>;
  nonReportingWorkers: string[];
}

export const DEFAULT_MAX_WORKERS = 6;
export const ABSOLUTE_MAX_WORKERS = 20;
const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;

async function writeTaskClaimLockOwnerToken(ownerPath: string, ownerToken: string): Promise<void> {
  await writeFile(ownerPath, ownerToken, 'utf8');
}

function defaultLeader(): TeamLeader {
  return {
    session_id: '',
    worker_id: 'leader-fixed',
    role: 'coordinator',
  };
}

function defaultPolicy(displayMode: TeamPolicy['display_mode'] = 'auto'): TeamPolicy {
  return {
    display_mode: displayMode,
    delegation_only: false,
    plan_approval_required: false,
    nested_teams_allowed: false,
    one_team_per_leader_session: true,
    cleanup_requires_all_workers_inactive: true,
  };
}

function defaultPermissionsSnapshot(): PermissionsSnapshot {
  return {
    approval_mode: 'unknown',
    sandbox_mode: 'unknown',
    network_access: true,
  };
}

function readEnvValue(env: NodeJS.ProcessEnv, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function parseOptionalBoolean(raw: string | null): boolean | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled', 'allow', 'allowed'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled', 'deny', 'denied'].includes(normalized)) return false;
  return null;
}

function resolveDisplayModeFromEnv(env: NodeJS.ProcessEnv): TeamPolicy['display_mode'] {
  const raw = readEnvValue(env, ['OMX_TEAM_DISPLAY_MODE', 'OMX_TEAM_MODE']);
  if (!raw) return 'auto';
  if (raw === 'in_process' || raw === 'in-process') return 'split_pane';
  if (raw === 'split_pane' || raw === 'tmux') return 'split_pane';
  if (raw === 'auto') return 'auto';
  return 'auto';
}

function resolvePermissionsSnapshot(env: NodeJS.ProcessEnv): PermissionsSnapshot {
  const snapshot = defaultPermissionsSnapshot();

  const approvalMode = readEnvValue(env, [
    'OMX_APPROVAL_MODE',
    'CODEX_APPROVAL_MODE',
    'CODEX_APPROVAL_POLICY',
    'CLAUDE_CODE_APPROVAL_MODE',
  ]);
  if (approvalMode) snapshot.approval_mode = approvalMode;

  const sandboxMode = readEnvValue(env, ['OMX_SANDBOX_MODE', 'CODEX_SANDBOX_MODE', 'SANDBOX_MODE']);
  if (sandboxMode) snapshot.sandbox_mode = sandboxMode;

  const network = parseOptionalBoolean(readEnvValue(env, ['OMX_NETWORK_ACCESS', 'CODEX_NETWORK_ACCESS', 'NETWORK_ACCESS']));
  if (network !== null) snapshot.network_access = network;
  else if (snapshot.sandbox_mode.toLowerCase().includes('offline')) snapshot.network_access = false;

  return snapshot;
}

async function resolveLeaderSessionId(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const fromEnv = readEnvValue(env, ['OMX_SESSION_ID', 'CODEX_SESSION_ID', 'SESSION_ID']);
  if (fromEnv) return fromEnv;

  const sessionPath = join(omxStateDir(cwd), 'session.json');
  try {
    if (!existsSync(sessionPath)) return '';
    const raw = await readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw) as { session_id?: unknown };
    if (typeof parsed.session_id === 'string' && parsed.session_id.trim() !== '') return parsed.session_id.trim();
  } catch {
    // best effort
  }
  return '';
}

function normalizeTask(task: TeamTask): TeamTaskV2 {
  return {
    ...task,
    depends_on: task.depends_on ?? task.blocked_by ?? [],
    version: Math.max(1, task.version ?? 1),
  };
}

// Team state directory: .omx/state/team/{teamName}/
function teamDir(teamName: string, cwd: string): string {
  return join(omxStateDir(cwd), 'team', teamName);
}

function teamConfigPath(teamName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'config.json');
}

function teamManifestV2Path(teamName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'manifest.v2.json');
}

function taskClaimLockDir(teamName: string, taskId: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'claims', `task-${taskId}.lock`);
}

function eventLogPath(teamName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'events', 'events.ndjson');
}

function mailboxPath(teamName: string, workerName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'mailbox', `${workerName}.json`);
}

function mailboxLockDir(teamName: string, workerName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'mailbox', `.lock-${workerName}`);
}

function approvalPath(teamName: string, taskId: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'approvals', `task-${taskId}.json`);
}

function summarySnapshotPath(teamName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'summary-snapshot.json');
}

// Validate team name: alphanumeric + hyphens only, max 30 chars
function validateTeamName(name: string): void {
  const re = /^[a-z0-9][a-z0-9-]{0,29}$/;
  if (!re.test(name)) {
    throw new Error(
      `Invalid team name: "${name}". Team name must match /^[a-z0-9][a-z0-9-]{0,29}$/ (lowercase alphanumeric + hyphens, max 30 chars).`
    );
  }
}

function isWorkerHeartbeat(value: unknown): value is WorkerHeartbeat {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    typeof v.last_turn_at === 'string' &&
    typeof v.turn_count === 'number' &&
    typeof v.alive === 'boolean'
  );
}

function isWorkerStatus(value: unknown): value is WorkerStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const state = v.state;
  const allowed = ['idle', 'working', 'blocked', 'done', 'failed', 'unknown'];
  if (typeof state !== 'string' || !allowed.includes(state)) return false;
  return typeof v.updated_at === 'string';
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const allowed = ['pending', 'blocked', 'in_progress', 'completed', 'failed'];
  if (typeof v.id !== 'string') return false;
  if (typeof v.subject !== 'string') return false;
  if (typeof v.description !== 'string') return false;
  if (typeof v.status !== 'string' || !allowed.includes(v.status)) return false;
  if (typeof v.created_at !== 'string') return false;
  return true;
}

function isTeamManifestV2(value: unknown): value is TeamManifestV2 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.schema_version !== 2) return false;
  if (typeof v.name !== 'string') return false;
  if (typeof v.task !== 'string') return false;
  if (typeof v.tmux_session !== 'string') return false;
  if (typeof v.worker_count !== 'number') return false;
  if (typeof v.next_task_id !== 'number') return false;
  if (typeof v.created_at !== 'string') return false;
  if (!Array.isArray(v.workers)) return false;
  if (!v.leader || typeof v.leader !== 'object') return false;
  if (!v.policy || typeof v.policy !== 'object') return false;
  if (!v.permissions_snapshot || typeof v.permissions_snapshot !== 'object') return false;
  return true;
}

// Atomic write: write to {path}.tmp.{pid}, then rename
export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, data, 'utf8');

  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' && existsSync(filePath)) {
      return;
    }
    throw error;
  }
}

// Initialize team state directory + config.json
// Creates: .omx/state/team/{name}/, workers/{worker-1}..{worker-N}/, tasks/
// Throws if workerCount > maxWorkers (default 6)
export async function initTeamState(
  teamName: string,
  task: string,
  agentType: string,
  workerCount: number,
  cwd: string,
  maxWorkers: number = DEFAULT_MAX_WORKERS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TeamConfig> {
  validateTeamName(teamName);

  if (maxWorkers > ABSOLUTE_MAX_WORKERS) {
    throw new Error(`maxWorkers (${maxWorkers}) exceeds ABSOLUTE_MAX_WORKERS (${ABSOLUTE_MAX_WORKERS})`);
  }

  if (workerCount > maxWorkers) {
    throw new Error(`workerCount (${workerCount}) exceeds maxWorkers (${maxWorkers})`);
  }

  const root = teamDir(teamName, cwd);
  const workersRoot = join(root, 'workers');
  const tasksRoot = join(root, 'tasks');
  const claimsRoot = join(root, 'claims');
  const mailboxRoot = join(root, 'mailbox');
  const eventsRoot = join(root, 'events');
  const approvalsRoot = join(root, 'approvals');

  await mkdir(workersRoot, { recursive: true });
  await mkdir(tasksRoot, { recursive: true });
  await mkdir(claimsRoot, { recursive: true });
  await mkdir(mailboxRoot, { recursive: true });
  await mkdir(eventsRoot, { recursive: true });
  await mkdir(approvalsRoot, { recursive: true });

  const workers: WorkerInfo[] = [];
  for (let i = 1; i <= workerCount; i++) {
    const name = `worker-${i}`;
    const worker: WorkerInfo = { name, index: i, role: agentType, assigned_tasks: [] };
    workers.push(worker);
    await mkdir(join(workersRoot, name), { recursive: true });
  }

  const leaderSessionId = await resolveLeaderSessionId(cwd, env);
  const leaderWorkerId = readEnvValue(env, ['OMX_TEAM_WORKER']) ?? 'leader-fixed';
  const displayMode = resolveDisplayModeFromEnv(env);
  const permissionsSnapshot = resolvePermissionsSnapshot(env);

  const config: TeamConfig = {
    name: teamName,
    task,
    agent_type: agentType,
    worker_count: workerCount,
    max_workers: maxWorkers,
    workers,
    created_at: new Date().toISOString(),
    tmux_session: `omx-team-${teamName}`,
    next_task_id: 1,
  };

  await writeAtomic(join(root, 'config.json'), JSON.stringify(config, null, 2));
  await writeTeamManifestV2(
    {
      schema_version: 2,
      name: teamName,
      task,
      leader: {
        ...defaultLeader(),
        session_id: leaderSessionId,
        worker_id: leaderWorkerId,
      },
      policy: defaultPolicy(displayMode),
      permissions_snapshot: permissionsSnapshot,
      tmux_session: config.tmux_session,
      worker_count: workerCount,
      workers,
      next_task_id: 1,
      created_at: config.created_at,
    },
    cwd
  );
  return config;
}

async function writeConfig(cfg: TeamConfig, cwd: string): Promise<void> {
  const p = teamConfigPath(cfg.name, cwd);
  await writeAtomic(p, JSON.stringify(cfg, null, 2));

  // Keep v2 manifest in sync when present. Don't create it implicitly here to preserve migration behavior.
  const existing = await readTeamManifestV2(cfg.name, cwd);
  if (existing) {
    const merged: TeamManifestV2 = {
      ...existing,
      task: cfg.task,
      tmux_session: cfg.tmux_session,
      worker_count: cfg.worker_count,
      workers: cfg.workers,
      next_task_id: normalizeNextTaskId(cfg.next_task_id),
    };
    await writeTeamManifestV2(merged, cwd);
  }
}

function teamConfigFromManifest(manifest: TeamManifestV2): TeamConfig {
  return {
    name: manifest.name,
    task: manifest.task,
    agent_type: manifest.workers[0]?.role ?? 'executor',
    worker_count: manifest.worker_count,
    max_workers: DEFAULT_MAX_WORKERS,
    workers: manifest.workers,
    created_at: manifest.created_at,
    tmux_session: manifest.tmux_session,
    next_task_id: manifest.next_task_id,
  };
}

function teamManifestFromConfig(config: TeamConfig): TeamManifestV2 {
  return {
    schema_version: 2,
    name: config.name,
    task: config.task,
    leader: defaultLeader(),
    policy: defaultPolicy(),
    permissions_snapshot: defaultPermissionsSnapshot(),
    tmux_session: config.tmux_session,
    worker_count: config.worker_count,
    workers: config.workers,
    next_task_id: normalizeNextTaskId(config.next_task_id),
    created_at: config.created_at,
  };
}

export async function writeTeamManifestV2(manifest: TeamManifestV2, cwd: string): Promise<void> {
  const p = teamManifestV2Path(manifest.name, cwd);
  await writeAtomic(p, JSON.stringify(manifest, null, 2));
}

export async function readTeamManifestV2(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  try {
    const p = teamManifestV2Path(teamName, cwd);
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isTeamManifestV2(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Idempotent migration; keeps config.json untouched.
export async function migrateV1ToV2(teamName: string, cwd: string): Promise<TeamManifestV2 | null> {
  const existing = await readTeamManifestV2(teamName, cwd);
  if (existing) return existing;

  try {
    const p = teamConfigPath(teamName, cwd);
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const manifest = teamManifestFromConfig(parsed as TeamConfig);
    await writeTeamManifestV2(manifest, cwd);
    return manifest;
  } catch {
    return null;
  }
}

function normalizeNextTaskId(raw: unknown): number {
  const asNum = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(asNum)) return 1;
  const floored = Math.floor(asNum);
  return Math.max(1, floored);
}

function hasValidNextTaskId(raw: unknown): boolean {
  const asNum = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(asNum) && Math.floor(asNum) >= 1;
}

async function computeNextTaskIdFromDisk(teamName: string, cwd: string): Promise<number> {
  const tasksRoot = join(teamDir(teamName, cwd), 'tasks');
  if (!existsSync(tasksRoot)) return 1;

  let maxId = 0;
  try {
    const files = await readdir(tasksRoot);
    for (const f of files) {
      const m = /^task-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > maxId) maxId = id;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return 1;
    throw error;
  }

  return maxId + 1;
}

// Read team config
export async function readTeamConfig(teamName: string, cwd: string): Promise<TeamConfig | null> {
  const v2 = await readTeamManifestV2(teamName, cwd);
  if (v2) return teamConfigFromManifest(v2);

  // Attempt idempotent migration on first read.
  const migrated = await migrateV1ToV2(teamName, cwd);
  if (migrated) return teamConfigFromManifest(migrated);

  try {
    const p = teamConfigPath(teamName, cwd);
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as TeamConfig;
  } catch {
    return null;
  }
}

// Write worker identity file
export async function writeWorkerIdentity(
  teamName: string,
  workerName: string,
  identity: WorkerInfo,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'identity.json');
  await writeAtomic(p, JSON.stringify(identity, null, 2));
}

// Read worker heartbeat (returns null on missing/malformed)
export async function readWorkerHeartbeat(
  teamName: string,
  workerName: string,
  cwd: string
): Promise<WorkerHeartbeat | null> {
  try {
    const p = join(teamDir(teamName, cwd), 'workers', workerName, 'heartbeat.json');
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isWorkerHeartbeat(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Atomic write worker heartbeat
export async function updateWorkerHeartbeat(
  teamName: string,
  workerName: string,
  heartbeat: WorkerHeartbeat,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'heartbeat.json');
  await writeAtomic(p, JSON.stringify(heartbeat, null, 2));
}

// Read worker status (returns {state:'unknown'} on missing/malformed)
export async function readWorkerStatus(teamName: string, workerName: string, cwd: string): Promise<WorkerStatus> {
  try {
    const p = join(teamDir(teamName, cwd), 'workers', workerName, 'status.json');
    if (!existsSync(p)) {
      return { state: 'unknown', updated_at: new Date().toISOString() };
    }
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isWorkerStatus(parsed)) {
      return { state: 'unknown', updated_at: new Date().toISOString() };
    }
    return parsed;
  } catch {
    return { state: 'unknown', updated_at: new Date().toISOString() };
  }
}

// Write prompt to worker's inbox.md (atomic)
export async function writeWorkerInbox(
  teamName: string,
  workerName: string,
  prompt: string,
  cwd: string
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'inbox.md');
  await writeAtomic(p, prompt);
}

function taskFilePath(teamName: string, taskId: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'tasks', `task-${taskId}.json`);
}

async function withTeamLock<T>(teamName: string, cwd: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = join(teamDir(teamName, cwd), '.lock.create-task');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      // Best-effort stale lock recovery for crashed processes.
      try {
        const info = await stat(lockDir);
        const ageMs = Date.now() - info.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring team task lock for ${teamName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

async function withTaskClaimLock<T>(
  teamName: string,
  taskId: string,
  cwd: string,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lockDir = taskClaimLockDir(teamName, taskId, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const staleLockMs = LOCK_STALE_MS;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      // Best-effort stale lock recovery for abandoned claim locks.
      try {
        const info = await stat(lockDir);
        const ageMs = Date.now() - info.mtimeMs;
        if (ageMs > staleLockMs) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If stat/remove fails, fall through to conflict.
      }
      if (Date.now() > deadline) return { ok: false };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    try {
      await writeTaskClaimLockOwnerToken(ownerPath, ownerToken);
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    return { ok: true, value: await fn() };
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

async function withMailboxLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = mailboxLockDir(teamName, workerName, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      try {
        const info = await stat(lockDir);
        const ageMs = Date.now() - info.mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // best effort
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring mailbox lock for ${teamName}/${workerName}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
      // best effort
    }
  }
}

// Create a task (auto-increment ID)
export async function createTask(
  teamName: string,
  task: Omit<TeamTask, 'id' | 'created_at'>,
  cwd: string
): Promise<TeamTaskV2> {
  return withTeamLock(teamName, cwd, async () => {
    const cfg = await readTeamConfig(teamName, cwd);
    if (!cfg) throw new Error(`Team ${teamName} not found`);

    let nextNumeric = normalizeNextTaskId(cfg.next_task_id);
    if (!hasValidNextTaskId(cfg.next_task_id)) {
      nextNumeric = await computeNextTaskIdFromDisk(teamName, cwd);
    }
    const nextId = String(nextNumeric);

    const created: TeamTaskV2 = {
      ...task,
      id: nextId,
      status: task.status ?? 'pending',
      depends_on: task.depends_on ?? task.blocked_by ?? [],
      version: 1,
      created_at: new Date().toISOString(),
    };

    await writeAtomic(taskFilePath(teamName, nextId, cwd), JSON.stringify(created, null, 2));

    // Advance counter after the task is safely persisted.
    cfg.next_task_id = nextNumeric + 1;
    await writeConfig(cfg, cwd);
    return created;
  });
}

// Read a task (returns null on missing/malformed)
export async function readTask(teamName: string, taskId: string, cwd: string): Promise<TeamTask | null> {
  try {
    const p = taskFilePath(teamName, taskId, cwd);
    if (!existsSync(p)) return null;
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isTeamTask(parsed) ? normalizeTask(parsed) : null;
  } catch {
    return null;
  }
}

// Update a task (merge updates, atomic write)
export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<TeamTask>,
  cwd: string
): Promise<TeamTask | null> {
  const lock = await withTaskClaimLock(teamName, taskId, cwd, async () => {
    const existing = await readTask(teamName, taskId, cwd);
    if (!existing) return null;

    if (updates.status && !['pending', 'blocked', 'in_progress', 'completed', 'failed'].includes(updates.status)) {
      throw new Error(`Invalid task status: ${updates.status}`);
    }

    const merged: TeamTaskV2 = {
      ...normalizeTask(existing),
      ...updates,
      id: existing.id,
      created_at: existing.created_at,
      depends_on: updates.depends_on ?? updates.blocked_by ?? existing.depends_on ?? existing.blocked_by ?? [],
      version: Math.max(1, existing.version ?? 1) + 1,
    };

    await writeAtomic(taskFilePath(teamName, taskId, cwd), JSON.stringify(merged, null, 2));
    return merged;
  });
  if (!lock.ok) {
    throw new Error(`Timed out acquiring task claim lock for ${teamName}/${taskId}`);
  }
  return lock.value;
}

// List all tasks sorted by numeric ID
export async function listTasks(teamName: string, cwd: string): Promise<TeamTask[]> {
  const tasksRoot = join(teamDir(teamName, cwd), 'tasks');
  if (!existsSync(tasksRoot)) return [];

  const files = await readdir(tasksRoot);
  const tasks: TeamTaskV2[] = [];

  for (const f of files) {
    const m = /^task-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const t = await readTask(teamName, m[1], cwd);
    if (t) tasks.push(normalizeTask(t));
  }

  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  return tasks;
}

export async function computeTaskReadiness(teamName: string, taskId: string, cwd: string): Promise<TaskReadiness> {
  const task = await readTask(teamName, taskId, cwd);
  if (!task) return { ready: false, reason: 'blocked_dependency', dependencies: [] };

  const deps = task.depends_on ?? task.blocked_by ?? [];
  if (deps.length === 0) return { ready: true };

  const depTasks = await Promise.all(deps.map((d) => readTask(teamName, d, cwd)));
  const incomplete = deps.filter((_, idx) => {
    const t = depTasks[idx];
    return !t || t.status !== 'completed';
  });

  if (incomplete.length > 0) return { ready: false, reason: 'blocked_dependency', dependencies: incomplete };
  return { ready: true };
}

export async function claimTask(
  teamName: string,
  taskId: string,
  workerName: string,
  expectedVersion: number | null,
  cwd: string
): Promise<ClaimTaskResult> {
  const readiness = await computeTaskReadiness(teamName, taskId, cwd);
  if (!readiness.ready) {
    return { ok: false, error: 'blocked_dependency', dependencies: readiness.dependencies };
  }

  const lock = await withTaskClaimLock(teamName, taskId, cwd, async () => {
    const current = await readTask(teamName, taskId, cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };
    const v = normalizeTask(current);
    if (expectedVersion !== null && v.version !== expectedVersion) {
      return { ok: false as const, error: 'claim_conflict' as const };
    }

    const claimToken = randomUUID();
    const leasedUntil = new Date(Date.now() + DEFAULT_CLAIM_LEASE_MS).toISOString();
    const updated: TeamTaskV2 = {
      ...v,
      status: 'in_progress',
      owner: workerName,
      claim: { owner: workerName, token: claimToken, leased_until: leasedUntil },
      version: v.version + 1,
    };

    await writeAtomic(taskFilePath(teamName, taskId, cwd), JSON.stringify(updated, null, 2));
    return { ok: true as const, task: updated, claimToken };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };
  return lock.value;
}

export async function transitionTaskStatus(
  teamName: string,
  taskId: string,
  from: TeamTask['status'],
  to: TeamTask['status'],
  claimToken: string,
  cwd: string
): Promise<TransitionTaskResult> {
  let emittedEvent: TeamEvent | null = null;
  const lock = await withTaskClaimLock(teamName, taskId, cwd, async () => {
    const current = await readTask(teamName, taskId, cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };
    const v = normalizeTask(current);

    if (v.status !== from) return { ok: false as const, error: 'invalid_transition' as const };
    if (!v.claim || v.claim.token !== claimToken) return { ok: false as const, error: 'claim_conflict' as const };

    const updated: TeamTaskV2 = {
      ...v,
      status: to,
      completed_at: to === 'completed' || to === 'failed' ? new Date().toISOString() : v.completed_at,
      version: v.version + 1,
    };
    await writeAtomic(taskFilePath(teamName, taskId, cwd), JSON.stringify(updated, null, 2));
    if (to === 'completed') {
      emittedEvent = await appendTeamEvent(
        teamName,
        {
          type: 'task_completed',
          worker: updated.owner || 'unknown',
          task_id: updated.id,
          message_id: null,
          reason: undefined,
        },
        cwd
      );
    } else if (to === 'failed') {
      emittedEvent = await appendTeamEvent(
        teamName,
        {
          type: 'worker_stopped',
          worker: updated.owner || 'unknown',
          task_id: updated.id,
          message_id: null,
          reason: updated.error || 'task_failed',
        },
        cwd
      );
    }
    return { ok: true as const, task: updated };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };
  void emittedEvent;
  return lock.value;
}

export async function releaseTaskClaim(
  teamName: string,
  taskId: string,
  claimToken: string,
  workerName: string,
  cwd: string
): Promise<ReleaseTaskClaimResult> {
  const lock = await withTaskClaimLock(teamName, taskId, cwd, async () => {
    const current = await readTask(teamName, taskId, cwd);
    if (!current) return { ok: false as const, error: 'task_not_found' as const };
    const v = normalizeTask(current);
    if (v.status === 'pending' && !v.claim && !v.owner) {
      return { ok: true as const, task: v };
    }

    const tokenMatches = Boolean(v.claim && v.claim.token === claimToken);
    const ownerMatches = v.status === 'in_progress' && v.owner === workerName;
    if (!tokenMatches && !ownerMatches) {
      return { ok: false as const, error: 'claim_conflict' as const };
    }

    const updated: TeamTaskV2 = {
      ...v,
      status: 'pending',
      owner: undefined,
      claim: undefined,
      version: v.version + 1,
    };
    await writeAtomic(taskFilePath(teamName, taskId, cwd), JSON.stringify(updated, null, 2));
    return { ok: true as const, task: updated };
  });

  if (!lock.ok) return { ok: false, error: 'claim_conflict' };
  return lock.value;
}

export async function appendTeamEvent(teamName: string, event: Omit<TeamEvent, 'event_id' | 'created_at' | 'team'>, cwd: string): Promise<TeamEvent> {
  const full: TeamEvent = {
    event_id: randomUUID(),
    team: teamName,
    created_at: new Date().toISOString(),
    ...event,
  };
  const p = eventLogPath(teamName, cwd);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(full)}\n`, 'utf8');
  return full;
}

async function readMailbox(teamName: string, workerName: string, cwd: string): Promise<TeamMailbox> {
  const p = mailboxPath(teamName, workerName, cwd);
  try {
    if (!existsSync(p)) return { worker: workerName, messages: [] };
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return { worker: workerName, messages: [] };
    const v = parsed as { worker?: unknown; messages?: unknown };
    if (v.worker !== workerName || !Array.isArray(v.messages)) return { worker: workerName, messages: [] };
    return { worker: workerName, messages: v.messages as TeamMailboxMessage[] };
  } catch {
    return { worker: workerName, messages: [] };
  }
}

async function writeMailbox(teamName: string, mailbox: TeamMailbox, cwd: string): Promise<void> {
  const p = mailboxPath(teamName, mailbox.worker, cwd);
  await writeAtomic(p, JSON.stringify(mailbox, null, 2));
}

export async function sendDirectMessage(
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  cwd: string
): Promise<TeamMailboxMessage> {
  const msg: TeamMailboxMessage = {
    message_id: randomUUID(),
    from_worker: fromWorker,
    to_worker: toWorker,
    body,
    created_at: new Date().toISOString(),
  };
  await withMailboxLock(teamName, toWorker, cwd, async () => {
    const mailbox = await readMailbox(teamName, toWorker, cwd);
    mailbox.messages.push(msg);
    await writeMailbox(teamName, mailbox, cwd);
  });

  await appendTeamEvent(
    teamName,
    { type: 'message_received', worker: toWorker, task_id: undefined, message_id: msg.message_id, reason: undefined },
    cwd
  );
  return msg;
}

export async function broadcastMessage(
  teamName: string,
  fromWorker: string,
  body: string,
  cwd: string
): Promise<TeamMailboxMessage[]> {
  const cfg = await readTeamConfig(teamName, cwd);
  if (!cfg) throw new Error(`Team ${teamName} not found`);
  const targets = cfg.workers.map((w) => w.name);
  const delivered: TeamMailboxMessage[] = [];
  for (const to of targets) {
    if (to === fromWorker) continue;
    delivered.push(await sendDirectMessage(teamName, fromWorker, to, body, cwd));
  }
  return delivered;
}

export async function markMessageDelivered(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string
): Promise<boolean> {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    if (!msg.delivered_at) {
      msg.delivered_at = new Date().toISOString();
      await writeMailbox(teamName, mailbox, cwd);
    }
    return true;
  });
}

export async function markMessageNotified(
  teamName: string,
  workerName: string,
  messageId: string,
  cwd: string
): Promise<boolean> {
  return withMailboxLock(teamName, workerName, cwd, async () => {
    const mailbox = await readMailbox(teamName, workerName, cwd);
    const msg = mailbox.messages.find((m) => m.message_id === messageId);
    if (!msg) return false;
    msg.notified_at = new Date().toISOString();
    await writeMailbox(teamName, mailbox, cwd);
    return true;
  });
}

export async function listMailboxMessages(
  teamName: string,
  workerName: string,
  cwd: string
): Promise<TeamMailboxMessage[]> {
  const mailbox = await readMailbox(teamName, workerName, cwd);
  return mailbox.messages;
}

export async function writeTaskApproval(
  teamName: string,
  approval: TaskApprovalRecord,
  cwd: string
): Promise<void> {
  const p = approvalPath(teamName, approval.task_id, cwd);
  await writeAtomic(p, JSON.stringify(approval, null, 2));
  await appendTeamEvent(
    teamName,
    {
      type: 'approval_decision',
      worker: approval.reviewer,
      task_id: approval.task_id,
      message_id: null,
      reason: `${approval.status}:${approval.decision_reason}`,
    },
    cwd
  );
}

export async function readTaskApproval(
  teamName: string,
  taskId: string,
  cwd: string
): Promise<TaskApprovalRecord | null> {
  const p = approvalPath(teamName, taskId, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as TaskApprovalRecord;
    if (parsed.task_id !== taskId) return null;
    if (!['pending', 'approved', 'rejected'].includes(parsed.status)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Get team summary with aggregation and non-reporting worker detection
export async function getTeamSummary(teamName: string, cwd: string): Promise<TeamSummary | null> {
  const cfg = await readTeamConfig(teamName, cwd);
  if (!cfg) return null;

  const tasks = await listTasks(teamName, cwd);
  const previousSnapshot = await readSummarySnapshot(teamName, cwd);
  const counts = {
    total: tasks.length,
    pending: 0,
    blocked: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  };

  for (const t of tasks) {
    if (t.status === 'pending') counts.pending++;
    else if (t.status === 'blocked') counts.blocked++;
    else if (t.status === 'in_progress') counts.in_progress++;
    else if (t.status === 'completed') counts.completed++;
    else if (t.status === 'failed') counts.failed++;
  }

  const workers = cfg.workers || [];
  const workerSummaries: TeamSummary['workers'] = [];
  const nonReportingWorkers: string[] = [];
  const nextSnapshot: TeamSummarySnapshot = {
    workerTurnCountByName: {},
    workerTaskByName: {},
  };

  for (const w of workers) {
    const hb = await readWorkerHeartbeat(teamName, w.name, cwd);
    const status = await readWorkerStatus(teamName, w.name, cwd);

    const alive = hb?.alive ?? false;
    const lastTurnAt = hb?.last_turn_at ?? null;

    const currentTaskId = status.current_task_id ?? '';
    const prevTaskId = previousSnapshot?.workerTaskByName[w.name] ?? '';
    const prevTurnCount = previousSnapshot?.workerTurnCountByName[w.name] ?? 0;
    const currentTask = currentTaskId ? await readTask(teamName, currentTaskId, cwd) : null;

    const turnsWithoutProgress =
      hb &&
      status.state === 'working' &&
      currentTask &&
      (currentTask.status === 'pending' || currentTask.status === 'in_progress') &&
      currentTaskId === prevTaskId
        ? Math.max(0, hb.turn_count - prevTurnCount)
        : 0;

    if (alive && status.state === 'working' && turnsWithoutProgress > 5) {
      nonReportingWorkers.push(w.name);
    }

    workerSummaries.push({ name: w.name, alive, lastTurnAt, turnsWithoutProgress });
    nextSnapshot.workerTurnCountByName[w.name] = hb?.turn_count ?? 0;
    nextSnapshot.workerTaskByName[w.name] = currentTaskId;
  }

  await writeSummarySnapshot(teamName, nextSnapshot, cwd);

  return {
    teamName: cfg.name,
    workerCount: cfg.worker_count,
    tasks: counts,
    workers: workerSummaries,
    nonReportingWorkers,
  };
}

async function readSummarySnapshot(teamName: string, cwd: string): Promise<TeamSummarySnapshot | null> {
  const p = summarySnapshotPath(teamName, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TeamSummarySnapshot>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskByName: parsed.workerTaskByName ?? {},
    };
  } catch {
    return null;
  }
}

async function writeSummarySnapshot(teamName: string, snapshot: TeamSummarySnapshot, cwd: string): Promise<void> {
  await writeAtomic(summarySnapshotPath(teamName, cwd), JSON.stringify(snapshot, null, 2));
}

// === Shutdown control ===

export interface ShutdownAck {
  status: 'accept' | 'reject';
  reason?: string;
  updated_at?: string;
}

export async function writeShutdownRequest(
  teamName: string,
  workerName: string,
  requestedBy: string,
  cwd: string,
): Promise<void> {
  const p = join(teamDir(teamName, cwd), 'workers', workerName, 'shutdown-request.json');
  await writeAtomic(p, JSON.stringify({ requested_at: new Date().toISOString(), requested_by: requestedBy }, null, 2));
}

export async function readShutdownAck(
  teamName: string,
  workerName: string,
  cwd: string,
  minUpdatedAt?: string,
): Promise<ShutdownAck | null> {
  const ackPath = join(teamDir(teamName, cwd), 'workers', workerName, 'shutdown-ack.json');
  if (!existsSync(ackPath)) return null;
  try {
    const raw = await readFile(ackPath, 'utf-8');
    const parsed = JSON.parse(raw) as ShutdownAck;
    if (parsed.status !== 'accept' && parsed.status !== 'reject') return null;
    if (typeof minUpdatedAt === 'string' && minUpdatedAt.trim() !== '') {
      const minTs = Date.parse(minUpdatedAt);
      const ackTs = Date.parse(parsed.updated_at ?? '');
      if (!Number.isFinite(minTs) || !Number.isFinite(ackTs) || ackTs < minTs) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// === Monitor snapshot ===

export interface TeamMonitorSnapshotState {
  taskStatusById: Record<string, string>;
  workerAliveByName: Record<string, boolean>;
  workerStateByName: Record<string, string>;
  workerTurnCountByName: Record<string, number>;
  workerTaskIdByName: Record<string, string>;
  mailboxNotifiedByMessageId: Record<string, string>;
}

function monitorSnapshotPath(teamName: string, cwd: string): string {
  return join(teamDir(teamName, cwd), 'monitor-snapshot.json');
}

export async function readMonitorSnapshot(
  teamName: string,
  cwd: string,
): Promise<TeamMonitorSnapshotState | null> {
  const p = monitorSnapshotPath(teamName, cwd);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TeamMonitorSnapshotState>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      taskStatusById: parsed.taskStatusById ?? {},
      workerAliveByName: parsed.workerAliveByName ?? {},
      workerStateByName: parsed.workerStateByName ?? {},
      workerTurnCountByName: parsed.workerTurnCountByName ?? {},
      workerTaskIdByName: parsed.workerTaskIdByName ?? {},
      mailboxNotifiedByMessageId: parsed.mailboxNotifiedByMessageId ?? {},
    };
  } catch {
    return null;
  }
}

export async function writeMonitorSnapshot(
  teamName: string,
  snapshot: TeamMonitorSnapshotState,
  cwd: string,
): Promise<void> {
  await writeAtomic(monitorSnapshotPath(teamName, cwd), JSON.stringify(snapshot, null, 2));
}

// === Config persistence (public wrapper) ===

export async function saveTeamConfig(config: TeamConfig, cwd: string): Promise<void> {
  await writeConfig(config, cwd);
}

// Delete team state directory
export async function cleanupTeamState(teamName: string, cwd: string): Promise<void> {
  await rm(teamDir(teamName, cwd), { recursive: true, force: true });
}
