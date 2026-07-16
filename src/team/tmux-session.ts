import { spawnSync, execFile } from 'child_process';
import { promisify } from 'util';
import { closeSync, chmodSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  CODEX_BYPASS_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  MADMAX_FLAG,
  CONFIG_FLAG,
  LONG_CONFIG_FLAG,
  MODEL_FLAG,
} from '../cli/constants.js';
import { getAgent } from '../agents/definitions.js';
import {
  buildCapturePaneArgv as sharedBuildCapturePaneArgv,
  buildVisibleCapturePaneArgv as sharedBuildVisibleCapturePaneArgv,
  normalizeTmuxCapture as sharedNormalizeTmuxCapture,
  paneHasActiveTask as sharedPaneHasActiveTask,
  paneIsBootstrapping as sharedPaneIsBootstrapping,
  paneShowsCodexViewport as sharedPaneShowsCodexViewport,
  paneLooksReady as sharedPaneLooksReady,
} from '../scripts/tmux-hook-engine.js';
import { readActiveProviderEnvOverrides } from '../config/models.js';
import {
  classifyTeamWorkerLaunchPolicy,
  extractModelProviderOverrideValue,
  normalizeTeamWorkerLaunchArgs,
  parseTeamWorkerLaunchArgs,
} from './model-contract.js';

import { sleep, sleepSync } from '../utils/sleep.js';
import {
  buildPlatformCommandSpec,
  classifySpawnError,
  resolveCommandPathForPlatform,
  spawnPlatformCommandSync,
} from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import { readExactPaneProof, readExactPaneProofsSync, readExactPaneProofSync, type ExactPaneProof } from './exact-pane.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';

const execFileAsync = promisify(execFile);
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_TEAM_HEIGHT_LINES } from '../hud/constants.js';
import { OMX_TMUX_HUD_OWNER_ENV } from '../hud/reconcile.js';
import { findHudWatchPaneIds, hudPaneMatchesOwner, OMX_TMUX_HUD_LEADER_PANE_ENV } from '../hud/tmux.js';

const OMX_INSTANCE_OPTION = '@omx_instance_id';
const OMX_PANE_INSTANCE_OPTION = '@omx_pane_instance_id';
const OMX_TEAM_PANE_OWNER_OPTION = '@omx_team_pane_owner_id';


type ProcessLiveness = 'alive' | 'gone' | 'unknown';

/** `kill(pid, 0)` establishes absence only on ESRCH. */
function probeProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';
  }
}

export interface TeamSession {
  name: string; // tmux target in "session:window" form
  /** Frozen tmux session incarnation persisted before any detached teardown. */
  tmuxSessionId?: string;
  tmuxSessionCreated?: string;
  workerCount: number;
  cwd: string;
  workerPaneIds: string[];
  /** Original worker-index slots for partial recovery; null means no unresolved pane at that index. */
  workerPaneIdsByIndex?: Array<string | null>;
  /** Frozen worker pane process identities aligned with workerPaneIdsByIndex. */
  workerPanePidsByIndex?: Array<number | null>;
  /** Leader's own pane ID — must never be targeted by worker cleanup routines. */
  leaderPaneId: string;
  /** Frozen leader pane process identity for startup and recovery authority. */
  leaderPanePid?: number;
  /** HUD pane spawned below the leader column, or null if creation failed. */
  hudPaneId: string | null;
  /** Frozen HUD pane process identity for startup and recovery authority. */
  hudPanePid?: number | null;

  /** Registered tmux resize hook name for the HUD pane, or null if unavailable. */
  resizeHookName: string | null;
  /** Registered tmux resize hook target in "<session>:<window>" form, or null. */
  resizeHookTarget: string | null;
  /** Team-scoped tmux pane ownership token used by shutdown safety checks. */
  teamPaneOwnerId: string;
}

/** Carries live tmux resources when creation cannot safely roll them back. */
export class CreateTeamSessionPartialError extends Error {
  constructor(
    readonly partialSession: TeamSession,
    readonly proofUnavailable: Array<Extract<ExactPaneProof, { status: 'unavailable' }>>,
    readonly originalError: unknown,
    /** Cleanup commands that failed after resources were created and must be retried. */
    readonly cleanupErrors: string[] = [],
  ) {
    super('create_team_session_cleanup_incomplete');
    this.name = 'CreateTeamSessionPartialError';
  }
}

class ExactPaneProofUnavailableError extends Error {
  constructor(readonly proof: Extract<ExactPaneProof, { status: 'unavailable' }>) {
    super(`exact_pane_proof_unavailable:${proof.paneId}:${proof.reason}`);
    this.name = 'ExactPaneProofUnavailableError';
  }
}

export interface CreateTeamSessionOptions {
  /**
   * Stable logical leader id forwarded to HUD/hook runtime and the generic
   * tmux pane instance tag. Team shutdown must not rely on this value because
   * environment session ids can be stale when a user starts OMX from another
   * tmux pane in the same shell/session.
   */
  ownerSessionId?: string | null;
  /** Team-scoped pane owner token used only for Team shutdown/teardown. */
  teamPaneOwnerId?: string | null;
}

export interface RestoreStandaloneHudPaneOptions {
  /** Session id that prompt-submit HUD reconciliation should use to dedupe the restored HUD. */
  sessionId?: string | null;
  /** Explicit HUD cwd override. When omitted, the live leader pane cwd is preferred over team launch cwd. */
  cwd?: string | null;
  /** Frozen leader pane PID. When supplied, restoration never adopts a replacement pane PID. */
  expectedLeaderPanePid?: number;
  /** Shared-session authorization recheck performed immediately before leader-targeted operations. */
  assertLeaderPaneAuthorization?: () => void;
  /** Canonical state root for durable restored-HUD cleanup debt. */
  stateRoot?: string | null;
  /** Canonical Team owner tag frozen with the leader for durable replay. */
  expectedLeaderPaneOwnerId?: string | null;
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const OMX_TEAM_WORKER_CLI_ENV = 'OMX_TEAM_WORKER_CLI';
const OMX_TEAM_WORKER_CLI_MAP_ENV = 'OMX_TEAM_WORKER_CLI_MAP';
const OMX_TEAM_WORKER_LAUNCH_MODE_ENV = 'OMX_TEAM_WORKER_LAUNCH_MODE';
const OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV = 'OMX_TEAM_AUTO_INTERRUPT_RETRY';
const OMX_TEAM_WORKER_MCP_COMPAT_ENV = 'OMX_TEAM_WORKER_MCP_COMPAT';
const CODEX_SQLITE_HOME_ENV = 'CODEX_SQLITE_HOME';
const GEMINI_PROMPT_INTERACTIVE_FLAG = '-i';
const GEMINI_APPROVAL_MODE_FLAG = '--approval-mode';
const GEMINI_APPROVAL_MODE_YOLO = 'yolo';
const OMX_LEADER_NODE_PATH_ENV = 'OMX_LEADER_NODE_PATH';
const OMX_LEADER_CLI_PATH_ENV = 'OMX_LEADER_CLI_PATH';
const TMUX_WORKER_AMBIENT_ENV_ALLOWLIST = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

const TEAM_WORKER_DISABLED_OMX_MCP_SERVERS = [
  'omx_state',
  'omx_memory',
  'omx_code_intel',
  'omx_trace',
  'omx_wiki',
  'omx_hermes',
] as const;
const TMUX_NO_UNDERLINE_STYLE_FLAGS = [
  'nounderscore',
  'nodouble-underscore',
  'nocurly-underscore',
  'nodotted-underscore',
  'nodashed-underscore',
] as const;
const TMUX_COPY_MODE_STYLE_OPTIONS = [
  'mode-style',
  'copy-mode-selection-style',
] as const;
const TMUX_PANE_STABILITY_POLL_MS = 60;
const TMUX_PANE_STABILITY_POLLS_REQUIRED = 2;
const TMUX_PANE_STABILITY_TIMEOUT_MS = 750;
const OMX_TEAM_STATE_ROOT_ENV = 'OMX_TEAM_STATE_ROOT';

export type TeamWorkerCli = 'codex' | 'claude' | 'gemini';
type TeamWorkerCliMode = 'auto' | TeamWorkerCli;
export type TeamWorkerLaunchMode = 'interactive' | 'prompt';

export interface WorkerSubmitPlan {
  shouldInterrupt: boolean;
  queueFirstRound: boolean;
  rounds: number;
  submitKeyPressesPerRound: number;
  allowAdaptiveRetry: boolean;
}

interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

export interface WorkerProcessLaunchSpec {
  workerCli: TeamWorkerCli;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface TmuxPaneInfo {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

type SpawnSyncLike = typeof spawnSync;

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const { result } = spawnPlatformCommandSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

/** Preserve structured tmux fields, including an empty final field. */
/** Preserve structured tmux fields, including an empty final field. */
function runTmuxStructured(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const { result } = spawnPlatformCommandSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').replace(/\r?\n$/, '') };
}

type RestoredHudCleanupDebt = {
  schema_version: 1;
  operation: 'restored_hud_cleanup';
  pane_id: string;
  pane_pid: number | null;
  leader_pane_id: string;
  leader_pane_pid: number;
  /** Canonical Team owner tag that authorizes the leader during replay. */
  leader_pane_owner_id: string | null;
  /** Immutable HUD command identity: this must remain tied to the frozen leader. */
  hud_owner_leader_pane_id: string;
};

function restoredHudCleanupDebtPath(cwd: string, stateRoot?: string | null): string {
  const canonicalStateRoot = resolveCanonicalTeamStateRoot(resolve(cwd));
  if (typeof stateRoot !== 'string' || !stateRoot.trim()) {
    return join(canonicalStateRoot, '.restored-hud-cleanup-debt.json');
  }

  const canonicalTeamsRoot = join(canonicalStateRoot, 'team');
  const root = resolve(stateRoot);
  const relativeRoot = relative(canonicalTeamsRoot, root);
  if (!isAbsolute(stateRoot.trim())
    || !relativeRoot
    || relativeRoot === '..'
    || relativeRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeRoot)
    || relativeRoot.split(sep).length !== 1) {
    throw new Error('restored_hud_cleanup_debt_state_root_invalid');
  }

  for (let candidate = root; ; candidate = dirname(candidate)) {
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('restored_hud_cleanup_debt_state_root_invalid');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (candidate === canonicalTeamsRoot) break;
  }
  return join(root, '.restored-hud-cleanup-debt.json');
}

function syncRestoredHudDebtParentSync(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(dirname(path), 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!(code === 'EPERM' && process.platform === 'win32')) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


function persistRestoredHudCleanupDebtSync(
  cwd: string,
  debt: RestoredHudCleanupDebt,
  stateRoot?: string | null,
): void {
  const debtPath = restoredHudCleanupDebtPath(cwd, stateRoot);
  mkdirSync(dirname(debtPath), { recursive: true });
  // Recheck after mkdir: an untrusted Team root must still be canonical and
  // non-symlinked immediately before the durable file mutation.
  restoredHudCleanupDebtPath(cwd, stateRoot);
  const temporaryPath = `${debtPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporaryPath, `${JSON.stringify(debt)}\n`, { mode: 0o600 });
  const temporaryDescriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(temporaryDescriptor);
  } finally {
    closeSync(temporaryDescriptor);
  }
  renameSync(temporaryPath, debtPath);
  syncRestoredHudDebtParentSync(debtPath);
}

function parseRestoredHudCleanupDebtSync(cwd: string, stateRoot?: string | null): { path: string; debt: RestoredHudCleanupDebt } | null {
  const debtPath = restoredHudCleanupDebtPath(cwd, stateRoot);
  if (!existsSync(debtPath)) return null;
  let debt: RestoredHudCleanupDebt;
  try {
    debt = JSON.parse(readFileSync(debtPath, 'utf8')) as RestoredHudCleanupDebt;
  } catch {
    throw new Error('restored_hud_cleanup_debt_malformed');
  }
  if (debt.schema_version !== 1 || debt.operation !== 'restored_hud_cleanup'
    || !hasExplicitWorkerPaneId(debt.pane_id)
    || !hasExplicitWorkerPaneId(debt.leader_pane_id)
    || !Number.isSafeInteger(debt.leader_pane_pid) || debt.leader_pane_pid <= 0
    || !(typeof debt.leader_pane_owner_id === 'string' || debt.leader_pane_owner_id === null)
    || debt.hud_owner_leader_pane_id !== debt.leader_pane_id
    || (debt.pane_pid !== null && (!Number.isSafeInteger(debt.pane_pid) || debt.pane_pid <= 0))) {
    throw new Error('restored_hud_cleanup_debt_malformed');
  }
  return { path: debtPath, debt };
}

function removeRestoredHudCleanupDebtSync(path: string): void {
  unlinkSync(path);
  syncRestoredHudDebtParentSync(path);
}

/**
 * Replays a prior restored-HUD obligation. A live pane is killable only when
 * its recorded PID, HUD command identity, and tagged leader identity all
 * still match; PID-less and ambiguous records remain durable debt.
 */
export function reconcileRestoredHudCleanupDebtSync(cwd: string, stateRoot?: string | null): void {
  const record = parseRestoredHudCleanupDebtSync(cwd, stateRoot);
  if (!record) return;
  const { path, debt } = record;
  const proof = readExactPaneProofSync(debt.pane_id);
  if (proof.status === 'gone') {
    removeRestoredHudCleanupDebtSync(path);
    return;
  }
  if (proof.status !== 'live' || debt.pane_pid === null || proof.pid !== debt.pane_pid || !debt.leader_pane_owner_id) {
    throw new Error(`restored_hud_cleanup_debt_unresolved:${debt.pane_id}`);
  }
  const leader = requireLiveTeamOwnedPaneSync(debt.leader_pane_id, debt.leader_pane_pid, debt.leader_pane_owner_id);
  const topology = listPanesResult(leader);
  const hudMatches = !topology.error && topology.panes.filter((pane) => pane.paneId === proof.paneId
    && hudPaneMatchesOwner(pane, { leaderPaneId: debt.hud_owner_leader_pane_id })).length === 1;
  if (!hudMatches) throw new Error(`restored_hud_cleanup_debt_unresolved:${debt.pane_id}`);
  killExactPaneSync(proof.paneId, debt.pane_pid, () => {
    requireLiveTeamOwnedPaneSync(debt.leader_pane_id, debt.leader_pane_pid, debt.leader_pane_owner_id!);
  });
  removeRestoredHudCleanupDebtSync(path);
}

/** Remove restored-HUD debt only after the canonical config transaction commits the same frozen identity. */
export function finalizeRestoredHudCleanupDebtSync(
  cwd: string,
  paneId: string,
  panePid: number,
  stateRoot?: string | null,
  _requireFreshHudIdentity?: boolean,
): void {
  const record = parseRestoredHudCleanupDebtSync(cwd, stateRoot);
  if (!record) return;
  const { debt } = record;
  if (debt.pane_id !== paneId || debt.pane_pid !== panePid || !debt.leader_pane_owner_id) {
    throw new Error(`restored_hud_cleanup_debt_unresolved:${debt.pane_id}`);
  }
  const leader = requireLiveTeamOwnedPaneSync(
    debt.leader_pane_id,
    debt.leader_pane_pid,
    debt.leader_pane_owner_id,
  );
  const topology = listPanesResult(leader);
  const hudMatches = !topology.error && topology.panes.filter((pane) => pane.paneId === debt.pane_id
    && hudPaneMatchesOwner(pane, { leaderPaneId: debt.hud_owner_leader_pane_id })).length === 1;
  if (!hudMatches) throw new Error(`restored_hud_cleanup_debt_unresolved:${debt.pane_id}`);
  const finalProof = readExactPaneProofSync(debt.pane_id);
  if (finalProof.status !== 'live' || finalProof.pid !== debt.pane_pid) {
    throw new Error(`restored_hud_cleanup_debt_unresolved:${debt.pane_id}`);
  }
  removeRestoredHudCleanupDebtSync(record.path);
}


/**
 * Kill only a pane that a fresh global snapshot proves live. Callers treat
 * gone/dead rows as already cleaned and unavailable snapshots as fail-closed.
 */
function requireLiveExactPaneSync(paneId: string, expectedPid?: number): string {
  const proof = readExactPaneProofSync(paneId);
  if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
  if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${paneId}`);
  if (expectedPid !== undefined && proof.pid !== expectedPid) {
    throw new Error(`tmux pane identity changed: ${paneId}`);
  }
  return proof.paneId;
}

function killExactPaneSync(paneId: string, expectedPid?: number, assertAuthorization?: () => void): void {
  const proof = readExactPaneProofSync(paneId);
  if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
  if (proof.status === 'gone') return;
  if (expectedPid !== undefined && proof.pid !== expectedPid) {
    throw new Error(`tmux pane identity changed: ${paneId}`);
  }
  assertAuthorization?.();
  // Authorization can read tmux. Re-prove immediately after it so a recycled
  // pane ID cannot be targeted by the subsequent kill.
  const finalProof = readExactPaneProofSync(proof.paneId);
  if (finalProof.status === 'unavailable') throw new ExactPaneProofUnavailableError(finalProof);
  if (finalProof.status === 'gone') return;
  if (finalProof.pid !== proof.pid || (expectedPid !== undefined && finalProof.pid !== expectedPid)) {
    throw new Error(`tmux pane identity changed: ${paneId}`);
  }
  const result = runTmux(['kill-pane', '-t', finalProof.paneId]);
  if (!result.ok) throw new Error(`failed to kill tmux pane ${finalProof.paneId}: ${result.stderr}`);
  const afterKill = readExactPaneProofSync(finalProof.paneId);
  if (afterKill.status === 'unavailable') throw new ExactPaneProofUnavailableError(afterKill);
  if (afterKill.status !== 'gone') {
    if (afterKill.pid !== finalProof.pid) throw new Error(`tmux pane identity changed: ${paneId}`);
    throw new Error(`tmux pane remains live after kill: ${paneId}`);
  }
}

function appendNoUnderlineStyleFlags(style: string): string {
  const normalized = style
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const combined = [...normalized];
  for (const flag of TMUX_NO_UNDERLINE_STYLE_FLAGS) {
    if (!combined.includes(flag)) combined.push(flag);
  }
  return combined.join(',');
}

function sanitizeTmuxStyleOption(
  sessionTarget: string,
  optionName: string,
  beforeEffect?: () => void,
): boolean {
  beforeEffect?.();
  const shown = runTmux(['show-options', '-gv', '-t', sessionTarget, optionName]);
  if (!shown.ok) return false;

  const current = shown.stdout.trim();
  if (current === '') return false;

  const sanitized = appendNoUnderlineStyleFlags(current);
  if (sanitized === current) return true;
  beforeEffect?.();
  const result = runTmux(['set-option', '-t', sessionTarget, optionName, sanitized]);
  return result.ok;
}

function tagPaneInstance(paneTarget: string, instanceId: string, expectedPanePid?: number): void {
  const target = paneTarget.trim();
  const sanitized = instanceId.trim();
  if (!target || !sanitized) return;
  const provenTarget = requireLiveExactPaneSync(target, expectedPanePid);
  const result = runTmux(['set-option', '-p', '-t', provenTarget, OMX_PANE_INSTANCE_OPTION, sanitized]);
  if (!result.ok) {
    throw new Error(`failed to tag tmux pane ${provenTarget}: ${result.stderr}`);
  }
}

export function tagPaneTeamOwner(paneTarget: string, teamOwnerId: string, expectedPanePid?: number): void {
  const target = paneTarget.trim();
  const sanitized = teamOwnerId.trim();
  if (!target || !sanitized) return;
  const provenTarget = requireLiveExactPaneSync(target, expectedPanePid);
  const result = runTmux(['set-option', '-p', '-t', provenTarget, OMX_TEAM_PANE_OWNER_OPTION, sanitized]);
  if (!result.ok) {
    throw new Error(`failed to tag tmux pane ${provenTarget}: ${result.stderr}`);
  }
}


export function mitigateCopyModeUnderlineArtifacts(
  sessionTarget: string,
  beforeEffect?: () => void,
): boolean {
  const normalizedTarget = sessionTarget.trim();
  if (normalizedTarget === '') return false;

  let applied = false;
  for (const optionName of TMUX_COPY_MODE_STYLE_OPTIONS) {
    if (sanitizeTmuxStyleOption(normalizedTarget, optionName, beforeEffect)) {
      applied = true;
    }
  }
  return applied;
}

export function hasCurrentTmuxClientContext(): boolean {
  const tmuxPaneTarget = process.env.TMUX_PANE?.trim();
  const displayArgs = tmuxPaneTarget
    ? ['display-message', '-p', '-t', tmuxPaneTarget, '#{session_name}:#{window_index} #{pane_id}']
    : ['display-message', '-p', '#{session_name}:#{window_index} #{pane_id}'];
  const context = runTmux(displayArgs);
  if (!context.ok) return false;
  const [sessionAndWindow = '', detectedLeaderPaneId = ''] = context.stdout.split(' ');
  const [sessionName, windowIndex] = sessionAndWindow.split(':');
  return Boolean(sessionName && windowIndex && detectedLeaderPaneId.startsWith('%'));
}

export function isMsysOrGitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const msystem = String(env.MSYSTEM ?? '').trim();
  if (msystem !== '') return true;
  const ostype = String(env.OSTYPE ?? '').trim();
  if (/(msys|mingw|cygwin)/i.test(ostype)) return true;
  return false;
}

function fallbackMsysPathTranslation(value: string): string {
  const drivePathMatch = value.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!drivePathMatch) return value;
  const drive = drivePathMatch[1]?.toLowerCase();
  const tail = drivePathMatch[2]?.replace(/\\/g, '/');
  if (!drive || !tail) return value;
  return `/${drive}/${tail}`;
}

