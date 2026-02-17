import { spawnSync } from 'child_process';
import { join } from 'path';

export interface TeamSession {
  name: string; // tmux target in "session:window" form
  workerCount: number;
  cwd: string;
  workerPaneIds: string[];
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';
const MADMAX_FLAG = '--madmax';
const CONFIG_FLAG = '-c';
const LONG_CONFIG_FLAG = '--config';
const MODEL_INSTRUCTIONS_FILE_KEY = 'model_instructions_file';
const OMX_BYPASS_DEFAULT_SYSTEM_PROMPT_ENV = 'OMX_BYPASS_DEFAULT_SYSTEM_PROMPT';
const OMX_MODEL_INSTRUCTIONS_FILE_ENV = 'OMX_MODEL_INSTRUCTIONS_FILE';

interface WorkerLaunchSpec {
  shell: string;
  rcFile: string | null;
}

interface TmuxPaneInfo {
  paneId: string;
  currentCommand: string;
  startCommand: string;
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) {
    return { ok: false, stderr: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

function baseSessionName(target: string): string {
  return target.split(':')[0] || target;
}

function listPanes(target: string): TmuxPaneInfo[] {
  const result = runTmux(['list-panes', '-t', target, '-F', '#{pane_id}\t#{pane_current_command}\t#{pane_start_command}']);
  if (!result.ok) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId = '', currentCommand = '', startCommand = ''] = line.split('\t');
      return { paneId, currentCommand, startCommand };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

function isHudWatchPane(pane: TmuxPaneInfo): boolean {
  const start = pane.startCommand || '';
  return /\bomx\b.*\bhud\b.*--watch/i.test(start);
}

function findHudPaneIds(target: string, leaderPaneId: string): string[] {
  const panes = listPanes(target);
  return panes
    .filter((pane) => pane.paneId !== leaderPaneId)
    .filter((pane) => isHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

function sleepSeconds(seconds: number): void {
  // shelling out keeps implementation consistent with the project's pattern
  spawnSync('sleep', [String(seconds)], { encoding: 'utf-8' });
}

function sleepFractionalSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  spawnSync('sleep', [String(seconds)], { encoding: 'utf-8' });
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWorkerLaunchSpec(shellPath: string | undefined): WorkerLaunchSpec {
  if (shellPath && /\/zsh$/i.test(shellPath)) {
    return { shell: shellPath, rcFile: '~/.zshrc' };
  }
  if (shellPath && /\/bash$/i.test(shellPath)) {
    return { shell: shellPath, rcFile: '~/.bashrc' };
  }
  if (shellPath && shellPath.trim() !== '') {
    return { shell: shellPath, rcFile: null };
  }
  return { shell: '/bin/sh', rcFile: null };
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

function buildModelInstructionsOverride(cwd: string, env: NodeJS.ProcessEnv): string {
  const filePath = env[OMX_MODEL_INSTRUCTIONS_FILE_ENV] || join(cwd, 'AGENTS.md');
  return `${MODEL_INSTRUCTIONS_FILE_KEY}="${escapeTomlString(filePath)}"`;
}

function resolveWorkerLaunchArgs(extraArgs: string[] = [], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const merged = [...extraArgs];
  const wantsBypass = process.argv.includes(CODEX_BYPASS_FLAG) || process.argv.includes(MADMAX_FLAG);
  if (wantsBypass && !merged.includes(CODEX_BYPASS_FLAG)) {
    merged.push(CODEX_BYPASS_FLAG);
  }
  if (shouldBypassDefaultSystemPrompt(env) && !hasModelInstructionsOverride(merged)) {
    merged.push(CONFIG_FLAG, buildModelInstructionsOverride(cwd, env));
  }
  return merged;
}

export function buildWorkerStartupCommand(
  teamName: string,
  workerIndex: number,
  launchArgs: string[] = [],
  cwd: string = process.cwd(),
): string {
  const spec = buildWorkerLaunchSpec(process.env.SHELL);
  const fullLaunchArgs = resolveWorkerLaunchArgs(launchArgs, cwd);
  const codexArgs = fullLaunchArgs.map(shellQuoteSingle).join(' ');
  const codexInvocation = codexArgs.length > 0 ? `exec codex ${codexArgs}` : 'exec codex';
  const rcPrefix = spec.rcFile ? `if [ -f ${spec.rcFile} ]; then source ${spec.rcFile}; fi; ` : '';
  const inner = `${rcPrefix}${codexInvocation}`;

  return `env OMX_TEAM_WORKER=${teamName}/worker-${workerIndex} ${shellQuoteSingle(spec.shell)} -lc ${shellQuoteSingle(inner)}`;
}

// Sanitize team name: lowercase, alphanumeric + hyphens, max 30 chars
export function sanitizeTeamName(name: string): string {
  const lowered = name.toLowerCase();
  const replaced = lowered
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '');

  const truncated = replaced.slice(0, 30).replace(/-$/, '');
  if (truncated.trim() === '') {
    throw new Error('sanitizeTeamName: empty after sanitization');
  }
  return truncated;
}

// Check if tmux is available
export function isTmuxAvailable(): boolean {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf-8' });
  if (result.error) return false;
  return result.status === 0;
}

// Create tmux session with N worker windows
// Split the current tmux leader window into worker panes.
// Returns TeamSession or throws if tmux not available
export function createTeamSession(
  teamName: string,
  workerCount: number,
  cwd: string,
  workerLaunchArgs: string[] = [],
): TeamSession {
  if (!isTmuxAvailable()) {
    throw new Error('tmux is not available');
  }
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error(`workerCount must be >= 1 (got ${workerCount})`);
  }
  if (!process.env.TMUX) {
    throw new Error('team mode requires running inside tmux leader pane');
  }

  const safeTeamName = sanitizeTeamName(teamName);
  const context = runTmux(['display-message', '-p', '#S:#I #{pane_id}']);
  if (!context.ok) {
    throw new Error(`failed to detect current tmux target: ${context.stderr}`);
  }
  const [sessionAndWindow = '', leaderPaneId = ''] = context.stdout.split(' ');
  const [sessionName, windowIndex] = (sessionAndWindow || '').split(':');
  if (!sessionName || !windowIndex || !leaderPaneId || !leaderPaneId.startsWith('%')) {
    throw new Error(`failed to parse current tmux target: ${context.stdout}`);
  }
  const teamTarget = `${sessionName}:${windowIndex}`;
  const initialHudPaneIds = findHudPaneIds(teamTarget, leaderPaneId);
  // Team mode prioritizes leader + worker visibility. Remove HUD panes in this window
  // to keep a clean "leader left / workers right" layout.
  for (const hudPaneId of initialHudPaneIds) {
    runTmux(['kill-pane', '-t', hudPaneId]);
  }

  const workerPaneIds: string[] = [];
  let rightStackRootPaneId: string | null = null;
  for (let i = 1; i <= workerCount; i++) {
    const cmd = buildWorkerStartupCommand(safeTeamName, i, workerLaunchArgs, cwd);
    // First split creates the right side from leader. Remaining splits stack on the right.
    const splitDirection = i === 1 ? '-h' : '-v';
    const splitTarget = i === 1 ? leaderPaneId : (rightStackRootPaneId ?? leaderPaneId);
    const split = runTmux([
      'split-window',
      splitDirection,
      '-t',
      splitTarget,
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-c',
      cwd,
      cmd,
    ]);
    if (!split.ok) {
      throw new Error(`failed to create worker pane ${i}: ${split.stderr}`);
    }
    const paneId = split.stdout.split('\n')[0]?.trim();
    if (!paneId || !paneId.startsWith('%')) {
      throw new Error(`failed to capture worker pane id for worker ${i}`);
    }
    workerPaneIds.push(paneId);
    if (i === 1) rightStackRootPaneId = paneId;
  }

  // Keep leader as full left/main pane; workers stay stacked on the right.
  runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);

  // Force leader pane to use half the window width.
  const windowWidthResult = runTmux(['display-message', '-p', '-t', teamTarget, '#{window_width}']);
  if (windowWidthResult.ok) {
    const width = Number.parseInt(windowWidthResult.stdout.split('\n')[0]?.trim() || '', 10);
    if (Number.isFinite(width) && width >= 40) {
      const half = String(Math.floor(width / 2));
      runTmux(['set-window-option', '-t', teamTarget, 'main-pane-width', half]);
      runTmux(['select-layout', '-t', teamTarget, 'main-vertical']);
    }
  }

  // Re-create a single HUD pane under the leader column for team visibility.
  // Keep this after layout sizing so HUD does not get mixed into worker stack.
  const omxEntry = process.argv[1];
  if (omxEntry && omxEntry.trim() !== '') {
    const hudCmd = `node ${shellQuoteSingle(omxEntry)} hud --watch`;
    runTmux(['split-window', '-v', '-l', '4', '-t', leaderPaneId, '-d', '-c', cwd, hudCmd]);
  }

  runTmux(['select-pane', '-t', leaderPaneId]);
  sleepSeconds(0.5);

  return { name: teamTarget, workerCount, cwd, workerPaneIds };
}

function paneTarget(sessionName: string, workerIndex: number, workerPaneId?: string): string {
  if (workerPaneId && workerPaneId.startsWith('%')) return workerPaneId;
  if (sessionName.includes(':')) {
    return `${sessionName}.${workerIndex}`;
  }
  return `${sessionName}:${workerIndex}`;
}

function paneLooksReady(captured: string): boolean {
  const content = captured.trimEnd();
  if (content === '') return false;

  const lines = content
    .split('\n')
    .map(l => l.replace(/\r/g, ''))
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '');

  const lastLine = lines.length > 0 ? lines[lines.length - 1] : '';
  if (/^\s*[›>]\s*/.test(lastLine)) return true;

  // Codex TUI often renders a status bar/footer instead of a raw shell prompt.
  // Treat common Codex UI markers as "ready enough" for inbox-trigger dispatch.
  const hasCodexPromptLine = lines.some((line) => /^\s*›\s*/u.test(line));
  const hasCodexStatus = lines.some((line) => /\bgpt-[\w.-]+\b/i.test(line) || /\b\d+% left\b/i.test(line));
  if (hasCodexPromptLine || hasCodexStatus) return true;

  return false;
}

function paneHasTrustPrompt(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);
  const tail = lines.slice(-12);
  const hasQuestion = tail.some((line) => /Do you trust the contents of this directory\?/i.test(line));
  const hasActiveChoices = tail.some((line) => /Yes,\s*continue|No,\s*quit|Press enter to continue/i.test(line));
  return hasQuestion && hasActiveChoices;
}

function paneHasActiveTask(captured: string): boolean {
  const lines = captured
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter((line) => line.length > 0);

  const tail = lines.slice(-40);
  if (tail.some((line) => /esc to interrupt/i.test(line))) return true;
  if (tail.some((line) => /\bbackground terminal running\b/i.test(line))) return true;
  // Typical Codex activity line: "• Doing X (3m 12s • esc to interrupt)"
  if (tail.some((line) => /^•\s.+\(.+•\s*esc to interrupt\)$/i.test(line))) return true;
  return false;
}

function resolveSendStrategyFromEnv(): 'auto' | 'queue' | 'interrupt' {
  const raw = String(process.env.OMX_TEAM_SEND_STRATEGY || '')
    .trim()
    .toLowerCase();
  if (raw === 'interrupt' || raw === 'queue' || raw === 'auto') {
    return raw;
  }
  return 'auto';
}

function sendKeyOrThrow(target: string, key: string, label: string): void {
  const result = runTmux(['send-keys', '-t', target, key]);
  if (!result.ok) {
    throw new Error(`sendToWorker: failed to send ${label}: ${result.stderr}`);
  }
}

// Poll tmux capture-pane for Codex prompt indicator (> or similar)
// Uses exponential backoff: 1s, 2s, 4s, 8s (total ~15s)
// Returns true if ready, false on timeout
export function waitForWorkerReady(
  sessionName: string,
  workerIndex: number,
  timeoutMs: number = 15000,
  workerPaneId?: string,
): boolean {
  const initialBackoffMs = 300;
  const maxBackoffMs = 8000;
  const startedAt = Date.now();
  let blockedByTrustPrompt = false;

  const sendRobustEnter = (): void => {
    const target = paneTarget(sessionName, workerIndex, workerPaneId);
    // Trust + follow-up splash can require two submits in Codex TUI.
    // Use C-m (carriage return) instead of Enter for raw-mode compatibility.
    runTmux(['send-keys', '-t', target, 'C-m']);
    sleepFractionalSeconds(0.12);
    runTmux(['send-keys', '-t', target, 'C-m']);
  };

  const check = (): boolean => {
    const result = runTmux(['capture-pane', '-t', paneTarget(sessionName, workerIndex, workerPaneId), '-p']);
    if (!result.ok) return false;
    if (paneHasTrustPrompt(result.stdout)) {
      // Default-on for team workers: they are spawned explicitly by the leader in the same cwd.
      // Opt-out by setting OMX_TEAM_AUTO_TRUST=0.
      if (process.env.OMX_TEAM_AUTO_TRUST !== '0') {
        sendRobustEnter();
        return false;
      }
      blockedByTrustPrompt = true;
      return false;
    }
    return paneLooksReady(result.stdout);
  };

  let delayMs = initialBackoffMs;
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return true;
    if (blockedByTrustPrompt) return false;
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    sleepSeconds(Math.max(0, Math.min(delayMs, remaining)) / 1000);
    delayMs = Math.min(maxBackoffMs, delayMs * 2);
  }

