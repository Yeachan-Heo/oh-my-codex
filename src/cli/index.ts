/**
 * oh-my-codex CLI
 * Multi-agent orchestration for OpenAI Codex CLI
 */

import { execSync, execFileSync, spawn } from 'child_process';
import { basename, dirname, join } from 'path';
import { existsSync } from 'fs';
import { setup } from './setup.js';
import { doctor } from './doctor.js';
import { version } from './version.js';
import { tmuxHookCommand } from './tmux-hook.js';
import { hooksCommand } from './hooks.js';
import { hudCommand } from '../hud/index.js';
import { teamCommand } from './team.js';
import { getAllScopedStateDirs, getBaseStateDir, getStateDir } from '../mcp/state-paths.js';
import { maybeCheckAndPromptUpdate } from './update.js';
import { maybePromptGithubStar } from './star-prompt.js';
import {
  generateOverlay,
  writeSessionModelInstructionsFile,
  removeSessionModelInstructionsFile,
  sessionModelInstructionsPath,
} from '../hooks/agents-overlay.js';
import {
  readSessionState, isSessionStale, writeSessionStart, writeSessionEnd, resetSessionMetrics,
} from '../hooks/session.js';
import { enableMouseScrolling, isWsl2 } from '../team/tmux-session.js';
import { getPackageRoot } from '../utils/package.js';
import { codexConfigPath } from '../utils/paths.js';
import { buildHookEvent } from '../hooks/extensibility/events.js';
import { dispatchHookEvent } from '../hooks/extensibility/dispatcher.js';
import {
  collectInheritableTeamWorkerArgs as collectInheritableTeamWorkerArgsShared,
  resolveTeamWorkerLaunchArgs,
} from '../team/model-contract.js';

const HELP = `
oh-my-codex (omx) - Multi-agent orchestration for Codex CLI

Usage:
  omx           Launch Codex CLI (HUD auto-attaches only when already inside tmux)
  omx setup     Install skills, prompts, MCP servers, and AGENTS.md
  omx doctor    Check installation health
  omx doctor --team  Check team/swarm runtime health diagnostics
  omx team      Spawn parallel worker panes in tmux and bootstrap inbox/task state
  omx version   Show version information
  omx tmux-hook Manage tmux prompt injection workaround (init|status|validate|test)
  omx hooks     Manage hook plugins (init|status|validate|test)
  omx hud       Show HUD statusline (--watch, --json, --preset=NAME)
  omx help      Show this help message
  omx status    Show active modes and state
  omx cancel    Cancel active execution modes
  omx reasoning Show or set model reasoning effort (low|medium|high|xhigh)

Options:
  --yolo        Launch Codex in yolo mode (shorthand for: omx launch --yolo)
  --high        Launch Codex with high reasoning effort
                (shorthand for: -c model_reasoning_effort="high")
  --xhigh       Launch Codex with xhigh reasoning effort
                (shorthand for: -c model_reasoning_effort="xhigh")
  --madmax      DANGEROUS: bypass Codex approvals and sandbox
                (alias for --dangerously-bypass-approvals-and-sandbox)
  --spark       Use the Codex spark model (~1.3x faster) for this session
                (shorthand for: --model gpt-5.3-codex-spark)
  --madmax-spark  Use spark model with approval bypass for maximum throughput
                (pro users only; shorthand for: --spark --madmax)
  --force       Force reinstall (overwrite existing files)
  --dry-run     Show what would be done without doing it
  --verbose     Show detailed output
`;

const MADMAX_FLAG = '--madmax';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MODEL_FLAG = '--model';
const HIGH_REASONING_FLAG = '--high';
const XHIGH_REASONING_FLAG = '--xhigh';
const SPARK_FLAG = '--spark';
const MADMAX_SPARK_FLAG = '--madmax-spark';
const SPARK_MODEL = 'gpt-5.3-codex-spark';
const CONFIG_FLAG = '-c';
const LONG_CONFIG_FLAG = '--config';
const REASONING_KEY = 'model_reasoning_effort';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const TEAM_WORKER_LAUNCH_ARGS_ENV = 'OMX_TEAM_WORKER_LAUNCH_ARGS';
const TEAM_INHERIT_LEADER_FLAGS_ENV = 'OMX_TEAM_INHERIT_LEADER_FLAGS';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';
const REASONING_MODES = ['low', 'medium', 'high', 'xhigh'] as const;
type ReasoningMode = typeof REASONING_MODES[number];
const REASONING_MODE_SET = new Set<string>(REASONING_MODES);
const REASONING_USAGE = 'Usage: omx reasoning <low|medium|high|xhigh>';

