import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { getPackageRoot } from '../utils/package.js';
import { suggestClosest } from './suggestions.js';

type TmuxTargetType = 'session' | 'pane';

interface TmuxHookConfig {
  enabled: boolean;
  target: { type: TmuxTargetType; value: string };
  allowed_modes: string[];
  cooldown_ms: number;
  max_injections_per_session: number;
  prompt_template: string;
  marker: string;
  dry_run: boolean;
  log_level: 'error' | 'info' | 'debug';
}

interface TmuxHookState {
  total_injections?: number;
  session_counts?: Record<string, number>;
  pane_counts?: Record<string, number>;
  last_injection_ts?: number;
  last_reason?: string;
  last_event_at?: string;
  last_target?: string;
}

interface InitialTargetDetection {
  target: { type: TmuxTargetType; value: string };
  sessionName?: string;
}

interface InitConfigResult {
  configPath: string;
  created: boolean;
  usedPlaceholderTarget: boolean;
  detectedSession?: string;
}

const DEFAULT_CONFIG: TmuxHookConfig = {
  enabled: true,
  target: { type: 'pane', value: '' },
  allowed_modes: ['ralph', 'ultrawork', 'team'],
  cooldown_ms: 15000,
  max_injections_per_session: 200,
  prompt_template: 'Continue from current mode state. [OMX_TMUX_INJECT]',
  marker: '[OMX_TMUX_INJECT]',
  dry_run: false,
  log_level: 'info',
};

const HELP = `
Usage:
  omx tmux-hook init       Create .omx/tmux-hook.json
  omx tmux-hook status     Show config + runtime state summary
  omx tmux-hook validate   Validate config and tmux target reachability
  omx tmux-hook test       Run a synthetic notify-hook turn (end-to-end)
`;

export async function tmuxHookCommand(args: string[]): Promise<void> {
  const subcommands = ['init', 'status', 'validate', 'test', 'help'];
  const subcommand = args[0] || 'status';
  switch (subcommand) {
    case 'init':
      await initTmuxHookConfig();
      return;
    case 'status':
      await showTmuxHookStatus();
      return;
    case 'validate':
      await validateTmuxHookConfig();
      return;
    case 'test':
      await testTmuxHook(args.slice(1));
      return;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      {
        const suggestion = suggestClosest(subcommand, subcommands);
        const hint = suggestion ? ` Did you mean: omx tmux-hook ${suggestion}` : '';
        throw new Error(`Unknown tmux-hook subcommand: ${subcommand}.${hint}`);
      }
  }
}

function omxDir(cwd = process.cwd()): string {
  return join(cwd, '.omx');
}

function tmuxHookConfigPath(cwd = process.cwd()): string {
  return join(omxDir(cwd), 'tmux-hook.json');
}

function tmuxHookStatePath(cwd = process.cwd()): string {
  return join(omxDir(cwd), 'state', 'tmux-hook-state.json');
}

