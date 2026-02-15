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

  // Watch mode: overwrite in-place (no flicker)
  let firstRender = true;
  const render = async () => {
    if (firstRender) {
      process.stdout.write('\x1b[2J\x1b[H'); // Clear screen on first render only
      firstRender = false;
    } else {
      process.stdout.write('\x1b[H'); // Move cursor to top-left (no clear)
    }
    const [ctx, config] = await Promise.all([
      readAllState(cwd),
      readHudConfig(cwd),
    ]);
    const preset = flags.preset ?? config.preset;
    const line = renderHud(ctx, preset);
    process.stdout.write(line + '\x1b[K\n\x1b[J'); // Write line, clear rest of line + below
  };

  process.stdout.write('\x1b[?25l'); // Hide cursor
  await render();
  const interval = setInterval(render, 1000);

  // Graceful exit on Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.stdout.write('\x1b[?25h\x1b[2J\x1b[H'); // Show cursor + clear
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {}); // Never resolves - exits via SIGINT
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
  return ['split-window', '-v', '-l', '4', '-c', cwd, cmd];
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