export function translatePathForMsys(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnSyncLike = spawnSync,
): string {
  if (typeof value !== 'string' || value.trim() === '') return value;
  if (!isMsysOrGitBash(env, platform)) return value;

  const result = spawnImpl('cygpath', ['-u', value], { encoding: 'utf-8' });
  if (!result.error && result.status === 0) {
    const translated = (result.stdout || '').trim();
    if (translated !== '') return translated;
  }

  return fallbackMsysPathTranslation(value);
}

function baseSessionName(target: string): string {
  return target.split(':')[0] || target;
}

interface PaneListResult {
  panes: TmuxPaneInfo[];
  error: string | null;
}

function listPanes(target: string): TmuxPaneInfo[] {
  return listPanesResult(target).panes;
}


function listPanesResult(target: string): PaneListResult {
  const result = runTmuxStructured(['list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}']);
  if (!result.ok) return { panes: [], error: result.stderr };

  const panes: TmuxPaneInfo[] = [];
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;

    const firstSeparator = line.indexOf('\t');
    const secondSeparator = firstSeparator >= 0 ? line.indexOf('\t', firstSeparator + 1) : -1;
    const paneId = firstSeparator >= 0 ? line.slice(0, firstSeparator) : line;
    if (firstSeparator < 0 || secondSeparator < 0 || !/^%[0-9]+$/.test(paneId)) {
      return { panes: [], error: 'malformed pane topology' };
    }

    if (panes.some((pane) => pane.paneId === paneId)) {
      return { panes: [], error: 'malformed pane topology' };
    }
    panes.push({
      paneId,
      currentCommand: line.slice(firstSeparator + 1, secondSeparator),
      startCommand: line.slice(secondSeparator + 1),
    });
  }

  return { panes, error: null };

}

/**
 * Window-wide layout effects may only touch the exact startup pane set. A
 * target-scoped topology read rejects foreign/new panes, and targeted global
 * snapshots pin every surviving pane identity. The final scoped read happens
 * immediately before the mutation so panes added during owner reads cannot
 * inherit that authority.
 */
/**
 * Re-prove an explicitly Team-owned pane immediately before an effect. The
 * double PID proof keeps ownership and process identity continuous across an
 * untrusted tmux option read.
 */
function requireLiveTeamOwnedPaneSync(
  paneId: string,
  expectedPanePid: number,
  expectedTeamOwnerId: string,
): string {
  const target = requireLiveExactPaneSync(paneId, expectedPanePid);
  const owner = readPaneTeamOwnerTagResult(target);
  if (owner.status !== 'value' || owner.value !== expectedTeamOwnerId) {
    const detail = owner.status === 'error' ? owner.error : 'missing';
    throw new Error(`tmux pane team owner changed: ${target}: ${detail}`);
  }
  return requireLiveExactPaneSync(target, expectedPanePid);
}

function requireFrozenWindowTopologySync(
  teamTarget: string,
  expectedPanePids: ReadonlyMap<string, number>,
  expectedPaneOwners?: ReadonlyMap<string, string>,
): void {
  const topology = listPanesResult(teamTarget);
  if (topology.error) throw new Error(`failed to read tmux pane topology: ${topology.error}`);

  const actualPaneIds = new Set(topology.panes.map((pane) => pane.paneId));
  if (actualPaneIds.size !== expectedPanePids.size
    || [...expectedPanePids.keys()].some((paneId) => !actualPaneIds.has(paneId))) {
    throw new Error('tmux window topology changed before layout mutation');
  }

  for (const [paneId, expectedPanePid] of expectedPanePids) {
    const expectedOwner = expectedPaneOwners?.get(paneId);
    if (expectedOwner) requireLiveTeamOwnedPaneSync(paneId, expectedPanePid, expectedOwner);
    else {
      const proof = readExactPaneProofSync(paneId);
      if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
      if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${proof.paneId}`);
      if (proof.pid !== expectedPanePid) throw new Error(`tmux pane identity changed: ${proof.paneId}`);
    }
  }

  const finalProofs = readExactPaneProofsSync([...expectedPanePids.keys()]);
  for (const [index, [paneId, expectedPanePid]] of [...expectedPanePids.entries()].entries()) {
    const proof = finalProofs[index]!;
    if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
    if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${proof.paneId}`);
    if (proof.paneId !== paneId || proof.pid !== expectedPanePid) {
      throw new Error(`tmux pane identity changed: ${paneId}`);
    }
  }

  const finalTopology = listPanesResult(teamTarget);
  if (finalTopology.error) throw new Error(`failed to read tmux pane topology: ${finalTopology.error}`);
  const finalPaneIds = new Set(finalTopology.panes.map((pane) => pane.paneId));
  if (finalPaneIds.size !== expectedPanePids.size
    || [...expectedPanePids.keys()].some((paneId) => !finalPaneIds.has(paneId))) {
    throw new Error('tmux window topology changed before layout mutation');
  }
}



export function listPaneIds(target: string): string[] {
  return listPanes(target).map((pane) => pane.paneId);
}

function paneExistsInTarget(target: string, paneId: string): boolean {
  if (!paneId.startsWith('%')) return false;
  return listPaneIds(target).includes(paneId);
}

function waitForPaneToRemainPresent(
  target: string,
  paneId: string,
  timeoutMs: number = TMUX_PANE_STABILITY_TIMEOUT_MS,
): boolean {
  if (!paneId.startsWith('%')) return false;

  const stablePollsRequired = Math.max(1, TMUX_PANE_STABILITY_POLLS_REQUIRED);
  const startedAt = Date.now();
  let stablePolls = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    if (paneExistsInTarget(target, paneId)) {
      stablePolls += 1;
      if (stablePolls >= stablePollsRequired) return true;
    } else {
      stablePolls = 0;
    }

    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepFractionalSeconds(Math.max(0, Math.min(TMUX_PANE_STABILITY_POLL_MS, remaining)) / 1000);
  }

  return false;
}

function isHudWatchPane(pane: TmuxPaneInfo): boolean {
  const start = pane.startCommand || '';
  return /\bomx\b.*\bhud\b.*--watch/i.test(start);
}

export function chooseTeamLeaderPaneId(panes: TmuxPaneInfo[], preferredPaneId: string): string {
  const preferred = panes.find((pane) => pane.paneId === preferredPaneId);
  if (preferred && !isHudWatchPane(preferred)) return preferred.paneId;

  const nonHud = panes.find((pane) => !isHudWatchPane(pane));
  if (nonHud) return nonHud.paneId;

  return preferredPaneId;
}



function readPaneCurrentPath(paneId: string): string | null {
  if (!paneId.startsWith('%')) return null;
  const result = runTmux(['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
  if (!result.ok) return null;
  const path = result.stdout.split('\n')[0]?.trim() ?? '';
  return path === '' ? null : path;
}

function pathIsUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

type RestoreCwdCandidateSource = 'explicit' | 'live' | 'fallback';

type RestoreCwdCandidate = {
  source: RestoreCwdCandidateSource;
  rawPath: string;
};

function isMsysDriveSlashPath(path: string): boolean {
  return /^\/[A-Za-z](?:\/|$)/.test(path);
}

function uniqueRestoreCwdCandidates(
  candidates: Array<{source: RestoreCwdCandidateSource; rawPath: string | null | undefined}>,
): RestoreCwdCandidate[] {
  const seen = new Set<string>();
  const result: RestoreCwdCandidate[] = [];
  for (const candidate of candidates) {
    const normalized = typeof candidate.rawPath === 'string' ? candidate.rawPath.trim() : '';
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ source: candidate.source, rawPath: normalized });
  }
  return result;
}

function shouldAttemptRestoreCwdCandidate(candidate: RestoreCwdCandidate): boolean {
  if (candidate.source === 'live' && isMsysOrGitBash() && isMsysDriveSlashPath(candidate.rawPath)) {
    return true;
  }

  return pathIsUsableDirectory(candidate.rawPath);
}

function resolveStandaloneHudRestoreCwdCandidates(
  leaderPaneId: string,
  fallbackCwd: string,
  explicitCwd?: string | null,
  beforeReadLiveLeaderCwd?: () => void,
): RestoreCwdCandidate[] {
  beforeReadLiveLeaderCwd?.();
  const liveLeaderCwd = readPaneCurrentPath(leaderPaneId);
  return uniqueRestoreCwdCandidates([
    { source: 'explicit', rawPath: explicitCwd },
    { source: 'live', rawPath: liveLeaderCwd },
    { source: 'fallback', rawPath: fallbackCwd },
  ]).filter(shouldAttemptRestoreCwdCandidate);
}

const MAX_FRACTIONAL_SLEEP_MS = 60_000;

function toFractionalSleepMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const ms = Math.ceil(seconds * 1000);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_FRACTIONAL_SLEEP_MS, ms);
}

function sleepSeconds(seconds: number): void {
  sleepFractionalSeconds(seconds);
}

export function sleepFractionalSeconds(
  seconds: number,
  sleepImpl: (ms: number) => void = sleepSync,
): void {
  const ms = toFractionalSleepMs(seconds);
  if (ms <= 0) return;
  sleepImpl(ms);
}

// ── Async tmux helpers ──────────────────────────────────────────────────────

async function runTmuxAsync(args: string[]): Promise<{ok: true; stdout: string} | {ok: false; stderr: string}> {
  try {
    const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf-8' });
    return { ok: true, stdout: (stdout || '').trim() };
  } catch (error: unknown) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, stderr: (err.stderr || err.message || '').trim() || 'tmux command failed' };
  }
}

function hasExplicitWorkerPaneId(workerPaneId: string | undefined): workerPaneId is string {
  return typeof workerPaneId === 'string' && workerPaneId.trim().length > 0;
}

function resolveWorkerPaneTargetSync(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): string | null {
  if (!hasExplicitWorkerPaneId(workerPaneId)) return paneTarget(sessionName, workerIndex);
  const proof = readExactPaneProofSync(workerPaneId);
  return proof.status === 'live' ? proof.paneId : null;
}

async function resolveWorkerPaneTargetAsync(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): Promise<string | null> {
  if (!hasExplicitWorkerPaneId(workerPaneId)) return paneTarget(sessionName, workerIndex);
  const proof = await readExactPaneProof(workerPaneId);
  return proof.status === 'live' ? proof.paneId : null;
}

function createPinnedWorkerPaneTargetResolverSync(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): () => string | null {
  if (!hasExplicitWorkerPaneId(workerPaneId)) {
    return () => resolveWorkerPaneTargetSync(sessionName, workerIndex, workerPaneId);
  }

  const pinnedPid = expectedPanePid;
  const expectedOwner = typeof expectedTeamOwnerId === 'string' ? expectedTeamOwnerId.trim() : '';
  const canonicalHudPaneId = typeof hudPaneId === 'string' ? hudPaneId.trim() : '';
  return () => {
    if (typeof pinnedPid !== 'number' || !Number.isSafeInteger(pinnedPid) || pinnedPid <= 0) return null;
    if (!expectedOwner) return null;
    if (canonicalHudPaneId && workerPaneId === canonicalHudPaneId) {
      throw new Error(`tmux worker pane is HUD target: ${workerPaneId}`);
    }
    const proof = readExactPaneProofSync(workerPaneId);
    if (proof.status !== 'live') return null;
    if (proof.pid !== pinnedPid) {
      throw new Error(`tmux pane identity changed: ${workerPaneId}`);
    }
    const owner = readPaneTeamOwnerTagResult(proof.paneId);
    if (owner.status !== 'value' || owner.value !== expectedOwner) return null;
    const finalProof = readExactPaneProofSync(workerPaneId);
    if (finalProof.status !== 'live') return null;
    if (finalProof.pid !== pinnedPid) {
      throw new Error(`tmux pane identity changed: ${workerPaneId}`);
    }
    return finalProof.paneId;
  };
}

function createPinnedWorkerPaneTargetResolver(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): AsyncPaneTargetResolver {
  if (!hasExplicitWorkerPaneId(workerPaneId)) {
    return () => resolveWorkerPaneTargetAsync(sessionName, workerIndex, workerPaneId);
  }

  const pinnedPid = expectedPanePid;
  const expectedOwner = typeof expectedTeamOwnerId === 'string' ? expectedTeamOwnerId.trim() : '';
  const canonicalHudPaneId = typeof hudPaneId === 'string' ? hudPaneId.trim() : '';
  let lastResolvedPid: number | undefined;
  const resolveTarget: AsyncPaneTargetResolver = async () => {
    if (typeof pinnedPid !== 'number' || !Number.isSafeInteger(pinnedPid) || pinnedPid <= 0) return null;
    if (!expectedOwner) return null;
    if (canonicalHudPaneId && workerPaneId === canonicalHudPaneId) {
      throw new Error(`tmux worker pane is HUD target: ${workerPaneId}`);
    }
    const proof = await readExactPaneProof(workerPaneId);
    if (proof.status !== 'live') return null;
    if (proof.pid !== pinnedPid) {
      throw new Error(`tmux pane identity changed: ${workerPaneId}`);
    }
    const owner = readPaneTeamOwnerTagResult(proof.paneId);
    if (owner.status !== 'value' || owner.value !== expectedOwner) {
      const detail = owner.status === 'error' ? owner.error : 'missing';
      throw new Error(`tmux pane team owner changed: ${workerPaneId}: ${detail}`);
    }
    // The option read is untrusted and can race pane ID reuse. Its immediately
    // adjacent PID proof authorizes the following capture/control/input effect.
    const finalProof = await readExactPaneProof(workerPaneId);
    if (finalProof.status !== 'live') return null;
    if (finalProof.pid !== pinnedPid) {
      throw new Error(`tmux pane identity changed: ${workerPaneId}`);
    }
    lastResolvedPid = finalProof.pid;
    return finalProof.paneId;
  };
  resolveTarget.lastResolvedPid = () => lastResolvedPid;
  return resolveTarget;
}

type AsyncPaneTargetResolver = (() => Promise<string | null>) & {
  lastResolvedPid?: () => number | undefined;
};

async function requireAsyncPaneTarget(resolveTarget: AsyncPaneTargetResolver): Promise<string> {
  const target = await resolveTarget();
  if (!target) throw new Error('tmux pane is not proven live');
  return target;
}

async function sendKeyAsync(resolveTarget: AsyncPaneTargetResolver, key: string): Promise<void> {
  const target = await requireAsyncPaneTarget(resolveTarget);
  const result = await runTmuxAsync(['send-keys', '-t', target, key]);
  if (!result.ok) {
    throw new Error(`sendKeyAsync: failed to send ${key}: ${result.stderr}`);
  }
}

async function capturePaneAsync(resolveTarget: AsyncPaneTargetResolver): Promise<string> {
  const target = await resolveTarget();
  if (!target) return '';
  const result = await runTmuxAsync(sharedBuildCapturePaneArgv(target, 80));
  if (!result.ok) return '';
  return result.stdout;
}

/** Capture an explicit Team worker pane only after PID-owner-PID authorization. */
export async function captureWorkerPane(
  sessionName: string,
  workerIndex: number,
  workerPaneId: string,
  expectedPanePid: number,
  expectedTeamOwnerId: string,
  hudPaneId?: string,
): Promise<string> {
  const resolveTarget = createPinnedWorkerPaneTargetResolver(
    sessionName,
    workerIndex,
    workerPaneId,
    expectedPanePid,
    expectedTeamOwnerId,
    hudPaneId,
  );
  return capturePaneAsync(resolveTarget);
}

async function captureVisiblePaneAsync(resolveTarget: AsyncPaneTargetResolver): Promise<string> {
  const target = await resolveTarget();
  if (!target) return '';
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return '';
  return result.stdout;
}

