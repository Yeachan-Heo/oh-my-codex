import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { appendTeamCommitHygieneEntries, type TeamOperationalCommitEntry, type TeamOperationalCommitKind } from '../../team/commit-hygiene.js';
import { appendTeamEvent } from '../../team/state.js';
import { resolveWorkerTeamStateRoot } from '../../team/state-root.js';

const execFileAsync = promisify(execFile);

type PostToolUseStatus = 'applied' | 'noop' | 'conflict' | 'skipped';
type PostToolUseOperationKind = 'auto_checkpoint' | 'worker_clean_rebase' | 'leader_integration_attempt';

type JsonRecord = Record<string, unknown>;

export interface TeamWorkerPostToolUseResult {
  handled: boolean;
  status: PostToolUseStatus;
  reason?: string;
  teamName?: string;
  workerName?: string;
  stateRoot?: string;
  worktreePath?: string;
  workerHeadBefore?: string | null;
  workerHeadAfter?: string | null;
  checkpointCommit?: string | null;
  leaderHeadObserved?: string | null;
  operationKinds: PostToolUseOperationKind[];
  dedupeKey?: string;
}

interface ParsedTeamWorkerEnv {
  teamName: string;
  workerName: string;
}

interface DedupeMarker {
  version: 1;
  updated_at: string;
  latest_key?: string;
  keys: string[];
  entries: Array<{ dedupe_key: string; created_at: string; tool_use_id?: string; status: PostToolUseStatus }>;
}

const PROTECTED_PATH_PREFIXES = [
  '.omx/state/',
  '.omx/logs/',
  '.omx/reports/',
];
const PROTECTED_PATH_SUFFIXES = [
  '.pid',
  '.lock',
  '.tmp',
];
const PROTECTED_PATH_EXACT = new Set([
  'AGENTS.md',
]);

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseTeamWorkerEnv(raw: unknown): ParsedTeamWorkerEnv | null {
  const value = safeString(raw).trim();
  const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(value);
  return match ? { teamName: match[1]!, workerName: match[2]! } : null;
}

function readHookEvent(payload: JsonRecord): string {
  return safeString(payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? payload.name).trim();
}

function readToolName(payload: JsonRecord): string {
  return safeString(payload.tool_name ?? payload.toolName ?? payload.tool).trim();
}

function readExitCode(payload: JsonRecord): number | null {
  const response = safeRecord(payload.tool_response ?? payload.toolResponse ?? payload.result);
  for (const source of [payload, response]) {
    for (const key of ['exit_code', 'exitCode', 'code', 'status']) {
      const value = source[key];
      if (typeof value === 'number' && Number.isInteger(value)) return value;
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
    }
  }
  return null;
}

function readToolUseId(payload: JsonRecord): string | undefined {
  const value = safeString(payload.tool_use_id ?? payload.toolUseId ?? payload.id).trim();
  return value || undefined;
}

async function readJsonIfExists(path: string): Promise<JsonRecord | null> {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function gitMaybe(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; stderr: string }> {
  try {
    return { ok: true, stdout: await git(cwd, args) };
  } catch (error) {
    const err = error as { stderr?: unknown; message?: string };
    return { ok: false, stderr: safeString(err.stderr) || safeString(err.message) };
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  const result = await gitMaybe(cwd, ['rev-parse', '--verify', 'HEAD']);
  return result.ok ? result.stdout : null;
}

async function hasGitOperationInProgress(cwd: string): Promise<string | null> {
  const gitDirResult = await gitMaybe(cwd, ['rev-parse', '--git-dir']);
  if (!gitDirResult.ok) return 'not_git_repository';
  const gitDir = resolve(cwd, gitDirResult.stdout);
  const paths = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge',
    'rebase-apply',
  ];
  for (const path of paths) {
    if (existsSync(join(gitDir, path))) return path;
  }
  return null;
}

function parsePorcelainPaths(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const raw = line.slice(3).trim();
      const renameTarget = raw.includes(' -> ') ? raw.split(' -> ').at(-1)! : raw;
      return renameTarget.replace(/^"|"$/g, '');
    })
    .filter(Boolean);
}

function isProtectedCheckpointPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (PROTECTED_PATH_EXACT.has(normalized)) return true;
  if (normalized.includes('/posttooluse-dedupe.json') || normalized.endsWith('/posttooluse-dedupe.json')) return true;
  if (PROTECTED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  if (PROTECTED_PATH_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  return false;
}

async function readTeamConfig(stateRoot: string, teamName: string): Promise<JsonRecord | null> {
  return readJsonIfExists(join(stateRoot, 'team', teamName, 'config.json'));
}

function readLeaderArtifactCwd(config: JsonRecord | null, fallbackCwd: string): string {
  const leaderCwd = safeString(config?.leader_cwd ?? config?.leaderCwd).trim();
  return leaderCwd ? resolve(fallbackCwd, leaderCwd) : fallbackCwd;
}

async function readLeaderHeadObserved(config: JsonRecord | null, fallbackCwd: string): Promise<string | null> {
  const leaderCwd = safeString(config?.leader_cwd ?? config?.leaderCwd).trim();
  if (leaderCwd) {
    const head = await gitMaybe(resolve(fallbackCwd, leaderCwd), ['rev-parse', '--verify', 'HEAD']);
    if (head.ok && head.stdout) return head.stdout;
  }
  const value = safeString(config?.leader_head ?? config?.leaderHead ?? config?.leader_head_observed).trim();
  return value || null;
}

async function readTeamPhaseTerminal(stateRoot: string, teamName: string): Promise<boolean> {
  const phase = await readJsonIfExists(join(stateRoot, 'team', teamName, 'phase.json'));
  const current = safeString(phase?.current_phase ?? phase?.phase).trim();
  return current === 'complete' || current === 'failed' || current === 'cancelled';
}

async function writeHeartbeat(stateRoot: string, teamName: string, workerName: string, nowIso: string): Promise<void> {
  const dir = join(stateRoot, 'team', teamName, 'workers', workerName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'heartbeat.json'), JSON.stringify({ last_turn_at: nowIso, source: 'posttooluse' }, null, 2));
}

async function readDedupeMarker(path: string): Promise<DedupeMarker> {
  const parsed = await readJsonIfExists(path);
  const keys = Array.isArray(parsed?.keys) ? parsed.keys.filter((key): key is string => typeof key === 'string') : [];
  const entries = Array.isArray(parsed?.entries)
    ? parsed.entries.filter((entry): entry is DedupeMarker['entries'][number] => !!entry && typeof entry === 'object' && typeof (entry as JsonRecord).dedupe_key === 'string')
    : [];
  return {
    version: 1,
    updated_at: safeString(parsed?.updated_at) || new Date(0).toISOString(),
    latest_key: safeString(parsed?.latest_key) || undefined,
    keys,
    entries,
  };
}

function buildDedupeKey(params: {
  teamName: string;
  workerName: string;
  workerHeadAfter: string | null;
  operationKind: PostToolUseOperationKind;
}): string {
  return [
    params.teamName,
    params.workerName,
    params.workerHeadAfter ?? '',
    params.operationKind,
  ].join('|');
}

async function appendLeaderSignal(params: {
  teamName: string;
  workerName: string;
  workerHeadBefore: string | null;
  workerHeadAfter: string | null;
  checkpointCommit: string | null;
  leaderHeadObserved: string | null;
  outcomeStatus: PostToolUseStatus;
  toolUseId?: string;
  dedupeKey: string;
  worktreePath: string;
  leaderArtifactCwd: string;
}): Promise<void> {
  await appendTeamEvent(params.teamName, {
    type: 'worker_integration_attempt_requested',
    worker: params.workerName,
    metadata: {
      worker_head_before: params.workerHeadBefore,
      worker_head_after: params.workerHeadAfter,
      checkpoint_commit: params.checkpointCommit,
      leader_head_observed: params.leaderHeadObserved,
      operation_kind: 'leader_integration_attempt',
      outcome_status: params.outcomeStatus,
      tool_use_id: params.toolUseId,
      dedupe_key: params.dedupeKey,
      worktree_path: params.worktreePath,
      source: 'posttooluse',
    },
  }, params.leaderArtifactCwd);
}

