/**
 * omx supervision [<user-prompt>] — live-session health checks and triage (Refs #4217, PR 1).
 *
 * Pipeline: discover sessions -> collect ONE snapshot -> run pure checks ->
 * (optional) spark analysis lanes -> triage P0-P3 -> report/drafts -> (optional) --file.
 * Every check is a pure function of the injected snapshot so it can be unit-tested;
 * Checks are a registry keyed by stable ids (supervision-registry.ts); the past issues each id
 * was derived from are per-user history data (supervision-history.iqdoctor.ts), not check logic.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSparkDefaultModel } from '../config/models.js';
import { LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK, resolveNativeSubagentSupportStatus } from '../leader/contract.js';
import { isHudWatchPane, parseTmuxPaneSnapshot, readHudPaneOwner, TMUX_PANE_FIELD_SEPARATOR } from '../hud/tmux.js';
import type { TmuxPaneSnapshot } from '../hud/tmux.js';
import { projectHudModes, readAllState, readVersion } from '../hud/state.js';
import { getBaseStateDir } from '../mcp/state-paths.js';
import { listActiveSkills, readVisibleSkillActiveStateForStateDir } from '../state/skill-active.js';
import { realpathSync } from 'node:fs';
import { CODEX_REVIEW_LOOP_USAGE, codexReviewLoopCommand } from './supervision-codex-review.js';
import { normalizeAutopilotPhase } from '../autopilot/fsm.js';
import { isValidTransition } from '../team/orchestrator.js';
import type { TeamPhase } from '../team/orchestrator.js';
import { buildSubagentResumeLedger } from '../subagents/tracker.js';
import type { SubagentTrackingState } from '../subagents/tracker.js';
import { buildSessionFrictionReport } from '../session-history/friction.js';
import { codexHome } from '../utils/paths.js';
import { REPEAT_PROBLEM_REGISTRY, sourcesFor } from './supervision-registry.js';
import type { CheckArea, RepeatProblem, RepeatProblemHistory, Severity } from './supervision-registry.js';
import { IQDOCTOR_HISTORY } from './supervision-history.iqdoctor.js';
import { checkNativeAgentConfigDrift, checkPluginVersionDiagnostics, resolveDoctorPaths, resolveDoctorScope } from './doctor.js';

export const SUPERVISION_REPO = 'Yeachan-Heo/oh-my-codex';
export const SUPERVISION_MARKER_PREFIX = 'omx-supervision:fingerprint=';
export const DEFAULT_WINDOW_SECONDS = 10;
/** CPU gate reused from #4202: more than ~2% of one core per HUD is a finding. */
export const HUD_CPU_THRESHOLD_PCT = 2;

export const SUPERVISION_HELP = `omx supervision - Live OMX session health checks and triage

Usage:
  omx supervision [options] [<user-prompt>]
  ${CODEX_REVIEW_LOOP_USAGE}

Inspects the running OMX sessions (or the most recent one when none is running),
runs deterministic health checks, optionally analyses failures with spark explore
lanes, ranks findings P0-P3, and writes a report plus issue drafts to
.omx/supervision/<timestamp>/.

Options:
  --window <seconds>   CPU sampling window for omx / hud --watch processes (default ${DEFAULT_WINDOW_SECONDS})
  --no-analyze         Skip the spark analysis lanes (deterministic checks only)
  --file               File GitHub issues in ${SUPERVISION_REPO} for P0/P1 findings without a duplicate
  --json               Print the machine-readable report on stdout
  --help, -h           Show this help

<user-prompt> is free-form text describing the problem; it is passed to every analysis lane.
Use -- to end options when the prompt itself starts with a dash.
Exit code is 1 when any check fails.

Dogfooding loop:
  1. omx update --dev
  2. omx supervision "<problem>"
  3. Paste .omx/supervision/<timestamp>/report.md (printed at the end of the run) into the issue as is.
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type { CheckArea, Severity };

export interface SupervisionOptions {
  windowSeconds: number;
  analyze: boolean;
  file: boolean;
  json: boolean;
  help: boolean;
  prompt: string;
}

export interface ProcSample {
  pid: number;
  ppid: number;
  kind: 'omx' | 'hud-watch';
  args: string;
  rssKb: number;
  cpuSecStart: number | null;
  cpuSecEnd: number | null;
  /** Percent of one core over the sampling window; null when it could not be measured. */
  cpuPct: number | null;
  cwd?: string;
  cwdDeleted?: boolean;
  omxRoot?: string;
  sessionId?: string;
}

export interface SessionCandidate {
  sessionId: string;
  cwd: string;
  stateDir: string;
  startedAt?: string;
  pid?: number;
  pidAlive: boolean;
  tmuxPaneId?: string;
  codexSessionId?: string;
  stateMtimeMs: number;
  rolloutMtimeMs: number | null;
  sources: string[];
}

export interface SessionSelection {
  selected: SessionCandidate | null;
  mode: 'active' | 'fallback-recent' | 'none';
  reason: string;
  candidates: SessionCandidate[];
}

export interface ModeStateRecord {
  mode: string;
  scope: 'root' | 'session';
  path: string;
  mtimeMs: number;
  data: Record<string, unknown>;
}

export interface DoctorCheckResult {
  status: CheckStatus;
  message: string;
}

export interface SupervisionSnapshot {
  takenAt: string;
  nowMs: number;
  windowSeconds: number;
  platform: string;
  selection: SessionSelection;
  processes: ProcSample[];
  panes: TmuxPaneSnapshot[];
  /** True when `tmux list-panes -a` answered (a tmux server is reachable). */
  tmuxAvailable: boolean;
  state: {
    stateDir: string | null;
    modes: ModeStateRecord[];
    currentAutopilot: Record<string, unknown> | null;
    nativeStop: Record<string, unknown> | null;
    supportBlockers: Array<{ file: string; data: Record<string, unknown> }>;
    /** team phase.json files (the persisted autopilot `team` child phase log): current phase + transitions. */
    /** Active skills from the canonical skill-active state the HUD also consults. */
    canonicalSkills: Array<{ skill: string; phase?: string }>;
    teamPhases: Array<{ path: string; currentPhase?: string; transitions: Array<{ from: string; to: string }> }>;
    subagentTracking: SubagentTrackingState | null;
    sizes: { stateBytes: number; logsBytes: number; rolloutBytes: number; rolloutScanTruncated: boolean };
    hookLog: { path: string; dispatchErrors: number; samples: string[] } | null;
  };
  /** Rendered HUD model reduced to mode -> phase, as readAllState() produced it. */
  hud: { modes: Record<string, { phase?: string }>; staleAutopilot: boolean } | null;
  doctor: { nativeAgents: DoctorCheckResult | null; pluginVersions: DoctorCheckResult | null };
  friction: Array<{ code: string; severity: string; message: string }>;
}

/**
 * Single object handed to the snapshot collector's caller and to the analysis-lane planner.
 * Later evidence sources (the #4217 section 7 preflight) extend this bundle; checks keep
 * reading only `snapshot`.
 */
export interface EvidenceBundle {
  schemaVersion: 1;
  collectedAt: string;
  snapshot: SupervisionSnapshot;  // Primary snapshot (for backward compatibility)
  snapshots?: Map<string, SupervisionSnapshot>;  // All active session snapshots (optional, for multi-session support)
}

export function toEvidenceBundle(snapshot: SupervisionSnapshot): EvidenceBundle {
  return { schemaVersion: 1, collectedAt: snapshot.takenAt, snapshot };
}

export function summarizeEvidence(bundle: EvidenceBundle): string {
  const { snapshot, snapshots } = bundle;
  // Include all sessions when available; fallback to primary snapshot
  const sessionsList = snapshots ? Array.from(snapshots.entries()).map(([sessionId, snap]) => ({
    sessionId,
    cwd: snap.selection.selected?.cwd,
    mode: snap.selection.mode,
    modes: snap.state.modes.map((record) => ({ mode: record.mode, active: record.data.active, phase: record.data.current_phase })),
    friction: snap.friction,
  })) : [{
    sessionId: snapshot.selection.selected?.sessionId,
    cwd: snapshot.selection.selected?.cwd,
    mode: snapshot.selection.mode,
    modes: snapshot.state.modes.map((record) => ({ mode: record.mode, active: record.data.active, phase: record.data.current_phase })),
    friction: snapshot.friction,
  }];
  return JSON.stringify({
    collectedAt: bundle.collectedAt,
    sessions: sessionsList,
    processes: snapshot.processes.map((proc) => ({ pid: proc.pid, kind: proc.kind, cpuPct: proc.cpuPct, rssKb: proc.rssKb })),
  }, null, 1);
}

export interface CheckOutcome {
  status: CheckStatus;
  evidence: string[];
  /** Stable, host-independent key (no pids/paths/timestamps) folded into the fingerprint. */
  key?: string;
  /** Number of distinct sessions/panes/pids implicated; >=3 widens blast radius. */
  blast?: number;
}

/** A registry entry (data) joined with its runner (logic) by stable id. */
export interface CheckDefinition extends RepeatProblem {
  run: (snapshot: SupervisionSnapshot) => CheckOutcome;
}

export interface CheckResult {
  id: string;
  area: CheckArea;
  title: string;
  status: CheckStatus;
  evidence: string[];
  fingerprint: string;
  severity: Severity;
  repro: 'persistent' | 'sampled';
  sources: number[];
  blast: number;
  sessionId?: string;  // Optional: identifies which session this check is for (multi-session support)
}

export interface Finding extends CheckResult {
  priority: Priority;
  score: number;
  duplicate?: { number: number; url: string };
  dedupe: 'none' | 'duplicate' | 'unknown';
  analysis?: string;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseSupervisionArgs(args: readonly string[]): SupervisionOptions {
  const options: SupervisionOptions = {
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    analyze: true,
    file: false,
    json: false,
    help: false,
    prompt: '',
  };
  const promptParts: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      promptParts.push(token);
      continue;
    }
    if (token === '--') {
      optionsEnded = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--json') {
      options.json = true;
    } else if (token === '--file') {
      options.file = true;
    } else if (token === '--no-analyze') {
      options.analyze = false;
    } else if (token === '--window' || token.startsWith('--window=')) {
      const raw = token === '--window' ? args[++i] : token.slice('--window='.length);
      if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0 || Number(raw) > 3600) {
        throw new Error(`--window expects seconds between 0 and 3600, got: ${raw ?? '(missing)'}`);
      }
      options.windowSeconds = Number(raw);
    } else {
      throw new Error(`Unknown omx supervision option: ${token}. Use -- before a prompt that starts with a dash.`);
    }
  }
  options.prompt = promptParts.join(' ').trim();
  return options;
}

// ---------------------------------------------------------------------------
// CPU math
// ---------------------------------------------------------------------------

/** Parse `ps -o time=` output: [[DD-]HH:]MM:SS[.frac] -> seconds. */
export function parsePsCpuTime(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** Percent of one core consumed between two cumulative CPU-time samples. */
export function computeCpuPercent(startSec: number | null, endSec: number | null, wallSeconds: number): number | null {
  if (startSec === null || endSec === null || !(wallSeconds > 0) || endSec < startSec) return null;
  return Math.round(((endSec - startSec) / wallSeconds) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Session selection (pure)
// ---------------------------------------------------------------------------

function activityMs(candidate: SessionCandidate): number {
  return Math.max(candidate.stateMtimeMs, candidate.rolloutMtimeMs ?? 0);
}

export function selectSession(candidates: readonly SessionCandidate[], requestedSessionId?: string): SessionSelection {
  const sorted = [...candidates].sort((a, b) => activityMs(b) - activityMs(a));
  if (requestedSessionId) {
    const match = sorted.find((candidate) => candidate.sessionId === requestedSessionId);
    if (match) {
      return { selected: match, mode: match.pidAlive ? 'active' : 'fallback-recent', reason: `session ${match.sessionId} requested explicitly`, candidates: sorted };
    }
  }
  const active = sorted.filter((candidate) => candidate.pidAlive);
  if (active.length > 0) {
    const selected = active[0] as SessionCandidate;
    return {
      selected,
      mode: 'active',
      reason: `${active.length} active session(s); chose ${selected.sessionId} (owner pid ${selected.pid} alive, most recent activity)`,
      candidates: sorted,
    };
  }
  if (sorted.length > 0) {
    const selected = sorted[0] as SessionCandidate;
    return {
      selected,
      mode: 'fallback-recent',
      reason: `no active session; fell back to the most recent session ${selected.sessionId} (latest of .omx/state mtime and Codex rollout mtime)`,
      candidates: sorted,
    };
  }
  return { selected: null, mode: 'none', reason: 'no OMX session found (no live omx process, no .omx/state/session.json, no recent Codex rollout with OMX state)', candidates: [] };
}

// ---------------------------------------------------------------------------
// Checks (pure functions of the snapshot)
// ---------------------------------------------------------------------------

const ACTIVE_STATE_MODES = ['autopilot', 'ralplan', 'deep-interview', 'ralph', 'ultrawork', 'autoresearch', 'ultraqa', 'team'] as const;
const HUD_STATE_KEY: Record<string, string> = { autopilot: 'autopilot', ralplan: 'ralplan', 'deep-interview': 'deepInterview', ralph: 'ralph', ultrawork: 'ultrawork', autoresearch: 'autoresearch', ultraqa: 'ultraqa', team: 'team' };

const RSS_WARN_KB = 1024 * 1024;
const RSS_FAIL_KB = 2 * 1024 * 1024;
const MB = 1024 * 1024;
const STATE_WARN_BYTES = 100 * MB;
const STATE_FAIL_BYTES = 1024 * MB;
const LOGS_WARN_BYTES = 200 * MB;
const LOGS_FAIL_BYTES = 1024 * MB;
const ROLLOUT_WARN_BYTES = 5 * 1024 * MB;
const ROLLOUT_FAIL_BYTES = 20 * 1024 * MB;
const AUTOPILOT_STUCK_MS = 2 * 60 * 60 * 1000;
const STOP_LOOP_WARN = 4;
/** Mirrors ORDINARY_STOP_NO_PROGRESS_DEFAULT_MAX_REPEATS in src/scripts/codex-native-hook.ts. */
const STOP_LOOP_FAIL = 8;
const GENERIC_REVIEWER_ROLES = new Set(['', 'default', 'worker']);

function activeModes(snapshot: SupervisionSnapshot): ModeStateRecord[] {
  return snapshot.state.modes.filter((record) => record.data.active === true);
}

function phaseOf(record: ModeStateRecord | undefined): string | undefined {
  const phase = record?.data.current_phase;
  return typeof phase === 'string' && phase.trim() ? phase.trim() : undefined;
}

function sessionLedger(snapshot: SupervisionSnapshot) {
  const selected = snapshot.selection.selected;
  if (!selected || !snapshot.state.subagentTracking) return null;
  return buildSubagentResumeLedger(snapshot.state.subagentTracking, selected.sessionId, { now: new Date(snapshot.nowMs) });
}

function bytesLabel(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MiB`;
}

