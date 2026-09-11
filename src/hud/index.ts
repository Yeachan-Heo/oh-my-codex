/**
 * OMX HUD - CLI entry point
 *
 * Usage:
 *   omx hud              Show current HUD state
 *   omx hud --watch      Poll every 1s with terminal clear
 *   omx hud --json       Output raw state as JSON
 *   omx hud --preset=X   Use preset: minimal, focused, full
 *   omx hud --tmux       Open HUD in a tmux split pane (auto-detects orientation)
 *   omx hud --reconcile-tmux
 */

import { execFileSync } from 'child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines, renderHud } from './render.js';
import type { HudFlags, HudPreset, HudRenderContext, ResolvedHudConfig } from './types.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import { sleep } from '../utils/sleep.js';
import { runHudAuthorityTick } from './authority.js';
import { isHudWatchSessionAttached } from './session-attached.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';
import {
  killTmuxPane,
  boundHudHeight,
  listCurrentWindowPanes,
  findHudWatchPaneIds,
  OMX_TMUX_HUD_LEADER_PANE_ENV,
  readActiveTmuxPaneId,
  registerHudResizeHook,
  isHudOwnerCurrent,
  clearTmuxPaneHistory,
  resizeTmuxPane,
  shellEscapeSingle,
} from './tmux.js';
import { OMX_TMUX_HUD_OWNER_ENV, needsHudTopologyRecreate, reconcileHudForPromptSubmit } from './reconcile.js';
import { buildHudRuntimeEnv } from './tmux.js';

export const HUD_USAGE = [
  'Usage:',
  '  omx hud              Show current HUD state',
  '  omx hud --watch      Poll every 1s with terminal clear',
  '  omx hud --json       Output raw state as JSON',
  '  omx hud --preset=X   Use preset: minimal, focused, full',
  '  omx hud --tmux       Open HUD in a tmux split pane (auto-detects orientation)',
  '  omx hud --reconcile-tmux',
].join('\n');

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export async function watchRenderLoop(
  render: () => Promise<void>,
  options: {
    intervalMs?: number;
    signal?: AbortSignal;
    onError?: (error: unknown) => void;
    sleepFn?: SleepFn;
  } = {},
): Promise<void> {
  const intervalMs = Math.max(0, options.intervalMs ?? 1000);
  const sleepFn = options.sleepFn ?? sleep;
  const signal = options.signal;

  while (!signal?.aborted) {
    const startedAt = Date.now();
    try {
      await render();
    } catch (error) {
      options.onError?.(error);
    }

    if (signal?.aborted) return;
    const elapsedMs = Date.now() - startedAt;
    await sleepFn(Math.max(0, intervalMs - elapsedMs), signal).catch(() => {});
  }
}