async function isWorkerAliveAsync(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
  resolveTarget?: AsyncPaneTargetResolver,
): Promise<ProcessLiveness> {
  if (hasExplicitWorkerPaneId(workerPaneId)) {
    const resolver = resolveTarget ?? createPinnedWorkerPaneTargetResolver(
      sessionName,
      workerIndex,
      workerPaneId,
      expectedPanePid,
      expectedTeamOwnerId,
      hudPaneId,
    );
    const target = await resolver();
    const pid = resolver.lastResolvedPid?.() ?? expectedPanePid;
    if (!target || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
    return probeProcessLiveness(pid);
  }

  const result = await runTmuxAsync([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return 'unknown';

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return 'unknown';

  const parts = line.split(/\s+/);
  if (parts.length < 2) return 'unknown';

  const paneDead = parts[0];
  const pid = Number.parseInt(parts[1], 10);

  if (paneDead === '1') return 'gone';
  if (!Number.isFinite(pid)) return 'unknown';
  return probeProcessLiveness(pid);
}


function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatHudEnvAssignments(
  env: NodeJS.ProcessEnv = process.env,
  owner: { sessionId?: string | null; leaderPaneId?: string | null } = {},
): string {
  const sessionId = (owner.sessionId ?? '').trim();
  const leaderPaneId = (owner.leaderPaneId ?? '').trim();
  const assignments = [
    sessionId ? `OMX_SESSION_ID=${shellQuoteSingle(sessionId)}` : '',
    `${OMX_TMUX_HUD_OWNER_ENV}=1`,
    leaderPaneId ? `${OMX_TMUX_HUD_LEADER_PANE_ENV}=${shellQuoteSingle(leaderPaneId)}` : '',
    ...(typeof env.OMX_ROOT === 'string' && env.OMX_ROOT.trim() !== ''
      ? [`OMX_ROOT=${shellQuoteSingle(env.OMX_ROOT)}`]
      : []),
  ].filter(Boolean);
  return assignments.join(' ');
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(commandText: string): string {
  return Buffer.from(commandText, 'utf16le').toString('base64');
}

function resolveNativeWindowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const rootCandidates = [
    env.SystemRoot,
    env.SYSTEMROOT,
    env.windir,
    env.WINDIR,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value, index, values) => value !== '' && values.indexOf(value) === index);
  const systemPowerShellCandidates = rootCandidates.map(
    (root) => `${root.replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
  );
  const resolvedFromPath = resolveCommandPathForPlatform('powershell', process.platform, env);
  const existingCandidates = [
    ...systemPowerShellCandidates,
    resolvedFromPath,
  ].filter((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

  return existingCandidates.find((candidate) => !/\s/.test(candidate))
    ?? existingCandidates[0]
    ?? resolvedFromPath
    ?? 'powershell.exe';
}

function normalizeTmuxHookToken(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return normalized === '' ? 'unknown' : normalized;
}

function normalizeHudPaneToken(hudPaneId: string): string {
  const trimmed = hudPaneId.trim();
  const withoutPrefix = trimmed.startsWith('%') ? trimmed.slice(1) : trimmed;
  return normalizeTmuxHookToken(withoutPrefix);
}

export function buildResizeHookTarget(sessionName: string, windowIndex: string): string {
  return `${sessionName}:${windowIndex}`;
}

export function buildResizeHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_resize',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildHudPaneTarget(hudPaneId: string): string {
  const trimmed = hudPaneId.trim();
  return trimmed.startsWith('%') ? trimmed : `%${trimmed}`;
}

function resolveHudHeightLines(heightLines: number): number {
  if (!Number.isFinite(heightLines)) return HUD_TMUX_TEAM_HEIGHT_LINES;
  const normalized = Math.floor(heightLines);
  return normalized > 0 ? normalized : HUD_TMUX_TEAM_HEIGHT_LINES;
}

function buildHudResizeCommand(hudPaneId: string, heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES): string {
  return `resize-pane -t ${buildHudPaneTarget(hudPaneId)} -y ${resolveHudHeightLines(heightLines)}`;
}

function buildHudResizeArgs(
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
): string[] {
  return ['resize-pane', '-t', buildHudPaneTarget(hudPaneId), '-y', String(resolveHudHeightLines(heightLines))];
}

function buildNestedTmuxShellCommand(command: string): string {
  if (process.platform !== 'win32') {
    return `tmux ${command}`;
  }

  const resolvedTmuxPath = resolveAbsoluteBinaryPath('tmux');
  if (resolvedTmuxPath === 'tmux') {
    return `tmux ${command}`;
  }

  return `${shellQuoteSingle(resolvedTmuxPath.replace(/\\/g, '/'))} ${command}`;
}

function buildBestEffortShellCommand(command: string): string {
  return `${command} >/dev/null 2>&1 || true`;
}

function buildAuthoritativeHudResizeShellCommand(
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
  expectedPanePid?: number,
  expectedPaneOwnerId?: string,
  effectCommand: string = buildNestedTmuxShellCommand(buildHudResizeCommand(buildHudPaneTarget(hudPaneId), heightLines)),
): string {
  const target = buildHudPaneTarget(hudPaneId);
  const snapshot = buildNestedTmuxShellCommand("list-panes -a -F '#{pane_id}\\t#{pane_dead}\\t#{pane_pid}'");
  const expectedPid = typeof expectedPanePid === 'number' && Number.isSafeInteger(expectedPanePid) && expectedPanePid > 0
    ? ` && $3 == "${expectedPanePid}"`
    : '';
  const proof = `awk -F '\\t' -v pane='${target}' 'NF != 3 || $1 !~ /^%[0-9]+$/ || ($2 != "0" && $2 != "1") || (seen[$1]++) || ($1 == pane && ($3 !~ /^[1-9][0-9]*$/ || length($3) > 16 || (length($3) == 16 && ("x" $3) > "x9007199254740991"))) || ($1 != pane && $3 != "" && ($3 !~ /^[1-9][0-9]*$/ || length($3) > 16 || (length($3) == 16 && ("x" $3) > "x9007199254740991"))) { bad = 1 } $1 == pane && $2 == "0"${expectedPid} { live = 1 } END { exit bad || !live }'`;
  const expectedOwner = expectedPaneOwnerId?.trim();
  if (!expectedOwner) {
    return `if snapshot=$(${snapshot}); then printf '%s\\n' "$snapshot" | ${proof} && ${effectCommand}; fi`;
  }
  const owner = buildNestedTmuxShellCommand(
    `show-option -qv -p -t ${target} ${OMX_TEAM_PANE_OWNER_OPTION}`,
  );
  return `if snapshot=$(${snapshot}); then printf '%s\\n' "$snapshot" | ${proof} && owner=$(${owner}) && [ "$owner" = ${shellQuoteSingle(expectedOwner)} ] && final_snapshot=$(${snapshot}) && printf '%s\\n' "$final_snapshot" | ${proof} && ${effectCommand}; fi`;
}

/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

function buildResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

function buildClientAttachedHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-attached[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export function buildRegisterResizeHookArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
  expectedPanePid?: number,
  expectedPaneOwnerId?: string,
): string[] {
  const resizeCommand = buildBestEffortShellCommand(buildAuthoritativeHudResizeShellCommand(
    hudPaneId,
    heightLines,
    expectedPanePid,
    expectedPaneOwnerId,
  ));
  const hookCommand = shellQuoteSingle(
    `${resizeCommand}; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${resizeCommand}`,
  );
  return ['set-hook', '-t', hookTarget, buildResizeHookSlot(hookName), `run-shell -b ${hookCommand}`];
}

export function buildUnregisterResizeHookArgs(hookTarget: string, hookName: string): string[] {
  return ['set-hook', '-u', '-t', hookTarget, buildResizeHookSlot(hookName)];
}

export function buildClientAttachedReconcileHookName(
  teamName: string,
  sessionName: string,
  windowIndex: string,
  hudPaneId: string,
): string {
  return [
    'omx_attached',
    normalizeTmuxHookToken(teamName),
    normalizeTmuxHookToken(sessionName),
    normalizeTmuxHookToken(windowIndex),
    normalizeHudPaneToken(hudPaneId),
  ].join('_');
}

export function buildRegisterClientAttachedReconcileArgs(
  hookTarget: string,
  hookName: string,
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
  expectedPanePid?: number,
  expectedPaneOwnerId?: string,
): string[] {
  const hookSlot = buildClientAttachedHookSlot(hookName);
  const resizeCommand = buildBestEffortShellCommand(buildAuthoritativeHudResizeShellCommand(
    hudPaneId,
    heightLines,
    expectedPanePid,
    expectedPaneOwnerId,
  ));
  const unregisterCommand = buildBestEffortShellCommand(buildAuthoritativeHudResizeShellCommand(
    hudPaneId,
    heightLines,
    expectedPanePid,
    expectedPaneOwnerId,
    buildNestedTmuxShellCommand(`set-hook -u -t ${hookTarget} ${hookSlot}`),
  ));
  const oneShotCommand = shellQuoteSingle(`${resizeCommand}; ${unregisterCommand}`);
  return ['set-hook', '-t', hookTarget, hookSlot, `run-shell -b ${oneShotCommand}`];
}

export function buildUnregisterClientAttachedReconcileArgs(hookTarget: string, hookName: string): string[] {
  return ['set-hook', '-u', '-t', hookTarget, buildClientAttachedHookSlot(hookName)];
}

export function unregisterResizeHook(hookTarget: string, hookName: string): boolean {
  const result = runTmux(buildUnregisterResizeHookArgs(hookTarget, hookName));
  return result.ok;
}

export function buildScheduleDelayedHudResizeArgs(
  hudPaneId: string,
  delaySeconds: number = HUD_RESIZE_RECONCILE_DELAY_SECONDS,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
  expectedPanePid?: number,
  expectedPaneOwnerId?: string,
): string[] {
  const delay = Number.isFinite(delaySeconds) && delaySeconds > 0 ? delaySeconds : HUD_RESIZE_RECONCILE_DELAY_SECONDS;
  return ['run-shell', '-b', `sleep ${delay}; ${buildBestEffortShellCommand(buildAuthoritativeHudResizeShellCommand(hudPaneId, heightLines, expectedPanePid, expectedPaneOwnerId))}`];
}

export function buildReconcileHudResizeArgs(
  hudPaneId: string,
  heightLines: number = HUD_TMUX_TEAM_HEIGHT_LINES,
  expectedPanePid?: number,
  expectedPaneOwnerId?: string,
): string[] {
  return ['run-shell', buildBestEffortShellCommand(buildAuthoritativeHudResizeShellCommand(hudPaneId, heightLines, expectedPanePid, expectedPaneOwnerId))];
}

function redrawLeaderPaneAfterTeamLayout(
  leaderPaneId: string,
  expectedPanePid: number,
  expectedTeamOwnerId: string,
): void {
  const target = leaderPaneId.trim();
  if (!target.startsWith('%')) return;
  const provenTarget = requireLiveTeamOwnedPaneSync(target, expectedPanePid, expectedTeamOwnerId);
  runTmux(['send-keys', '-t', provenTarget, 'C-l']);
}

const ZSH_CANDIDATE_PATHS = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/local/bin/zsh', '/opt/homebrew/bin/zsh'];
const BASH_CANDIDATE_PATHS = ['/bin/bash', '/usr/bin/bash'];

function buildShellLaunchSpec(shell: string, rcFile: string | null): WorkerLaunchSpec {
  return { shell, rcFile };
}

export function shouldSourceTeamWorkerShellRc(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.OMX_TMUX_SOURCE_SHELL_RC ?? '').trim() === '1';
}

function resolveSupportedShellAffinity(shellPath: string | undefined): WorkerLaunchSpec | null {
  if (!shellPath || shellPath.trim() === '' || !existsSync(shellPath)) return null;
  if (/\/zsh$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.zshrc');
  if (/\/bash$/i.test(shellPath)) return buildShellLaunchSpec(shellPath, '~/.bashrc');
  return null;
}

function resolveShellFromCandidates(paths: string[], rcFile: string): WorkerLaunchSpec | null {
  for (const shellPath of paths) {
    if (existsSync(shellPath)) return buildShellLaunchSpec(shellPath, rcFile);
  }
  return null;
}

function buildWorkerLaunchSpec(shellPath: string | undefined): WorkerLaunchSpec {
  if (isMsysOrGitBash()) {
    return buildShellLaunchSpec('/bin/sh', null);
  }

  const affinitySpec = resolveSupportedShellAffinity(shellPath);
  if (affinitySpec) return affinitySpec;

  const zshSpec = resolveShellFromCandidates(ZSH_CANDIDATE_PATHS, '~/.zshrc');
  if (zshSpec) return zshSpec;

  const bashSpec = resolveShellFromCandidates(BASH_CANDIDATE_PATHS, '~/.bashrc');
  if (bashSpec) return bashSpec;

  return buildShellLaunchSpec('/bin/sh', null);
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function someConfigOverrideBeforeEndOfOptions(
  args: readonly string[],
  matches: (value: string) => boolean,
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;

    let value: string | undefined;
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      value = args[index + 1];
      if (value === '--') break;
      index += 1;
    } else if (arg.startsWith(`${CONFIG_FLAG}=`)) {
      value = arg.slice(`${CONFIG_FLAG}=`.length);
    } else if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      value = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
    } else {
      continue;
    }

    if (typeof value === 'string' && matches(value)) return true;
  }
  return false;
}

function hasModelInstructionsOverride(args: readonly string[]): boolean {
  return someConfigOverrideBeforeEndOfOptions(args, isModelInstructionsOverride);
}

function normalizeTeamWorkerCliMode(raw: string | undefined, sourceEnv: string = OMX_TEAM_WORKER_CLI_ENV): TeamWorkerCliMode {
  const normalized = String(raw ?? 'auto').trim().toLowerCase();
  if (normalized === '' || normalized === 'auto') return 'auto';
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') return normalized;
  throw new Error(`Invalid ${sourceEnv} value "${raw}". Expected: auto, codex, claude, gemini`);
}

export function resolveTeamWorkerLaunchMode(
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerLaunchMode {
  const raw = String(env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV] ?? 'interactive').trim().toLowerCase();
  if (raw === '' || raw === 'interactive') return 'interactive';
  if (raw === 'prompt') return 'prompt';
  throw new Error(`Invalid ${OMX_TEAM_WORKER_LAUNCH_MODE_ENV} value "${env[OMX_TEAM_WORKER_LAUNCH_MODE_ENV]}". Expected: interactive, prompt`);
}

function extractModelOverride(args: string[]): string | null {
  let model: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg === MODEL_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && maybeValue.trim() !== '' && !maybeValue.startsWith('-')) {
        model = maybeValue.trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith(`${MODEL_FLAG}=`)) {
      const inline = arg.slice(`${MODEL_FLAG}=`.length).trim();
      if (inline !== '') model = inline;
    }
  }
  return model;
}

export function resolveTeamWorkerCli(launchArgs: string[] = [], env: NodeJS.ProcessEnv = process.env): TeamWorkerCli {
  const mode = normalizeTeamWorkerCliMode(env[OMX_TEAM_WORKER_CLI_ENV]);
  if (mode !== 'auto') return mode;
  return resolveTeamWorkerCliFromLaunchArgs(launchArgs);
}

function resolveTeamWorkerCliFromLaunchArgs(launchArgs: string[] = []): TeamWorkerCli {
  const model = extractModelOverride(launchArgs);
  if (model && /claude/i.test(model)) return 'claude';
  if (model && /gemini/i.test(model)) return 'gemini';
  return 'codex';
}

export function resolveTeamWorkerCliPlan(
  workerCount: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli[] {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }

  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  const fallback = (): TeamWorkerCli => resolveTeamWorkerCli(launchArgs, env);
  const fallbackAutoFromArgs = (): TeamWorkerCli => resolveTeamWorkerCliFromLaunchArgs(launchArgs);

  if (rawMap === '') {
    const cli = fallback();
    return Array.from({ length: workerCount }, () => cli);
  }

  const entries = rawMap
    .split(',')
    .map((part) => part.trim());

  if (entries.length === 0 || entries.every((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Expected comma-separated values: auto|codex|claude|gemini.`,
    );
  }
  if (entries.some((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Empty entries are not allowed.`,
    );
  }
  if (entries.length !== 1 && entries.length !== workerCount) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; `
        + `expected 1 or ${workerCount} comma-separated values.`,
    );
  }

  const expanded = entries.length === 1 ? Array.from({ length: workerCount }, () => entries[0] as string) : entries;
  return expanded.map((entry) => {
    const mode = normalizeTeamWorkerCliMode(entry, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? fallbackAutoFromArgs() : mode;
  });
}

export function resolveTeamWorkerCliForResolvedLaunchArgs(
  workerIndex: number,
  workerCount: number,
  resolvedLaunchArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!Number.isInteger(workerIndex) || workerIndex < 1 || workerIndex > workerCount) {
    throw new Error(`workerIndex must be within 1..${workerCount} (got ${workerIndex})`);
  }

  const rawMap = String(env.OMX_TEAM_WORKER_CLI_MAP ?? '').trim();
  const autoCli = resolveTeamWorkerCli(resolvedLaunchArgs, {
    ...env,
    OMX_TEAM_WORKER_CLI: 'auto',
  });
  const normalizeEntry = (entry: string): TeamWorkerCli | 'auto' | null => {
    const normalized = entry.trim().toLowerCase();
    if (normalized === 'auto' || normalized === 'codex' || normalized === 'claude' || normalized === 'gemini') {
      return normalized;
    }
    return null;
  };
  const invalidMapError = () => new Error(
    `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
      + `Expected comma-separated values: auto|codex|claude|gemini.`,
  );

  if (rawMap === '') {
    return resolveTeamWorkerCli(resolvedLaunchArgs, env);
  }

  const entries = rawMap.split(',').map((part) => part.trim());
  if (entries.length === 0 || entries.every((part) => part.length === 0)) {
    throw invalidMapError();
  }
  if (entries.some((part) => part.length === 0)) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} value "${env[OMX_TEAM_WORKER_CLI_MAP_ENV]}". `
        + `Empty entries are not allowed.`,
    );
  }
  if (entries.length !== 1 && entries.length !== workerCount) {
    throw new Error(
      `Invalid ${OMX_TEAM_WORKER_CLI_MAP_ENV} length ${entries.length}; `
        + `expected 1 or ${workerCount} comma-separated values.`,
    );
  }

  const entry = entries.length === 1 ? entries[0] as string : entries[workerIndex - 1];
  const mode = normalizeEntry(entry);
  if (!mode) throw invalidMapError();
  return mode === 'auto' ? autoCli : mode;
}

function shouldGrantExecutionBypassForRole(workerRole?: string): boolean {
  const normalizedRole = workerRole?.trim().toLowerCase();
  if (!normalizedRole) return true;
  const agent = getAgent(normalizedRole);
  if (!agent) return true;
  return agent.tools === 'execution';
}

export function assertTeamWorkerCliPolicyCompatibility(workerCli: TeamWorkerCli, launchArgs: string[]): void {
  const policy = classifyTeamWorkerLaunchPolicy(launchArgs);
  if ((workerCli === 'claude' || workerCli === 'gemini') && (policy === 'direct-policy' || policy === 'mixed-policy')) {
    throw new Error(
      `Selected team worker CLI "${workerCli}" is incompatible with an explicit approval or sandbox policy.`,
    );
  }
}

export function assertTeamWorkerLaunchPolicyInvariant(workerCli: TeamWorkerCli, launchArgs: string[]): void {
  assertTeamWorkerCliPolicyCompatibility(workerCli, launchArgs);
  if (workerCli === 'codex' && classifyTeamWorkerLaunchPolicy(launchArgs) === 'mixed-policy') {
    throw new Error('internal_mixed_codex_worker_policy_argv');
  }
}


export function translateWorkerLaunchArgsForCli(
  workerCli: TeamWorkerCli,
  args: string[],
  initialPrompt?: string,
  workerRole?: string,
): string[] {
  if (workerCli === 'codex') return [...args];
  if (workerCli === 'gemini') {
    const model = extractModelOverride(args);
    const geminiModel = model && /gemini/i.test(model) ? model : null;
    const translatedArgs = shouldGrantExecutionBypassForRole(workerRole)
      ? [GEMINI_APPROVAL_MODE_FLAG, GEMINI_APPROVAL_MODE_YOLO]
      : [];
    const trimmedPrompt = initialPrompt?.trim();
    if (trimmedPrompt) translatedArgs.push(GEMINI_PROMPT_INTERACTIVE_FLAG, trimmedPrompt);
    if (geminiModel) translatedArgs.push(MODEL_FLAG, geminiModel);
    return translatedArgs;
  }

  // Claude workers must launch with exactly one permissions bypass flag.
  // All other launch args are dropped to avoid Codex-only flags and model/config overrides.
  void args;
  return shouldGrantExecutionBypassForRole(workerRole) ? [CLAUDE_SKIP_PERMISSIONS_FLAG] : [];
}

function commandExists(binary: string): boolean {
  const { result } = spawnPlatformCommandSync(binary, ['--version'], { encoding: 'utf-8' });
  if (result.error) {
    return classifySpawnError(result.error as NodeJS.ErrnoException) !== 'missing';
  }
  return true;
}

export function trustWorkerMiseConfigIfAvailable(workerCwd: string): boolean {
  const miseConfigPath = join(workerCwd, '.mise.toml');
  if (!existsSync(miseConfigPath)) return false;
  if (!commandExists('mise')) return false;

  const { result } = spawnPlatformCommandSync('mise', ['trust', '--yes', miseConfigPath], { encoding: 'utf-8' });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || String(result.stderr || '').trim() || `mise exited ${result.status}`;
    console.warn(`[omx] mise trust failed for team worker config ${miseConfigPath}: ${reason}; continuing.`);
    return false;
  }
  return true;
}

/**
 * Resolve the absolute path of a binary from the leader's current environment.
 * Returns the absolute path or the bare command name as fallback.
 */
function resolveAbsoluteBinaryPath(binary: string): string {
  return resolveCommandPathForPlatform(binary) || binary;
}

/**
 * Resolve the leader's node binary path.
 * Caches results for the process lifetime.
 */
let _leaderPaths: { node: string; } | null = null;
function resolveLeaderNodePath(): string {
  const envOverride = process.env[OMX_LEADER_NODE_PATH_ENV];
  if (typeof envOverride === 'string' && envOverride.trim() !== '') {
    return envOverride.trim();
  }
  if (!_leaderPaths) {
    _leaderPaths = { node: resolveAbsoluteBinaryPath('node') };
  }
  return _leaderPaths.node;
}

export function assertTeamWorkerCliBinaryAvailable(
  workerCli: TeamWorkerCli,
  existsImpl: (binary: string) => boolean = commandExists,
): void {
  if (existsImpl(workerCli)) return;
  throw new Error(
    `Selected team worker CLI "${workerCli}" is not available on PATH. `
      + `Install "${workerCli}" or set ${OMX_TEAM_WORKER_CLI_ENV}=codex|claude|gemini.`,
  );
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== '0';
}

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv): string {
  const filePath = translatePathForMsys(env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || join(cwd, 'AGENTS.md'));
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function readTmuxWorkerAmbientEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of TMUX_WORKER_AMBIENT_ENV_ALLOWLIST) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    inherited[key] = value;
  }
  return inherited;
}

export function scrubTeamWorkerHudOwnershipEnv<T extends Record<string, string | undefined>>(env: T): T {
  const scrubbed = { ...env };
  delete scrubbed[OMX_TMUX_HUD_OWNER_ENV];
  delete scrubbed[OMX_TMUX_HUD_LEADER_PANE_ENV];
  return scrubbed;
}

function hasConfigOverride(args: readonly string[], key: string): boolean {
  return someConfigOverrideBeforeEndOfOptions(args, (value) => {
    const trimmed = value.trim();
    return trimmed.startsWith(key) && /^\s*=/.test(trimmed.slice(key.length));
  });
}

