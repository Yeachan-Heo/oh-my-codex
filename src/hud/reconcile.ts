import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  findLegacyFocusedHudWatchPaneIds,
  findHudWatchPaneIds,
  killTmuxPane,
  listCurrentWindowPanes,
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
    options?: { heightLines?: number; targetPaneId?: string },
  ) => string | null;
  killTmuxPane?: (paneId: string) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (hudPaneId: string, leaderPaneId: string | undefined, heightLines: number) => boolean;
  unregisterHudResizeHook?: (leaderPaneId: string | undefined) => boolean;
}

function ensureHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  desiredHeight: number,
  deps: ReconcileHudForPromptSubmitDeps,
): void {
  try {
    (deps.registerHudResizeHook ?? registerHudResizeHook)(hudPaneId, leaderPaneId, desiredHeight);
  } catch {
    // Non-critical — hook registration failure does not break HUD lifecycle.
  }
}

function planOwnedHudPaneDedupe(
  panes: TmuxPaneSnapshot[],
  currentPaneId: string | undefined,
  owner: { sessionId?: string; leaderPaneId?: string },
  preferredPaneId: string,
): { paneId: string; duplicatePaneIds: string[] } {
  const ownedPaneIds = [
    ...findHudWatchPaneIds(panes, currentPaneId, owner),
    ...findLegacyFocusedHudWatchPaneIds(panes, currentPaneId),
  ].filter((paneId, index, paneIds) => paneIds.indexOf(paneId) === index);
  const keeperPaneId = ownedPaneIds.includes(preferredPaneId)
    ? preferredPaneId
    : (ownedPaneIds[0] ?? preferredPaneId);

  return {
    paneId: keeperPaneId,
    duplicatePaneIds: ownedPaneIds.filter((paneId) => paneId !== keeperPaneId),
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
  const panes = listPanes(currentPaneId);
  const resolvedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  const owner = {
    sessionId: resolvedSessionId,
    leaderPaneId: currentPaneId,
  };
  const hudPaneIds = [
    ...findHudWatchPaneIds(panes, currentPaneId, owner),
    ...findLegacyFocusedHudWatchPaneIds(panes, currentPaneId),
  ].filter((paneId, index, paneIds) => paneIds.indexOf(paneId) === index);
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
    const resized = resizePane(keeperPaneId, desiredHeight);
    if (!resized) {
      return {
        status: 'failed',
        paneId: null,
        desiredHeight,
        duplicateCount,
      };
    }
    for (const paneId of extraPaneIds) {
      killPane(paneId);
    }
    ensureHudResizeHook(keeperPaneId, currentPaneId, desiredHeight, deps);
    return {
      status: 'replaced_duplicates',
      paneId: keeperPaneId,
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

  // A launch-path restore and prompt-submit reconciliation can both observe
  // "no HUD" before either split-window has materialized. Re-scan after create
  // and collapse same-owner panes so the second creator cleans up the race
  // instead of leaving a duplicate HUD in the user window.
  const postCreate = planOwnedHudPaneDedupe(
    listPanes(currentPaneId),
    currentPaneId,
    owner,
    paneId,
  );
  const resized = resizePane(postCreate.paneId, desiredHeight);
  if (!resized) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  for (const duplicatePaneId of postCreate.duplicatePaneIds) {
    killPane(duplicatePaneId);
  }
  ensureHudResizeHook(postCreate.paneId, currentPaneId, desiredHeight, deps);

  return {
    status: postCreate.duplicatePaneIds.length > 0 || hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId: postCreate.paneId,
    desiredHeight,
    duplicateCount: postCreate.duplicatePaneIds.length,
  };
}
