import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type {
  HookEventEnvelope,
  HookPluginSdk,
  HookPluginSendKeysOptions,
  HookPluginSendKeysResult,
} from './types.js';

interface HookPluginSdkOptions {
  cwd: string;
  pluginName: string;
  event: HookEventEnvelope;
  sideEffectsEnabled?: boolean;
}

const INJECTION_MARKER = '[OMX_TMUX_INJECT]';

interface PluginTmuxState {
  last_sent_at: number;
  recent_keys: Record<string, number>;
}

const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

function asPositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitizePluginName(name: string): string {
  const cleaned = (name || 'unknown-plugin').replace(/[^a-zA-Z0-9._-]/g, '-');
  return cleaned || 'unknown-plugin';
}

function pluginRootDir(cwd: string, pluginName: string): string {
  return join(cwd, '.omx', 'state', 'hooks', 'plugins', sanitizePluginName(pluginName));
}

function pluginTmuxStatePath(cwd: string, pluginName: string): string {
  return join(pluginRootDir(cwd, pluginName), 'tmux.json');
}

function pluginDataPath(cwd: string, pluginName: string): string {
  return join(pluginRootDir(cwd, pluginName), 'data.json');
}

function pluginLogPath(cwd: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(cwd, '.omx', 'logs', `hooks-${day}.jsonl`);
}

async function appendPluginLog(
  cwd: string,
  pluginName: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const logPath = pluginLogPath(cwd);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'hook_plugin_log',
    plugin: pluginName,
    level,
    message,
    ...meta,
  })}\n`).catch(() => {});
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
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(seconds * 1000));
}

function runTmux(args: string[]): { ok: true; stdout: string } | { ok: false; stderr: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' });
  if (result.error) return { ok: false, stderr: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stderr: (result.stderr || '').trim() || `tmux exited ${result.status}` };
  }
  return { ok: true, stdout: (result.stdout || '').trim() };
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
    const paneList = runTmux(['list-panes', '-t', sessionName, '-F', '#{pane_id} #{pane_active}']);
    if (!paneList.ok) {
      return { ok: false, reason: 'target_missing', error: paneList.stderr };
    }
    const lines = paneList.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const active = lines.find((line) => line.endsWith(' 1')) || lines[0];
    if (!active) return { ok: false, reason: 'target_missing' };
    const resolved = active.split(' ')[0];
    return resolved ? { ok: true, reason: 'ok', target: resolved, paneId: resolved } : { ok: false, reason: 'target_missing' };
  }

  const envPane = typeof process.env.TMUX_PANE === 'string' ? process.env.TMUX_PANE.trim() : '';
  if (envPane) return { ok: true, reason: 'ok', target: envPane, paneId: envPane };

  return { ok: false, reason: 'target_missing' };
}

async function sendTmuxKeys(
  options: HookPluginSendKeysOptions,
  context: HookPluginSdkOptions,
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

  const tmuxStatePath = pluginTmuxStatePath(context.cwd, context.pluginName);
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
    Object.entries(tmuxState.recent_keys || {}).filter(([, ts]) => Number.isFinite(ts) && ts >= minTs)
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

  await appendPluginLog(context.cwd, context.pluginName, 'info', 'tmux.sendKeys', {
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

function normalizeStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('state key is required');
  if (trimmed.includes('..') || trimmed.startsWith('/')) {
    throw new Error('invalid state key');
  }
  return trimmed;
}

export function createHookPluginSdk(options: HookPluginSdkOptions): HookPluginSdk {
  const pluginName = sanitizePluginName(options.pluginName);
  const dataPath = pluginDataPath(options.cwd, pluginName);

  async function readData(): Promise<Record<string, unknown>> {
    return readJsonIfExists<Record<string, unknown>>(dataPath, {});
  }

  async function writeData(value: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(dataPath), { recursive: true });
    await writeFile(dataPath, JSON.stringify(value, null, 2));
  }

  const logger = {
    info: (message: string, meta: Record<string, unknown> = {}) => appendPluginLog(options.cwd, pluginName, 'info', message, {
      hook_event: options.event.event,
      ...meta,
    }),
    warn: (message: string, meta: Record<string, unknown> = {}) => appendPluginLog(options.cwd, pluginName, 'warn', message, {
      hook_event: options.event.event,
      ...meta,
    }),
    error: (message: string, meta: Record<string, unknown> = {}) => appendPluginLog(options.cwd, pluginName, 'error', message, {
      hook_event: options.event.event,
      ...meta,
    }),
  };

  return {
    tmux: {
      sendKeys: (sendOptions: HookPluginSendKeysOptions) => sendTmuxKeys(sendOptions, {
        ...options,
        pluginName,
      }),
    },
    log: logger,
    state: {
      read: async <T = unknown>(key: string, fallback?: T): Promise<T | undefined> => {
        const safeKey = normalizeStateKey(key);
        const data = await readData();
        if (!(safeKey in data)) return fallback;
        return data[safeKey] as T;
      },
      write: async (key: string, value: unknown): Promise<void> => {
        const safeKey = normalizeStateKey(key);
        const data = await readData();
        data[safeKey] = value;
        await writeData(data);
      },
      delete: async (key: string): Promise<void> => {
        const safeKey = normalizeStateKey(key);
        const data = await readData();
        if (safeKey in data) {
          delete data[safeKey];
          await writeData(data);
        }
      },
      all: async <T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T> => {
        const data = await readData();
        return data as T;
      },
    },
  };
}

export async function clearHookPluginState(cwd: string, pluginName: string): Promise<void> {
  const root = pluginRootDir(cwd, pluginName);
  await unlink(join(root, 'data.json')).catch(() => {});
  await unlink(join(root, 'tmux.json')).catch(() => {});
}
