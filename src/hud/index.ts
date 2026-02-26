/**
 * OMX HUD - CLI entry point
 *
 * Usage:
 *   omx hud              Show current HUD state
 *   omx hud --watch      Poll every 1s with terminal clear
 *   omx hud --json       Output raw state as JSON
 *   omx hud --preset=X   Use preset: minimal, focused, full
 *   omx hud --tmux       Open HUD in a tmux split pane (auto-detects orientation)
 */

import { execFileSync } from 'child_process';
import { readAllState, readHudConfig } from './state.js';
import { renderHud } from './render.js';
import type { HudFlags, HudPreset } from './types.js';
import { HUD_TMUX_HEIGHT_LINES } from './constants.js';
import { setColorEnabled, shouldEnableColorOutput } from './colors.js';

type IntervalHandle = ReturnType<typeof setInterval>;

interface RunWatchModeDeps {
  readAllStateFn: typeof readAllState;
  readHudConfigFn: typeof readHudConfig;
  renderHudFn: typeof renderHud;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  registerSigint: (handler: () => void) => void;
  setIntervalFn: (handler: () => void, delayMs: number) => IntervalHandle;
  clearIntervalFn: (handle: IntervalHandle) => void;
  isTTY: boolean | undefined;
  env: Record<string, string | undefined>;
}

function resolveWatchModeDeps(overrides: Partial<RunWatchModeDeps> = {}): RunWatchModeDeps {
  return {
    readAllStateFn: overrides.readAllStateFn ?? readAllState,
    readHudConfigFn: overrides.readHudConfigFn ?? readHudConfig,
    renderHudFn: overrides.renderHudFn ?? renderHud,
    writeStdout: overrides.writeStdout ?? ((text: string) => { process.stdout.write(text); }),
    writeStderr: overrides.writeStderr ?? ((text: string) => { process.stderr.write(text); }),
    registerSigint: overrides.registerSigint ?? ((handler: () => void) => { process.on('SIGINT', handler); }),
    setIntervalFn: overrides.setIntervalFn ?? setInterval,
    clearIntervalFn: overrides.clearIntervalFn ?? clearInterval,
    isTTY: overrides.isTTY ?? process.stdout.isTTY,
    env: overrides.env ?? (process.env as Record<string, string | undefined>),
  };
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
  setColorEnabled(shouldEnableColorOutput(process.stdout.isTTY, process.env));
  const [ctx, config] = await Promise.all([
    readAllState(cwd),
    readHudConfig(cwd),
  ]);

  const preset = flags.preset ?? config.preset;

  if (flags.json) {
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }

  console.log(renderHud(ctx, preset));
}

export async function runWatchMode(
  cwd: string,
  flags: HudFlags,
  depsOverrides: Partial<RunWatchModeDeps> = {},
): Promise<void> {
  const deps = resolveWatchModeDeps(depsOverrides);
  const ansiEnabled = shouldEnableColorOutput(deps.isTTY, deps.env);
  setColorEnabled(ansiEnabled);

  let firstRender = true;
  let stopped = false;
  let renderInFlight = false;
  let rerenderQueued = false;
  let interval: IntervalHandle | null = null;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const stop = (exitCode?: number) => {
    if (stopped) return;
    stopped = true;
    if (interval) {
      deps.clearIntervalFn(interval);
      interval = null;
    }
    if (ansiEnabled) {
      deps.writeStdout('\x1b[?25h\x1b[2J\x1b[H');
    }
    if (typeof exitCode === 'number' && exitCode !== 0) {
      process.exitCode = exitCode;
    }
    resolveDone?.();
  };

  const renderFrame = async () => {
    const [ctx, config] = await Promise.all([
      deps.readAllStateFn(cwd),
      deps.readHudConfigFn(cwd),
    ]);
    const preset = flags.preset ?? config.preset;
    const line = deps.renderHudFn(ctx, preset);

    if (ansiEnabled) {
      if (firstRender) {
        deps.writeStdout('\x1b[2J\x1b[H');
        firstRender = false;
      } else {
        deps.writeStdout('\x1b[H');
      }
      deps.writeStdout(line + '\x1b[K\n\x1b[J');
      return;
    }

    deps.writeStdout(`${line}\n`);
  };

  const tick = () => {
    if (stopped) return;
    if (renderInFlight) {
      rerenderQueued = true;
      return;
    }
    renderInFlight = true;
    void (async () => {
      try {
        await renderFrame();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.writeStderr(`HUD watch render failed: ${message}\n`);
        stop(1);
        return;
      } finally {
        renderInFlight = false;
      }

      if (rerenderQueued && !stopped) {
        rerenderQueued = false;
        tick();
      }
    })();
  };

  if (ansiEnabled) {
    deps.writeStdout('\x1b[?25l');
  }

  deps.registerSigint(() => {
    stop(0);
  });

  interval = deps.setIntervalFn(() => {
    tick();
  }, 1000);
  tick();
  await done;
}

export async function hudCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const cwd = process.cwd();

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
): string[] {
  // Defense-in-depth: keep preset constrained even if this helper is reused.
  const safePreset = parseHudPreset(preset);
  const presetArg = safePreset ? ` --preset=${safePreset}` : '';
  const cmd = `node ${shellEscape(omxBin)} hud --watch${presetArg}`;
  return ['split-window', '-v', '-l', String(HUD_TMUX_HEIGHT_LINES), '-c', cwd, cmd];
}

async function launchTmuxPane(cwd: string, flags: HudFlags): Promise<void> {
  // Check if we're inside tmux
  if (!process.env.TMUX) {
    console.error('Not inside a tmux session. Start tmux first, then run: omx hud --tmux');
    process.exit(1);
  }

  const omxBin = process.argv[1]; // path to bin/omx.js
  const args = buildTmuxSplitArgs(cwd, omxBin, flags.preset);

  try {
    // Split bottom pane, 4 lines tall, running omx hud --watch.
    // execFileSync bypasses the shell – cwd and omxBin cannot inject commands.
    execFileSync('tmux', args, { stdio: 'inherit' });
    console.log('HUD launched in tmux pane below. Close with: Ctrl+C in that pane, or `tmux kill-pane -t bottom`');
  } catch {
    console.error('Failed to create tmux split. Ensure tmux is available.');
    process.exit(1);
  }
}