type CliCommand = 'launch' | 'setup' | 'doctor' | 'team' | 'version' | 'tmux-hook' | 'hooks' | 'hud' | 'status' | 'cancel' | 'help' | 'reasoning' | string;

export interface ResolvedCliInvocation {
  command: CliCommand;
  launchArgs: string[];
}

export function resolveCliInvocation(args: string[]): ResolvedCliInvocation {
  const firstArg = args[0];
  if (firstArg === '--help' || firstArg === '-h') {
    return { command: 'help', launchArgs: [] };
  }
  if (!firstArg || firstArg.startsWith('--')) {
    return { command: 'launch', launchArgs: firstArg ? args : [] };
  }
  if (firstArg === 'launch') {
    return { command: 'launch', launchArgs: args.slice(1) };
  }
  return { command: firstArg, launchArgs: [] };
}

export type CodexLaunchPolicy = 'inside-tmux' | 'direct';

export function resolveCodexLaunchPolicy(env: NodeJS.ProcessEnv = process.env): CodexLaunchPolicy {
  return env.TMUX ? 'inside-tmux' : 'direct';
}

interface TmuxPaneSnapshot {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

export function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId = '', currentCommand = '', ...startCommandParts] = line.split('\t');
      return {
        paneId: paneId.trim(),
        currentCommand: currentCommand.trim(),
        startCommand: startCommandParts.join('\t').trim(),
      };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