async function appendLedger(params: {
  teamName: string;
  workerName: string;
  cwd: string;
  leaderArtifactCwd: string;
  operation: TeamOperationalCommitKind;
  status: PostToolUseStatus;
  workerHeadBefore: string | null;
  workerHeadAfter: string | null;
  leaderHeadObserved: string | null;
  operationalCommit?: string | null;
  sourceCommit?: string | null;
  detail?: string;
}): Promise<void> {
  const entry: TeamOperationalCommitEntry = {
    recorded_at: new Date().toISOString(),
    operation: params.operation,
    worker_name: params.workerName,
    status: params.status,
    operational_commit: params.operationalCommit ?? null,
    source_commit: params.sourceCommit ?? null,
    leader_head_before: params.leaderHeadObserved,
    leader_head_after: params.leaderHeadObserved,
    worker_head_before: params.workerHeadBefore,
    worker_head_after: params.workerHeadAfter,
    worktree_path: params.cwd,
    detail: params.detail,
  };
  await appendTeamCommitHygieneEntries(params.teamName, [entry], params.leaderArtifactCwd);
}

async function writeDedupeMarker(path: string, params: {
  dedupeKey: string;
  createdAt: string;
  toolUseId?: string;
  status: PostToolUseStatus;
}): Promise<void> {
  await mkdir(resolve(path, '..'), { recursive: true });
  const marker = await readDedupeMarker(path);
  const keys = marker.keys.includes(params.dedupeKey) ? marker.keys : [...marker.keys, params.dedupeKey].slice(-100);
  const entries = [
    ...marker.entries.filter((entry) => entry.dedupe_key !== params.dedupeKey),
    {
      dedupe_key: params.dedupeKey,
      created_at: params.createdAt,
      tool_use_id: params.toolUseId,
      status: params.status,
    },
  ].slice(-100);
  await writeFile(path, JSON.stringify({
    version: 1,
    updated_at: params.createdAt,
    latest_key: params.dedupeKey,
    keys,
    entries,
  }, null, 2));
}

async function classifyCleanScaffolding(cwd: string, leaderHeadObserved: string | null, workerHeadAfter: string | null): Promise<{ status: PostToolUseStatus; reason: string }> {
  if (!leaderHeadObserved) return { status: 'skipped', reason: 'no_leader_head_observed' };
  if (!workerHeadAfter) return { status: 'skipped', reason: 'no_worker_head' };
  if (leaderHeadObserved === workerHeadAfter) return { status: 'noop', reason: 'worker_already_at_leader' };

  const leaderAncestor = await gitMaybe(cwd, ['merge-base', '--is-ancestor', leaderHeadObserved, workerHeadAfter]);
  if (leaderAncestor.ok) return { status: 'noop', reason: 'leader_is_worker_ancestor' };

  const workerAncestor = await gitMaybe(cwd, ['merge-base', '--is-ancestor', workerHeadAfter, leaderHeadObserved]);
  if (workerAncestor.ok) return { status: 'skipped', reason: 'worker_behind_leader_defer_to_leader_integration' };

  return { status: 'skipped', reason: 'non_fast_forward_defer_to_leader_integration' };
}

async function unstageCheckpointablePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const restore = await gitMaybe(cwd, ['restore', '--staged', '--', ...paths]);
  if (restore.ok) return;
  await gitMaybe(cwd, ['reset', '-q', '--', ...paths]);
}

