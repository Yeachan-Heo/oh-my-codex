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

import { execSync } from 'child_process';
import { readAllState, readHudConfig } from './state.js';
import { renderHud } from './render.js';
import type { HudFlags, HudPreset } from './types.js';

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
      const value = arg.slice('--preset='.length) as HudPreset;
      if (['minimal', 'focused', 'full'].includes(value)) {
        flags.preset = value;
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

  // Watch mode: clear + render every 1s
  const render = async () => {
    process.stdout.write('\x1b[2J\x1b[H'); // Clear screen + move cursor to top
    await renderOnce(cwd, flags);
  };

  await render();
  const interval = setInterval(render, 1000);

  // Graceful exit on Ctrl+C
  process.on('SIGINT', () => {
    clearInterval(interval);
    process.stdout.write('\x1b[2J\x1b[H');
    process.exit(0);
  });

  // Keep process alive
  await new Promise(() => {}); // Never resolves - exits via SIGINT
}

async function launchTmuxPane(cwd: string, flags: HudFlags): Promise<void> {
  // Check if we're inside tmux
  if (!process.env.TMUX) {
    console.error('Not inside a tmux session. Start tmux first, then run: omx hud --tmux');
    process.exit(1);
  }

  const presetArg = flags.preset ? ` --preset=${flags.preset}` : '';
  const omxBin = process.argv[1]; // path to bin/omx.js
  const cmd = `node ${omxBin} hud --watch${presetArg}`;

  try {
    // Split bottom pane, 4 lines tall, running omx hud --watch
    execSync(`tmux split-window -v -l 4 -c "${cwd}" '${cmd}'`, { stdio: 'inherit' });
    console.log('HUD launched in tmux pane below. Close with: Ctrl+C in that pane, or `tmux kill-pane -t bottom`');
  } catch {
    console.error('Failed to create tmux split. Ensure tmux is available.');
    process.exit(1);
  }
}