interface RunWatchModeDependencies {
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  resolveWatchCwdFn: (launchCwd: string) => string;
  readAllStateFn: (cwd: string, config?: ResolvedHudConfig) => Promise<HudRenderContext>;
  readHudConfigFn: (cwd: string) => Promise<ResolvedHudConfig>;
  renderHudFn: (ctx: HudRenderContext, preset: HudPreset, options?: { maxWidth?: number; maxLines?: number }) => string;
  runAuthorityTickFn: (options: { cwd: string }) => Promise<void>;
  resizeTmuxPaneFn: (paneId: string, heightLines: number) => boolean;
  listCurrentWindowPanesFn: (paneId?: string) => ReturnType<typeof listCurrentWindowPanes>;
  clearTmuxPaneHistoryFn: (paneId: string) => boolean;
  registerHudResizeHookFn: (hudPaneId: string, leaderPaneId: string | undefined, heightLines: number) => boolean;
  isHudOwnerCurrentFn: (leaderPaneId: string, ownerId: string) => boolean;
  reconcileTmuxHudFn: (cwd: string) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  registerSigint: (handler: () => void) => void | (() => void);
  setIntervalFn: (handler: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearIntervalFn: (timer: ReturnType<typeof setInterval>) => void;
  isSessionAttachedFn: () => boolean;
}

export interface ResolveHudWatchCwdDependencies {
  getCwd?: () => string;
  realpath?: (path: string) => string;
  readProcCwd?: () => string | null | undefined;
}

function safeCallString(fn: () => string | null | undefined): string | null {
  try {
    const value = fn();
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function defaultProcCwd(): string | null {
  if (process.platform === 'win32') return null;
  return safeCallString(() => readlinkSync('/proc/self/cwd'));
}

function isDeletedCwdMarkerText(path: string | null): boolean {
  return Boolean(path && /(?:^|\s)\(deleted\)\s*$/.test(path.trim()));
}

/**
 * Resolve the cwd a long-running HUD watch should read on this frame.
 *
 * tmux launches HUD with both a real cwd and a shell PWD string. If that
 * directory is later renamed and the original pathname is reused by a fresh
 * OMX run, the old HUD process can keep reading the reused launch path and
 * display the new run's state. Compare the launch path to the process' live
 * cwd inode/path each tick; when they diverge, follow the live cwd instead of
 * the stale launch path.
 */
export function resolveHudWatchCwd(
  launchCwd: string,
  deps: ResolveHudWatchCwdDependencies = {},
): string {
  const getCwd = deps.getCwd ?? (() => process.cwd());
  const realpath = deps.realpath ?? ((path: string) => realpathSync.native(path));
  const readProcCwd = deps.readProcCwd ?? defaultProcCwd;

  const processCwd = safeCallString(getCwd);
  const launchPath = launchCwd.trim() || processCwd || launchCwd;
  const livePath = safeCallString(readProcCwd) || processCwd;
  if (!livePath) return launchPath;
  const liveMarkerMayBeProcDeleted = isDeletedCwdMarkerText(livePath) && !isDeletedCwdMarkerText(launchPath) && processCwd !== livePath;
  if (liveMarkerMayBeProcDeleted) {
    const processReal = processCwd ? safeCallString(() => realpath(processCwd)) : null;
    const markerReal = safeCallString(() => realpath(livePath));
    if (!processReal || !markerReal || processReal !== markerReal) return launchPath;
  }

  const launchReal = safeCallString(() => realpath(launchPath));
  const liveReal = safeCallString(() => realpath(livePath));
  if (launchReal && liveReal && launchReal !== liveReal) return livePath;
  if (!launchReal && liveReal) return livePath;
  if (launchReal && !liveReal && livePath !== launchPath) return livePath;
  return launchPath;
}

function reconcileRunningHudPaneHeight(
  desiredHeight: number,
  dependencies: Pick<RunWatchModeDependencies, 'env' | 'resizeTmuxPaneFn' | 'registerHudResizeHookFn' | 'isHudOwnerCurrentFn'>,
): void {
  if (!dependencies.env.TMUX || dependencies.env[OMX_TMUX_HUD_OWNER_ENV] !== '1') return;
  const hudPaneId = dependencies.env.TMUX_PANE?.trim();
  if (!hudPaneId?.startsWith('%')) return;
  const leaderPaneId = dependencies.env[OMX_TMUX_HUD_LEADER_PANE_ENV]?.trim() || undefined;
  if (!leaderPaneId) return;
  if (!dependencies.env.OMX_SESSION_ID) {
    if (dependencies.resizeTmuxPaneFn(hudPaneId, desiredHeight)) {
      dependencies.registerHudResizeHookFn(hudPaneId, leaderPaneId, desiredHeight);
    }
    return;
  }
  if (!dependencies.isHudOwnerCurrentFn(leaderPaneId, dependencies.env.OMX_SESSION_ID)) return;
  dependencies.resizeTmuxPaneFn(hudPaneId, desiredHeight);
  dependencies.registerHudResizeHookFn(hudPaneId, leaderPaneId, desiredHeight);
}

/**
 * Backward-compatible watch mode runner used by tests.
 */
export async function runWatchMode(
  cwd: string,
  flags: HudFlags,
  deps: Partial<RunWatchModeDependencies> = {},
): Promise<void> {
  if (!flags.watch) return;

  const dependencies: RunWatchModeDependencies = {
    isTTY: deps.isTTY ?? Boolean(process.stdout.isTTY),
    env: deps.env ?? process.env,
    resolveWatchCwdFn: deps.resolveWatchCwdFn ?? ((launchCwd) => resolveHudWatchCwd(launchCwd)),
    readAllStateFn: deps.readAllStateFn ?? readAllState,
    readHudConfigFn: deps.readHudConfigFn ?? readHudConfig,
    renderHudFn: deps.renderHudFn ?? renderHud,
    runAuthorityTickFn: deps.runAuthorityTickFn ?? (async ({ cwd: authorityCwd }) => {
      await runHudAuthorityTick({ cwd: authorityCwd });
    }),
    resizeTmuxPaneFn: deps.resizeTmuxPaneFn ?? resizeTmuxPane,
    listCurrentWindowPanesFn: deps.listCurrentWindowPanesFn ?? (paneId => listCurrentWindowPanes(undefined, paneId)),
    clearTmuxPaneHistoryFn: deps.clearTmuxPaneHistoryFn ?? clearTmuxPaneHistory,
    registerHudResizeHookFn: deps.registerHudResizeHookFn ?? registerHudResizeHook,
    isHudOwnerCurrentFn: deps.isHudOwnerCurrentFn
      ?? (deps.registerHudResizeHookFn ? () => true : isHudOwnerCurrent),
    reconcileTmuxHudFn: deps.reconcileTmuxHudFn ?? (async (reconcileCwd) => {
      const leaderPaneId = dependencies.env[OMX_TMUX_HUD_LEADER_PANE_ENV]?.trim();
      if (!leaderPaneId?.startsWith('%')) return;
      const omxEntry = resolveOmxCliEntryPath({
        cwd: reconcileCwd,
        env: {
          ...dependencies.env,
          TMUX_PANE: leaderPaneId,
        },
      });
      if (!omxEntry) return;
      const command = [
        'cd',
        shellEscapeSingle(reconcileCwd),
        '&&',
        `TMUX_PANE=${shellEscapeSingle(leaderPaneId)}`,
        `OMX_TMUX_HUD_OWNER=${shellEscapeSingle('1')}`,
        dependencies.env.OMX_SESSION_ID
          ? `OMX_SESSION_ID=${shellEscapeSingle(dependencies.env.OMX_SESSION_ID)}`
          : '',
        dependencies.env.OMX_ROOT
          ? `OMX_ROOT=${shellEscapeSingle(dependencies.env.OMX_ROOT)}`
          : '',
        shellEscapeSingle(process.execPath),
        shellEscapeSingle(omxEntry),
        'hud',
        '--reconcile-tmux',
        '>/dev/null',
        '2>&1',
      ].filter(Boolean).join(' ');
      execFileSync('tmux', ['run-shell', '-b', command], {
        env: dependencies.env,
        stdio: 'ignore',
      });
    }),
    writeStdout: deps.writeStdout ?? ((text: string) => process.stdout.write(text)),
    writeStderr: deps.writeStderr ?? ((text: string) => process.stderr.write(text)),
    registerSigint: deps.registerSigint ?? ((handler: () => void) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    }),
    setIntervalFn: deps.setIntervalFn ?? ((handler: () => void, intervalMs: number) => setInterval(handler, intervalMs)),
    clearIntervalFn: deps.clearIntervalFn ?? ((timer: ReturnType<typeof setInterval>) => clearInterval(timer)),
    isSessionAttachedFn: deps.isSessionAttachedFn ?? (() => isHudWatchSessionAttached({ env: dependencies.env })),
  };

  if (!dependencies.isTTY && !dependencies.env.CI) {
    dependencies.writeStderr('HUD watch mode requires a TTY\n');
    process.exitCode = 1;
    return;
  }

  dependencies.writeStdout('\x1b[?25l');

  let firstRender = true;
  let inFlight = false;
  let queued = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastDesiredHeight: number | undefined;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  let unregisterSigint: void | (() => void);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) dependencies.clearIntervalFn(timer);
    unregisterSigint?.();
    unregisterSigint = undefined;
    dependencies.writeStdout('\x1b[?25h\x1b[2J\x1b[H');
    resolveDone();
  };