function shouldDisableOmxMcpForTeamWorker(env: NodeJS.ProcessEnv): boolean {
  const raw = env[OMX_TEAM_WORKER_MCP_COMPAT_ENV]?.trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'on' || raw === 'compat');
}

function resolveCodexConfigPath(env: NodeJS.ProcessEnv): string {
  const codexHomeOverride = env.CODEX_HOME?.trim();
  const codexHomePath = codexHomeOverride
    ? (isAbsolute(codexHomeOverride) ? codexHomeOverride : resolve(codexHomeOverride))
    : join(homedir(), '.codex');
  return join(codexHomePath, 'config.toml');
}

function codexConfigDeclaresMcpServer(serverName: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const config = readFileSync(resolveCodexConfigPath(env), 'utf-8');
    const escaped = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*\\]\\s*$`, 'm')
      .test(config);
  } catch {
    return false;
  }
}

function appendTeamWorkerMcpDisableOverrides(args: string[], env: NodeJS.ProcessEnv): void {
  if (!shouldDisableOmxMcpForTeamWorker(env)) return;
  for (const server of TEAM_WORKER_DISABLED_OMX_MCP_SERVERS) {
    if (!codexConfigDeclaresMcpServer(server, env)) continue;
    const key = `mcp_servers.${server}.enabled`;
    if (hasConfigOverride(args, key)) continue;
    const endOfOptionsIndex = args.indexOf('--');
    args.splice(endOfOptionsIndex < 0 ? args.length : endOfOptionsIndex, 0, CONFIG_FLAG, `${key}=false`);
  }
}

function insertArgsBeforeEndOfOptions(args: string[], insertedArgs: readonly string[]): string[] {
  const endOfOptionsIndex = args.indexOf('--');
  if (endOfOptionsIndex < 0) return [...args, ...insertedArgs];
  return [...args.slice(0, endOfOptionsIndex), ...insertedArgs, ...args.slice(endOfOptionsIndex)];
}

function insertCanonicalCodexBypassBeforeEndOfOptions(args: string[]): string[] {
  const endOfOptionsIndex = args.indexOf('--');
  const preMarkerArgs = endOfOptionsIndex < 0 ? args : args.slice(0, endOfOptionsIndex);
  const postMarkerArgs = endOfOptionsIndex < 0 ? [] : args.slice(endOfOptionsIndex);
  return [
    ...preMarkerArgs.filter((arg) => arg !== CODEX_BYPASS_FLAG && arg !== MADMAX_FLAG),
    CODEX_BYPASS_FLAG,
    ...postMarkerArgs,
  ];
}

function resolveWorkerLaunchArgs(extraArgs: string[] = [], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  let merged = [...extraArgs];
  const initialPolicy = classifyTeamWorkerLaunchPolicy(merged);
  if (initialPolicy === 'direct-policy') {
    merged = normalizeTeamWorkerLaunchArgs(merged);
  }
  const policy = classifyTeamWorkerLaunchPolicy(merged);
  const ambientWantsBypass = parseTeamWorkerLaunchArgs(process.argv, 'ambient process arguments', { directPolicyMode: 'ignore' }).wantsBypass;
  if (policy === 'none' || policy === 'bypass') {
    const wantsBypass = ambientWantsBypass || policy === 'bypass';
    if (wantsBypass) {
      merged = insertCanonicalCodexBypassBeforeEndOfOptions(merged);
    }
  }
  if (shouldBypassDefaultSystemPrompt(env) && !hasModelInstructionsOverride(merged)) {
    merged = insertArgsBeforeEndOfOptions(merged, [CONFIG_FLAG, buildModelInstructionsOverride(cwd, env)]);
  }
  return merged;
}


export function buildWorkerStartupCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): string {
  const processSpec = buildWorkerStartupProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
  const startupEnv = scrubTeamWorkerHudOwnershipEnv({
    ...readTmuxWorkerAmbientEnv(process.env),
    ...processSpec.env,
  });
  const startupArgs = [...processSpec.args];
  if (processSpec.workerCli === 'codex') {
    appendTeamWorkerMcpDisableOverrides(startupArgs, { ...process.env, ...extraEnv });
  }
  const resolvedLeaderNodePath = processSpec.env[OMX_LEADER_NODE_PATH_ENV]?.trim() || resolveLeaderNodePath();
  const leaderNodeDir = /[\\/]/.test(resolvedLeaderNodePath)
    ? translatePathForMsys(resolvedLeaderNodePath.replace(/[\\/][^\\/]+$/, ''))
    : '';
  if (isNativeWindows()) {
    const powershellPath = resolveNativeWindowsPowerShellPath();
    const pathBootstrap = leaderNodeDir
      ? `$env:PATH = ${quotePowerShellArg(`${leaderNodeDir};`)} + $env:PATH`
      : '';
    const hudEnvUnset = [OMX_TMUX_HUD_OWNER_ENV, OMX_TMUX_HUD_LEADER_PANE_ENV]
      .map((key) => `Remove-Item Env:${key} -ErrorAction SilentlyContinue`)
      .join('; ');
    const envAssignments = Object.entries(startupEnv)
      .map(([key, value]) => `$env:${key} = ${quotePowerShellArg(value)}`)
      .join('; ');
    const invocation = ['&', quotePowerShellArg(processSpec.command), ...startupArgs.map(quotePowerShellArg)].join(' ');
    const encodedCommand = encodePowerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        pathBootstrap,
        hudEnvUnset,
        envAssignments,
        invocation,
      ].filter(Boolean).join('; '),
    );
    return `${powershellPath} -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}`;
  }

  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const pathPrefix = leaderNodeDir ? `export PATH=${shellQuoteSingle(leaderNodeDir)}:$PATH; ` : '';
  const quotedArgs = startupArgs.map((arg) => shellQuoteSingle(translatePathForMsys(arg))).join(' ');
  const quotedCommand = shellQuoteSingle(translatePathForMsys(processSpec.command));
  const cliInvocation = quotedArgs.length > 0 ? `exec ${quotedCommand} ${quotedArgs}` : `exec ${quotedCommand}`;
  // Keep worker tmux panes non-interactive and rc-free by default. PR #2283
  // blocked rc sourcing for detached leader/HUD panes, but team workers still
  // sourced ~/.bashrc or ~/.zshrc here, leaving the same #2239/#2282/#2358
  // recursive bash fan-out path open when team/ultrawork created workers.
  // Users who intentionally need legacy shell PATH bootstrapping can opt in
  // with the same tmux-pane escape hatch used by buildTmuxPaneCommand().
  const rcPrefix = shouldSourceTeamWorkerShellRc({ ...process.env, ...extraEnv }) && launchSpec.rcFile
    ? `if [ -f ${launchSpec.rcFile} ]; then source ${launchSpec.rcFile}; fi; `
    : '';
  const inner = `${rcPrefix}${pathPrefix}${cliInvocation}`;
  const envParts = Object.entries(startupEnv).map(([key, value]) => `${key}=${value}`);
  const unsetParts = ['-u', OMX_TMUX_HUD_OWNER_ENV, '-u', OMX_TMUX_HUD_LEADER_PANE_ENV];

  return `env ${[...unsetParts, ...envParts].map(shellQuoteSingle).join(' ')} ${shellQuoteSingle(launchSpec.shell)} -c ${shellQuoteSingle(inner)}`;
}

function assertShellEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid worker startup env key: ${key}`);
  }
}

function buildWorkerStartupScriptContent(
  processSpec: WorkerProcessLaunchSpec,
  startupEnv: Record<string, string>,
  startupArgs: string[],
  cwd: string,
  extraEnv: Record<string, string>,
): string {
  const resolvedLeaderNodePath = processSpec.env[OMX_LEADER_NODE_PATH_ENV]?.trim() || resolveLeaderNodePath();
  const leaderNodeDir = /[\\/]/.test(resolvedLeaderNodePath)
    ? translatePathForMsys(resolvedLeaderNodePath.replace(/[\\/][^\\/]+$/, ''))
    : '';
  const launchSpec = buildWorkerLaunchSpec(process.env.SHELL);
  const pathPrefix = leaderNodeDir ? `export PATH=${shellQuoteSingle(leaderNodeDir)}:$PATH\n` : '';
  const quotedArgs = startupArgs.map((arg) => shellQuoteSingle(translatePathForMsys(arg))).join(' ');
  const quotedCommand = shellQuoteSingle(translatePathForMsys(processSpec.command));
  const cliInvocation = quotedArgs.length > 0 ? `exec ${quotedCommand} ${quotedArgs}` : `exec ${quotedCommand}`;
  const rcPrefix = shouldSourceTeamWorkerShellRc({ ...process.env, ...extraEnv }) && launchSpec.rcFile
    ? `if [ -f ${launchSpec.rcFile} ]; then . ${launchSpec.rcFile}; fi\n`
    : '';
  const envExports = Object.entries(startupEnv)
    .map(([key, value]) => {
      assertShellEnvKey(key);
      return `export ${key}=${shellQuoteSingle(value)}`;
    })
    .join('\n');

  return [
    '#!/bin/sh',
    'set -eu',
    `unset ${OMX_TMUX_HUD_OWNER_ENV} ${OMX_TMUX_HUD_LEADER_PANE_ENV}`,
    `cd ${shellQuoteSingle(translatePathForMsys(cwd))}`,
    envExports,
    `exec ${shellQuoteSingle(launchSpec.shell)} -c ${shellQuoteSingle(`${rcPrefix}${pathPrefix}${cliInvocation}`)}`,
    '',
  ].filter((line) => line !== '').join('\n');
}

export function writeWorkerStartupScriptCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): string | null {
  if (process.platform === 'win32' && !isMsysOrGitBash()) return null;
  const stateRoot = extraEnv[OMX_TEAM_STATE_ROOT_ENV]?.trim();
  if (!stateRoot) return null;

  const processSpec = buildWorkerStartupProcessLaunchSpec(
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
  const startupEnv = {
    ...readTmuxWorkerAmbientEnv(process.env),
    ...processSpec.env,
  };
  const startupArgs = [...processSpec.args];
  if (processSpec.workerCli === 'codex') {
    appendTeamWorkerMcpDisableOverrides(startupArgs, { ...process.env, ...extraEnv });
  }

  const scriptPath = join(stateRoot, 'team', teamName, 'runtime', `worker-${workerIndex}-startup.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, buildWorkerStartupScriptContent(processSpec, startupEnv, startupArgs, cwd, extraEnv), 'utf-8');
  chmodSync(scriptPath, 0o700);
  return `exec /bin/sh ${shellQuoteSingle(translatePathForMsys(scriptPath))}`;
}

type WorkerProcessLaunchMode = 'direct-spawn' | 'posix-startup-script';

export function buildWorkerProcessLaunchSpec(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  return buildWorkerProcessLaunchSpecForMode(
    'direct-spawn',
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
}

function buildWorkerStartupProcessLaunchSpec(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  return buildWorkerProcessLaunchSpecForMode(
    'posix-startup-script',
    teamName,
    workerIndex,
    launchArgs,
    cwd,
    extraEnv,
    workerCliOverride,
    initialPrompt,
    workerRole,
  );
}

function buildWorkerProcessLaunchSpecForMode(
  mode: WorkerProcessLaunchMode,
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
  extraEnv: Record<string, string> = {},
  workerCliOverride?: TeamWorkerCli,
  initialPrompt?: string,
  workerRole?: string,
): WorkerProcessLaunchSpec {
  const effectiveEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const fullLaunchArgs = resolveWorkerLaunchArgs(launchArgs, cwd, effectiveEnv);
  const workerCli = workerCliOverride ?? resolveTeamWorkerCli(fullLaunchArgs, effectiveEnv);
  assertTeamWorkerLaunchPolicyInvariant(workerCli, fullLaunchArgs);

  const cliLaunchArgs = translateWorkerLaunchArgsForCli(workerCli, fullLaunchArgs, initialPrompt, workerRole);
  const launchPolicy = workerCli === 'codex'
    ? classifyTeamWorkerLaunchPolicy(cliLaunchArgs)
    : 'none';
  const effectiveCliLaunchArgs = workerCli === 'codex'
    && shouldGrantExecutionBypassForRole(workerRole)
    && launchPolicy === 'none'
    ? insertCanonicalCodexBypassBeforeEndOfOptions(cliLaunchArgs)
    : cliLaunchArgs;
  const workerCodexHomeOverride = typeof effectiveEnv.CODEX_HOME === 'string'
    ? effectiveEnv.CODEX_HOME.trim()
    : undefined;
  const workerSqliteHomeOverride = typeof effectiveEnv[CODEX_SQLITE_HOME_ENV] === 'string'
    ? effectiveEnv[CODEX_SQLITE_HOME_ENV].trim()
    : undefined;
  const providerLookupCodexHome = workerCodexHomeOverride
    ? (isAbsolute(workerCodexHomeOverride) ? workerCodexHomeOverride : resolve(cwd, workerCodexHomeOverride))
    : undefined;

  const resolvedCliPath = resolveAbsoluteBinaryPath(workerCli);
  const shouldUseNativeWindowsLaunchSpec = process.platform === 'win32'
    && (mode === 'direct-spawn' || !isMsysOrGitBash(effectiveEnv, process.platform));

  const platformSpec = shouldUseNativeWindowsLaunchSpec
    ? buildPlatformCommandSpec(workerCli, effectiveCliLaunchArgs, process.platform, effectiveEnv)
    : { command: resolvedCliPath, args: effectiveCliLaunchArgs, resolvedPath: resolvedCliPath };
  const resolvedLauncherPath = platformSpec.resolvedPath || resolvedCliPath;
  const modelProviderOverride = workerCli === 'codex'
    ? extractModelProviderOverrideValue(effectiveCliLaunchArgs)
    : undefined;
  const codexProviderEnv = workerCli === 'codex'
    ? readActiveProviderEnvOverrides(
        effectiveEnv,
        providerLookupCodexHome,
        modelProviderOverride,
      )
    : {};
  const internalWorkerIdentity = `${teamName}/worker-${workerIndex}`;
  const displayTeamName = typeof extraEnv.OMX_TEAM_DISPLAY_NAME === 'string'
    ? extraEnv.OMX_TEAM_DISPLAY_NAME.trim()
    : '';
  const publicWorkerIdentity = displayTeamName
    ? `${displayTeamName}/worker-${workerIndex}`
    : internalWorkerIdentity;
  const workerEnv: Record<string, string> = {
    OMX_TEAM_WORKER: publicWorkerIdentity,
    OMX_TEAM_INTERNAL_WORKER: internalWorkerIdentity,
    [OMX_LEADER_NODE_PATH_ENV]: resolveLeaderNodePath(),
    [OMX_LEADER_CLI_PATH_ENV]: resolvedLauncherPath,
    ...(workerCli === 'codex' && workerCodexHomeOverride
      ? { CODEX_HOME: workerCodexHomeOverride }
      : {}),
    ...(workerCli === 'codex' && workerSqliteHomeOverride
      ? { [CODEX_SQLITE_HOME_ENV]: workerSqliteHomeOverride }
      : {}),
    ...codexProviderEnv,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    workerEnv[key] = value;
  }

  return {
    workerCli,
    command: platformSpec.command,
    args: platformSpec.args,
    env: scrubTeamWorkerHudOwnershipEnv(workerEnv),
  };
}

// Sanitize team name: lowercase, alphanumeric + hyphens, max 30 chars
export function sanitizeTeamName(name: string): string {
  const lowered = name.toLowerCase();
  const replaced = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');

  const truncated = replaced.slice(0, 30).replace(/-$/, '');
  if (truncated.trim() === '') {
    throw new Error('sanitizeTeamName: empty after sanitization');
  }
  return truncated;
}

/**
 * Detect whether the process is running inside a WSL2 environment.
 * WSL2 always sets WSL_DISTRO_NAME; WSL_INTEROP is also present.
 * Fallback: check /proc/version for the Microsoft kernel string.
 */
export function isWsl2(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }
  try {
    const version = readFileSync('/proc/version', 'utf-8');
    return /microsoft/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Detect whether the process is running on native Windows (not WSL2).
 * OMX requires tmux, which is unavailable on native Windows.
 */
export function isNativeWindows(): boolean {
  return process.platform === 'win32' && !isWsl2() && !isMsysOrGitBash();
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const { result } = spawnPlatformCommandSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}

// Create tmux session with N worker windows
// Split the current tmux leader window into worker panes.
// Returns TeamSession or throws if tmux not available
export function createTeamSession(
  teamName: string,
  workerCount: number,
  cwd: string,
  workerLaunchArgs: string[] = [],
  workerStartups: Array<{
    cwd?: string;
    env?: Record<string, string>;
    initialPrompt?: string;
    launchArgs?: string[];
    workerCli?: TeamWorkerCli;
    workerRole?: string;
  }> = [],
  options: CreateTeamSessionOptions = {},
): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!hasCurrentTmuxClientContext()) {
    throw new Error('team mode requires running inside tmux leader pane');
  }
  const normalizedWorkerLaunchArgs = resolveWorkerLaunchArgs(workerLaunchArgs, cwd);
  const defaultWorkerCliPlan = resolveTeamWorkerCliPlan(workerCount, normalizedWorkerLaunchArgs, process.env);
  const workerCliPlan = Array.from(
    { length: workerCount },
    (_, index) => workerStartups[index]?.workerCli ?? defaultWorkerCliPlan[index]!,
  );
  for (const workerCli of new Set(workerCliPlan)) {
    assertTeamWorkerCliBinaryAvailable(workerCli);
  }
  const workerLaunchPolicyPlan = Array.from({ length: workerCount }, (_, index) => {
    const startup = workerStartups[index] ?? {};
    const workerCwd = startup.cwd || cwd;
    const workerEnv = startup.env || {};
    const launchArgs = startup.launchArgs || workerLaunchArgs;
    const effectiveLaunchArgs = resolveWorkerLaunchArgs(
      launchArgs,
      workerCwd,
      { ...process.env, ...workerEnv },
    );
    assertTeamWorkerLaunchPolicyInvariant(workerCliPlan[index]!, effectiveLaunchArgs);
    return Object.freeze([...launchArgs]);
  });

  const safeTeamName = sanitizeTeamName(teamName);
  type RegisteredHudHook = {
    name: string;
    target: string;
    leaderPaneId: string;
    leaderPanePid: number;
    hudPaneId: string;
    hudPanePid: number;
    teamPaneOwnerId: string;
  };
  let registeredResizeHook: RegisteredHudHook | null = null;
  let registeredClientAttachedHook: RegisteredHudHook | null = null;
  const rollbackPanes = new Map<string, number | null>();
  // An owner-tag command may have succeeded even if tmux reports an ambiguous
  // failure; rollback can only kill panes whose owner is re-authorized.
  const rollbackTaggedPaneOwnerIds = new Map<string, string>();
  let partialTeamTarget: string | null = null;
  let partialLeaderPaneId: string | null = null;
  let partialLeaderPanePid: number | undefined;
  let partialTeamPaneOwnerId = '';
  const partialWorkerPaneIds: string[] = [];
  const partialWorkerPaneIdsByIndex: Array<string | null> = Array.from({ length: workerCount }, () => null);
  const partialWorkerPanePidsByIndex: Array<number | null> = Array.from({ length: workerCount }, () => null);
  let partialHudPaneId: string | null = null;
  let partialHudPanePid: number | null = null;

  try {
    const tmuxPaneTarget = process.env.TMUX_PANE;
    const displayArgs = tmuxPaneTarget
      ? ['display-message', '-p', '-t', tmuxPaneTarget, '#{session_name}:#{window_index} #{pane_id}']
      : ['display-message', '-p', '#{session_name}:#{window_index} #{pane_id}'];
    const context = runTmux(displayArgs);
    if (!context.ok) {
      const paneHint = tmuxPaneTarget ? ` (TMUX_PANE=${tmuxPaneTarget})` : '';
      throw new Error(`failed to detect current tmux target${paneHint}: ${context.stderr}`);
    }
    const [sessionAndWindow = '', detectedLeaderPaneId = ''] = context.stdout.split(' ');
    const [sessionName, windowIndex] = (sessionAndWindow || '').split(':');
    if (!sessionName || !windowIndex || !detectedLeaderPaneId || !detectedLeaderPaneId.startsWith('%')) {
      throw new Error(`failed to parse current tmux target: ${context.stdout}`);
    }
    const teamTarget = `${sessionName}:${windowIndex}`;
    partialTeamTarget = teamTarget;
    const ownerSessionId = (options.ownerSessionId ?? process.env.OMX_SESSION_ID ?? '').trim();
    const teamPaneOwnerId = (options.teamPaneOwnerId ?? `team:${safeTeamName}`).trim();
    partialTeamPaneOwnerId = teamPaneOwnerId;
    const paneListResult = listPanesResult(teamTarget);
    if (paneListResult.error) throw new Error(`failed to read tmux pane topology: ${paneListResult.error}`);
    const leaderPaneId = chooseTeamLeaderPaneId(paneListResult.panes, detectedLeaderPaneId);
    const leaderProof = readExactPaneProofSync(leaderPaneId);
    if (leaderProof.status === 'unavailable') throw new ExactPaneProofUnavailableError(leaderProof);
    if (leaderProof.status === 'gone') throw new Error(`tmux pane is not proven live: ${leaderPaneId}`);
    const leaderPanePid = leaderProof.pid;
    partialLeaderPaneId = leaderPaneId;
    partialLeaderPanePid = leaderPanePid;
    const initialHudPaneIds = findHudWatchPaneIds(paneListResult.panes, leaderPaneId, { leaderPaneId });
    const initialWindowPanePids = new Map<string, number>([[leaderPaneId, leaderPanePid]]);

    const omxEntry = resolveOmxCliEntryPath();
    const canRecreateTeamHud = Boolean(omxEntry && omxEntry.trim() !== '');
    // Freeze every HUD owned by this leader even when startup cannot recreate
    // it; the untouched pane remains part of the authorized topology.
    for (const hudPaneId of initialHudPaneIds) {
      const proof = readExactPaneProofSync(hudPaneId);
      if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
      if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${hudPaneId}`);
      initialWindowPanePids.set(hudPaneId, proof.pid);
    }
    // Team mode prioritizes leader + worker visibility. Remove HUD panes only
    // when we can recreate the team HUD. Otherwise keep the existing HUD alive
    // instead of making it disappear on team startup failures or broken installs.
    requireFrozenWindowTopologySync(teamTarget, initialWindowPanePids);
    if (ownerSessionId) {
      const tagResult = runTmux(['set-option', '-t', sessionName, OMX_INSTANCE_OPTION, ownerSessionId]);
      if (!tagResult.ok) {
        throw new Error(`failed to tag tmux session ${sessionName}: ${tagResult.stderr}`);
      }
    }
    tagPaneInstance(leaderPaneId, ownerSessionId, leaderPanePid);
    tagPaneTeamOwner(leaderPaneId, teamPaneOwnerId, leaderPanePid);
    if (canRecreateTeamHud) {
      for (const [hudPaneId, hudPanePid] of initialWindowPanePids) {
        if (hudPaneId !== leaderPaneId) killExactPaneSync(hudPaneId, hudPanePid);
      }
    }

    const workerPaneIds: string[] = [];
    const workerPanePidsByIndex: Array<number | null> = Array.from({ length: workerCount }, () => null);
    let rightStackRootPaneId: string | null = null;
    let rightStackRootPanePid: number | null = null;
    const frozenWindowPanePids = new Map<string, number>([[leaderPaneId, leaderPanePid]]);
    const frozenWindowPaneOwners = new Map<string, string>([[leaderPaneId, teamPaneOwnerId]]);

    for (let i = 1; i <= workerCount; i++) {
      const startup = workerStartups[i - 1] || {};
      const workerCwd = startup.cwd || cwd;
      const tmuxWorkerCwd = translatePathForMsys(workerCwd);
      const workerEnv = startup.env || {};
      const launchArgsForWorker = [...(workerLaunchPolicyPlan[i - 1] ?? workerLaunchArgs)];
      trustWorkerMiseConfigIfAvailable(workerCwd);
      const cmd = writeWorkerStartupScriptCommand(
        safeTeamName,
        i,
        launchArgsForWorker,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
        startup.initialPrompt,
        startup.workerRole,
      ) ?? buildWorkerStartupCommand(
        safeTeamName,
        i,
        launchArgsForWorker,
        workerCwd,
        workerEnv,
        workerCliPlan[i - 1],
        startup.initialPrompt,
        startup.workerRole,
      );
      // First split creates the right side from leader. Remaining splits stack on the right.
      const splitDirection = i === 1 ? '-h' : '-v';
      const splitTarget = requireLiveTeamOwnedPaneSync(
        i === 1 ? leaderPaneId : (rightStackRootPaneId ?? leaderPaneId),
        i === 1 ? leaderPanePid : (rightStackRootPanePid ?? leaderPanePid),
        teamPaneOwnerId,
      );

      const split = runTmux([
        'split-window',
        splitDirection,
        '-t',
        splitTarget,
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-c',
        tmuxWorkerCwd,
        cmd,
      ]);
      if (!split.ok) {
        throw new Error(`failed to create worker pane ${i}: ${split.stderr}`);
      }
      const paneId = split.stdout.split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        throw new Error(`failed to capture worker pane id for worker ${i}`);
      }
      // The pane exists once split-window returns its concrete ID. Persist it in
      // rollback/partial state before its first proof: a malformed or unavailable
      // topology must retain cleanup debt, but cannot authorize an effect.
      rollbackPanes.set(paneId, null);
      partialWorkerPaneIds.push(paneId);
      partialWorkerPaneIdsByIndex[i - 1] = paneId;
      const paneProof = readExactPaneProofSync(paneId);
      if (paneProof.status === 'unavailable') throw new ExactPaneProofUnavailableError(paneProof);
      if (paneProof.status === 'gone') throw new Error(`tmux pane is not proven live: ${paneId}`);
      const panePid = paneProof.pid;
      rollbackPanes.set(paneId, panePid);
      partialWorkerPanePidsByIndex[i - 1] = panePid;
      workerPanePidsByIndex[i - 1] = panePid;
      frozenWindowPanePids.set(paneId, panePid);
      if (isNativeWindows() && !waitForPaneToRemainPresent(teamTarget, paneId)) {
        throw new Error(`worker pane ${i} did not remain present after tmux split-window returned ${paneId}`);
      }
      tagPaneInstance(paneId, ownerSessionId, panePid);
      rollbackTaggedPaneOwnerIds.set(paneId, teamPaneOwnerId);
      tagPaneTeamOwner(paneId, teamPaneOwnerId, panePid);
      frozenWindowPaneOwners.set(paneId, teamPaneOwnerId);
      workerPaneIds.push(paneId);
      if (i === 1) {
        rightStackRootPaneId = paneId;
        rightStackRootPanePid = panePid;
      }

    }

    // Keep leader as full left/main pane; workers stay stacked on the right.
    requireFrozenWindowTopologySync(teamTarget, frozenWindowPanePids, frozenWindowPaneOwners);
    runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);

    // Force leader pane to use half the window width.
    const windowWidthResult = runTmux(['display-message', '-p', '-t', teamTarget, '#{window_width}']);
    if (windowWidthResult.ok) {
      const width = Number.parseInt(windowWidthResult.stdout.split('\n')[0]?.trim() || '', 10);
      if (Number.isFinite(width) && width >= 40) {
        const half = String(Math.floor(width / 2));
        requireFrozenWindowTopologySync(teamTarget, frozenWindowPanePids, frozenWindowPaneOwners);
        runTmux(['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
        requireFrozenWindowTopologySync(teamTarget, frozenWindowPanePids, frozenWindowPaneOwners);
        runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);
      }
    }

    // Re-create a single team HUD as a full-width bottom strip spanning both
    // leader + worker columns. Keep this after layout sizing so the main
    // leader/worker topology stays readable and the HUD remains compact.
    // Capture the HUD pane ID so it can be tracked and excluded from worker cleanup.
    let hudPaneId: string | null = null;
    let resizeHookName: string | null = null;
    let resizeHookTarget: string | null = null;
    if (canRecreateTeamHud && omxEntry) {
      const hudCmd = `exec env ${formatHudEnvAssignments(process.env, { sessionId: ownerSessionId, leaderPaneId })} node ${shellQuoteSingle(translatePathForMsys(omxEntry))} hud --watch`;
      const hudCwd = translatePathForMsys(cwd);
      requireFrozenWindowTopologySync(teamTarget, frozenWindowPanePids, frozenWindowPaneOwners);
      const hudSplitTarget = leaderPaneId;

      const hudResult = runTmux([
        'split-window', '-v', '-f', '-l', String(HUD_TMUX_TEAM_HEIGHT_LINES), '-t', hudSplitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', hudCwd, hudCmd,
      ]);
      if (hudResult.ok) {
        const id = hudResult.stdout.split('\n')[0]?.trim() ?? '';
        if (id.startsWith('%')) {
          // split-window has created a concrete pane even though no proof has
          // authorized an effect yet. Retain PID-less cleanup debt first.
          rollbackPanes.set(id, null);
          partialHudPaneId = id;
          partialHudPanePid = null;
          const hudProof = readExactPaneProofSync(id);
          if (hudProof.status === 'unavailable') throw new ExactPaneProofUnavailableError(hudProof);
          if (hudProof.status === 'gone') throw new Error(`tmux pane is not proven live: ${id}`);
          const hudPanePid = hudProof.pid;
          frozenWindowPanePids.set(id, hudPanePid);
          rollbackPanes.set(id, hudPanePid);
          partialHudPanePid = hudPanePid;
          if (isNativeWindows() && !waitForPaneToRemainPresent(teamTarget, id)) {
            throw new Error(`HUD pane did not remain present after tmux split-window returned ${id}`);
          }
          tagPaneInstance(id, ownerSessionId, hudPanePid);
          rollbackTaggedPaneOwnerIds.set(id, teamPaneOwnerId);
          tagPaneTeamOwner(id, teamPaneOwnerId, hudPanePid);
          frozenWindowPaneOwners.set(id, teamPaneOwnerId);
          hudPaneId = id;


          if (isNativeWindows()) {
            const provenHudPaneId = requireLiveTeamOwnedPaneSync(hudPaneId, hudPanePid, teamPaneOwnerId);
            const reconcile = runTmux(buildHudResizeArgs(provenHudPaneId));

            if (!reconcile.ok) {
              throw new Error(`failed to reconcile HUD resize: ${reconcile.stderr}`);
            }
          } else {
            const hookTarget = buildResizeHookTarget(sessionName, windowIndex);
            const hookName = buildResizeHookName(safeTeamName, sessionName, windowIndex, hudPaneId);
            requireLiveTeamOwnedPaneSync(hudPaneId, hudPanePid, teamPaneOwnerId);
            const registerHook = runTmux(buildRegisterResizeHookArgs(
              hookTarget,
              hookName,
              hudPaneId,
              HUD_TMUX_TEAM_HEIGHT_LINES,
              hudPanePid,
              teamPaneOwnerId,
            ));
            const clientAttachedHookName = buildClientAttachedReconcileHookName(
              safeTeamName,
              sessionName,
              windowIndex,
              hudPaneId,
            );
            if (registerHook.ok) {
              resizeHookTarget = hookTarget;
              resizeHookName = hookName;
              registeredResizeHook = {
                name: resizeHookName,
                target: resizeHookTarget,
                leaderPaneId,
                leaderPanePid,
                hudPaneId,
                hudPanePid,
                teamPaneOwnerId,
              };
            } else {
              console.warn(
                `[omx] tmux resize hook unavailable for ${hookTarget} (${hookName}): ${registerHook.stderr}; `
                  + 'continuing with best-effort HUD resize fallback.',
              );
            }
            requireLiveTeamOwnedPaneSync(hudPaneId, hudPanePid, teamPaneOwnerId);
            const registerClientAttachedHook = runTmux(
              buildRegisterClientAttachedReconcileArgs(
                hookTarget,
                clientAttachedHookName,
                hudPaneId,
                HUD_TMUX_TEAM_HEIGHT_LINES,
                hudPanePid,
                teamPaneOwnerId,
              ),
            );

            if (registerClientAttachedHook.ok) {
              registeredClientAttachedHook = {
                name: clientAttachedHookName,
                target: hookTarget,
                leaderPaneId,
                leaderPanePid,
                hudPaneId,
                hudPanePid,
                teamPaneOwnerId,
              };
            } else {
              console.warn(
                `[omx] tmux client-attached resize fallback unavailable for ${hookTarget} `
                  + `(${clientAttachedHookName}): ${registerClientAttachedHook.stderr}; continuing with delayed HUD resize fallback.`,
              );
            }

            requireLiveTeamOwnedPaneSync(hudPaneId, hudPanePid, teamPaneOwnerId);
            const delayed = runTmux(buildScheduleDelayedHudResizeArgs(
              hudPaneId,
              HUD_RESIZE_RECONCILE_DELAY_SECONDS,
              HUD_TMUX_TEAM_HEIGHT_LINES,
              hudPanePid,
              teamPaneOwnerId,
            ));

            if (!delayed.ok) {
              console.warn(`[omx] tmux delayed HUD resize unavailable for ${hudPaneId}: ${delayed.stderr}; continuing.`);
            }
            requireLiveTeamOwnedPaneSync(hudPaneId, hudPanePid, teamPaneOwnerId);
            const reconcile = runTmux(buildReconcileHudResizeArgs(
              hudPaneId,
              HUD_TMUX_TEAM_HEIGHT_LINES,
              hudPanePid,
              teamPaneOwnerId,
            ));

            if (!reconcile.ok) {
              console.warn(`[omx] tmux HUD resize reconcile unavailable for ${hudPaneId}: ${reconcile.stderr}; continuing.`);
            }
          }
        }
      }
    }

    runTmux(['select-pane', '-t', requireLiveTeamOwnedPaneSync(leaderPaneId, leaderPanePid, teamPaneOwnerId)]);
    redrawLeaderPaneAfterTeamLayout(leaderPaneId, leaderPanePid, teamPaneOwnerId);

    sleepSeconds(0.5);

    // Enable mouse scrolling so agent output panes can be scrolled with the
    // mouse wheel without conflicting with keyboard up/down arrow-key input
    // history navigation in the Codex CLI input field. (issue #103)
    // Opt-out: set OMX_TEAM_MOUSE=0 in the environment.
    if (process.env.OMX_TEAM_MOUSE !== '0') {
      enableMouseScrolling(
        sessionName,
        () => { requireLiveTeamOwnedPaneSync(leaderPaneId, leaderPanePid, teamPaneOwnerId); },
      );
    }

    const sessionIncarnation = teamTarget.includes(':') ? null : queryDetachedTeamSession(sessionName);
    if (sessionIncarnation && sessionIncarnation.status !== 'exact') {
      throw new Error(`tmux_session_incarnation_unavailable:${sessionName}`);
    }
    return {
      name: teamTarget,
      tmuxSessionId: sessionIncarnation?.incarnation.sessionId,
      tmuxSessionCreated: sessionIncarnation?.incarnation.sessionCreated,
      workerCount,
      cwd,
      workerPaneIds,
      workerPaneIdsByIndex: [...workerPaneIds],
      workerPanePidsByIndex,
      leaderPanePid,
      hudPanePid: partialHudPanePid,

      leaderPaneId,
      hudPaneId,
      resizeHookName,
      resizeHookTarget,
      teamPaneOwnerId,
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    const unregisterAuthorizedHook = (
      hook: RegisteredHudHook,
      unregister: (target: string, name: string) => string[],
      label: string,
    ): boolean => {
      try {
        requireLiveTeamOwnedPaneSync(hook.leaderPaneId, hook.leaderPanePid, hook.teamPaneOwnerId);
        requireLiveTeamOwnedPaneSync(hook.hudPaneId, hook.hudPanePid, hook.teamPaneOwnerId);
        const unregistered = runTmux(unregister(hook.target, hook.name));
        if (unregistered.ok) return true;
        cleanupErrors.push(`failed to unregister tmux ${label} hook ${hook.name}: ${unregistered.stderr}`);
      } catch (cleanupError) {
        cleanupErrors.push(`unable to authorize tmux ${label} hook cleanup ${hook.name}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      return false;
    };
    if (registeredClientAttachedHook && unregisterAuthorizedHook(
      registeredClientAttachedHook,
      buildUnregisterClientAttachedReconcileArgs,
      'client-attached',
    )) {
      registeredClientAttachedHook = null;
    }
    if (registeredResizeHook && unregisterAuthorizedHook(
      registeredResizeHook,
      buildUnregisterResizeHookArgs,
      'resize',
    )) {
      registeredResizeHook = null;
    }

    const proofUnavailable: Array<Extract<ExactPaneProof, { status: 'unavailable' }>> = [];
    if (error instanceof ExactPaneProofUnavailableError) proofUnavailable.push(error.proof);
    const unresolvedPaneIds = new Set(rollbackPanes.keys());
    for (const [paneId, panePid] of rollbackPanes) {
      // split-window IDs without a positive exact PID proof are cleanup debt,
      // never authorization to affect a potentially recycled pane ID.
      if (panePid === null) continue;
      try {
        const expectedOwnerId = rollbackTaggedPaneOwnerIds.get(paneId);
        killExactPaneSync(paneId, panePid, expectedOwnerId
          ? () => { requireLiveTeamOwnedPaneSync(paneId, panePid, expectedOwnerId); }
          : undefined);
        unresolvedPaneIds.delete(paneId);
      } catch (cleanupError) {
        if (cleanupError instanceof ExactPaneProofUnavailableError) {
          proofUnavailable.push(cleanupError.proof);
          break;
        } else {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
      }
    }

    const unresolvedWorkerPaneIds = partialWorkerPaneIds.filter((paneId) => unresolvedPaneIds.has(paneId));
    const unresolvedWorkerPaneIdsByIndex = partialWorkerPaneIdsByIndex
      .map((paneId) => paneId && unresolvedPaneIds.has(paneId) ? paneId : null);
    const unresolvedWorkerPanePidsByIndex = partialWorkerPanePidsByIndex
      .map((panePid, index) => partialWorkerPaneIdsByIndex[index] && unresolvedPaneIds.has(partialWorkerPaneIdsByIndex[index]!) ? panePid : null);

    const unresolvedHudPaneId = partialHudPaneId && (
      unresolvedPaneIds.has(partialHudPaneId)
      || registeredResizeHook !== null
      || registeredClientAttachedHook !== null
    )
      ? partialHudPaneId
      : null;
    const hasRecoverablePartialArtifact = unresolvedPaneIds.size > 0
      || registeredResizeHook !== null
      || registeredClientAttachedHook !== null;

    if (hasRecoverablePartialArtifact && partialTeamTarget && partialLeaderPaneId) {
      throw new CreateTeamSessionPartialError(
        {
          name: partialTeamTarget,
          workerCount,
          cwd,
          workerPaneIds: unresolvedWorkerPaneIds,
          workerPaneIdsByIndex: unresolvedWorkerPaneIdsByIndex,
          workerPanePidsByIndex: unresolvedWorkerPanePidsByIndex,
          leaderPanePid: partialLeaderPanePid,
          hudPanePid: unresolvedHudPaneId ? partialHudPanePid : null,
          leaderPaneId: partialLeaderPaneId,
          hudPaneId: unresolvedHudPaneId,
          resizeHookName: registeredResizeHook?.name ?? null,
          resizeHookTarget: registeredResizeHook?.target ?? null,
          teamPaneOwnerId: partialTeamPaneOwnerId,
        },
        proofUnavailable,
        error,
        cleanupErrors,
      );
    }
    throw error;
  }
}

export function restoreStandaloneHudPane(
  leaderPaneId: string | null | undefined,
  cwd: string,
  options: RestoreStandaloneHudPaneOptions = {},
): string | null {
  const normalizedLeaderPaneId = normalizePaneTarget(leaderPaneId);
  if (!normalizedLeaderPaneId) return null;
  // The split is irreversible without a durable cleanup obligation. Validate
  // its canonical Team-root location before authorizing any pane effect.
  restoredHudCleanupDebtPath(cwd, options.stateRoot);

  const omxEntry = resolveOmxCliEntryPath();
  if (!omxEntry || omxEntry.trim() === '') return null;

  const leaderPanePid = (() => {
    const proof = readExactPaneProofSync(normalizedLeaderPaneId);
    if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
    if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${normalizedLeaderPaneId}`);
    if (options.expectedLeaderPanePid !== undefined && proof.pid !== options.expectedLeaderPanePid) {
      throw new Error(`tmux pane identity changed: ${normalizedLeaderPaneId}`);
    }
    return proof.pid;
  })();
  const requireAuthorizedLeaderPane = (): string => {
    options.assertLeaderPaneAuthorization?.();
    return requireLiveExactPaneSync(normalizedLeaderPaneId, options.expectedLeaderPanePid ?? leaderPanePid);
  };
  requireAuthorizedLeaderPane();

  const paneListResult = listPanesResult(normalizedLeaderPaneId);
  if (paneListResult.error) throw new Error(`failed to read tmux pane topology: ${paneListResult.error}`);
  const [existingHudPaneId, ...duplicateHudPaneIds] = findHudWatchPaneIds(
    paneListResult.panes,
    normalizedLeaderPaneId,
    { leaderPaneId: normalizedLeaderPaneId },
  );
  const ownedHudPanePids = new Map<string, number>();
  for (const paneId of [existingHudPaneId, ...duplicateHudPaneIds]) {
    if (!paneId) continue;
    const proof = readExactPaneProofSync(paneId);
    if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
    if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${paneId}`);
    ownedHudPanePids.set(paneId, proof.pid);
  }
  for (const paneId of duplicateHudPaneIds) {
    killExactPaneSync(paneId, ownedHudPanePids.get(paneId), requireAuthorizedLeaderPane);
  }
  if (existingHudPaneId) {
    if (isNativeWindows()) {
      const exactHudPaneId = requireLiveExactPaneSync(
        existingHudPaneId,
        ownedHudPanePids.get(existingHudPaneId),
      );
      requireAuthorizedLeaderPane();
      const reconcile = runTmux(buildHudResizeArgs(exactHudPaneId));
      if (!reconcile.ok) throw new Error(`failed to reconcile standalone HUD resize: ${reconcile.stderr}`);
    } else {
      requireAuthorizedLeaderPane();
      runTmux(buildScheduleDelayedHudResizeArgs(
        existingHudPaneId,
        HUD_RESIZE_RECONCILE_DELAY_SECONDS,
        HUD_TMUX_TEAM_HEIGHT_LINES,
        ownedHudPanePids.get(existingHudPaneId),
      ));
      requireAuthorizedLeaderPane();
      runTmux(buildReconcileHudResizeArgs(
        existingHudPaneId,
        HUD_TMUX_TEAM_HEIGHT_LINES,
        ownedHudPanePids.get(existingHudPaneId),
      ));
    }
    runTmux(['select-pane', '-t', requireAuthorizedLeaderPane()]);
    return existingHudPaneId;
  }

  const hudCmd = `exec env ${formatHudEnvAssignments(process.env, { sessionId: options.sessionId, leaderPaneId: normalizedLeaderPaneId })} ${shellQuoteSingle(translatePathForMsys(resolveLeaderNodePath()))} ${shellQuoteSingle(translatePathForMsys(omxEntry))} hud --watch`;
  let hudResult: ReturnType<typeof runTmux> | null = null;
  for (const restoreCwd of resolveStandaloneHudRestoreCwdCandidates(
    normalizedLeaderPaneId,
    cwd,
    options.cwd,
    requireAuthorizedLeaderPane,
  )) {
    const candidateResult = runTmux([
      'split-window',
      '-v',
      '-l',
      String(HUD_TMUX_TEAM_HEIGHT_LINES),
      '-t',
      requireAuthorizedLeaderPane(),
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      translatePathForMsys(restoreCwd.rawPath),
      hudCmd,
    ]);
    if (candidateResult.ok) {
      hudResult = candidateResult;
      break;
    }
  }
  if (!hudResult?.ok) return null;

  const paneId = hudResult.stdout.split('\n')[0]?.trim() ?? '';
  if (!paneId.startsWith('%')) return null;
  persistRestoredHudCleanupDebtSync(cwd, {
    schema_version: 1,
    operation: 'restored_hud_cleanup',
    pane_id: paneId,
    pane_pid: null,
    leader_pane_id: normalizedLeaderPaneId,
    leader_pane_pid: options.expectedLeaderPanePid ?? leaderPanePid,
    leader_pane_owner_id: options.expectedLeaderPaneOwnerId?.trim() || null,
    hud_owner_leader_pane_id: normalizedLeaderPaneId,
  }, options.stateRoot);

  const hudPanePid = (() => {
    const proof = readExactPaneProofSync(paneId);
    if (proof.status === 'unavailable') throw new ExactPaneProofUnavailableError(proof);
    if (proof.status === 'gone') throw new Error(`tmux pane is not proven live: ${paneId}`);
    return proof.pid;
  })();
  persistRestoredHudCleanupDebtSync(cwd, {
    schema_version: 1,
    operation: 'restored_hud_cleanup',
    pane_id: paneId,
    pane_pid: hudPanePid,
    leader_pane_id: normalizedLeaderPaneId,
    leader_pane_pid: options.expectedLeaderPanePid ?? leaderPanePid,
    leader_pane_owner_id: options.expectedLeaderPaneOwnerId?.trim() || null,
    hud_owner_leader_pane_id: normalizedLeaderPaneId,
  }, options.stateRoot);
  if (isNativeWindows()) {
    const exactHudPaneId = requireLiveExactPaneSync(paneId, hudPanePid);
    requireAuthorizedLeaderPane();
    const reconcile = runTmux(buildHudResizeArgs(exactHudPaneId));
    if (!reconcile.ok) throw new Error(`failed to reconcile standalone HUD resize: ${reconcile.stderr}`);
  } else {
    requireAuthorizedLeaderPane();
    runTmux(buildScheduleDelayedHudResizeArgs(
      paneId,
      HUD_RESIZE_RECONCILE_DELAY_SECONDS,
      HUD_TMUX_TEAM_HEIGHT_LINES,
      hudPanePid,
    ));
    requireAuthorizedLeaderPane();
    runTmux(buildReconcileHudResizeArgs(paneId, HUD_TMUX_TEAM_HEIGHT_LINES, hudPanePid));
  }
  runTmux(['select-pane', '-t', requireAuthorizedLeaderPane()]);
  return paneId;
}

/**
 * Enable tmux mouse mode for a session so users can scroll pane content
 * (e.g. long agent output) with the mouse wheel instead of arrow keys.
 *
 * This helper is intentionally limited to session-scoped options so OMX
 * does not overwrite server-global tmux bindings/options owned by users,
 * oh-my-tmux, or other sessions. Returns true if the session mouse option
 * was set successfully, false otherwise.
 */
export function enableMouseScrolling(sessionTarget: string, beforeEffect?: () => void): boolean {
  beforeEffect?.();
  const result = runTmux(['set-option', '-t', sessionTarget, 'mouse', 'on']);
  if (!result.ok) return false;

  // Enable OSC 52 so copy-selection-and-cancel propagates selected text to
  // the terminal's clipboard without requiring xclip or pbcopy. (closes #206)
  beforeEffect?.();
  runTmux(['set-option', '-t', sessionTarget, 'set-clipboard', 'on']);

  // Mouse selection enters tmux copy-mode. Keep the mitigation session-scoped
  // so OMX does not mutate users' global tmux style defaults. (issue #1448)
  mitigateCopyModeUnderlineArtifacts(sessionTarget, beforeEffect);

  return true;
}

function paneTarget(sessionName: string, workerIndex: number): string {
  if (sessionName.includes(':')) {
    return `${sessionName}.${workerIndex}`;
  }
  return `${sessionName}:${workerIndex}`;
}

export const paneIsBootstrapping = sharedPaneIsBootstrapping;
export const paneLooksReady = sharedPaneLooksReady;

function paneHasTrustPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasActiveChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  return hasQuestion && hasActiveChoices;
}

function paneHasClaudeBypassPermissionsPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-20);
  const hasWarning = tail.some((line) => /Bypass Permissions mode/i.test(line));
  const hasChoices = tail.some((line) => /No,\s*exit/i.test(line))
    && tail.some((line) => /Yes,\s*I\s*accept/i.test(line))
    && tail.some((line) => /Enter\s*to\s*confirm/i.test(line));
  return hasWarning && hasChoices;
}


export type StartupDirectTriggerSafety =
  | { safe: true; reason: 'ready_prompt' | 'codex_viewport' }
  | { safe: false; reason: 'tmux_unavailable' | 'capture_failed' | 'trust_prompt' | 'claude_bypass_prompt' | 'bootstrapping' | 'not_agent_viewport' };

export function evaluateStartupDirectTriggerSafetyCapture(captured: string, workerCli?: TeamWorkerCli): StartupDirectTriggerSafety {
  if (paneHasTrustPrompt(captured)) return { safe: false, reason: 'trust_prompt' };
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return { safe: false, reason: 'claude_bypass_prompt' };
  if (paneLooksReady(captured)) return { safe: true, reason: 'ready_prompt' };
  if (paneIsBootstrapping(captured)) return { safe: false, reason: 'bootstrapping' };
  if (workerCli === 'codex' && sharedPaneShowsCodexViewport(captured)) return { safe: true, reason: 'codex_viewport' };
  return { safe: false, reason: 'not_agent_viewport' };
}

export async function evaluateStartupDirectTriggerSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
): Promise<StartupDirectTriggerSafety> {
  if (!isTmuxAvailable()) return { safe: false, reason: 'tmux_unavailable' };
  const target = await resolveWorkerPaneTargetAsync(sessionName, workerIndex, workerPaneId);

  if (!target) return { safe: false, reason: 'capture_failed' };
  const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
  if (!result.ok) return { safe: false, reason: 'capture_failed' };
  return evaluateStartupDirectTriggerSafetyCapture(result.stdout, workerCli);
}

function acceptClaudeBypassPermissionsPrompt(resolveTarget: () => string | null): boolean {
  const literalTarget = resolveTarget();
  if (!literalTarget) return false;
  runTmux(['send-keys', '-t', literalTarget, '-l', '--', '2']);
  sleepFractionalSeconds(0.12);
  const submitTarget = resolveTarget();
  if (!submitTarget) return false;
  runTmux(['send-keys', '-t', submitTarget, 'C-m']);
  return true;
}

function dismissClaudeBypassPermissionsPromptIfPresent(
  resolveTarget: () => string | null,
  captured: string,
): boolean {
  if (process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS === '0') return false;
  if (!paneHasClaudeBypassPermissionsPrompt(captured)) return false;
  return acceptClaudeBypassPermissionsPrompt(resolveTarget);
}
async function dismissClaudeBypassPermissionsPromptIfPresentAsync(
  resolveTarget: AsyncPaneTargetResolver,
  captured: string,
): Promise<boolean> {
  if (process.env.OMX_TEAM_AUTO_ACCEPT_BYPASS === '0') return false;
  if (!paneHasClaudeBypassPermissionsPrompt(captured)) return false;

  const literalTarget = await resolveTarget();
  if (!literalTarget) return false;
  const literalSend = await runTmuxAsync(['send-keys', '-t', literalTarget, '-l', '--', '2']);
  if (!literalSend.ok) return false;
  await sleep(120);

  const submitTarget = await resolveTarget();
  if (!submitTarget) return false;
  const submitSend = await runTmuxAsync(['send-keys', '-t', submitTarget, 'C-m']);
  return submitSend.ok;
}

export const paneHasActiveTask = sharedPaneHasActiveTask;

export type WorkerStartupInjectSafety =
  | 'safe'
  | 'trust_prompt'
  | 'claude_bypass_prompt'
  | 'bootstrapping'
  | 'active_task'
  | 'not_ready';

export function classifyWorkerStartupInjectSafety(captured: string): WorkerStartupInjectSafety {
  if (paneHasTrustPrompt(captured)) return 'trust_prompt';
  if (paneHasClaudeBypassPermissionsPrompt(captured)) return 'claude_bypass_prompt';
  if (paneIsBootstrapping(captured)) return 'bootstrapping';
  if (paneHasActiveTask(captured)) return 'active_task';
  if (!paneLooksReady(captured)) return 'not_ready';
  return 'safe';
}

export async function checkWorkerStartupInjectSafety(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
): Promise<{ safe: true; reason: 'safe' } | { safe: false; reason: Exclude<WorkerStartupInjectSafety, 'safe'> }> {
  const resolveTarget = (): Promise<string | null> => resolveWorkerPaneTargetAsync(sessionName, workerIndex, workerPaneId);

  const visibleCapture = await captureVisiblePaneAsync(resolveTarget);
  const visibleSafety = classifyWorkerStartupInjectSafety(visibleCapture);
  if (visibleSafety === 'safe') return { safe: true, reason: 'safe' };
  if (visibleSafety !== 'not_ready') return { safe: false, reason: visibleSafety };

  if (!sharedPaneShowsCodexViewport(visibleCapture)) {
    return { safe: false, reason: visibleSafety };
  }

  const scrollbackCapture = await capturePaneAsync(resolveTarget);
  const scrollbackSafety = classifyWorkerStartupInjectSafety(scrollbackCapture);
  return scrollbackSafety === 'safe'
    ? { safe: true, reason: 'safe' }
    : { safe: false, reason: scrollbackSafety };
}

function resolveSendStrategyFromEnv(): 'auto' | 'queue' | 'interrupt' {
  const raw = String(process.env.OMX_TEAM_SEND_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (raw === 'interrupt' || raw === 'queue' || raw === 'auto') {
    return raw;
  }
  return 'auto';
}

function resolveWorkerCliFromMapForSend(
  workerIndex: number,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli | null {
  const rawMap = String(env[OMX_TEAM_WORKER_CLI_MAP_ENV] ?? '').trim();
  if (rawMap === '') return null;
  const entries = rawMap.split(',').map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) return null;
  const selectedRaw = entries.length === 1 ? entries[0] : entries[workerIndex - 1];
  if (!selectedRaw) return null;
  try {
    const mode = normalizeTeamWorkerCliMode(selectedRaw, OMX_TEAM_WORKER_CLI_MAP_ENV);
    return mode === 'auto' ? resolveTeamWorkerCliFromLaunchArgs(launchArgs) : mode;
  } catch {
    return null;
  }
}

/**
 * Worker CLI resolution contract for submit routing:
 * 1) explicit workerCli param from caller
 * 2) per-worker OMX_TEAM_WORKER_CLI_MAP entry (worker index aware)
 * 3) global/default OMX_TEAM_WORKER_CLI behavior
 */
export function resolveWorkerCliForSend(
  workerIndex: number,
  workerCli?: TeamWorkerCli,
  launchArgs: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): TeamWorkerCli {
  if (workerCli) return workerCli;
  const mapped = resolveWorkerCliFromMapForSend(workerIndex, launchArgs, env);
  if (mapped) return mapped;
  return resolveTeamWorkerCli(launchArgs, env);
}

export function buildWorkerSubmitPlan(
  strategy: 'auto' | 'queue' | 'interrupt',
  workerCli: TeamWorkerCli,
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
): WorkerSubmitPlan {
  const queueRequested = strategy === 'queue' || (strategy === 'auto' && paneBusyAtStart);
  return {
    shouldInterrupt: strategy === 'interrupt',
    queueFirstRound: workerCli === 'codex' && queueRequested,
    rounds: 6,
    submitKeyPressesPerRound: workerCli === 'claude' ? 1 : 2,
    allowAdaptiveRetry: workerCli === 'codex' && allowAdaptiveRetry,
  };
}

export function shouldAttemptAdaptiveRetry(
  strategy: 'auto' | 'queue' | 'interrupt',
  paneBusyAtStart: boolean,
  allowAdaptiveRetry: boolean,
  latestCapture: string | null,
  text: string,
): boolean {
  if (!allowAdaptiveRetry) return false;
  if (strategy !== 'auto') return false;
  if (!paneBusyAtStart) return false;
  if (typeof latestCapture !== 'string') return false;

  const normalizedText = normalizeWorkerTriggerForDraftMatch(text);
  if (normalizedText === '') return false;

  const normalizedCapture = normalizeWorkerTriggerForDraftMatch(latestCapture);
  if (!normalizedCapture.includes(normalizedText)) return false;
  if (paneHasActiveTask(latestCapture)) return false;
  if (!paneLooksReady(latestCapture)) return false;
  return true;
}

async function sendLiteralTextOrThrow(resolveTarget: AsyncPaneTargetResolver, text: string): Promise<void> {
  const target = await requireAsyncPaneTarget(resolveTarget);
  const send = await runTmuxAsync(['send-keys', '-t', target, '-l', '--', text]);
  if (!send.ok) {
    throw new Error(`sendToWorker: failed to send text: ${send.stderr}`);
  }
}

function paneHasQueuedCodexSubmission(captured: string | null | undefined): boolean {
  const normalized = normalizeTmuxCapture(captured ?? '');
  if (normalized === '') return false;
  return /messages to be submitted after next tool call/i.test(normalized)
    || /press esc to interrupt and send immediately/i.test(normalized);
}

async function attemptSubmitRounds(
  resolveTarget: AsyncPaneTargetResolver,
  text: string,
  rounds: number,
  queueFirstRound: boolean,
  submitKeyPressesPerRound: number,
): Promise<boolean> {
  const presses = Math.max(1, Math.floor(submitKeyPressesPerRound));
  for (let round = 0; round < rounds; round++) {
    await sleep(100);
    if (round === 0 && queueFirstRound) {
      await sendKeyAsync(resolveTarget, 'Tab');
      await sleep(80);
      await sendKeyAsync(resolveTarget, 'C-m');
    } else {
      for (let press = 0; press < presses; press++) {
        await sendKeyAsync(resolveTarget, 'C-m');
        if (press < presses - 1) {
          await sleep(200);
        }
      }
    }
    await sleep(140);
    const [captured, visibleCapture] = await Promise.all([
      capturePaneAsync(resolveTarget),
      captureVisiblePaneAsync(resolveTarget),
    ]);
    const normalizedCapture = normalizeWorkerTriggerForDraftMatch(captured);
    if (
      !normalizedCapture.includes(normalizeWorkerTriggerForDraftMatch(text))
      && !paneHasQueuedCodexSubmission(visibleCapture)
    ) {
      return true;
    }
    await sleep(140);
  }
  return false;
}

export function waitForWorkerReady(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): boolean {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;
  const resolveTarget = createPinnedWorkerPaneTargetResolverSync(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId);

  const sendRobustEnter = (): void => {
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) for raw-mode compatibility.
    const firstTarget = resolveTarget();
    if (!firstTarget) return;
    runTmux(['send-keys', '-t', firstTarget, 'C-m']);
    sleepFractionalSeconds(0.12);
    const secondTarget = resolveTarget();
    if (!secondTarget) return;
    runTmux(['send-keys', '-t', secondTarget, 'C-m']);
  };

  const check = (): boolean => {
    const target = resolveTarget();
    if (!target) return false;
    const result = runTmux(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (dismissClaudeBypassPermissionsPromptIfPresent(resolveTarget, result.stdout)) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        sendRobustEnter();
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackTarget = resolveTarget();
    if (!scrollbackTarget) return false;
    const scrollbackResult = runTmux(sharedBuildCapturePaneArgv(scrollbackTarget, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepSeconds(Math.max(0, Math.min(delayMs, remaining)) / 1000);
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

// Async twin of waitForWorkerReady for team startup fan-out. Keep the readiness
// semantics mirrored with the synchronous helper above, but yield between polls
// so one slow worker pane cannot block later workers' startup attempts.
export async function waitForWorkerReadyAsync(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 30_000,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): Promise<boolean> {
  const initialBackoffMs = 150;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;
  let promptDismissed = false;
  const resolveTarget = createPinnedWorkerPaneTargetResolver(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId);


  const sendRobustEnter = async (): Promise<void> => {
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) for raw-mode compatibility.
    const firstTarget = await resolveTarget();
    if (!firstTarget) return;
    await runTmuxAsync(['send-keys', '-t', firstTarget, 'C-m']);
    await sleep(120);
    const secondTarget = await resolveTarget();
    if (!secondTarget) return;
    await runTmuxAsync(['send-keys', '-t', secondTarget, 'C-m']);
  };

  const check = async (): Promise<boolean> => {
    const target = await resolveTarget();
    if (!target) return false;
    const result = await runTmuxAsync(sharedBuildVisibleCapturePaneArgv(target));
    if (!result.ok) return false;
    if (await dismissClaudeBypassPermissionsPromptIfPresentAsync(resolveTarget, result.stdout)) {
      promptDismissed = true;
      return false;
    }
    if (paneHasClaudeBypassPermissionsPrompt(result.stdout)) {
      return false;
    }
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        await sendRobustEnter();
        promptDismissed = true;
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    if (paneLooksReady(result.stdout)) return true;
    // Keep startup safety checks anchored to the visible pane. Only if the
    // visible slice already proves a live Codex viewport do we consult recent
    // scrollback for the prompt/helper text that may have slipped below the fold.
    if (!sharedPaneShowsCodexViewport(result.stdout)) return false;

    const scrollbackTarget = await resolveTarget();
    if (!scrollbackTarget) return false;
    const scrollbackResult = await runTmuxAsync(sharedBuildCapturePaneArgv(scrollbackTarget, 80));
    if (!scrollbackResult.ok) return false;
    return paneLooksReady(scrollbackResult.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true;
    if (blockedByTrustPrompt) return false;
    // After dismissing a trust prompt, reset backoff so we re-check quickly
    // instead of sleeping 2s/4s/8s while the worker is starting up.
    if (promptDismissed) {
      delayMs = initialBackoffMs;
      promptDismissed = false;
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.max(0, Math.min(delayMs, remaining)));
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

/**
 * Detect and auto-dismiss a Codex "Trust this directory?" prompt in a worker pane.
 * Returns true if a trust prompt was found and dismissed, false otherwise.
 * Opt-out: set OMX_TEAM_AUTO_TRUST=0 to disable auto-dismissal.
 */
export function dismissTrustPromptIfPresent(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): boolean {
  if (process.env.OMX_TEAM_AUTO_TRUST === '0') return false;
  if (!isTmuxAvailable()) return false;
  const resolveTarget = createPinnedWorkerPaneTargetResolverSync(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId);
  const captureTarget = resolveTarget();
  if (!captureTarget) return false;
  const result = runTmux(sharedBuildVisibleCapturePaneArgv(captureTarget));
  if (!result.ok) return false;
  if (!paneHasTrustPrompt(result.stdout)) return false;
  // Trust prompt detected; send C-m twice to dismiss (trust + follow-up splash)
  const firstTarget = resolveTarget();
  if (!firstTarget) return false;
  runTmux(['send-keys', '-t', firstTarget, 'C-m']);
  sleepFractionalSeconds(0.12);
  const secondTarget = resolveTarget();
  if (!secondTarget) return false;
  runTmux(['send-keys', '-t', secondTarget, 'C-m']);
  return true;
}

export const normalizeTmuxCapture = sharedNormalizeTmuxCapture;

function normalizeWorkerTriggerForDraftMatch(value: string | null | undefined): string {
  // Codex/tmux can wrap long path-like trigger text after a hyphen, e.g.
  // `worker-\n  1/inbox.md`. Treat those visual wraps as the original token so
  // delivery verification does not mistake an unsent draft for consumed input.
  return normalizeTmuxCapture(value ?? '').replace(/-\s+/g, '-');
}

function assertWorkerTriggerText(text: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.trim().length === 0) {
    throw new Error('sendToWorker: text must be non-empty');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }
}

export function sendToWorkerStdin(
  stdin: Pick<NodeJS.WritableStream, 'write' | 'writable'> | null | undefined,
  text: string,
): void {
  assertWorkerTriggerText(text);
  if (!stdin || !stdin.writable) {
    throw new Error('sendToWorkerStdin: stdin is not writable');
  }
  stdin.write(`${text}\n`);
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export async function sendToWorker(
  sessionName: string,
  workerIndex: number,
  text: string,
  workerPaneId?: string,
  workerCli?: TeamWorkerCli,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): Promise<void> {
  assertWorkerTriggerText(text);

  const resolveTarget = createPinnedWorkerPaneTargetResolver(
    sessionName,
    workerIndex,
    workerPaneId,
    expectedPanePid,
    expectedTeamOwnerId,
    hudPaneId,
  );


  const strategy = resolveSendStrategyFromEnv();
  const resolvedWorkerCli = resolveWorkerCliForSend(workerIndex, workerCli);

  // Guard: if the trust prompt is still present, advance it first so our trigger text
  // doesn't get typed into the trust screen and ignored.
  const capturedStr = await capturePaneAsync(resolveTarget);
  const paneBusy = paneHasActiveTask(capturedStr);
  if (await dismissClaudeBypassPermissionsPromptIfPresentAsync(resolveTarget, capturedStr)) {
    await sleep(200);
  }
  if (paneHasTrustPrompt(capturedStr)) {
    await sendKeyAsync(resolveTarget, 'C-m');
    await sleep(120);
    await sendKeyAsync(resolveTarget, 'C-m');
    await sleep(200);
  }

  await sendLiteralTextOrThrow(resolveTarget, text);

  // Allow the input buffer to settle before sending C-m
  await sleep(150);

  const allowAutoInterruptRetry = process.env[OMX_TEAM_AUTO_INTERRUPT_RETRY_ENV] !== '0';
  const submitPlan = buildWorkerSubmitPlan(strategy, resolvedWorkerCli, paneBusy, allowAutoInterruptRetry);
  if (submitPlan.shouldInterrupt) {
    // Explicit interrupt mode: abort current turn first, then submit the new command.
    await sendKeyAsync(resolveTarget, 'C-c');
    await sleep(100);
  }

  // Submit deterministically using CLI-specific plan:
  // - Codex: queue-first Tab+C-m when configured/busy, then double C-m rounds.
  // - Claude: direct C-m rounds only (never queue-first Tab).
  if (await attemptSubmitRounds(
    resolveTarget,
    text,
    submitPlan.rounds,
    submitPlan.queueFirstRound,
    submitPlan.submitKeyPressesPerRound,
  )) return;

  // Adaptive escalation for "likely unsent trigger text at ready prompt" cases:
  // clear line, re-send trigger, then re-submit with deterministic C-m rounds.
  const latestCapture = await capturePaneAsync(resolveTarget);
  if (shouldAttemptAdaptiveRetry(strategy, paneBusy, submitPlan.allowAdaptiveRetry, latestCapture || null, text)) {
    // Keep this branch non-interrupting to avoid canceling active turns on false positives.
    await sendKeyAsync(resolveTarget, 'C-u');
    await sleep(80);
    await sendLiteralTextOrThrow(resolveTarget, text);
    await sleep(120);
    if (await attemptSubmitRounds(resolveTarget, text, 4, false, submitPlan.submitKeyPressesPerRound)) return;
  }

  // Fail-open by default: Codex may keep the last submitted line visible even after executing it.
  // If you need strictness for debugging, set OMX_TEAM_STRICT_SUBMIT=1.
  const strict = process.env.OMX_TEAM_STRICT_SUBMIT === '1';
  if (strict) {
    throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
  }

  // One last best-effort double C-m nudge, then verify.
  await sendKeyAsync(resolveTarget, 'C-m');
  await sleep(120);
  await sendKeyAsync(resolveTarget, 'C-m');

  // Post-submit verification: wait briefly and confirm the worker consumed the
  // trigger (draft disappeared or active-task indicator appeared). Fixes #391.
  await sleep(300);
  const [verifyCapture, verifyVisibleCapture] = await Promise.all([
    capturePaneAsync(resolveTarget),
    captureVisiblePaneAsync(resolveTarget),
  ]);
  if (verifyCapture) {
    if (paneHasActiveTask(verifyCapture)) return;
    if (
      !normalizeWorkerTriggerForDraftMatch(verifyCapture).includes(normalizeWorkerTriggerForDraftMatch(text))
      && !paneHasQueuedCodexSubmission(verifyVisibleCapture)
    ) {
      return;
    }
    // Draft still visible and no active task — one more C-m attempt.
    await sendKeyAsync(resolveTarget, 'C-m');
    await sleep(150);
    await sendKeyAsync(resolveTarget, 'C-m');
    const finalVisibleCapture = await captureVisiblePaneAsync(resolveTarget);
    if (paneHasQueuedCodexSubmission(finalVisibleCapture)) {
      throw new Error('sendToWorker: submit_queued_after_tool_call');
    }
    const finalCapture = await capturePaneAsync(resolveTarget);
    if (
      normalizeWorkerTriggerForDraftMatch(finalCapture).includes(normalizeWorkerTriggerForDraftMatch(text))
      && !paneHasActiveTask(finalCapture)
      && paneLooksReady(finalCapture)
    ) {
      throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
    }
  }
}

export function notifyLeaderStatus(sessionName: string, message: string): boolean {
  if (!isTmuxAvailable()) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  const capped = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  const result = runTmux(['display-message', '-t', sessionName, '--', capped]);
  return result.ok;
}

// Get PID of the shell process in a worker's tmux pane
export function getWorkerPanePid(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): number | null {
  if (hasExplicitWorkerPaneId(workerPaneId)) {
    const target = createPinnedWorkerPaneTargetResolverSync(
      sessionName,
      workerIndex,
      workerPaneId,
      expectedPanePid,
      expectedTeamOwnerId,
      hudPaneId,
    )();
    return target ? expectedPanePid ?? null : null;
  }

  const result = runTmux(['list-panes', '-t', paneTarget(sessionName, workerIndex), '-F', '#{pane_pid}']);
  if (!result.ok) return null;

  const firstLine = result.stdout.split('\n')[0]?.trim();
  if (!firstLine) return null;

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid)) return null;
  return pid;
}


// Check if worker's tmux pane has a running process
export function isWorkerAlive(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): boolean {
  if (hasExplicitWorkerPaneId(workerPaneId)) {
    const target = createPinnedWorkerPaneTargetResolverSync(
      sessionName,
      workerIndex,
      workerPaneId,
      expectedPanePid,
      expectedTeamOwnerId,
      hudPaneId,
    )();
    if (!target || typeof expectedPanePid !== 'number') return false;
    return probeProcessLiveness(expectedPanePid) !== 'gone';
  }

  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;

  const parts = line.split(/\s+/);
  if (parts.length < 2) return false;

  const paneDead = parts[0];
  const pid = Number.parseInt(parts[1], 10);

  if (paneDead === '1') return false;
  if (!Number.isFinite(pid)) return false;
  // Unknown is conservatively live so callers cannot classify a permission or
  // transient failure as stale cleanup authority.
  return probeProcessLiveness(pid) !== 'gone';
}


export function isWorkerPaneOpen(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): boolean {
  if (hasExplicitWorkerPaneId(workerPaneId)) {
    return createPinnedWorkerPaneTargetResolverSync(
      sessionName,
      workerIndex,
      workerPaneId,
      expectedPanePid,
      expectedTeamOwnerId,
      hudPaneId,
    )() !== null;
  }

  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex),
    '-F',
    '#{pane_dead}',
  ]);
  if (!result.ok) return false;
  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;
  return line !== '1';
}

// Kill a specific worker: send C-c, then C-d, then kill-pane if still alive.
// leaderPaneId: when provided, the kill is skipped entirely if workerPaneId matches it.
export async function killWorker(
  sessionName: string,
  workerIndex: number,
  workerPaneId?: string,
  leaderPaneId?: string,
  expectedPanePid?: number,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): Promise<void> {
  // Guard: never kill the leader's own pane.
  if (leaderPaneId && workerPaneId === leaderPaneId) return;

  const resolveTarget = createPinnedWorkerPaneTargetResolver(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId);
  const initialTarget = await resolveTarget();
  if (!initialTarget) return;
  if (await isWorkerAliveAsync(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId, resolveTarget) !== 'alive') return;
  await runTmuxAsync(['send-keys', '-t', initialTarget, 'C-c']);
  await sleep(1000);

  if (await isWorkerAliveAsync(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId, resolveTarget) === 'alive') {
    const exitTarget = await resolveTarget();
    if (exitTarget) {
      await runTmuxAsync(['send-keys', '-t', exitTarget, 'C-d']);
      await sleep(1000);
    }
  }

  if (await isWorkerAliveAsync(sessionName, workerIndex, workerPaneId, expectedPanePid, expectedTeamOwnerId, hudPaneId, resolveTarget) === 'alive') {
    const killTarget = await resolveTarget();
    if (!killTarget) return;
    const killed = await runTmuxAsync(['kill-pane', '-t', killTarget]);
    if (!killed.ok) throw new Error(`failed to kill tmux pane ${killTarget}: ${killed.stderr}`);
    const absence = await readExactPaneProof(killTarget);
    if (absence.status === 'unavailable') throw new ExactPaneProofUnavailableError(absence);
    if (absence.status !== 'gone') throw new Error(`tmux pane remains live after kill: ${killTarget}`);
  }
}


// Explicit pane targets require frozen PID, canonical Team owner, and HUD
// exclusion. A successful kill is only accepted after a fresh absence proof.
export function killWorkerByPaneId(
  workerPaneId: string,
  expectedPanePid?: number,
  leaderPaneId?: string,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): void {
  const expectedOwner = typeof expectedTeamOwnerId === 'string' ? expectedTeamOwnerId.trim() : '';
  if (!hasExplicitWorkerPaneId(workerPaneId)
    || typeof expectedPanePid !== 'number'
    || !Number.isSafeInteger(expectedPanePid)
    || expectedPanePid <= 0
    || !expectedOwner
    || workerPaneId === hudPaneId) return;
  if (leaderPaneId && workerPaneId === leaderPaneId) return;
  const proof = readExactPaneProofSync(workerPaneId);
  if (proof.status !== 'live' || proof.pid !== expectedPanePid) return;
  const owner = readPaneTeamOwnerTagResult(proof.paneId);
  if (owner.status !== 'value' || owner.value !== expectedOwner) return;
  const finalProof = readExactPaneProofSync(proof.paneId);
  if (finalProof.status !== 'live' || finalProof.pid !== expectedPanePid) return;
  const result = runTmux(['kill-pane', '-t', finalProof.paneId]);
  if (!result.ok) throw new Error(`failed to kill tmux pane ${finalProof.paneId}: ${result.stderr}`);
  const absence = readExactPaneProofSync(finalProof.paneId);
  if (absence.status === 'unavailable') throw new ExactPaneProofUnavailableError(absence);
  if (absence.status !== 'gone') throw new Error(`tmux pane remains live after kill: ${finalProof.paneId}`);
}

export function paneHasOmxInstanceTag(paneId: string | null | undefined, instanceId: string | null | undefined): boolean {
  const normalizedPaneId = normalizePaneTarget(paneId);
  const expectedInstanceId = typeof instanceId === 'string' ? instanceId.trim() : '';
  if (!normalizedPaneId || !expectedInstanceId) return false;
  const result = runTmux(['show-option', '-qv', '-p', '-t', normalizedPaneId, OMX_PANE_INSTANCE_OPTION]);
  if (!result.ok) return false;
  return result.stdout.trim() === expectedInstanceId;
}

export function paneHasOmxTeamOwnerTag(paneId: string | null | undefined, teamOwnerId: string | null | undefined): boolean {
  const expectedTeamOwnerId = typeof teamOwnerId === 'string' ? teamOwnerId.trim() : '';
  if (!expectedTeamOwnerId) return false;
  const result = readPaneTeamOwnerTagResult(paneId);
  return result.status === 'value' && result.value === expectedTeamOwnerId;
}

export function readPaneTeamOwnerTag(paneId: string | null | undefined): string | null {
  const result = readPaneTeamOwnerTagResult(paneId);
  return result.status === 'value' ? result.value : null;
}

export type PaneTeamOwnerTagReadResult =
  | { status: 'value'; value: string }
  | { status: 'missing' }
  | { status: 'error'; error: string };

export function readPaneTeamOwnerTagResult(paneId: string | null | undefined): PaneTeamOwnerTagReadResult {
  const normalizedPaneId = normalizePaneTarget(paneId);
  if (!normalizedPaneId) return { status: 'error', error: 'invalid pane target' };
  const { result } = spawnPlatformCommandSync('tmux', [
    'show-option',
    '-qv',
    '-p',
    '-t',
    normalizedPaneId,
    OMX_TEAM_PANE_OWNER_OPTION,
  ], { encoding: 'utf-8' });
  if (result.error) {
    return { status: 'error', error: result.error.message };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.status === 0) {
    return stdout === '' ? { status: 'missing' } : { status: 'value', value: stdout };
  }
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
  // tmux reports an unset user option as status 1 with no diagnostic on
  // supported versions. Treat other failures, including signal/null exits,
  // as real read errors so shared-pane shutdown fails closed instead of
  // killing a pane whose owner could not be read.
  if (result.status === 1 && stderr === '') return { status: 'missing' };
  return { status: 'error', error: stderr || `tmux show-option exited ${result.status ?? 'unknown'}` };
}

export async function killWorkerByPaneIdAsync(
  workerPaneId: string,
  expectedPanePid?: number,
  leaderPaneId?: string,
  expectedTeamOwnerId?: string,
  hudPaneId?: string,
): Promise<void> {
  const expectedOwner = typeof expectedTeamOwnerId === 'string' ? expectedTeamOwnerId.trim() : '';
  if (!hasExplicitWorkerPaneId(workerPaneId)
    || typeof expectedPanePid !== 'number'
    || !Number.isSafeInteger(expectedPanePid)
    || expectedPanePid <= 0
    || !expectedOwner
    || workerPaneId === hudPaneId) return;
  if (leaderPaneId && workerPaneId === leaderPaneId) return;
  const proof = await readExactPaneProof(workerPaneId);
  if (proof.status !== 'live' || proof.pid !== expectedPanePid) return;
  const owner = readPaneTeamOwnerTagResult(proof.paneId);
  if (owner.status !== 'value' || owner.value !== expectedOwner) return;
  const finalProof = await readExactPaneProof(proof.paneId);
  if (finalProof.status !== 'live' || finalProof.pid !== expectedPanePid) return;
  const result = await runTmuxAsync(['kill-pane', '-t', finalProof.paneId]);
  if (!result.ok) throw new Error(`failed to kill tmux pane ${finalProof.paneId}: ${result.stderr}`);
  const absence = await readExactPaneProof(finalProof.paneId);
  if (absence.status === 'unavailable') throw new ExactPaneProofUnavailableError(absence);
  if (absence.status !== 'gone') throw new Error(`tmux pane remains live after kill: ${finalProof.paneId}`);
}

export interface PaneTeardownSummary {
  attemptedPaneIds: string[];
  excluded: {
    leader: number;
    hud: number;
    invalid: number;
  };
  provenGonePaneIds: string[];
  killedPaneIds: string[];
  proofUnavailable: Array<Extract<ExactPaneProof, { status: 'unavailable' }>>;
  kill: {
    attempted: number;
    succeeded: number;
    failed: number;
    failedPaneIds: string[];
  };
}

export interface PaneTeardownOptions {
  leaderPaneId?: string | null;
  hudPaneId?: string | null;
  graceMs?: number;
  expectedPanePids?: Readonly<Record<string, number>>;
  /** Revalidates caller-owned authority after the final exact PID proof and before kill-pane. */
  authorizePaneKill?: (paneId: string, proof: Extract<ExactPaneProof, { status: 'live' }>) => boolean;
}

export type SharedSessionShutdownTopology =
  | {
    status: 'available';
    livePaneIds: string[];
    teamWorkerPaneIds: string[];
    leaderPaneId: string | null;
    hudPaneIds: string[];
    leaderOwnedHudPaneIds: string[];
  }
  | {
    status: 'unavailable';
    detail: string;
  };


function normalizePaneTarget(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('%')) return null;
  return trimmed;
}

function normalizePaneTargets(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): { killablePaneIds: string[]; excluded: PaneTeardownSummary['excluded'] } {
  const leaderPaneId = normalizePaneTarget(options.leaderPaneId);
  const hudPaneId = normalizePaneTarget(options.hudPaneId);
  const excluded = { leader: 0, hud: 0, invalid: 0 };
  const deduped = new Set<string>();
  const killablePaneIds: string[] = [];

  for (const paneId of paneIds) {
    const normalized = normalizePaneTarget(paneId);
    if (!normalized) {
      excluded.invalid += 1;
      continue;
    }
    if (leaderPaneId && normalized === leaderPaneId) {
      excluded.leader += 1;
      continue;
    }
    if (hudPaneId && normalized === hudPaneId) {
      excluded.hud += 1;
      continue;
    }
    if (deduped.has(normalized)) continue;
    deduped.add(normalized);
    killablePaneIds.push(normalized);
  }

  return { killablePaneIds, excluded };
}

export function resolveSharedSessionShutdownTopology(
  sessionName: string,
  preferredLeaderPaneId?: string | null,
  teamName?: string | null,
): SharedSessionShutdownTopology {
  const paneList = listPanesResult(sessionName);
  if (paneList.error !== null) return { status: 'unavailable', detail: paneList.error };
  const panes = paneList.panes;

  const livePaneIds = panes
    .map((pane) => normalizePaneTarget(pane.paneId))
    .filter((paneId): paneId is string => Boolean(paneId));
  const fallbackLeaderPaneId = normalizePaneTarget(preferredLeaderPaneId);
  if (panes.length === 0) {
    return {
      livePaneIds,
      status: 'available',

      teamWorkerPaneIds: [],
      leaderPaneId: fallbackLeaderPaneId,
      hudPaneIds: [],
      leaderOwnedHudPaneIds: [],
    };
  }

  const normalizedTeamName = typeof teamName === 'string' ? teamName.trim() : '';
  const normalizedTeamWorkerPaneIds = normalizedTeamName
    ? panes
      .filter((pane) => !isHudWatchPane(pane))
      .filter((pane) => paneLooksLikeTeamWorkerPane(pane, normalizedTeamName))
      .map((pane) => pane.paneId)
      .filter((paneId) => paneId.startsWith('%'))
    : [];
  const workerPaneIdSet = new Set(normalizedTeamWorkerPaneIds);
  const resolvedLeaderPaneId = chooseSharedSessionShutdownLeaderPaneId(
    panes,
    fallbackLeaderPaneId,
    workerPaneIdSet,
  );
  const hudPaneIds = panes
    .filter((pane) => pane.paneId !== resolvedLeaderPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId)
    .filter((paneId) => paneId.startsWith('%'));
  const leaderOwnedHudPaneIds = resolvedLeaderPaneId
    ? panes
      .filter((pane) => pane.paneId !== resolvedLeaderPaneId)
      .filter((pane) => hudPaneMatchesOwner(pane, { leaderPaneId: resolvedLeaderPaneId }))
      .map((pane) => pane.paneId)
      .filter((paneId) => paneId.startsWith('%'))
    : [];

  return {
    livePaneIds,
    status: 'available',
    teamWorkerPaneIds: normalizedTeamWorkerPaneIds,
    leaderPaneId: resolvedLeaderPaneId,
    hudPaneIds,
    leaderOwnedHudPaneIds,
  };
}

function chooseSharedSessionShutdownLeaderPaneId(
  panes: TmuxPaneInfo[],
  preferredLeaderPaneId: string | null,
  teamWorkerPaneIds: ReadonlySet<string>,
): string | null {
  const preferred = panes.find((pane) => pane.paneId === preferredLeaderPaneId);
  if (preferred && !isHudWatchPane(preferred) && !teamWorkerPaneIds.has(preferred.paneId)) {
    return preferred.paneId;
  }
  return null;
}

function paneLooksLikeTeamWorkerPane(pane: TmuxPaneInfo, teamName: string): boolean {
  const command = `${pane.startCommand || ''} ${pane.currentCommand || ''}`.replace(/\\/g, '/');
  if (!command.trim() || !teamName) return false;
  if (command.includes(`/team/${teamName}/runtime/worker-`) && command.includes('-startup.sh')) {
    return true;
  }
  const commandVariants = [command, ...decodePowerShellEncodedCommands(command)];
  return commandVariants.some((candidate) => (
    commandHasTeamWorkerEnvMarker(candidate, 'OMX_TEAM_INTERNAL_WORKER', teamName)
    || commandHasTeamWorkerEnvMarker(candidate, 'OMX_TEAM_WORKER', teamName)
  ));
}

function commandHasTeamWorkerEnvMarker(command: string, envName: string, teamName: string): boolean {
  const normalized = command.replace(/\\/g, '/');
  const key = escapeRegExp(envName);
  const workerValue = `${escapeRegExp(teamName)}/worker-[A-Za-z0-9_-]+`;
  const shellAssignment = new RegExp(
    `(?:^|[\\s;])(?:export\\s+)?(?:["']${key}=${workerValue}|${key}=(?:["']?${workerValue}))`,
    'g',
  );
  const powerShellAssignment = new RegExp(`(?:^|;)\\s*\\$env:${key}\\s*=\\s*["']?${workerValue}`, 'gi');
  return hasWorkerCliAfterEnvAssignment(
    normalized,
    shellAssignment,
    hasSafeShellEnvAssignmentContext,
    shellTailInvokesWorkerCli,
  )
    || hasWorkerCliAfterEnvAssignment(
      normalized,
      powerShellAssignment,
      () => true,
      powerShellTailInvokesWorkerCli,
    );
}

function hasWorkerCliAfterEnvAssignment(
  command: string,
  assignmentPattern: RegExp,
  contextIsSafe: (command: string, matchIndex: number) => boolean = () => true,
  tailInvokesWorkerCli: (tail: string) => boolean = shellTailInvokesWorkerCli,
): boolean {
  assignmentPattern.lastIndex = 0;
  for (const match of command.matchAll(assignmentPattern)) {
    const matchIndex = match.index ?? 0;
    if (!contextIsSafe(command, matchIndex)) continue;
    const afterAssignment = command.slice(matchIndex + match[0].length);
    if (tailInvokesWorkerCli(afterAssignment)) {
      return true;
    }
  }
  return false;
}

const WORKER_CLI_TOKEN_PATTERN = String.raw`(?:"[^"]*(?:^|[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?"|'[^']*(?:^|[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?'|(?:\S*[\/\\])?(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?)`;

function shellTailInvokesWorkerCli(tail: string): boolean {
  const directTail = stripShellAssignmentTailPrefix(tail);
  const directCliPattern = new RegExp(`^(?:exec\\s+)?${WORKER_CLI_TOKEN_PATTERN}(?:[\\s;"'\`]|$)`, 'i');
  if (directCliPattern.test(directTail)) return true;

  const shellCommandPattern = /(?:^|\s)-(?:c|lc)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  for (const match of directTail.matchAll(shellCommandPattern)) {
    const commandText = match[1] ?? match[2] ?? match[3] ?? '';
    const execCliPattern = new RegExp(`(?:^|[\\s;&|])exec\\s+${WORKER_CLI_TOKEN_PATTERN}(?:[\\s;"'\`]|$)`, 'i');
    if (execCliPattern.test(commandText)) return true;
  }
  return false;
}

function stripShellAssignmentTailPrefix(tail: string): string {
  let value = tail.trimStart();
  while (value.startsWith("'") || value.startsWith('"')) {
    value = value.slice(1).trimStart();
  }
  const envAssignmentPattern = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+/;
  let changed = true;
  while (changed) {
    changed = false;
    const match = value.match(envAssignmentPattern);
    if (match) {
      value = value.slice(match[0].length).trimStart();
      changed = true;
    }
  }
  return value;
}

function powerShellTailInvokesWorkerCli(tail: string): boolean {
  return /(?:^|[\s;&|"'`\/\\])(?:codex|claude|gemini)(?:\.(?:js|mjs|cjs|cmd|exe|bat|ps1))?(?:[\s;"'`]|$)/i.test(tail);
}

function hasSafeShellEnvAssignmentContext(command: string, matchIndex: number): boolean {
  const prefix = command.slice(0, matchIndex).trimEnd();
  if (!prefix) return true;
  const segment = prefix.split(/&&|\|\||[;|]/).pop()?.trimEnd() ?? '';
  if (!segment) return true;
  return /(?:^|\s)(?:env|export)(?:\s+(?:'[^']*'|"[^"]*"|\S+))*$/.test(segment)
    || /(?:^|\s)worker[-_]wrapper(?:\s+(?:'[^']*'|"[^"]*"|\S+))*$/.test(segment);
}

function decodePowerShellEncodedCommands(command: string): string[] {
  const decoded: string[] = [];
  const encodedCommandPattern = /(?:^|\s)-(?:EncodedCommand|enc|e)(?:\s+|:)([A-Za-z0-9+/=]+)/gi;
  for (const match of command.matchAll(encodedCommandPattern)) {
    const encoded = match[1];
    if (!encoded) continue;
    try {
      const text = Buffer.from(encoded, 'base64').toString('utf16le').trim();
      if (text) decoded.push(text.replace(/\\/g, '/'));
    } catch {
      // Ignore malformed pane command fragments; they are not team ownership evidence.
    }
  }
  return decoded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shared pane-id-direct teardown primitive for worker pane cleanup.
 * A fresh exact global proof is required before each kill; proven-gone panes
 * are teardown-compatible while unavailable proofs remain fail-closed.
 */
export async function teardownWorkerPanes(
  paneIds: string[],
  options: PaneTeardownOptions = {},
): Promise<PaneTeardownSummary> {
  const { killablePaneIds, excluded } = normalizePaneTargets(paneIds, options);
  const graceMs = options.graceMs ?? 2000;
  const perPaneGrace = killablePaneIds.length > 0
    ? Math.max(100, Math.floor(graceMs / killablePaneIds.length))
    : 0;

  const summary: PaneTeardownSummary = {
    attemptedPaneIds: killablePaneIds,
    excluded,
    provenGonePaneIds: [],
    killedPaneIds: [],
    proofUnavailable: [],
    kill: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      failedPaneIds: [],
    },
  };

  for (const paneId of killablePaneIds) {
    const proof = await readExactPaneProof(paneId);
    const expectedPid = options.expectedPanePids?.[paneId];
    if (proof.status === 'gone') {
      summary.provenGonePaneIds.push(proof.paneId);
      continue;
    }
    if (proof.status === 'unavailable') {
      summary.proofUnavailable.push(proof);
      break;
    }
    if (typeof expectedPid !== 'number' || !Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
      summary.proofUnavailable.push({
        status: 'unavailable',
        paneId,
        reason: 'pane_pid_changed',
        detail: 'expected positive pane PID is required before teardown kill',
      });
      break;
    }
    if (proof.pid !== expectedPid) {
      summary.proofUnavailable.push({
        status: 'unavailable',
        paneId,
        reason: 'pane_pid_changed',
        detail: `expected ${expectedPid}, got ${proof.pid}`,
      });
      break;
    }

    if (options.authorizePaneKill && !options.authorizePaneKill(proof.paneId, proof)) {
      summary.proofUnavailable.push({
        status: 'unavailable',
        paneId: proof.paneId,
        reason: 'pane_pid_changed',
        detail: 'pane owner authorization changed',
      });
      break;
    }

    // Owner authorization can read tmux. Re-prove the persisted identity after
    // it and immediately before kill-pane.
    const finalProof = await readExactPaneProof(proof.paneId);
    if (finalProof.status === 'gone') {
      summary.provenGonePaneIds.push(finalProof.paneId);
      continue;
    }
    if (finalProof.status === 'unavailable') {
      summary.proofUnavailable.push(finalProof);
      break;
    }
    if (finalProof.pid !== expectedPid) {
      summary.proofUnavailable.push({
        status: 'unavailable',
        paneId: finalProof.paneId,
        reason: 'pane_pid_changed',
        detail: `expected ${expectedPid}, got ${finalProof.pid}`,
      });
      break;
    }

    summary.kill.attempted += 1;
    const result = await runTmuxAsync(['kill-pane', '-t', finalProof.paneId]);
    if (!result.ok) {
      summary.kill.failed += 1;
      summary.kill.failedPaneIds.push(proof.paneId);
      await sleep(perPaneGrace);
      break;
    }

    const afterKill = await readExactPaneProof(finalProof.paneId);
    if (afterKill.status === 'gone') {
      summary.kill.succeeded += 1;
      summary.killedPaneIds.push(proof.paneId);
    } else if (afterKill.status === 'unavailable') {
      summary.proofUnavailable.push(afterKill);
      break;
    } else {
      summary.kill.failed += 1;
      summary.kill.failedPaneIds.push(proof.paneId);
      await sleep(perPaneGrace);
      break;
    }
    await sleep(perPaneGrace);
  }

  return summary;
}

export async function killWorkerPanes(
  paneIds: string[],
  leaderPaneId: string,
  graceMs: number = 2000,
  hudPaneId?: string,
  expectedPanePids?: Readonly<Record<string, number>>,
): Promise<PaneTeardownSummary> {
  return teardownWorkerPanes(paneIds, {
    leaderPaneId,
    hudPaneId: hudPaneId ?? null,
    graceMs,
    expectedPanePids,
  });
}

// Kill an entire detached tmux session only when the caller has already
// established ownership. Success requires tmux to accept the kill and a fresh
// session-list proof that the exact base session is absent.
function parseTeamSessionNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(baseSessionName);
}

function isFinalTmuxServerGone(result: ReturnType<typeof runTmux>): boolean {
  return !result.ok && /^no server running on .+$/i.test(result.stderr);
}

export type DetachedSessionIncarnation = {
  sessionId: string;
  sessionCreated: string;
};

export type DetachedSessionLeaderBinding = {
  paneId: string;
  pid: number;
  sessionName: string;
  incarnation: DetachedSessionIncarnation;
};

export type DetachedSessionDestroyAuthorization = DetachedSessionIncarnation & {
  leaderPaneId: string;
  leaderPanePid: number;
  ownerId: string;
};


/**
 * Reads pane and session incarnation in one tmux snapshot. This prevents a
 * same-name replacement from combining a stale session proof with a live pane.
 */
export function queryDetachedSessionLeaderBinding(
  paneId: string,
  pid: number,
  sessionName: string,
  expected: DetachedSessionIncarnation,
): DetachedSessionLeaderBinding | null {
  const result = runTmuxStructured(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}\t#{pane_pid}\t#{session_name}\t#{session_id}\t#{session_created}']);
  if (!result.ok) return null;
  const seenPaneIds = new Set<string>();
  let binding: DetachedSessionLeaderBinding | null = null;
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 6) return null;
    const [currentPaneId, dead, panePid, currentSessionName, sessionId, sessionCreated] = fields;
    if (!/^%[0-9]+$/.test(currentPaneId) || seenPaneIds.has(currentPaneId) || (dead !== '0' && dead !== '1')
      || !/^[0-9]+$/.test(panePid) || !Number.isSafeInteger(Number(panePid)) || Number(panePid) <= 0
      || !currentSessionName || !/^\$[0-9]+$/.test(sessionId) || !/^[0-9]+$/.test(sessionCreated)) return null;
    seenPaneIds.add(currentPaneId);
    if (currentPaneId !== paneId) continue;
    if (dead !== '0' || Number(panePid) !== pid || currentSessionName !== sessionName
      || sessionId !== expected.sessionId || sessionCreated !== expected.sessionCreated) return null;
    binding = { paneId: currentPaneId, pid: Number(panePid), sessionName: currentSessionName, incarnation: { sessionId, sessionCreated } };
  }
  return binding;
}

export type DetachedSessionQueryResult =
  | { status: 'absent' }
  | { status: 'exact'; incarnation: DetachedSessionIncarnation }
  | { status: 'replacement'; incarnation: DetachedSessionIncarnation }
  | { status: 'unavailable'; detail: string };

function parseDetachedSessionIncarnation(stdout: string, sessionName: string): DetachedSessionIncarnation | null | 'malformed' {
  const baseName = baseSessionName(sessionName);
  const matches: DetachedSessionIncarnation[] = [];
  for (const line of stdout.split('\n').filter(Boolean)) {
    const fields = line.split('\t');
    if (fields.length !== 3) return 'malformed';
    const [name, sessionId, sessionCreated] = fields;
    if (!name || !sessionId || !sessionCreated || !/^\$[0-9]+$/.test(sessionId) || !/^[0-9]+$/.test(sessionCreated)) return 'malformed';
    if (baseSessionName(name) === baseName) matches.push({ sessionId, sessionCreated });
  }
  return matches.length === 0 ? null : matches.length === 1 ? matches[0] : 'malformed';
}

/**
 * Reads stable tmux incarnation evidence. Name-only presence is never effect
 * authority: malformed or unavailable evidence fails closed, and an expected
 * incarnation distinguishes an exact survivor from a recycled same-name session.
 */
export function queryDetachedTeamSession(
  sessionName: string,
  expected?: DetachedSessionIncarnation,
): DetachedSessionQueryResult {
  const sessions = runTmuxStructured(['list-sessions', '-F', '#{session_name}\t#{session_id}\t#{session_created}']);
  if (!sessions.ok) {
    return isFinalTmuxServerGone(sessions)
      ? { status: 'absent' }
      : { status: 'unavailable', detail: sessions.stderr };
  }
  const incarnation = parseDetachedSessionIncarnation(sessions.stdout, sessionName);
  if (incarnation === 'malformed') return { status: 'unavailable', detail: 'malformed_session_incarnation' };
  if (incarnation === null) return { status: 'absent' };
  if (expected && (incarnation.sessionId !== expected.sessionId || incarnation.sessionCreated !== expected.sessionCreated)) {
    return { status: 'replacement', incarnation };
  }
  return { status: 'exact', incarnation };
}

/**
 * Re-proves every stable authorization component at the destructive sink. The
 * final tmux command queues an in-server predicate with the kill, so no client
 * can replace the session or pane between authorization and the effect.
 */
function buildDetachedSessionDestroyArgs(expected: DetachedSessionDestroyAuthorization): string[] | null {
  const leaderPaneId = expected.leaderPaneId.trim();
  const ownerId = expected.ownerId.trim();
  if (!/^%[0-9]+$/.test(leaderPaneId)
    || !Number.isSafeInteger(expected.leaderPanePid)
    || expected.leaderPanePid <= 0
    || !/^\$[0-9]+$/.test(expected.sessionId)
    || !/^[0-9]+$/.test(expected.sessionCreated)
    || !/^[A-Za-z0-9._:@/-]+$/.test(ownerId)) return null;

  const predicate = [
    '#{==:#{pane_dead},0}',
    `#{==:#{pane_id},${leaderPaneId}}`,
    `#{==:#{pane_pid},${expected.leaderPanePid}}`,
    `#{==:#{${OMX_TEAM_PANE_OWNER_OPTION}},${ownerId}}`,
    `#{==:#{session_id},${expected.sessionId}}`,
    `#{==:#{session_created},${expected.sessionCreated}}`,
  ].reduce((combined, condition) => `#{&&:${combined},${condition}}`);
  return ['if-shell', '-F', '-t', leaderPaneId, predicate, `kill-session -t ${expected.sessionId}`, 'run-shell "exit 1"'];
}

export function requestDetachedTeamSessionDestroy(
  sessionName: string,
  expected: DetachedSessionDestroyAuthorization,
): boolean {
  const incarnation = { sessionId: expected.sessionId, sessionCreated: expected.sessionCreated };
  if (queryDetachedTeamSession(sessionName, incarnation).status !== 'exact') return false;
  if (!queryDetachedSessionLeaderBinding(expected.leaderPaneId, expected.leaderPanePid, sessionName, incarnation)) return false;
  const pane = readExactPaneProofSync(expected.leaderPaneId);
  if (pane.status !== 'live' || pane.pid !== expected.leaderPanePid) return false;
  const owner = readPaneTeamOwnerTagResult(expected.leaderPaneId);
  if (owner.status !== 'value' || owner.value !== expected.ownerId) return false;
  const args = buildDetachedSessionDestroyArgs(expected);
  return args !== null && runTmux(args).ok;
}

export function destroyTeamSession(sessionName: string): boolean {
  const result = runTmux(['kill-session', '-t', sessionName]);
  if (!result.ok) return false;

  const sessions = runTmux(['list-sessions', '-F', '#{session_name}']);
  // Killing tmux's final session also terminates its server. Its documented
  // no-server response is the only post-kill query failure that proves absence.
  if (!sessions.ok) return isFinalTmuxServerGone(sessions);
  return !parseTeamSessionNames(sessions.stdout).includes(baseSessionName(sessionName));
}

// A failed query is not a successful empty session list. Destructive callers
// must require the latter before treating a detached session as absent.
export function listTeamSessions(): string[] | null {
  const result = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (!result.ok) return null;

  return parseTeamSessionNames(result.stdout);
}

/**
 * Notify the leader through durable mailbox state only.
 *
 * Team leaders are a coordination endpoint, not a direct tmux control target:
 * workers and runtime paths may message `leader-fixed` via `omx team api`
 * / mailbox persistence, but team code must not inject text or control keys
 * into the leader pane. This is the async mailbox-based replacement for
 * `notifyLeaderStatus()`.
 */
export async function notifyLeaderMailboxAsync(
  teamName: string,
  fromWorker: string,
  message: string,
  cwd: string,
): Promise<boolean> {
  try {
    const { sendDirectMessage } = await import('./state.js');
    await sendDirectMessage(teamName, fromWorker, 'leader-fixed', message, cwd);
    return true;
  } catch {
    return false;
  }
}