async function checkpointIfEligible(cwd: string, workerName: string): Promise<{
  status: PostToolUseStatus;
  reason?: string;
  checkpointCommit: string | null;
  workerHeadAfter: string | null;
}> {
  const inProgress = await hasGitOperationInProgress(cwd);
  if (inProgress) {
    return { status: inProgress === 'not_git_repository' ? 'skipped' : 'skipped', reason: inProgress, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
  if (unmerged.trim()) {
    return { status: 'conflict', reason: 'unmerged_paths', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const staged = await git(cwd, ['diff', '--name-only', '--cached']);
  if (staged.trim()) {
    return { status: 'skipped', reason: 'index_not_clean', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const status = await git(cwd, ['status', '--porcelain=v1', '-uall']);
  const paths = parsePorcelainPaths(status);
  if (paths.length === 0) {
    return { status: 'noop', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const checkpointable = paths.filter((path) => !isProtectedCheckpointPath(path));
  if (checkpointable.length === 0) {
    const onlyRuntimeArtifacts = paths.every((path) => {
      const normalized = path.replace(/\\/g, '/');
      return normalized.startsWith('.omx/state/') || normalized.startsWith('.omx/logs/') || normalized.startsWith('.omx/reports/');
    });
    return onlyRuntimeArtifacts
      ? { status: 'noop', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) }
      : { status: 'skipped', reason: 'only_protected_paths_changed', checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const addResult = await gitMaybe(cwd, ['add', '--', ...checkpointable]);
  if (!addResult.ok) {
    await unstageCheckpointablePaths(cwd, checkpointable);
    return { status: 'skipped', reason: `git_add_failed:${addResult.stderr.slice(0, 120)}`, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const commitResult = await gitMaybe(cwd, ['commit', '--no-verify', '-m', `omx(team): auto-checkpoint ${workerName}`]);
  if (!commitResult.ok) {
    await unstageCheckpointablePaths(cwd, checkpointable);
    const reason = commitResult.stderr.includes('conflict') ? 'git_commit_conflict' : `git_commit_failed:${commitResult.stderr.slice(0, 120)}`;
    return { status: reason.includes('conflict') ? 'conflict' : 'skipped', reason, checkpointCommit: null, workerHeadAfter: await gitHead(cwd) };
  }

  const head = await gitHead(cwd);
  return { status: 'applied', checkpointCommit: head, workerHeadAfter: head };
}

export async function handleTeamWorkerPostToolUseSuccess(
  payload: JsonRecord,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TeamWorkerPostToolUseResult> {
  try {
    if (readHookEvent(payload) !== 'PostToolUse') return { handled: false, status: 'skipped', reason: 'not_posttooluse', operationKinds: [] };
    if (readToolName(payload) !== 'Bash') return { handled: false, status: 'skipped', reason: 'not_bash', operationKinds: [] };
    if (readExitCode(payload) !== 0) return { handled: false, status: 'skipped', reason: 'nonzero_exit', operationKinds: [] };

    const parsedWorker = parseTeamWorkerEnv(env.OMX_TEAM_WORKER);
    if (!parsedWorker) return { handled: false, status: 'skipped', reason: 'missing_worker_env', operationKinds: [] };

    const resolvedStateRoot = await resolveWorkerTeamStateRoot(cwd, parsedWorker, env);
    if (!resolvedStateRoot.ok || !resolvedStateRoot.stateRoot) {
      return {
        handled: false,
        status: 'skipped',
        reason: resolvedStateRoot.reason || 'missing_team_root',
        teamName: parsedWorker.teamName,
        workerName: parsedWorker.workerName,
        operationKinds: [],
      };
    }

    const { teamName, workerName } = parsedWorker;
    const stateRoot = resolvedStateRoot.stateRoot;
    const worktreePath = resolvedStateRoot.worktreePath || resolve(cwd);
    if (await readTeamPhaseTerminal(stateRoot, teamName)) {
      return { handled: false, status: 'skipped', reason: 'terminal_phase', teamName, workerName, stateRoot, worktreePath, operationKinds: [] };
    }

    const nowIso = new Date().toISOString();
    await writeHeartbeat(stateRoot, teamName, workerName, nowIso);

    const config = await readTeamConfig(stateRoot, teamName);
    const leaderArtifactCwd = readLeaderArtifactCwd(config, cwd);
    const workerHeadBefore = await gitHead(cwd);
    const leaderHeadObserved = await readLeaderHeadObserved(config, cwd);
    const checkpoint = await checkpointIfEligible(cwd, workerName);
    const workerHeadAfter = checkpoint.workerHeadAfter;
    const operationKinds: PostToolUseOperationKind[] = ['auto_checkpoint'];
    await appendLedger({
      teamName,
      workerName,
      cwd,
      leaderArtifactCwd,
      operation: 'auto_checkpoint',
      status: checkpoint.status,
      workerHeadBefore,
      workerHeadAfter,
      leaderHeadObserved,
      operationalCommit: checkpoint.checkpointCommit,
      sourceCommit: workerHeadBefore,
      detail: checkpoint.reason ? `posttooluse:${checkpoint.reason}` : 'posttooluse',
    });

    const cleanScaffolding = await classifyCleanScaffolding(cwd, leaderHeadObserved, workerHeadAfter);
    operationKinds.push('worker_clean_rebase');
    await appendLedger({
      teamName,
      workerName,
      cwd,
      leaderArtifactCwd,
      operation: 'worker_clean_rebase',
      status: cleanScaffolding.status,
      workerHeadBefore,
      workerHeadAfter,
      leaderHeadObserved,
      sourceCommit: workerHeadAfter,
      detail: `posttooluse:${cleanScaffolding.reason}`,
    });

    if (workerHeadAfter) operationKinds.push('leader_integration_attempt');
    const dedupeKey = buildDedupeKey({
      teamName,
      workerName,
      workerHeadAfter,
      operationKind: 'leader_integration_attempt',
    });
    const dedupePath = join(stateRoot, 'team', teamName, 'workers', workerName, 'posttooluse-dedupe.json');
    const marker = await readDedupeMarker(dedupePath);

    if (workerHeadAfter && !marker.keys.includes(dedupeKey)) {
      await appendLeaderSignal({
        teamName,
        workerName,
        workerHeadBefore,
        workerHeadAfter,
        checkpointCommit: checkpoint.checkpointCommit,
        leaderHeadObserved,
        outcomeStatus: checkpoint.status,
        toolUseId: readToolUseId(payload),
        dedupeKey,
        worktreePath,
        leaderArtifactCwd,
      });
      await appendLedger({
        teamName,
        workerName,
        cwd,
        leaderArtifactCwd,
        operation: 'leader_integration_attempt',
        status: checkpoint.status,
        workerHeadBefore,
        workerHeadAfter,
        leaderHeadObserved,
        sourceCommit: workerHeadAfter,
        detail: `posttooluse:${dedupeKey}`,
      });
      await writeDedupeMarker(dedupePath, {
        dedupeKey,
        createdAt: nowIso,
        toolUseId: readToolUseId(payload),
        status: checkpoint.status,
      });
    }

    return {
      handled: true,
      status: checkpoint.status,
      reason: checkpoint.reason,
      teamName,
      workerName,
      stateRoot,
      worktreePath,
      workerHeadBefore,
      workerHeadAfter,
      checkpointCommit: checkpoint.checkpointCommit,
      leaderHeadObserved,
      operationKinds,
      dedupeKey,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { handled: false, status: 'skipped', reason: `bridge_error:${reason}`, operationKinds: [] };
  }
}

export const teamWorkerPostToolUseInternals = {
  buildDedupeKey,
  isProtectedCheckpointPath,
  parsePorcelainPaths,
};
