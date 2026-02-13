/**
 * oh-my-codex CLI
 * Multi-agent orchestration for OpenAI Codex CLI
 */

import { execSync, execFileSync, spawn } from 'child_process';
import { basename, join } from 'path';
import { existsSync } from 'fs';
import { setup } from './setup.js';
import { doctor } from './doctor.js';
import { version } from './version.js';
import { tmuxHookCommand } from './tmux-hook.js';
import { hudCommand } from '../hud/index.js';
import { getAllScopedStateDirs, getBaseStateDir, getStateDir } from '../mcp/state-paths.js';
import { maybeCheckAndPromptUpdate } from './update.js';
import { generateOverlay, applyOverlay, stripOverlay } from '../hooks/agents-overlay.js';
import {
  readSessionState, isSessionStale, writeSessionStart, writeSessionEnd, resetSessionMetrics,
} from '../hooks/session.js';
import { getPackageRoot } from '../utils/package.js';

const HELP = `
oh-my-codex (omx) - Multi-agent orchestration for Codex CLI

Usage:
  omx           Launch Codex CLI + HUD in tmux (or just Codex if no tmux)
  omx setup     Install skills, prompts, MCP servers, and AGENTS.md
  omx doctor    Check installation health
  omx version   Show version information
  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)
  omx help      Show this help message
  omx status    Show active modes and state
  omx cancel    Cancel active execution modes

Options:
  --yolo        Launch Codex in yolo mode (shorthand for: omx launch --yolo)
  --madmax      DANGEROUS: bypass Codex approvals and sandbox
                (alias for --dangerously-bypass-approvals-and-sandbox)
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --verbose     Show detailed output
`;

const MADMAX_FLAG = '--madmax';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