export function isHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`.toLowerCase();
  return /\bhud\b/.test(command)
    && /--watch\b/.test(command)
    && (/\bomx(?:\.js)?\b/.test(command) || /\bnode\b/.test(command));
}

export function findHudWatchPaneIds(panes: TmuxPaneSnapshot[], currentPaneId?: string): string[] {
  return panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

export function buildHudPaneCleanupTargets(existingPaneIds: string[], createdPaneId: string | null, leaderPaneId?: string): string[] {
  const targets = new Set<string>(existingPaneIds.filter((id) => id.startsWith('%')));
  if (createdPaneId && createdPaneId.startsWith('%')) {
    targets.add(createdPaneId);
  }
  // Guard: never kill the leader's own pane under any circumstances.
  if (leaderPaneId && leaderPaneId.startsWith('%')) {
    targets.delete(leaderPaneId);
  }
  return [...targets];
}

export async function main(args: string[]): Promise<void> {
  const knownCommands = new Set([
    'launch', 'setup', 'doctor', 'team', 'version', 'tmux-hook', 'hooks', 'hud', 'status', 'cancel', 'help', '--help', '-h',
  ]);
  const firstArg = args[0];
  const { command, launchArgs } = resolveCliInvocation(args);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const options = {
    force: flags.has('--force'),
    dryRun: flags.has('--dry-run'),
    verbose: flags.has('--verbose'),
    team: flags.has('--team'),
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
      case 'team':
        await teamCommand(args.slice(1), options);
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
      case 'hooks':
        await hooksCommand(args.slice(1));
        break;
      case 'status':
        await showStatus();
        break;
      case 'cancel':
        await cancelModes();
        break;
      case 'reasoning':
        await reasoningCommand(args.slice(1));
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

async function reasoningCommand(args: string[]): Promise<void> {
  const mode = args[0];
  const configPath = codexConfigPath();

  if (!mode) {
    if (!existsSync(configPath)) {
      console.log(`model_reasoning_effort is not set (${configPath} does not exist).`);
      console.log(REASONING_USAGE);
      return;
    }

    const { readFile } = await import('fs/promises');
    const content = await readFile(configPath, 'utf-8');
    const current = readTopLevelTomlString(content, REASONING_KEY);
    if (current) {
      console.log(`Current ${REASONING_KEY}: ${current}`);
      return;
    }

    console.log(`${REASONING_KEY} is not set in ${configPath}.`);
    console.log(REASONING_USAGE);
    return;
  }

  if (!REASONING_MODE_SET.has(mode)) {
    throw new Error(`Invalid reasoning mode "${mode}". Expected one of: ${REASONING_MODES.join(', ')}.\n${REASONING_USAGE}`);
  }

  const { mkdir, readFile, writeFile } = await import('fs/promises');
  await mkdir(dirname(configPath), { recursive: true });

  const existing = existsSync(configPath) ? await readFile(configPath, 'utf-8') : '';
  const updated = upsertTopLevelTomlString(existing, REASONING_KEY, mode);
  await writeFile(configPath, updated);
  console.log(`Set ${REASONING_KEY}="${mode}" in ${configPath}`);
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

  try {
    await maybePromptGithubStar();
  } catch {
    // Non-fatal: star prompt must never block launch
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
    runCodex(cwd, normalizedArgs, sessionId);
  } finally {
    // ── Phase 3: postLaunch ─────────────────────────────────────────────
    await postLaunch(cwd, sessionId);
  }
}

export function normalizeCodexLaunchArgs(args: string[]): string[] {
  const normalized: string[] = [];
  let wantsBypass = false;
  let hasBypass = false;
  let reasoningMode: ReasoningMode | null = null;
  let wantsSparkModel = false;
  let hasExplicitModel = false;

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

    if (arg === HIGH_REASONING_FLAG) {
      reasoningMode = 'high';
      continue;
    }

    if (arg === XHIGH_REASONING_FLAG) {
      reasoningMode = 'xhigh';
      continue;
    }

    if (arg === SPARK_FLAG) {
      wantsSparkModel = true;
      continue;
    }

    if (arg === MADMAX_SPARK_FLAG) {
      wantsSparkModel = true;
      wantsBypass = true;
      continue;
    }

    if (arg === MODEL_FLAG || arg.startsWith(`${MODEL_FLAG}=`)) {
      hasExplicitModel = true;
    }

    normalized.push(arg);
  }

  if (wantsBypass && !hasBypass) {
    normalized.push(CODEX_BYPASS_FLAG);
  }

  if (reasoningMode) {
    normalized.push(CONFIG_FLAG, `${REASONING_KEY}="${reasoningMode}"`);
  }

  if (wantsSparkModel && !hasExplicitModel) {
    normalized.push(MODEL_FLAG, SPARK_MODEL);
  }

  return normalized;
}

function isReasoningOverride(value: string): boolean {
  return new RegExp(`^${REASONING_KEY}\\s*=`).test(value.trim());
}

function isModelInstructionsOverride(value: string): boolean {
  return new RegExp(`^${MODEL_INSTRUCTIONS_FILE_KEY}\\s*=`).test(value.trim());
}

function hasModelInstructionsOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === CONFIG_FLAG || arg === LONG_CONFIG_FLAG) {
      const maybeValue = args[i + 1];
      if (typeof maybeValue === 'string' && isModelInstructionsOverride(maybeValue)) {
        return true;
      }
      continue;
    }

    if (arg.startsWith(`${LONG_CONFIG_FLAG}=`)) {
      const inlineValue = arg.slice(`${LONG_CONFIG_FLAG}=`.length);
      if (isModelInstructionsOverride(inlineValue)) return true;
    }
  }
  return false;
}

function shouldBypassDefaultSystemPrompt(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV] !== '0';
}

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv, defaultFilePath?: string): string {
  const filePath = env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || defaultFilePath || join(cwd, 'AGENTS.md');
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

export function injectModelInstructionsBypassArgs(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  defaultFilePath?: string,
): string[] {
  if (!shouldBypassDefaultSystemPrompt(env)) return [...args];
  if (hasModelInstructionsOverride(args)) return [...args];
  return [...args, CONFIG_FLAG, buildModelInstructionsOverride(cwd, env, defaultFilePath)];
}

export function collectInheritableTeamWorkerArgs(codexArgs: string[]): string[] {
  return collectInheritableTeamWorkerArgsShared(codexArgs);
}

export function resolveTeamWorkerLaunchArgsEnv(
  existingRaw: string | undefined,
  codexArgs: string[],
  inheritLeaderFlags = true,
  defaultModel?: string,
): string | null {
  const inheritedArgs = inheritLeaderFlags ? collectInheritableTeamWorkerArgs(codexArgs) : [];
  const normalized = resolveTeamWorkerLaunchArgs({
    existingRaw,
    inheritedArgs,
    fallbackModel: defaultModel,
  });
  if (normalized.length === 0) return null;
  return normalized.join(' ');
}

export function readTopLevelTomlString(content: string, key: string): string | null {
  let inTopLevel = true;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!match || match[1] !== key) continue;
    return parseTomlStringValue(match[2]);
  }
  return null;
}

export function upsertTopLevelTomlString(content: string, key: string, value: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const assignment = `${key} = "${escapeTomlString(value)}"`;

  if (!content.trim()) {
    return assignment + eol;
  }

  const lines = content.split(/\r?\n/);
  let replaced = false;
  let inTopLevel = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^\[[^[\]]+\]\s*(#.*)?$/.test(trimmed)) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (match && match[1] === key) {
      lines[i] = assignment;
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    const firstTableIndex = lines.findIndex(line => /^\s*\[[^[\]]+\]\s*(#.*)?$/.test(line.trim()));
    if (firstTableIndex >= 0) {
      lines.splice(firstTableIndex, 0, assignment);
    } else {
      lines.push(assignment);
    }
  }

  let out = lines.join(eol);
  if (!out.endsWith(eol)) out += eol;
  return out;
}

function parseTomlStringValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('\'') && trimmed.endsWith('\'') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeTmuxToken(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

export function buildTmuxSessionName(cwd: string, sessionId: string): string {
  const dirToken = sanitizeTmuxToken(basename(cwd));
  let branchToken = 'detached';
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (branch) branchToken = sanitizeTmuxToken(branch);
  } catch {
    // Non-git directory or git unavailable.
  }
  const sessionToken = sanitizeTmuxToken(sessionId.replace(/^omx-/, ''));
  const name = `omx-${dirToken}-${branchToken}-${sessionToken}`;
  return name.length > 120 ? name.slice(0, 120) : name;
}

/**
 * preLaunch: Prepare environment before Codex starts.
 * 1. Orphan cleanup (stale session from a crashed launch)
 * 2. Generate runtime overlay + write session-scoped model instructions file
 * 3. Write session.json
 */
async function preLaunch(cwd: string, sessionId: string): Promise<void> {
  // 1. Orphan cleanup
  const existingSession = await readSessionState(cwd);
  if (existingSession && isSessionStale(existingSession)) {
    try { await removeSessionModelInstructionsFile(cwd, existingSession.session_id); } catch { /* best effort */ }
    const { unlink } = await import('fs/promises');
    try { await unlink(join(cwd, '.omx', 'state', 'session.json')); } catch { /* best effort */ }
  }

  // 2. Generate runtime overlay + write session-scoped model instructions file
  const overlay = await generateOverlay(cwd, sessionId);
  await writeSessionModelInstructionsFile(cwd, sessionId, overlay);

  // 3. Write session state
  await resetSessionMetrics(cwd);
  await writeSessionStart(cwd, sessionId);

  // 4. Start notify fallback watcher (best effort)
  try {
    await startNotifyFallbackWatcher(cwd);
  } catch {
    // Non-fatal
  }

  // 5. Start derived watcher (best effort, opt-in)
  try {
    await startHookDerivedWatcher(cwd);
  } catch {
    // Non-fatal
  }

  // 6. Send session-start lifecycle notification (best effort)
  try {
    const { notifyLifecycle } = await import('../notifications/index.js');
    await notifyLifecycle('session-start', {
      sessionId,
      projectPath: cwd,
      projectName: basename(cwd),
    });
  } catch {
    // Non-fatal: notification failures must never block launch
  }

  // 7. Dispatch native hook event (best effort)
  try {
    await emitNativeHookEvent(cwd, 'session-start', {
      session_id: sessionId,
      context: {
        project_path: cwd,
        project_name: basename(cwd),
      },
    });
  } catch {
    // Non-fatal
  }
}

/**
 * runCodex: Launch Codex CLI (blocks until exit).
 * All 3 paths (new tmux, existing tmux, no tmux) block via execSync/execFileSync.
 */
function runCodex(cwd: string, args: string[], sessionId: string): void {
  const launchArgs = injectModelInstructionsBypassArgs(
    cwd,
    args,
    process.env,
    sessionModelInstructionsPath(cwd, sessionId),
  );
  const omxBin = process.argv[1];
  const hudCmd = buildTmuxShellCommand('node', [omxBin, 'hud', '--watch']);
  const inheritLeaderFlags = process.env[TEAM_INHERIT_LEADER_FLAGS_ENV] !== '0';
  const workerLaunchArgs = resolveTeamWorkerLaunchArgsEnv(
    process.env[TEAM_WORKER_LAUNCH_ARGS_ENV],
    launchArgs,
    inheritLeaderFlags,
  );
  const codexEnv = workerLaunchArgs
    ? { ...process.env, [TEAM_WORKER_LAUNCH_ARGS_ENV]: workerLaunchArgs }
    : process.env;

  if (resolveCodexLaunchPolicy(process.env) === 'inside-tmux') {
    // Already in tmux: launch codex in current pane, HUD in bottom split
    const currentPaneId = process.env.TMUX_PANE;
    const staleHudPaneIds = listHudWatchPaneIdsInCurrentWindow(currentPaneId);
    for (const paneId of staleHudPaneIds) {
      killTmuxPane(paneId);
    }

    let hudPaneId: string | null = null;
    try {
      hudPaneId = createHudWatchPane(cwd, hudCmd);
    } catch {
      // HUD split failed, continue without it
    }

    // Enable mouse scrolling at session start so scroll works before team
    // expansion. Previously this was only called from createTeamSession().
    // Opt-out: set OMX_MOUSE=0. (closes #128)
    if (process.env.OMX_MOUSE !== '0') {
      try {
        const tmuxSession = execFileSync('tmux', ['display-message', '-p', '#S'], { encoding: 'utf-8' }).trim();
        if (tmuxSession) enableMouseScrolling(tmuxSession);
      } catch {
        // Non-fatal: mouse scrolling is a convenience feature
      }
    }

    try {
      execFileSync('codex', launchArgs, { cwd, stdio: 'inherit', env: codexEnv });
    } catch {
      // Codex exited
    } finally {
      const cleanupPaneIds = buildHudPaneCleanupTargets(
        listHudWatchPaneIdsInCurrentWindow(currentPaneId),
        hudPaneId,
        currentPaneId
      );
      for (const paneId of cleanupPaneIds) {
        killTmuxPane(paneId);
      }
    }
  } else {
    // Not in tmux: create a new tmux session with codex + HUD pane
    const codexCmd = buildTmuxShellCommand('codex', launchArgs);
    const tmuxSessionId = `omx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionName = buildTmuxSessionName(cwd, tmuxSessionId);
    try {
      execFileSync(
        'tmux',
        [
          'new-session', '-d', '-s', sessionName, '-c', cwd,
          ...(workerLaunchArgs ? ['-e', `${TEAM_WORKER_LAUNCH_ARGS_ENV}=${workerLaunchArgs}`] : []),
          codexCmd,
          ';',
          'split-window', '-v', '-l', '4', '-d', '-c', cwd, hudCmd,
          // Enable mouse scrolling at session start (closes #128)
          ...(process.env.OMX_MOUSE !== '0' ? [
            ';', 'set-option', '-t', sessionName, 'mouse', 'on',
            ...(isWsl2() ? [';', 'set-option', '-ga', 'terminal-overrides', ',xterm*:XT'] : []),
          ] : []),
          ';',
          'select-pane', '-t', '0',
          ';',
          'attach-session', '-t', sessionName,
        ],
        { stdio: 'inherit' }
      );
    } catch {
      // tmux not available or failed, just run codex directly
      try {
        execFileSync('codex', launchArgs, { cwd, stdio: 'inherit', env: codexEnv });
      } catch {
        // Codex exited
      }
    }
  }
}

