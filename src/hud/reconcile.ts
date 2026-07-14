import { mkdir } from 'node:fs/promises';

import { acquireHudLifecycleLock, releaseHudLifecycleLock, type HudLifecycleLockDeps } from './lifecycle-lock.js';
import { resolveHudControlPlaneDomain, type ResolvedHudControlPlaneDomain } from '../mcp/state-paths.js';
import { probeActualTmuxInstanceEvidence, tmuxEvidenceBindsCandidate, type ActualTmuxInstanceEvidence } from '../scripts/notify-hook/managed-tmux.js';

import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES, isTmuxWindowTooCrampedForHudSplit } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  isHudWatchPane,
  killTmuxPane,
  listCurrentWindowPanes,
  readCurrentWindowSize,
  readHudPaneOwner,
  hudPaneMatchesOwner,
  hudPaneMatchesExactCandidate,
  registerHudResizeHook,
  unregisterHudResizeHook,
  resizeTmuxPane,
  type HudPaneOwner,
  type TmuxPaneSnapshot,
} from './tmux.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';

function isExplicitOmxOwnedTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_TMUX_HUD_OWNER_ENV] === '1';
}

/**
 * Kill HUD watch panes that belong to the *current* session but whose owning
 * leader pane is no longer alive in this window.
 *
 * When a leader pane is destroyed (e.g. during a `team` setup/teardown cycle that
 * tears down the leader REPL pane), its owner-tagged HUD panes are left pointing at
 * the dead leader id. They are matched by neither `findHudWatchPaneIds` — whose
 * owner check requires the recorded leader to equal the current pane — nor
 * `findLegacyFocusedHudWatchPaneIds`, which only adopts HUD panes that *lack* owner
 * metadata. So the reconcile below sees "no HUD", recreates one, and repeats on
 * every prompt submit until the window degenerates into a column of stacked HUD
 * strips with no leader or worker panes left.
 *
 * The reap is intentionally scoped to the current session: HUD panes owned by other
 * sessions (whose leader may legitimately live in a different tmux window we cannot
 * see from this window's pane list) are never touched.
 */
function reapOrphanedSessionHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    sessionId: string | undefined;
    sessionIds?: string[];
    currentPaneId: string | undefined;
    killPane: (paneId: string) => boolean;
  },
): string[] {
  const { sessionId, currentPaneId, killPane } = opts;
  const sameSessionIds = new Set(
    [sessionId, ...(opts.sessionIds ?? [])]
      .map((candidate) => candidate?.trim() ?? '')
      .filter((candidate) => candidate !== ''),
  );
  if (sameSessionIds.size === 0) return [];
  // A recorded leader only counts as "live" if it exists in this window AND is not
  // itself a HUD watcher. Without the HUD exclusion, an orphan whose recorded leader
  // is *another HUD pane* would be preserved here; that referenced HUD could be
  // reaped on a later iteration, leaving a dangling orphan that still never matches
  // the real current pane — so the all-HUD-strip state is only partially cleaned.
  const liveNonHudPaneIds = new Set(
    panes.filter((pane) => !isHudWatchPane(pane)).map((pane) => pane.paneId),
  );
  const reaped: string[] = [];
  for (const pane of panes) {
    if (!isHudWatchPane(pane)) continue;
    const owner = readHudPaneOwner(pane);
    // Only reclaim HUDs that explicitly belong to this session and name a leader.
    if (!owner.sessionId || !sameSessionIds.has(owner.sessionId) || !owner.leaderPaneId) continue;
    if (!hasVerifiedHudPaneInstanceIdentity(pane, sameSessionIds)) continue;
    // Keep HUDs whose leader is the current pane or another live non-HUD leader pane.
    if (owner.leaderPaneId === currentPaneId || liveNonHudPaneIds.has(owner.leaderPaneId)) continue;
    if (killPane(pane.paneId)) reaped.push(pane.paneId);
  }
  return reaped;
}

function hasExplicitHudOwnerMarker(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return new RegExp(`(?:^|\\s)${OMX_TMUX_HUD_OWNER_ENV}=(?:'1'|1)(?=$|\\s)`).test(command);
}

function reapStaleCurrentLeaderHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    sessionIds: string[];
    currentPaneId: string | undefined;
    killPane: (paneId: string) => boolean;
  },
): string[] {
  const { currentPaneId, killPane } = opts;
  if (!currentPaneId) return [];
  const currentSessionIds = new Set(opts.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean));
  if (currentSessionIds.size === 0) return [];

  const reaped: string[] = [];
  for (const pane of panes) {
    if (!isHudWatchPane(pane)) continue;
    const owner = readHudPaneOwner(pane);
    if (owner.leaderPaneId !== currentPaneId) continue;
    if (!hasExplicitHudOwnerMarker(pane)) continue;
    if (!owner.sessionId || currentSessionIds.has(owner.sessionId)) continue;
    if (!hasVerifiedHudPaneInstanceIdentity(pane, currentSessionIds)) continue;
    if (killPane(pane.paneId)) reaped.push(pane.paneId);
  }
  return reaped;
}

export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
    | 'skipped_not_omx_owned_tmux'
    | 'skipped_no_session_id'
    | 'skipped_window_too_cramped'
    | 'unchanged'
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'skipped_concurrent'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  sessionIds?: string[];
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string; instanceId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (
    hudPaneId: string,
    leaderPaneId: string | undefined,
    heightLines: number,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => boolean;
  unregisterHudResizeHook?: (leaderPaneId: string | undefined) => boolean;
  readCurrentWindowSize?: (currentPaneId?: string) => { width: number | null; height: number | null };
  nowMs?: () => number;
  isProcessLive?: (pid: number) => boolean | null;
  resolveDomain?: (options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    requestedSessionId?: string;
  }) => Promise<ResolvedHudControlPlaneDomain>;
  lifecycleLockDeps?: HudLifecycleLockDeps;
  probeTmuxInstance?: (paneId?: string) => Promise<ActualTmuxInstanceEvidence>;

}

function ensureHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  desiredHeight: number,
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps,
): void {
  try {
    (deps.registerHudResizeHook ?? registerHudResizeHook)(hudPaneId, leaderPaneId, desiredHeight, {
      cwd,
      env: deps.env ?? process.env,
    });
  } catch {
    // Non-critical — hook registration failure does not break HUD lifecycle.
  }
}

function hasCompleteGeometry(pane: TmuxPaneSnapshot): boolean {
  return (
    typeof pane.paneLeft === 'number'
    && typeof pane.paneWidth === 'number'
    && typeof pane.paneBottom === 'number'
    && typeof pane.windowWidth === 'number'
    && typeof pane.windowHeight === 'number'
  );
}

function needsHudTopologyRecreate(pane: TmuxPaneSnapshot, leaderPane?: TmuxPaneSnapshot): boolean {
  if (!hasCompleteGeometry(pane)) return false;
  const expectedLeft = typeof leaderPane?.paneLeft === 'number' ? leaderPane.paneLeft : 0;
  const expectedWidth = typeof leaderPane?.paneWidth === 'number' ? leaderPane.paneWidth : pane.windowWidth;
  const spansExpectedWidth = pane.paneLeft === expectedLeft && pane.paneWidth === expectedWidth;
  const touchesWindowBottom = pane.paneBottom === (pane.windowHeight ?? 0) - 1;
  return !spansExpectedWidth || !touchesWindowBottom;
}

function shouldCreateFullWidthHud(leaderPane?: TmuxPaneSnapshot): boolean {
  return Boolean(
    leaderPane
    && typeof leaderPane.paneLeft === 'number'
    && typeof leaderPane.paneWidth === 'number'
    && typeof leaderPane.windowWidth === 'number'
    && leaderPane.paneLeft === 0
    && leaderPane.paneWidth === leaderPane.windowWidth,
  );
}

function needsHudHeightResize(pane: TmuxPaneSnapshot, desiredHeight: number): boolean {
  return typeof pane.paneHeight !== 'number' || pane.paneHeight !== desiredHeight;
}