export async function main(args: string[]): Promise<void> {
  const knownCommands = new Set([
    'launch', 'setup', 'doctor', 'version', 'tmux-hook', 'hud', 'status', 'cancel', 'help', '--help', '-h',
  ]);
  const firstArg = args[0];
  const command = !firstArg || firstArg.startsWith('--') ? 'launch' : firstArg;
  const launchArgs = command === 'launch'
    ? (firstArg && firstArg.startsWith('--') ? args : args.slice(1))
    : [];
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const options = {
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    verbose: flags.has('--verbose'),
  };

  try {
    switch (command) {
      case 'launch':
        await launchWithHud(launchArgs);
        break;
      case 'setup':
        await setup(options);
        break;
      case 'doctor':
        await doctor(options);
        break;
      case 'version':
        version();
        break;
      case 'hud':
        await hudCommand(args.slice(1));
        break;
      case 'tmux-hook':
        await tmuxHookCommand(args.slice(1));
        break;
      case 'status':
        await showStatus();
        break;
      case 'cancel':
        await cancelModes();
        break;
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;
      default:
        if (firstArg && firstArg.startsWith('-') && !knownCommands.has(firstArg)) {
          await launchWithHud(args);
          break;
        }
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

async function showStatus(): Promise<void> {
  const { readdir, readFile } = await import('fs/promises');
  const cwd = process.cwd();
  try {
    const scopedDirs = await getAllScopedStateDirs(cwd);
    const states: string[] = [];
    for (const stateDir of scopedDirs) {
      const files = await readdir(stateDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'session.json') continue;
        states.push(join(stateDir, file));
      }
    }
    if (states.length === 0) {
      console.log('No active modes.');
      return;
    }
    for (const path of states) {
      const content = await readFile(path, 'utf-8');
      const state = JSON.parse(content);
      const file = basename(path);
      const mode = file.replace('-state.json', '');
      console.log(`${mode}: ${state.active ? 'ACTIVE' : 'inactive'} (phase: ${state.current_phase || 'n/a'})`);
    }
  } catch {
    console.log('No active modes.');
  }
}

async function launchWithHud(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const normalizedArgs = normalizeCodexLaunchArgs(args);
  const sessionId = `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await maybeCheckAndPromptUpdate(cwd);
  } catch {
    // Non-fatal: update checks must never block launch
  }

  // ── Phase 1: preLaunch ──────────────────────────────────────────────────
  try {
    await preLaunch(cwd, sessionId);
  } catch (err) {
    // preLaunch errors must NOT prevent Codex from starting
    console.error(`[omx] preLaunch warning: ${err instanceof Error ? err.message : err}`);
  }

  // ── Phase 2: run ────────────────────────────────────────────────────────
  try {
    runCodex(cwd, normalizedArgs);
  } finally {
    // ── Phase 3: postLaunch ─────────────────────────────────────────────
    await postLaunch(cwd, sessionId);
  }
}

export function normalizeCodexLaunchArgs(args: string[]): string[] {
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;

  for (const arg of args) {
    if (arg === MADMAX_FLAG) {
      wantsBypass = true;
      continue;
    }

    if (arg === CODEX_BYPASS_FLAG) {
      wantsBypass = true;
      if (!hasBypass) {
        normalized.push(arg);
        hasBypass = true;
      }
      continue;
    }

    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) {
    normalized.push(CODEX_BYPASS_FLAG);
  }

  return normalized;
}

/**
 * preLaunch: Prepare environment before Codex starts.
 * 1. Orphan cleanup (stale session from a crashed launch)
 * 2. Generate + apply AGENTS.md overlay
 * 3. Write session.json
 */
async function preLaunch(cwd: string, sessionId: string): Promise<void> {
  // 1. Orphan cleanup
  const existingSession = await readSessionState(cwd);
  if (existingSession && isSessionStale(existingSession)) {
    const agentsMdPath = join(cwd, 'AGENTS.md');
    try { await stripOverlay(agentsMdPath, cwd); } catch { /* best effort */ }
    const { unlink } = await import('fs/promises');
    try { await unlink(join(cwd, '.omx', 'state', 'session.json')); } catch { /* best effort */ }
  }

  // 2. Generate + apply AGENTS.md overlay
  const agentsMdPath = join(cwd, 'AGENTS.md');
  const overlay = await generateOverlay(cwd, sessionId);
  await applyOverlay(agentsMdPath, overlay, cwd);

  // 3. Write session state
  await resetSessionMetrics(cwd);
  await writeSessionStart(cwd, sessionId);

  // 4. Start notify fallback watcher (best effort)
  try {
    await startNotifyFallbackWatcher(cwd);
  } catch {
    // Non-fatal
  }
}

/**
 * runCodex: Launch Codex CLI (blocks until exit).
 * All 3 paths (new tmux, existing tmux, no tmux) block via execSync/execFileSync.
 */
function runCodex(cwd: string, args: string[]): void {
  const omxBin = process.argv[1];
  const codexArgs = args.length > 0 ? ' ' + args.join(' ') : '';

  if (process.env.TMUX) {
    // Already in tmux: launch codex in current pane, HUD in bottom split
    const hudCmd = `node ${omxBin} hud --watch`;
    try {
      execSync(`tmux split-window -v -l 4 -d -c "${cwd}" '${hudCmd}'`, { stdio: 'inherit' });
    } catch {
      // HUD split failed, continue without it
    }
    // execFileSync imported at top level
    try {
      execFileSync('codex', args, { cwd, stdio: 'inherit' });
    } catch {
      // Codex exited
    }
  } else {
    // Not in tmux: create a new tmux session with codex + HUD pane
    const sessionName = `omx-${Date.now()}`;
    const hudCmd = `node ${omxBin} hud --watch`;
    try {
      execSync(
        `tmux new-session -d -s "${sessionName}" -c "${cwd}" "codex${codexArgs}" \\; ` +
        `split-window -v -l 4 -d -c "${cwd}" '${hudCmd}' \\; ` +
        `select-pane -t 0 \\; ` +
        `attach-session -t "${sessionName}"`,
        { stdio: 'inherit' }
      );
    } catch {
      // tmux not available, just run codex directly
      console.log('tmux not available, launching codex without HUD...');
      // execFileSync imported at top level
      try {
        execFileSync('codex', args, { cwd, stdio: 'inherit' });
      } catch {
        // Codex exited
      }
    }
  }
}

/**
 * postLaunch: Clean up after Codex exits.
 * Each step is independently fault-tolerant (try/catch per step).
 */
async function postLaunch(cwd: string, sessionId: string): Promise<void> {
  // 0. Flush fallback watcher once to reduce race with fast codex exit.
  try {
    await flushNotifyFallbackOnce(cwd);
  } catch {
    // Non-fatal
  }

  // 0. Stop notify fallback watcher first.
  try {
    await stopNotifyFallbackWatcher(cwd);
  } catch {
    // Non-fatal
  }

  // 1. Strip AGENTS.md overlay
  try {
    await stripOverlay(join(cwd, 'AGENTS.md'), cwd);
  } catch (err) {
    console.error(`[omx] postLaunch: overlay strip failed: ${err instanceof Error ? err.message : err}`);
  }

  // 2. Archive session (write history, delete session.json)
  try {
    await writeSessionEnd(cwd, sessionId);
  } catch (err) {
    console.error(`[omx] postLaunch: session archive failed: ${err instanceof Error ? err.message : err}`);
  }

  // 3. Cancel any still-active modes
  try {
    const { readdir, writeFile, readFile } = await import('fs/promises');
    const scopedDirs = [getBaseStateDir(cwd), getStateDir(cwd, sessionId)];
    for (const stateDir of scopedDirs) {
      const files = await readdir(stateDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'session.json') continue;
        const path = join(stateDir, file);
        const content = await readFile(path, 'utf-8');
        const state = JSON.parse(content);
        if (state.active) {
          state.active = false;
          state.completed_at = new Date().toISOString();
          await writeFile(path, JSON.stringify(state, null, 2));
        }
      }
    }
  } catch (err) {
    console.error(`[omx] postLaunch: mode cleanup failed: ${err instanceof Error ? err.message : err}`);
  }
}

function notifyFallbackPidPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'notify-fallback.pid');
}

async function startNotifyFallbackWatcher(cwd: string): Promise<void> {
  if (process.env.OMX_NOTIFY_FALLBACK === '0') return;

  const { mkdir, writeFile, readFile } = await import('fs/promises');
  const pidPath = notifyFallbackPidPath(cwd);
  const pkgRoot = getPackageRoot();
  const watcherScript = join(pkgRoot, 'scripts', 'notify-fallback-watcher.js');
  const notifyScript = join(pkgRoot, 'scripts', 'notify-hook.js');
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;

  // Stop stale watcher from a previous run.
  if (existsSync(pidPath)) {
    try {
      const prev = JSON.parse(await readFile(pidPath, 'utf-8')) as { pid?: number };
      if (prev && typeof prev.pid === 'number') {
        process.kill(prev.pid, 'SIGTERM');
      }
    } catch {
      // Ignore stale PID parse/kill errors.
    }
  }

  await mkdir(join(cwd, '.omx', 'state'), { recursive: true }).catch(() => {});
  const child = spawn(
    process.execPath,
    [watcherScript, '--cwd', cwd, '--notify-script', notifyScript],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
    }
  );
  child.unref();

  await writeFile(
    pidPath,
    JSON.stringify({ pid: child.pid, started_at: new Date().toISOString() }, null, 2)
  ).catch(() => {});
}

async function stopNotifyFallbackWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import('fs/promises');
  const pidPath = notifyFallbackPidPath(cwd);
  if (!existsSync(pidPath)) return;

  try {
    const parsed = JSON.parse(await readFile(pidPath, 'utf-8')) as { pid?: number };
    if (parsed && typeof parsed.pid === 'number') {
      process.kill(parsed.pid, 'SIGTERM');
    }
  } catch {
    // Ignore stop errors.
  }

  await unlink(pidPath).catch(() => {});
}

async function flushNotifyFallbackOnce(cwd: string): Promise<void> {
  const { spawnSync } = await import('child_process');
  const pkgRoot = getPackageRoot();
  const watcherScript = join(pkgRoot, 'scripts', 'notify-fallback-watcher.js');
  const notifyScript = join(pkgRoot, 'scripts', 'notify-hook.js');
  if (!existsSync(watcherScript) || !existsSync(notifyScript)) return;
  spawnSync(process.execPath, [watcherScript, '--once', '--cwd', cwd, '--notify-script', notifyScript], {
    cwd,
    stdio: 'ignore',
    timeout: 3000,
  });
}

async function cancelModes(): Promise<void> {
  const { readdir, writeFile, readFile } = await import('fs/promises');
  const cwd = process.cwd();
  try {
    const scopedDirs = await getAllScopedStateDirs(cwd);
    let cancelled = 0;
    for (const stateDir of scopedDirs) {
      const files = await readdir(stateDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith('-state.json') || file === 'session.json') continue;
        const path = join(stateDir, file);
        const content = await readFile(path, 'utf-8');
        const state = JSON.parse(content);
        if (state.active) {
          state.active = false;
          state.current_phase = 'cancelled';
          state.completed_at = new Date().toISOString();
          await writeFile(path, JSON.stringify(state, null, 2));
          cancelled++;
          console.log(`Cancelled: ${file.replace('-state.json', '')}`);
        }
      }
    }
    if (cancelled === 0) {
      console.log('No active modes to cancel.');
    }
  } catch {
    console.log('No active modes to cancel.');
  }
}