function listHudWatchPaneIdsInCurrentWindow(currentPaneId?: string): string[] {
  try {
    const output = execFileSync(
      'tmux',
      ['list-panes', '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}'],
      { encoding: 'utf-8' }
    );
    return findHudWatchPaneIds(parseTmuxPaneSnapshot(output), currentPaneId);
  } catch {
    return [];
  }
}

function createHudWatchPane(cwd: string, hudCmd: string): string | null {
  const output = execFileSync(
    'tmux',
    ['split-window', '-v', '-l', '4', '-d', '-c', cwd, '-P', '-F', '#{pane_id}', hudCmd],
    { encoding: 'utf-8' }
  );
  const paneId = output.split('\n')[0]?.trim() || '';
  return paneId.startsWith('%') ? paneId : null;
}

function killTmuxPane(paneId: string): void {
  if (!paneId.startsWith('%')) return;
  try {
    execFileSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
  } catch {
    // Pane may already be gone; ignore.
  }
}

export function buildTmuxShellCommand(command: string, args: string[]): string {
  return [quoteShellArg(command), ...args.map(quoteShellArg)].join(' ');
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * postLaunch: Clean up after Codex exits.
 * Each step is independently fault-tolerant (try/catch per step).
 */
async function postLaunch(cwd: string, sessionId: string): Promise<void> {
  // Capture session start time before cleanup (writeSessionEnd deletes session.json)
  let sessionStartedAt: string | undefined;
  try {
    const sessionState = await readSessionState(cwd);
    sessionStartedAt = sessionState?.started_at;
  } catch {
    // Non-fatal
  }

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

  // 0. Flush derived watcher once on shutdown (opt-in, best effort).
  try {
    await flushHookDerivedWatcherOnce(cwd);
  } catch {
    // Non-fatal
  }

  // 0.1 Stop derived watcher first (opt-in, best effort).
  try {
    await stopHookDerivedWatcher(cwd);
  } catch {
    // Non-fatal
  }

  // 1. Remove session-scoped model instructions file
  try {
    await removeSessionModelInstructionsFile(cwd, sessionId);
  } catch (err) {
    console.error(`[omx] postLaunch: model instructions cleanup failed: ${err instanceof Error ? err.message : err}`);
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

  // 4. Send session-end lifecycle notification (best effort)
  try {
    const { notifyLifecycle } = await import('../notifications/index.js');
    const durationMs = sessionStartedAt
      ? Date.now() - new Date(sessionStartedAt).getTime()
      : undefined;
    await notifyLifecycle('session-end', {
      sessionId,
      projectPath: cwd,
      projectName: basename(cwd),
      durationMs,
      reason: 'session_exit',
    });
  } catch {
    // Non-fatal: notification failures must never block session cleanup
  }

  // 5. Dispatch native hook event (best effort)
  try {
    const durationMs = sessionStartedAt
      ? Date.now() - new Date(sessionStartedAt).getTime()
      : undefined;
    await emitNativeHookEvent(cwd, 'session-end', {
      session_id: sessionId,
      context: {
        project_path: cwd,
        project_name: basename(cwd),
        duration_ms: durationMs,
        reason: 'session_exit',
      },
    });
  } catch {
    // Non-fatal
  }
}

async function emitNativeHookEvent(
  cwd: string,
  event: 'session-start' | 'session-end' | 'session-idle' | 'turn-complete',
  opts: {
    session_id?: string;
    thread_id?: string;
    turn_id?: string;
    mode?: string;
    context?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const payload = buildHookEvent(event, {
    source: 'native',
    context: opts.context || {},
    session_id: opts.session_id,
    thread_id: opts.thread_id,
    turn_id: opts.turn_id,
    mode: opts.mode,
  });
  await dispatchHookEvent(payload, {
    cwd,
  });
}

function notifyFallbackPidPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'notify-fallback.pid');
}

function hookDerivedWatcherPidPath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'hook-derived-watcher.pid');
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