function hasVerifiedHudPaneInstanceIdentity(
  pane: TmuxPaneSnapshot,
  equivalentSessionIds: ReadonlySet<string>,
): boolean {
  const paneInstanceId = pane.paneInstanceId?.trim();
  const sessionInstanceId = pane.sessionInstanceId?.trim();
  return Boolean(
    paneInstanceId
    && sessionInstanceId
    && equivalentSessionIds.has(paneInstanceId)
    && equivalentSessionIds.has(sessionInstanceId),
  );
}

function planOwnedHudPaneDedupe(
  panes: TmuxPaneSnapshot[],
  currentPaneId: string | undefined,
  owner: HudPaneOwner,
  preferredPaneId: string,
  equivalentSessionIds: ReadonlySet<string>,
): { paneId: string; duplicatePaneIds: string[]; unsafeCandidate: boolean } {
  const ownedPanes = panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner));
  if (ownedPanes.some((pane) => !hasVerifiedHudPaneInstanceIdentity(pane, equivalentSessionIds))) {
    return { paneId: preferredPaneId, duplicatePaneIds: [], unsafeCandidate: true };
  }
  const ownedPaneIds = ownedPanes.map((pane) => pane.paneId);
  const keeperPaneId = ownedPaneIds.includes(preferredPaneId)
    ? preferredPaneId
    : (ownedPaneIds[0] ?? preferredPaneId);

  return {
    paneId: keeperPaneId,
    duplicatePaneIds: ownedPaneIds.filter((paneId) => paneId !== keeperPaneId),
    unsafeCandidate: false,
  };
}

const HUD_RECONCILE_LOCK_STALE_MS = 10_000;

function isVerifiedManagedHudOwner(
  domain: ResolvedHudControlPlaneDomain,
  currentPaneId: string | undefined,
  evidence: ActualTmuxInstanceEvidence,
): boolean {
  const equivalentSessionIds = new Set(
    [domain.session?.canonicalId, ...(domain.session?.equivalentIds ?? [])]
      .map((sessionId) => sessionId?.trim() ?? '')
      .filter(Boolean),
  );
  return Boolean(
    domain.managed
    && currentPaneId
    && evidence.paneTarget === currentPaneId
    && domain.claimant.leaderPaneId === currentPaneId
    && domain.claimant.tmuxSessionName
    && domain.claimant.tmuxSessionName === evidence.sessionName
    && [...equivalentSessionIds].some((sessionId) => tmuxEvidenceBindsCandidate(evidence, sessionId)),
  );
}

function lifecycleLockDepsForReconcile(deps: ReconcileHudForPromptSubmitDeps): HudLifecycleLockDeps {
  if (!deps.isProcessLive) return deps.lifecycleLockDeps ?? {};
  return {
    ...deps.lifecycleLockDeps,
    probeProcess: deps.lifecycleLockDeps?.probeProcess ?? (async (owner) => {
      const live = deps.isProcessLive?.(owner.pid);
      return live === true ? 'live' : live === false ? 'dead' : 'uncertain';
    }),
  };
}