  return false;
}

function paneTailContainsLiteralLine(target: string, text: string): boolean {
  const result = runTmux(['capture-pane', '-t', target, '-p', '-S', '-80']);
  if (!result.ok) return false;
  return normalizeTmuxCapture(result.stdout).includes(normalizeTmuxCapture(text));
}

export function normalizeTmuxCapture(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Send SHORT text (<200 chars) to worker via tmux send-keys
// Validates: text < 200 chars, no injection marker
// Throws on violation
export function sendToWorker(sessionName: string, workerIndex: number, text: string, workerPaneId?: string): void {
  if (text.length >= 200) {
    throw new Error('sendToWorker: text must be < 200 characters');
  }
  if (text.includes(INJECTION_MARKER)) {
    throw new Error('sendToWorker: injection marker is not allowed');
  }

  const target = paneTarget(sessionName, workerIndex, workerPaneId);
  const strategy = resolveSendStrategyFromEnv();

  // Guard: if the trust prompt is still present, advance it first so our trigger text
  // doesn't get typed into the trust screen and ignored.
  const captured = runTmux(['capture-pane', '-t', target, '-p', '-S', '-80']);
  const paneBusy = captured.ok ? paneHasActiveTask(captured.stdout) : false;
  if (captured.ok && paneHasTrustPrompt(captured.stdout)) {
    sendKeyOrThrow(target, 'C-m', 'C-m');
    sleepFractionalSeconds(0.12);
    sendKeyOrThrow(target, 'C-m', 'C-m');
    sleepFractionalSeconds(0.2);
  }

  const send = runTmux(['send-keys', '-t', target, '-l', '--', text]);
  if (!send.ok) {
    throw new Error(`sendToWorker: failed to send text: ${send.stderr}`);
  }

  // Allow the input buffer to settle before sending Enter
  sleepFractionalSeconds(0.15);

  const shouldInterrupt = strategy === 'interrupt';
  const shouldQueueFirst = strategy === 'queue' || (strategy === 'auto' && paneBusy);
  if (shouldInterrupt) {
    // Explicit interrupt mode: abort current turn first, then submit the new command.
    sendKeyOrThrow(target, 'C-c', 'C-c');
    sleepFractionalSeconds(0.1);
  }

  // Submit deterministically: C-m twice with short sleep between presses.
  // When worker is busy, first attempt uses Tab+C-m to leverage Codex queue semantics.
  // If that fails, fall back to legacy C-m-based submit rounds.
  const submitRounds = 6;
  for (let round = 0; round < submitRounds; round++) {
    sleepFractionalSeconds(0.1);
    if (round === 0 && shouldQueueFirst) {
      sendKeyOrThrow(target, 'Tab', 'Tab');
      sleepFractionalSeconds(0.08);
      sendKeyOrThrow(target, 'C-m', 'C-m');
    } else {
      sendKeyOrThrow(target, 'C-m', 'C-m');
      sleepFractionalSeconds(0.2);
      sendKeyOrThrow(target, 'C-m', 'C-m');
    }
    sleepFractionalSeconds(0.14);
    if (!paneTailContainsLiteralLine(target, text)) return;
    sleepFractionalSeconds(0.14);
  }

  // Fail-open by default: Codex may keep the last submitted line visible even after executing it.
  // If you need strictness for debugging, set OMX_TEAM_STRICT_SUBMIT=1.
  const strict = process.env.OMX_TEAM_STRICT_SUBMIT === '1';
  if (strict) {
    throw new Error('sendToWorker: submit_failed (trigger text still visible after retries)');
  }

  // One last best-effort double C-m nudge, then continue.
  runTmux(['send-keys', '-t', target, 'C-m']);
  sleepFractionalSeconds(0.12);
  runTmux(['send-keys', '-t', target, 'C-m']);
}

export function notifyLeaderStatus(sessionName: string, message: string): boolean {
  if (!isTmuxAvailable()) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;
  const capped = trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
  const result = runTmux(['display-message', '-t', sessionName, '--', capped]);
  return result.ok;
}

// Get PID of the shell process in a worker's tmux pane
export function getWorkerPanePid(sessionName: string, workerIndex: number, workerPaneId?: string): number | null {
  const result = runTmux(['list-panes', '-t', paneTarget(sessionName, workerIndex, workerPaneId), '-F', '#{pane_pid}']);
  if (!result.ok) return null;

  const firstLine = result.stdout.split('\n')[0]?.trim();
  if (!firstLine) return null;

  const pid = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(pid)) return null;
  return pid;
}