function tier(value: number, warnAt: number, failAt: number): CheckStatus {
  return value >= failAt ? 'fail' : value >= warnAt ? 'warn' : 'pass';
}

const hudProcs = (snapshot: SupervisionSnapshot) => snapshot.processes.filter((proc) => proc.kind === 'hud-watch');

const CHECK_RUNNERS: Record<string, CheckDefinition['run']> = {
  'silver-rule-lane-reuse': (snapshot) => {
      const ledger = sessionLedger(snapshot);
      if (!ledger) return { status: 'pass', evidence: ['no subagent tracking for the selected session'] };
      const groups = new Map<string, string[]>();
      for (const entry of ledger.savedSubagents) {
        if (entry.status === 'unavailable' || !entry.role) continue;
        const key = `${entry.role}/${entry.laneId ?? entry.role}`;
        groups.set(key, [...(groups.get(key) ?? []), entry.threadId]);
      }
      const duplicated = [...groups.entries()].filter(([, ids]) => ids.length > 1);
      if (duplicated.length === 0) return { status: 'pass', evidence: [`${ledger.savedSubagents.length} saved subagent(s), one reusable entry per role/lane`] };
      return {
        status: 'warn',
        key: duplicated.map(([key]) => key).sort().join(','),
        evidence: duplicated.map(([key, ids]) => `role/lane ${key} has ${ids.length} reusable entries (${ids.join(', ')}); Silver Rule says reuse/resume before spawning`),
      };
    },
  'ralplan-lane-reuse': (snapshot) => {
      const ralplan = activeModes(snapshot).find((record) => record.mode === 'ralplan');
      const ledger = sessionLedger(snapshot);
      if (!ralplan || !ledger) return { status: 'pass', evidence: ['ralplan not active or no subagent tracking'] };
      const generic = ledger.savedSubagents.filter((entry) => GENERIC_REVIEWER_ROLES.has(entry.role ?? ''));
      if (generic.length === 0) return { status: 'pass', evidence: [`ralplan active; all ${ledger.savedSubagents.length} subagent(s) have typed roles`] };
      return {
        status: 'warn',
        key: 'generic-reviewer',
        evidence: generic.map((entry) => `thread ${entry.threadId} has role "${entry.role ?? '(none)'}" while ralplan (${ralplan.path}) is active`),
      };
    },
  'native-subagent-blocker': (snapshot) => {
      const byFile = (name: string) => snapshot.state.supportBlockers.find((blocker) => blocker.file.endsWith(name))?.data ?? null;
      const selected = snapshot.selection.selected;
      // Reuse the leader contract's own scope + expiry semantics (cwd/session binding, expires_at).
      const support = resolveNativeSubagentSupportStatus({
        persistedSupportBlocker: byFile('native-subagent-support.json'),
        persistedCapacityBlocker: byFile('native-subagent-capacity-blocker.json'),
        nowMs: snapshot.nowMs,
        ...(selected ? { cwd: selected.cwd, sessionId: selected.sessionId } : {}),
      });
      const blocked = support.status === 'unsupported' || (support.status === 'unknown' && support.reason !== undefined);
      if (!blocked) return { status: 'pass', evidence: [`no live native subagent blocker for this session (${support.status}, ${support.source})`] };
      const active = activeModes(snapshot);
      const evidence = [`${support.source}: ${support.reason ?? support.status}${support.evidenceSummary ? ` - ${support.evidenceSummary}` : ''}${support.expiresAt ? ` (expires ${support.expiresAt})` : ''}`];
      if (active.length === 0) return { status: 'warn', key: 'blocker-idle', evidence: [...evidence, 'no workflow active'] };
      return {
        status: support.status === 'unsupported' ? 'fail' : 'warn',
        key: `blocker-${support.status}-${active.map((record) => record.mode).sort().join('+')}`,
        evidence: [...evidence, `active workflow(s): ${active.map((record) => record.mode).join(', ')}`, `contract: ${LEADER_CONDUCTOR_UNSUPPORTED_NATIVE_DEGRADE_BLOCK.slice(0, 120)}...`],
      };
    },
  'hud-cpu-load': (snapshot) => {
      const huds = hudProcs(snapshot);
      if (huds.length === 0) return { status: 'pass', evidence: ['no hud --watch process'] };
      const unmeasured = huds.filter((proc) => proc.cpuPct === null);
      const hot = huds.filter((proc) => (proc.cpuPct ?? 0) > HUD_CPU_THRESHOLD_PCT);
      if (hot.length > 0) {
        return {
          status: 'fail',
          key: 'hud-cpu',
          blast: hot.length,
          evidence: hot.map((proc) => `pid ${proc.pid} used ${proc.cpuPct}% of a core over ${snapshot.windowSeconds}s (cpu ${proc.cpuSecStart?.toFixed(2)}s -> ${proc.cpuSecEnd?.toFixed(2)}s, threshold ${HUD_CPU_THRESHOLD_PCT}%) cmd: ${proc.args.slice(0, 140)}`),
        };
      }
      if (unmeasured.length === huds.length) return { status: 'warn', key: 'hud-cpu-unmeasured', evidence: [`CPU time unreadable for pid(s) ${unmeasured.map((proc) => proc.pid).join(', ')}`] };
      return { status: 'pass', evidence: huds.map((proc) => `pid ${proc.pid}: ${proc.cpuPct ?? '?'}%`) };
    },
  'hud-duplicate-panes': (snapshot) => {
      const groups = new Map<string, string[]>();
      for (const pane of snapshot.panes) {
        if (!isHudWatchPane(pane)) continue;
        const owner = readHudPaneOwner(pane);
        const key = `${pane.windowId ?? 'window?'}|${owner.leaderPaneId ?? owner.sessionId ?? 'unowned'}`;
        groups.set(key, [...(groups.get(key) ?? []), pane.paneId]);
      }
      const duplicated = [...groups.entries()].filter(([, ids]) => ids.length > 1);
      const total = [...groups.values()].reduce((sum, ids) => sum + ids.length, 0);
      if (duplicated.length === 0) return { status: 'pass', evidence: [`${total} HUD pane(s), at most one per leader/window`] };
      return {
        status: 'fail',
        key: 'hud-duplicate-panes',
        blast: total,
        evidence: duplicated.map(([key, ids]) => `${ids.length} HUD panes (${ids.join(', ')}) for ${key}`),
      };
    },
  'process-rss': (snapshot) => {
      const heavy = snapshot.processes.filter((proc) => proc.rssKb >= RSS_WARN_KB);
      if (heavy.length === 0) return { status: 'pass', evidence: [`${snapshot.processes.length} process(es) under ${RSS_WARN_KB / 1024} MiB RSS`] };
      const status = heavy.some((proc) => proc.rssKb >= RSS_FAIL_KB) ? 'fail' : 'warn';
      return { status, key: `rss-${heavy.map((proc) => proc.kind).sort().join('+')}`, blast: heavy.length, evidence: heavy.map((proc) => `pid ${proc.pid} (${proc.kind}) RSS ${(proc.rssKb / 1024).toFixed(0)} MiB`) };
    },
  'disk-growth': (snapshot) => {
      const { stateBytes, logsBytes, rolloutBytes, rolloutScanTruncated } = snapshot.state.sizes;
      const rows: Array<[string, number, CheckStatus]> = [
        ['.omx/state', stateBytes, tier(stateBytes, STATE_WARN_BYTES, STATE_FAIL_BYTES)],
        ['.omx/logs', logsBytes, tier(logsBytes, LOGS_WARN_BYTES, LOGS_FAIL_BYTES)],
        ['codex rollouts', rolloutBytes, tier(rolloutBytes, ROLLOUT_WARN_BYTES, ROLLOUT_FAIL_BYTES)],
      ];
      const bad = rows.filter(([, , status]) => status !== 'pass');
      const evidence = rows.map(([name, bytes, status]) => `${name}: ${bytesLabel(bytes)} (${status})${name === 'codex rollouts' && rolloutScanTruncated ? ' [scan truncated]' : ''}`);
      if (bad.length === 0) return { status: 'pass', evidence };
      return { status: bad.some(([, , status]) => status === 'fail') ? 'fail' : 'warn', key: `disk-${bad.map(([name]) => name).join('+')}`, evidence };
    },
  'autopilot-phase-illegal': (snapshot) => {
      const autopilot = activeModes(snapshot).find((record) => record.mode === 'autopilot');
      if (!autopilot) return { status: 'pass', evidence: ['autopilot not active'] };
      const phase = phaseOf(autopilot);
      if (!phase) return { status: 'fail', key: 'phase-missing', evidence: [`${autopilot.path}: active without current_phase`] };
      if (normalizeAutopilotPhase(phase) === null) return { status: 'fail', key: 'phase-illegal', evidence: [`${autopilot.path}: current_phase "${phase}" is not a legal autopilot phase`] };
      return { status: 'pass', evidence: [`${autopilot.path}: phase ${phase}`] };
    },
  'team-phase-transition-illegal': (snapshot) => {
    const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
    const bad: string[] = [];
    for (const phase of snapshot.state.teamPhases) {
      for (const transition of phase.transitions) {
        // Forced termination (hook failure/cancel) may reach a terminal phase from anywhere;
        // anything else must follow orchestrator.isValidTransition, and terminal phases are final.
        const legal = TERMINAL.has(transition.from)
          ? false
          : TERMINAL.has(transition.to) && transition.to !== 'complete'
            ? true
            : isValidTransition(transition.from as TeamPhase, transition.to as TeamPhase);
        if (!legal) bad.push(`${phase.path}: illegal transition ${transition.from} -> ${transition.to}`);
      }
    }
    if (bad.length === 0) return { status: 'pass', evidence: [`${snapshot.state.teamPhases.length} team phase log(s), all transitions legal`] };
    return { status: 'fail', key: 'team-phase-transition', evidence: bad };
  },
  'autopilot-phase-stuck': (snapshot) => {
      const autopilot = activeModes(snapshot).find((record) => record.mode === 'autopilot');
      const phase = phaseOf(autopilot);
      if (!autopilot || phase === 'waiting-for-user') return { status: 'pass', evidence: ['autopilot not active or waiting for the user'] };
      const updated = typeof autopilot.data.updated_at === 'string' ? Date.parse(autopilot.data.updated_at) : NaN;
      const lastMs = Number.isFinite(updated) ? updated : autopilot.mtimeMs;
      const idleMs = snapshot.nowMs - lastMs;
      if (idleMs < AUTOPILOT_STUCK_MS) return { status: 'pass', evidence: [`phase ${phase ?? '?'} updated ${Math.round(idleMs / 60000)} min ago`] };
      return { status: 'warn', key: `stuck-${phase ?? 'unknown'}`, evidence: [`${autopilot.path}: phase ${phase ?? '?'} unchanged for ${Math.round(idleMs / 60000)} min while active (timeout ${AUTOPILOT_STUCK_MS / 60000} min)`] };
    },
  'autopilot-gate-loop': (snapshot) => {
      const sessions = snapshot.state.nativeStop?.sessions;
      if (!sessions || typeof sessions !== 'object') return { status: 'pass', evidence: ['no native-stop-state.json sessions'] };
      const looping: Array<{ key: string; repeats: number }> = [];
      for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
        const guard = (value as { ordinary_no_progress_guard?: { repeat_count?: unknown; last_seen_at?: unknown } } | null)?.ordinary_no_progress_guard;
        const repeats = Number(guard?.repeat_count ?? 0);
        const lastSeen = typeof guard?.last_seen_at === 'string' ? Date.parse(guard.last_seen_at) : NaN;
        if (repeats >= STOP_LOOP_WARN && Number.isFinite(lastSeen) && snapshot.nowMs - lastSeen < 60 * 60 * 1000) looping.push({ key, repeats });
      }
      if (looping.length === 0) return { status: 'pass', evidence: ['no repeated Stop-hook guard in the last hour'] };
      const worst = Math.max(...looping.map((entry) => entry.repeats));
      return {
        status: worst >= STOP_LOOP_FAIL ? 'fail' : 'warn',
        key: 'stop-guard-loop',
        blast: looping.length,
        evidence: looping.map((entry) => `native-stop-state session ${entry.key}: ${entry.repeats} identical Stop-hook passes (guard trips at ${STOP_LOOP_FAIL})`),
      };
    },
  'stop-hook-invalid-json': (snapshot) => {
      const log = snapshot.state.hookLog;
      if (!log || log.dispatchErrors === 0) return { status: 'pass', evidence: [log ? `${log.path}: no dispatch errors` : 'no native-hook log for today'] };
      return { status: 'fail', key: 'stop-dispatch-errors', evidence: [`${log.path}: ${log.dispatchErrors} dispatch/invalid-JSON error record(s)`, ...log.samples] };
    },
  'hud-authority-churn': (snapshot) => {
      if (!snapshot.hud) return { status: 'pass', evidence: ['HUD model unavailable (no selected session)'] };
      const mismatches: string[] = [];
      const canonical = snapshot.state.canonicalSkills;
      const autopilotPhase = phaseOf(activeModes(snapshot).find((record) => record.mode === 'autopilot'));
      for (const record of activeModes(snapshot)) {
        if (!(ACTIVE_STATE_MODES as readonly string[]).includes(record.mode)) continue;
        const shown = snapshot.hud.modes[HUD_STATE_KEY[record.mode] as string];
        // Detail-first precedence: detail phase is preferred, canonical is a fallback (like HUD's mergePhase).
        const detailPhase = phaseOf(record);
        const canonicalPhase = canonical.find((skill) => skill.skill === record.mode)?.phase;
        let phase = detailPhase ?? canonicalPhase;
        if (record.mode === 'team') {
          // Team precedence (HUD mergeTeamPhase): team/<name>/phase.json, then canonical skill phase, then detail.
          const teamName = typeof record.data.team_name === 'string' ? record.data.team_name.trim() : '';
          const logPhase = teamName
            ? snapshot.state.teamPhases.find((log) => /[\\/]team[\\/]([^\\/]+)[\\/]phase\.json$/.exec(log.path)?.[1] === teamName)?.currentPhase?.trim()
            : undefined;
          phase = logPhase || canonicalPhase || detailPhase;
        }
        if (!shown) mismatches.push(`${record.mode} is active in ${record.path} (phase ${phase ?? '?'}) but the HUD shows nothing`);
        else if (phase && shown.phase && shown.phase !== phase) mismatches.push(`${record.mode} phase is "${phase}" in state but HUD shows "${shown.phase}"`);
      }
      for (const [mode, shown] of Object.entries(snapshot.hud.modes)) {
        const stateMode = Object.entries(HUD_STATE_KEY).find(([, hudKey]) => hudKey === mode)?.[0];
        // supported renderings without a detail file: canonical active skill, or ultraqa synthesized from autopilot's phase.
        const supported = canonical.some((skill) => skill.skill === stateMode) || (stateMode === 'ultraqa' && autopilotPhase === 'ultraqa');
        if (shown && stateMode && !supported && !activeModes(snapshot).some((record) => record.mode === stateMode) && stateMode !== 'team') {
          mismatches.push(`HUD shows ${mode} (phase ${shown.phase ?? '?'}) but no active ${stateMode} state exists`);
        }
      }
      const current = snapshot.state.currentAutopilot;
      if (snapshot.hud.staleAutopilot && current) mismatches.push('current-autopilot.json is active but not authoritative (HUD flags it stale)');
      if (mismatches.length === 0) return { status: 'pass', evidence: ['HUD model matches .omx/state for all active modes'] };
      return { status: 'fail', key: 'hud-model-mismatch', evidence: mismatches };
    },
  'native-agent-toml-drift': (snapshot) => {
      const result = snapshot.doctor.nativeAgents;
      if (!result) return { status: 'pass', evidence: ['doctor native-agent check unavailable'] };
      return { status: result.status, key: 'native-toml-drift', evidence: [`omx doctor: ${result.message}`] };
    },
  'question-outside-tmux': (snapshot) => {
      const selected = snapshot.selection.selected;
      const asking = activeModes(snapshot).filter((record) => record.mode === 'deep-interview' || (record.mode === 'autopilot' && phaseOf(record) === 'deep-interview'));
      if (!selected || snapshot.selection.mode !== 'active' || asking.length === 0) return { status: 'pass', evidence: ['no active deep-interview in a live session'] };
      const paneKnown = selected.tmuxPaneId ? snapshot.panes.some((pane) => pane.paneId === selected.tmuxPaneId) : false;
      if (paneKnown) return { status: 'pass', evidence: [`pane ${selected.tmuxPaneId} is live`] };
      return {
        status: 'fail',
        key: 'question-no-tmux',
        evidence: [`${asking.map((record) => record.mode).join(', ')} is active but session ${selected.sessionId} has ${selected.tmuxPaneId ? `tmux pane ${selected.tmuxPaneId} that is not live` : 'no tmux_pane_id'}${snapshot.tmuxAvailable ? '' : ' (tmux server unreachable)'}`],
      };
    },
  'stale-omx-root': (snapshot) => {
      const selected = snapshot.selection.selected;
      const bad: string[] = [];
      for (const proc of snapshot.processes) {
        if (!proc.omxRoot) continue;
        if (!existsSync(proc.omxRoot)) {
          bad.push(`pid ${proc.pid} (${proc.kind}) OMX_ROOT=${proc.omxRoot} does not exist`);
          continue;
        }
        const sameSession = selected && (proc.sessionId === selected.sessionId || proc.cwd === selected.cwd);
        if (sameSession && selected && !samePath(stateDirForRoot(proc.omxRoot), selected.stateDir)) {
          bad.push(`pid ${proc.pid} (${proc.kind}) OMX_ROOT=${proc.omxRoot} but session state lives in ${selected.stateDir}`);
        }
      }
      if (bad.length === 0) return { status: 'pass', evidence: ['no process with a stale or mismatched OMX_ROOT'] };
      return { status: 'fail', key: 'stale-omx-root', blast: bad.length, evidence: bad };
    },
  'hud-deleted-cwd': (snapshot) => {
      const bad: string[] = [];
      for (const pane of snapshot.panes) {
        if (isHudWatchPane(pane) && pane.currentPath && !existsSync(pane.currentPath)) bad.push(`HUD pane ${pane.paneId} cwd ${pane.currentPath} no longer exists`);
      }
      for (const proc of hudProcs(snapshot)) {
        if (proc.cwdDeleted) bad.push(`HUD pid ${proc.pid} cwd ${proc.cwd ?? '?'} was deleted`);
      }
      if (bad.length === 0) return { status: 'pass', evidence: ['all HUD watchers have a live cwd'] };
      return { status: 'fail', key: 'deleted-cwd-hud', blast: bad.length, evidence: bad };
    },
  'setup-cache-drift': (snapshot) => {
      const result = snapshot.doctor.pluginVersions;
      if (!result) return { status: 'pass', evidence: ['doctor plugin-version check unavailable'] };
      return { status: result.status, key: 'plugin-cache-drift', evidence: [`omx doctor: ${result.message}`] };
    },
};