export async function reconcileHudForPromptSubmit(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<ReconcileHudForPromptSubmitResult> {
  const env = deps.env ?? process.env;
  if (!env.TMUX) {
    return {
      status: 'skipped_not_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  if (!isExplicitOmxOwnedTmuxEnv(env)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const currentPaneId = env.TMUX_PANE?.trim();
  const requestedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  if (!requestedSessionId) {
    return {
      status: 'skipped_no_session_id',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const domainEnv: NodeJS.ProcessEnv = {
    ...env,
    TMUX_PANE: undefined,
    TMUX_SESSION: undefined,
  };
  const domain = await (deps.resolveDomain ?? resolveHudControlPlaneDomain)({
    cwd,
    env: domainEnv,
    requestedSessionId,
  }).catch(() => null);
  const evidence = domain && currentPaneId
    ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
    : null;
  if (!domain || !evidence || !isVerifiedManagedHudOwner(domain, currentPaneId, evidence)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const resolveOmxCliEntryPathFn = deps.resolveOmxCliEntryPath ?? resolveOmxCliEntryPath;
  const omxBin = resolveOmxCliEntryPathFn();
  if (!omxBin) {
    return {
      status: 'skipped_no_entry',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const lockDirReady = await mkdir(domain.baseStateDir, { recursive: true }).then(() => true).catch(() => false);
  const acquired = lockDirReady
    ? await acquireHudLifecycleLock(
      { path: domain.reconcileLockPath, domainKey: domain.domainKey, staleMs: HUD_RECONCILE_LOCK_STALE_MS },
      {
        ...lifecycleLockDepsForReconcile(deps),
        nowMs: deps.lifecycleLockDeps?.nowMs ?? deps.nowMs ?? (() => Date.now()),
      },
    )
    : { status: 'failed' as const };
  if (acquired.status !== 'acquired' || !acquired.lock) {
    return {
      status: 'skipped_concurrent',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const listPanes = deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId));
  const createPane = deps.createHudWatchPane ?? ((hudCwd, hudCmd, options) => createHudWatchPane(hudCwd, hudCmd, options));
  const killPane = deps.killTmuxPane ?? ((paneId) => killTmuxPane(paneId));
  const resizePane = deps.resizeTmuxPane ?? ((paneId, lines) => resizeTmuxPane(paneId, lines));
  const lock = acquired.lock;
  const resolvedSessionId = domain.session?.canonicalId;
  const equivalentSessionIds = domain.session?.equivalentIds ?? [];
  try {

  let panes = listPanes(currentPaneId);

  // Reclaim orphaned HUD panes left behind by a destroyed leader before deciding
  // whether a HUD already exists; otherwise dead-leader HUDs accumulate one per
  // prompt submit and the window fills with stacked HUD strips.
  const reapedOrphanPaneIds = reapOrphanedSessionHudPanes(panes, {
    sessionId: resolvedSessionId,
    sessionIds: equivalentSessionIds,
    currentPaneId,
    killPane,
  });
  if (reapedOrphanPaneIds.length > 0) {
    const reapedPaneIdSet = new Set(reapedOrphanPaneIds);
    panes = panes.filter((pane) => !reapedPaneIdSet.has(pane.paneId));
  }

  // A Codex self-update can restart/resume the leader in the same tmux pane with
  // a new OMX session id while the old HUD watcher stays alive. That stale HUD
  // still names the current leader pane, but with the previous session id, so it
  // does not match same-owner dedupe and the next launch would create a second HUD
  // beside it. Reap only HUDs tied to this exact leader pane; neighboring panes'
  // HUDs remain isolated by leaderPaneId.
  const reapedStaleLeaderPaneIds = reapStaleCurrentLeaderHudPanes(panes, {
    sessionIds: equivalentSessionIds,
    currentPaneId,
    killPane,
  });
  if (reapedStaleLeaderPaneIds.length > 0) {
    const reapedPaneIdSet = new Set(reapedStaleLeaderPaneIds);
    panes = panes.filter((pane) => !reapedPaneIdSet.has(pane.paneId));
  }

  const equivalentSessionIdSet = new Set(
    [resolvedSessionId, ...equivalentSessionIds].map((sessionId) => sessionId?.trim() ?? '').filter(Boolean),
  );
  const owner = {
    sessionId: resolvedSessionId,
    sessionIds: equivalentSessionIds,
    leaderPaneId: currentPaneId,
  };
  const ownedHudPanes = panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner));
  if (ownedHudPanes.some((pane) => !hasVerifiedHudPaneInstanceIdentity(pane, equivalentSessionIdSet))) {
    return { status: 'unchanged', paneId: null, desiredHeight: null, duplicateCount: 0 };
  }
  const hudPaneIds = ownedHudPanes.map((pane) => pane.paneId);
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const readAllStateFn = deps.readAllState ?? readAllState;
  const hudState = hudConfig ? await readAllStateFn(cwd, hudConfig).catch(() => null) : null;
  const desiredHeight = hudState ? getHudRenderMaxLines(hudState) : HUD_TMUX_HEIGHT_LINES;
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId, env.OMX_ROOT, currentPaneId, {
    omxStateRoot: env.OMX_STATE_ROOT,
    omxTeamStateRoot: env.OMX_TEAM_STATE_ROOT,
    rootSource: env.OMX_TEAM_STATE_ROOT ? 'team-env' : env.OMX_ROOT ? 'omx-root-env' : env.OMX_STATE_ROOT ? 'omx-state-root-env' : 'cwd-default',
  });
  const leaderPane = currentPaneId
    ? panes.find((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane))
    : undefined;

  const singleHudPane = hudPaneIds.length === 1
    ? panes.find((pane) => pane.paneId === hudPaneIds[0])
    : undefined;
  if (singleHudPane && !needsHudTopologyRecreate(singleHudPane, leaderPane)) {
    const shouldResize = needsHudHeightResize(singleHudPane, desiredHeight);
    const resized = shouldResize ? resizePane(singleHudPane.paneId, desiredHeight) : true;
    if (resized) ensureHudResizeHook(singleHudPane.paneId, currentPaneId, desiredHeight, cwd, deps);
    return {
      status: resized ? (shouldResize ? 'resized' : 'unchanged') : 'failed',
      paneId: singleHudPane.paneId,
      desiredHeight,
      duplicateCount,
    };
  }

  if (hudPaneIds.length > 1) {
    const hudPanes = hudPaneIds
      .map((paneId) => panes.find((pane) => pane.paneId === paneId))
      .filter((pane): pane is TmuxPaneSnapshot => Boolean(pane));
    const keeperPane = hudPanes.find((pane) => !needsHudTopologyRecreate(pane, leaderPane));

    if (keeperPane) {
      for (const paneId of hudPaneIds.filter((paneId) => paneId !== keeperPane.paneId)) {
        killPane(paneId);
      }
      const resized = resizePane(keeperPane.paneId, desiredHeight);
      if (resized) ensureHudResizeHook(keeperPane.paneId, currentPaneId, desiredHeight, cwd, deps);
      return {
        status: resized ? 'replaced_duplicates' : 'failed',
        paneId: keeperPane.paneId,
        desiredHeight,
        duplicateCount,
      };
    }
  }
  const createFullWidth = hudPaneIds
    .map((paneId) => panes.find((pane) => pane.paneId === paneId))
    .some((pane) => Boolean(pane && needsHudTopologyRecreate(pane, leaderPane)))
    && (!leaderPane || shouldCreateFullWidthHud(leaderPane));



  // When there is no existing HUD pane to keep/recreate, this reconcile would
  // create a fresh HUD split. Mirror the launch-time guard: if the current tmux
  // window is too short, skip the split so the first prompt submit cannot
  // recreate the cramped, unreadable 2-line HUD the launch path already
  // declined to add. Default behavior is preserved for normal/unknown heights.
  // (closes #2754)
  if (hudPaneIds.length === 0 && (deps.readCurrentWindowSize || !deps.listCurrentWindowPanes)) {
    const readWindowSize = deps.readCurrentWindowSize ?? ((paneId) => readCurrentWindowSize(undefined, paneId));
    const windowHeight = readWindowSize(currentPaneId).height;
    if (isTmuxWindowTooCrampedForHudSplit(windowHeight)) {
      return {
        status: 'skipped_window_too_cramped',
        paneId: null,
        desiredHeight,
        duplicateCount,
      };
    }
  }

  const unregisterHook = deps.unregisterHudResizeHook ?? unregisterHudResizeHook;
  unregisterHook(currentPaneId);

  const removedHudPaneIds = new Set<string>();
  for (const paneId of hudPaneIds) {
    if (killPane(paneId)) removedHudPaneIds.add(paneId);
  }

  const createOptions: { heightLines: number; fullWidth?: boolean; targetPaneId?: string; instanceId?: string } = {
    heightLines: desiredHeight,
    targetPaneId: currentPaneId,
    instanceId: resolvedSessionId,
  };
  if (createFullWidth) createOptions.fullWidth = true;
  const paneId = createPane(cwd, hudCmd, createOptions);
  if (!paneId) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  // A launch-path restore and prompt-submit reconciliation can both observe
  // "no HUD" before either split-window has materialized. Re-scan after create
  // and collapse same-owner panes so the second creator cleans up the race
  // instead of leaving a duplicate HUD in the user window.
  const postCreate = planOwnedHudPaneDedupe(
    listPanes(currentPaneId).filter((pane) => !removedHudPaneIds.has(pane.paneId)),
    currentPaneId,
    owner,
    paneId,
    equivalentSessionIdSet,
  );
  if (postCreate.unsafeCandidate) {
    return { status: 'recreated', paneId, desiredHeight, duplicateCount: 0 };
  }
  for (const duplicatePaneId of postCreate.duplicatePaneIds) {
    killPane(duplicatePaneId);
  }
  const resized = resizePane(postCreate.paneId, desiredHeight);
  if (!resized) {
    return {
      status: 'failed',
      paneId: postCreate.paneId,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  ensureHudResizeHook(postCreate.paneId, currentPaneId, desiredHeight, cwd, deps);

  return {
    status: postCreate.duplicatePaneIds.length > 0 || hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId: postCreate.paneId,
    desiredHeight,
    duplicateCount: postCreate.duplicatePaneIds.length,
  };
  } finally {
    await releaseHudLifecycleLock(lock);
  }
}

export interface TeardownManagedHudResult {
  status: 'removed' | 'unchanged' | 'skipped_not_omx_owned_tmux' | 'skipped_concurrent';
  removedPaneIds: string[];
}

export async function teardownManagedHudPane(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<TeardownManagedHudResult> {
  const env = deps.env ?? process.env;
  const currentPaneId = env.TMUX_PANE?.trim();
  const requestedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  if (!env.TMUX || !isExplicitOmxOwnedTmuxEnv(env) || !currentPaneId || !requestedSessionId) {
    return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
  }

  const domain = await (deps.resolveDomain ?? resolveHudControlPlaneDomain)({
    cwd,
    env: { ...env, TMUX_PANE: undefined, TMUX_SESSION: undefined },
    requestedSessionId,
  }).catch(() => null);
  const evidence = domain
    ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
    : null;
  if (!domain || !evidence || !isVerifiedManagedHudOwner(domain, currentPaneId, evidence)) {
    return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
  }

  const lockDirReady = await mkdir(domain.baseStateDir, { recursive: true }).then(() => true).catch(() => false);
  const acquired = lockDirReady
    ? await acquireHudLifecycleLock(
      { path: domain.reconcileLockPath, domainKey: domain.domainKey, staleMs: HUD_RECONCILE_LOCK_STALE_MS },
      lifecycleLockDepsForReconcile(deps),
    )
    : { status: 'failed' as const };
  if (acquired.status !== 'acquired' || !acquired.lock) {
    return { status: 'skipped_concurrent', removedPaneIds: [] };
  }

  try {
    const panes = (deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId)))(currentPaneId);
    const leader = panes.find((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane));
    const equivalentSessionIds = new Set(
      [domain.session?.canonicalId, ...(domain.session?.equivalentIds ?? [])]
        .map((value) => value?.trim() ?? '')
        .filter(Boolean),
    );
    const tmuxSessionInstanceId = leader?.sessionInstanceId?.trim() ?? '';
    const tmuxPaneInstanceId = leader?.paneInstanceId?.trim() ?? '';
    if (!leader || !equivalentSessionIds.has(tmuxSessionInstanceId) || !equivalentSessionIds.has(tmuxPaneInstanceId)) {
      return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
    }

    const identity = { tmuxSessionInstanceId, tmuxPaneInstanceId };
    const removedPaneIds: string[] = [];
    const killPane = deps.killTmuxPane ?? killTmuxPane;
    for (const pane of panes) {
      if (pane.paneId === currentPaneId || !isHudWatchPane(pane)) continue;
      const exactOwner = [...equivalentSessionIds].some((sessionId) => hudPaneMatchesExactCandidate(
        pane,
        { sessionId, leaderPaneId: currentPaneId },
        identity,
      ));
      if (exactOwner && killPane(pane.paneId)) removedPaneIds.push(pane.paneId);
    }
    if (removedPaneIds.length > 0) {
      (deps.unregisterHudResizeHook ?? unregisterHudResizeHook)(currentPaneId);
    }
    return { status: removedPaneIds.length > 0 ? 'removed' : 'unchanged', removedPaneIds };
  } finally {
    await releaseHudLifecycleLock(acquired.lock);
  }
}