// Check if worker's tmux pane has a running process
export function isWorkerAlive(sessionName: string, workerIndex: number, workerPaneId?: string): boolean {
  const result = runTmux([
    'list-panes',
    '-t', paneTarget(sessionName, workerIndex, workerPaneId),
    '-F',
    '#{pane_dead} #{pane_pid}',
  ]);
  if (!result.ok) return false;

  const line = result.stdout.split('\n')[0]?.trim();
  if (!line) return false;

  const parts = line.split(/\s+/);
  if (parts.length < 2) return false;

  const paneDead = parts[0];
  const pid = Number.parseInt(parts[1], 10);

  if (paneDead === '1') return false;
  if (!Number.isFinite(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill a specific worker: send C-c, then C-d, then kill-pane if still alive
export function killWorker(sessionName: string, workerIndex: number, workerPaneId?: string): void {
  runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-c']);
  sleepSeconds(1);

  if (isWorkerAlive(sessionName, workerIndex, workerPaneId)) {
    runTmux(['send-keys', '-t', paneTarget(sessionName, workerIndex, workerPaneId), 'C-d']);
    sleepSeconds(1);
  }

  if (isWorkerAlive(sessionName, workerIndex, workerPaneId)) {
    runTmux(['kill-pane', '-t', paneTarget(sessionName, workerIndex, workerPaneId)]);
  }
}

export function killWorkerByPaneId(workerPaneId: string): void {
  if (!workerPaneId.startsWith('%')) return;
  runTmux(['kill-pane', '-t', workerPaneId]);
}

// Kill entire tmux session. Tolerates already-dead sessions.
export function destroyTeamSession(sessionName: string): void {
  try {
    runTmux(['kill-session', '-t', sessionName]);
  } catch {
    // tolerate
  }
}

// List all tmux sessions matching omx-team-* pattern
export function listTeamSessions(): string[] {
  const result = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (!result.ok) return [];

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(baseSessionName);
}