/** Registry metadata (src/cli/supervision-registry.ts) joined with the runner for the same stable id. */
export const SUPERVISION_CHECKS: readonly CheckDefinition[] = REPEAT_PROBLEM_REGISTRY.map((entry) => {
  const run = CHECK_RUNNERS[entry.id];
  if (!run) throw new Error(`supervision registry entry ${entry.id} has no runner`);
  return { ...entry, run };
});

/** State dir for an OMX_ROOT / OMX_STATE_ROOT override, via the same resolver the runtime uses (<root>/.omx/state). */
export function stateDirForRoot(root: string): string {
  try {
    return getBaseStateDir(undefined, { OMX_ROOT: root });
  } catch {
    return join(root, '.omx', 'state');
  }
}

function samePath(a: string, b: string): boolean {
  const canon = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return canon(a) === canon(b);
}

export function fingerprintFor(id: string, key: string | undefined): string {
  return createHash('sha256').update(`${id}|${key ?? ''}`).digest('hex').slice(0, 16);
}

export function evaluateChecks(
  snapshot: SupervisionSnapshot,
  checks: readonly CheckDefinition[] = SUPERVISION_CHECKS,
  history: RepeatProblemHistory = IQDOCTOR_HISTORY,
): CheckResult[] {
  return checks.map((check) => {
    let outcome: CheckOutcome;
    try {
      outcome = check.run(snapshot);
    } catch (error) {
      outcome = { status: 'warn', key: 'check-error', evidence: [`check threw: ${error instanceof Error ? error.message : String(error)}`] };
    }
    return {
      id: check.id,
      area: check.area,
      title: check.title,
      status: outcome.status,
      evidence: outcome.evidence.map((line) => (line.length > 400 ? `${line.slice(0, 399)}…` : line)),
      fingerprint: fingerprintFor(check.id, outcome.key),
      severity: check.severity,
      repro: check.repro,
      sources: sourcesFor(history, check.id),
      blast: outcome.blast ?? 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** score = status(fail 2 / warn 1) + severity(0-3) + reproducibility(persistent +1) + blast(>=3 +1); P0>=7, P1>=5, P2>=3. */
export function rankFinding(result: Pick<CheckResult, 'status' | 'severity' | 'repro' | 'blast'>): { priority: Priority; score: number } {
  const score = (result.status === 'fail' ? 2 : 1)
    + SEVERITY_WEIGHT[result.severity]
    + (result.repro === 'persistent' ? 1 : 0)
    + (result.blast >= 3 ? 1 : 0);
  const priority: Priority = score >= 7 ? 'P0' : score >= 5 ? 'P1' : score >= 3 ? 'P2' : 'P3';
  return { priority, score };
}

export function triage(results: readonly CheckResult[]): Finding[] {
  return results
    .filter((result) => result.status !== 'pass')
    .map((result): Finding => ({ ...result, ...rankFinding(result), dedupe: 'none' }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export type GhRunner = (args: string[], input?: string) => string;

export function defaultGhRunner(args: string[], input?: string): string {
  return execFileSync('gh', args, { encoding: 'utf-8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
}

export function markerFor(fingerprint: string): string {
  return `<!-- ${SUPERVISION_MARKER_PREFIX}${fingerprint} -->`;
}

/** Look for an open issue whose body carries this fingerprint's marker. */
export function findDuplicateIssue(fingerprint: string, gh: GhRunner): { number: number; url: string } | null | 'unknown' {
  try {
    const query = `repo:${SUPERVISION_REPO} is:issue is:open in:body "${SUPERVISION_MARKER_PREFIX}${fingerprint}"`;
    const raw = gh(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'per_page=20']);
    const parsed = JSON.parse(raw) as { items?: Array<{ number: number; html_url: string; body?: string | null }> };
    const marker = markerFor(fingerprint);
    const hit = (parsed.items ?? []).find((item) => (item.body ?? '').includes(marker));
    return hit ? { number: hit.number, url: hit.html_url } : null;
  } catch {
    return 'unknown';
  }
}

export function applyDedupe(findings: Finding[], gh: GhRunner): Finding[] {
  return findings.map((finding) => {
    const duplicate = findDuplicateIssue(finding.fingerprint, gh);
    if (duplicate === 'unknown') return { ...finding, dedupe: 'unknown' };
    if (duplicate) return { ...finding, dedupe: 'duplicate', duplicate };
    return { ...finding, dedupe: 'none' };
  });
}

export function isFileable(finding: Finding): boolean {
  return (finding.priority === 'P0' || finding.priority === 'P1') && finding.dedupe === 'none';
}

/**
 * Consolidate findings with the same fingerprint from multiple sessions into a single finding
 * that includes evidence from all affected sessions.
 * Returns both the consolidated findings and a map of which original findings were consolidated.
 */
export function consolidateFindingsByFingerprint(findings: Finding[]): { consolidated: Finding[]; wasConsolidated: Map<Finding, boolean> } {
  const byFingerprint = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = finding.fingerprint;
    if (!byFingerprint.has(key)) {
      byFingerprint.set(key, []);
    }
    byFingerprint.get(key)!.push(finding);
  }

  const consolidated: Finding[] = [];
  const wasConsolidated = new Map<Finding, boolean>();
  
  for (const [, groupedFindings] of byFingerprint) {
    if (groupedFindings.length === 1) {
      consolidated.push(groupedFindings[0]);
      wasConsolidated.set(groupedFindings[0], false);
    } else {
      // Multiple findings with same fingerprint - consolidate them
      const primary = groupedFindings[0];
      const affectedSessions = groupedFindings
        .filter((f) => f.sessionId)
        .map((f) => f.sessionId!)
        .filter((s, i, arr) => arr.indexOf(s) === i); // unique sessions
      
      // Add affected sessions info to evidence
      const seen = new Set(primary.evidence);
      const secondaryEvidence = groupedFindings.slice(1).flatMap((f) => f.evidence.filter((line) => {
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      }).map((line) => (f.sessionId ? `[${f.sessionId}] ${line}` : line)));
      const consolidatedEvidence = [
        ...primary.evidence,
        ...secondaryEvidence,
        ...(affectedSessions.length > 1
          ? [`Also observed in sessions: ${affectedSessions.join(', ')}`]
          : []),
      ];
      
      const consolidatedFinding = { ...primary, evidence: consolidatedEvidence };
      consolidated.push(consolidatedFinding);
      
      // Mark all findings in this group as consolidated
      wasConsolidated.set(primary, true);
      for (let i = 1; i < groupedFindings.length; i++) {
        wasConsolidated.set(groupedFindings[i], true);
      }
    }
  }

  return { consolidated, wasConsolidated };
}

export function buildIssueDraft(finding: Finding, context: { prompt: string; version: string; selection: SessionSelection; platform: string }): { title: string; body: string } {
  const lines = [
    markerFor(finding.fingerprint),
    '',
    `**${finding.priority}** · check \`${finding.id}\` · status \`${finding.status}\``,
    '',
    '## Evidence',
    ...finding.evidence.map((line) => `- ${line}`),
    '',
    '## Derived from past failures',
    finding.sources.map((source) => `#${source}`).join(', '),
    '',
    '## Environment',
    `- omx ${context.version} on ${context.platform}`,
    `- session: ${context.selection.selected?.sessionId ?? 'none'} (${context.selection.mode}; ${context.selection.reason})`,
  ];
  if (context.prompt) lines.push('', '## Reporter note', context.prompt);
  if (finding.analysis) lines.push('', '## Analysis lane output', finding.analysis);
  lines.push('', 'Generated by `omx supervision` (Refs #4217).');
  return { title: `[supervision] ${finding.title}`, body: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Analysis lanes (spark, read-only, `$oh-my-codex:analyze`)
// ---------------------------------------------------------------------------

export const LANE_GROUPS: Record<string, CheckArea[]> = {
  'leader-and-agents': ['leader', 'agents'],
  resources: ['resource'],
  'autopilot-and-hooks': ['autopilot', 'hook', 'question'],
  'hud-roots-and-setup': ['hud', 'root', 'setup'],
};

export interface PlannedLane {
  id: string;
  findings: Finding[];
  prompt: string;
}

/** One lane per group of areas that has findings; every lane prompt is built from the same evidence bundle. */
export function planAnalysisLanes(bundle: EvidenceBundle, findings: readonly Finding[], userPrompt: string): PlannedLane[] {
  const summary = summarizeEvidence(bundle);
  return Object.entries(LANE_GROUPS)
    .map(([id, areas]) => ({ id, findings: findings.filter((finding) => areas.includes(finding.area)) }))
    .filter((lane) => lane.findings.length > 0)
    .map((lane) => ({ ...lane, prompt: buildLanePrompt(lane, userPrompt, summary) }));
}

export function buildLanePrompt(lane: { id: string; findings: readonly Finding[] }, prompt: string, evidenceSummary: string): string {
  return [
    'You are an `explore` lane: read-only investigation, never modify files.',
    'Run $oh-my-codex:analyze against the evidence bundle below and report root cause, affected code paths, and a minimal fix direction for each finding.',
    '',
    `User account of the problem: ${prompt || '(none given)'}`,
    '',
    `Lane: ${lane.id}`,
    'Findings:',
    ...lane.findings.map((finding) => {
      const findingHeader = [`- [${finding.priority}] ${finding.id} (${finding.status}) \u2014 past issues ${finding.sources.map((s) => `#${s}`).join(' ')}`];
      if (finding.sessionId) findingHeader.push(`(session: ${finding.sessionId})`);
      const indentedEvidence = finding.evidence.map((line) => `    ${line}`);
      return [findingHeader.join(' '), ...indentedEvidence].join('\n');
    }),
    '',
    'Evidence bundle:',
    evidenceSummary,
  ].join('\n');
}

export interface LaneResult {
  id: string;
  ok: boolean;
  output: string;
  error?: string;
}

export type LaneRunner = (lane: { id: string; prompt: string; model: string; cwd: string }) => Promise<LaneResult>;

const LANE_TIMEOUT_MS = 300_000;
const LANE_OUTPUT_CAP = 20_000;

/** Run one lane through `codex exec` on the spark model, read-only, prompt on stdin. */
export const codexExecLane: LaneRunner = ({ id, prompt, model, cwd }) => new Promise((resolve) => {
  let output = '';
  let stderr = '';
  let settled = false;
  const finish = (result: LaneResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const child = spawn('codex', ['exec', '--model', model, '--sandbox', 'read-only', '--skip-git-repo-check', '-C', cwd, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => {
    child.kill('SIGTERM');
    finish({ id, ok: false, output: output.slice(0, LANE_OUTPUT_CAP), error: `lane timed out after ${LANE_TIMEOUT_MS / 1000}s` });
  }, LANE_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => { if (output.length < LANE_OUTPUT_CAP) output += chunk.toString('utf-8'); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf-8'); });
  child.on('error', (error) => finish({ id, ok: false, output: '', error: `cannot start codex: ${error.message}` }));
  child.on('close', (code) => finish({ id, ok: code === 0, output: output.slice(0, LANE_OUTPUT_CAP), ...(code === 0 ? {} : { error: `codex exited with ${code}: ${stderr.trim().slice(0, 400)}` }) }));
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
});

// ---------------------------------------------------------------------------
// Snapshot collection (impure)
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function dirBytes(root: string, cap = 50_000): { bytes: number; truncated: boolean } {
  let bytes = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > cap) return { bytes, truncated: true };
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) bytes += safeSize(path);
    }
  }
  return { bytes, truncated: false };
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function clockTicksPerSecond(): number {
  try {
    const value = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf-8' }).trim());
    return Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    return 100;
  }
}

/** Cumulative CPU seconds: /proc/<pid>/stat on Linux (tick resolution), `ps -o time=` elsewhere. */
function readCpuSeconds(pid: number, ticks: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const total = Number(fields[11]) + Number(fields[12]);
    if (Number.isFinite(total)) return total / ticks;
  } catch {
    // fall through to ps
  }
  try {
    return parsePsCpuTime(execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf-8' }));
  } catch {
    return null;
  }
}

export function classifyProcess(args: string): ProcSample['kind'] | null {
  if (/(^|\s|\/)(ps|grep|rg|tmux)\s/.test(args) && !/\bhud\b.*--watch/.test(args)) return null;
  if (/\bhud\b/.test(args) && /--watch\b/.test(args) && /(?:^|[\s/'"])(?:omx(?:\.js)?|node)(?=$|[\s'"])/.test(args)) return 'hud-watch';
  if (/(?:^|[\s/'"])omx(?:\.js)?(?=$|\s)/.test(args) && !/^\S*\b(?:vim?|less|cat|tail|sed)\b/.test(args)) return 'omx';
  return null;
}

function readProcEnv(pid: number): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0')) {
      const eq = entry.indexOf('=');
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function sampleProcesses(windowSeconds: number): Promise<ProcSample[]> {
  let listing = '';
  try {
    listing = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const ticks = clockTicksPerSecond();
  const found: ProcSample[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    const args = match[4] as string;
    const kind = classifyProcess(args);
    if (!kind) continue;
    const env = readProcEnv(pid);
    let cwd: string | undefined;
    let cwdDeleted = false;
    try {
      const link = readlinkSync(`/proc/${pid}/cwd`);
      cwdDeleted = link.endsWith(' (deleted)');
      cwd = cwdDeleted ? link.slice(0, -' (deleted)'.length) : link;
    } catch {
      // not Linux or not readable
    }
    const omxRoot = env.OMX_ROOT?.trim() || env.OMX_STATE_ROOT?.trim() || undefined;
    found.push({
      pid, ppid: Number(match[2]), kind, args: args.slice(0, 300), rssKb: Number(match[3]),
      cpuSecStart: readCpuSeconds(pid, ticks), cpuSecEnd: null, cpuPct: null,
      ...(cwd ? { cwd } : {}), ...(cwdDeleted ? { cwdDeleted } : {}),
      ...(omxRoot ? { omxRoot } : {}), ...(env.OMX_SESSION_ID ? { sessionId: env.OMX_SESSION_ID } : {}),
    });
  }
  if (found.length === 0) return [];
  const startedAt = process.hrtime.bigint();
  await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000));
  const wallSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  for (const proc of found) {
    proc.cpuSecEnd = readCpuSeconds(proc.pid, ticks);
    proc.cpuPct = computeCpuPercent(proc.cpuSecStart, proc.cpuSecEnd, wallSeconds);
  }
  return found.filter((proc) => proc.cpuSecEnd !== null || isPidAlive(proc.pid));
}

function listTmuxPanes(): { panes: TmuxPaneSnapshot[]; available: boolean } {
  const format = ['#{pane_id}', '#{pane_current_command}', '#{pane_left}', '#{pane_top}', '#{pane_width}', '#{pane_height}', '#{pane_bottom}', '#{window_width}', '#{window_height}', '#{session_id}', '#{window_id}', '#{pane_dead}', '#{pane_pid}', '#{pane_start_command}', '#{pane_current_path}'].join(TMUX_PANE_FIELD_SEPARATOR);
  try {
    const output = execFileSync('tmux', ['list-panes', '-a', '-F', format], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { panes: parseTmuxPaneSnapshot(output), available: true };
  } catch {
    return { panes: [], available: false };
  }
}

function newestRollouts(sessionsRoot: string, limit: number): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const descend = (dir: string, depth: number): void => {
    if (out.length >= limit) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= limit) return;
      const path = join(dir, name);
      if (depth < 3) descend(path, depth + 1);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push({ path, mtimeMs: mtimeOf(path) });
    }
  };
  descend(sessionsRoot, 0);
  return out;
}

function rolloutCwd(path: string): string | null {
  try {
    const head = readFileSync(path, { encoding: 'utf-8', flag: 'r' }).slice(0, 8192).split('\n', 1)[0] ?? '';
    const payload = (JSON.parse(head) as { payload?: { cwd?: unknown } }).payload;
    return typeof payload?.cwd === 'string' ? payload.cwd : null;
  } catch {
    return null;
  }
}

function readCandidate(cwd: string, omxRoot: string | undefined, rolloutMtimeMs: number | null, source: string): SessionCandidate | null {
  const stateDir = omxRoot ? stateDirForRoot(omxRoot) : getBaseStateDir(cwd, {});
  const sessionPath = join(stateDir, 'session.json');
  const raw = readJson(sessionPath);
  if (!raw || typeof raw.session_id !== 'string') return null;
  const pid = typeof raw.pid === 'number' ? raw.pid : undefined;
  return {
    sessionId: raw.session_id,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : cwd,
    stateDir,
    ...(typeof raw.started_at === 'string' ? { startedAt: raw.started_at } : {}),
    ...(pid !== undefined ? { pid } : {}),
    pidAlive: pid !== undefined && isPidAlive(pid),
    ...(typeof raw.tmux_pane_id === 'string' ? { tmuxPaneId: raw.tmux_pane_id } : {}),
    ...(typeof raw.codex_session_id === 'string' ? { codexSessionId: raw.codex_session_id } : typeof raw.native_session_id === 'string' ? { codexSessionId: raw.native_session_id } : {}),
    stateMtimeMs: mtimeOf(sessionPath),
    rolloutMtimeMs,
    sources: [source],
  };
}

function discoverCandidates(cwd: string, processes: readonly ProcSample[], panes: readonly TmuxPaneSnapshot[]): SessionCandidate[] {
  const byId = new Map<string, SessionCandidate>();
  const add = (candidate: SessionCandidate | null) => {
    if (!candidate) return;
    const existing = byId.get(candidate.sessionId);
    if (existing) existing.sources.push(...candidate.sources);
    else byId.set(candidate.sessionId, candidate);
  };
  add(readCandidate(cwd, undefined, null, 'supervision cwd'));
  for (const proc of processes) {
    if (proc.cwd) add(readCandidate(proc.cwd, proc.omxRoot, null, `${proc.kind} pid ${proc.pid}`));
  }
  for (const pane of panes) {
    if (pane.currentPath && isHudWatchPane(pane)) add(readCandidate(pane.currentPath, undefined, null, `HUD pane ${pane.paneId}`));
  }
  const rollouts = newestRollouts(join(codexHome(), 'sessions'), 12);
  for (const rollout of rollouts) {
    const rolloutDir = rolloutCwd(rollout.path);
    if (rolloutDir) add(readCandidate(rolloutDir, undefined, rollout.mtimeMs, `rollout ${rollout.path.split('/').pop()}`));
  }
  return [...byId.values()];
}

export function collectStateFiles(stateDir: string, sessionId: string): ModeStateRecord[] {
  const records: ModeStateRecord[] = [];
  // Read only session-scoped state, like the HUD reader does (not root compatibility records).
  let names: string[];
  try {
    names = readdirSync(join(stateDir, 'sessions', sessionId));
  } catch {
    return records;
  }
  for (const name of names) {
    if (!name.endsWith('-state.json')) continue;
    const path = join(stateDir, 'sessions', sessionId, name);
    const data = readJson(path);
    if (data) records.push({ mode: name.slice(0, -'-state.json'.length), scope: 'session', path, mtimeMs: mtimeOf(path), data });
  }
  return records;
}

export async function readHudModel(cwd: string, stateDir?: string, sessionId?: string): Promise<SupervisionSnapshot['hud']> {
  try {
    // Explicit state root + session: apply the HUD's projection rules without consulting process env.
    if (stateDir && sessionId) {
      const canonicalSkills = new Map(
        listActiveSkills(await readVisibleSkillActiveStateForStateDir(stateDir, sessionId)).map((entry) => [entry.skill, entry] as const),
      );
      const detail = (mode: string) => readJson(join(stateDir, 'sessions', sessionId, `${mode}-state.json`)) as { active?: boolean; current_phase?: string; team_name?: string } | null;
      // Same source as readAllState's readCanonicalTeamPhase, but rooted at the candidate's state dir.
      const teamDetail = detail('team');
      const teamName = teamDetail?.active === true && typeof teamDetail.team_name === 'string' ? teamDetail.team_name.trim() : '';
      const teamPhase = teamName && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(teamName) ? readJson(join(stateDir, 'team', teamName, 'phase.json'))?.current_phase : undefined;
      const canonicalTeamPhase = typeof teamPhase === 'string' && teamPhase.trim() ? teamPhase.trim() : undefined;
      return projectHudModes(canonicalSkills, {
        ralph: detail('ralph'), ultrawork: detail('ultrawork'), autopilot: detail('autopilot'), ralplan: detail('ralplan'),
        deepInterview: detail('deep-interview'), autoresearch: detail('autoresearch'), ultraqa: detail('ultraqa'), team: detail('team'),
      }, readJson(join(stateDir, 'current-autopilot.json')), canonicalTeamPhase);
    }
    // Fallback to reading from full HudRenderContext
    const hud = await readAllState(cwd);
    const modes: Record<string, { phase?: string }> = {};
    for (const key of ['ralph', 'ultrawork', 'autopilot', 'ralplan', 'deepInterview', 'autoresearch', 'ultraqa', 'team'] as const) {
      const value = hud[key] as { current_phase?: string } | null;
      if (value) modes[key] = value.current_phase ? { phase: value.current_phase } : {};
    }
    return { modes, staleAutopilot: hud.staleAutopilot != null };
  } catch {
    return null;
  }
}

async function collectCanonicalSkills(stateDir: string, sessionId: string): Promise<Array<{ skill: string; phase?: string }>> {
  try {
    return listActiveSkills(await readVisibleSkillActiveStateForStateDir(stateDir, sessionId)).map((entry) => ({
      skill: entry.skill,
      ...(typeof entry.phase === 'string' && entry.phase ? { phase: entry.phase } : {}),
    }));
  } catch {
    return [];
  }
}

function collectTeamPhases(stateDir: string): SupervisionSnapshot['state']['teamPhases'] {
  const out: SupervisionSnapshot['state']['teamPhases'] = [];
  let names: string[] = [];
  try {
    names = readdirSync(join(stateDir, 'team'));
  } catch {
    return out;
  }
  for (const name of names.slice(0, 50)) {
    const path = join(stateDir, 'team', name, 'phase.json');
    const data = readJson(path);
    if (!data) continue;
    const raw = Array.isArray(data.transitions) ? data.transitions : [];
    out.push({
      path,
      ...(typeof data.current_phase === 'string' ? { currentPhase: data.current_phase } : {}),
      transitions: raw.flatMap((entry) => {
        const t = entry as { from?: unknown; to?: unknown };
        return typeof t.from === 'string' && typeof t.to === 'string' ? [{ from: t.from, to: t.to }] : [];
      }),
    });
  }
  return out;
}

export async function collectEvidence(options: SupervisionOptions, cwd: string): Promise<EvidenceBundle> {
  const [processes, tmux] = await Promise.all([sampleProcesses(options.windowSeconds), Promise.resolve(listTmuxPanes())]);
  const snapshots = await collectSnapshotsForAllActiveSessions(options, cwd, processes, tmux);
  const primarySnapshot = Array.from(snapshots.values())[0] ?? (await collectSnapshot(options, cwd));
  const bundle = toEvidenceBundle(primarySnapshot);
  bundle.snapshots = snapshots;
  return bundle;
}

export async function collectSnapshotForSession(options: SupervisionOptions, invokingCwd: string, processes: readonly ProcSample[], tmux: { panes: TmuxPaneSnapshot[]; available: boolean }, selection: SessionSelection): Promise<SupervisionSnapshot> {
  const selected = selection.selected;
  // Sessions may belong to different projects: diagnostics follow the session's own cwd.
  const cwd = selected?.cwd ?? invokingCwd;
  const stateDir = selected?.stateDir ?? null;
  const nowMs = Date.now();

  const logsDir = stateDir ? join(stateDir, '..', 'logs') : null;
  const stateSize = stateDir ? dirBytes(stateDir) : { bytes: 0, truncated: false };
  const logsSize = logsDir ? dirBytes(logsDir) : { bytes: 0, truncated: false };
  const rolloutSize = dirBytes(join(codexHome(), 'sessions'));

  let hookLog: SupervisionSnapshot['state']['hookLog'] = null;
  if (logsDir) {
    const path = join(logsDir, `native-hook-${new Date(nowMs).toISOString().slice(0, 10)}.jsonl`);
    if (existsSync(path)) {
      const samples: string[] = [];
      let dispatchErrors = 0;
      for (const line of readFileSync(path, 'utf-8').split('\n')) {
        if (!/native_hook_dispatch_error|invalid[ _-]json/i.test(line)) continue;
        dispatchErrors += 1;
        if (samples.length < 3) samples.push(line.slice(0, 200));
      }
      hookLog = { path, dispatchErrors, samples };
    }
  }

  const supportBlockers: Array<{ file: string; data: Record<string, unknown> }> = [];
  if (stateDir) {
    for (const file of ['native-subagent-support.json', 'native-subagent-capacity-blocker.json']) {
      const data = readJson(join(stateDir, file));
      if (data) supportBlockers.push({ file: join(stateDir, file), data });
    }
  }

  let nativeAgents: DoctorCheckResult | null = null;
  let pluginVersions: DoctorCheckResult | null = null;
  try {
    const scope = await resolveDoctorScope(cwd);
    const paths = resolveDoctorPaths(cwd, scope.scope);
    const [agents, plugin] = await Promise.all([checkNativeAgentConfigDrift(paths, cwd), checkPluginVersionDiagnostics(paths.codexHomeDir)]);
    nativeAgents = { status: agents.status, message: agents.message };
    pluginVersions = { status: plugin.status, message: plugin.message };
  } catch {
    // doctor reuse is best-effort; checks degrade to "unavailable".
  }

  let friction: SupervisionSnapshot['friction'] = [];
  if (selected?.codexSessionId) {
    try {
      const report = await buildSessionFrictionReport({ session: selected.codexSessionId, limit: 1, cwd });
      friction = (report.sessions[0]?.risks ?? []).map((risk) => ({ code: risk.code, severity: risk.severity, message: risk.message }));
    } catch {
      friction = [];
    }
  }

  return {
    takenAt: new Date(nowMs).toISOString(),
    nowMs,
    windowSeconds: options.windowSeconds,
    platform: process.platform,
    selection,
    processes: [...processes],
    panes: tmux.panes,
    tmuxAvailable: tmux.available,
    state: {
      stateDir,
      modes: selected && stateDir ? collectStateFiles(stateDir, selected.sessionId) : [],
      currentAutopilot: stateDir ? readJson(join(stateDir, 'current-autopilot.json')) : null,
      nativeStop: stateDir ? readJson(join(stateDir, 'native-stop-state.json')) : null,
      supportBlockers,
      canonicalSkills: stateDir && selected ? await collectCanonicalSkills(stateDir, selected.sessionId) : [],
      teamPhases: stateDir ? collectTeamPhases(stateDir) : [],
      subagentTracking: stateDir ? (readJson(join(stateDir, 'subagent-tracking.json')) as SubagentTrackingState | null) : null,
      sizes: { stateBytes: stateSize.bytes, logsBytes: logsSize.bytes, rolloutBytes: rolloutSize.bytes, rolloutScanTruncated: rolloutSize.truncated },
      hookLog,
    },
    hud: selected && stateDir ? await readHudModel(selected.cwd, stateDir, selected.sessionId) : (selected ? await readHudModel(selected.cwd) : null),
    doctor: { nativeAgents, pluginVersions },
    friction,
  };
}

export async function collectSnapshot(options: SupervisionOptions, cwd: string): Promise<SupervisionSnapshot> {
  const [processes, tmux] = await Promise.all([sampleProcesses(options.windowSeconds), Promise.resolve(listTmuxPanes())]);
  const candidates = discoverCandidates(cwd, processes, tmux.panes);
  const selection = selectSession(candidates);
  return collectSnapshotForSession(options, cwd, processes, tmux, selection);
}

// Helper to create snapshots for all active sessions (for multi-session reporting)
async function collectSnapshotsForAllActiveSessions(options: SupervisionOptions, cwd: string, processes: readonly ProcSample[], tmux: { panes: TmuxPaneSnapshot[]; available: boolean }): Promise<Map<string, SupervisionSnapshot>> {
  const candidates = discoverCandidates(cwd, processes, tmux.panes);
  const selection = selectSession(candidates);
  const snapshots = new Map<string, SupervisionSnapshot>();
  
  // Create snapshots for all active sessions
  const activeCandidates = selection.candidates.filter((c) => c.pidAlive);
  for (const sessionCandidate of activeCandidates) {
    const sessionSelection = { selected: sessionCandidate, mode: 'active' as const, reason: `session ${sessionCandidate.sessionId}`, candidates: selection.candidates };
    const snapshot = await collectSnapshotForSession(options, cwd, processes, tmux, sessionSelection);
    snapshots.set(sessionCandidate.sessionId, snapshot);
  }
  
  // If no active sessions, include the fallback (most recent)
  if (snapshots.size === 0 && selection.selected) {
    const snapshot = await collectSnapshotForSession(options, cwd, processes, tmux, selection);
    snapshots.set(selection.selected.sessionId, snapshot);
  }
  
  return snapshots;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface SupervisionReport {
  generatedAt: string;
  prompt: string;
  session: { mode: SessionSelection['mode']; reason: string; sessionId: string | null; cwd: string | null; fallback: boolean };
  windowSeconds: number;
  checks: CheckResult[];
  findings: Finding[];
  lanes: LaneResult[];
  filed: Array<{ fingerprint: string; url: string }>;
  fileSkipped: Array<{ fingerprint: string; reason: string }>;
  outputDir: string | null;
  friction: SupervisionSnapshot['friction'];
}

export function renderReportMarkdown(report: SupervisionReport): string {
  const lines = [
    `# omx supervision report — ${report.generatedAt}`,
    '',
    `Generated by \`omx supervision\` (Refs #4217). Paste this file into the issue as is.`,
    '',
    `Session: ${report.session.sessionId ?? 'none'} (${report.session.mode})`,
    `Selection: ${report.session.reason}`,
    ...(report.session.fallback ? ['**No active session — this report covers the most recent session, not a live one.**'] : []),
    ...(report.prompt ? ['', `User account: ${report.prompt}`] : []),
    '',
    '## Checks',
    ...report.checks.map((check) => {
      const isSecondary = check.sessionId && check.sessionId !== report.session.sessionId;
      const sessionAttr = isSecondary ? ` (session: ${check.sessionId})` : '';
      return `- ${check.status.toUpperCase().padEnd(4)} \`${check.id}\`${sessionAttr} — ${(check.evidence[0] ?? '').slice(0, 160)}`;
    }),
    '',
    '## Findings',
    ...(report.findings.length === 0 ? ['None.'] : report.findings.flatMap((finding) => {
      const isSecondary = finding.sessionId && finding.sessionId !== report.session.sessionId;
      const sessionAttr = isSecondary ? `\n- session: ${finding.sessionId}` : '';
      return [
        `### ${finding.priority} \`${finding.id}\` (${finding.status}, score ${finding.score})`,
        finding.title,
        ...finding.evidence.map((line) => `- ${line}`),
        `- past issues: ${finding.sources.map((s) => `#${s}`).join(', ')}`,
        `- fingerprint: ${finding.fingerprint} (${finding.dedupe}${finding.duplicate ? `: ${finding.duplicate.url}` : ''})${sessionAttr}`,
        '',
      ];
    })),
  ];
  if (report.lanes.length > 0) {
    lines.push('## Analysis lanes');
    for (const lane of report.lanes) lines.push(`### ${lane.id} (${lane.ok ? 'ok' : 'failed'})`, lane.ok ? lane.output : `error: ${lane.error ?? 'unknown'}\n${lane.output}`, '');
  }
  if (report.filed.length > 0) lines.push('## Filed issues', ...report.filed.map((item) => `- ${item.fingerprint}: ${item.url}`), '');
  if (report.fileSkipped.length > 0) lines.push('## Not filed', ...report.fileSkipped.map((item) => `- ${item.fingerprint}: ${item.reason}`), '');
  return lines.join('\n');
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export interface SupervisionDeps {
  collect: (options: SupervisionOptions, cwd: string) => Promise<EvidenceBundle>;
  gh: GhRunner;
  lane: LaneRunner;
  sparkModel: () => string;
  version: () => string;
  now: () => Date;
  /** check id -> past issue/PR numbers; defaults to @iqdoctor's history fixture. */
  history?: RepeatProblemHistory;
}

export const defaultSupervisionDeps: SupervisionDeps = {
  collect: collectEvidence,
  gh: defaultGhRunner,
  lane: codexExecLane,
  sparkModel: () => getSparkDefaultModel(),
  version: () => readVersion() ?? 'unknown',
  now: () => new Date(),
};

export async function runSupervision(options: SupervisionOptions, cwd: string, deps: SupervisionDeps = defaultSupervisionDeps): Promise<SupervisionReport> {
  const evidence = await deps.collect(options, cwd);
  const snapshot = evidence.snapshot;
  
  // Collect findings from all active sessions
  let allChecks: CheckResult[] = [];
  const snapshots = (evidence.snapshots && evidence.snapshots.size > 0) ? evidence.snapshots : new Map([[snapshot.selection.selected?.sessionId ?? 'default', snapshot]]);
  
  for (const [sessionId, sessionSnapshot] of snapshots) {
    const sessionChecks = evaluateChecks(sessionSnapshot, SUPERVISION_CHECKS, deps.history ?? IQDOCTOR_HISTORY);
    // Tag each check result with the session ID
    for (const check of sessionChecks) {
      check.sessionId = sessionId;
    }
    allChecks.push(...sessionChecks);
  }
  const checks = allChecks;
  
  let findings = triage(allChecks);
  const lanes: LaneResult[] = [];

  if (options.analyze && findings.length > 0) {
    const model = deps.sparkModel();
    const groups = planAnalysisLanes(evidence, findings, options.prompt);
    const results = await Promise.all(groups.map((lane) => deps.lane({ id: lane.id, prompt: lane.prompt, model, cwd })));
    lanes.push(...results);
    findings = findings.map((finding) => {
      const lane = groups.find((group) => group.findings.some((entry) => entry.id === finding.id));
      const result = lane && results.find((entry) => entry.id === lane.id);
      return result?.ok ? { ...finding, analysis: result.output.trim() } : finding;
    });
  }

  findings = applyDedupe(findings, deps.gh);

  const generatedAt = deps.now();
  const selected = snapshot.selection.selected;
  const outputDir = join(cwd, '.omx', 'supervision', timestampSlug(generatedAt));
  const report: SupervisionReport = {
    generatedAt: generatedAt.toISOString(),
    prompt: options.prompt,
    session: { mode: snapshot.selection.mode, reason: snapshot.selection.reason, sessionId: selected?.sessionId ?? null, cwd: selected?.cwd ?? null, fallback: snapshot.selection.mode === 'fallback-recent' },
    windowSeconds: options.windowSeconds,
    checks,
    findings,
    lanes,
    filed: [],
    fileSkipped: [],
    outputDir,
    friction: snapshot.friction,
  };

  const context = { prompt: options.prompt, version: deps.version(), selection: snapshot.selection, platform: snapshot.platform };
  await mkdir(join(outputDir, 'drafts'), { recursive: true });
  await mkdir(join(outputDir, 'evidence'), { recursive: true });
  // Convert evidence bundle to serializable format (Maps become objects)
  const serializableEvidence = { ...evidence, snapshots: evidence.snapshots ? Object.fromEntries(evidence.snapshots) : undefined };
  await writeFile(join(outputDir, 'evidence', 'bundle.json'), `${JSON.stringify(serializableEvidence, null, 2)}\n`);
  const drafts = findings.map((finding) => {
    const own = finding.sessionId ? snapshots.get(finding.sessionId) : undefined;
    return { finding, draft: buildIssueDraft(finding, own ? { ...context, selection: own.selection } : context) };
  });
  for (const { finding, draft } of drafts) {
    await writeFile(join(outputDir, 'drafts', `${[finding.priority, finding.id, finding.fingerprint, finding.sessionId].filter(Boolean).join('-')}.md`), `# ${draft.title}\n\n${draft.body}\n`);
  }

  if (options.file) {
    // Consolidate same-fingerprint findings for filing to avoid duplicate issues
    const fileableFindings = findings.filter((f) => f.priority === 'P0' || f.priority === 'P1');
    const { consolidated: consolidatedForFiling } = consolidateFindingsByFingerprint(fileableFindings);
    const consolidatedDrafts = consolidatedForFiling.map((finding) => {
      // Use primary session's context if available, otherwise fall back to default context
      const own = finding.sessionId ? snapshots.get(finding.sessionId) : undefined;
      return { finding, draft: buildIssueDraft(finding, own ? { ...context, selection: own.selection } : context) };
    });
    
    // Track which fingerprints were filed successfully
    const filed = new Set<string>();
    
    // Process consolidated findings for filing
    for (const { finding, draft } of consolidatedDrafts) {
      if (finding.dedupe === 'duplicate') {
        report.fileSkipped.push({ fingerprint: finding.fingerprint, reason: `duplicate of ${finding.duplicate?.url}` });
      } else if (finding.dedupe === 'unknown') {
        report.fileSkipped.push({ fingerprint: finding.fingerprint, reason: 'duplicate search failed; not filing blind' });
      } else {
        try {
          const url = deps.gh(['issue', 'create', '-R', SUPERVISION_REPO, '--title', draft.title, '--body-file', '-'], draft.body).trim();
          report.filed.push({ fingerprint: finding.fingerprint, url });
          filed.add(finding.fingerprint);
        } catch (error) {
          report.fileSkipped.push({ fingerprint: finding.fingerprint, reason: `gh issue create failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` });
        }
      }
    }
    
    // Mark consolidated findings that weren't the primary as "already filed"
    // Group original findings by fingerprint to find non-primary ones
    const byFingerprint = new Map<string, Finding[]>();
    for (const finding of fileableFindings) {
      if (!byFingerprint.has(finding.fingerprint)) {
        byFingerprint.set(finding.fingerprint, []);
      }
      byFingerprint.get(finding.fingerprint)!.push(finding);
    }
    
    // For each fingerprint that was filed, mark all non-primary findings as already filed
    for (const [fingerprint, findingsForFp] of byFingerprint) {
      if (filed.has(fingerprint) && findingsForFp.length > 1) {
        // Mark all findings except the first one as already filed
        for (let i = 1; i < findingsForFp.length; i++) {
          report.fileSkipped.push({ fingerprint, reason: 'already filed in this run (same fingerprint from another session)' });
        }
      }
    }
  }

  await writeFile(join(outputDir, 'report.md'), renderReportMarkdown(report));
  await writeFile(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function supervisionCommand(args: string[]): Promise<void> {
  if (args[0] === 'codex-review-loop') return codexReviewLoopCommand(args.slice(1));
  const options = parseSupervisionArgs(args);
  if (options.help) {
    console.log(SUPERVISION_HELP);
    return;
  }
  const report = await runSupervision(options, process.cwd());
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReportMarkdown(report) + (report.outputDir ? `\nReport written to ${report.outputDir}\n` : ''));
  if (report.checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}
