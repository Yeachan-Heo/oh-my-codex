import { parse as parseToml } from '@iarna/toml';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { codexConfigPath } from './paths.js';

export const DEFAULT_TMUX_SUBMIT_SETTLE_MS = 120;
export const DEFAULT_TMUX_SUBMIT_REPEAT_DELAY_MS = 100;

const MAX_TMUX_SUBMIT_DELAY_MS = 60_000;

export function parseTmuxSubmitDelayMs(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    const rounded = Math.floor(value);
    if (rounded < 0 || rounded > MAX_TMUX_SUBMIT_DELAY_MS) return undefined;
    return rounded;
  }

  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const rounded = Math.floor(parsed);
  if (rounded < 0 || rounded > MAX_TMUX_SUBMIT_DELAY_MS) return undefined;
  return rounded;
}

interface TmuxSubmitDelayTomlConfig {
  tmux_submit_repeat_delay_ms?: unknown;
  tmux_submit_settle_ms?: unknown;
}

interface CodexTomlConfig {
  omx?: TmuxSubmitDelayTomlConfig;
}

function readCodexTomlConfig(codexHomeOverride?: string): CodexTomlConfig | null {
  const configPath = codexHomeOverride
    ? join(codexHomeOverride, 'config.toml')
    : codexConfigPath();
  if (!existsSync(configPath)) return null;

  try {
    const parsed = parseToml(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CodexTomlConfig;
  } catch {
    return null;
  }
}

function readTomlOmxDelayValue(
  key: keyof TmuxSubmitDelayTomlConfig,
  codexHomeOverride?: string,
): number | undefined {
  const omx = readCodexTomlConfig(codexHomeOverride)?.omx;
  if (!omx || typeof omx !== 'object' || Array.isArray(omx)) return undefined;
  return parseTmuxSubmitDelayMs(omx[key]);
}

export function resolveTmuxSubmitSettleMs(
  codexHomeOverride?: string,
  fallbackMs = DEFAULT_TMUX_SUBMIT_SETTLE_MS,
): number {
  return (
    readTomlOmxDelayValue('tmux_submit_settle_ms', codexHomeOverride)
    ?? fallbackMs
  );
}

export function resolveTmuxSubmitRepeatDelayMs(codexHomeOverride?: string): number {
  return (
    readTomlOmxDelayValue('tmux_submit_repeat_delay_ms', codexHomeOverride)
    ?? DEFAULT_TMUX_SUBMIT_REPEAT_DELAY_MS
  );
}