  const renderTick = async () => {
    if (stopped) return;
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    let renderedThisTick: 'rendered' | 'suppressed' | 'stopped' = 'suppressed';
    try {
      // A detached session has no client to receive stdout, so skip the
      // render-only work (state reads with git subprocess spawns, tmux height
      // reconciliation, stdout writes) while still running the authority
      // tick below. Fail-open: an unknown attachment answer renders.
      // (closes #3577)
      let attached = true;
      try {
        attached = dependencies.isSessionAttachedFn();
      } catch {
        // Fail-open: an unknown attachment answer renders.
        attached = true;
      }
      const frameCwd = dependencies.resolveWatchCwdFn(cwd);
      if (firstRender || attached) {
        const config = await dependencies.readHudConfigFn(frameCwd);
        const ctx = await dependencies.readAllStateFn(frameCwd, config);
        const preset = flags.preset ?? config.preset;
        const hudPaneId = dependencies.env.TMUX_PANE?.trim();
        const ownedHudPane = Boolean(
          dependencies.env.TMUX
          && dependencies.env[OMX_TMUX_HUD_OWNER_ENV] === '1'
          && hudPaneId?.startsWith('%'),
        );
        const desiredHeight = getHudRenderMaxLines(ctx);
        const panes = ownedHudPane ? dependencies.listCurrentWindowPanesFn(hudPaneId) : [];
        const maxLines = ownedHudPane
          ? boundHudHeight(desiredHeight, panes,
            dependencies.env[OMX_TMUX_HUD_LEADER_PANE_ENV], hudPaneId)
          : Math.min(desiredHeight, process.stdout.rows || desiredHeight);
        const line = dependencies.renderHudFn(ctx, preset, {
          maxWidth: process.stdout.columns ?? undefined,
          maxLines,
        });
        const currentHeight = panes.find(pane => pane.paneId === hudPaneId)?.paneHeight;
        const changingHeight = maxLines !== lastDesiredHeight
          || (typeof currentHeight === 'number' && currentHeight !== maxLines);
        const clearFrame = ownedHudPane && changingHeight
          ? '\x1b[3J\x1b[2J\x1b[H'
          : '\x1b[2J\x1b[H';
        if (changingHeight) {
          // Clear before a pane resize so tmux cannot reflow stale HUD rows
          // into visible output or scrollback while changing the pane height.
          dependencies.writeStdout(clearFrame);
          reconcileRunningHudPaneHeight(maxLines, dependencies);
          if (ownedHudPane && hudPaneId) dependencies.clearTmuxPaneHistoryFn(hudPaneId);
          lastDesiredHeight = maxLines;
          dependencies.writeStdout(`\x1b[H${line}\x1b[K\x1b[J`);
        } else {
          dependencies.writeStdout(`${clearFrame}${line}\x1b[K\x1b[J`);
        }
        firstRender = false;
        renderedThisTick = 'rendered';
      }
      if (
        dependencies.env.TMUX
        && dependencies.env[OMX_TMUX_HUD_OWNER_ENV] === '1'
        && dependencies.env.TMUX_PANE?.trim().startsWith('%')
      ) {
        // tmux has no command hook for swap-pane on supported 3.2-era builds.
        // Run this even while the session is detached: render work may pause,
        // but topology ownership must still converge without a later prompt.
        await dependencies.reconcileTmuxHudFn(frameCwd);
      }
      try {
        await dependencies.runAuthorityTickFn({ cwd: frameCwd });
      } catch (authorityError) {
        const message = authorityError instanceof Error ? authorityError.message : String(authorityError);
        dependencies.writeStderr(`HUD watch authority tick failed: ${message}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.writeStderr(`HUD watch render failed: ${message}\n`);
      process.exitCode = 1;
      renderedThisTick = 'stopped';
      stop();
    } finally {
      if (renderedThisTick !== 'stopped') inFlight = false;
    }

    if (renderedThisTick === 'stopped') return;
    if (queued) {
      queued = false;
      await renderTick();
    }
  };

  unregisterSigint = dependencies.registerSigint(stop);
  timer = dependencies.setIntervalFn(() => {
    void renderTick();
  }, 1000);

  await renderTick();
  if (!stopped) {
    await done;
  }
}

function parseHudPreset(value: string | undefined): HudPreset | undefined {
  if (value === 'minimal' || value === 'focused' || value === 'full') {
    return value;
  }
  return undefined;
}

function parseFlags(args: string[]): HudFlags {
  const flags: HudFlags = { watch: false, json: false, tmux: false };

  for (const arg of args) {
    if (arg === '--watch' || arg === '-w') {
      flags.watch = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--tmux') {
      flags.tmux = true;
    } else if (arg.startsWith('--preset=')) {
      const preset = parseHudPreset(arg.slice('--preset='.length));
      if (preset) {
        flags.preset = preset;
      }
    }
  }

  return flags;
}

async function renderOnce(cwd: string, flags: HudFlags): Promise<void> {
  const config = await readHudConfig(cwd);
  const ctx = await readAllState(cwd, config);

  const preset = flags.preset ?? config.preset;

  if (flags.json) {
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }

  console.log(renderHud(ctx, preset, {
    maxWidth: process.stdout.columns ?? undefined,
    maxLines: getHudRenderMaxLines(ctx),
  }));
}

export async function hudCommand(
  args: string[],
  deps: {
    cwd?: string;
    reconcileHudForPromptSubmit?: typeof reconcileHudForPromptSubmit;
  } = {},
): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(HUD_USAGE);
    return;
  }

  const flags = parseFlags(args);
  const cwd = deps.cwd ?? process.cwd();

  if (args.includes('--reconcile-tmux')) {
    const result = await (deps.reconcileHudForPromptSubmit ?? reconcileHudForPromptSubmit)(cwd);
    if (result.status === 'failed') {
      process.exitCode = 1;
    }
    return;
  }

  if (flags.tmux) {
    await launchTmuxPane(cwd, flags);
    return;
  }

  if (!flags.watch) {
    await renderOnce(cwd, flags);
    return;
  }

  await runWatchMode(cwd, flags);
}

/** Shell-escape a string using single-quote wrapping (POSIX-safe). */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the argument array for `execFileSync('tmux', args)`.
 *
 * By returning an argv array instead of a shell command string, `cwd` is
 * passed as a literal argument to tmux (no shell expansion).  `omxBin` is
 * shell-escaped inside the command string that tmux will execute in a shell.
 */
export function buildTmuxSplitArgs(
  cwd: string,
  omxBin: string,
  preset?: string,
  sessionId?: string,
  omxRoot?: string,
  leaderPaneId?: string,
  heightLines?: number,
  rootEnv?: Parameters<typeof buildHudRuntimeEnv>[0],
): string[] {
  // Defense-in-depth: keep preset constrained even if this helper is reused.
  const safePreset = parseHudPreset(preset);
  const presetArg = safePreset ? ` --preset=${safePreset}` : '';
  const envAssignments = Object.entries(buildHudRuntimeEnv({
    sessionId,
    leaderPaneId,
    omxRoot,
    ...(rootEnv ?? { rootSource: 'omx-root-env' }),
  }).env).map(([key, value]) => `${key}=${key === OMX_TMUX_HUD_OWNER_ENV ? value : shellEscape(value)}`);
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments.join(' ')} ` : '';
  const cmd = `exec ${envPrefix}${shellEscape(process.execPath)} ${shellEscape(omxBin)} hud --watch${presetArg}`;
  const height = Number.isFinite(heightLines) && (heightLines ?? 0) > 0
    ? Math.floor(heightLines ?? HUD_TMUX_HEIGHT_LINES)
    : HUD_TMUX_HEIGHT_LINES;
  return [
    'split-window',
    '-v',
    '-l',
    String(height),
    ...(leaderPaneId ? ['-t', leaderPaneId] : []),
    '-c',
    cwd,
    cmd,
  ];
}

async function launchTmuxPane(cwd: string, flags: HudFlags): Promise<void> {
  // Check if we're inside tmux
  if (!process.env.TMUX) {
    console.error('Not inside a tmux session. Start tmux first, then run: omx hud --tmux');
    process.exit(1);
  }

  const omxBin = resolveOmxCliEntryPath();
  if (!omxBin) {
    console.error('Failed to resolve OMX launcher path for tmux HUD startup.');
    process.exit(1);
  }
  const envPaneId = process.env.TMUX_PANE?.trim();
  const currentPaneId = envPaneId || readActiveTmuxPaneId() || undefined;
  const leaderPaneId = currentPaneId;
  const sessionId = process.env.OMX_SESSION_ID?.trim() || undefined;
  const panes = listCurrentWindowPanes(undefined, leaderPaneId);
  const existingHudPaneIds = leaderPaneId || sessionId
    ? findHudWatchPaneIds(panes, leaderPaneId, leaderPaneId ? { leaderPaneId } : { sessionId })
    : [];
  const leaderPane = panes.find(pane => pane.paneId === leaderPaneId);
  const keeperPaneId = panes.find(pane => existingHudPaneIds.includes(pane.paneId)
    && !needsHudTopologyRecreate(pane, leaderPane))?.paneId;
  const duplicatePaneIds = existingHudPaneIds.filter(paneId => paneId !== keeperPaneId);
  for (const paneId of duplicatePaneIds) {
    killTmuxPane(paneId);
  }
  if (keeperPaneId) {
    const config = await readHudConfig(cwd);
    const ctx = await readAllState(cwd, config);
    const desiredHeight = boundHudHeight(getHudRenderMaxLines(ctx), listCurrentWindowPanes(undefined, leaderPaneId), leaderPaneId, keeperPaneId);
    resizeTmuxPane(keeperPaneId, desiredHeight);
    if (leaderPaneId) registerHudResizeHook(keeperPaneId, leaderPaneId, desiredHeight);
    console.log(duplicatePaneIds.length > 0
      ? 'HUD already running in tmux pane. Removed duplicate HUD panes and reused existing HUD pane.'
      : 'HUD already running in tmux pane. Reused existing HUD pane.');
    return;
  }

  const config = await readHudConfig(cwd);
  const ctx = await readAllState(cwd, config);
  const args = buildTmuxSplitArgs(
    cwd,
    omxBin,
    flags.preset,
    process.env.OMX_SESSION_ID,
    process.env.OMX_ROOT,
    currentPaneId,
    boundHudHeight(getHudRenderMaxLines(ctx), listCurrentWindowPanes(undefined, leaderPaneId), leaderPaneId),
    {
      omxStateRoot: process.env.OMX_STATE_ROOT,
      omxTeamStateRoot: process.env.OMX_TEAM_STATE_ROOT,
      rootSource: process.env.OMX_TEAM_STATE_ROOT ? 'team-env' : process.env.OMX_ROOT ? 'omx-root-env' : process.env.OMX_STATE_ROOT ? 'omx-state-root-env' : 'cwd-default',
    },
  );

  try {
    // Split bottom pane at the shared HUD height, running omx hud --watch.
    // execFileSync bypasses the shell – cwd and omxBin cannot inject commands.
    execFileSync('tmux', args, { stdio: 'inherit' });
    console.log('HUD launched in tmux pane below. Close with: Ctrl+C in that pane, or `tmux kill-pane -t bottom`');
  } catch {
    console.error('Failed to create tmux split. Ensure tmux is available.');
    process.exit(1);
  }
}
