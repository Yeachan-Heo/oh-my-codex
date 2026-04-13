import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { spawnSync } from 'child_process';
import { sleepSync } from '../../../utils/sleep.js';
import { resolveCodexPane } from '../../../scripts/tmux-hook-engine.js';
import { resolveTmuxBinaryForPlatform } from '../../../utils/platform-command.js';
import type {
  HookEventEnvelope,
  HookPluginSdk,
  HookPluginSendKeysOptions,
  HookPluginSendKeysResult,
} from '../types.js';
import { appendHookPluginLog } from './logging.js';
import { hookPluginTmuxStatePath } from './paths.js';

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

interface PluginTmuxState {
  last_sent_at: number;
  recent_keys: Record<string, number>;
}

interface HookPluginTmuxApiOptions {
  cwd: string;
  pluginName: string;
  event: HookEventEnvelope;
  sideEffectsEnabled?: boolean;
}

function asPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readJsonIfExists<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function hashDedupeKey(target: string, text: string): string {
  return createHash('sha256').update(`${target}|${text}`).digest('hex');
}

function sleepFractionalSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  sleepSync(Math.round(seconds * 1000));
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync(resolveTmuxBinaryForPlatform() || 'tmux', args, { encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
}

function isHudStartCommand(startCommand: string): boolean {
  return /\bomx\b.*\bhud\b.*--watch/i.test(startCommand);
}

function resolveSessionPaneTarget(sessionName: string): HookPluginSendKeysResult {
  const paneList = runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id}\t#{pane_active}\t#{pane_start_command}']);
  if (!paneList.ok) {
    return { ok: false, reason: 'target_missing', error: paneList.stderr };
  }

  const rows = paneList.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [paneId = '', activeRaw = '0', startCommand = ''] = line.split('\t');
      return {
        paneId,
        active: activeRaw === '1',
        startCommand: startCommand.trim(),
      };
    })
    .filter((row) => row.paneId.startsWith('%'));

  if (rows.length === 0) return { ok: false, reason: 'target_missing' };

  const nonHudRows = rows.filter((row) => !isHudStartCommand(row.startCommand));
  const canonicalRows = nonHudRows.filter((row) => /\bcodex\b/i.test(row.startCommand));
  const resolved = canonicalRows.find((row) => row.active)
    || canonicalRows[0]
    || nonHudRows.find((row) => row.active)
    || nonHudRows[0];

  if (!resolved) return { ok: false, reason: 'target_missing' };
  return { ok: true, reason: 'ok', target: resolved.paneId, paneId: resolved.paneId };
}

function resolveTmuxTarget(options: HookPluginSendKeysOptions): HookPluginSendKeysResult {
  const paneId = typeof options.paneId === 'string' ? options.paneId.trim() : '';
  if (paneId) {
    const pane = runTmux(['display-message', '-p', '-t', paneId, '#{pane_id}']);
    if (pane.ok && pane.stdout) return { ok: true, reason: 'ok', target: pane.stdout, paneId: pane.stdout };
    return { ok: false, reason: 'target_missing', error: pane.ok ? 'pane_not_found' : pane.stderr };
  }

  const sessionName = typeof options.sessionName === 'string' ? options.sessionName.trim() : '';
  if (sessionName) {
    return resolveSessionPaneTarget(sessionName);
  }

  const envPane = String(resolveCodexPane() || '').trim();
  if (envPane) return { ok: true, reason: 'ok', target: envPane, paneId: envPane };

  return { ok: false, reason: 'target_missing' };
}

async function sendTmuxKeys(
  options: HookPluginSendKeysOptions,
  context: HookPluginTmuxApiOptions,
): Promise<HookPluginSendKeysResult> {
  if (!context.sideEffectsEnabled) {
    return { ok: false, reason: 'side_effects_disabled' };
  }

  const text = typeof options.text === 'string' ? options.text : '';
  if (!text.trim()) {
    return { ok: false, reason: 'invalid_text' };
  }

  const marker = process.env.OMX_HOOK_PLUGIN_LOOP_MARKER || '[OMX_HOOK_PLUGIN]';
  if (marker && text.includes(marker)) {
    return { ok: false, reason: 'loop_guard_input_marker' };
  }

  const targetResolution = resolveTmuxTarget(options);
  if (!targetResolution.ok || !targetResolution.target) {
    return targetResolution;
  }

  const tmuxStatePath = hookPluginTmuxStatePath(context.cwd, context.pluginName);
  await mkdir(dirname(tmuxStatePath), { recursive: true });
  const tmuxState = await readJsonIfExists<PluginTmuxState>(tmuxStatePath, {
    last_sent_at: 0,
    recent_keys: {},
  });

  const now = Date.now();
  const cooldownMs = typeof options.cooldownMs === 'number'
    ? Math.max(0, options.cooldownMs)
    : asPositiveNumber(process.env.OMX_HOOK_PLUGIN_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
  const dedupeWindowMs = asPositiveNumber(process.env.OMX_HOOK_PLUGIN_DEDUPE_MS, DEFAULT_DEDUPE_WINDOW_MS);
  const minTs = now - dedupeWindowMs;

  tmuxState.recent_keys = Object.fromEntries(
    Object.entries(tmuxState.recent_keys || {}).filter(([, ts]) => Number.isFinite(ts) && ts >= minTs),
  );

  if (cooldownMs > 0 && now - (tmuxState.last_sent_at || 0) < cooldownMs) {
    return { ok: false, reason: 'cooldown_active', target: targetResolution.target, paneId: targetResolution.target };
  }

  const dedupeKey = hashDedupeKey(targetResolution.target, text);
  if (tmuxState.recent_keys[dedupeKey]) {
    return { ok: false, reason: 'duplicate_event', target: targetResolution.target, paneId: targetResolution.target };
  }

  const markedText = `${text} ${INJECTION_MARKER}`;
  const typed = runTmux(['send-keys', '-t', targetResolution.target, '-l', markedText]);
  if (!typed.ok) {
    return {
      ok: false,
      reason: 'tmux_failed',
      target: targetResolution.target,
      paneId: targetResolution.target,
      error: typed.stderr,
    };
  }

  if (options.submit !== false) {
    sleepFractionalSeconds(0.12);
    const submitA = runTmux(['send-keys', '-t', targetResolution.target, 'C-m']);
    sleepFractionalSeconds(0.1);
    const submitB = runTmux(['send-keys', '-t', targetResolution.target, 'C-m']);
    if (!submitA.ok && !submitB.ok) {
      return {
        ok: false,
        reason: 'tmux_failed',
        target: targetResolution.target,
        paneId: targetResolution.target,
        error: submitA.stderr || submitB.stderr,
      };
    }
  }

  tmuxState.last_sent_at = now;
  tmuxState.recent_keys[dedupeKey] = now;
  await writeFile(tmuxStatePath, JSON.stringify(tmuxState, null, 2));

  await appendHookPluginLog(context.cwd, context.pluginName, 'info', 'tmux.sendKeys', {
    hook_event: context.event.event,
    target: targetResolution.target,
    submitted: options.submit !== false,
  }).catch(() => {});

  return {
    ok: true,
    reason: 'ok',
    target: targetResolution.target,
    paneId: targetResolution.target,
  };
}

export function createHookPluginTmuxApi(options: HookPluginTmuxApiOptions): HookPluginSdk['tmux'] {
  return {
    sendKeys: (sendOptions: HookPluginSendKeysOptions) => sendTmuxKeys(sendOptions, options),
  };
}
