import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  findHudWatchPaneIds,
  isHudWatchPane,
  killTmuxPane,
  listCurrentWindowPanes,
  readHudPaneOwner,
  registerHudResizeHook,
  unregisterHudResizeHook,
  resizeTmuxPane,
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
 * Without this, a destroyed leader pane (e.g. when a `team` setup/teardown cycle
 * tears down the leader REPL pane) leaves its HUD panes orphaned. The owner match
 * used below (`findHudWatchPaneIds` with `leaderPaneId: currentPaneId`) keys on the
 * *current* leader pane id, so those orphans — still tagged with the dead leader id
 * — never match. The reconcile then treats the window as having zero HUDs and
 * appends a fresh one on every prompt submit, until the window degenerates into a
 * column of stacked HUD strips with no leader or worker panes left.
 *
 * The reap is intentionally scoped to the current session: HUD panes owned by other
 * sessions (whose leader may legitimately live in a different tmux window we cannot
 * see from this window's pane list) are never touched.
 */
function reapOrphanedSessionHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    sessionId: string | undefined;
    currentPaneId: string | undefined;
    killPane: (paneId: string) => boolean;
  },
): string[] {
  const { sessionId, currentPaneId, killPane } = opts;
  if (!sessionId) return [];
  const livePaneIds = new Set(panes.map((pane) => pane.paneId));
  const reaped: string[] = [];
  for (const pane of panes) {
    if (!isHudWatchPane(pane)) continue;
    const owner = readHudPaneOwner(pane);
    // Only reclaim HUDs that explicitly belong to this session and name a leader.
    if (owner.sessionId !== sessionId || !owner.leaderPaneId) continue;
    // Keep HUDs whose leader is the current pane or otherwise still alive here.
    if (owner.leaderPaneId === currentPaneId || livePaneIds.has(owner.leaderPaneId)) continue;
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
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (hudPaneId: string, currentPaneId: string | undefined, heightLines: number) => boolean;
  unregisterHudResizeHook?: (currentPaneId: string | undefined) => boolean;
}

function ensureHudResizeHook(
  hudPaneId: string,
  currentPaneId: string | undefined,
  desiredHeight: number,
  deps: ReconcileHudForPromptSubmitDeps,
): void {
  try {
    (deps.registerHudResizeHook ?? registerHudResizeHook)(hudPaneId, currentPaneId, desiredHeight);
  } catch {
    // Non-critical — hook registration failure does not break HUD lifecycle.
  }
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

  const listPanes = deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId));
  const createPane = deps.createHudWatchPane ?? ((hudCwd, hudCmd, options) => createHudWatchPane(hudCwd, hudCmd, options));
  const killPane = deps.killTmuxPane ?? ((paneId) => killTmuxPane(paneId));
  const resizePane = deps.resizeTmuxPane ?? ((paneId, lines) => resizeTmuxPane(paneId, lines));

  const currentPaneId = env.TMUX_PANE?.trim();
  const resolvedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  let panes = listPanes(currentPaneId);

  // Reclaim orphaned HUD panes from a destroyed leader before deciding whether a
  // HUD already exists; otherwise dead-leader HUDs accumulate one per prompt submit.
  const reapedOrphanPaneIds = reapOrphanedSessionHudPanes(panes, {
    sessionId: resolvedSessionId,
    currentPaneId,
    killPane,
  });
  if (reapedOrphanPaneIds.length > 0) {
    const reapedPaneIdSet = new Set(reapedOrphanPaneIds);
    panes = panes.filter((pane) => !reapedPaneIdSet.has(pane.paneId));
  }

  const hudPaneIds = findHudWatchPaneIds(panes, currentPaneId, {
    sessionId: resolvedSessionId,
    leaderPaneId: currentPaneId,
  });
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const nonHudPaneCount = panes.filter((pane) => !isHudWatchPane(pane)).length;
  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const readAllStateFn = deps.readAllState ?? readAllState;
  const hudState = hudConfig ? await readAllStateFn(cwd, hudConfig).catch(() => null) : null;
  const desiredHeight = hudState ? getHudRenderMaxLines(hudState) : HUD_TMUX_HEIGHT_LINES;
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId, env.OMX_ROOT, currentPaneId);

  if (hudPaneIds.length === 1) {
    const resized = resizePane(hudPaneIds[0], desiredHeight);
    if (resized) ensureHudResizeHook(hudPaneIds[0], currentPaneId, desiredHeight, deps);
    return {
      status: resized ? 'resized' : 'failed',
      paneId: hudPaneIds[0],
      desiredHeight,
      duplicateCount,
    };
  }

  if (hudPaneIds.length > 1) {
    const [keeperPaneId, ...extraPaneIds] = hudPaneIds;
    for (const paneId of extraPaneIds) {
      killPane(paneId);
    }
    const resized = resizePane(keeperPaneId, desiredHeight);
    if (resized) ensureHudResizeHook(keeperPaneId, currentPaneId, desiredHeight, deps);
    return {
      status: resized ? 'replaced_duplicates' : 'failed',
      paneId: resized ? keeperPaneId : null,
      desiredHeight,
      duplicateCount,
    };
  }

  if (!resolvedSessionId) {
    return {
      status: 'skipped_no_session_id',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  const unregisterHook = deps.unregisterHudResizeHook ?? unregisterHudResizeHook;
  unregisterHook(currentPaneId);

  for (const paneId of hudPaneIds) {
    killPane(paneId);
  }

  const paneId = createPane(cwd, hudCmd, {
    heightLines: desiredHeight,
    fullWidth: nonHudPaneCount > 1,
    targetPaneId: currentPaneId,
  });
  if (!paneId) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  resizePane(paneId, desiredHeight);
  ensureHudResizeHook(paneId, currentPaneId, desiredHeight, deps);

  return {
    status: hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId,
    desiredHeight,
    duplicateCount,
  };
}