function tmuxHookLogPath(cwd = process.cwd()): string {
  return join(omxDir(cwd), 'logs', `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
}

function parseConfig(raw: unknown): TmuxHookConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('tmux-hook config must be a JSON object');
  }
  const parsed = raw as Record<string, unknown>;
  if (parsed.enabled !== true && parsed.enabled !== false) {
    throw new Error('`enabled` must be boolean');
  }
  const target = parsed.target;
  if (!target || typeof target !== 'object') {
    throw new Error('`target` is required');
  }
  const targetObj = target as Record<string, unknown>;
  if (targetObj.type !== 'session' && targetObj.type !== 'pane') {
    throw new Error('`target.type` must be "session" or "pane"');
  }
  if (typeof targetObj.value !== 'string' || targetObj.value.trim() === '') {
    throw new Error('`target.value` must be a non-empty string');
  }

  const allowedModes = parsed.allowed_modes;
  if (!Array.isArray(allowedModes) || allowedModes.length === 0 || allowedModes.some(v => typeof v !== 'string')) {
    throw new Error('`allowed_modes` must be a non-empty string array');
  }

  const cooldown = parsed.cooldown_ms;
  const maxInjections = parsed.max_injections_per_session;
  if (typeof cooldown !== 'number' || cooldown < 0 || !Number.isFinite(cooldown)) {
    throw new Error('`cooldown_ms` must be a non-negative number');
  }
  if (typeof maxInjections !== 'number' || maxInjections < 1 || !Number.isFinite(maxInjections)) {
    throw new Error('`max_injections_per_session` must be >= 1');
  }

  const promptTemplate = parsed.prompt_template;
  const marker = parsed.marker;
  if (typeof promptTemplate !== 'string' || promptTemplate.trim() === '') {
    throw new Error('`prompt_template` must be a non-empty string');
  }
  if (typeof marker !== 'string' || marker.trim() === '') {
    throw new Error('`marker` must be a non-empty string');
  }

  if (parsed.dry_run !== true && parsed.dry_run !== false) {
    throw new Error('`dry_run` must be boolean');
  }
  if (parsed.log_level !== 'error' && parsed.log_level !== 'info' && parsed.log_level !== 'debug') {
    throw new Error('`log_level` must be one of: error, info, debug');
  }

  return {
    enabled: parsed.enabled,
    target: { type: targetObj.type, value: targetObj.value },
    allowed_modes: allowedModes,
    cooldown_ms: cooldown,
    max_injections_per_session: maxInjections,
    prompt_template: promptTemplate,
    marker,
    dry_run: parsed.dry_run,
    log_level: parsed.log_level,
  };
}

async function readValidatedConfig(cwd = process.cwd()): Promise<TmuxHookConfig> {
  const configPath = tmuxHookConfigPath(cwd);
  if (!existsSync(configPath)) {
    throw new Error('tmux-hook config missing. Run: omx tmux-hook init');
  }
  const content = await readFile(configPath, 'utf-8');
  return parseConfig(JSON.parse(content));
}

async function loadConfigForCommand(
  commandName: 'status' | 'validate' | 'test',
  cwd = process.cwd(),
): Promise<{ config: TmuxHookConfig; initResult: InitConfigResult | null }> {
  const configPath = tmuxHookConfigPath(cwd);
  let initResult: InitConfigResult | null = null;

  if (!existsSync(configPath)) {
    initResult = await initTmuxHookConfig({ silent: true, cwd });
    if (initResult.created) {
      console.log(`No tmux-hook config found. Created ${initResult.configPath}.`);
      if (initResult.detectedSession) {
        console.log(`Detected tmux session: ${initResult.detectedSession}`);
      }
      if (initResult.usedPlaceholderTarget) {
        console.log('Could not auto-detect a tmux target. Edit `.omx/tmux-hook.json` when ready.');
        if (commandName === 'validate') {
          console.log('Validation skipped until `target.value` is configured.');
        }
      }
    }
  }

  return { config: await readValidatedConfig(cwd), initResult };
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

function resolveValidateTarget(config: TmuxHookConfig): { ok: true; target: string } | { ok: false; reason: string } {
  if (config.target.type === 'pane') {
    const paneCheck = runTmux(['display-message', '-p', '-t', config.target.value, '#{pane_id}']);
    if (!paneCheck.ok || paneCheck.stdout === '') {
      return { ok: false, reason: paneCheck.ok ? 'pane not found' : paneCheck.stderr };
    }
    return { ok: true, target: paneCheck.stdout };
  }

  const paneList = runTmux(['list-panes', '-t', config.target.value, '-F', '#{pane_id} #{pane_active}']);
  if (!paneList.ok) {
    return { ok: false, reason: paneList.stderr };
  }
  const lines = paneList.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, reason: 'session has no panes' };
  }
  const active = lines.find(line => line.endsWith(' 1')) || lines[0];
  const paneId = active.split(' ')[0];
  if (!paneId) {
    return { ok: false, reason: 'failed to resolve pane id from session' };
  }
  return { ok: true, target: paneId };
}

function detectActivePaneFromList(): InitialTargetDetection | null {
  const paneList = runTmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_active}\t#{session_name}']);
  if (!paneList.ok || paneList.stdout.trim() === '') return null;

  const rows = paneList.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split('\t'))
    .filter(parts => parts.length >= 3);
  if (rows.length === 0) return null;

  const active = rows.find(parts => parts[1] === '1') || rows[0];
  const paneId = (active?.[0] || '').trim();
  const sessionName = (active?.[2] || '').trim();
  if (!paneId) return null;

  return {
    target: { type: 'pane', value: paneId },
    sessionName: sessionName || undefined,
  };
}

function detectInitialTarget(): InitialTargetDetection | null {
  const tmuxPaneEnv = process.env.TMUX_PANE;
  if (tmuxPaneEnv) {
    const pane = runTmux(['display-message', '-p', '-t', tmuxPaneEnv, '#{pane_id}']);
    if (pane.ok && pane.stdout) {
      const session = runTmux(['display-message', '-p', '-t', tmuxPaneEnv, '#S']);
      return {
        target: { type: 'pane', value: pane.stdout },
        sessionName: session.ok && session.stdout ? session.stdout : undefined,
      };
    }
  }

  const currentClientPane = runTmux(['display-message', '-p', '#{pane_id}']);
  if (currentClientPane.ok && currentClientPane.stdout) {
    const session = runTmux(['display-message', '-p', '#S']);
    return {
      target: { type: 'pane', value: currentClientPane.stdout },
      sessionName: session.ok && session.stdout ? session.stdout : undefined,
    };
  }

  const activePane = detectActivePaneFromList();
  if (activePane) return activePane;

  const sessions = runTmux(['list-sessions', '-F', '#{session_name}']);
  if (sessions.ok && sessions.stdout.trim() !== '') {
    const firstSession = sessions.stdout
      .split('\n')
      .map(line => line.trim())
      .find(Boolean);
    if (firstSession) {
      return {
        target: { type: 'session', value: firstSession },
        sessionName: firstSession,
      };
    }
  }

  return null;
}

async function initTmuxHookConfig(opts?: { silent?: boolean; cwd?: string }): Promise<InitConfigResult> {
  const cwd = opts?.cwd ?? process.cwd();
  const silent = opts?.silent ?? false;
  const configPath = tmuxHookConfigPath(cwd);
  await mkdir(omxDir(cwd), { recursive: true });

  if (existsSync(configPath)) {
    if (!silent) {
      console.log(`tmux-hook config already exists: ${configPath}`);
    }
    return { configPath, created: false, usedPlaceholderTarget: false };
  }

  const detected = detectInitialTarget();
  const initial = {
    ...DEFAULT_CONFIG,
    target: detected?.target ?? { type: 'pane' as const, value: 'replace-with-tmux-pane-id' },
  };
  await writeFile(configPath, JSON.stringify(initial, null, 2) + '\n');

  const result: InitConfigResult = {
    configPath,
    created: true,
    usedPlaceholderTarget: !detected,
    detectedSession: detected?.sessionName,
  };

  if (!silent) {
    console.log(`Created ${configPath}`);
    console.log('Feature is enabled by default (`"enabled": true`).');
    if (detected) {
      console.log(`Detected target: ${detected.target.type}:${detected.target.value}`);
    }
    if (detected?.sessionName) {
      console.log(`Detected tmux session: ${detected.sessionName}`);
    }
    if (!detected) {
      console.log('No running tmux target detected. Update `target.value` when ready.');
    }
  }

  return result;
}

export async function ensureTmuxHookInitialized(cwd = process.cwd()): Promise<void> {
  try {
    await initTmuxHookConfig({ silent: true, cwd });
  } catch {
    // Best-effort only: state tools must remain available even without tmux.
  }
}

async function showTmuxHookStatus(): Promise<void> {
  const cwd = process.cwd();
  const statePath = tmuxHookStatePath(cwd);
  const logPath = tmuxHookLogPath(cwd);

  console.log('tmux-hook status');
  console.log('----------------');
  const { config, initResult } = await loadConfigForCommand('status', cwd);
  const configPath = tmuxHookConfigPath(cwd);
  console.log(`Config: ${configPath}`);
  console.log(`Enabled: ${config.enabled ? 'yes' : 'no'}`);
  console.log(`Target: ${config.target.type}:${config.target.value}`);
  if (initResult?.usedPlaceholderTarget) {
    console.log('Target Status: placeholder (set `target.value` to enable injection)');
  }
  console.log(`Allowed Modes: ${config.allowed_modes.join(', ')}`);
  console.log(`Cooldown: ${config.cooldown_ms}ms`);
  console.log(`Max Injections/Pane: ${config.max_injections_per_session}`);
  console.log(`Dry Run: ${config.dry_run ? 'yes' : 'no'}`);

  if (!existsSync(statePath)) {
    console.log(`State: missing (${statePath})`);
  } else {
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as TmuxHookState;
    console.log(`State: ${statePath}`);
    console.log(`Total Injections: ${state.total_injections ?? 0}`);
    console.log(`Last Reason: ${state.last_reason ?? 'n/a'}`);
    console.log(`Last Event: ${state.last_event_at ?? 'n/a'}`);
    console.log(`Last Target: ${state.last_target ?? 'n/a'}`);
    const panes = state.pane_counts ? Object.keys(state.pane_counts).length : 0;
    const legacySessions = state.session_counts ? Object.keys(state.session_counts).length : 0;
    console.log(`Tracked Panes: ${panes}`);
    if (legacySessions > 0) {
      console.log(`Tracked Sessions (legacy): ${legacySessions}`);
    }
  }

  console.log(`Log (today): ${existsSync(logPath) ? logPath : 'none yet'}`);
}

async function validateTmuxHookConfig(): Promise<void> {
  const cwd = process.cwd();
  const { config, initResult } = await loadConfigForCommand('validate', cwd);
  if (initResult?.usedPlaceholderTarget) {
    return;
  }
  const resolved = resolveValidateTarget(config);

  if (!resolved.ok) {
    throw new Error(`tmux target validation failed: ${resolved.reason}`);
  }

  console.log('tmux-hook config is valid.');
  console.log(`Resolved target pane: ${resolved.target}`);
  console.log(`Mode gating: ${config.allowed_modes.join(', ')}`);
  if (!config.enabled) {
    console.log('Note: config is currently disabled (`enabled: false`).');
  }
}

async function testTmuxHook(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const { initResult } = await loadConfigForCommand('test', cwd);
  if (initResult?.usedPlaceholderTarget) {
    console.log('Proceeding with placeholder target; notify-hook may log `invalid_config` skips.');
  }
  const pkgRoot = getPackageRoot();
  const notifyHook = join(pkgRoot, 'scripts', 'notify-hook.js');
  if (!existsSync(notifyHook)) {
    throw new Error(`notify-hook.js not found at ${notifyHook}`);
  }

  const threadId = `tmux-test-${Date.now()}`;
  const turnId = `turn-${Date.now()}`;
  const message = args.join(' ').trim() || 'tmux-hook test payload';
  const payload = {
    type: 'agent-turn-complete',
    cwd,
    'thread-id': threadId,
    'turn-id': turnId,
    'input-messages': ['omx tmux-hook test'],
    'last-assistant-message': message,
  };

  const result = spawnSync(process.execPath, [notifyHook, JSON.stringify(payload)], {
    cwd,
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(`failed to run notify-hook: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`notify-hook exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }

  console.log('tmux-hook test: notify-hook executed.');
  console.log(`thread_id=${threadId}`);
  console.log(`turn_id=${turnId}`);
  console.log('Check: .omx/logs/tmux-hook-YYYY-MM-DD.jsonl for skip/reason codes.');
}