async function startHookDerivedWatcher(cwd: string): Promise<void> {
  if (process.env.OMX_HOOK_DERIVED_SIGNALS !== '1') return;

  const { mkdir, writeFile, readFile } = await import('fs/promises');
  const pidPath = hookDerivedWatcherPidPath(cwd);
  const pkgRoot = getPackageRoot();
  const watcherScript = join(pkgRoot, 'scripts', 'hook-derived-watcher.js');
  if (!existsSync(watcherScript)) return;

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
    [watcherScript, '--cwd', cwd],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
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

async function stopHookDerivedWatcher(cwd: string): Promise<void> {
  const { readFile, unlink } = await import('fs/promises');
  const pidPath = hookDerivedWatcherPidPath(cwd);
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

async function flushHookDerivedWatcherOnce(cwd: string): Promise<void> {
  if (process.env.OMX_HOOK_DERIVED_SIGNALS !== '1') return;
  const { spawnSync } = await import('child_process');
  const pkgRoot = getPackageRoot();
  const watcherScript = join(pkgRoot, 'scripts', 'hook-derived-watcher.js');
  if (!existsSync(watcherScript)) return;
  spawnSync(process.execPath, [watcherScript, '--once', '--cwd', cwd], {
    cwd,
    stdio: 'ignore',
    timeout: 3000,
    env: {
      ...process.env,
      OMX_HOOK_DERIVED_SIGNALS: '1',
    },
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
