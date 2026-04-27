import { readHudConfig } from './state.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  findHudWatchPaneIds,
  isHudWatchPane,
  killTmuxPane,
  listCurrentWindowPanes,
  resizeTmuxPane,
  type TmuxPaneSnapshot,
} from './tmux.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
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
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
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
  const hudPaneIds = findHudWatchPaneIds(panes, currentPaneId);
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const nonHudPaneCount = panes.filter((pane) => !isHudWatchPane(pane)).length;
  const desiredHeight = HUD_TMUX_HEIGHT_LINES;

  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const preset = hudConfig?.preset;
  const resolvedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId);

  if (hudPaneIds.length === 1) {
    const resized = resizePane(hudPaneIds[0], desiredHeight);
    return {
      status: resized ? 'resized' : 'failed',
      paneId: hudPaneIds[0],
      desiredHeight,
      duplicateCount,
    };
  }

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

  return {
    status: hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId,
    desiredHeight,
    duplicateCount,
  };
}
